const { app } = require("@azure/functions");
const Devotee = require("../models/Devotee");
const Login = require("../models/Login");
const NotificationLog = require("../models/notificationLogs");
const { ensureMongo } = require("../config/mongo");
const { istYmd } = require("../utils/dateIst");
const { getAdmin } = require("../config/firebase");
const { sendFestivalsTopicNotification } = require("../utils/fcmFunctions");

// ---- helpers ----
function monthDayKeyFromDate(d) {
    if (!d) return "";
    const ymd = istYmd(new Date(d)); // IST aligned YYYY-MM-DD
    const [, mm, dd] = ymd.split("-");
    return `${mm}-${dd}`;
}

function formatNames(devotees, limit = 8) {
    const names = devotees.map(d => d.initiationName || d.name).filter(Boolean);
    const shown = names.slice(0, limit);
    const more = names.length - shown.length;
    return more > 0 ? `${shown.join(", ")} +${more} more` : shown.join(", ");
}

async function sendToToken(admin, token, title, body, data = {}) {
    if (!token) return null;
    return admin.messaging().send({
        token,
        notification: { title, body },
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? "")])),
    });
}

async function runAnniversariesToday730am(context) {
    await ensureMongo();
    const admin = await getAdmin();

    const todayYmd = istYmd(new Date());
    const [, mm, dd] = todayYmd.split("-");
    const todayKey = `${mm}-${dd}`;

    const devotees = await Devotee.find(
        { dateOfMarriage: { $ne: null } },
        { name: 1, mobileNo: 1, dateOfMarriage: 1, initiationName: 1 }
    ).lean();

    const todaysAnniversaries = devotees.filter(d => monthDayKeyFromDate(d.dateOfMarriage) === todayKey);

    // ---- 1) TOPIC summary (single send)
    if (todaysAnniversaries.length) {
        const key = {
            type: "anniversary",
            topic: "festivals",
            slot: "today_730am",
            eventDate: todayYmd,
            event: "summary",
        };

        const already = await NotificationLog.findOne(key).lean();
        if (!already) {
            const count = todaysAnniversaries.length;
            const namesText = formatNames(todaysAnniversaries, 8);

            const title = "🎉 Today: Wedding Anniversaries (ISKCON Vesu)";
            const body = `(${count}) ${namesText}`;

            try {
                const messageId = await sendFestivalsTopicNotification({
                    title,
                    body,
                    data: { type: "anniversary", slot: "today_730am", date: todayYmd, count }
                });

                await NotificationLog.create({ ...key, status: "sent", messageId });
                context.log("[FCM] anniversary summary sent:", messageId);
            } catch (err) {
                await NotificationLog.create({ ...key, status: "failed", error: err?.message || String(err) }).catch(() => { });
                context.log("[FCM] anniversary summary failed:", err?.message || err);
            }
        }
    }

    // ---- 2) PERSONAL wishes
    // Map mobile -> fcmToken from Login collection
    const mobiles = todaysAnniversaries.map(d => d.mobileNo).filter(Boolean);
    const logins = await Login.find({ mobile: { $in: mobiles } }, { mobile: 1, fcmToken: 1 }).lean();
    const tokenMap = new Map(logins.map(l => [l.mobile, l.fcmToken]));

    for (const d of todaysAnniversaries) {
        const token = tokenMap.get(d.mobileNo);
        if (!token) continue;

        const displayName = d.initiationName || d.name || "Devotee";

        const key = {
            type: "anniversary_personal",
            topic: "token",
            slot: "today_730am",
            eventDate: todayYmd,
            event: d.mobileNo, // unique per person
        };

        const already = await NotificationLog.findOne(key).lean();
        if (already) continue;

        try {
            const title = "Hare Krishna 🙏";
            const body = `Happy Wedding Anniversary ${displayName}! 🎂`;

            await sendToToken(admin, token, title, body, { type: "anniversary", date: todayYmd });

            await NotificationLog.create({ ...key, status: "sent", messageId: "token_send" });
        } catch (err) {
            await NotificationLog.create({ ...key, status: "failed", error: err?.message || String(err) }).catch(() => { });
        }
    }
}

app.timer("anniversariesToday730am", {
    schedule: "0 55 5 * * *", // ✅ 7:30 AM IST
    handler: async (_timer, context) => runAnniversariesToday730am(context),
});

module.exports = { runAnniversariesToday730am };
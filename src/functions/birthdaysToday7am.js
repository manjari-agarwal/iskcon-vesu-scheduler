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

function safeStr(s) {
  return String(s || "").trim();
}

function pickDisplayName(p) {
  return safeStr(p.initiationName) || safeStr(p.name) || "Devotee";
}

function makeKeyFromMobileOrName(mobile, name) {
  const m = safeStr(mobile);
  if (m) return `m:${m}`;
  return `n:${safeStr(name).toLowerCase()}`;
}


async function sendToToken(admin, token, title, body, data = {}) {
  if (!token) return null;
  return admin.messaging().send({
    token,
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? "")])),
  });
}

async function runBirthdaysToday7am(context) {
    const ok = await ensureMongo(context);
    if (!ok) {
        context.log("❌ Skipping run because Mongo is not connected.");
        return;
    }
    const admin = await getAdmin();

    const todayYmd = istYmd(new Date());
    const [, mm, dd] = todayYmd.split("-");
    const todayKey = `${mm}-${dd}`;

    const devotees = await Devotee.find(
      { dateOfBirth: { $ne: null } },
      { name: 1, mobileNo: 1, dateOfBirth: 1, initiationName: 1 }
    ).lean();

    // --- Build a set of "registered people" by mobile (Devotee + Login) ---
    const devoteeMobiles = new Set(
      devotees.map(d => safeStr(d.mobileNo)).filter(Boolean)
    );

    const loginMobiles = await Login.find(
      { mobile: { $in: Array.from(devoteeMobiles) } },
      { mobile: 1 }
    ).lean();

    const registeredMobiles = new Set([
      ...devoteeMobiles,
      ...loginMobiles.map(l => safeStr(l.mobile)).filter(Boolean),
    ]);

    // --- Collect birthdays from main devotees + spouse + children (deduped) ---
    const people = [];
    const added = new Set(); // to avoid duplicates even if same entry appears twice

    // 1) Main devotees
    for (const d of devotees) {
      if (monthDayKeyFromDate(d.dateOfBirth) !== todayKey) continue;

      const displayName = pickDisplayName(d);
      const uniqueKey = makeKeyFromMobileOrName(d.mobileNo, displayName);
      if (added.has(uniqueKey)) continue;

      people.push({
        name: displayName,
        mobileNo: safeStr(d.mobileNo),
        source: "devotee",
        parentMobileNo: safeStr(d.mobileNo),
      });
      added.add(uniqueKey);
    }

    // 2) Spouse + Children (ONLY if not already registered as devotee/login)
    for (const d of devotees) {
      // spouse
      const sp = d.spouseDetails;
      if (sp?.dateOfBirth && monthDayKeyFromDate(sp.dateOfBirth) === todayKey) {
        const spMobile = safeStr(sp.mobileNo);
        const spName = pickDisplayName(sp);

        // skip if spouse already has own devotee/login record
        if (!spMobile || !registeredMobiles.has(spMobile)) {
          const uniqueKey = makeKeyFromMobileOrName(spMobile, spName);
          if (!added.has(uniqueKey)) {
            people.push({
              name: spName,
              mobileNo: spMobile, // may be empty
              source: "spouse",
              parentMobileNo: safeStr(d.mobileNo),
            });
            added.add(uniqueKey);
          }
        }
      }

      // children
      const kids = Array.isArray(d.childrenDetails) ? d.childrenDetails : [];
      for (const c of kids) {
        if (!c?.dateOfBirth) continue;
        if (monthDayKeyFromDate(c.dateOfBirth) !== todayKey) continue;

        const cMobile = safeStr(c.mobileNo);
        const cName = pickDisplayName(c);

        // skip if child already has own devotee/login record
        if (!cMobile || !registeredMobiles.has(cMobile)) {
          const uniqueKey = makeKeyFromMobileOrName(cMobile, cName);
          if (!added.has(uniqueKey)) {
            people.push({
              name: cName,
              mobileNo: cMobile,
              source: "child",
              parentMobileNo: safeStr(d.mobileNo),
            });
            added.add(uniqueKey);
          }
        }
      }
    }

    // ✅ This is your final list for topic message
    const todaysBirthdays = people.map(p => ({
      name: p.name,
      initiationName: "", // keep compatible with formatNames()
      mobileNo: p.mobileNo,
      source: p.source,
      parentMobileNo: p.parentMobileNo,
    }));

    // ---- 1) TOPIC summary (single send)
    if (todaysBirthdays.length) {
      const key = {
        type: "birthday",
        topic: "festivals",
        slot: "today_7am",
        eventDate: todayYmd,
        event: "summary",
      };

      const already = await NotificationLog.findOne(key).lean();
      if (!already) {
        const count = todaysBirthdays.length;
        const namesText = formatNames(todaysBirthdays, 8);

        const title = "🎉 Today: Birthdays (ISKCON Vesu)";
        const body = `(${count}) ${namesText}`;

        try {
          const messageId = await sendFestivalsTopicNotification({
            title,
            body,
            data: { type: "birthday", slot: "today_7am", date: todayYmd, count }
          });

          await NotificationLog.create({ ...key, status: "sent", messageId });
          context.log("[FCM] birthday summary sent:", messageId);
        } catch (err) {
          await NotificationLog.create({ ...key, status: "failed", error: err?.message || String(err) }).catch(() => { });
          context.log("[FCM] birthday summary failed:", err?.message || err);
        }
      }
    }

    // ---- 2) PERSONAL wishes
    // Map mobile -> fcmToken from Login collection
    const mobiles = todaysBirthdays.map(d => d.mobileNo).filter(Boolean);
    const logins = await Login.find({ mobile: { $in: mobiles } }, { mobile: 1, fcmToken: 1 }).lean();
    const tokenMap = new Map(logins.map(l => [l.mobile, l.fcmToken]));

    for (const d of todaysBirthdays) {
      const token = tokenMap.get(d.mobileNo);
      if (!token) continue;

      const displayName = d.initiationName || d.name || "Devotee";

      const key = {
        type: "birthday_personal",
        topic: "token",
        slot: "today_7am",
        eventDate: todayYmd,
        event: d.mobileNo, // unique per person
      };

      const already = await NotificationLog.findOne(key).lean();
      if (already) continue;

      try {
        const title = "Hare Krishna 🙏";
        const body = `Happy Birthday ${displayName}! 🎂`;

        await sendToToken(admin, token, title, body, { type: "birthday", date: todayYmd });

        await NotificationLog.create({ ...key, status: "sent", messageId: "token_send" });
      } catch (err) {
        await NotificationLog.create({ ...key, status: "failed", error: err?.message || String(err) }).catch(() => { });
      }
    }
  }

app.timer("birthdaysToday7am", {
  schedule: "0 50 7 * * *", // ✅ 7:00 AM IST
  handler: async (_timer, context) => runBirthdaysToday7am(context),
});

module.exports = { runBirthdaysToday7am };
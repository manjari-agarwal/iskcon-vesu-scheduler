const { app } = require("@azure/functions");
const VaishnavaCalender = require("../models/VaishnavaCalender");
const NotificationLog = require("../models/notificationLogs");
const { ensureMongo } = require("../config/mongo");
const { istYmd } = require("../utils/dateIst");
const { sendFestivalTopicNotification } = require("../utils/fcmFunctions");

async function getEventsForIstDate(targetYmd) {
  const [y, m] = targetYmd.split("-").map(Number);
  const doc = await VaishnavaCalender.findOne({ year: y, month: m }).lean();
  if (!doc?.data?.length) return [];

  return doc.data.filter((item) => istYmd(new Date(item.date)) === targetYmd);
}

async function runFestivalsToday630am(context) {
    await ensureMongo();

    const today = istYmd(new Date());
    const events = await getEventsForIstDate(today);

    for (const e of events) {
      const key = {
        type: "festival",
        topic: "festivals",
        slot: "today_6am",
        eventDate: today,
        event: e.event
      };

      const already = await NotificationLog.findOne(key).lean();
      if (already) continue;

      try {
        const dateISO = new Date(e.date).toISOString();
        const messageId = await sendFestivalTopicNotification("today_6am", {
          event: e.event,
          description: e.description || "",
          dateISO
        });

        await NotificationLog.create({ ...key, status: "sent", messageId });
        context.log("[FCM] today_6am sent:", e.event, messageId);
      } catch (err) {
        await NotificationLog.create({
          ...key,
          status: "failed",
          error: err?.message || String(err)
        }).catch(() => {});
        context.log("[FCM] today_6am failed:", e.event, err?.message || err);
      }
    }
  }

app.timer("festivalsToday630am", {
  schedule: "0 30 0 * * *", // 6:30 AM IST = 00:30 UTC
  handler: async (_timer, context) => runFestivalsToday630am(context),
});

module.exports = { runFestivalsToday630am };
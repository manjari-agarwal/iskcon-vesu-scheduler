const { app } = require("@azure/functions");
const VaishnavaCalender = require("../models/VaishnavaCalender");
const NotificationLog = require("../models/NotificationLog");
const { ensureMongo } = require("../config/mongo");
const { istYmd, addDaysYmd } = require("../utils/dateIst");
const { sendFestivalTopicNotification } = require("../utils/fcmFunctions");

async function getEventsForIstDate(targetYmd) {
  const [y, m] = targetYmd.split("-").map(Number);
  const doc = await VaishnavaCalender.findOne({ year: y, month: m }).lean();
  if (!doc?.data?.length) return [];

  return doc.data.filter((item) => istYmd(new Date(item.date)) === targetYmd);
}

app.timer("festivalsTomorrow5pm", {
  schedule: "0 30 11 * * *", // 5:00 PM IST = 11:30 UTC
  handler: async (_timer, context) => {
    await ensureMongo();

    const today = istYmd(new Date());
    const tomorrow = addDaysYmd(today, 1);
    const events = await getEventsForIstDate(tomorrow);

    for (const e of events) {
      const key = {
        type: "festival",
        topic: "festivals",
        slot: "tomorrow_5pm",
        eventDate: tomorrow,
        event: e.event
      };

      const already = await NotificationLog.findOne(key).lean();
      if (already) continue;

      try {
        const dateISO = new Date(e.date).toISOString();
        const messageId = await sendFestivalTopicNotification("tomorrow_5pm", {
          event: e.event,
          description: e.description || "",
          dateISO
        });

        await NotificationLog.create({ ...key, status: "sent", messageId });
        context.log("[FCM] tomorrow_5pm sent:", e.event, messageId);
      } catch (err) {
        await NotificationLog.create({
          ...key,
          status: "failed",
          error: err?.message || String(err)
        }).catch(() => {});
        context.log("[FCM] tomorrow_5pm failed:", e.event, err?.message || err);
      }
    }
  }
});

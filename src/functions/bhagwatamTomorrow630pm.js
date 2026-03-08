const { app } = require("@azure/functions");
const BhagwatamCalender = require("../models/BhagwatamCalender");
const NotificationLog = require("../models/notificationLogs");
const { ensureMongo } = require("../config/mongo");
const { istYmd, addDaysYmd } = require("../utils/dateIst");
const { sendBhagwatamScheduledTopicNotification } = require("../utils/fcmFunctions");

async function runBhagwatamTomorrow630pm(context, opts = {}) {
  const slot = "tomorrow_630pm";
  const baseYmd = opts.forceBaseYmd || istYmd(new Date());
  const targetYmd = addDaysYmd(baseYmd, 1);

  const mongoOk = await ensureMongo(context);
  if (!mongoOk) return;

  const start = new Date(`${targetYmd}T00:00:00+05:30`);
  const end = new Date(`${targetYmd}T23:59:59.999+05:30`);

  const doc = await BhagwatamCalender.findOne({
    date: { $gte: start, $lte: end }
  }).lean();

  if (!doc) return;

  const key = {
    type: "bhagwatam",
    topic: "bhagwatam",
    slot,
    eventDate: targetYmd,
    event: String(doc._id),
  };

  const already = await NotificationLog.findOne(key).lean();
  if (already) return;

  const title = "🔔 Tomorrow’s Srimad Bhagwatam Class";
  const body = `${doc.speaker} — ${doc.verse}`;

  try {
    const messageId = await sendBhagwatamScheduledTopicNotification({
      title,
      body,
      doc,
      data: { slot, mode: "tomorrow" },
    });

    await NotificationLog.create({ ...key, status: "sent", messageId });
  } catch (err) {
    await NotificationLog.create({
      ...key,
      status: "failed",
      error: err?.message || String(err),
    }).catch(() => {});
  }
}

app.timer("bhagwatamTomorrow630pm", {
  // 6:30 PM IST = 13:00 UTC
  schedule: "0 0 13 * * *",
  handler: async (_timer, context) => runBhagwatamTomorrow630pm(context),
});

module.exports = { runBhagwatamTomorrow630pm };
const { app } = require("@azure/functions");
const BhagwatamCalender = require("../models/BhagwatamCalender");
const NotificationLog = require("../models/notificationLogs");
const { ensureMongo } = require("../config/mongo");
const { istYmd } = require("../utils/dateIst");
const { sendBhagwatamScheduledTopicNotification } = require("../utils/fcmFunctions");

async function runBhagwatamToday3pm(context, opts = {}) {
  const slot = "today_3pm";
  const todayYmd = opts.forceYmd || istYmd(new Date());

  const mongoOk = await ensureMongo(context);
  if (!mongoOk) return;

  const start = new Date(`${todayYmd}T00:00:00+05:30`);
  const end = new Date(`${todayYmd}T23:59:59.999+05:30`);

  const doc = await BhagwatamCalender.findOne({
    date: { $gte: start, $lte: end }
  }).lean();

  if (!doc) return;

  const key = {
    type: "bhagwatam",
    topic: "bhagwatam",
    slot,
    eventDate: todayYmd,
    event: String(doc._id),
  };

  const already = await NotificationLog.findOne(key).lean();
  if (already) return;

  const title = "📖 Today’s Srimad Bhagwatam Class";
  const body = `${doc.speaker} — ${doc.verse}`;
  const youtubeUrl = doc.url || "";

  try {
    const messageId = await sendBhagwatamScheduledTopicNotification({
      title,
      body,
      doc,
      data: {
        slot,
        mode: "today",
        url: youtubeUrl
      },
    });

    await NotificationLog.create({ ...key, status: "sent", messageId });
  } catch (err) {
    await NotificationLog.create({
      ...key,
      status: "failed",
      error: err?.message || String(err),
    }).catch(() => { });
  }
}

app.timer("bhagwatamToday3pm", {
  // 3:00 PM IST = 09:30 UTC
  schedule: "0 30 9 * * *",
  handler: async (_timer, context) => runBhagwatamToday3pm(context),
});

module.exports = { runBhagwatamToday3pm };
const { app } = require("@azure/functions");
const PrabhuPaadQuotes = require("../models/PrabhuPaadQuotes");
const NotificationLog = require("../models/notificationLogs");
const { ensureMongo } = require("../config/mongo");
const { sendPrabhupadQuoteTopicNotification } = require("../utils/fcmFunctions");

function getIstDayMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "numeric",
  }).formatToParts(now);

  const day = Number(parts.find((p) => p.type === "day")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);

  return { day, month };
}

function istYmd(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function truncateText(text, max = 140) {
  const str = String(text || "").trim();
  if (!str) return "";
  return str.length > max ? `${str.slice(0, max)}...` : str;
}

async function runPrabhupadQuoteDaily8am(context) {
  const slot = "daily_8am";
  const todayYmd = istYmd(new Date());
  const { day, month } = getIstDayMonth(new Date());

  const mongoOk = await ensureMongo(context);
  if (!mongoOk) return;

  const doc = await PrabhuPaadQuotes.findOne({ day, month }).lean();
  if (!doc?.hindiText) return;

  const key = {
    type: "quote",
    topic: "quotes",
    slot,
    eventDate: todayYmd,
    event: `${month}-${day}`,
  };

  const already = await NotificationLog.findOne(key).lean();
  if (already) return;

  const title = "Prabhupad Quote of the Day";
  const body = truncateText(doc.hindiText, 140);

  try {
    const messageId = await sendPrabhupadQuoteTopicNotification({
      title,
      body,
      data: { slot, date: todayYmd, lang: "hi" },
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

app.timer("prabhupadQuoteDaily8am", {
  // 8:00 AM IST = 02:30 UTC
  schedule: "0 30 5 * * *",
  handler: async (_timer, context) => runPrabhupadQuoteDaily8am(context),
});

module.exports = { runPrabhupadQuoteDaily8am };
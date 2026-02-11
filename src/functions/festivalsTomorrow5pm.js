const { app } = require("@azure/functions");
const VaishnavaCalender = require("../models/VaishnavaCalender");
const NotificationLog = require("../models/notificationLogs");
const { ensureMongo } = require("../config/mongo");
const { istYmd, addDaysYmd } = require("../utils/dateIst");
const { sendFestivalTopicNotification } = require("../utils/fcmFunctions");

function safeStr(s) {
  return String(s || "").trim();
}

async function getEventsForIstDate(targetYmd, context) {
  const log = (...a) => (context?.log ? context.log(...a) : console.log(...a));

  const [y, m] = targetYmd.split("-").map(Number);
  if (!y || !m) return [];

  log("[DB] Fetching VaishnavaCalender for:", { year: y, month: m });

  const doc = await VaishnavaCalender.findOne({ year: y, month: m }).lean();
  if (!doc?.data?.length) {
    log("[DB] No calendar doc/data found for year/month");
    return [];
  }

  const events = doc.data.filter((item) => istYmd(new Date(item.date)) === targetYmd);
  log("[DB] Events matched for day:", targetYmd, "count:", events.length);

  return events;
}

/**
 * Save run summary into NotificationLog (one doc per run)
 * type: festival_run
 * event: "summary"
 */
async function saveRunSummary({ eventYmd, slot, stats, details, context }) {
  const log = (...a) => (context?.log ? context.log(...a) : console.log(...a));

  try {
    const key = {
      type: "festival_run",
      topic: "festivals",
      slot,
      eventDate: eventYmd,
      event: "summary",
    };

    await NotificationLog.create({
      ...key,
      status: "completed",
      stats,
      details,
    });

    log("[SUMMARY] Saved run summary into NotificationLog");
  } catch (e) {
    log("[SUMMARY] Failed to save run summary:", e?.message || e);
  }
}

async function runFestivalsTomorrow5pm(context, opts = {}) {
  const log = (...a) => (context?.log ? context.log(...a) : console.log(...a));
  const warn = (...a) => (context?.log ? context.log(...a) : console.warn(...a));

  const forcedBaseYmd = safeStr(opts.forceBaseYmd); // optional: treat this as "today" for testing
  const baseTodayYmd = forcedBaseYmd || istYmd(new Date());
  const tomorrowYmd = addDaysYmd(baseTodayYmd, 1);

  log("========== FESTIVALS TOMORROW START ==========");
  log("Base IST date:", baseTodayYmd, "Tomorrow IST date:", tomorrowYmd, "slot: tomorrow_5pm");
  log("Force base date used?", !!forcedBaseYmd);

  const mongoOk = await ensureMongo(context);
  if (!mongoOk) {
    warn("❌ Mongo not connected. Exiting.");
    return;
  }

  const events = await getEventsForIstDate(tomorrowYmd, context);

  const stats = {
    baseDate: baseTodayYmd,
    eventDate: tomorrowYmd,
    totalEvents: events.length,
    skippedAlreadySent: 0,
    sent: 0,
    failed: 0,
    empty: events.length === 0,
  };

  const details = [];

  if (!events.length) {
    log("No festivals tomorrow. Nothing to send.");

    if (opts.saveSummary === true) {
      await saveRunSummary({ eventYmd: tomorrowYmd, slot: "tomorrow_5pm", stats, details, context });
    }

    log("========== FESTIVALS TOMORROW DONE ==========");
    return;
  }

  for (const e of events) {
    const eventName = safeStr(e?.event) || "unknown_event";
    const desc = safeStr(e?.description);
    const dateISO = e?.date ? new Date(e.date).toISOString() : "";

    const key = {
      type: "festival",
      topic: "festivals",
      slot: "tomorrow_5pm",
      eventDate: tomorrowYmd,
      event: eventName,
    };

    const already = await NotificationLog.findOne(key).lean();
    if (already) {
      stats.skippedAlreadySent += 1;
      log("[SKIP] Already sent:", eventName);

      details.push({
        event: eventName,
        status: "skipped_already_sent",
        messageId: already.messageId || null,
        error: null,
      });
      continue;
    }

    log("[SEND] Sending topic message for:", eventName);

    try {
      const messageId = await sendFestivalTopicNotification("tomorrow_5pm", {
        event: eventName,
        description: desc,
        dateISO,
      });

      stats.sent += 1;

      await NotificationLog.create({ ...key, status: "sent", messageId });

      log("[SEND] ✅ Sent:", eventName, "messageId:", messageId);

      details.push({
        event: eventName,
        status: "sent",
        messageId,
        error: null,
      });
    } catch (err) {
      stats.failed += 1;
      const emsg = err?.message || String(err);

      await NotificationLog.create({
        ...key,
        status: "failed",
        error: emsg,
      }).catch(() => {});

      warn("[SEND] ❌ Failed:", eventName, emsg);

      details.push({
        event: eventName,
        status: "failed",
        messageId: null,
        error: emsg,
      });
    }
  }

  log("========== FESTIVALS TOMORROW DONE ==========");
  log("Summary:", stats);

  if (opts.saveSummary === true) {
    await saveRunSummary({ eventYmd: tomorrowYmd, slot: "tomorrow_5pm", stats, details, context });
  }
}

app.timer("festivalsTomorrow5pm", {
  schedule: "0 30 11 * * *", // 5:00 PM IST = 11:30 UTC
  handler: async (_timer, context) => runFestivalsTomorrow5pm(context, { saveSummary: true }),
});

module.exports = { runFestivalsTomorrow5pm };
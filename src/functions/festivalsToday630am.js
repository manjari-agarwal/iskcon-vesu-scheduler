const { app } = require("@azure/functions");
const VaishnavaCalender = require("../models/VaishnavaCalender");
const NotificationLog = require("../models/notificationLogs");
const { ensureMongo } = require("../config/mongo");
const { istYmd } = require("../utils/dateIst");
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
 * Optional: Save a run summary record into NotificationLog.
 * - type: festival_run
 * - event: "summary"
 * - includes stats + per-event details
 */
async function saveRunSummary({ todayYmd, slot, stats, details, context }) {
  const log = (...a) => (context?.log ? context.log(...a) : console.log(...a));

  try {
    const key = {
      type: "festival_run",
      topic: "festivals",
      slot,
      eventDate: todayYmd,
      event: "summary",
    };

    await NotificationLog.create({
      ...key,
      status: "completed",
      stats,
      details,
      createdAt: new Date(),
    });

    log("[SUMMARY] Saved run summary into NotificationLog");
  } catch (e) {
    log("[SUMMARY] Failed to save run summary:", e?.message || e);
  }
}

async function runFestivalsToday630am(context, opts = {}) {
  const log = (...a) => (context?.log ? context.log(...a) : console.log(...a));
  const warn = (...a) => (context?.log ? context.log(...a) : console.warn(...a));

  const forcedYmd = safeStr(opts.forceYmd);
  const todayYmd = forcedYmd || istYmd(new Date());

  log("========== FESTIVALS TODAY START ==========");
  log("IST date:", todayYmd, "slot: today_6am");
  log("Force date used?", !!forcedYmd);

  const mongoOk = await ensureMongo(context);
  if (!mongoOk) {
    warn("❌ Mongo not connected. Exiting.");
    return;
  }

  const events = await getEventsForIstDate(todayYmd, context);

  // Run stats
  const stats = {
    date: todayYmd,
    totalEvents: events.length,
    skippedAlreadySent: 0,
    sent: 0,
    failed: 0,
    empty: events.length === 0,
  };

  // Per-event detailed log
  const details = [];

  if (!events.length) {
    log("No festivals today. Nothing to send.");
    // Save summary if you want even for empty days:
    if (opts.saveSummary === true) {
      await saveRunSummary({ todayYmd, slot: "today_6am", stats, details, context });
    }
    log("========== FESTIVALS TODAY DONE ==========");
    return;
  }

  for (const e of events) {
    const eventName = safeStr(e?.event);
    const desc = safeStr(e?.description);
    const dateISO = e?.date ? new Date(e.date).toISOString() : "";

    const key = {
      type: "festival",
      topic: "festivals",
      slot: "today_6am",
      eventDate: todayYmd,
      event: eventName || "unknown_event",
    };

    // Check already sent
    const already = await NotificationLog.findOne(key).lean();
    if (already) {
      stats.skippedAlreadySent += 1;
      log("[SKIP] Already sent:", key.event);
      details.push({
        event: key.event,
        status: "skipped_already_sent",
        messageId: already.messageId || null,
        error: null,
      });
      continue;
    }

    // Try sending
    log("[SEND] Sending topic message for:", key.event);

    try {
      const messageId = await sendFestivalTopicNotification("today_6am", {
        event: eventName,
        description: desc,
        dateISO,
      });

      stats.sent += 1;

      await NotificationLog.create({ ...key, status: "sent", messageId });

      log("[SEND] ✅ Sent:", key.event, "messageId:", messageId);

      details.push({
        event: key.event,
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

      warn("[SEND] ❌ Failed:", key.event, emsg);

      details.push({
        event: key.event,
        status: "failed",
        messageId: null,
        error: emsg,
      });
    }
  }

  log("========== FESTIVALS TODAY DONE ==========");
  log("Summary:", stats);

  // Save summary of full run (optional)
  if (opts.saveSummary === true) {
    await saveRunSummary({ todayYmd, slot: "today_6am", stats, details, context });
  }
}

app.timer("festivalsToday630am", {
  schedule: "0 30 0 * * *", // 6:30 AM IST = 00:30 UTC
  handler: async (_timer, context) => runFestivalsToday630am(context, { saveSummary: true }),
});

module.exports = { runFestivalsToday630am };
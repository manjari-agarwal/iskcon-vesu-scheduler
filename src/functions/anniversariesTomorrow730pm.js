const { app } = require("@azure/functions");
const Devotee = require("../models/Devotee");
const NotificationLog = require("../models/notificationLogs");
const { ensureMongo } = require("../config/mongo");
const { istYmd, addDaysYmd } = require("../utils/dateIst");
const { sendFestivalsTopicNotification } = require("../utils/fcmFunctions");

function safeStr(s) {
  return String(s || "").trim();
}

function monthDayKeyFromDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  const m = dt.toLocaleString("en-CA", { timeZone: "Asia/Kolkata", month: "2-digit" });
  const day = dt.toLocaleString("en-CA", { timeZone: "Asia/Kolkata", day: "2-digit" });
  return `${m}-${day}`;
}

function preferName(p) {
  const init = `${safeStr(p?.initiationName)} ${safeStr(p?.initiationTitle)}`.trim();
  return init || safeStr(p?.initiationName) || safeStr(p?.name) || "Devotee";
}

function formatNames(items, limit = 8) {
  const names = items.map((d) => safeStr(d.displayName || d.name)).filter(Boolean);
  const shown = names.slice(0, limit);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(", ")} +${more} more` : shown.join(", ");
}

async function saveRunSummary({ slot, eventDate, stats, details }) {
  const key = {
    type: "anniversary_run",
    topic: "festivals",
    slot,
    eventDate,
    event: "summary",
  };

  await NotificationLog.findOneAndUpdate(
    key,
    { $set: { ...key, status: "completed", stats, details } },
    { upsert: true, new: true }
  );
}

async function runAnniversariesTomorrow730pm(context, opts = {}) {
  const slot = "tomorrow_730pm";
  const baseYmd = opts.forceBaseYmd || istYmd(new Date());
  const targetYmd = addDaysYmd(baseYmd, 1);
  const [, mm, dd] = targetYmd.split("-");
  const targetKey = `${mm}-${dd}`;

  const mongoOk = await ensureMongo(context);
  if (!mongoOk) return;

  const devotees = await Devotee.find(
    { dateOfMarriage: { $ne: null } },
    { name: 1, mobileNo: 1, dateOfMarriage: 1, initiationName: 1, initiationTitle: 1, gender: 1, spouseDetails: 1 }
  ).lean();

  const todaysAnniversaries = devotees.filter((d) => monthDayKeyFromDate(d.dateOfMarriage) === targetKey);

  const byMobileToday = new Map();
  for (const d of todaysAnniversaries) {
    const m = safeStr(d.mobileNo);
    if (m) byMobileToday.set(m, d);
  }

  const pairKeySet = new Set();
  const clubbedForTopic = [];

  for (const d of todaysAnniversaries) {
    const myMobile = safeStr(d.mobileNo);
    const spouseMobile = safeStr(d?.spouseDetails?.mobileNo);

    if (!myMobile || !spouseMobile) {
      clubbedForTopic.push({ displayName: preferName(d) });
      continue;
    }

    const spouseDevotee = byMobileToday.get(spouseMobile);
    if (spouseDevotee) {
      const stablePairKey = [myMobile, spouseMobile].sort().join("|");
      if (pairKeySet.has(stablePairKey)) continue;
      pairKeySet.add(stablePairKey);

      const g1 = safeStr(d.gender).toLowerCase();
      const g2 = safeStr(spouseDevotee.gender).toLowerCase();

      let first = preferName(d);
      let second = preferName(spouseDevotee);

      if (g1 === "female" && g2 === "male") {
        first = preferName(spouseDevotee);
        second = preferName(d);
      }

      clubbedForTopic.push({ displayName: `${first} & ${second}` });
    } else {
      clubbedForTopic.push({ displayName: preferName(d) });
    }
  }

  const details = [];
  let topicSent = 0;
  let topicFailed = 0;

  if (!clubbedForTopic.length) {
    details.push({ step: "topic", status: "skipped_no_anniversaries" });
  } else {
    const key = {
      type: "anniversary",
      topic: "festivals",
      slot,
      eventDate: targetYmd,
      event: "summary",
    };

    const already = await NotificationLog.findOne(key).lean();
    if (already) {
      details.push({ step: "topic", status: "skipped_already_sent" });
    } else {
      const count = clubbedForTopic.length;
      const namesText = formatNames(clubbedForTopic, 8);
      const title = "💐 Tomorrow: Wedding Anniversaries (ISKCON Vesu)";
      const body = `(${count}) ${namesText}`;

      try {
        const messageId = await sendFestivalsTopicNotification({
          title,
          body,
          data: { type: "anniversary", slot, date: targetYmd, count },
        });

        await NotificationLog.create({ ...key, status: "sent", messageId });
        topicSent += 1;
        details.push({ step: "topic", status: "sent", messageId });
      } catch (err) {
        const emsg = err?.message || String(err);
        await NotificationLog.create({ ...key, status: "failed", error: emsg }).catch(() => {});
        topicFailed += 1;
        details.push({ step: "topic", status: "failed", error: emsg });
      }
    }
  }

  await saveRunSummary({
    slot,
    eventDate: targetYmd,
    stats: {
      baseYmd,
      eventDate: targetYmd,
      totalCount: clubbedForTopic.length,
      topicSent,
      topicFailed,
    },
    details,
  });
}

app.timer("anniversariesTomorrow730pm", {
  // 7:30 PM IST = 14:00 UTC
  schedule: "0 0 14 * * *",
  handler: async (_timer, context) => runAnniversariesTomorrow730pm(context),
});

module.exports = { runAnniversariesTomorrow730pm };
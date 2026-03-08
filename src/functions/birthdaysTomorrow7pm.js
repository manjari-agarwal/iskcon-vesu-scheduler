const { app } = require("@azure/functions");
const Devotee = require("../models/Devotee");
const NotificationLog = require("../models/notificationLogs");
const { ensureMongo } = require("../config/mongo");
const { istYmd, addDaysYmd } = require("../utils/dateIst");
const { sendFestivalsTopicNotification } = require("../utils/fcmFunctions");

function safeStr(s) {
  return String(s || "").trim();
}

function hasText(s) {
  return safeStr(s).length > 0;
}

function shouldUseInitiatedName(p) {
  return p?.isInitiated === true || hasText(p?.initiationName);
}

function buildInitiatedName(p) {
  if (!shouldUseInitiatedName(p)) return "";
  const init = `${safeStr(p?.initiationName)} ${safeStr(p?.initiationTitle)}`.trim();
  return hasText(init) ? init : "";
}

function monthDayKeyFromDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  const y = dt.toLocaleString("en-CA", { timeZone: "Asia/Kolkata", year: "numeric" });
  const m = dt.toLocaleString("en-CA", { timeZone: "Asia/Kolkata", month: "2-digit" });
  const day = dt.toLocaleString("en-CA", { timeZone: "Asia/Kolkata", day: "2-digit" });
  return `${m}-${day}`;
}

function formatNames(people, limit = 8) {
  const names = people.map((d) => safeStr(d?.name)).filter(Boolean);
  const shown = names.slice(0, limit);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(", ")} +${more} more` : shown.join(", ");
}

function pickDisplayName(p) {
  const init = buildInitiatedName(p);
  const base = init || safeStr(p?.name) || "Devotee";
  const g = safeStr(p?.gender).toLowerCase();

  if (g === "female") return `${base} Mataji`;
  if (g === "male") return `${base} Prabhuji`;
  return base;
}

function pickFamilyDisplayName(p) {
  const init = buildInitiatedName(p);
  return init || safeStr(p?.name) || "Devotee";
}

function makeKeyFromMobileOrName(mobile, name, mmdd = "") {
  const m = safeStr(mobile);
  if (m) return `m:${m}`;
  return `n:${safeStr(name).toLowerCase()}:${mmdd}`;
}

async function saveRunSummary({ type, slot, eventDate, stats, details }) {
  const key = {
    type,
    topic: "festivals",
    slot,
    eventDate,
    event: "summary",
  };

  await NotificationLog.findOneAndUpdate(
    key,
    {
      $set: {
        ...key,
        status: "completed",
        stats,
        details,
      },
    },
    { upsert: true, new: true }
  );
}

async function runBirthdaysTomorrow7pm(context, opts = {}) {
  const log = (...a) => (context?.log ? context.log(...a) : console.log(...a));
  const warn = (...a) => (context?.log ? context.log(...a) : console.warn(...a));

  const slot = "tomorrow_7pm";
  const baseYmd = opts.forceBaseYmd || istYmd(new Date());
  const targetYmd = addDaysYmd(baseYmd, 1);
  const [, mm, dd] = targetYmd.split("-");
  const targetKey = `${mm}-${dd}`;

  const startedAt = new Date().toISOString();

  const mongoOk = await ensureMongo(context);
  if (!mongoOk) {
    warn("Mongo not connected");
    await saveRunSummary({
      type: "birthday_run",
      slot,
      eventDate: targetYmd,
      stats: {
        baseYmd,
        eventDate: targetYmd,
        mongoOk: false,
        totalPeople: 0,
        topicSent: 0,
        topicFailed: 0,
        startedAt,
        endedAt: new Date().toISOString(),
      },
      details: [{ step: "mongo", status: "failed" }],
    });
    return;
  }

  const devotees = await Devotee.find(
    { dateOfBirth: { $ne: null } },
    {
      name: 1,
      gender: 1,
      mobileNo: 1,
      dateOfBirth: 1,
      isInitiated: 1,
      initiationName: 1,
      initiationTitle: 1,
      spouseDetails: 1,
      childrenDetails: 1,
    }
  ).lean();

  const people = [];
  const added = new Set();

  for (const d of devotees) {
    if (monthDayKeyFromDate(d.dateOfBirth) === targetKey) {
      const name = pickDisplayName(d);
      const key = makeKeyFromMobileOrName(d.mobileNo, name, targetKey);
      if (!added.has(key)) {
        people.push({ name });
        added.add(key);
      }
    }

    const sp = d.spouseDetails;
    if (sp?.dateOfBirth && monthDayKeyFromDate(sp.dateOfBirth) === targetKey) {
      const name = pickFamilyDisplayName(sp);
      const key = makeKeyFromMobileOrName(sp.mobileNo, name, targetKey);
      if (!added.has(key)) {
        people.push({ name });
        added.add(key);
      }
    }

    const kids = Array.isArray(d.childrenDetails) ? d.childrenDetails : [];
    for (const c of kids) {
      if (!c?.dateOfBirth) continue;
      if (monthDayKeyFromDate(c.dateOfBirth) !== targetKey) continue;

      const name = pickFamilyDisplayName(c);
      const key = makeKeyFromMobileOrName(c.mobileNo, name, targetKey);
      if (!added.has(key)) {
        people.push({ name });
        added.add(key);
      }
    }
  }

  const details = [];
  let topicSent = 0;
  let topicFailed = 0;

  if (!people.length) {
    details.push({ step: "topic", status: "skipped_no_birthdays" });
  } else {
    const topicKey = {
      type: "birthday",
      topic: "festivals",
      slot,
      eventDate: targetYmd,
      event: "summary",
    };

    const already = await NotificationLog.findOne(topicKey).lean();
    if (already) {
      details.push({ step: "topic", status: "skipped_already_sent" });
    } else {
      const count = people.length;
      const namesText = formatNames(people, 8);
      const title = "🎂 Tomorrow: Birthdays (ISKCON Vesu)";
      const body = `(${count}) ${namesText}`;

      try {
        const messageId = await sendFestivalsTopicNotification({
          title,
          body,
          data: { type: "birthday", slot, date: targetYmd, count },
        });

        await NotificationLog.create({ ...topicKey, status: "sent", messageId });
        topicSent += 1;
        details.push({ step: "topic", status: "sent", messageId });
      } catch (err) {
        const emsg = err?.message || String(err);
        await NotificationLog.create({ ...topicKey, status: "failed", error: emsg }).catch(() => {});
        topicFailed += 1;
        details.push({ step: "topic", status: "failed", error: emsg });
      }
    }
  }

  await saveRunSummary({
    type: "birthday_run",
    slot,
    eventDate: targetYmd,
    stats: {
      baseYmd,
      eventDate: targetYmd,
      mongoOk: true,
      totalPeople: people.length,
      topicSent,
      topicFailed,
      startedAt,
      endedAt: new Date().toISOString(),
    },
    details,
  });
}

app.timer("birthdaysTomorrow7pm", {
  // 7:00 PM IST = 13:30 UTC
  schedule: "0 30 13 * * *",
  handler: async (_timer, context) => runBirthdaysTomorrow7pm(context),
});

module.exports = { runBirthdaysTomorrow7pm };
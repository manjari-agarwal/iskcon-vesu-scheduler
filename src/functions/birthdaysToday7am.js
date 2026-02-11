const { app } = require("@azure/functions");
const Devotee = require("../models/Devotee");
const Login = require("../models/Login");
const NotificationLog = require("../models/notificationLogs");
const { ensureMongo } = require("../config/mongo");
const { istYmd } = require("../utils/dateIst");
const { getAdmin } = require("../config/firebase");
const { sendFestivalsTopicNotification } = require("../utils/fcmFunctions");

// ---- helpers ----
function safeStr(s) {
  return String(s || "").trim();
}

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

function pickDisplayName(p) {
  return safeStr(p.initiationName) || safeStr(p.name) || "Devotee";
}

function makeKeyFromMobileOrName(mobile, name) {
  const m = safeStr(mobile);
  if (m) return `m:${m}`;
  return `n:${safeStr(name).toLowerCase()}`;
}

/**
 * Send to a single token and return detailed result
 */
async function sendToToken(admin, token, title, body, data = {}) {
  if (!token) return { ok: false, skipped: true, reason: "no_token" };

  try {
    const messageId = await admin.messaging().send({
      token,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? "")])),
      android: { notification: { channelId: "default" } },
    });
    return { ok: true, messageId };
  } catch (err) {
    return {
      ok: false,
      errorCode: err?.code,
      errorMessage: err?.message || String(err),
    };
  }
}

/**
 * Upsert a run summary doc (always one per day/slot)
 */
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

async function runBirthdaysToday7am(context, opts = {}) {
  const log = (...a) => (context?.log ? context.log(...a) : console.log(...a));
  const warn = (...a) => (context?.log ? context.log(...a) : console.warn(...a));

  const slot = "today_7am";

  const forcedYmd = safeStr(opts.forceYmd);
  const todayYmd = forcedYmd || istYmd(new Date());
  const [, mm, dd] = todayYmd.split("-");
  const todayKey = `${mm}-${dd}`;

  const startedAt = new Date().toISOString();

  log("========== BIRTHDAY JOB START ==========");
  log("IST date:", todayYmd, "todayKey:", todayKey, "slot:", slot);

  const mongoOk = await ensureMongo(context);
  if (!mongoOk) {
    warn("❌ Mongo not connected. Exiting.");
    await saveRunSummary({
      type: "birthday_run",
      slot,
      eventDate: todayYmd,
      stats: {
        date: todayYmd,
        mongoOk: false,
        totalPeople: 0,
        topicSent: 0,
        topicFailed: 0,
        personalSent: 0,
        personalFailed: 0,
        personalSkippedNoToken: 0,
        startedAt,
        endedAt: new Date().toISOString(),
      },
      details: [{ step: "mongo", status: "failed" }],
    });
    return;
  }

  const admin = await getAdmin();

  // pull full fields needed for spouse/children logic
  const devotees = await Devotee.find(
    { dateOfBirth: { $ne: null } },
    {
      name: 1,
      mobileNo: 1,
      dateOfBirth: 1,
      initiationName: 1,
      spouseDetails: 1,
      childrenDetails: 1,
    }
  ).lean();

  log("Devotees loaded:", devotees.length);

  const devoteeMobiles = new Set(devotees.map(d => safeStr(d.mobileNo)).filter(Boolean));

  const loginMobiles = await Login.find(
    { mobile: { $in: Array.from(devoteeMobiles) } },
    { mobile: 1 }
  ).lean();

  const registeredMobiles = new Set([
    ...devoteeMobiles,
    ...loginMobiles.map(l => safeStr(l.mobile)).filter(Boolean),
  ]);

  // build people list (devotee + spouse/children if not registered)
  const people = [];
  const added = new Set();

  for (const d of devotees) {
    if (monthDayKeyFromDate(d.dateOfBirth) !== todayKey) continue;

    const displayName = pickDisplayName(d);
    const uniqueKey = makeKeyFromMobileOrName(d.mobileNo, displayName);
    if (added.has(uniqueKey)) continue;

    people.push({
      name: displayName,
      initiationName: safeStr(d.initiationName),
      mobileNo: safeStr(d.mobileNo),
      source: "devotee",
      parentMobileNo: safeStr(d.mobileNo),
    });
    added.add(uniqueKey);
  }

  for (const d of devotees) {
    const sp = d.spouseDetails;
    if (sp?.dateOfBirth && monthDayKeyFromDate(sp.dateOfBirth) === todayKey) {
      const spMobile = safeStr(sp.mobileNo);
      const spName = pickDisplayName(sp);

      if (!spMobile || !registeredMobiles.has(spMobile)) {
        const uniqueKey = makeKeyFromMobileOrName(spMobile, spName);
        if (!added.has(uniqueKey)) {
          people.push({
            name: spName,
            initiationName: safeStr(sp.initiationName),
            mobileNo: spMobile,
            source: "spouse",
            parentMobileNo: safeStr(d.mobileNo),
          });
          added.add(uniqueKey);
        }
      }
    }

    const kids = Array.isArray(d.childrenDetails) ? d.childrenDetails : [];
    for (const c of kids) {
      if (!c?.dateOfBirth) continue;
      if (monthDayKeyFromDate(c.dateOfBirth) !== todayKey) continue;

      const cMobile = safeStr(c.mobileNo);
      const cName = pickDisplayName(c);

      if (!cMobile || !registeredMobiles.has(cMobile)) {
        const uniqueKey = makeKeyFromMobileOrName(cMobile, cName);
        if (!added.has(uniqueKey)) {
          people.push({
            name: cName,
            initiationName: safeStr(c.initiationName),
            mobileNo: cMobile,
            source: "child",
            parentMobileNo: safeStr(d.mobileNo),
          });
          added.add(uniqueKey);
        }
      }
    }
  }

  log("Birthdays people found:", people.length);

  const details = [];
  let topicSent = 0;
  let topicFailed = 0;
  let personalSent = 0;
  let personalFailed = 0;
  let personalSkippedNoToken = 0;

  // ---------- TOPIC SUMMARY ----------
  if (people.length) {
    const topicKey = {
      type: "birthday",
      topic: "festivals",
      slot,
      eventDate: todayYmd,
      event: "summary",
    };

    const already = await NotificationLog.findOne(topicKey).lean();
    log("Topic already sent?", !!already);

    if (!already) {
      const count = people.length;
      const namesText = formatNames(people, 8);

      const title = "🎉 Today: Birthdays (ISKCON Vesu)";
      const body = `(${count}) ${namesText}`;

      log("[TOPIC] Sending:", { title, body });

      try {
        const messageId = await sendFestivalsTopicNotification({
          title,
          body,
          data: { type: "birthday", slot, date: todayYmd, count },
        });

        await NotificationLog.create({ ...topicKey, status: "sent", messageId });
        topicSent += 1;
        details.push({ step: "topic", status: "sent", messageId });
        log("[TOPIC] ✅ Sent:", messageId);
      } catch (err) {
        const emsg = err?.message || String(err);
        await NotificationLog.create({ ...topicKey, status: "failed", error: emsg }).catch(() => {});
        topicFailed += 1;
        details.push({ step: "topic", status: "failed", error: emsg });
        warn("[TOPIC] ❌ Failed:", emsg);
      }
    } else {
      details.push({ step: "topic", status: "skipped_already_sent" });
    }
  } else {
    details.push({ step: "topic", status: "skipped_no_birthdays" });
  }

  // ---------- PERSONAL ----------
  const mobiles = people.map(p => safeStr(p.mobileNo)).filter(Boolean);
  const logins = mobiles.length
    ? await Login.find({ mobile: { $in: mobiles } }, { mobile: 1, fcmToken: 1 }).lean()
    : [];

  const tokenMap = new Map(logins.map(l => [safeStr(l.mobile), safeStr(l.fcmToken)]));
  const loginMobileSet = new Set(logins.map(l => safeStr(l.mobile)));

  const missingInLogin = mobiles.filter(m => !loginMobileSet.has(m));
  if (missingInLogin.length) {
    warn("Mobiles missing in Login (no token possible):", missingInLogin.join(", "));
    details.push({ step: "personal", status: "missing_login_rows", mobiles: missingInLogin });
  }

  for (const p of people) {
    const mobile = safeStr(p.mobileNo);
    if (!mobile) {
      personalSkippedNoToken += 1;
      details.push({ step: "personal", status: "skipped_no_mobile", name: p.name, source: p.source });
      continue;
    }

    const token = tokenMap.get(mobile);
    if (!token) {
      personalSkippedNoToken += 1;
      details.push({ step: "personal", status: "skipped_no_token", mobile, name: p.name });
      continue;
    }

    const personalKey = {
      type: "birthday_personal",
      topic: "token",
      slot,
      eventDate: todayYmd,
      event: mobile,
    };

    const already = await NotificationLog.findOne(personalKey).lean();
    if (already) {
      details.push({ step: "personal", status: "skipped_already_sent", mobile });
      continue;
    }

    const displayName = p.initiationName || p.name || "Devotee";
    const title = "Hare Krishna 🙏";
    const body = `Happy Birthday ${displayName}! 🎂`;

    const res = await sendToToken(admin, token, title, body, { type: "birthday", date: todayYmd });

    if (res.ok) {
      personalSent += 1;
      await NotificationLog.create({ ...personalKey, status: "sent", messageId: res.messageId });
      details.push({ step: "personal", status: "sent", mobile, messageId: res.messageId });
    } else {
      personalFailed += 1;
      const emsg = `${res.errorCode || ""} ${res.errorMessage || ""}`.trim();
      await NotificationLog.create({ ...personalKey, status: "failed", error: emsg }).catch(() => {});
      details.push({ step: "personal", status: "failed", mobile, error: emsg });

      const code = String(res.errorCode || "");
      if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
        await Login.updateOne({ mobile }, { $set: { fcmToken: null } }).catch(() => {});
        details.push({ step: "personal", status: "token_cleared", mobile });
      }
    }
  }

  const endedAt = new Date().toISOString();

  await saveRunSummary({
    type: "birthday_run",
    slot,
    eventDate: todayYmd,
    stats: {
      date: todayYmd,
      mongoOk: true,
      totalPeople: people.length,
      topicSent,
      topicFailed,
      personalSent,
      personalFailed,
      personalSkippedNoToken,
      startedAt,
      endedAt,
    },
    details,
  });

  log("========== BIRTHDAY JOB DONE ==========");
  log("Summary:", {
    totalPeople: people.length,
    topicSent,
    topicFailed,
    personalSent,
    personalFailed,
    personalSkippedNoToken,
  });
}

app.timer("birthdaysToday7am", {
  schedule: "0 30 5 * * *", // 7:00 AM IST (00:30 UTC) - keep as you need
  handler: async (_timer, context) => runBirthdaysToday7am(context),
});

module.exports = { runBirthdaysToday7am };

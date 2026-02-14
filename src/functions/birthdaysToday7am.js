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

function formatNames(people, limit = 8) {
  const names = people
    .map((d) => safeStr(d?.name) || safeStr(d?.initiationName))
    .filter(Boolean);
  const shown = names.slice(0, limit);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(", ")} +${more} more` : shown.join(", ");
}

// Devotee display name (adds Prabhuji/Mataji based on gender)
function pickDisplayName(p) {
  const init = `${safeStr(p?.initiationName)} ${safeStr(p?.initiationTitle)}`.trim();
  const base = init || safeStr(p?.name) || "Devotee";

  const g = safeStr(p?.gender).toLowerCase();
  if (g === "female") return `${base} Mataji`;
  if (g === "male") return `${base} Prabhuji`;

  return base;
}

// Spouse/Child display name (NO Prabhuji/Mataji)
function pickFamilyDisplayName(p) {
  const init = `${safeStr(p?.initiationName)} ${safeStr(p?.initiationTitle)}`.trim();
  return init || safeStr(p?.name) || "Devotee";
}

function makeKeyFromMobileOrName(mobile, name, mmdd = "") {
  const m = safeStr(mobile);
  if (m) return `m:${m}`;
  const n = safeStr(name).toLowerCase();
  return `n:${n}:${mmdd}`;
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
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v ?? "")])
      ),
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
      gender: 1,
      mobileNo: 1,
      dateOfBirth: 1,
      initiationName: 1,
      initiationTitle: 1,
      spouseDetails: 1,
      childrenDetails: 1,
    }
  ).lean();

  log("Devotees loaded:", devotees.length);

  // ---------- helpers (for standalone detection) ----------
  const toYmd = (d) => {
    if (!d) return "";
    const dt = new Date(d);
    if (isNaN(dt)) return "";
    return dt.toISOString().slice(0, 10);
  };

  const norm = (s = "") => String(s).trim().toLowerCase();

  const buildInitiatedName = (x) =>
    `${x?.initiationName || ""} ${x?.initiationTitle || ""}`.trim();

  // Build lookup maps of real devotees (to detect spouse/child already exists)
  const devoteeByMobile = new Map();
  const devoteeByNameDob = new Map();

  for (const d of devotees) {
    const m = safeStr(d.mobileNo);
    const dobYmd = toYmd(d.dateOfBirth);
    const n1 = norm(d.name);
    const n2 = norm(buildInitiatedName(d));

    if (m) devoteeByMobile.set(m, d);

    if (dobYmd) {
      if (n2) devoteeByNameDob.set(`${n2}|${dobYmd}`, d);
      if (n1) devoteeByNameDob.set(`${n1}|${dobYmd}`, d);
    }
  }

  const existsAsDevotee = ({ mobileNo, name, initiationName, dob }) => {
    const dobYmd = toYmd(dob);
    const m = safeStr(mobileNo);
    if (m && devoteeByMobile.has(m)) return true;

    const ini = norm(initiationName);
    if (ini && dobYmd && devoteeByNameDob.has(`${ini}|${dobYmd}`)) return true;

    const n = norm(name);
    if (n && dobYmd && devoteeByNameDob.has(`${n}|${dobYmd}`)) return true;

    return false;
  };

  // ---------- build people list ----------
  const people = [];
  const added = new Set();

  // collect spouse/child candidates for today (to check in Login once)
  const familyCandidates = [];

  // 1) SELF birthdays (always included)
  for (const d of devotees) {
    if (monthDayKeyFromDate(d.dateOfBirth) !== todayKey) continue;

    const displayName = pickDisplayName(d); // ✅ includes Prabhuji/Mataji
    const uniqueKey = makeKeyFromMobileOrName(d.mobileNo, displayName, todayKey);
    if (added.has(uniqueKey)) continue;

    people.push({
      name: displayName, // final display name (already has Prabhuji/Mataji)
      initiationName: buildInitiatedName(d),
      mobileNo: safeStr(d.mobileNo),
      gender: safeStr(d.gender),
      source: "devotee",
      parentMobileNo: safeStr(d.mobileNo),
    });
    added.add(uniqueKey);
  }

  // 2) Collect spouse/child candidates for today
  for (const d of devotees) {
    const parentMobile = safeStr(d.mobileNo);

    // spouse
    const sp = d.spouseDetails;
    if (sp?.dateOfBirth && monthDayKeyFromDate(sp.dateOfBirth) === todayKey) {
      familyCandidates.push({
        relation: "spouse",
        parentMobileNo: parentMobile,
        dateOfBirth: sp.dateOfBirth,
        name: pickFamilyDisplayName(sp), // ✅ NO Prabhuji/Mataji
        initiationName: buildInitiatedName(sp),
        mobileNo: safeStr(sp.mobileNo),
      });
    }

    // children
    const kids = Array.isArray(d.childrenDetails) ? d.childrenDetails : [];
    for (const c of kids) {
      if (!c?.dateOfBirth) continue;
      if (monthDayKeyFromDate(c.dateOfBirth) !== todayKey) continue;

      familyCandidates.push({
        relation: "child",
        parentMobileNo: parentMobile,
        dateOfBirth: c.dateOfBirth,
        name: pickFamilyDisplayName(c), // ✅ NO Prabhuji/Mataji
        initiationName: buildInitiatedName(c),
        mobileNo: safeStr(c.mobileNo),
      });
    }
  }

  // 3) Check which family candidates are standalone registered users (Devotee or Login)
  const familyMobiles = Array.from(
    new Set(familyCandidates.map((x) => safeStr(x.mobileNo)).filter(Boolean))
  );

  const loginRowsForFamily = familyMobiles.length
    ? await Login.find({ mobile: { $in: familyMobiles } }, { mobile: 1 }).lean()
    : [];

  const familyMobileInLogin = new Set(
    loginRowsForFamily.map((r) => safeStr(r.mobile)).filter(Boolean)
  );

  // 4) Add spouse/child only if NOT registered as devotee AND NOT registered in login
  for (const fc of familyCandidates) {
    const m = safeStr(fc.mobileNo);

    // If spouse/child has no mobile -> include (cannot be standalone Login user)
    // If has mobile and exists as Devotee OR exists in Login -> skip
    const isStandaloneRegistered =
      existsAsDevotee({
        mobileNo: m,
        name: fc.name,
        initiationName: fc.initiationName,
        dob: fc.dateOfBirth,
      }) || (m && familyMobileInLogin.has(m));

    if (isStandaloneRegistered) continue;

    const uniqueKey = makeKeyFromMobileOrName(m, fc.name, todayKey);
    if (added.has(uniqueKey)) continue;

    people.push({
      name: fc.name,
      initiationName: safeStr(fc.initiationName),
      mobileNo: m,
      source: fc.relation, // "spouse" or "child"
      parentMobileNo: safeStr(fc.parentMobileNo),
    });

    added.add(uniqueKey);
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
        await NotificationLog.create({ ...topicKey, status: "failed", error: emsg }).catch(
          () => {}
        );
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
  const mobiles = people.map((p) => safeStr(p.mobileNo)).filter(Boolean);
  const logins = mobiles.length
    ? await Login.find({ mobile: { $in: mobiles } }, { mobile: 1, fcmToken: 1 }).lean()
    : [];

  const tokenMap = new Map(logins.map((l) => [safeStr(l.mobile), safeStr(l.fcmToken)]));
  const loginMobileSet = new Set(logins.map((l) => safeStr(l.mobile)));

  const missingInLogin = mobiles.filter((m) => !loginMobileSet.has(m));
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

    // ✅ IMPORTANT: use p.name (already formatted with Prabhuji/Mataji for devotees)
    const displayName = safeStr(p.name) || "Devotee";
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
  // 7:00 AM IST = 01:30 UTC
  schedule: "0 30 1 * * *",
  handler: async (_timer, context) => runBirthdaysToday7am(context),
});

module.exports = { runBirthdaysToday7am };

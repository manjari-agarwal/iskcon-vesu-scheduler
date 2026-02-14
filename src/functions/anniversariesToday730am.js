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
  const ymd = istYmd(new Date(d));
  const [, mm, dd] = ymd.split("-");
  return `${mm}-${dd}`;
}

function preferName(p) {
  // Priority: initiationName+title, then name
  const init = `${safeStr(p?.initiationName)} ${safeStr(p?.initiationTitle)}`.trim();
  return init || safeStr(p?.initiationName) || safeStr(p?.name) || "Devotee";
}

function formatNames(items, limit = 8) {
  const names = items.map((d) => safeStr(d.displayName || d.name)).filter(Boolean);
  const shown = names.slice(0, limit);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(", ")} +${more} more` : shown.join(", ");
}

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
 * ✅ Always upsert a run summary doc (ONE per day per slot)
 */
async function upsertRunSummary({ todayYmd, slot, stats, details, context }) {
  const log = (...a) => (context?.log ? context.log(...a) : console.log(...a));

  const key = {
    type: "anniversary_run",
    topic: "festivals",
    slot,
    eventDate: todayYmd,
    event: "summary",
  };

  try {
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

    log("[SUMMARY] ✅ Upserted anniversary_run summary");
  } catch (e) {
    log("[SUMMARY] ❌ Failed to upsert anniversary_run summary:", e?.message || e);
  }
}

async function runAnniversariesToday730am(context, opts = {}) {
  const log = (...a) => (context?.log ? context.log(...a) : console.log(...a));
  const warn = (...a) => (context?.log ? context.log(...a) : console.warn(...a));

  const slot = "today_730am";

  const forcedYmd = safeStr(opts.forceYmd);
  const todayYmd = forcedYmd || istYmd(new Date());
  const [, mm, dd] = todayYmd.split("-");
  const todayKey = `${mm}-${dd}`;

  const startedAt = new Date().toISOString();

  log("========== ANNIVERSARY JOB START ==========");
  log("IST date:", todayYmd, "todayKey:", todayKey, "slot:", slot, "force?", !!forcedYmd);

  const stats = {
    date: todayYmd,
    mongoOk: false,
    totalCandidates: 0,
    todaysCount: 0,
    todaysListCountAfterClubbing: 0,
    topic: { sent: 0, failed: 0, skippedAlready: 0, skippedNoAnniversaries: 0 },
    personal: { sent: 0, failed: 0, skippedNoToken: 0, skippedAlready: 0, skippedNoMobile: 0 },
    startedAt,
    endedAt: null,
  };

  const details = [];

  const mongoOk = await ensureMongo(context);
  if (!mongoOk) {
    warn("❌ Mongo not connected. Exiting.");

    stats.mongoOk = false;
    stats.endedAt = new Date().toISOString();
    details.push({ step: "mongo", status: "failed" });

    await upsertRunSummary({ todayYmd, slot, stats, details, context });
    return;
  }

  stats.mongoOk = true;

  const admin = await getAdmin();

  // ✅ pull initiationTitle too, and spouseDetails (for pairing by mobile)
  const devotees = await Devotee.find(
    { dateOfMarriage: { $ne: null } },
    { name: 1, mobileNo: 1, dateOfMarriage: 1, initiationName: 1, initiationTitle: 1, gender: 1, spouseDetails: 1 }
  ).lean();

  stats.totalCandidates = devotees.length;

  const todaysAnniversaries = devotees.filter((d) => monthDayKeyFromDate(d.dateOfMarriage) === todayKey);
  stats.todaysCount = todaysAnniversaries.length;

  log("Devotees with marriage date:", devotees.length);
  log("Today's anniversaries:", todaysAnniversaries.length);

  // ======================================================
  // ✅ CLUBBING FOR TOPIC LIST ONLY:
  // If spouse mobile matches another registered user in today list,
  // club as "MaleName & FemaleName" (male first). No duplicates.
  // Name priority: initiationName+title then name.
  // If no match -> keep as individual.
  // ======================================================
  const byMobileToday = new Map();
  for (const d of todaysAnniversaries) {
    const m = safeStr(d.mobileNo);
    if (m) byMobileToday.set(m, d);
  }

  const pairKeySet = new Set(); // prevent duplicates in list
  const clubbedForTopic = [];

  for (const d of todaysAnniversaries) {
    const myMobile = safeStr(d.mobileNo);
    const spouseMobile = safeStr(d?.spouseDetails?.mobileNo);

    // If can't pair, keep individual
    if (!myMobile || !spouseMobile) {
      clubbedForTopic.push({
        displayName: preferName(d),
        members: [myMobile].filter(Boolean),
      });
      continue;
    }

    const spouseDevotee = byMobileToday.get(spouseMobile);

    // spouse exists AND is in today's anniversary list -> club them
    if (spouseDevotee) {
      const a = myMobile;
      const b = spouseMobile;
      const stablePairKey = [a, b].sort().join("|"); // prevents duplicates
      if (pairKeySet.has(stablePairKey)) continue;
      pairKeySet.add(stablePairKey);

      const d1 = d;
      const d2 = spouseDevotee;

      const g1 = safeStr(d1.gender).toLowerCase();
      const g2 = safeStr(d2.gender).toLowerCase();

      const name1 = preferName(d1);
      const name2 = preferName(d2);

      // male first, otherwise keep name1 then name2
      let first = name1;
      let second = name2;

      if (g1 === "male" && g2 === "female") {
        first = name1;
        second = name2;
      } else if (g1 === "female" && g2 === "male") {
        first = name2;
        second = name1;
      }

      clubbedForTopic.push({
        displayName: `${first} & ${second}`,
        members: [a, b],
      });
    } else {
      // spouse not in today's list -> keep individual
      clubbedForTopic.push({
        displayName: preferName(d),
        members: [myMobile].filter(Boolean),
      });
    }
  }

  stats.todaysListCountAfterClubbing = clubbedForTopic.length;

  details.push({
    step: "candidates",
    status: "ok",
    totalCandidates: devotees.length,
    todaysCount: todaysAnniversaries.length,
    todaysListCountAfterClubbing: clubbedForTopic.length,
    todaysListPreview: clubbedForTopic.slice(0, 20),
  });

  // -------------------------
  // 1) TOPIC SUMMARY (use clubbedForTopic)
  // -------------------------
  if (!clubbedForTopic.length) {
    stats.topic.skippedNoAnniversaries += 1;
    details.push({ step: "topic", status: "skipped_no_anniversaries" });
  } else {
    const key = {
      type: "anniversary",
      topic: "festivals",
      slot,
      eventDate: todayYmd,
      event: "summary",
    };

    const already = await NotificationLog.findOne(key).lean();
    log("Topic already sent?", !!already);

    if (already) {
      stats.topic.skippedAlready += 1;
      details.push({ step: "topic", status: "skipped_already_sent", messageId: already.messageId || null });
    } else {
      const count = clubbedForTopic.length;
      const namesText = formatNames(clubbedForTopic, 8);

      const title = "🎉 Today: Wedding Anniversaries (ISKCON Vesu)";
      const body = `(${count}) ${namesText}`;

      log("[TOPIC] Sending:", { title, body });

      try {
        const messageId = await sendFestivalsTopicNotification({
          title,
          body,
          data: { type: "anniversary", slot, date: todayYmd, count },
        });

        await NotificationLog.create({ ...key, status: "sent", messageId });
        stats.topic.sent += 1;
        details.push({ step: "topic", status: "sent", messageId });
        log("[TOPIC] ✅ Sent:", messageId);
      } catch (err) {
        const emsg = err?.message || String(err);
        await NotificationLog.create({ ...key, status: "failed", error: emsg }).catch(() => {});
        stats.topic.failed += 1;
        details.push({ step: "topic", status: "failed", error: emsg });
        warn("[TOPIC] ❌ Failed:", emsg);
      }
    }
  }

  // -------------------------
  // 2) PERSONAL (send to EACH registered user separately)
  // -------------------------
  const mobiles = todaysAnniversaries.map((d) => safeStr(d.mobileNo)).filter(Boolean);

  const logins = mobiles.length
    ? await Login.find({ mobile: { $in: mobiles } }, { mobile: 1, fcmToken: 1 }).lean()
    : [];

  const tokenMap = new Map(logins.map((l) => [safeStr(l.mobile), safeStr(l.fcmToken)]));
  const loginMobileSet = new Set(logins.map((l) => safeStr(l.mobile)));

  const missingInLogin = mobiles.filter((m) => !loginMobileSet.has(m));
  if (missingInLogin.length) {
    details.push({ step: "personal", status: "missing_login_rows", mobiles: missingInLogin });
  }

  for (const d of todaysAnniversaries) {
    const mobile = safeStr(d.mobileNo);
    if (!mobile) {
      stats.personal.skippedNoMobile += 1;
      details.push({ step: "personal", status: "skipped_no_mobile", name: preferName(d) });
      continue;
    }

    const token = tokenMap.get(mobile);
    if (!token) {
      stats.personal.skippedNoToken += 1;
      details.push({ step: "personal", status: "skipped_no_token", mobile });
      continue;
    }

    const key = {
      type: "anniversary_personal",
      topic: "token",
      slot,
      eventDate: todayYmd,
      event: mobile,
    };

    const already = await NotificationLog.findOne(key).lean();
    if (already) {
      stats.personal.skippedAlready += 1;
      details.push({ step: "personal", status: "skipped_already_sent", mobile });
      continue;
    }

    const displayName = preferName(d);
    const title = "Hare Krishna 🙏";
    const body = `Happy Wedding Anniversary ${displayName}! 🎉`;

    const res = await sendToToken(admin, token, title, body, { type: "anniversary", date: todayYmd });

    if (res.ok) {
      stats.personal.sent += 1;
      await NotificationLog.create({ ...key, status: "sent", messageId: res.messageId });
      details.push({ step: "personal", status: "sent", mobile, messageId: res.messageId });
    } else {
      stats.personal.failed += 1;
      const emsg = `${res.errorCode || ""} ${res.errorMessage || ""}`.trim();
      await NotificationLog.create({ ...key, status: "failed", error: emsg }).catch(() => {});
      details.push({ step: "personal", status: "failed", mobile, error: emsg });

      const code = String(res.errorCode || "");
      if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
        await Login.updateOne({ mobile }, { $set: { fcmToken: null } }).catch(() => {});
        details.push({ step: "personal", status: "token_cleared", mobile });
      }
    }
  }

  stats.endedAt = new Date().toISOString();

  await upsertRunSummary({ todayYmd, slot, stats, details, context });

  log("========== ANNIVERSARY JOB DONE ==========");
  log("Summary:", stats);
}

app.timer("anniversariesToday730am", {
  // ✅ 7:30 AM IST = 02:00 UTC
  schedule: "0 0 2 * * *",
  handler: async (_timer, context) => runAnniversariesToday730am(context),
});

module.exports = { runAnniversariesToday730am };
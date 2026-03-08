const { app } = require("@azure/functions");
const Announcement = require("../models/Announcements");
const NotificationLog = require("../models/notificationLogs");
const { ensureMongo } = require("../config/mongo");
const { istYmd } = require("../utils/dateIst");
const { sendAnnouncementScheduledTopicNotification } = require("../utils/fcmFunctions");

const GAP_MINUTES = Number(process.env.ANNOUNCEMENT_GAP_MINUTES || 3);

function safeStr(s) {
  return String(s || "").trim();
}

function truncateText(text, max = 90) {
  const str = safeStr(text);
  if (!str) return "";
  return str.length > max ? `${str.slice(0, max)}...` : str;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAnnouncementsToday10am(context, opts = {}) {
  const slot = "today_10am";
  const todayYmd = opts.forceYmd || istYmd(new Date());

  const mongoOk = await ensureMongo(context);
  if (!mongoOk) return;

  const start = new Date(`${todayYmd}T00:00:00+05:30`);
  const end = new Date(`${todayYmd}T23:59:59.999+05:30`);

  const docs = await Announcement.find({
    date: { $gte: start, $lte: end }
  })
    .sort({ date: 1, createdAt: 1 })
    .lean();

  context.log(`[announcementsToday10am] Found ${docs.length} announcements for ${todayYmd}`);

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];

    const key = {
      type: "announcement",
      topic: "announcements",
      slot,
      eventDate: todayYmd,
      event: String(doc._id),
    };

    const already = await NotificationLog.findOne(key).lean();
    if (already) {
      context.log(`[announcementsToday10am] Already sent/skipped for ${doc._id}`);
      continue;
    }

    const title = "📢 Today’s Announcement";
    const body = truncateText(doc.title || doc.subtitle || "Please check today’s temple update");

    try {
      const messageId = await sendAnnouncementScheduledTopicNotification({
        title,
        body,
        doc,
        data: {
          slot,
          mode: "today",
          order: i + 1,
          total: docs.length,
        },
      });

      await NotificationLog.create({
        ...key,
        status: "sent",
        messageId,
      });

      context.log(`[announcementsToday10am] Sent ${i + 1}/${docs.length} -> ${doc._id}`);

      // delay only if another announcement is pending
      if (i < docs.length - 1) {
        await sleep(GAP_MINUTES * 60 * 1000);
      }
    } catch (err) {
      await NotificationLog.create({
        ...key,
        status: "failed",
        error: err?.message || String(err),
      }).catch(() => {});

      context.log(`[announcementsToday10am] Failed for ${doc._id}: ${err?.message || err}`);
    }
  }
}

app.timer("announcementsToday10am", {
  // 10:00 AM IST = 04:30 UTC
  schedule: "0 30 4 * * *",
  handler: async (_timer, context) => runAnnouncementsToday10am(context),
});

module.exports = { runAnnouncementsToday10am };
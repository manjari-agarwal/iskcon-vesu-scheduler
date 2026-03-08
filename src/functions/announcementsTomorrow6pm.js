const { app } = require("@azure/functions");
const Announcement = require("../models/Announcements");
const NotificationLog = require("../models/notificationLogs");
const { ensureMongo } = require("../config/mongo");
const { istYmd, addDaysYmd } = require("../utils/dateIst");
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

async function runAnnouncementsTomorrow6pm(context, opts = {}) {
  const slot = "tomorrow_6pm";
  const baseYmd = opts.forceBaseYmd || istYmd(new Date());
  const targetYmd = addDaysYmd(baseYmd, 1);

  const mongoOk = await ensureMongo(context);
  if (!mongoOk) return;

  const start = new Date(`${targetYmd}T00:00:00+05:30`);
  const end = new Date(`${targetYmd}T23:59:59.999+05:30`);

  const docs = await Announcement.find({
    date: { $gte: start, $lte: end }
  })
    .sort({ date: 1, createdAt: 1 })
    .lean();

  context.log(`[announcementsTomorrow6pm] Found ${docs.length} announcements for ${targetYmd}`);

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];

    const key = {
      type: "announcement",
      topic: "announcements",
      slot,
      eventDate: targetYmd,
      event: String(doc._id),
    };

    const already = await NotificationLog.findOne(key).lean();
    if (already) {
      context.log(`[announcementsTomorrow6pm] Already sent/skipped for ${doc._id}`);
      continue;
    }

    const title = "🔔 Tomorrow’s Announcement";
    const body = truncateText(doc.title || doc.subtitle || "Please check tomorrow’s temple update");

    try {
      const messageId = await sendAnnouncementScheduledTopicNotification({
        title,
        body,
        doc,
        data: {
          slot,
          mode: "tomorrow",
          order: i + 1,
          total: docs.length,
        },
      });

      await NotificationLog.create({
        ...key,
        status: "sent",
        messageId,
      });

      context.log(`[announcementsTomorrow6pm] Sent ${i + 1}/${docs.length} -> ${doc._id}`);

      if (i < docs.length - 1) {
        await sleep(GAP_MINUTES * 60 * 1000);
      }
    } catch (err) {
      await NotificationLog.create({
        ...key,
        status: "failed",
        error: err?.message || String(err),
      }).catch(() => {});

      context.log(`[announcementsTomorrow6pm] Failed for ${doc._id}: ${err?.message || err}`);
    }
  }
}

app.timer("announcementsTomorrow6pm", {
  // 6:00 PM IST = 12:30 UTC
  schedule: "0 30 12 * * *",
  handler: async (_timer, context) => runAnnouncementsTomorrow6pm(context),
});

module.exports = { runAnnouncementsTomorrow6pm };
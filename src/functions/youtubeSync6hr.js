// functions/youtubeSync6hr.js
const { app } = require("@azure/functions");
const { ensureMongo } = require("../config/mongo");

const YoutubeVideo = require("../models/YoutubeVideos");
const { fetchLatestChannelUploads } = require("../services/youtubeServices");

const { YOUTUBE_CHANNEL_ID } = process.env;

function safeInt(v, def) {
  const n = parseInt(String(v || ""), 10);
  return Number.isFinite(n) ? n : def;
}

async function runYoutubeSync6hr(context) {
  const log = (...a) => (context?.log ? context.log(...a) : console.log(...a));
  const warn = (...a) => (context?.log ? context.log(...a) : console.warn(...a));

  log("========== YOUTUBE SYNC START ==========");

  const mongoOk = await ensureMongo(context);
  if (!mongoOk) {
    warn("❌ Mongo not connected. Exiting.");
    return;
  }

  if (!YOUTUBE_CHANNEL_ID) {
    warn("❌ YOUTUBE_CHANNEL_ID missing. Exiting.");
    return;
  }

  const maxItems = safeInt(process.env.YOUTUBE_SYNC_MAX_ITEMS, 300);

  try {
    const videos = await fetchLatestChannelUploads({
      channelId: YOUTUBE_CHANNEL_ID,
      maxItems,
    });

    log(`[YT] fetched: ${videos.length}`);

    if (!videos.length) {
      log("No videos fetched. Done.");
      return;
    }

    // Bulk upsert
    const ops = videos.map((v) => ({
      updateOne: {
        filter: { videoId: v.videoId },
        update: { $set: v },
        upsert: true,
      },
    }));

    const res = await YoutubeVideo.bulkWrite(ops, { ordered: false });

    log("[DB] bulkWrite result:", {
      upsertedCount: res.upsertedCount,
      modifiedCount: res.modifiedCount,
      matchedCount: res.matchedCount,
    });

    // Optional: keep DB small by deleting very old videos (months back)
    const monthsBack = safeInt(process.env.YOUTUBE_SYNC_MONTHS_BACK, 2);
    const cutoff = new Date();
    cutoff.setUTCMonth(cutoff.getUTCMonth() - monthsBack);
    cutoff.setUTCHours(0, 0, 0, 0);

    await YoutubeVideo.deleteMany({
      channelId: YOUTUBE_CHANNEL_ID,
      publishedAt: { $lt: cutoff },
    });

    log(`[DB] cleanup older than: ${cutoff.toISOString()}`);

    log("========== YOUTUBE SYNC DONE ==========");
  } catch (err) {
    console.log("youtubeSync6hr error:", err?.response?.data || err?.message || err);
    warn("========== YOUTUBE SYNC FAILED ==========");
  }
}

app.timer("youtubeSync6hr", {
  // every 6 hours at minute 0
  // Azure Functions cron: {second} {minute} {hour} {day} {month} {day-of-week}
  schedule: "0 0 */12 * * *",
  handler: async (_timer, context) => runYoutubeSync6hr(context),
});

module.exports = { runYoutubeSync6hr };
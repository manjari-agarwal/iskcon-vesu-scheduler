// services/youtubeSync.js
const axios = require("axios");

const { YOUTUBE_API_KEY } = process.env;

const yt = axios.create({
  baseURL: "https://www.googleapis.com/youtube/v3",
  timeout: 150000,
});

// -------------------- FILTER HELPERS --------------------
const isSbContent = (title = "", description = "") => {
  const t = String(title).toLowerCase();
  const d = String(description).toLowerCase();

  const sbRegex = /\b(s\.?b\.?|srimad\s*bhagavatam|bhagavatam|bhagwatam)\b/i;
  const verseRegex = /\b\d+\.\d+\.\d+\b/;

  return sbRegex.test(t) || sbRegex.test(d) || verseRegex.test(t);
};

async function getUploadsPlaylistId(channelId) {
  const res = await yt.get("/channels", {
    params: {
      key: YOUTUBE_API_KEY,
      part: "contentDetails",
      id: channelId,
    },
  });

  const item = res.data?.items?.[0];
  return item?.contentDetails?.relatedPlaylists?.uploads || null;
}

// Fetch ALL (or capped) items of a playlist with pagination
async function getAllPlaylistItems(playlistId, maxItems = 200) {
  const all = [];
  let pageToken = undefined;

  while (all.length < maxItems) {
    const res = await yt.get("/playlistItems", {
      params: {
        key: YOUTUBE_API_KEY,
        part: "snippet,contentDetails",
        playlistId,
        maxResults: 50,
        pageToken,
      },
    });

    const items = res.data?.items || [];
    all.push(...items);

    pageToken = res.data?.nextPageToken;
    if (!pageToken) break;
  }

  return all.slice(0, maxItems);
}

async function getVideosMetaByIds(videoIds = []) {
  if (!videoIds.length) return new Map();

  const metaMap = new Map();
  const chunkSize = 50;

  for (let i = 0; i < videoIds.length; i += chunkSize) {
    const chunk = videoIds.slice(i, i + chunkSize);
    const metaRes = await yt.get("/videos", {
      params: {
        key: YOUTUBE_API_KEY,
        part: "contentDetails,statistics,snippet",
        id: chunk.join(","),
      },
    });

    (metaRes.data?.items || []).forEach((v) => metaMap.set(v.id, v));
  }

  return metaMap;
}

function buildVideoItem({ channelId, videoId, snippet, meta }) {
  const thumb =
    snippet?.thumbnails?.maxres?.url ||
    snippet?.thumbnails?.high?.url ||
    snippet?.thumbnails?.medium?.url ||
    snippet?.thumbnails?.default?.url ||
    null;

  const durationISO = meta?.contentDetails?.duration || null;
  const views = meta?.statistics?.viewCount;

  const isShort =
    typeof durationISO === "string" &&
    (/PT\d{1,2}S/.test(durationISO) ||
      durationISO === "PT1M" ||
      /PT0M\d{1,2}S/.test(durationISO));

  const publishedAt = snippet?.publishedAt ? new Date(snippet.publishedAt) : null;
  const year = publishedAt ? publishedAt.getUTCFullYear() : null;
  const month = publishedAt ? (publishedAt.getUTCMonth() + 1) : null;

  const title = snippet?.title || "";
  const description = snippet?.description || "";

  return {
    channelId,
    videoId,
    title,
    description,
    thumbnail: thumb,
    publishedAt,
    year,
    month,
    url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
    isShort,
    duration: durationISO,
    views: views ? Number(views) : null,
    playlistId: null,
    playlistTitle: null,
    contentFlags: {
      isSbContent: isSbContent(title, description),
    },
  };
}

/**
 * Fetch latest uploads from YouTube channel and return normalized video docs
 */
async function fetchLatestChannelUploads({ channelId, maxItems = 300 }) {
  if (!YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY missing");
  if (!channelId) throw new Error("channelId missing");

  const uploadsId = await getUploadsPlaylistId(channelId);
  if (!uploadsId) return [];

  const items = await getAllPlaylistItems(uploadsId, maxItems);

  const videoIds = items.map((x) => x?.contentDetails?.videoId).filter(Boolean);
  const metaMap = await getVideosMetaByIds(videoIds);

  const docs = items
    .map((it) => {
      const vid = it?.contentDetails?.videoId;
      const meta = metaMap.get(vid);
      return buildVideoItem({
        channelId,
        videoId: vid,
        snippet: it.snippet,
        meta,
      });
    })
    // remove SB content (as your earlier logic)
    .filter((v) => !v.contentFlags?.isSbContent);

  // newest first
  docs.sort((a, b) => (b.publishedAt?.getTime() || 0) - (a.publishedAt?.getTime() || 0));

  return docs;
}

module.exports = {
  fetchLatestChannelUploads,
};
// models/YoutubeVideo.js
const mongoose = require("mongoose");

const YoutubeVideoSchema = new mongoose.Schema(
  {
    channelId: { type: String, index: true, required: true },
    videoId: { type: String, index: true, required: true, unique: true }, // unique across channel
    title: { type: String, default: "" },
    description: { type: String, default: "" },
    thumbnail: { type: String, default: null },

    publishedAt: { type: Date, index: true },
    month: { type: Number, index: true }, // 1-12
    year: { type: Number, index: true },  // YYYY

    url: { type: String, default: null },
    isShort: { type: Boolean, default: false },
    duration: { type: String, default: null }, // ISO8601 duration
    views: { type: Number, default: null },

    playlistId: { type: String, default: null },
    playlistTitle: { type: String, default: null },

    // Keep in case you want filtering changes later
    contentFlags: {
      isSbContent: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

YoutubeVideoSchema.index({ channelId: 1, year: 1, month: 1, publishedAt: -1 });

module.exports = mongoose.model("YoutubeVideo", YoutubeVideoSchema);
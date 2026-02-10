// models/NotificationLog.js
const mongoose = require("mongoose");

const notificationLogSchema = new mongoose.Schema({
  type: { type: String, required: true },        // "festival"
  topic: { type: String, required: true },       // "festivals"
  slot: { type: String, required: true },        // "today_7am" | "tomorrow_5pm"
  eventDate: { type: String, required: true },   // "YYYY-MM-DD" (IST)
  event: { type: String, required: true },
  status: { type: String, default: "sent" },     // sent/failed
  messageId: { type: String },
  error: { type: String },
}, { timestamps: true });

notificationLogSchema.index({ type:1, topic:1, slot:1, eventDate:1, event:1 }, { unique: true });

module.exports = mongoose.model("NotificationLog", notificationLogSchema);

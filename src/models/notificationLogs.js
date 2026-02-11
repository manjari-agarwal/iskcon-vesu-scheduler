// models/notificationLogs.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const notificationLogSchema = new Schema(
  {
    type: { type: String, required: true },        // "festival" | "birthday" | "anniversary" | "*_personal" | "*_run"
    topic: { type: String, required: true },       // "festivals" | "token"
    slot: { type: String, required: true },        // "today_7am" | "today_730am" | "today_6am"
    eventDate: { type: String, required: true },   // "YYYY-MM-DD" (IST)
    event: { type: String, required: true },       // eventName | mobile | "summary"
    status: { type: String, default: "sent" },     // sent/failed/completed
    messageId: { type: String },
    error: { type: String },

    // ✅ add these:
    stats: { type: Schema.Types.Mixed },
    details: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

notificationLogSchema.index(
  { type: 1, topic: 1, slot: 1, eventDate: 1, event: 1 },
  { unique: true }
);

module.exports = mongoose.model("NotificationLog", notificationLogSchema);

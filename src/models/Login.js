// models/Login.js
const mongoose = require("mongoose");

const LoginSchema = new mongoose.Schema(
  {
    mobile: { type: String, required: true, unique: true, match: /^[6-9]\d{9}$/ },

    // OTP should NOT be required always, because you clear it after successful verify
    otp: { type: String, default: null },
    otpExpiresAt: { type: Date, default: null },

    requestOtpAttempts: { type: Number, default: 0 },
    verifyOtpAttempts: { type: Number, default: 0 },
    blockedUntil: { type: Date, default: null },

    deviceType: { type: String, default: null },
    deviceModel: { type: String, default: null },
    deviceVersion: { type: String, default: null },
    uuid: { type: String, default: null },
    fcmToken: { type: String, default: null },
    appVersion: { type: String, default: null }
  },
  { timestamps: true } // gives createdAt + updatedAt automatically
);

module.exports = mongoose.model("Login", LoginSchema);

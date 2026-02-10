const mongoose = require("mongoose");

let connecting = null;

const ensureMongo = async () => {
  try {
    // Already connected
    if (mongoose.connection.readyState === 1) return true;

    // If connection in progress, await it
    if (connecting) return await connecting;

    connecting = mongoose
      .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 })
      .then(() => {
        console.log("✅ MongoDB connected");
        console.log("DB:", mongoose.connection.name);
        return true;
      })
      .catch((err) => {
        console.error("❌ MongoDB connect failed:", err.message);
        return false;
      })
      .finally(() => {
        connecting = null;
      });

    return await connecting;
  } catch (err) {
    console.error("❌ Mongo ensure failed:", err?.message || err);
    return false;
  }
};

module.exports = { ensureMongo };

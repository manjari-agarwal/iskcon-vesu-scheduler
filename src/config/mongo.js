// src/config/mongo.js
const mongoose = require("mongoose");

let connectingPromise = null;

// Optional: tune these if you want
const DEFAULT_TIMEOUT_MS = 15000;

async function ensureMongo(context) {
  try {
    const uri = process.env.MONGO_URI;

    if (!uri) {
      const msg = "❌ MONGO_URI is missing in environment variables.";
      (context?.log || console.error)(msg);
      return false;
    }

    // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    if (mongoose.connection.readyState === 1) return true;

    // If connect already in progress, wait for it
    if (connectingPromise) return await connectingPromise;

    const opts = {
      serverSelectionTimeoutMS: DEFAULT_TIMEOUT_MS,
      connectTimeoutMS: DEFAULT_TIMEOUT_MS,
      socketTimeoutMS: 60000,

      // Cosmos/Mongo clusters are TLS; URI already has tls=true but keep this explicit
      tls: true,

      // vCore + many Cosmos Mongo setups work best with retryWrites disabled
      retryWrites: false,

      // Keep connections stable in Functions
      maxPoolSize: 5,
      minPoolSize: 0,
      maxIdleTimeMS: 120000,
      heartbeatFrequencyMS: 10000,
    };

    connectingPromise = mongoose
      .connect(uri, opts)
      .then(() => {
        (context?.log || console.log)("✅ MongoDB connected");
        (context?.log || console.log)("DB:", mongoose.connection.name);
        return true;
      })
      .catch((err) => {
        // Useful extra info for DNS/firewall issues
        const extra =
          err?.code ? ` (code=${err.code})` : "";
        (context?.log || console.error)(
          `❌ MongoDB connect failed: ${err?.message || err}${extra}`
        );
        return false;
      })
      .finally(() => {
        connectingPromise = null;
      });

    return await connectingPromise;
  } catch (err) {
    (context?.log || console.error)(
      "❌ Mongo ensure failed:",
      err?.message || err
    );
    return false;
  }
}

// Optional: close (useful for local scripts/tests; not usually needed in Azure Functions)
async function closeMongo(context) {
  try {
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
      (context?.log || console.log)("✅ MongoDB disconnected");
    }
  } catch (err) {
    (context?.log || console.error)(
      "❌ Mongo disconnect failed:",
      err?.message || err
    );
  }
}

module.exports = { ensureMongo, closeMongo };

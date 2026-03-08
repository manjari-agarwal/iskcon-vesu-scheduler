const { getAdmin } = require("../config/firebase");

// Build absolute URL if DB stores relative paths
function toAbsoluteImageUrl(imagePath) {
  if (!imagePath) return "";
  if (/^https?:\/\//i.test(imagePath)) return imagePath;

  const base = process.env.METADATA_IMAGE_BASE_URL || "";
  const token = process.env.METADATA_SAS_TOKEN || "";
  return base
    ? `${base.replace(/\/$/, "")}/${String(imagePath).replace(/^\//, "")}${token}`
    : "";
}

async function sendFestivalTopicNotification(slot, payload) {
  const admin = await getAdmin();

  const title =
    slot === "tomorrow_5pm"
      ? "🔔 Tomorrow: Vaishnava Festival"
      : "🌸 Today: Vaishnava Festival";

  const body = payload.event + (payload.description ? ` — ${payload.description}` : "");

  const message = {
    topic: "festivals",
    notification: { title, body },
    data: {
      type: "festival",
      slot,
      date: payload.dateISO || "",
      event: payload.event || ""
    },
    android: {
      priority: "high",
      notification: {
        channelId: "default",
        sound: "default"
      }
    },
    apns: { payload: { aps: { sound: "default" } } }
  };

  return admin.messaging().send(message);
}

async function sendFestivalsTopicNotification({ title, body, data }) {
  const admin = await getAdmin();

  const message = {
    topic: "festivals",
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data || {}).map(([k, v]) => [k, String(v ?? "")])
    ),
    android: {
      priority: "high",
      notification: { channelId: "default", sound: "default" }
    },
    apns: { payload: { aps: { sound: "default" } } }
  };

  return admin.messaging().send(message);
}

async function sendAnnouncementScheduledTopicNotification({ title, body, doc, data = {} }) {
    if (!doc) throw new Error("[FCM] sendAnnouncementScheduledTopicNotification: doc is required");

    const admin = await getAdmin();
    const dateISO = (doc.date instanceof Date)
        ? doc.date.toISOString()
        : new Date(doc.date).toISOString();

    const imageUrl = toAbsoluteImageUrl(doc.image);

    const message = {
        topic: "announcements",
        notification: {
            title,
            body,
            image: imageUrl || undefined,
        },
        data: Object.fromEntries(
            Object.entries({
                type: "announcements",
                id: String(doc._id || ""),
                date: dateISO,
                image: imageUrl || "",
                ...data,
            }).map(([k, v]) => [k, String(v ?? "")])
        ),
        android: {
            priority: "high",
            notification: {
                channelId: "default",
                sound: "default",
                image: imageUrl || undefined,
            },
        },
        apns: {
            headers: { "apns-priority": "10" },
            payload: {
                aps: {
                    sound: "default",
                    "mutable-content": 1,
                },
            },
            fcm_options: {
                image: imageUrl || undefined,
            },
        },
    };

    try {
        const messageId = await admin.messaging().send(message);
        return messageId;
    } catch (e) {
        console.error("[FCM] scheduled announcements send error:", e?.message || e);
        if (e?.errorInfo) console.error("errorInfo:", e.errorInfo);
        throw e;
    }
}

async function sendBhagwatamScheduledTopicNotification({ title, body, doc, data = {} }) {

    const admin = await getAdmin();

    const dateISO =
        doc.date instanceof Date
            ? doc.date.toISOString()
            : new Date(doc.date).toISOString();

    const message = {
        topic: "bhagwatam",

        notification: {
            title,
            body,
        },

        data: {
            type: "bhagwatam",
            id: String(doc._id || ""),
            date: dateISO,
            url: doc.url ? String(doc.url) : "",   // 👈 IMPORTANT
            ...Object.fromEntries(
                Object.entries(data).map(([k, v]) => [k, String(v ?? "")])
            )
        },

        android: {
            priority: "high",
            notification: {
                channelId: "default",
                sound: "default",
                clickAction: "OPEN_BHAGWATAM"
            }
        },

        apns: {
            payload: {
                aps: {
                    sound: "default"
                }
            }
        }
    };

    return admin.messaging().send(message);
}

async function sendPrabhupadQuoteTopicNotification({ title, body, imagePath, data = {} }) {
  const admin = await getAdmin();
  const imageUrl = toAbsoluteImageUrl("/metadata/PrabhuPadasQuotes/prabhupaad5.png");

  const message = {
    topic: "festivals",
    notification: {
      title,
      body,
      image: imageUrl || undefined,
    },
    data: Object.fromEntries(
      Object.entries({
        type: "quote",
        image: imageUrl || "",
        ...data,
      }).map(([k, v]) => [k, String(v ?? "")])
    ),
    android: {
      priority: "high",
      notification: {
        channelId: "default",
        sound: "default",
        image: imageUrl || undefined,
      },
    },
    apns: {
      headers: { "apns-priority": "10" },
      payload: { aps: { sound: "default", "mutable-content": 1 } },
      fcm_options: {
        image: imageUrl || undefined,
      },
    },
  };

  return admin.messaging().send(message);
}

module.exports = {
  sendFestivalTopicNotification,
  sendFestivalsTopicNotification,
  sendAnnouncementScheduledTopicNotification,
  sendBhagwatamScheduledTopicNotification,
  sendPrabhupadQuoteTopicNotification,
};
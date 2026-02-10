const { getAdmin } = require("../config/firebase");

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
    topic: "festivals", // ✅ single topic for everything
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

module.exports = { sendFestivalTopicNotification, sendFestivalsTopicNotification };

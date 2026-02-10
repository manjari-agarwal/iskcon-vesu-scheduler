// config/firebase.js
const admin = require('firebase-admin');
const { readCredFiles } = require('../utils/blobStorage');

let initializing = null;       // Promise<admin> while initializing
let ready = null;              // holds the resolved admin instance

async function getAdmin() {
  if (ready) return ready;                 // already ready
  if (initializing) return initializing;   // in progress

  initializing = (async () => {
    try {
      // If a previous attempt partially initialized, reuse it.
      if (admin.apps && admin.apps.length) {
        ready = admin;                     // reuse existing app
        return ready;
      }

      const serviceAccount = await readCredFiles('credentials', 'fcm.json');

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        // storageBucket: 'iskcon-vesu.firebasestorage.app',
      });

      console.log(
        '[FCM] Admin initialized for project:',
        serviceAccount?.project_id ||
        admin.app().options?.credential?.projectId ||
        '(unknown)'
      );

      ready = admin;
      return ready;
    } catch (err) {
      // Important: clear the latch so a later call can retry
      initializing = null;
      console.error('[FCM] Admin init failed:', err?.message || err);
      throw err;
    }
  })();

  return initializing;
}

module.exports = { getAdmin };

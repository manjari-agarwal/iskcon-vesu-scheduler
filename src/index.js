function safeRequire(path) {
  try {
    require(path);
    console.log("[OK] Loaded", path);
  } catch (e) {
    console.error("[FAIL] Could not load", path, e?.message || e);
  }
}

safeRequire("./functions/festivalsTomorrow5pm");
safeRequire("./functions/festivalsToday630am");
safeRequire("./functions/anniversariesToday730am");
safeRequire("./functions/anniversariesTomorrow730pm");
safeRequire("./functions/birthdaysToday7am");
safeRequire("./functions/birthdaysTomorrow7pm");
safeRequire("./functions/youtubeSync6hr");
safeRequire("./functions/bhagwatamToday3pm");
safeRequire("./functions/bhagwatamTomorrow630pm");
safeRequire("./functions/prabhupadQuoteDaily8am");
safeRequire("./functions/announcementsToday10am");
safeRequire("./functions/announcementsTomorrow6pm");
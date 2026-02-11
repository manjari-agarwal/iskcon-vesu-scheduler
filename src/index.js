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
safeRequire("./functions/birthdaysToday7am");
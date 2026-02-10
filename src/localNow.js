require("dotenv").config();
const { runFestivalsToday630am } = require("./functions/festivalsToday630am");
const { runBirthdaysToday7am } = require("./functions/birthdaysToday7am");
const { runAnniversariesToday730am } = require("./functions/anniversariesToday730am");

function makeContext(name) {
  return {
    log: (...args) => console.log(`[${name}]`, ...args),
  };
}

(async () => {
  console.log("✅ Running all 3 locally...");

  await runFestivalsToday630am(makeContext("festivalsToday630am"));
  await runBirthdaysToday7am(makeContext("birthdaysToday7am"));
  await runAnniversariesToday730am(makeContext("anniversariesToday730am"));

  console.log("✅ Done");
  process.exit(0);
})().catch((e) => {
  console.error("❌ Failed:", e);
  process.exit(1);
});

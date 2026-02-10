const TZ = "Asia/Kolkata";

function istYmd(date = new Date()) {
  const ist = new Date(date.toLocaleString("en-US", { timeZone: TZ }));
  const y = ist.getFullYear();
  const m = String(ist.getMonth() + 1).padStart(2, "0");
  const d = String(ist.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const baseUtc = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const shifted = new Date(baseUtc.getTime() + days * 86400000);
  return istYmd(shifted);
}

module.exports = { istYmd, addDaysYmd };

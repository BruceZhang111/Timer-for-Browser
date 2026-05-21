const STORAGE_KEY = "dailyUsage";

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDuration(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  return `${minutes}分${seconds}秒`;
}

async function getTodayStatsFromBackground() {
  try {
    const res = await browser.runtime.sendMessage({ type: "GET_TODAY_STATS" });
    if (res?.ok && res.sites) return res.sites;
  } catch (e) {
    console.warn("[timer-for-browser popup]", e);
  }
  return null;
}

async function getTodayStatsFromStorage() {
  const result = await browser.storage.local.get(STORAGE_KEY);
  const data = result[STORAGE_KEY];
  if (!data || data.date !== todayKey()) return {};
  if (data.sites) return data.sites;
  if (typeof data.seconds === "number") return { bilibili: data.seconds };
  return {};
}

function renderSiteList(sites) {
  const list = document.getElementById("site-list");
  list.replaceChildren();

  let total = 0;
  for (const site of TRACKED_SITES) {
    const sec = sites[site.id] || 0;
    total += sec;

    const row = document.createElement("div");
    row.className = "site-row";

    const name = document.createElement("span");
    name.className = "site-name";
    name.textContent = site.name;

    const time = document.createElement("span");
    time.className = "site-time";
    time.textContent = formatDuration(sec);

    row.append(name, time);
    list.appendChild(row);
  }

  document.getElementById("total").textContent = formatDuration(total);
}

async function refresh() {
  const stats =
    (await getTodayStatsFromBackground()) ?? (await getTodayStatsFromStorage());
  renderSiteList(stats);
  document.getElementById("site-list").classList.remove("loading");
}

document.addEventListener("DOMContentLoaded", () => {
  refresh();
  const timer = setInterval(refresh, 1000);
  window.addEventListener("unload", () => clearInterval(timer));
});

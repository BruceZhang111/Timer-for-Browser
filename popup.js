function formatDuration(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  return `${minutes}分${seconds}秒`;
}

/** 上次从后台拿到的基准数据，用于弹窗打开期间本地插值计时 */
let snapshot = {
  sites: {},
  date: null,
  tracking: null,
  fetchedAt: 0,
};

/** 已落盘 + 当前计时段（由 sessionStart 推算，弹窗每秒本地刷新） */
function sitesWithLivePending(baseSites, tracking, nowMs) {
  const sites = { ...baseSites };
  if (!tracking?.siteId || tracking.sessionStart == null) return sites;

  const pending = Math.max(0, (nowMs - tracking.sessionStart) / 1000);
  sites[tracking.siteId] = (sites[tracking.siteId] || 0) + pending;
  return sites;
}

async function getTodayStatsFromBackground() {
  try {
    const res = await browser.runtime.sendMessage({ type: "GET_TODAY_STATS" });
    if (res?.ok && res.sites) {
      return {
        sites: res.sites,
        date: res.date || todayKey(),
        tracking: res.tracking || null,
      };
    }
  } catch (e) {
    console.warn("[timer-for-browser popup]", e);
  }
  return null;
}

async function getTodayStatsFromStorage() {
  const sites = await loadDailySites();
  return { sites, date: todayKey(), tracking: null };
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

function renderFromSnapshot(nowMs = Date.now()) {
  const liveSites = sitesWithLivePending(snapshot.sites, snapshot.tracking, nowMs);
  document.getElementById("date-label").textContent =
    `统计日 ${snapshot.date || todayKey()} · 每日 0:00 清零`;
  renderSiteList(liveSites);
  document.getElementById("site-list").classList.remove("loading");
}

async function syncFromBackground() {
  const payload =
    (await getTodayStatsFromBackground()) ?? (await getTodayStatsFromStorage());
  snapshot = {
    sites: payload.sites,
    date: payload.date,
    tracking: payload.tracking,
    fetchedAt: Date.now(),
  };
  renderFromSnapshot();
}

document.addEventListener("DOMContentLoaded", () => {
  syncFromBackground();
  const syncTimer = setInterval(syncFromBackground, 2000);
  const uiTimer = setInterval(() => renderFromSnapshot(), 1000);

  window.addEventListener("unload", () => {
    clearInterval(syncTimer);
    clearInterval(uiTimer);
    browser.runtime.sendMessage({ type: "RESUME_SESSION" }).catch(() => {});
  });
});

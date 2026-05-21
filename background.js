/**
 * 按自然日、按站点累计前台停留秒数。
 * 仅当标签为配置站点、处于当前窗口前台且浏览器窗口有焦点时计时。
 */

const STORAGE_KEY = "dailyUsage";

/** @type {number | null} */
let activeTabId = null;
/** @type {string | null} 当前计时的站点 id */
let activeSiteId = null;
/** @type {number | null} */
let sessionStart = null;

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** @returns {Record<string, number>} */
async function loadDailySites() {
  const result = await browser.storage.local.get(STORAGE_KEY);
  const data = result[STORAGE_KEY];
  if (!data || data.date !== todayKey()) return {};

  if (data.sites && typeof data.sites === "object") {
    return { ...data.sites };
  }
  // 兼容旧版仅统计 B 站的存储格式
  if (typeof data.seconds === "number" && data.seconds > 0) {
    return { bilibili: data.seconds };
  }
  return {};
}

async function saveDailySites(sites) {
  const cleaned = {};
  for (const [id, sec] of Object.entries(sites)) {
    cleaned[id] = Math.max(0, Math.floor(sec));
  }
  await browser.storage.local.set({
    [STORAGE_KEY]: {
      date: todayKey(),
      sites: cleaned,
    },
  });
}

function pendingSeconds() {
  if (sessionStart == null) return 0;
  return Math.max(0, (Date.now() - sessionStart) / 1000);
}

/** 各站点今日秒数（含当前未落盘时段） */
async function getTodayStats() {
  const sites = await loadDailySites();
  if (activeSiteId && sessionStart != null) {
    sites[activeSiteId] = (sites[activeSiteId] || 0) + pendingSeconds();
  }
  return sites;
}

async function addElapsedSeconds(siteId, deltaSec) {
  if (!siteId || deltaSec <= 0) return;
  const sites = await loadDailySites();
  sites[siteId] = (sites[siteId] || 0) + deltaSec;
  await saveDailySites(sites);
}

async function flushSession() {
  if (sessionStart == null || !activeSiteId) return;
  const elapsed = (Date.now() - sessionStart) / 1000;
  const siteId = activeSiteId;
  sessionStart = null;
  activeTabId = null;
  activeSiteId = null;
  await addElapsedSeconds(siteId, elapsed);
}

async function isTabWindowFocused(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    const win = await browser.windows.get(tab.windowId);
    return Boolean(win.focused);
  } catch {
    return false;
  }
}

async function maybeStartSession(tabId, url) {
  const siteId = matchSite(url);
  if (!siteId) {
    await flushSession();
    return;
  }
  if (!(await isTabWindowFocused(tabId))) {
    await flushSession();
    return;
  }
  if (activeTabId === tabId && activeSiteId === siteId && sessionStart != null) {
    return;
  }
  await flushSession();
  activeTabId = tabId;
  activeSiteId = siteId;
  sessionStart = Date.now();
}

async function handleTabActivated(activeInfo) {
  try {
    const tab = await browser.tabs.get(activeInfo.tabId);
    await maybeStartSession(activeInfo.tabId, tab.url);
  } catch {
    await flushSession();
  }
}

async function handleTabUpdated(tabId, changeInfo, tab) {
  if (changeInfo.url == null && changeInfo.status !== "complete") return;
  const activeTabs = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!activeTabs.length || activeTabs[0].id !== tabId) return;
  await maybeStartSession(tabId, tab.url || changeInfo.url);
}

async function handleWindowFocusChanged(windowId) {
  if (windowId === browser.windows.WINDOW_ID_NONE) {
    await flushSession();
    return;
  }
  const tabs = await browser.tabs.query({ active: true, windowId });
  if (tabs.length) {
    await maybeStartSession(tabs[0].id, tabs[0].url);
  } else {
    await flushSession();
  }
}

async function handleTabRemoved(tabId) {
  if (tabId === activeTabId) {
    await flushSession();
  }
}

browser.alarms.create("flush", { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "flush" || sessionStart == null || !activeSiteId) return;
  const elapsed = (Date.now() - sessionStart) / 1000;
  await addElapsedSeconds(activeSiteId, elapsed);
  sessionStart = Date.now();
});

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_TODAY_STATS") {
    getTodayStats()
      .then((sites) => sendResponse({ ok: true, sites }))
      .catch((err) => {
        console.error("[timer-for-browser]", err);
        sendResponse({ ok: false, sites: {} });
      });
    return true;
  }
  return false;
});

browser.tabs.onActivated.addListener(handleTabActivated);
browser.tabs.onUpdated.addListener(handleTabUpdated);
browser.windows.onFocusChanged.addListener(handleWindowFocusChanged);
browser.tabs.onRemoved.addListener(handleTabRemoved);

(async () => {
  try {
    const tabs = await browser.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tabs.length) {
      await maybeStartSession(tabs[0].id, tabs[0].url);
    }
  } catch (e) {
    console.error("[timer-for-browser]", e);
  }
})();

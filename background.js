/**
 * 统计指定站点在前台、窗口有焦点时的停留时长。
 * - 数据写入 browser.storage.local，浏览器重启不丢失
 * - 每日 0:00（本地时区）自动换日清零
 * - 跨午夜计时会按自然日切分
 */

/** @type {number | null} */
let activeTabId = null;
/** @type {string | null} */
let activeSiteId = null;
/** @type {number | null} */
let sessionStart = null;

function pendingSeconds() {
  if (sessionStart == null) return 0;
  return Math.max(0, (Date.now() - sessionStart) / 1000);
}

/** 仅跨自然日时落盘并换桶（查询统计时不能 flush，否则弹窗轮询会打断计时） */
async function ensureTodayBucket() {
  const data = await getStoredDaily();
  const today = todayKey();
  if (data && data.date !== today) {
    await flushSession();
    await rolloverDayIfNeeded();
    return true;
  }
  await rolloverDayIfNeeded();
  return false;
}

async function getTodayStats() {
  await ensureTodayBucket();
  const sites = await loadDailySites();
  const tracking =
    activeSiteId && sessionStart != null
      ? { siteId: activeSiteId, sessionStart }
      : null;
  return { sites, tracking };
}

async function flushSession() {
  if (sessionStart == null || !activeSiteId) return;
  const start = sessionStart;
  const siteId = activeSiteId;
  sessionStart = null;
  activeTabId = null;
  activeSiteId = null;
  await addElapsedForRange(siteId, start, Date.now());
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
  await ensureTodayBucket();

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

let blurFlushTimer = null;

async function handleWindowFocusChanged(windowId) {
  if (windowId === browser.windows.WINDOW_ID_NONE) {
    clearTimeout(blurFlushTimer);
    blurFlushTimer = setTimeout(() => {
      blurFlushTimer = null;
      flushSession();
    }, 400);
    return;
  }
  clearTimeout(blurFlushTimer);
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

/** 每分钟落盘，降低异常退出丢数据风险 */
async function ensurePeriodicFlushAlarm() {
  const alarms = await browser.alarms.getAll();
  if (!alarms.some((a) => a.name === "flush")) {
    await browser.alarms.create("flush", { periodInMinutes: 1 });
  }
}

/** 预约下一次本地 0:00 换日 */
async function scheduleMidnightAlarm() {
  await browser.alarms.clear("midnight");
  await browser.alarms.create("midnight", {
    when: Date.now() + msUntilNextMidnight(),
  });
}

async function handleMidnightRollover() {
  await flushSession();
  await rolloverDayIfNeeded();
  await scheduleMidnightAlarm();
  await resumeActiveTabSession();
}

async function resumeActiveTabSession() {
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
}

async function checkpointSession() {
  if (sessionStart == null || !activeSiteId) return;
  const start = sessionStart;
  const siteId = activeSiteId;
  const end = Date.now();
  sessionStart = end;
  await addElapsedForRange(siteId, start, end);
}

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "flush") {
    await checkpointSession();
    return;
  }
  if (alarm.name === "midnight") {
    await handleMidnightRollover();
  }
});

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_TODAY_STATS") {
    getTodayStats()
      .then(({ sites, tracking }) =>
        sendResponse({ ok: true, sites, date: todayKey(), tracking })
      )
      .catch((err) => {
        console.error("[timer-for-browser]", err);
        sendResponse({ ok: false, sites: {}, date: todayKey(), tracking: null });
      });
    return true;
  }
  if (message?.type === "RESUME_SESSION") {
    resumeActiveTabSession()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

browser.tabs.onActivated.addListener(handleTabActivated);
browser.tabs.onUpdated.addListener(handleTabUpdated);
browser.windows.onFocusChanged.addListener(handleWindowFocusChanged);
browser.tabs.onRemoved.addListener(handleTabRemoved);

/** 浏览器启动：恢复闹钟与计时，不重置 storage */
browser.runtime.onStartup.addListener(() => {
  initExtension();
});

browser.runtime.onInstalled.addListener(() => {
  initExtension();
});

if (browser.runtime.onSuspend) {
  browser.runtime.onSuspend.addListener(() => {
    flushSession();
  });
}

async function initExtension() {
  await ensureTodayBucket();
  await ensurePeriodicFlushAlarm();
  await scheduleMidnightAlarm();
  await resumeActiveTabSession();
}

initExtension();

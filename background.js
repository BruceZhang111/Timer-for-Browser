/**
 * 统计指定站点在前台、窗口有焦点时的停留时长。
 * - 数据写入 browser.storage.local，浏览器重启不丢失
 * - 每日 0:00（本地时区）自动换日清零
 * - 跨午夜计时会按自然日切分
 */

const SESSION_DEFAULTS = { activeTabId: null, activeSiteId: null, sessionStart: null };

async function getSessionState() {
  return { ...SESSION_DEFAULTS, ...(await browser.storage.session.get(SESSION_DEFAULTS)) };
}

async function setSessionState(updates) {
  await browser.storage.session.set(updates);
}

async function pendingSeconds() {
  const state = await getSessionState();
  if (state.sessionStart == null) return 0;
  return Math.max(0, (Date.now() - state.sessionStart) / 1000);
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
  await refreshSitesCache();
  const sites = await loadDailySites();
  const state = await getSessionState();
  const tracking =
    state.activeSiteId && state.sessionStart != null
      ? { siteId: state.activeSiteId, sessionStart: state.sessionStart }
      : null;
  return { sites, tracking, trackedSites: getAllSites() };
}

async function flushSession() {
  const state = await getSessionState();
  if (state.sessionStart == null || !state.activeSiteId) return;
  const start = state.sessionStart;
  const siteId = state.activeSiteId;
  await setSessionState({ activeTabId: null, activeSiteId: null, sessionStart: null });
  await addElapsedForRange(siteId, start, Date.now());
}

async function isTabWindowFocused(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    const win = await browser.windows.get(tab.windowId);
    if (win.focused) return true;

    // 网页窗口未聚焦时，检查焦点是否被插件弹窗或 DevTools 抢走
    const focusedWin = await browser.windows.getLastFocused().catch(() => null);
    if (isIgnorableWindowType(focusedWin)) return true;

    return false;
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
  const state = await getSessionState();
  if (state.activeTabId === tabId && state.activeSiteId === siteId && state.sessionStart != null) {
    return;
  }
  await flushSession();
  await setSessionState({ activeTabId: tabId, activeSiteId: siteId, sessionStart: Date.now() });
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

function clearBlurTimer() {
  if (blurFlushTimer !== null) {
    clearTimeout(blurFlushTimer);
    blurFlushTimer = null;
  }
}

/** 判断窗口是否为应忽略焦点变化的类型（插件弹窗 / DevTools） */
function isIgnorableWindowType(win) {
  return win && (win.type === "popup" || win.type === "devtools");
}

async function handleWindowFocusChanged(windowId) {
  // 统一清理：任何焦点变化的第一步都是清除上一轮延迟 flush 定时器
  clearBlurTimer();

  // 所有窗口失焦：启动 400ms 延迟落盘（等待可能的弹窗/DevTools 抢焦点）
  if (windowId === browser.windows.WINDOW_ID_NONE) {
    blurFlushTimer = setTimeout(() => {
      blurFlushTimer = null;
      flushSession();
    }, 400);
    return;
  }

  // 查询新获焦窗口类型，popup/devtools 不打断计时
  let win;
  try {
    win = await browser.windows.get(windowId);
  } catch {
    await flushSession();
    return;
  }
  if (isIgnorableWindowType(win)) return;

  // 正常网页窗口切换：查询活跃 Tab 并判定是否需要追踪
  try {
    const tabs = await browser.tabs.query({ active: true, windowId });
    if (tabs.length) {
      await maybeStartSession(tabs[0].id, tabs[0].url);
    } else {
      await flushSession();
    }
  } catch {
    await flushSession();
  }
}

async function handleTabRemoved(tabId) {
  const state = await getSessionState();
  if (tabId === state.activeTabId) {
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
  const state = await getSessionState();
  if (state.sessionStart == null || !state.activeSiteId) return;
  const start = state.sessionStart;
  const siteId = state.activeSiteId;
  const end = Date.now();
  await setSessionState({ sessionStart: end });
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
      .then(({ sites, tracking, trackedSites }) =>
        sendResponse({
          ok: true,
          sites,
          date: todayKey(),
          tracking,
          trackedSites,
        })
      )
      .catch((err) => {
        console.error("[timer-for-browser]", err);
        sendResponse({
          ok: false,
          sites: {},
          date: todayKey(),
          tracking: null,
          trackedSites: getAllSites(),
        });
      });
    return true;
  }
  if (message?.type === "GET_TRACKED_SITES") {
    refreshSitesCache()
      .then(() => sendResponse({ ok: true, trackedSites: getAllSites() }))
      .catch((err) => {
        sendResponse({ ok: false, trackedSites: getAllSites(), error: String(err) });
      });
    return true;
  }
  if (message?.type === "ADD_CUSTOM_SITE") {
    addCustomSite(message.url, message.name, {
      permissionsGranted: Boolean(message.permissionsGranted),
    })
      .then(async (site) => {
        await refreshSitesCache();
        resumeActiveTabSession();
        sendResponse({
          ok: true,
          site,
          trackedSites: getAllSites(),
        });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err.message || String(err) });
      });
    return true;
  }
  if (message?.type === "RENAME_TRACKED_SITE") {
    renameTrackedSite(message.siteId, message.name)
      .then((site) => {
        sendResponse({ ok: true, site, trackedSites: getAllSites() });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err.message || String(err) });
      });
    return true;
  }
  if (message?.type === "REMOVE_TRACKED_SITE") {
    const siteId = message.siteId;
    (async () => {
      const state = await getSessionState();
      if (state.activeSiteId === siteId) {
        await flushSession();
      }
      await removeTrackedSite(siteId);
      await resumeActiveTabSession();
      sendResponse({ ok: true, trackedSites: getAllSites() });
    })().catch((err) => {
      sendResponse({ ok: false, error: err.message || String(err) });
    });
    return true;
  }
  if (message?.type === "REORDER_TRACKED_SITES") {
    reorderTrackedSites(message.siteIds)
      .then((trackedSites) => {
        sendResponse({ ok: true, trackedSites });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err.message || String(err) });
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

browser.runtime.onSuspend.addListener(() => {
  flushSession();
});

if (browser.permissions.onAdded) {
  browser.permissions.onAdded.addListener(() => {
    tryCompletePendingAdd().then((ok) => {
      if (ok) resumeActiveTabSession();
    });
  });
}

async function initExtension() {
  await refreshSitesCache();
  await checkCustomSitePermissions();
  await tryCompletePendingAdd();
  await ensureTodayBucket();
  await ensurePeriodicFlushAlarm();
  await scheduleMidnightAlarm();
  await resumeActiveTabSession();
}

initExtension();

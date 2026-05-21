/**
 * 本地持久化：browser.storage.local 在浏览器重启后仍保留。
 * 按自然日分桶；跨日时段由 background 按时间戳切分写入。
 */

const STORAGE_KEY = "dailyUsage";
const HISTORY_KEY = "usageHistory";

function todayKey(ms = Date.now()) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function msUntilNextMidnight(fromMs = Date.now()) {
  const d = new Date(fromMs);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return next.getTime() - fromMs;
}

/** 串行化读写，避免并发 flush 覆盖 storage */
let storageChain = Promise.resolve();

function runStorageOp(fn) {
  const next = storageChain.then(fn);
  storageChain = next.catch(() => {});
  return next;
}

async function archiveDay(date, sites) {
  if (!date || !sites || !Object.keys(sites).length) return;
  const result = await browser.storage.local.get(HISTORY_KEY);
  const history = result[HISTORY_KEY] || {};
  history[date] = sites;
  await browser.storage.local.set({ [HISTORY_KEY]: history });
}

async function getStoredDaily() {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || null;
}

/** 读取今日各站点已落盘秒数 */
async function loadDailySites() {
  const data = await getStoredDaily();
  const today = todayKey();
  if (!data || data.date !== today) return {};

  if (data.sites && typeof data.sites === "object") {
    return { ...data.sites };
  }
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
      updatedAt: Date.now(),
    },
  });
}

/**
 * 若 storage 里仍是昨日数据：归档后清空，开始新一天（0:00 刷新）
 * @returns {boolean} 是否发生了换日
 */
async function rolloverDayIfNeeded() {
  const data = await getStoredDaily();
  const today = todayKey();
  if (!data || data.date === today) return false;

  const sites =
    data.sites && typeof data.sites === "object"
      ? data.sites
      : typeof data.seconds === "number"
        ? { bilibili: data.seconds }
        : {};

  await archiveDay(data.date, sites);
  await saveDailySites({});
  return true;
}

/** 向指定自然日累加秒数（仅今日写入 dailyUsage，往日写入 history） */
async function addElapsedSecondsForDate(siteId, date, deltaSec) {
  if (!siteId || deltaSec <= 0) return;

  return runStorageOp(async () => {
    const today = todayKey();
    const sec = Math.floor(deltaSec);

    if (date === today) {
      const result = await browser.storage.local.get(STORAGE_KEY);
      let data = result[STORAGE_KEY];
      if (!data || data.date !== today) {
        data = { date: today, sites: {} };
      }
      const sites = { ...(data.sites || {}) };
      sites[siteId] = (sites[siteId] || 0) + sec;
      await browser.storage.local.set({
        [STORAGE_KEY]: { date: today, sites, updatedAt: Date.now() },
      });
      return;
    }

    const result = await browser.storage.local.get(HISTORY_KEY);
    const history = result[HISTORY_KEY] || {};
    const sites = { ...(history[date] || {}) };
    sites[siteId] = (sites[siteId] || 0) + sec;
    history[date] = sites;
    await browser.storage.local.set({ [HISTORY_KEY]: history });
  });
}

/** 将 [startMs, endMs) 按自然日切分后分别落盘 */
async function addElapsedForRange(siteId, startMs, endMs) {
  if (!siteId || endMs <= startMs) return;

  let cursor = startMs;
  while (cursor < endMs) {
    const d = new Date(cursor);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const nextMidnight = dayStart + 86400000;
    const chunkEnd = Math.min(endMs, nextMidnight);
    const secs = (chunkEnd - cursor) / 1000;
    if (secs > 0) {
      await addElapsedSecondsForDate(siteId, todayKey(cursor), secs);
    }
    cursor = chunkEnd;
  }
}

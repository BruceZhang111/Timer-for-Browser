/**
 * 用户自行添加的追踪站点（storage.customSites），持久保存在本机。
 */

const CUSTOM_SITES_KEY = "customSites";
const PENDING_ADD_KEY = "pendingAdd";

/** 一次性申请全部 https/http 站点权限，避免每添加一个域名就弹窗 */
const BROAD_TRACKING_ORIGINS = ["https://*/*", "http://*/*"];

/** @type {Array<object> | null} */
let cachedAllSites = null;

function normalizeHost(hostname) {
  return hostname.replace(/^www\./, "").toLowerCase();
}

/** www.zhihu.com → zhihu.com；用于生成 https://zhihu.com/* */
function extractRootHost(hostname) {
  let h = normalizeHost(hostname);
  if (h.startsWith("www.")) h = h.slice(4);
  return h;
}

/**
 * 将用户输入解析为追踪模式
 * @returns {{ host: string, pattern: string, origins: string[], name: string }}
 */
function parseUrlInput(raw) {
  let text = (raw || "").trim();
  if (!text) throw new Error("请输入网址");

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    text = "https://" + text;
  }

  const u = new URL(text);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("仅支持 http / https 协议");
  }

  const host = extractRootHost(u.hostname);
  if (!host || !host.includes(".")) {
    throw new Error("无法识别有效域名");
  }

  const pattern = `https://${host}/*`;
  const origins = [`https://${host}/*`, `https://*.${host}/*`];

  return {
    host,
    pattern,
    origins,
    name: host,
  };
}

function siteIdFromHost(host) {
  return "site_" + host.replace(/\./g, "_");
}

async function getCustomSites() {
  const result = await browser.storage.local.get(CUSTOM_SITES_KEY);
  return result[CUSTOM_SITES_KEY] || [];
}

async function saveCustomSites(sites) {
  await browser.storage.local.set({
    [CUSTOM_SITES_KEY]: sites,
    customSitesUpdatedAt: Date.now(),
  });
}

function hostsAlreadyTracked(host, list) {
  const root = extractRootHost(host);
  return list.some((site) =>
    site.hosts.some((h) => {
      const base = extractRootHost(h);
      return base === root || root.endsWith("." + base) || base.endsWith("." + root);
    })
  );
}

async function refreshSitesCache() {
  cachedAllSites = await getCustomSites();
  return cachedAllSites;
}

function getAllSites() {
  return cachedAllSites || [];
}

/** @returns {string | null} */
function matchSite(url) {
  if (!url) return null;
  try {
    const host = normalizeHost(new URL(url).hostname);
    for (const site of getAllSites()) {
      for (const h of site.hosts) {
        const base = extractRootHost(h);
        if (host === base || host.endsWith("." + base)) return site.id;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function hasBroadTrackingPermission() {
  try {
    return await browser.permissions.contains({ origins: BROAD_TRACKING_ORIGINS });
  } catch {
    return false;
  }
}

/** 广义权限或该站点 origin 已授权 */
async function hasTrackingPermission(siteOrigins) {
  if (await hasBroadTrackingPermission()) return true;
  return hasOriginsPermission(siteOrigins);
}

async function waitForTrackingPermission(maxMs = 2500) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await hasBroadTrackingPermission()) return true;
    await new Promise((r) => setTimeout(r, 80));
  }
  return hasBroadTrackingPermission();
}

/** 任一 origin 已授权即视为通过（兼容旧版按域名授权） */
async function hasOriginsPermission(origins) {
  if (!origins?.length) return false;
  for (const origin of origins) {
    try {
      if (await browser.permissions.contains({ origins: [origin] })) {
        return true;
      }
    } catch {
      /* continue */
    }
  }
  try {
    return await browser.permissions.contains({ origins });
  } catch {
    return false;
  }
}

async function waitForOriginsPermission(origins, maxMs = 2500) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await hasOriginsPermission(origins)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return hasOriginsPermission(origins);
}

async function savePendingAdd(pending) {
  await browser.storage.local.set({ [PENDING_ADD_KEY]: pending });
}

async function getPendingAdd() {
  const result = await browser.storage.local.get(PENDING_ADD_KEY);
  return result[PENDING_ADD_KEY] || null;
}

async function clearPendingAdd() {
  await browser.storage.local.remove(PENDING_ADD_KEY);
}

async function checkCustomSitePermissions() {
  return { granted: await hasBroadTrackingPermission() };
}

/** 用户已在 Firefox 系统对话框中点「允许」后，由后台完成未结束的添加 */
async function tryCompletePendingAdd() {
  const pending = await getPendingAdd();
  if (!pending?.url) return false;

  if (!(await hasTrackingPermission(pending.origins))) {
    await waitForTrackingPermission(800);
  }
  if (!(await hasTrackingPermission(pending.origins))) {
    return false;
  }

  try {
    await addCustomSite(pending.url, pending.name || "", {
      permissionsGranted: true,
      force: true,
    });
    await clearPendingAdd();
    return true;
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes("已在追踪列表")) {
      await clearPendingAdd();
    }
    console.error("[timer-for-browser] tryCompletePendingAdd", err);
    return false;
  }
}

async function addCustomSite(urlInput, displayName, options = {}) {
  const parsed = parseUrlInput(urlInput);
  await refreshSitesCache();

  if (hostsAlreadyTracked(parsed.host, getAllSites())) {
    throw new Error("该域名已在追踪列表中");
  }

  if (options.permissionsGranted) {
    const has =
      options.force === true
        ? await waitForTrackingPermission(800)
        : await hasTrackingPermission(parsed.origins);
    if (!has) {
      throw new Error("未授予网站访问权限，无法追踪该域名");
    }
  } else {
    throw new Error("请从弹窗点击「授予权限并添加」完成授权");
  }

  const custom = await getCustomSites();
  const site = {
    id: siteIdFromHost(parsed.host),
    name: (displayName || "").trim() || parsed.name,
    hosts: [parsed.host],
    pattern: parsed.pattern,
    origins: parsed.origins,
    addedAt: Date.now(),
  };

  custom.push(site);
  await saveCustomSites(custom);
  await refreshSitesCache();
  return site;
}

async function removeTrackedSite(siteId) {
  const custom = await getCustomSites();
  const site = custom.find((s) => s.id === siteId);
  if (!site) {
    throw new Error("未找到该追踪站点");
  }

  await saveCustomSites(custom.filter((s) => s.id !== siteId));
  await removeSiteFromDailyStats(siteId);
  await refreshSitesCache();

  return site;
}

async function renameTrackedSite(siteId, newName) {
  const trimmed = (newName || "").trim();
  if (!trimmed) throw new Error("名称不能为空");
  if (trimmed.length > 32) throw new Error("名称最多 32 个字符");

  const custom = await getCustomSites();
  const index = custom.findIndex((s) => s.id === siteId);
  if (index < 0) throw new Error("未找到该追踪站点");

  custom[index] = { ...custom[index], name: trimmed };
  await saveCustomSites(custom);
  await refreshSitesCache();
  return custom[index];
}

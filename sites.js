/**
 * 开发初期：在扩展内维护待统计站点列表。
 * 新增站点时同步更新 manifest.json 的 permissions。
 */
const TRACKED_SITES = [
  { id: "gemini", name: "Gemini", hosts: ["gemini.google.com"] },
  { id: "zhihu", name: "知乎", hosts: ["zhihu.com"] },
  { id: "xiaohongshu", name: "小红书", hosts: ["xiaohongshu.com"] },
  { id: "douyin", name: "抖音", hosts: ["douyin.com"] },
  { id: "bilibili", name: "B站", hosts: ["bilibili.com"] },
];

function normalizeHost(hostname) {
  return hostname.replace(/^www\./, "").toLowerCase();
}

/** @returns {string | null} 站点 id */
function matchSite(url) {
  if (!url) return null;
  try {
    const host = normalizeHost(new URL(url).hostname);
    for (const site of TRACKED_SITES) {
      for (const h of site.hosts) {
        const base = normalizeHost(h);
        if (host === base || host.endsWith("." + base)) return site.id;
      }
    }
  } catch {
    return null;
  }
  return null;
}

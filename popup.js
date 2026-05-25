/** @type {Array<{id:string,name:string,pattern?:string}>} */
let trackedSitesList = [];

let snapshot = {
  sites: {},
  date: null,
  tracking: null,
  fetchedAt: 0,
};

/** @type {string | null} 当前左滑展开菜单的站点 id */
let openRowSiteId = null;

function formatDuration(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  return `${minutes}分${seconds}秒`;
}

function sitesWithLivePending(baseSites, tracking, nowMs) {
  const sites = { ...baseSites };
  if (!tracking?.siteId || tracking.sessionStart == null) return sites;

  const pending = Math.max(0, (nowMs - tracking.sessionStart) / 1000);
  sites[tracking.siteId] = (sites[tracking.siteId] || 0) + pending;
  return sites;
}

async function reloadTrackedSitesList() {
  try {
    const res = await browser.runtime.sendMessage({ type: "GET_TRACKED_SITES" });
    if (res?.ok && Array.isArray(res.trackedSites)) {
      trackedSitesList = res.trackedSites;
      return trackedSitesList;
    }
  } catch (e) {
    console.warn("[timer-for-browser popup] GET_TRACKED_SITES", e);
  }

  await refreshSitesCache();
  trackedSitesList = getAllSites();
  return trackedSitesList;
}

function showView(viewId) {
  document.querySelectorAll(".view").forEach((el) => {
    el.classList.toggle("active", el.id === viewId);
  });
}

async function updateAddFormState() {
  const url = document.getElementById("input-url").value.trim();
  const card = document.getElementById("permission-card");
  const hostEl = document.getElementById("permission-host");
  const noteEl = document.querySelector(".permission-note");
  const btn = document.getElementById("btn-confirm-add");
  let valid = false;

  if (url) {
    try {
      const parsed = parseUrlInput(url);
      valid = true;
      card.classList.add("is-visible");
      hostEl.textContent = parsed.host;
    } catch {
      card.classList.remove("is-visible");
    }
  } else {
    card.classList.remove("is-visible");
  }

  const hasBroad = await hasBroadTrackingPermission();
  if (hasBroad) {
    btn.textContent = "确认添加";
    if (noteEl) {
      noteEl.textContent = "已获得统计权限，将直接添加该站点，无需再次授权。";
    }
  } else {
    btn.textContent = "授予权限并添加";
    if (noteEl) {
      noteEl.textContent =
        "首次需授权一次（用于读取您添加的网站标签页）。授权后，再添加新网址将不再弹出 Firefox 权限框。";
    }
  }

  btn.disabled = !valid;
}

async function finishAddSite(pending) {
  const res = await browser.runtime.sendMessage({
    type: "ADD_CUSTOM_SITE",
    url: pending.url,
    name: pending.name || "",
    permissionsGranted: true,
  });

  if (!res?.ok) {
    throw new Error(res?.error || "添加失败");
  }

  await clearPendingAdd();

  if (Array.isArray(res.trackedSites)) {
    trackedSitesList = res.trackedSites;
  }
  if (res.site?.id) {
    snapshot.sites[res.site.id] = snapshot.sites[res.site.id] ?? 0;
  }

  closeAddView();
  await reloadTrackedSitesList();
  renderFromSnapshot(Date.now(), { rebuildList: true });
  await syncFromBackground();
}

/** 弹窗被 Firefox 权限对话框关闭后，再次打开时自动完成添加 */
async function tryResumePendingAdd() {
  const pending = await getPendingAdd();
  if (!pending?.origins) return false;

  if (!(await hasTrackingPermission(pending.origins))) {
    return false;
  }

  try {
    await finishAddSite(pending);
    return true;
  } catch (e) {
    const msg = e.message || String(e);
    if (msg.includes("已在追踪列表")) {
      await clearPendingAdd();
      closeAddView();
      await syncFromBackground();
    }
    return false;
  }
}

function openAddView() {
  closeAllRowMenus();
  document.getElementById("input-url").value = "";
  document.getElementById("input-name").value = "";
  document.getElementById("add-error").textContent = "";
  updateAddFormState();
  showView("view-add");
  document.getElementById("input-url").focus();
}

function closeAddView() {
  showView("view-main");
}

function closeAllRowMenus() {
  document.querySelectorAll(".site-row-wrap.is-open").forEach((el) => {
    el.classList.remove("is-open");
  });
  openRowSiteId = null;
}

function toggleRowMenu(siteId, wrapEl) {
  if (openRowSiteId === siteId) {
    closeAllRowMenus();
    return;
  }
  closeAllRowMenus();
  wrapEl.classList.add("is-open");
  openRowSiteId = siteId;
}

async function getTodayStatsFromBackground() {
  try {
    const res = await browser.runtime.sendMessage({ type: "GET_TODAY_STATS" });
    if (res?.ok && res.sites) {
      if (Array.isArray(res.trackedSites)) {
        trackedSitesList = res.trackedSites;
      }
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
  await reloadTrackedSitesList();
  const sites = await loadDailySites();
  return { sites, date: todayKey(), tracking: null };
}

async function renameTrackedSite(siteId, currentName) {
  closeAllRowMenus();
  const name = prompt("重命名为：", currentName);
  if (name === null) return;

  const trimmed = name.trim();
  if (!trimmed) {
    alert("名称不能为空");
    return;
  }

  try {
    const res = await browser.runtime.sendMessage({
      type: "RENAME_TRACKED_SITE",
      siteId,
      name: trimmed,
    });
    if (res?.ok) {
      if (Array.isArray(res.trackedSites)) {
        trackedSitesList = res.trackedSites;
      } else {
        await reloadTrackedSitesList();
      }
      renderFromSnapshot();
      return;
    }
    alert(res?.error || "重命名失败");
  } catch (e) {
    alert(e.message || "重命名失败");
  }
}

async function deleteTrackedSite(siteId, siteName) {
  closeAllRowMenus();
  const ok = confirm(
    `确定删除「${siteName}」？\n删除后不再统计该网站，今日已计时长也会移除。`
  );
  if (!ok) return;

  try {
    const res = await browser.runtime.sendMessage({
      type: "REMOVE_TRACKED_SITE",
      siteId,
    });
    if (res?.ok) {
      if (Array.isArray(res.trackedSites)) {
        trackedSitesList = res.trackedSites;
      } else {
        await reloadTrackedSitesList();
      }
      if (snapshot.sites[siteId] != null) {
        delete snapshot.sites[siteId];
      }
      if (snapshot.tracking?.siteId === siteId) {
        snapshot.tracking = null;
      }
      renderFromSnapshot();
      await syncFromBackground();
      return;
    }
    alert(res?.error || "删除失败");
  } catch (e) {
    alert(e.message || "删除失败");
  }
}

function updateLiveTimes(liveSites) {
  let total = 0;
  for (const site of trackedSitesList) {
    const sec = liveSites[site.id] || 0;
    total += sec;
    const wrap = document.querySelector(
      `.site-row-wrap[data-site-id="${site.id}"]`
    );
    if (!wrap) continue;
    const timeEl = wrap.querySelector(".site-time");
    if (timeEl) timeEl.textContent = formatDuration(sec);
  }
  document.getElementById("total").textContent = formatDuration(total);
}

function renderSiteList(sites) {
  const list = document.getElementById("site-list");
  const prevOpen = openRowSiteId;
  list.replaceChildren();

  const siteDefs = trackedSitesList.length ? trackedSitesList : [];

  if (!siteDefs.length) {
    list.textContent = "暂无追踪站点，点击右上角 + 添加";
    list.className = "empty";
    document.getElementById("total").textContent = formatDuration(0);
    openRowSiteId = null;
    return;
  }

  list.className = "";

  let total = 0;
  for (const site of siteDefs) {
    const sec = sites[site.id] || 0;
    total += sec;

    const wrap = document.createElement("div");
    wrap.className = "site-row-wrap";
    wrap.dataset.siteId = site.id;

    const actions = document.createElement("div");
    actions.className = "site-row-actions";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "action-btn action-btn--rename";
    renameBtn.textContent = "重命名";
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      renameTrackedSite(site.id, site.name);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "action-btn action-btn--delete";
    deleteBtn.textContent = "删除";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteTrackedSite(site.id, site.name);
    });

    actions.append(renameBtn, deleteBtn);

    const panel = document.createElement("div");
    panel.className = "site-row-panel";

    const main = document.createElement("div");
    main.className = "site-row-main";

    const name = document.createElement("span");
    name.className = "site-name";
    name.textContent = site.name;
    name.title = site.pattern || site.name;

    const time = document.createElement("span");
    time.className = "site-time";
    time.textContent = formatDuration(sec);

    main.append(name, time);

    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "btn-more";
    moreBtn.title = "更多操作";
    moreBtn.setAttribute("aria-label", `${site.name} 更多操作`);
    moreBtn.textContent = "···";
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleRowMenu(site.id, wrap);
    });

    panel.append(main, moreBtn);
    wrap.append(actions, panel);
    list.appendChild(wrap);
  }

  document.getElementById("total").textContent = formatDuration(total);

  if (prevOpen) {
    const openWrap = list.querySelector(
      `.site-row-wrap[data-site-id="${prevOpen}"]`
    );
    if (openWrap) {
      openWrap.classList.add("is-open");
      openRowSiteId = prevOpen;
    } else {
      openRowSiteId = null;
    }
  }
}

function renderFromSnapshot(nowMs = Date.now(), { rebuildList = true } = {}) {
  const liveSites = sitesWithLivePending(
    snapshot.sites,
    snapshot.tracking,
    nowMs
  );
  document.getElementById("date-label").textContent =
    `统计日 ${snapshot.date || todayKey()} · 每日 0:00 清零`;

  if (rebuildList) {
    renderSiteList(liveSites);
  } else {
    updateLiveTimes(liveSites);
  }
}

async function syncFromBackground() {
  await reloadTrackedSitesList();
  const payload =
    (await getTodayStatsFromBackground()) ?? (await getTodayStatsFromStorage());
  snapshot = {
    sites: payload.sites,
    date: payload.date,
    tracking: payload.tracking,
    fetchedAt: Date.now(),
  };
  renderFromSnapshot(Date.now(), { rebuildList: true });
}

/**
 * 必须在用户点击的同步调用栈里发起 permissions.request（之前不能有 await）。
 */
function confirmAddSite() {
  const url = document.getElementById("input-url").value.trim();
  const name = document.getElementById("input-name").value.trim();
  const errEl = document.getElementById("add-error");
  const btn = document.getElementById("btn-confirm-add");

  errEl.textContent = "";
  if (!url) {
    errEl.textContent = "请先输入有效网址";
    return;
  }

  let parsed;
  try {
    parsed = parseUrlInput(url);
  } catch (e) {
    errEl.textContent = e.message || "网址无效";
    updateAddFormState();
    return;
  }

  const pending = { url, name, origins: parsed.origins, host: parsed.host };
  btn.disabled = true;

  let permPromise;
  try {
    // 申请全局 https/http 权限：已授权时立即返回 true，不再弹窗
    permPromise = browser.permissions.request({
      origins: BROAD_TRACKING_ORIGINS,
    });
  } catch (e) {
    errEl.textContent = e.message || "请求权限失败";
    void updateAddFormState();
    return;
  }

  void afterPermissionRequest(permPromise, pending, errEl, btn);
}

async function afterPermissionRequest(permPromise, pending, errEl, btn) {
  let granted = false;
  try {
    granted = Boolean(await permPromise);
  } catch (e) {
    errEl.textContent = e.message || "请求权限失败";
    void updateAddFormState();
    return;
  }

  if (!granted) {
    errEl.textContent = "请允许访问网站数据，以便统计停留时间。";
    void updateAddFormState();
    return;
  }

  await savePendingAdd(pending);

  try {
    await finishAddSite(pending);
    await clearPendingAdd();
  } catch (e) {
    errEl.textContent = e.message || "添加失败";
    void updateAddFormState();
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await reloadTrackedSitesList();
  const resumed = await tryResumePendingAdd();
  if (!resumed) {
    await syncFromBackground();
  }

  document.getElementById("btn-open-add").addEventListener("click", openAddView);
  document.getElementById("btn-back").addEventListener("click", closeAddView);
  document.getElementById("btn-confirm-add").addEventListener("click", confirmAddSite);

  document.getElementById("input-url").addEventListener("input", updateAddFormState);

  function submitAddOnEnter(e) {
    if (e.key === "Enter" && !document.getElementById("btn-confirm-add").disabled) {
      document.getElementById("btn-confirm-add").click();
    }
  }
  document.getElementById("input-url").addEventListener("keydown", submitAddOnEnter);
  document.getElementById("input-name").addEventListener("keydown", submitAddOnEnter);

  document.getElementById("site-list-scroll").addEventListener("click", (e) => {
    if (!e.target.closest(".site-row-wrap")) {
      closeAllRowMenus();
    }
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.customSites) {
      reloadTrackedSitesList().then(() => {
        if (document.getElementById("view-main").classList.contains("active")) {
          renderFromSnapshot(Date.now(), { rebuildList: true });
        }
      });
    }
  });

  const syncTimer = setInterval(syncFromBackground, 2000);
  const uiTimer = setInterval(() => {
    if (document.getElementById("view-main").classList.contains("active")) {
      renderFromSnapshot(Date.now(), { rebuildList: false });
    }
  }, 1000);

  window.addEventListener("unload", () => {
    clearInterval(syncTimer);
    clearInterval(uiTimer);
    browser.runtime.sendMessage({ type: "RESUME_SESSION" }).catch(() => {});
  });
});

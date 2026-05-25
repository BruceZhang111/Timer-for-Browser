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

/* ================================================================
   Drag‑and‑drop controller (FLIP animation strategy, rAF‑batched)
   ================================================================ */
/* ================================================================
   Drag‑and‑drop controller (Virtual Translation Strategy / iOS Style)
   ================================================================ */
const dragCtrl = {
  active: false,
  sourceEl: null,
  cloneEl: null,
  sourceIndex: -1,
  currentIndex: -1,
  pointerOffsetY: 0,
  listEl: null,
  scrollEl: null,
  moved: false,
  threshold: 5,

  // 几何位置缓存
  _dragItems: [],
  _startY: 0,
  initialBaseTop: 0,
  initialScrollTop: 0,
  baseTop: 0,
  itemFullHeight: 0,
  itemCount: 0,

  // rAF 节流
  _rafId: null,
  _pendingY: 0,

  init(listEl, scrollEl) {
    this.listEl = listEl;
    this.scrollEl = scrollEl;
  },

  onPointerDown(e) {
    if (this.active) return;
    const row = e.target.closest(".site-row-wrap");
    if (!row) return;
    if (e.target.closest(".btn-more, .action-btn, .site-row-actions")) return;

    const rows = this.listEl.querySelectorAll(".site-row-wrap");
    if (rows.length <= 1) return;

    if (typeof closeAllRowMenus === "function") closeAllRowMenus();

    this.sourceEl = row;
    this._startY = e.clientY;
    this.moved = false;

    // 1. 立刻给予按下反馈（微缩或获得焦点）
    row.classList.add("is-clicked");

    row.setPointerCapture(e.pointerId);
    row.addEventListener("pointermove", this._onRowMove);
    row.addEventListener("pointerup", this._onRowUp);
    row.addEventListener("pointercancel", this._onRowUp);
  },

  _onRowMove: (e) => {
    const self = dragCtrl;
    const dy = e.clientY - self._startY;
    if (!self.moved && Math.abs(dy) < self.threshold) return;

    if (!self.moved) {
      self.moved = true;
      self.sourceEl.classList.remove("is-clicked"); // 消除按下态，准备起飞
      self._startDrag(e.clientY);
    }

    self._pendingY = e.clientY;
    if (!self._rafId) {
      self._rafId = requestAnimationFrame(() => {
        self._rafId = null;
        self._doUpdateDrag(self._pendingY);
      });
    }
  },

 _onRowUp: (e) => {
    const self = dragCtrl;
    const row = self.sourceEl;
    if (row) {
      row.classList.remove("is-clicked");
      row.removeEventListener("pointermove", self._onRowMove);
      row.removeEventListener("pointerup", self._onRowUp);
      row.removeEventListener("pointercancel", self._onRowUp);
    }

    if (self._rafId) {
      cancelAnimationFrame(self._rafId);
      self._rafId = null;
    }

    if (!self.moved) {
      self._fireClick(row);
      // 如果只是点击没拖拽，立刻结束状态并恢复定时器
      self.active = false;
      self.sourceEl = null;
      self.moved = false;
      if (typeof resumeTimers === "function") resumeTimers();
    } else {
      // 发生了拖拽，交接给 _endDrag 处理收尾
      self._endDrag();
    }
  },

  _startDrag(pointerY) {
    this.active = true;
    if (typeof pauseTimers === "function") pauseTimers();

    if (this.cloneEl) {
      this.cloneEl.remove();
      this.cloneEl = null;
    }

    // 缓存所有 DOM，后续全程通过 CSS transform 操作
    this._dragItems = [...this.listEl.querySelectorAll(".site-row-wrap")];
    this.itemCount = this._dragItems.length;
    this.sourceIndex = this._dragItems.indexOf(this.sourceEl);
    this.currentIndex = this.sourceIndex;

    // 测算高度与布局基准
    if (this.itemCount >= 2) {
      const r0 = this._dragItems[0].getBoundingClientRect();
      const r1 = this._dragItems[1].getBoundingClientRect();
      this.itemFullHeight = r1.top - r0.top;
    } else {
      this.itemFullHeight = this._dragItems[0].getBoundingClientRect().height + 12;
    }

    this.initialScrollTop = this.scrollEl.scrollTop;
    this.initialBaseTop = this._dragItems[0].getBoundingClientRect().top;
    this._refreshBaseTop();

    // 构建悬浮克隆层
    const panel = this.sourceEl.querySelector(".site-row-panel");
    const rect = panel.getBoundingClientRect();

    const cloneWrap = document.createElement("div");
    cloneWrap.className = "drag-clone";
    cloneWrap.style.width = Math.round(rect.width) + "px";
    cloneWrap.style.left = Math.round(rect.left) + "px";
    cloneWrap.style.top = Math.round(rect.top) + "px";

    const panelClone = panel.cloneNode(true);
    cloneWrap.appendChild(panelClone);
    document.body.appendChild(cloneWrap);

    // 2. 生命感起飞动画：平滑放大、增加阴影
    requestAnimationFrame(() => {
      panelClone.style.transition = 'transform 0.25s cubic-bezier(0.2, 0, 0, 1), box-shadow 0.25s ease';
      panelClone.style.transform = 'scale(1.05)';
      panelClone.style.boxShadow = '0 16px 32px rgba(51, 102, 255, 0.15)';
    });

    this.cloneEl = cloneWrap;
    this.pointerOffsetY = rect.top - pointerY;

    // 源元素变成灰色底层占位符
    this.sourceEl.classList.add("is-drag-source");

    // 清空任何历史过渡状态
    this._dragItems.forEach(item => {
      item.style.transform = '';
      item.style.transition = '';
    });
  },

  _doUpdateDrag(pointerY) {
    // 悬浮层跟手移动
    this.cloneEl.style.top = Math.round(pointerY + this.pointerOffsetY) + "px";

    this._autoScroll(pointerY);
    this._refreshBaseTop();

    // 计算当前应当处于的视觉索引
    const raw = Math.floor((pointerY - this.baseTop + this.itemFullHeight * 0.5) / this.itemFullHeight);
    const targetIdx = Math.max(0, Math.min(raw, this.itemCount - 1));

    if (targetIdx !== this.currentIndex) {
      this._shiftItems(targetIdx);
      this.currentIndex = targetIdx;
    }
  },

  _shiftItems(targetIdx) {
    const startIdx = this.sourceIndex;
    // 使用 Apple 经典的优雅过渡曲线
    const ease = 'transform 0.35s cubic-bezier(0.33, 1, 0.68, 1)';

    // 3. 动态移动占位符：让底部的缺口像有生命一样跟随滑动
    const placeholderTy = (targetIdx - startIdx) * this.itemFullHeight;
    this.sourceEl.style.transition = ease;
    this.sourceEl.style.transform = `translate3d(0, ${placeholderTy}px, 0)`;

    // 根据目标位置推挤其他项目 (全部通过 GPU 计算位移)
    for (let i = 0; i < this.itemCount; i++) {
      if (i === startIdx) continue;
      const item = this._dragItems[i];
      let ty = 0;

      if (startIdx < targetIdx && i > startIdx && i <= targetIdx) {
        ty = -this.itemFullHeight; // 向上让位
      } else if (startIdx > targetIdx && i >= targetIdx && i < startIdx) {
        ty = this.itemFullHeight;  // 向下让位
      }

      item.style.transition = ease;
      item.style.transform = `translate3d(0, ${ty}px, 0)`;
    }
  },

 _endDrag() {
    if (!this.cloneEl || !this.sourceEl) return;

    this._refreshBaseTop();
    const finalTop = this.baseTop + this.currentIndex * this.itemFullHeight;

    // 4. 落地吸附动画
    this.cloneEl.style.transition = 'top 0.3s cubic-bezier(0.33, 1, 0.68, 1)';
    this.cloneEl.style.top = Math.round(finalTop) + "px";

    const panelClone = this.cloneEl.querySelector('.site-row-panel');
    if (panelClone) {
      panelClone.style.transform = 'scale(1)';
      panelClone.style.boxShadow = '0 2px 8px rgba(30, 40, 90, 0.06)';
    }

    const onDropComplete = () => {
      if (this.cloneEl) {
        this.cloneEl.remove();
        this.cloneEl = null;
      }

      // 5. 动画落幕后：静默变更真实 DOM 结构
      if (this.currentIndex !== this.sourceIndex) {
        const targetNode = this._dragItems[this.currentIndex];
        if (this.currentIndex > this.sourceIndex) {
          this.listEl.insertBefore(this.sourceEl, targetNode.nextSibling);
        } else {
          this.listEl.insertBefore(this.sourceEl, targetNode);
        }
      }

      // 重置所有视觉偏移属性
      this._dragItems.forEach(item => {
        item.style.transition = '';
        item.style.transform = '';
      });

      this.sourceEl.classList.remove("is-drag-source");

      // 6. 持久化顺序并彻底结束拖拽状态
      this._persistOrder().then(() => {
        this.active = false;
        this.sourceEl = null;
        this.moved = false;
        if (typeof resumeTimers === "function") resumeTimers();
      });
    };

    this.cloneEl.addEventListener("transitionend", onDropComplete, { once: true });
    // 后备机制
    setTimeout(() => {
      if (this.sourceEl && this.sourceEl.classList.contains("is-drag-source")) {
        onDropComplete();
      }
    }, 350);
  },

  _refreshBaseTop() {
    // 抵消滚动差值，保证无论怎么滚都能精准定位
    const scrollDelta = this.scrollEl.scrollTop - this.initialScrollTop;
    this.baseTop = this.initialBaseTop - scrollDelta;
  },

  _autoScroll(pointerY) {
    const margin = 50;
    const scrollRect = this.scrollEl.getBoundingClientRect();
    if (pointerY > scrollRect.top + margin && pointerY < scrollRect.bottom - margin) return;

    const zone = 40;
    const maxSpeed = 7;

    if (pointerY < scrollRect.top + zone) {
      const frac = Math.max(0, 1 - (pointerY - scrollRect.top) / zone);
      this.scrollEl.scrollTop = Math.max(0, this.scrollEl.scrollTop - frac * maxSpeed);
    } else if (pointerY > scrollRect.bottom - zone) {
      const frac = Math.max(0, 1 - (scrollRect.bottom - pointerY) / zone);
      this.scrollEl.scrollTop += frac * maxSpeed;
    }
  },

  _fireClick(row) {
    if (!row) return;
    row.classList.add("is-clicked");
    setTimeout(() => row.classList.remove("is-clicked"), 200);
  },

async _persistOrder() {
    const items = this.listEl.querySelectorAll(".site-row-wrap");
    const orderedIds = [...items].map((el) => el.dataset.siteId).filter(Boolean);
    try {
      const res = await browser.runtime.sendMessage({
        type: "REORDER_TRACKED_SITES",
        siteIds: orderedIds,
      });
      
      // 更新本地缓存，防止后续 render 渲染旧顺序导致闪烁
      if (res?.ok && Array.isArray(res.trackedSites)) {
        if (typeof trackedSitesList !== 'undefined') {
          trackedSitesList = res.trackedSites;
        }
      }
    } catch (e) {
      console.warn("[timer-for-browser popup] reorder persist failed", e);
    }
  },
};

/* ---- Timer pause/resume: prevents DOM rebuilds mid‑drag ---- */
let _syncTimerId = null;
let _uiTimerId = null;

function pauseTimers() {
  if (_syncTimerId != null) { clearInterval(_syncTimerId); _syncTimerId = null; }
  if (_uiTimerId != null) { clearInterval(_uiTimerId); _uiTimerId = null; }
}

function resumeTimers() {
  if (_syncTimerId == null) {
    _syncTimerId = setInterval(() => {
      if (dragCtrl.active) return;
      syncFromBackground();
    }, 2000);
  }
  if (_uiTimerId == null) {
    _uiTimerId = setInterval(() => {
      if (dragCtrl.active) return; // skip during drag
      if (document.getElementById("view-main").classList.contains("active")) {
        renderFromSnapshot(Date.now(), { rebuildList: false });
      }
    }, 1000);
  }
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

    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.setAttribute("aria-hidden", "true");

    const name = document.createElement("span");
    name.className = "site-name";
    name.textContent = site.name;
    name.title = site.pattern || site.name;

    const time = document.createElement("span");
    time.className = "site-time";
    time.textContent = formatDuration(sec);

    main.append(handle, name, time);

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

  // Drag-and-drop sorting
  dragCtrl.init(
    document.getElementById("site-list"),
    document.getElementById("site-list-scroll")
  );
  document.getElementById("site-list").addEventListener("pointerdown", (e) => {
    dragCtrl.onPointerDown(e);
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

  _syncTimerId = setInterval(() => {
    if (dragCtrl.active) return; // skip full rebuild during drag
    syncFromBackground();
  }, 2000);
  _uiTimerId = setInterval(() => {
    if (dragCtrl.active) return; // skip during drag
    if (document.getElementById("view-main").classList.contains("active")) {
      renderFromSnapshot(Date.now(), { rebuildList: false });
    }
  }, 1000);

  window.addEventListener("unload", () => {
    if (_syncTimerId != null) { clearInterval(_syncTimerId); _syncTimerId = null; }
    if (_uiTimerId != null) { clearInterval(_uiTimerId); _uiTimerId = null; }
    browser.runtime.sendMessage({ type: "RESUME_SESSION" }).catch(() => {});
  });
});

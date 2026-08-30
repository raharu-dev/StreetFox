"use strict";

/*
 * StreetFox content script — the in-page UI on Google Maps.
 *
 * Injects a small button cluster (download + settings) next to Street
 * View's own controls, styled to match whatever button look Maps is
 * currently using (light or dark theme). The cluster only shows while the
 * tab is actually viewing a Street View panorama. Google Maps is an SPA
 * that rebuilds its DOM, so an interval re-checks attachment + visibility.
 */

(() => {
  if (window.__streetfoxInjected) return;
  window.__streetfoxInjected = true;

  // top-level Maps tabs only — not Street View embeds on third-party pages
  try {
    if (window.top !== window.self) return;
  } catch (e) {
    return;
  }

  const ROOT_ID = "streetfox-root";
  const TICK_MS = 800;
  const RECENT_TILE_MS = 20000; // "tab has Street View tiles loading recently"
  const CAPTURE_TRUST_MS = 60000; // how long a captured pano stays authoritative

  const ICON_DOWNLOAD =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 4v11"/><path d="m7 10.5 5 5 5-5"/><path d="M5 20h14"/></svg>';
  const ICON_SETTINGS =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true">' +
    '<path d="M4 8h8"/><circle cx="16.5" cy="8" r="2.7"/><path d="M4 16h2.5"/>' +
    '<circle cx="11" cy="16" r="2.7"/><path d="M14 16h6"/></svg>';
  const ICON_CHECK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const ICON_CLOSE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  const state = {
    captured: null, // { panoid, ts } from background tile capture
    lastHref: location.href,
    lastHrefChange: 0,
    mode: "idle", // idle | busy
    pct: 0,
    phase: "",
    toastTimer: 0,
    hasToast: false,
    settingsOpen: false
  };

  let root = null;
  let dlBtn = null;
  let gearBtn = null;
  let toastEl = null;
  let panelEl = null;
  let pctEl = null;
  let ringEl = null;
  let dlIconEl = null;
  let successTimer = 0;
  let themeApplied = false;

  /* ---------------------------------------------------------------- */
  /* DOM                                                              */
  /* ---------------------------------------------------------------- */

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html; // only ever our own static strings
    return n;
  }

  function ensureRoot() {
    if (document.getElementById(ROOT_ID)) return;
    root = el("div", "streetfox-hidden");
    root.id = ROOT_ID;

    toastEl = el("div", "streetfox-toast");
    toastEl.hidden = true;

    const cluster = el("div", "streetfox-cluster");
    dlBtn = el("button", "streetfox-btn");
    dlBtn.type = "button";
    dlBtn.title = "Download 360° panorama (StreetFox)";
    dlBtn.innerHTML =
      '<span class="streetfox-icon">' + ICON_DOWNLOAD + "</span>" +
      '<span class="streetfox-ring"></span>' +
      '<span class="streetfox-pct" hidden></span>';
    gearBtn = el("button", "streetfox-btn streetfox-gear");
    gearBtn.type = "button";
    gearBtn.title = "StreetFox settings";
    gearBtn.innerHTML = '<span class="streetfox-icon">' + ICON_SETTINGS + "</span>";
    cluster.append(dlBtn, gearBtn);

    panelEl = el("div", "streetfox-panel");
    panelEl.hidden = true;
    const title = el("div", "streetfox-panel-title");
    const titleText = el("span");
    titleText.textContent = "StreetFox";
    const closeBtn = el("button", "streetfox-panel-close");
    closeBtn.type = "button";
    closeBtn.title = "Close";
    closeBtn.innerHTML = ICON_CLOSE;
    title.append(titleText, closeBtn);
    const body = el("div", "streetfox-panel-body");
    panelEl.append(title, body);

    root.append(toastEl, cluster, panelEl);
    (document.documentElement || document.body).append(root);

    dlIconEl = dlBtn.querySelector(".streetfox-icon");
    ringEl = dlBtn.querySelector(".streetfox-ring");
    pctEl = dlBtn.querySelector(".streetfox-pct");

    dlBtn.addEventListener("click", startDownload);
    gearBtn.addEventListener("click", toggleSettings);
    closeBtn.addEventListener("click", () => setSettingsOpen(false));
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.settingsOpen) setSettingsOpen(false);
    }, true);

    themeApplied = false;
  }

  /* ---------------------------------------------------------------- */
  /* Look like a native Maps button                                    */
  /* ---------------------------------------------------------------- */

  function applyTheme() {
    if (themeApplied || !dlBtn) return;
    let bg = "#ffffff";
    let color = "#3c4043";
    let radius = "50%";
    let shadow = "0 1px 4px rgba(0, 0, 0, 0.3)";
    let border = "none";
    let sampled = false;
    try {
      // sample a real square Maps control button near the bottom-right
      const cands = document.querySelectorAll('button, [role="button"]');
      for (const c of cands) {
        const r = c.getBoundingClientRect();
        if (r.width < 34 || r.width > 66 || Math.abs(r.width - r.height) > 8) continue;
        if (r.x < innerWidth - 160 || r.y < innerHeight - 260) continue;
        const cs = getComputedStyle(c);
        if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.5) continue;
        if (!cs.backgroundColor || cs.backgroundColor === "rgba(0, 0, 0, 0)") continue;
        bg = cs.backgroundColor;
        color = cs.color;
        if (cs.borderRadius && cs.borderRadius !== "0px") radius = cs.borderRadius;
        shadow = cs.boxShadow;
        border = cs.border;
        sampled = true;
        break;
      }
      if (!sampled) {
        // fall back to page luminance → Maps dark mode uses dark gray controls
        const bodyBg = getComputedStyle(document.body).backgroundColor;
        const m = bodyBg && bodyBg.match(/\d+(\.\d+)?/g);
        if (m && m.length >= 3) {
          const [rr, gg, bb] = m.map(Number);
          if ((0.299 * rr + 0.587 * gg + 0.114 * bb) / 255 < 0.35) {
            bg = "#303134";
            color = "#e8eaed";
          }
        }
      }
    } catch (e) {
      /* keep defaults */
    }
    for (const b of [dlBtn, gearBtn]) {
      b.style.backgroundColor = bg;
      b.style.color = color;
      b.style.borderRadius = radius;
      b.style.boxShadow = shadow;
      b.style.border = border;
    }
    themeApplied = true;
  }

  /* ---------------------------------------------------------------- */
  /* Visibility                                                       */
  /* ---------------------------------------------------------------- */

  function setVisible(show) {
    if (!root) return;
    const hidden = root.classList.contains("streetfox-hidden");
    if (show && hidden) {
      applyTheme();
      root.classList.remove("streetfox-hidden");
    } else if (!show && !hidden && state.mode !== "busy") {
      root.classList.add("streetfox-hidden");
    }
  }

  async function tick() {
    if (!document.body) return;
    ensureRoot();

    if (location.href !== state.lastHref) {
      state.lastHref = location.href;
      state.lastHrefChange = Date.now();
    }

    try {
      const status = await browser.runtime.sendMessage({ type: "getStatus" });
      if (status && status.panoid) state.captured = { panoid: status.panoid, ts: status.ts };
    } catch (e) {
      /* background unreachable — URL fallback still works */
    }

    const urlPano = streetfoxPanoIdFromUrl(location.href);
    const urlSv = streetfoxLooksLikeStreetViewUrl(location.href);
    const recent =
      !!state.captured && Date.now() - state.captured.ts < RECENT_TILE_MS && !document.hidden;
    const hasPano = !!(urlPano || (recent && state.captured.panoid));
    const keepVisible = state.mode === "busy" || state.hasToast || state.settingsOpen;
    setVisible(keepVisible || ((urlSv || recent) && hasPano));
  }

  /**
   * Best guess at the pano currently on screen. Tile requests that arrived
   * after the last URL change reflect what is actually displayed (this is
   * also what makes historical imagery work — the URL never updates there).
   */
  function currentPanoId() {
    const urlPano = streetfoxPanoIdFromUrl(location.href);
    const cap = state.captured;
    if (cap && cap.ts > state.lastHrefChange && Date.now() - cap.ts < CAPTURE_TRUST_MS) {
      return cap.panoid;
    }
    if (urlPano) return urlPano;
    return cap ? cap.panoid : null;
  }

  /* ---------------------------------------------------------------- */
  /* Download                                                         */
  /* ---------------------------------------------------------------- */

  function startDownload() {
    if (state.mode === "busy") return;
    const panoId = currentPanoId();
    if (!panoId) {
      showToast("No Street View panorama detected on this page.", true);
      return;
    }

    setBusy(true);
    let port;
    try {
      port = browser.runtime.connect({ name: STREETFOX_PORT_NAME });
    } catch (e) {
      setBusy(false);
      showToast("Could not reach the StreetFox background script.", true);
      return;
    }

    port.onDisconnect.addListener(() => {
      if (state.mode === "busy") {
        setBusy(false);
        showToast("Download connection closed unexpectedly.", true);
      }
    });
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === "status") {
        state.phase = msg.text || "";
        updateBusyUI();
      } else if (msg.type === "progress") {
        state.pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
        state.phase = "";
        updateBusyUI();
      } else if (msg.type === "done") {
        port.disconnect();
        onDone(msg);
      } else if (msg.type === "error") {
        port.disconnect();
        setBusy(false);
        showToast(msg.message || "Download failed.", true, 7000);
      }
    });
    port.postMessage({ type: "start", panoId });
  }

  function setBusy(on) {
    state.mode = on ? "busy" : "idle";
    state.pct = 0;
    state.phase = "";
    dlBtn.classList.toggle("streetfox-busy", on);
    dlIconEl.style.display = on ? "none" : "";
    pctEl.hidden = !on;
    gearBtn.disabled = on;
    if (on) {
      pctEl.textContent = "…";
    } else {
      ringEl.style.removeProperty("--p");
      pctEl.textContent = "";
      dlBtn.title = "Download 360° panorama (StreetFox)";
    }
    setVisible(true);
    updateBusyUI();
  }

  function updateBusyUI() {
    if (state.mode !== "busy") return;
    if (state.phase) {
      // indeterminate phase (metadata / encoding / saving)
      ringEl.style.setProperty("--p", "0");
      ringEl.classList.add("streetfox-spin");
      pctEl.textContent = "";
      dlBtn.title = state.phase;
    } else {
      ringEl.classList.remove("streetfox-spin");
      ringEl.style.setProperty("--p", String(state.pct));
      pctEl.textContent = state.pct + "%";
      dlBtn.title = "Downloading… " + state.pct + "%";
    }
  }

  function onDone(msg) {
    setBusy(false);
    dlBtn.classList.add("streetfox-success");
    dlIconEl.innerHTML = ICON_CHECK;
    dlIconEl.style.display = "";
    pctEl.hidden = true;
    clearTimeout(successTimer);
    successTimer = setTimeout(() => {
      dlBtn.classList.remove("streetfox-success");
      dlIconEl.innerHTML = ICON_DOWNLOAD;
    }, 2500);

    const bits = ["Saved " + msg.width + "×" + msg.height];
    if (msg.filename) bits.push(msg.filename.split("/").pop());
    if (msg.usedFallbackLadder) bits.push("exact sizes unavailable — assumed standard ladder");
    showToast(bits.join("  ·  "), false, 6000);
  }

  /* ---------------------------------------------------------------- */
  /* Toast                                                            */
  /* ---------------------------------------------------------------- */

  function showToast(text, isError, ms = 4500) {
    if (!toastEl) return;
    state.hasToast = true;
    toastEl.hidden = false;
    toastEl.textContent = text;
    toastEl.classList.toggle("streetfox-error", !!isError);
    setVisible(true);
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      toastEl.hidden = true;
      state.hasToast = false;
    }, ms);
  }

  /* ---------------------------------------------------------------- */
  /* Settings panel                                                   */
  /* ---------------------------------------------------------------- */

  function setSettingsOpen(open) {
    state.settingsOpen = open;
    if (!panelEl) return;
    panelEl.hidden = !open;
    if (open) {
      setVisible(true);
      if (!panelEl.dataset.rendered) {
        panelEl.dataset.rendered = "1";
        StreetFoxSettings.render(panelEl.querySelector(".streetfox-panel-body"));
      }
    }
  }

  function toggleSettings() {
    setSettingsOpen(!state.settingsOpen);
  }

  function onDocClick(e) {
    if (state.settingsOpen && root && !root.contains(e.target)) setSettingsOpen(false);
  }

  /* ---------------------------------------------------------------- */

  ensureRoot();
  tick();
  setInterval(tick, TICK_MS);
})();

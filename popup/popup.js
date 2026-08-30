"use strict";

/* StreetFox toolbar popup: download the active tab's panorama + settings. */

const $ = (id) => document.getElementById(id);

let panoId = null;
let mode = "idle";

async function refresh() {
  try {
    const st = await browser.runtime.sendMessage({ type: "getStatusForActiveTab" });
    panoId = st && st.panoid;
    if (panoId) {
      const bits = [];
      if (st.address) bits.push(st.address);
      if (st.date) bits.push(st.date.year + "-" + String(st.date.month).padStart(2, "0"));
      if (st.maxWidth) bits.push("up to " + st.maxWidth + " px wide");
      $("pano-info").textContent = (bits.length ? bits.join("  ·  ") + "\n" : "") + panoId;
      $("dl").disabled = mode === "busy";
    } else {
      $("pano-info").textContent = "No Street View panorama in the active tab.\nOpen Google Maps in Street View first.";
      $("dl").disabled = true;
    }
  } catch (e) {
    $("pano-info").textContent = "Extension error: " + (e && e.message ? e.message : e);
    $("dl").disabled = true;
  }
}

function setBar(frac, text) {
  $("bar").hidden = false;
  $("bar-fill").style.width = frac === null ? "8%" : Math.round(frac * 100) + "%";
  if (text) {
    $("status").hidden = false;
    $("status").textContent = text;
  }
}

$("dl").addEventListener("click", () => {
  if (!panoId || mode === "busy") return;
  mode = "busy";
  $("dl").disabled = true;
  $("status").hidden = true;
  setBar(null, "Starting…");

  let port;
  try {
    port = browser.runtime.connect({ name: STREETFOX_PORT_NAME });
  } catch (e) {
    mode = "idle";
    $("dl").disabled = false;
    $("bar").hidden = true;
    $("status").hidden = false;
    $("status").textContent = "Could not reach the background script.";
    return;
  }

  port.onDisconnect.addListener(() => {
    if (mode === "busy") {
      mode = "idle";
      $("dl").disabled = false;
      $("bar").hidden = true;
      $("status").hidden = false;
      $("status").textContent = "Download connection closed unexpectedly.";
    }
  });

  port.onMessage.addListener((m) => {
    if (!m) return;
    if (m.type === "status") {
      setBar(null, m.text);
    } else if (m.type === "progress") {
      setBar(m.total ? m.done / m.total : 0, m.done + " / " + m.total + " tiles");
    } else if (m.type === "done") {
      port.disconnect();
      mode = "idle";
      $("dl").disabled = false;
      $("bar").hidden = true;
      $("status").hidden = false;
      $("status").textContent = "Saved " + m.width + "×" + m.height + " · " + String(m.filename).split("/").pop();
    } else if (m.type === "error") {
      port.disconnect();
      mode = "idle";
      $("dl").disabled = false;
      $("bar").hidden = true;
      $("status").hidden = false;
      $("status").textContent = m.message || "Download failed.";
    }
  });

  port.postMessage({ type: "start", panoId });
});

$("open-settings").addEventListener("click", () => browser.runtime.openOptionsPage());

refresh();

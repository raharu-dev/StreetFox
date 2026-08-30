"use strict";

/*
 * StreetFox background page (persistent, MV2).
 *
 * Responsibilities:
 *  1. Passively capture the panorama id of every tab from the tile requests
 *     the Maps page itself makes (works for historical imagery too, where
 *     the URL never updates).
 *  2. Fetch panorama metadata (size ladder, coords, date) from photometa/v1.
 *  3. On request: download all tiles, stitch them into an equirectangular
 *     panorama on a canvas, embed GPano XMP, save via the downloads API.
 *     Progress is streamed to the caller over a runtime Port.
 */

const STREETFOX_TILE_CONCURRENCY = 8;
const STREETFOX_BLACK_TILE_BYTES = 1300; // uniform-black placeholder tiles are ~1184 B; real tiles are ≥ ~1.9 KB

const tabPanos = new Map(); // tabId -> { panoid, ts }
const metaCache = new Map(); // panoid -> Promise<meta>
const liveBlobs = new Map(); // downloadId -> objectURL (revoked on completion)
let busy = false;

/* ------------------------------------------------------------------ */
/* Pano capture                                                        */
/* ------------------------------------------------------------------ */

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      const u = new URL(details.url);
      if (u.pathname !== "/v1/tile") return;
      const panoid = u.searchParams.get("panoid");
      if (!panoid || details.tabId < 0) return;
      tabPanos.set(details.tabId, { panoid, ts: Date.now() });
      if (tabPanos.size > 64) {
        // prune the oldest entry so the map never grows unbounded
        let oldestId = null;
        let oldestTs = Infinity;
        for (const [id, v] of tabPanos) if (v.ts < oldestTs) (oldestTs = v.ts), (oldestId = id);
        if (oldestId !== null) tabPanos.delete(oldestId);
      }
    } catch (e) {
      /* malformed URL — ignore */
    }
  },
  { urls: ["https://streetviewpixels-pa.googleapis.com/v1/tile*"] }
);

browser.tabs.onRemoved.addListener((tabId) => tabPanos.delete(tabId));

/* ------------------------------------------------------------------ */
/* Messaging                                                           */
/* ------------------------------------------------------------------ */

function statusForTab(tabId) {
  const p = Number.isFinite(tabId) && tabId >= 0 ? tabPanos.get(tabId) : null;
  return { panoid: p ? p.panoid : null, ts: p ? p.ts : 0, busy };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== "string") return undefined;

  switch (msg.type) {
    case "getStatus":
      return Promise.resolve(statusForTab(sender.tab && sender.tab.id));

    case "getStatusForActiveTab":
      return (async () => {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const status = statusForTab(tabs[0] && tabs[0].id);
        if (status.panoid && metaCache.has(status.panoid)) {
          try {
            const meta = await metaCache.get(status.panoid);
            status.address = meta.address || null;
            status.date = meta.date || null;
            status.maxWidth = meta.imageSizes.length ? meta.imageSizes[meta.imageSizes.length - 1][1] : null;
          } catch (e) {
            /* metadata unavailable — popup just shows less info */
          }
        }
        return status;
      })();

    case "openOptions":
      return browser.runtime.openOptionsPage();

    default:
      return undefined;
  }
});

function post(port, obj) {
  try {
    port.postMessage(obj);
  } catch (e) {
    /* port closed mid-download — keep going, the file still saves */
  }
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== STREETFOX_PORT_NAME) return;
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === "start" && msg.panoId) runDownload(port, String(msg.panoId));
  });
});

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

async function fetchMeta(panoid) {
  if (metaCache.has(panoid)) return metaCache.get(panoid);
  const p = (async () => {
    const res = await fetch(streetfoxPhotometaUrl(panoid), { credentials: "omit" });
    if (!res.ok) throw new Error("metadata HTTP " + res.status);
    let text = await res.text();
    if (text.startsWith(")]}'")) text = text.replace(/^\)\]\}'\s*/, "");
    const meta = streetfoxParsePhotometa(JSON.parse(text));
    if (!meta || !meta.imageSizes.length) throw new Error("no metadata for this panorama");
    return meta;
  })();
  metaCache.set(panoid, p);
  p.catch(() => metaCache.delete(panoid));
  return p;
}

function fallbackMeta(panoid) {
  return {
    panoId: panoid,
    imageSizes: STREETFOX_FALLBACK_LADDER.map((x) => x.slice()),
    tileWidth: 512,
    tileHeight: 512
  };
}

/* ------------------------------------------------------------------ */
/* Tiles + canvas                                                      */
/* ------------------------------------------------------------------ */

/** Firefox silently fails above its canvas limits (32767 px per side,
 *  134,217,728 px area) — probe with a write+readback before committing. */
function canvasWorks(w, h) {
  try {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    if (c.width !== w || c.height !== h) return false;
    const ctx = c.getContext("2d");
    if (!ctx) return false;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 2, 2);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return d[0] === 255 && d[1] === 255 && d[2] === 255;
  } catch (e) {
    return false;
  }
}

async function fetchTile(panoid, x, y, zoom) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(streetfoxTileUrl(panoid, x, y, zoom), { credentials: "omit" });
      if (!res.ok) return null; // e.g. 400 for zoom beyond the pano's ladder
      const buf = await res.arrayBuffer();
      if (buf.byteLength < STREETFOX_BLACK_TILE_BYTES) return null; // black placeholder, not a 404
      return buf;
    } catch (e) {
      if (attempt === 1) return null;
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  return null;
}

async function decodeTile(buf) {
  const blob = new Blob([buf], { type: "image/jpeg" });
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch (e) {
      /* fall through to <img> */
    }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("tile decode failed"));
    };
    img.src = url;
  });
}

async function runPool(limit, items, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

/* ------------------------------------------------------------------ */
/* Blob URL bookkeeping                                                */
/* ------------------------------------------------------------------ */

browser.downloads.onChanged.addListener((delta) => {
  if (!delta.id || !liveBlobs.has(delta.id)) return;
  const state = delta.state && delta.state.current;
  if (state === "complete" || state === "interrupted") {
    URL.revokeObjectURL(liveBlobs.get(delta.id));
    liveBlobs.delete(delta.id);
  }
});

/* ------------------------------------------------------------------ */
/* Download pipeline                                                   */
/* ------------------------------------------------------------------ */

async function runDownload(port, panoid) {
  if (busy) {
    post(port, { type: "error", message: "Another download is already running — wait for it to finish." });
    return;
  }
  busy = true;
  try {
    const settings = await streetfoxLoadSettings();

    post(port, { type: "status", text: "Fetching panorama metadata…" });
    let meta;
    let usedFallback = false;
    try {
      meta = await fetchMeta(panoid);
    } catch (e) {
      meta = fallbackMeta(panoid);
      usedFallback = true;
    }

    // choose zoom, stepping down if this machine's canvas can't take the size
    let zoom = streetfoxChooseZoomIndex(settings.resolution, meta.imageSizes.length);
    let w = 0;
    let h = 0;
    while (zoom >= 0) {
      const size = meta.imageSizes[zoom]; // [height, width]
      if (size && canvasWorks(size[1], size[0])) {
        h = size[0];
        w = size[1];
        break;
      }
      zoom--;
    }
    if (zoom < 0) throw new Error("Even the smallest size of this panorama exceeds this machine's canvas limits.");

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (settings.format === "png") {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
    }

    const cols = Math.ceil(w / meta.tileWidth);
    const rows = Math.ceil(h / meta.tileHeight);
    const coords = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) coords.push([x, y]);

    post(port, { type: "status", text: "Downloading tiles (" + w + "×" + h + ", " + coords.length + " tiles)…" });

    let done = 0;
    let blanks = 0;
    await runPool(STREETFOX_TILE_CONCURRENCY, coords, async ([x, y]) => {
      const buf = await fetchTile(panoid, x, y, zoom);
      if (buf) {
        try {
          const bmp = await decodeTile(buf);
          ctx.drawImage(bmp, x * meta.tileWidth, y * meta.tileHeight, meta.tileWidth, meta.tileHeight);
          if (bmp.close) bmp.close();
        } catch (e) {
          blanks++;
        }
      } else {
        blanks++;
      }
      done++;
      post(port, { type: "progress", done, total: coords.length });
    });

    post(port, { type: "status", text: "Encoding image…" });
    const wantPng = settings.format === "png";
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("canvas encoding failed"))),
        wantPng ? "image/png" : "image/jpeg",
        Math.min(1, Math.max(0.1, settings.jpegQuality / 100))
      );
    });

    // verify magic bytes — toBlob silently falls back to PNG for bad types
    const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    const isJpeg = head[0] === 0xff && head[1] === 0xd8;
    const isPng = head[0] === 0x89 && head[1] === 0x50;
    if (!isJpeg && !isPng) throw new Error("unexpected image encoding from canvas");
    const mime = isJpeg ? "image/jpeg" : "image/png";

    let outBlob = blob;
    if (settings.embedXmp) {
      const descParts = ["Street View pano " + (meta.panoId || panoid)];
      if (Number.isFinite(meta.lat) && Number.isFinite(meta.lng)) {
        descParts.push(meta.lat.toFixed(6) + "," + meta.lng.toFixed(6));
      }
      if (meta.date && streetfoxFormatDate(meta.date)) descParts.push("captured " + streetfoxFormatDate(meta.date));
      if (meta.copyright) descParts.push(meta.copyright);
      const xmp = StreetFoxXmp.buildGpanoPacket({
        width: w,
        height: h,
        heading: meta.heading,
        date: meta.date,
        description: descParts.join(" · "),
        software: "StreetFox " + STREETFOX_VERSION
      });
      let bytes = new Uint8Array(await blob.arrayBuffer());
      bytes = isJpeg ? StreetFoxXmp.injectJpeg(bytes, xmp) : StreetFoxXmp.injectPng(bytes, xmp);
      outBlob = new Blob([bytes], { type: mime });
    }

    const baseName = streetfoxExpandFilename(settings.filenameTemplate, {
      panoId: panoid,
      date: meta.date,
      address: meta.address,
      lat: meta.lat,
      lng: meta.lng,
      width: w,
      height: h
    });
    const filename = baseName + "." + (isJpeg ? "jpg" : "png");

    post(port, { type: "status", text: "Saving…" });
    const url = URL.createObjectURL(outBlob);
    try {
      const id = await browser.downloads.download({
        url,
        filename,
        conflictAction: "uniquify",
        saveAs: !!settings.saveAs
      });
      liveBlobs.set(id, url);
    } catch (e) {
      URL.revokeObjectURL(url);
      throw new Error("could not start the download: " + (e && e.message ? e.message : e));
    }

    post(port, {
      type: "done",
      width: w,
      height: h,
      zoom,
      filename,
      blankTiles: blanks,
      usedFallbackLadder: usedFallback,
      address: meta.address || null,
      date: meta.date || null
    });
  } catch (e) {
    post(port, { type: "error", message: e && e.message ? e.message : String(e) });
  } finally {
    busy = false;
  }
}

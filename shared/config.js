"use strict";

/*
 * StreetFox — shared configuration, defaults and Street View protocol helpers.
 *
 * Loaded as a classic script in every context (background page, content
 * script, options page, popup). Everything below is a top-level const or
 * function, so any script loaded afterwards can use it directly.
 *
 * Protocol notes (verified keyless, 2026-08):
 *  - Tiles:    streetviewpixels-pa.googleapis.com/v1/tile  (512×512 JPEG, no cookies/key)
 *  - Metadata: www.google.com/maps/photometa/v1             (per-zoom size ladder, coords, date)
 *  - Panoramas come in (at least) two size ladders — never assume powers of two;
 *    always prefer the ladder returned by photometa.
 */

const STREETFOX_VERSION = "1.0.0";
const STREETFOX_STORAGE_KEY = "settings";
const STREETFOX_PORT_NAME = "pano-download";

const STREETFOX_DEFAULTS = {
  resolution: "z3",        // "auto" | "z2" | "z3" | "z4" | "z5"
  format: "jpeg",          // "jpeg" | "png"
  jpegQuality: 90,         // 60..100, jpeg only
  embedXmp: true,
  filenameTemplate: "StreetView {panoid} {date}",
  saveAs: false
};

/** Fallback "new" (post-2016) size ladder: [height, width] per zoom 0..5. */
const STREETFOX_FALLBACK_LADDER = [
  [256, 512], [512, 1024], [1024, 2048], [2048, 4096], [4096, 8192], [8192, 16384]
];

const STREETFOX_TILE_ENDPOINT = "https://streetviewpixels-pa.googleapis.com/v1/tile";
const STREETFOX_PHOTOMETA_ENDPOINT = "https://www.google.com/maps/photometa/v1";

function streetfoxTileUrl(panoid, x, y, zoom) {
  const q = new URLSearchParams({
    cb_client: "maps_sv.tactile",
    panoid: String(panoid),
    x: String(x),
    y: String(y),
    zoom: String(zoom),
    nbt: "1",
    fover: "2"
  });
  return STREETFOX_TILE_ENDPOINT + "?" + q.toString();
}

/* pb payload for photometa/v1, by-pano-id lookup (field 3 carries the pano
 * id; the trailing toggles request the size ladder, address, copyright,
 * places and neighbours). */
const STREETFOX_PHOTOMETA_PB =
  "!1m4!1smaps_sv.tactile!11m2!2m1!1b1!2m2!1sen!2sus!3m3!1m2!1e2!2s{panoid}" +
  "!4m57!1e1!1e2!1e3!1e4!1e5!1e6!1e8!1e12!2m1!1e1!4m1!1i48!5m1!1e1!5m1!1e2" +
  "!6m1!1e1!6m1!1e2!9m36!1m3!1e2!2b1!3e2!1m3!1e2!2b0!3e3!1m3!1e3!2b1!3e2" +
  "!1m3!1e3!2b0!3e3!1m3!1e8!2b0!3e3!1m3!1e1!2b0!3e3!1m3!1e4!2b0!3e3" +
  "!1m3!1e10!2b1!3e2!1m3!1e10!2b0!3e3";

function streetfoxPhotometaUrl(panoid) {
  const pb = STREETFOX_PHOTOMETA_PB.replace("{panoid}", encodeURIComponent(String(panoid)));
  return STREETFOX_PHOTOMETA_ENDPOINT + "?authuser=0&hl=en&gl=us&pb=" + encodeURIComponent(pb);
}

/* ------------------------------------------------------------------ */
/* Metadata parsing                                                     */
/* ------------------------------------------------------------------ */

function streetfoxTryGet(fn) {
  try {
    const v = fn();
    return v === undefined || v === null ? undefined : v;
  } catch (e) {
    return undefined;
  }
}

/**
 * Parse a photometa/v1 JSON document (the leading )]}' XSSI prefix must
 * already be stripped). Field paths mirror the reference implementation in
 * sk-zk/streetlevel (streetview/parse.py), wrapped defensively because
 * Google shifts indices between responses.
 *
 * Returns null when the response means "not found"; throws never.
 */
function streetfoxParsePhotometa(doc) {
  const code = streetfoxTryGet(() => doc[1][0][0][0]); // 1 / 3 = OK, 2 = not found
  if (code !== 1 && code !== 3) return null;
  const msg = streetfoxTryGet(() => doc[1][0]);
  if (!msg) return null;

  let panoId = streetfoxTryGet(() => msg[1][1]);
  if (Array.isArray(panoId)) panoId = panoId[1];

  const rawSizes = streetfoxTryGet(() => msg[2][3][0]) || [];
  const imageSizes = [];
  for (const entry of rawSizes) {
    let hw = entry;
    if (Array.isArray(hw) && Array.isArray(hw[0])) hw = hw[0];
    if (!Array.isArray(hw) || hw.length < 2) continue;
    const a = Number(hw[0]);
    const b = Number(hw[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
    // entries are [height, width]; an equirect is always wider than tall
    imageSizes.push([Math.min(a, b), Math.max(a, b)]);
  }
  imageSizes.sort((p, q) => p[1] - q[1]); // ascending width == ascending zoom

  const rawTile = streetfoxTryGet(() => msg[2][3][1]);
  const tileWidth = Number(streetfoxTryGet(() => rawTile[0])) || 512;
  const tileHeight = Number(streetfoxTryGet(() => rawTile[1])) || 512;

  const lat = Number(streetfoxTryGet(() => msg[5][0][1][0][2]));
  const lng = Number(streetfoxTryGet(() => msg[5][0][1][0][3]));
  const heading = Number(streetfoxTryGet(() => msg[5][0][1][2][0])); // degrees

  let address = "";
  const rawAddr = streetfoxTryGet(() => msg[3][2]);
  if (Array.isArray(rawAddr)) {
    address = rawAddr
      .map((a) => {
        if (typeof a === "string") return a;
        if (Array.isArray(a) && typeof a[0] === "string") return a[0];
        return "";
      })
      .filter(Boolean)
      .join(", ");
  }

  const copyright =
    streetfoxTryGet(() => msg[4][0][0][0][0]) ||
    streetfoxTryGet(() => msg[4][1][0][0][0]) ||
    "";

  let date = null;
  const d = streetfoxTryGet(() => msg[6][7]); // [year, month, day?]
  if (Array.isArray(d) && d.length >= 2 && Number.isFinite(Number(d[0]))) {
    date = { year: Number(d[0]), month: Number(d[1]) || 1, day: Number(d[2]) || undefined };
  } else {
    // third-party panos carry an exact "…/<epoch-ms>" timestamp instead
    const ts = streetfoxTryGet(() => msg[12][0]);
    if (typeof ts === "string" && ts.includes("/")) {
      const n = Number(ts.split("/")[1]);
      if (Number.isFinite(n) && n > 0) {
        const dt = new Date(n);
        date = { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
      }
    }
  }

  return {
    panoId: typeof panoId === "string" ? panoId : "",
    imageSizes,
    tileWidth,
    tileHeight,
    lat: Number.isFinite(lat) ? lat : undefined,
    lng: Number.isFinite(lng) ? lng : undefined,
    heading: Number.isFinite(heading) ? heading : undefined,
    address: address || undefined,
    copyright: copyright || undefined,
    date: date || undefined
  };
}

/** Map a settings.resolution value to a ladder index (== tile zoom param). */
function streetfoxChooseZoomIndex(resolution, ladderLength) {
  const maxIdx = Math.max(0, Math.min(5, (ladderLength || 1) - 1));
  if (resolution === "auto") return maxIdx;
  const want = Number(String(resolution).replace(/^z/, ""));
  if (!Number.isFinite(want)) return Math.min(3, maxIdx);
  return Math.max(0, Math.min(Math.floor(want), maxIdx));
}

/* ------------------------------------------------------------------ */
/* URL helpers                                                          */
/* ------------------------------------------------------------------ */

/* Pano id inside a /maps data= section: "!1s<id>!" — the id is alnum/_/-
 * and never contains ':' (the 0x…:0x… tokens are place ftids, NOT pano ids). */
const STREETFOX_PANO_ID_RE = /!1s([A-Za-z0-9_-]{16,40})(?=[!/#&]|$)/;

function streetfoxPanoIdFromUrl(href) {
  try {
    const u = new URL(href);
    const q = u.searchParams.get("panoid");
    if (q && /^[A-Za-z0-9_-]{8,40}$/.test(q) && !q.startsWith("0x")) return q;
    const m = (u.pathname + u.search).match(STREETFOX_PANO_ID_RE);
    if (m && !m[1].startsWith("0x")) return m[1];
  } catch (e) {
    /* ignore */
  }
  return null;
}

function streetfoxLooksLikeStreetViewUrl(href) {
  try {
    const u = new URL(href);
    if (u.searchParams.get("map_action") === "pano" || u.searchParams.get("panoid")) return true;
    const s = u.pathname + u.search;
    if (/\/@[^/]*,3a,\d+(?:\.\d+)?y/.test(s)) return true; // @lat,lng,3a,75y,…
    if (/\/data=[\s\S]*!3m\d+!1e\d+!3m\d+!1s/.test(s)) return true; // data=!3m…!1e…!3m…!1sID
    return false;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* File names                                                           */
/* ------------------------------------------------------------------ */

const STREETFOX_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function streetfoxSanitizeSegment(seg) {
  let s = String(seg)
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, " ") // illegal on Windows (downloads API rejects, not sanitizes)
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/, "")
    .trim();
  if (!s) s = "_";
  if (STREETFOX_RESERVED_NAMES.test(s)) s += "_";
  return s.slice(0, 120);
}

function streetfoxFormatDate(d) {
  if (!d || !d.year) return null;
  const mm = String(d.month || 1).padStart(2, "0");
  if (d.day) return d.year + "-" + mm + "-" + String(d.day).padStart(2, "0");
  return d.year + "-" + mm;
}

function streetfoxTodayStr() {
  const n = new Date();
  return n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0") + "-" + String(n.getDate()).padStart(2, "0");
}

/**
 * Expand a filename template. Tokens: {panoid} {date} {year} {month} {day}
 * {address} {lat} {lng} {width} {height}. "/" separates subfolders (each
 * segment sanitized). Unknown tokens are dropped; empty result falls back
 * to a sane default.
 */
function streetfoxExpandFilename(template, ctx) {
  const now = new Date();
  const dateStr = streetfoxFormatDate(ctx.date) || streetfoxTodayStr();
  const vals = {
    panoid: ctx.panoId || "",
    date: dateStr,
    year: String((ctx.date && ctx.date.year) || now.getFullYear()),
    month: String((ctx.date && ctx.date.month) || now.getMonth() + 1).padStart(2, "0"),
    day: String((ctx.date && ctx.date.day) || now.getDate()).padStart(2, "0"),
    address: ctx.address || "",
    lat: Number.isFinite(ctx.lat) ? Number(ctx.lat).toFixed(5) : "",
    lng: Number.isFinite(ctx.lng) ? Number(ctx.lng).toFixed(5) : "",
    width: ctx.width ? String(ctx.width) : "",
    height: ctx.height ? String(ctx.height) : ""
  };
  let out = String(template || "");
  for (const [k, v] of Object.entries(vals)) out = out.split("{" + k + "}").join(v);
  out = out.replace(/\{[a-z]+\}/gi, ""); // unknown tokens
  const segs = out.split("/").map(streetfoxSanitizeSegment).filter((s) => s && s !== ".");
  if (segs.length) return segs.join("/");
  return "StreetView " + (ctx.panoId || "panorama") + " " + dateStr;
}

/* ------------------------------------------------------------------ */
/* Settings access (all extension contexts)                             */
/* ------------------------------------------------------------------ */

async function streetfoxLoadSettings() {
  const stored = await browser.storage.local.get(STREETFOX_STORAGE_KEY);
  return Object.assign({}, STREETFOX_DEFAULTS, (stored && stored[STREETFOX_STORAGE_KEY]) || {});
}

function streetfoxSaveSettings(settings) {
  return browser.storage.local.set({ [STREETFOX_STORAGE_KEY]: settings });
}

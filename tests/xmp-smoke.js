/*
 * StreetFox XMP injector smoke test (plain Node, no dependencies).
 *
 * Run from the repo root:  node tests/xmp-smoke.js
 *
 * Builds minimal fake JPEG/PNG containers, injects a GPano packet and
 * verifies the byte layouts documented in shared/xmp.js.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "shared", "xmp.js"), "utf8");
const StreetFoxXmp = new Function(src + "\n; return StreetFoxXmp;")();

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("  ok  " + name);
  } else {
    failures++;
    console.error("FAIL  " + name + (detail ? " — " + detail : ""));
  }
}

const dec = (u8, start, len) => new TextDecoder().decode(u8.subarray(start, start + len));

/* ------------------------------------------------------------------ */
/* JPEG                                                               */
/* ------------------------------------------------------------------ */

// SOI + APP0(JFIF) + APP1(Exif-ish, to prove we insert before it) + SOS + junk
const jfif = [
  0xff, 0xd8, // SOI
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66, // fake APP1, 6-byte segment
  0xff, 0xda, 0x00, 0x02, 0x99, 0x99 // SOS + payload
];
const jpeg = new Uint8Array(jfif);
const packet = StreetFoxXmp.buildGpanoPacket({
  width: 4096,
  height: 2048,
  heading: 123.4,
  date: { year: 2026, month: 8, day: 30 },
  description: 'Street View pano 2_abc · <&"quoted">',
  software: "StreetFox 1.0.0"
});

const jout = StreetFoxXmp.injectJpeg(jpeg, packet);

{
  check("jpeg: SOI intact", jout[0] === 0xff && jout[1] === 0xd8);
  check("jpeg: APP0 still first after SOI", jout[2] === 0xff && jout[3] === 0xe0);
  check("jpeg: XMP APP1 follows APP0", jout[20] === 0xff && jout[21] === 0xe1);
  const segLen = (jout[22] << 8) | jout[23];
  const packetBytes = new TextEncoder().encode(packet);
  check("jpeg: APP1 length = 2 + 29 + packetLen", segLen === 2 + 29 + packetBytes.length, "got " + segLen + " want " + (2 + 29 + packetBytes.length));
  check("jpeg: XMP namespace signature", dec(jout, 24, 28) === "http://ns.adobe.com/xap/1.0/" && jout[24 + 28] === 0);
  const embedded = dec(jout, 24 + 29, packetBytes.length);
  check("jpeg: packet bytes intact", embedded === packet);
  check("jpeg: packet contains GPano dims", embedded.includes("<GPano:FullPanoWidthPixels>4096<") && embedded.includes("<GPano:FullPanoHeightPixels>2048<"));
  check("jpeg: no-crop invariant", embedded.includes("<GPano:CroppedAreaLeftPixels>0<") && embedded.includes("<GPano:CroppedAreaImageWidthPixels>4096<"));
  check("jpeg: heading + date", embedded.includes("123.4") && embedded.includes("2026-08-30"));
  check("jpeg: xml escaping", embedded.includes("&lt;&amp;&quot;quoted&quot;&gt;"));
  check("jpeg: rest of file preserved", jout.length === jpeg.length + 4 + 29 + packetBytes.length && jout[jout.length - 1] === 0x99 && jout[jout.length - 2] === 0x99);
}

/* ------------------------------------------------------------------ */
/* PNG                                                                */
/* ------------------------------------------------------------------ */

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  out[0] = (data.length >>> 24) & 0xff;
  out[1] = (data.length >>> 16) & 0xff;
  out[2] = (data.length >>> 8) & 0xff;
  out[3] = data.length & 0xff;
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  const crc = StreetFoxXmp.crc32(out.subarray(4, 8 + data.length));
  out[8 + data.length] = (crc >>> 24) & 0xff;
  out[9 + data.length] = (crc >>> 16) & 0xff;
  out[10 + data.length] = (crc >>> 8) & 0xff;
  out[11 + data.length] = crc & 0xff;
  return out;
}

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const pngSig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = chunk("IHDR", new Uint8Array(13));
const idat = chunk("IDAT", new Uint8Array([1, 2, 3, 4]));
const iend = chunk("IEND", new Uint8Array(0));
const png = concat(pngSig, ihdr, idat, iend);

const pout = StreetFoxXmp.injectPng(png, packet);

{
  check("png: signature intact", pout.subarray(0, 8).every((v, i) => v === pngSig[i]));
  check("png: IHDR still first chunk", dec(pout, 12, 4) === "IHDR");
  const iTXtAt = 8 + 12 + 13;
  check("png: iTXt inserted after IHDR", dec(pout, iTXtAt + 4, 4) === "iTXt");
  const dataLen = (pout[iTXtAt] << 24) | (pout[iTXtAt + 1] << 16) | (pout[iTXtAt + 2] << 8) | pout[iTXtAt + 3];
  const packetBytes = new TextEncoder().encode(packet);
  check("png: chunk length = 22 + packetLen", dataLen === 22 + packetBytes.length, "got " + dataLen + " want " + (22 + packetBytes.length));
  const kwStart = iTXtAt + 8;
  const kwEnd = kwStart + 18;
  check("png: keyword XML:com.adobe.xmp\\0", dec(pout, kwStart, 17) === "XML:com.adobe.xmp" && pout[kwEnd - 1] === 0);
  check("png: uncompressed flags + empty tags", pout[kwEnd] === 0 && pout[kwEnd + 1] === 0 && pout[kwEnd + 2] === 0 && pout[kwEnd + 3] === 0);
  const textAt = kwEnd + 4;
  check("png: packet bytes intact", dec(pout, textAt, packetBytes.length) === packet);
  const storedCrc =
    ((pout[iTXtAt + 8 + dataLen] << 24) | (pout[iTXtAt + 9 + dataLen] << 16) | (pout[iTXtAt + 10 + dataLen] << 8) | pout[iTXtAt + 11 + dataLen]) >>> 0;
  const wantCrc = StreetFoxXmp.crc32(pout.subarray(iTXtAt + 4, iTXtAt + 8 + dataLen));
  check("png: CRC-32 over type+data matches", storedCrc === wantCrc, "got " + storedCrc.toString(16) + " want " + wantCrc.toString(16));
  const tail = pout.subarray(iTXtAt + 12 + dataLen);
  check("png: remaining chunks preserved", dec(tail, 4, 4) === "IDAT" && tail.length === idat.length + iend.length);
}

/* ------------------------------------------------------------------ */

console.log(failures ? "\n" + failures + " check(s) FAILED" : "\nAll checks passed.");
process.exit(failures ? 1 : 0);

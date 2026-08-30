"use strict";

/*
 * StreetFox — GPano XMP construction and byte-level embedding.
 *
 * JPEG: XMP goes into an APP1 segment — FF E1, uint16 BE length (counts
 * itself, excludes the marker), the 29-byte signature
 * "http://ns.adobe.com/xap/1.0/\0", then the UTF-8 packet. Inserted after
 * SOI/APP0, before anything else. (Adobe XMP Spec Part 3 §1.1.3.)
 *
 * PNG: XMP goes into an iTXt chunk with keyword "XML:com.adobe.xmp",
 * uncompressed, inserted right after IHDR. CRC-32 (poly 0xEDB88320) is
 * computed over chunk type + data only. (W3C PNG §11.3.4.)
 */

const StreetFoxXmp = (() => {
  const XMP_NS = "http://ns.adobe.com/xap/1.0/\0"; // 28 chars + NUL = 29 bytes

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function xmlEscape(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function isoDate(d) {
    if (!d || !d.year) return null;
    const mm = String(d.month || 1).padStart(2, "0");
    const dd = String(d.day || 1).padStart(2, "0");
    return d.year + "-" + mm + "-" + dd;
  }

  /**
   * Build a GPano XMP packet for a FULL 360° equirectangular image
   * (cropped area == full pano, no offset). Recognized by Google Photos,
   * Facebook 360, Pannellum, Photo Sphere Viewer, Kuula, etc.
   */
  function buildGpanoPacket({ width, height, heading, date, description, software }) {
    const L = [];
    L.push('<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>');
    L.push('<x:xmpmeta xmlns:x="adobe:ns:meta/"');
    L.push('            xmlns:GPano="http://ns.google.com/photos/1.0/panorama/"');
    L.push('            xmlns:dc="http://purl.org/dc/elements/1.1/">');
    L.push('  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">');
    L.push('    <rdf:Description rdf:about="">');
    L.push("      <GPano:ProjectionType>equirectangular</GPano:ProjectionType>");
    L.push("      <GPano:UsePanoramaViewer>True</GPano:UsePanoramaViewer>");
    L.push("      <GPano:CaptureSoftware>Google Street View</GPano:CaptureSoftware>");
    L.push("      <GPano:StitchingSoftware>" + xmlEscape(software || "StreetFox") + "</GPano:StitchingSoftware>");
    if (Number.isFinite(heading)) {
      L.push("      <GPano:PoseHeadingDegrees>" + Number(heading).toFixed(1) + "</GPano:PoseHeadingDegrees>");
    }
    const d = isoDate(date);
    if (d) {
      L.push("      <GPano:FirstPhotoDate>" + d + "</GPano:FirstPhotoDate>");
      L.push("      <GPano:LastPhotoDate>" + d + "</GPano:LastPhotoDate>");
    }
    L.push("      <GPano:CroppedAreaLeftPixels>0</GPano:CroppedAreaLeftPixels>");
    L.push("      <GPano:CroppedAreaTopPixels>0</GPano:CroppedAreaTopPixels>");
    L.push("      <GPano:CroppedAreaImageWidthPixels>" + width + "</GPano:CroppedAreaImageWidthPixels>");
    L.push("      <GPano:CroppedAreaImageHeightPixels>" + height + "</GPano:CroppedAreaImageHeightPixels>");
    L.push("      <GPano:FullPanoWidthPixels>" + width + "</GPano:FullPanoWidthPixels>");
    L.push("      <GPano:FullPanoHeightPixels>" + height + "</GPano:FullPanoHeightPixels>");
    if (description) {
      L.push(
        "      <dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">" +
          xmlEscape(description) +
          "</rdf:li></rdf:Alt></dc:description>"
      );
    }
    L.push("    </rdf:Description>");
    L.push("  </rdf:RDF>");
    L.push("</x:xmpmeta>");
    L.push('<?xpacket end="w"?>');
    return L.join("\n");
  }

  function readU16BE(b, i) {
    return (b[i] << 8) | b[i + 1];
  }

  function writeU32BE(b, i, v) {
    b[i] = (v >>> 24) & 0xff;
    b[i + 1] = (v >>> 16) & 0xff;
    b[i + 2] = (v >>> 8) & 0xff;
    b[i + 3] = v & 0xff;
  }

  /** Splice an XMP APP1 segment into a JPEG right after SOI (+APP0 if present). */
  function injectJpeg(jpeg, xmp) {
    if (!(jpeg instanceof Uint8Array) || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
      throw new Error("not a JPEG");
    }
    const enc = new TextEncoder();
    const ns = enc.encode(XMP_NS);
    const packet = enc.encode(xmp);
    const segLen = 2 + ns.length + packet.length; // length field counts itself
    if (segLen > 0xffff) throw new Error("XMP packet too large for one APP1 segment");

    const seg = new Uint8Array(2 + segLen); // marker + segment
    seg[0] = 0xff;
    seg[1] = 0xe1;
    seg[2] = (segLen >> 8) & 0xff;
    seg[3] = segLen & 0xff;
    seg.set(ns, 4);
    seg.set(packet, 4 + ns.length);

    // skip APP0 (JFIF) if present so we land in canonical SOI|APP0|XMP order
    let pos = 2;
    if (jpeg[2] === 0xff && jpeg[3] === 0xe0) pos = 4 + readU16BE(jpeg, 4);

    const out = new Uint8Array(jpeg.length + seg.length);
    out.set(jpeg.subarray(0, pos), 0);
    out.set(seg, pos);
    out.set(jpeg.subarray(pos), pos + seg.length);
    return out;
  }

  /** Splice an XMP iTXt chunk into a PNG right after IHDR. */
  function injectPng(png, xmp) {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (!(png instanceof Uint8Array) || png.length < 33 || !sig.every((v, i) => png[i] === v)) {
      throw new Error("not a PNG");
    }
    const enc = new TextEncoder();
    const packet = enc.encode(xmp);
    const keyword = enc.encode("XML:com.adobe.xmp\0"); // keyword + NUL
    const dataLen = keyword.length + 4 + packet.length; // + comp flag/method, empty lang tag, empty translated kw

    const chunk = new Uint8Array(12 + dataLen); // len + type + data + crc
    writeU32BE(chunk, 0, dataLen);
    chunk.set(enc.encode("iTXt"), 4);
    let o = 8;
    chunk.set(keyword, o);
    o += keyword.length;
    chunk[o++] = 0; // compression flag: uncompressed
    chunk[o++] = 0; // compression method: n/a
    chunk[o++] = 0; // language tag: empty
    chunk[o++] = 0; // translated keyword: empty
    chunk.set(packet, o);
    writeU32BE(chunk, 8 + dataLen, crc32(chunk.subarray(4, 8 + dataLen)));

    // insert after the first chunk (IHDR): 8 sig + 4 len + 4 type + len + 4 crc
    const firstLen = (png[8] << 24) | (png[9] << 16) | (png[10] << 8) | png[11];
    const pos = 8 + 12 + firstLen;

    const out = new Uint8Array(png.length + chunk.length);
    out.set(png.subarray(0, pos), 0);
    out.set(chunk, pos);
    out.set(png.subarray(pos), pos + chunk.length);
    return out;
  }

  return { crc32, buildGpanoPacket, injectJpeg, injectPng };
})();

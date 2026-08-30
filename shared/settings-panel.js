"use strict";

/*
 * StreetFox — shared settings UI.
 *
 * StreetFoxSettings.render(container) builds the whole settings form into any
 * container. Used by the in-page settings panel (content script) and the
 * options page. Changes save to storage.local (debounced 250 ms) and every
 * open instance stays in sync via storage.onChanged.
 */

const StreetFoxSettings = {
  TOKENS: ["panoid", "date", "year", "month", "day", "address", "lat", "lng", "width", "height"],

  SAMPLE_CTX: {
    panoId: "2_c8kTBThxxl9NNesQGhBA",
    date: { year: 2026, month: 8, day: 30 },
    address: "Example Street 12, Springfield",
    lat: 41.40923,
    lng: -8.61234,
    width: 4096,
    height: 2048
  },

  async render(container) {
    container.textContent = "";
    const root = document.createElement("div");
    root.className = "streetfox-settings";
    container.appendChild(root);

    const settings = await streetfoxLoadSettings();
    const controls = {}; // setting key -> sync(value) for cross-instance sync
    let saveTimer = 0;
    let savedEl = null;

    const save = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          await streetfoxSaveSettings(settings);
          if (savedEl) {
            savedEl.classList.add("sf-show");
            setTimeout(() => savedEl && savedEl.classList.remove("sf-show"), 1100);
          }
        } catch (e) {
          /* storage unavailable — nothing sensible to do */
        }
      }, 250);
    };

    const row = () => {
      const d = document.createElement("div");
      d.className = "sf-row";
      root.appendChild(d);
      return d;
    };
    const labelEl = (text) => {
      const l = document.createElement("div");
      l.className = "sf-label";
      l.textContent = text;
      return l;
    };
    const hintEl = (text) => {
      const h = document.createElement("div");
      h.className = "sf-hint";
      h.textContent = text;
      return h;
    };

    /* --- resolution ------------------------------------------------- */
    {
      const r = row();
      r.appendChild(labelEl("Resolution"));
      const sel = document.createElement("select");
      for (const [v, t] of [
        ["auto", "Maximum available (slowest, biggest)"],
        ["z2", "Standard · ~2K (2048 px)"],
        ["z3", "High · ~4K (4096 px) — recommended"],
        ["z4", "Very high · ~8K (8192 px)"],
        ["z5", "Maximum · ~16K (16384 px, experimental)"]
      ]) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = t;
        sel.appendChild(o);
      }
      sel.value = settings.resolution;
      sel.addEventListener("change", () => {
        settings.resolution = sel.value;
        save();
      });
      r.appendChild(sel);
      r.appendChild(
        hintEl(
          "Actual size depends on the panorama — older ones are smaller " +
            "(e.g. 3328 px at “High”). If this machine can’t handle the chosen " +
            "size, StreetFox automatically steps down."
        )
      );
      controls.resolution = { sync: (v) => (sel.value = v) };
    }

    /* --- format + jpeg quality -------------------------------------- */
    {
      const r = row();
      r.appendChild(labelEl("Image format"));
      const seg = document.createElement("div");
      seg.className = "sf-seg";
      const mk = (val, text) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.addEventListener("click", () => {
          settings.format = val;
          sync();
          save();
        });
        seg.appendChild(b);
        return b;
      };
      const bJpg = mk("jpeg", "JPEG");
      const bPng = mk("png", "PNG (lossless)");

      const qr = row();
      const lq = labelEl("JPEG quality ");
      const valSpan = document.createElement("span");
      valSpan.className = "sf-quality-val";
      lq.appendChild(valSpan);
      qr.appendChild(lq);
      const range = document.createElement("input");
      range.type = "range";
      range.min = "60";
      range.max = "100";
      range.step = "1";
      range.value = settings.jpegQuality;
      valSpan.textContent = String(settings.jpegQuality);
      range.addEventListener("input", () => {
        settings.jpegQuality = Number(range.value);
        valSpan.textContent = range.value;
        save();
      });
      qr.appendChild(range);
      qr.appendChild(hintEl("90 is a good default — the source tiles are already JPEG; higher values mostly inflate file size."));

      const sync = () => {
        const png = settings.format === "png";
        bJpg.classList.toggle("sf-on", !png);
        bPng.classList.toggle("sf-on", png);
        qr.style.display = png ? "none" : "";
      };
      r.appendChild(seg);
      r.appendChild(
        hintEl("JPEG with 360° metadata is recognized by Google Photos, Facebook and most 360° viewers. PNG is lossless but much larger.")
      );
      controls.format = {
        sync: (v) => {
          settings.format = v === "png" ? "png" : "jpeg";
          sync();
        }
      };
      controls.jpegQuality = {
        sync: (v) => {
          range.value = v;
          valSpan.textContent = String(v);
        }
      };
      sync();
    }

    /* --- 360 metadata ------------------------------------------------ */
    {
      const r = row();
      const lab = document.createElement("label");
      lab.className = "sf-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = settings.embedXmp;
      cb.addEventListener("change", () => {
        settings.embedXmp = cb.checked;
        save();
      });
      const txt = document.createElement("span");
      const b = document.createElement("b");
      b.textContent = "Embed 360° metadata";
      txt.append(b, document.createElement("br"), document.createTextNode("Writes GPano XMP so viewers show the file as an interactive 360° photo instead of a flat strip."));
      lab.append(cb, txt);
      r.appendChild(lab);
      controls.embedXmp = { sync: (v) => (cb.checked = !!v) };
    }

    /* --- filename ----------------------------------------------------- */
    {
      const r = row();
      const l = labelEl("File name");
      savedEl = document.createElement("span");
      savedEl.className = "sf-saved";
      savedEl.textContent = "saved";
      l.appendChild(savedEl);
      r.appendChild(l);

      const inp = document.createElement("input");
      inp.type = "text";
      inp.spellcheck = false;
      inp.value = settings.filenameTemplate;
      const preview = document.createElement("div");
      preview.className = "sf-preview";
      const updatePreview = () => {
        preview.textContent = streetfoxExpandFilename(inp.value, StreetFoxSettings.SAMPLE_CTX) + ".jpg";
      };
      inp.addEventListener("input", () => {
        settings.filenameTemplate = inp.value;
        updatePreview();
        save();
      });
      r.appendChild(inp);

      const chips = document.createElement("div");
      chips.className = "sf-chips";
      for (const t of StreetFoxSettings.TOKENS) {
        const c = document.createElement("button");
        c.type = "button";
        c.className = "sf-chip";
        c.textContent = "{" + t + "}";
        c.title = "Insert {" + t + "}";
        c.addEventListener("click", () => {
          const start = inp.selectionStart === null ? inp.value.length : inp.selectionStart;
          const end = inp.selectionEnd === null ? start : inp.selectionEnd;
          inp.value = inp.value.slice(0, start) + "{" + t + "}" + inp.value.slice(end);
          inp.focus();
          const caret = start + t.length + 2;
          inp.setSelectionRange(caret, caret);
          settings.filenameTemplate = inp.value;
          updatePreview();
          save();
        });
        chips.appendChild(c);
      }
      r.appendChild(chips);
      r.appendChild(preview);
      updatePreview();
      controls.filenameTemplate = {
        sync: (v) => {
          inp.value = v;
          updatePreview();
        }
      };
    }

    /* --- save-as dialog ---------------------------------------------- */
    {
      const r = row();
      const lab = document.createElement("label");
      lab.className = "sf-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = settings.saveAs;
      cb.addEventListener("change", () => {
        settings.saveAs = cb.checked;
        save();
      });
      const txt = document.createElement("span");
      txt.textContent = "Always ask where to save";
      lab.append(cb, txt);
      r.appendChild(lab);
      controls.saveAs = { sync: (v) => (cb.checked = !!v) };
    }

    /* --- keep other instances in sync -------------------------------- */
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[STREETFOX_STORAGE_KEY]) return;
      const incoming = changes[STREETFOX_STORAGE_KEY].newValue || {};
      for (const [key, value] of Object.entries(incoming)) {
        if (settings[key] === value) continue;
        settings[key] = value;
        if (controls[key]) controls[key].sync(value);
      }
    });
  }
};

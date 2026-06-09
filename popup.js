/* Notion Turbo — popup controller (v1.0.3) */
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    mode: "soft",
    keepVisible: 30,
    intrinsicHeight: 140,
    containerSelector: "",
    debug: false,
    monitor: false,
    trim: false,
    keepRecords: 25,
  };

  // id -> { prop, cast? }
  const FIELDS = {
    enabled: { prop: "checked" },
    trim: { prop: "checked" },
    mode: { prop: "value" },
    keepVisible: { prop: "value", cast: Number },
    intrinsicHeight: { prop: "value", cast: Number },
    containerSelector: { prop: "value" },
    monitor: { prop: "checked" },
    debug: { prop: "checked" },
  };

  const $ = (id) => document.getElementById(id);

  // "Recent exchanges to keep" is a free-text field. Validate strictly: digits
  // only, whole number, clamped to [KEEP_MIN, KEEP_MAX]. Persisted separately
  // from the generic FIELDS save loop so a bad value is never written.
  const KEEP_MIN = 1;
  const KEEP_MAX = 100;
  let lastValidKeep = DEFAULTS.keepRecords;

  function setKeepError(msg) {
    const inp = $("keepRecords");
    if (inp) inp.classList.toggle("invalid", !!msg);
    const e = $("keepRecordsErr");
    if (!e) return;
    e.textContent = msg || "";
    e.style.display = msg ? "block" : "none";
  }

  function persistKeep(n) {
    lastValidKeep = n;
    chrome.storage.sync.set({ keepRecords: n }, flashSaved);
  }

  // Live validation while typing: reject anything that is not a whole number.
  function onKeepInput() {
    const inp = $("keepRecords");
    if (!inp) return;
    const raw = inp.value.trim();
    if (raw === "") { setKeepError(`Enter a whole number between ${KEEP_MIN} and ${KEEP_MAX}.`); return; }
    if (!/^\d+$/.test(raw)) {
      setKeepError("Whole numbers only — no letters, decimals, or symbols.");
      return;
    }
    const n = parseInt(raw, 10);
    if (n < KEEP_MIN || n > KEEP_MAX) {
      setKeepError(`Allowed range is ${KEEP_MIN}–${KEEP_MAX}; it will be adjusted when you finish.`);
      return;
    }
    setKeepError("");
    persistKeep(n);
  }

  // Commit on blur / Enter: strip stray characters, clamp, normalize, and save.
  function onKeepCommit() {
    const inp = $("keepRecords");
    if (!inp) return;
    const digits = (inp.value.match(/\d+/g) || []).join("");
    let n = parseInt(digits, 10);
    if (!Number.isFinite(n)) n = lastValidKeep;
    n = Math.min(KEEP_MAX, Math.max(KEEP_MIN, n));
    inp.value = String(n);
    setKeepError("");
    persistKeep(n);
  }

  function flashSaved() {
    const s = $("saved");
    if (!s) return;
    s.classList.add("show");
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(() => s.classList.remove("show"), 1100);
  }

  // Dim "keep recent rows" unless hard mode is selected.
  function reflectModeUI() {
    const row = $("keepRow");
    if (row) row.style.opacity = $("mode").value === "hard" ? "1" : "0.4";
  }

  // Dim + disable the keep-exchanges field unless trimming is on.
  function reflectTrimUI() {
    const on = $("trim").checked;
    const row = $("keepRecordsRow");
    const input = $("keepRecords");
    if (row) row.classList.toggle("dim", !on);
    if (input) input.disabled = !on;
  }

  function loadConfig() {
    chrome.storage.sync.get(DEFAULTS, (cfg) => {
      for (const id of Object.keys(FIELDS)) {
        const el = $(id);
        if (!el) continue;
        el[FIELDS[id].prop] = cfg[id];
      }
      let keep = parseInt(cfg.keepRecords, 10);
      if (!Number.isFinite(keep)) keep = DEFAULTS.keepRecords;
      keep = Math.min(KEEP_MAX, Math.max(KEEP_MIN, keep));
      lastValidKeep = keep;
      const keepEl = $("keepRecords");
      if (keepEl) keepEl.value = String(keep);
      reflectModeUI();
      reflectTrimUI();
      setKeepError("");
    });
  }

  function saveConfig() {
    const next = {};
    for (const id of Object.keys(FIELDS)) {
      const el = $(id);
      if (!el) continue;
      const f = FIELDS[id];
      let v = el[f.prop];
      if (f.cast) v = f.cast(v);
      next[id] = v;
    }
    chrome.storage.sync.set(next, flashSaved);
  }

  function renderStatus(status) {
    const dot = $("dot");
    const text = $("statusText");
    if (!status) {
      dot.className = "dot";
      text.textContent = "Open a Notion AI chat to activate.";
      return;
    }
    if (!status.enabled) {
      dot.className = "dot off";
      text.textContent = "Turned off.";
      return;
    }
    const stale = Date.now() - (status.ts || 0) > 12000;
    if (status.found) {
      dot.className = "dot on";
      const bits = [`Active · ${status.rows} messages`];
      if (status.trim) bits.push("trimming on");
      text.textContent = bits.join(" · ") + (stale ? " (idle)" : "");
    } else {
      dot.className = "dot";
      text.textContent = "Waiting for a long chat to load…";
    }
  }

  function loadStatus() {
    chrome.storage.local.get({ status: null }, (d) => renderStatus(d.status));
  }

  // Ask the page (via the content script) to download a diagnostic report.
  function requestDiagSave() {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || tab.id == null) return;
        chrome.tabs.sendMessage(tab.id, { type: "notionTurboDiagSave" }, () => void chrome.runtime.lastError);
      });
    } catch (_) {}
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("version").textContent = "v" + (chrome.runtime.getManifest().version || "");
    loadConfig();
    loadStatus();

    for (const id of Object.keys(FIELDS)) {
      const el = $(id);
      if (!el) continue;
      const evt = el.type === "text" || el.type === "number" || el.type === "range" ? "input" : "change";
      el.addEventListener(evt, () => {
        if (id === "mode") reflectModeUI();
        if (id === "trim") reflectTrimUI();
        saveConfig();
      });
    }

    // Validated integer field for "recent exchanges to keep".
    const keepEl = $("keepRecords");
    if (keepEl) {
      keepEl.addEventListener("input", onKeepInput);
      keepEl.addEventListener("change", onKeepCommit);
      keepEl.addEventListener("blur", onKeepCommit);
      keepEl.addEventListener("keydown", (ev) => { if (ev.key === "Enter") keepEl.blur(); });
    }

    const diagBtn = $("diagSave");
    if (diagBtn) diagBtn.addEventListener("click", requestDiagSave);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.status) renderStatus(changes.status.newValue);
    });
    setInterval(loadStatus, 2000);
  });
})();

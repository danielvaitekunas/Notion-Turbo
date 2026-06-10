/*
 * Notion Turbo — isolated-world CSS layer + config relay  (v1.0.4)
 * -----------------------------------------------------------------
 * Two responsibilities:
 *  1. CSS optimizer: marks the chat's message list so the browser can skip
 *     layout/paint for off-screen rows (content-visibility). React-safe — one
 *     data-attribute + a single <style> tag. When "recent exchanges only" is
 *     on, an exchange-aware render-prune also un-renders already-painted OLD
 *     exchanges (anchored on prompt rows, so a live answer is never clipped).
 *  2. Config relay: only this isolated world can read chrome.storage, so it
 *     forwards the trimmer settings to the MAIN-world network agent (page.js),
 *     and relays the popup's "download diagnostic report" click to it.
 *
 * PERFORMANCE (v1.0.3):
 *  - The MutationObserver is the primary trigger: it self-heals instantly when
 *    Notion swaps out the chat container, and early-returns in a single
 *    comparison while the container is stable.
 *  - The polling interval is only a slow safety net (8s), pauses entirely in
 *    background tabs, and does near-zero work when everything is attached.
 *  - Self-timing (performance.now) only runs when a diagnostic toggle is on.
 *
 * v1.0.2:
 *  - Chat-aware container detection (scores candidates by prompt-row count) so
 *    the render-prune can no longer lock onto the wrong scroller and silently
 *    no-op — the #1 reason old exchanges weren't un-rendering.
 *  - Periodically re-scans for a better container (chat panel that loads late /
 *    thread switches); leading+trailing prune recompute so the final state is
 *    never stale; re-asserts our marker each cycle (React can rewrite the row
 *    list); coalesces mutation bursts into one requestAnimationFrame.
 *  - Detection no longer requires a scrollbar: includes Notion's .notion-scroller
 *    region even when content currently fits (short/trimmed chats), plus a
 *    structural fallback that finds the chat row-list directly from its
 *    prompt-row shape. Fixes chats where the extension found no container at all.
 */
(() => {
  "use strict";

  if (window.top !== window.self) return;

  const VERSION = "1.0.4";

  const DEFAULTS = {
    enabled: true,
    mode: "soft",
    keepVisible: 30,
    intrinsicHeight: 140,
    containerSelector: "",
    debug: false,
    monitor: false,
    trim: true, // forwarded to the MAIN-world network agent (page.js)
    keepRecords: 10, // how many recent exchanges to keep when trimming
  };

  const MARK = "data-notion-turbo";
  const STYLE_ID = "notion-turbo-style";
  const HUD_ID = "notion-turbo-hud";
  const DETECT_DEBOUNCE = 150;
  const SAFETY_MS = 8000; // slow safety-net poll
  const DIAG_THROTTLE = 3000;
  const PRUNE_THROTTLE = 700; // min gap between live render-prune recomputes
  const RESCAN_THROTTLE = 4000; // min gap between "is there a better container?" checks
  const LONG_TASK_MS = 200;
  const SELF_WARN_MS = 12;
  const DESCEND_GUARD = 16;

  let config = { ...DEFAULTS };
  let container = null;
  let lastCss = null;
  let lastStatus = null;
  let warned = false;

  let observer = null;
  let pendingScan = false;
  let detectPending = false;
  let lastDiag = 0;
  let lastPrune = 0;
  let lastRescan = 0;
  let pruneTrailer = null;
  let rafPending = false;

  let perfObs = null;
  let selfStart = 0;
  let selfEnd = 0;
  let selfMax = 0;
  let lastDomRelay = 0;

  const log = (...a) => {
    if (config.debug) console.log("[NotionTurbo]", ...a);
  };

  const idle = (fn) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 500 });
    else setTimeout(fn, 16);
  };

  // Forward the trimmer config to the MAIN-world agent (page.js).
  function relayConfig() {
    try {
      window.dispatchEvent(
        new CustomEvent("notion-turbo-config", {
          detail: {
            trim: !!config.trim,
            keepRecords: Number(config.keepRecords) || 10,
            debug: !!config.debug,
          },
        }),
      );
    } catch (_) {}
  }

  // Runs fn. Only pays for performance timing when a diagnostic toggle is on
  // (the monitor needs selfStart/selfEnd to attribute long tasks).
  function measure(fn) {
    if (!(config.monitor || config.debug)) {
      fn();
      return;
    }
    const s = performance.now();
    try {
      fn();
    } finally {
      const e = performance.now();
      selfStart = s;
      selfEnd = e;
      const d = e - s;
      if (d > selfMax) selfMax = d;
      if (d > SELF_WARN_MS) {
        // console.log (not warn) so it never surfaces on the extension Errors page.
        console.log(`[NotionTurbo][monitor] own work ${d.toFixed(1)}ms this cycle`);
      }
    }
  }

  function styleTag() {
    let t = document.getElementById(STYLE_ID);
    if (!t) {
      t = document.createElement("style");
      t.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(t);
    }
    return t;
  }

  function setCss(css) {
    if (css === lastCss) return;
    lastCss = css;
    styleTag().textContent = css;
  }

  // Identify a user-prompt row (an exchange boundary) in the rendered chat.
  // Notion ships no ids/data-* on chat rows — only obfuscated atomic classes —
  // so we key off the stable structural shape seen in the DOM capture:
  //   • prompt row:    exactly ONE child, inner wrapper uses "gap: 8px"
  //   • assistant turn: TWO children, row itself is "flex-direction: column"
  //   • date separator: single centered child
  // If Notion ever changes this shape, isPromptRow simply stops matching and the
  // prune degrades to a no-op — it never guesses, so it can never clip a live turn.
  function isPromptRow(el) {
    if (el.childElementCount !== 1) return false;
    const own = (el.getAttribute && el.getAttribute("style")) || "";
    if (own.indexOf("center") !== -1) return false; // date separator
    const fc = el.firstElementChild;
    const fcs = fc ? (fc.getAttribute("style") || "") : "";
    return fcs.indexOf("gap: 8px") !== -1;
  }

  // How many leading rows to visually drop so only the last N whole exchanges
  // remain painted. Anchored on prompt rows => never splits an exchange, and the
  // newest exchange (plus any in-progress streaming answer) is always kept.
  // Returns 0 (no-op) unless there are strictly more exchanges than the window.
  function computeHideCount() {
    if (!config.trim || !container) return 0;
    const keep = Math.max(1, Number(config.keepRecords) || 10);
    const rows = container.children;
    const total = rows.length;
    const prompts = [];
    for (let i = 0; i < total; i++) if (isPromptRow(rows[i])) prompts.push(i);
    if (prompts.length <= keep) return 0; // nothing older than the window
    const firstKeep = prompts[prompts.length - keep];
    return Math.max(0, Math.min(firstKeep, total - 1));
  }

  function buildCss() {
    if (!config.enabled || !container) return "";
    const h = Math.max(20, Number(config.intrinsicHeight) || 140);
    const keep = Math.max(1, Number(config.keepVisible) || 30);
    let css =
      `[${MARK}="1"] > * {` +
      `content-visibility:auto;` +
      `contain-intrinsic-size:auto ${h}px;` +
      `}`;
    if (config.mode === "hard") {
      css += `[${MARK}="1"] > *:nth-last-child(n + ${keep + 1}){display:none !important;}`;
    }
    // Exchange-aware render-prune: un-render already-painted OLD exchanges so a
    // long chat that grew mid-session gets light again without a reload.
    if (config.trim) {
      const hide = computeHideCount();
      if (hide > 0) {
        css += `[${MARK}="1"] > *:nth-child(-n + ${hide}){display:none !important;}`;
      }
    }
    return css;
  }

  function isScrollable(el) {
    // Cheap geometry checks first; only pay for getComputedStyle on elements
    // that are actually tall enough to scroll. Big win when scanning the DOM.
    if (el.clientHeight <= 120 || el.scrollHeight <= el.clientHeight + 40) return false;
    const oy = getComputedStyle(el).overflowY;
    return oy === "auto" || oy === "scroll" || oy === "overlay";
  }

  function rowListFrom(scroller) {
    let el = scroller;
    let best = scroller;
    let bestCount = scroller.childElementCount;
    let guard = 0;
    while (el && guard < DESCEND_GUARD) {
      if (el.childElementCount > bestCount) {
        best = el;
        bestCount = el.childElementCount;
      }
      let next = null;
      let nextCount = 0;
      for (const c of el.children) {
        if (c.childElementCount > nextCount) {
          next = c;
          nextCount = c.childElementCount;
        }
      }
      if (!next || nextCount === 0) break;
      el = next;
      guard++;
    }
    return best || scroller;
  }

  function collectScrollers() {
    const list = [];
    const seen = new Set();
    // .notion-scroller is Notion's purpose-built scroll region. Include it even
    // when the content currently fits without a scrollbar — a short or freshly
    // trimmed chat (e.g. 11 exchanges) often isn't tall enough to scroll yet,
    // but the row list still lives inside it. Gating on isScrollable() here was
    // why the extension silently did nothing on shorter chats.
    for (const el of document.querySelectorAll(".notion-scroller")) {
      if (!seen.has(el)) { seen.add(el); list.push(el); }
    }
    // Add genuinely-scrollable generic containers as a fallback for layouts
    // that don't use the .notion-scroller class.
    for (const el of document.querySelectorAll("div,main,section,ul")) {
      if (!seen.has(el) && isScrollable(el)) { seen.add(el); list.push(el); }
    }
    return list;
  }

  function logDiagnostics() {
    const now = Date.now();
    if (now - lastDiag < DIAG_THROTTLE) return;
    lastDiag = now;
    const ranked = [];
    for (const el of document.querySelectorAll("div,main,section,ul")) {
      const sh = el.scrollHeight;
      if (sh < 600) continue;
      const s = getComputedStyle(el);
      ranked.push({
        el,
        scrollHeight: sh,
        clientHeight: el.clientHeight,
        overflowY: s.overflowY,
        children: el.childElementCount,
        className: typeof el.className === "string" ? el.className : "",
      });
    }
    ranked.sort((a, b) => b.scrollHeight - a.scrollHeight);
    console.groupCollapsed(`[NotionTurbo] DIAGNOSTIC — ${ranked.length} tall elements (top 12)`);
    ranked.slice(0, 12).forEach((c) =>
      console.log(
        `scrollH=${c.scrollHeight} clientH=${c.clientHeight} overflowY=${c.overflowY} children=${c.children} class="${c.className}"`,
        c.el,
      ),
    );
    console.groupEnd();
  }

  // Count direct children that look like user-prompt rows. Cheap structural
  // check; used both to recognise the chat and to drive the render-prune.
  function countPromptRows(el) {
    if (!el) return 0;
    const kids = el.children;
    let n = 0;
    for (let i = 0; i < kids.length; i++) if (isPromptRow(kids[i])) n++;
    return n;
  }

  // Structural fallback: find the chat row-list directly from its content, with
  // no dependence on scrollability or Notion class names. User-prompt rows wrap
  // their text in a "gap: 8px" flex box, so we locate those wrappers, climb to
  // the prompt row, and tally the row's parent. The element that parents the
  // most prompt rows IS the chat row-list. This rescues detection on chats
  // where no scroll container is recognised.
  function structuralChatContainer() {
    let wraps;
    try {
      wraps = document.querySelectorAll('[style*="gap: 8px"]');
    } catch (e) {
      return null;
    }
    const tally = new Map();
    let best = null;
    let bestN = 0;
    for (const w of wraps) {
      const row = w.parentElement;
      if (!row || !isPromptRow(row)) continue;
      const list = row.parentElement;
      if (!list) continue;
      const n = (tally.get(list) || 0) + 1;
      tally.set(list, n);
      if (n > bestN) { best = list; bestN = n; }
    }
    return best;
  }

  function detectContainer() {
    if (config.containerSelector) {
      const el = document.querySelector(config.containerSelector);
      if (el) return rowListFrom(el);
      log("containerSelector matched nothing:", config.containerSelector);
    }
    const scrollers = collectScrollers();
    // Chat-aware scoring: the AI chat usually lives in a side panel, and the
    // main page behind it can have MORE child blocks — so picking purely by
    // child count can lock onto the wrong element. When that happens the
    // render-prune finds no prompt rows and never hides anything. Prefer the
    // row-list that actually contains user-prompt rows; only fall back to raw
    // child count when nothing looks like a chat yet (e.g. still loading).
    let best = null;
    let bestPrompts = -1;
    let bestRows = -1;
    let bestHeight = -1;
    for (const s of scrollers) {
      const rl = rowListFrom(s);
      const prompts = countPromptRows(rl);
      const rows = rl.childElementCount;
      const sh = s.scrollHeight;
      if (
        prompts > bestPrompts ||
        (prompts === bestPrompts && rows > bestRows) ||
        (prompts === bestPrompts && rows === bestRows && sh > bestHeight)
      ) {
        best = rl;
        bestPrompts = prompts;
        bestRows = rows;
        bestHeight = sh;
      }
    }
    // Structural rescue: if the scroller scan found no prompt rows (short chat,
    // unrecognised scroll container, or nothing scrollable yet), locate the
    // chat row-list directly from its prompt-row structure and adopt it when it
    // has more prompt rows than the scroller-based pick.
    if (bestPrompts <= 0) {
      const structural = structuralChatContainer();
      const structuralPrompts = countPromptRows(structural);
      if (structuralPrompts > bestPrompts) {
        best = structural;
        bestPrompts = structuralPrompts;
        if (config.debug) log(`structural fallback chosen, prompts=${structuralPrompts}`, best);
      }
    }
    if (!best) {
      if (config.debug) logDiagnostics();
      return null;
    }
    if (config.debug) log(`scrollers=${scrollers.length}, chosen prompts=${bestPrompts} rows=${bestRows}`, best);
    return best;
  }

  function writeStatus(found, rows) {
    const status = {
      v: VERSION,
      host: location.host,
      enabled: config.enabled,
      mode: config.mode,
      trim: config.trim,
      found,
      rows,
      selfMax: Math.round(selfMax),
      ts: Date.now(),
    };
    const json = JSON.stringify({ ...status, ts: 0 });
    if (json === lastStatus) return;
    lastStatus = json;
    try { chrome.storage?.local.set({ status }); } catch (_) {}
  }

  function hud() {
    let el = document.getElementById(HUD_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = HUD_ID;
      el.style.cssText = [
        "position:fixed", "bottom:12px", "right:12px", "z-index:2147483647",
        "font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif",
        "background:rgba(11,107,203,0.95)", "color:#fff", "padding:8px 10px",
        "border-radius:8px", "box-shadow:0 2px 10px rgba(0,0,0,0.3)",
        "max-width:280px", "pointer-events:none", "white-space:pre",
      ].join(";");
      document.documentElement.appendChild(el);
    }
    return el;
  }

  function updateHud(found, rows) {
    if (!config.debug) {
      const el = document.getElementById(HUD_ID);
      if (el) el.remove();
      return;
    }
    hud().textContent =
      `Notion Turbo v${VERSION}\n` +
      `host: ${location.host}\n` +
      `enabled: ${config.enabled}  mode: ${config.mode}\n` +
      `trim: ${config.trim ? "on" : "off"}\n` +
      `container: ${found ? "FOUND" : "not found"}\n` +
      `message rows: ${rows}\n` +
      `prompt rows: ${found && container ? countPromptRows(container) : 0}\n` +
      `un-rendered: ${found ? computeHideCount() : 0}\n` +
      `our max cycle: ${selfMax.toFixed(1)}ms`;
  }

  function startMonitor() {
    if (perfObs || typeof PerformanceObserver === "undefined") return;
    try {
      perfObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.duration < LONG_TASK_MS) continue;
          const overlap = selfEnd >= e.startTime && selfStart <= e.startTime + e.duration;
          console.log(
            `[NotionTurbo][monitor] long task ${Math.round(e.duration)}ms — ` +
              (overlap ? "NotionTurbo code ran during this task" : "Notion/other (not NotionTurbo)"),
          );
        }
      });
      perfObs.observe({ entryTypes: ["longtask"] });
      console.log(`[NotionTurbo][monitor] enabled (longtask threshold ${LONG_TASK_MS}ms)`);
    } catch (_) {}
  }

  function stopMonitor() {
    if (perfObs) {
      try { perfObs.disconnect(); } catch (_) {}
      perfObs = null;
    }
  }

  // The observer stays armed for the page's lifetime. While the container is
  // attached this callback costs a single isConnected check; when Notion swaps
  // the chat out, it re-detects after a short debounce.
  // Recompute the live render-prune when rows are added/removed (a new prompt or
  // a finished turn). Throttled and cheap: setCss is a no-op when the boundary is
  // unchanged, so steady streaming costs ~one timestamp compare per mutation.
  // Re-assert our marker (React can replace/clear the row-list element) and
  // recompute the stylesheet. Kept tiny so it is cheap to call often.
  function doPrune() {
    if (!config.enabled || !config.trim) return;
    if (!container || !container.isConnected) return;
    if (container.getAttribute(MARK) !== "1") {
      try { container.setAttribute(MARK, "1"); } catch (_) {}
    }
    measure(() => setCss(buildCss()));
  }

  // Leading + trailing throttle: the leading call keeps the window sliding
  // promptly as you chat; the trailing call guarantees the FINAL state is never
  // stale if the decisive mutation (a new prompt) lands mid-throttle and the
  // DOM then goes quiet.
  function maybePrune() {
    if (!config.enabled || !config.trim) return;
    if (!container || !container.isConnected) return;
    const now = Date.now();
    if (now - lastPrune >= PRUNE_THROTTLE) {
      lastPrune = now;
      doPrune();
    }
    if (pruneTrailer) clearTimeout(pruneTrailer);
    pruneTrailer = setTimeout(() => {
      pruneTrailer = null;
      lastPrune = Date.now();
      doPrune();
    }, PRUNE_THROTTLE);
  }

  // While attached, occasionally check whether a BETTER chat container exists
  // (e.g. the chat panel finished loading after the page, or the user switched
  // threads). Only switches to a row-list with strictly more prompt rows, so it
  // can never thrash. Heavily throttled — near-zero cost during steady use.
  function maybeRescan() {
    const now = Date.now();
    if (now - lastRescan < RESCAN_THROTTLE) return;
    lastRescan = now;
    const cand = detectContainer();
    if (!cand || cand === container) return;
    if (countPromptRows(cand) > countPromptRows(container)) {
      try { container.removeAttribute(MARK); } catch (_) {}
      container = cand;
      applyAttached();
    }
  }

  // Coalesce bursts of mutations into a single rAF callback. During streaming
  // Notion fires hundreds of mutations per second; without coalescing we'd run
  // our checks just as often. One pass per frame is plenty for a sliding
  // window, and rAF naturally pauses in background tabs.
  function onMutations() {
    if (!config.enabled) return;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (container && container.isConnected) {
        maybePrune();
        maybeRescan();
        return;
      }
      if (pendingScan) return;
      pendingScan = true;
      setTimeout(() => {
        pendingScan = false;
        reconcile();
      }, DETECT_DEBOUNCE);
    });
  }

  function armObserver() {
    if (observer) return;
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function disarmObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // ---- read-only DOM structure capture (debug only) ----
  // We never read message text — only tag/class/attribute SHAPES and whether a
  // row exposes a record-id-like value. This tells us how to hide already-
  // painted exchanges precisely (by record id) without ever clipping the live
  // streaming turn. Rides along in page.js's diagnostic export.
  function attrShapes(el) {
    const out = {};
    try {
      for (const a of el.attributes) {
        const v = a.value || "";
        const uuidLike = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(v) || /\b[0-9a-f]{32}\b/i.test(v);
        out[a.name] = { len: v.length, uuidLike, sample: v.slice(0, 90) };
      }
    } catch (_) {}
    return out;
  }
  function describeRow(el, i) {
    const fc = el.firstElementChild;
    return {
      i,
      tag: el.tagName,
      cls: (typeof el.className === "string" ? el.className : "").slice(0, 140),
      kids: el.childElementCount,
      attrs: attrShapes(el),
      firstChild: fc ? { tag: fc.tagName, cls: (typeof fc.className === "string" ? fc.className : "").slice(0, 140), attrs: attrShapes(fc) } : null,
      textLen: (el.textContent || "").length,
    };
  }
  function captureDomSample() {
    if (!container) return null;
    const rows = Array.from(container.children);
    const total = rows.length;
    const head = [];
    for (let i = 0; i < Math.min(6, total); i++) head.push(describeRow(rows[i], i));
    const tail = [];
    for (let i = Math.max(0, total - 10); i < total; i++) tail.push(describeRow(rows[i], i));
    return {
      host: location.host,
      capturedAt: new Date().toISOString(),
      containerTag: container.tagName,
      containerCls: (typeof container.className === "string" ? container.className : "").slice(0, 200),
      totalRows: total,
      head,
      tail,
    };
  }
  function relayDom() {
    if (!config.debug || !container) return;
    const now = Date.now();
    if (now - lastDomRelay < DIAG_THROTTLE) return;
    lastDomRelay = now;
    try { window.dispatchEvent(new CustomEvent("notion-turbo-dom", { detail: captureDomSample() })); } catch (_) {}
  }

  function applyAttached() {
    if (!container) return;
    if (container.getAttribute(MARK) !== "1") {
      try { container.setAttribute(MARK, "1"); } catch (_) {}
    }
    setCss(buildCss());
    const rows = container.childElementCount;
    updateHud(true, rows);
    writeStatus(true, rows);
    relayDom();
  }

  function idleDetect() {
    if (detectPending) return;
    detectPending = true;
    idle(() =>
      measure(() => {
        detectPending = false;
        if (!config.enabled) return;
        if (container && container.isConnected) return;
        container = detectContainer();
        if (container) {
          warned = false;
          applyAttached();
        } else if (config.debug && !warned) {
          warned = true;
          log(
            "Waiting for a long, fully-loaded chat with a visible scrollbar. " +
              "Open a long chat or set a container selector in Advanced.",
          );
        }
      }),
    );
  }

  // Single source of truth for "make the page match the current config".
  function reconcile() {
    if (!config.enabled) {
      container = null;
      setCss("");
      updateHud(false, 0);
      writeStatus(false, 0);
      return;
    }
    if (container && container.isConnected) {
      applyAttached();
      return;
    }
    container = null;
    setCss("");
    updateHud(false, 0);
    writeStatus(false, 0);
    // No console.warn here: detection is async and usually succeeds a moment
    // later (e.g. right after a tab switch), so warning now would be a false
    // alarm — and console.warn shows up on the extension Errors page. If
    // detection actually fails, idleDetect() logs a debug-only note instead.
    idleDetect();
  }

  function tick() {
    measure(reconcile);
  }

  function applyConfig(next) {
    const selectorChanged = (next.containerSelector || "") !== (config.containerSelector || "");
    config = { ...DEFAULTS, ...next };
    if (selectorChanged) container = null;
    lastCss = null;
    warned = false;
    if (config.enabled) armObserver();
    else disarmObserver();
    if (config.monitor || config.debug) startMonitor();
    else stopMonitor();
    relayConfig();
    tick();
  }

  // ---------- boot ----------
  armObserver();
  tick();

  // Slow safety net: pauses in background tabs, and only does real work if the
  // container vanished without a mutation we caught.
  setInterval(() => {
    if (document.hidden) return;
    if (!config.enabled) return;
    if (container && container.isConnected) { writeStatus(true, container.childElementCount); return; }
    tick();
  }, SAFETY_MS);

  try {
    chrome.storage?.sync.get(DEFAULTS, (stored) => applyConfig(stored));
    chrome.storage?.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      const next = { ...config };
      for (const k of Object.keys(changes)) next[k] = changes[k].newValue;
      applyConfig(next);
      log("config updated", config);
    });
  } catch (_) {}

  // Relay a diagnostic-save request from the popup to the MAIN-world agent.
  try {
    chrome.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === "notionTurboDiagSave") {
        try { window.dispatchEvent(new CustomEvent("notion-turbo-diag-save")); } catch (_) {}
        if (sendResponse) sendResponse({ ok: true });
      }
      return false;
    });
  } catch (_) {}

  // SPA navigations: re-detect on history changes and when the tab regains focus.
  const reset = () => { container = null; if (config.enabled) armObserver(); tick(); };
  window.addEventListener("popstate", reset);
  window.addEventListener("pageshow", reset);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) reset(); });
})();

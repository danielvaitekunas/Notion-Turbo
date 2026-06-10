/*
 * Notion Turbo — MAIN-world network agent  (v1.0.4)
 * --------------------------------------------------
 * Runs in the page's OWN JS world and patches the same fetch the Notion app
 * uses, so it can shape the AI-chat transcript before React ever sees it.
 *
 * WHAT IT DOES (opt-in via the popup):
 *   When the app loads the AI chat transcript, keep only the most recent N
 *   EXCHANGES and drop the older ones ENTIRELY — old prompts AND their responses
 *   — before React ingests them. This removes the multi-second load freeze on
 *   very long chats; the visible history stays a clean set of complete recent
 *   exchanges (no orphaned prompts/responses, correct order).
 *
 * WHAT COUNTS AS AN "EXCHANGE":
 *   A single transcript turn contains MANY records (one user prompt plus dozens
 *   of agent inferences, tool results, turn records, summaries, etc.). Only the
 *   real user prompt (step type "user") starts a new exchange. Records that
 *   immediately precede a prompt and belong to it (uploaded files, config
 *   snapshots) are "lead-ins" grouped FORWARD into that prompt. Everything else
 *   — including any unknown future record type — folds into the exchange already
 *   in progress, so new record types can never be mistaken for new exchanges.
 *
 * LIVE STREAMING (the v1.0.3 fix):
 *   Trimming is applied ONLY to the initial transcript load (the bulk
 *   syncRecordValuesSpaceInitial and page-chunk fetches). Live/streaming record
 *   deltas during an in-progress AI turn — and on-demand getRecordValues
 *   fetches — are passed through untouched, so the active response always
 *   renders immediately. The visible window is chosen once, when the chat loads
 *   (a ChatGPT-style "light session"); newer responses are never altered while
 *   they stream.
 *
 * MULTI-BATCH LOADING (the v1.0.1 fix):
 *   Notion loads a long thread in SEVERAL separate network responses, each
 *   carrying a different time-slice of the SAME thread (e.g. one batch is
 *   Jun 4–8, another Jun 1–3). Trimming each batch on its own ("keep this
 *   batch's last N") keeps a different chunk per batch, and the app merges them
 *   — so the conversation barely shrinks. Instead we remember every exchange
 *   we have ever seen PER THREAD and trim every batch against ONE global cutoff,
 *   so the merged result converges to the last N exchanges of the whole thread.
 *
 * SAFETY — page content can never be harmed, and exchanges stay whole:
 *   - The ONLY mutation ever performed is `delete recordMap.thread_message[id]`
 *     for records before the kept window. We cut on EXCHANGE boundaries and, in
 *     each batch, drop strictly by chronological POSITION up to the first kept
 *     exchange — so a kept exchange always includes its prompt, its lead-in
 *     files, and all of its responses.
 *   - thread_message records are a flat list (every record is parented to the
 *     thread, not to each other), so dropping older records never orphans a
 *     kept one.
 *   - Every other record map (block, collection, space, …) is re-serialized
 *     byte-for-byte unchanged.
 *   - This only shapes the data the app READS; it never writes to Notion, so the
 *     full history always remains on the server and returns on reload.
 *   - Any error => the original, untouched response is returned.
 *
 * PERFORMANCE:
 *   - When trimming and diagnostics are OFF, the fetch wrapper is a pure
 *     pass-through (one boolean short-circuit).
 *   - When ON, every request costs a single regex test; only Notion's
 *     record-sync endpoints carrying "thread_message" are ever read/parsed.
 *
 * DIAGNOSTICS (Debug on):
 *   - Captures the STRUCTURE of each transcript payload (record ids, step
 *     types, created_time, parent links, per-record role) plus the global trim
 *     plan — never message text. Runs even when trimming is OFF. Export via the
 *     popup button or __NOTION_TURBO_DIAG_SAVE__() in DevTools.
 */
(() => {
  "use strict";

  if (window.top !== window.self) return;
  if (window.__NOTION_TURBO_PAGE__) return;
  window.__NOTION_TURBO_PAGE__ = true;

  const VERSION = "1.0.4";
  const MAX_BODY = 30000000; // 30MB hard cap on bodies we will parse

  // Notion's record-loading endpoints — the only places the transcript lives.
  const RECORD_SYNC = /\/api\/v3\/(syncRecordValues|getRecordValues|loadCachedPageChunk|loadPageChunk)/i;
  // These carry the INITIAL bulk transcript load (used only to label loads vs.
  // live deltas in diagnostics/notes).
  const LOAD_SYNC = /\/api\/v3\/(syncRecordValuesSpaceInitial|loadCachedPageChunk|loadPageChunk)/i;
  // Endpoints trimmed on EVERY turn for the live sliding window: the initial
  // bulk load, live record syncs (plain syncRecordValues), and page chunks.
  // getRecordValues hydration is deliberately excluded. Trimming here is always
  // newest-safe (see tryTrim) so in-progress streaming answers are never cut.
  const TRIM_SYNC = /\/api\/v3\/(syncRecordValues|loadCachedPageChunk|loadPageChunk)/i;

  let cfg = { trim: false, keepRecords: 10, debug: false };
  let lastBannerKey = "";
  let lastBannerAt = 0;
  // Read-only DOM snapshot pushed from the isolated-world content script (which
  // can see the rendered chat). Rides along in the diagnostic export so we can
  // learn how Notion renders chat rows — and whether they expose a record id —
  // the prerequisite for hiding already-painted exchanges precisely and safely.
  let lastDom = null;
  const trimStats = { attempts: 0, trimmed: 0, recent: [] };

  // Global, session-wide memory of the thread so trimming stays consistent
  // across the MULTIPLE network batches Notion uses for one long thread. Keyed
  // by thread id so navigating between chats never mixes their timelines.
  // threadId -> { set: Set<number> (membership), arr: number[] (sorted asc, unique) }.
  // The Set gives O(1) de-duplication so folding each batch's prompts into the
  // per-thread view stays linear instead of O(n^2) on very long threads.
  const promptsByThread = new Map();
  function rememberPrompts(threadId, times) {
    let rec = promptsByThread.get(threadId);
    if (!rec) { rec = { set: new Set(), arr: [] }; promptsByThread.set(threadId, rec); }
    let changed = false;
    for (const t of times) {
      if (!t) continue;
      if (!rec.set.has(t)) { rec.set.add(t); rec.arr.push(t); changed = true; }
    }
    if (changed) rec.arr.sort((a, b) => a - b);
    return rec.arr;
  }
  // The start time of the Nth-from-newest exchange across everything seen for
  // this thread; 0 means we have not yet seen more than `keep` exchanges.
  function cutoffFor(arr, keep) {
    return arr.length > keep ? arr[arr.length - keep] : 0;
  }

  // ---- cross-reload persistence (the v1.0.3 load-speed fix) ----
  // The per-thread prompt timeline above lives only in memory, so on a FRESH
  // page load the first network batches arrive before any prompt has been seen
  // (cutoff = 0) and sail through untrimmed — which is why a reload still loaded
  // the whole history and stayed slow. We mirror the timeline into localStorage
  // (available in this MAIN world, same-origin) keyed by thread id, and re-seed
  // it on the very first batch of the next load so the cutoff is known
  // IMMEDIATELY and even batch #0 gets trimmed. Only prompt START times are
  // stored (small numbers), never any page/message content.
  const LS_PREFIX = "notion-turbo:prompts:";
  const LS_MAX = 500; // bound the stored timeline on enormous threads
  function seedFromStorage(threadId) {
    if (!threadId || promptsByThread.has(threadId)) return;
    let rec = { set: new Set(), arr: [] };
    try {
      const raw = localStorage.getItem(LS_PREFIX + threadId);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          for (const t of arr) {
            if (typeof t === "number" && t > 0 && !rec.set.has(t)) { rec.set.add(t); rec.arr.push(t); }
          }
          rec.arr.sort((a, b) => a - b);
        }
      }
    } catch { /* storage blocked / bad JSON -> start empty */ }
    promptsByThread.set(threadId, rec);
  }
  function persistPrompts(threadId, arr) {
    if (!threadId || !arr || !arr.length) return;
    try { localStorage.setItem(LS_PREFIX + threadId, JSON.stringify(arr.slice(-LS_MAX))); } catch { /* ignore */ }
  }

  // Gated behind debug so a normal install keeps the console clean.
  const log = (...a) => { if (cfg.debug) console.log("[NotionTurbo:net]", ...a); };

  function note(reason, info) {
    // Diagnostics aid only — skip all bookkeeping (Date alloc + array churn) on
    // the hot path unless Debug is on. The real trim counters live in tryTrim.
    if (!cfg.debug) return;
    const row = Object.assign({ reason, at: new Date().toISOString().slice(11, 19) }, info || {});
    trimStats.recent.push(row);
    if (trimStats.recent.length > 60) trimStats.recent.shift();
    log("trim:", reason, info || "");
  }

  // Small purple toast confirming a trim/diag happened (throttled).
  function banner(msg) {
    try {
      const id = "notion-turbo-banner";
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement("div");
        el.id = id;
        el.style.cssText = [
          "position:fixed", "bottom:16px", "left:16px", "z-index:2147483647",
          "font:12px/1.3 -apple-system,Segoe UI,Roboto,sans-serif",
          "padding:8px 11px", "border-radius:8px",
          "background:rgba(33,33,36,0.96)", "color:#fff",
          "box-shadow:0 2px 12px rgba(0,0,0,0.25)", "pointer-events:none",
        ].join(";");
        document.documentElement.appendChild(el);
      }
      el.textContent = msg;
      el.style.display = "block";
      clearTimeout(el.__h);
      el.__h = setTimeout(() => { el.style.display = "none"; }, 2600);
    } catch {}
  }

  // ---------- diagnostics (non-destructive) ----------
  const DIAG_MAX = 12;
  const diagBuf = [];

  function idArraysOf(obj) {
    const out = {};
    if (!obj || typeof obj !== "object") return out;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) {
        out[k] = { len: v.length, sample: v.slice(0, 8) };
      }
    }
    return out;
  }

  function captureDiag(endpoint, json, rm, tm, ids, h, plan) {
    try {
      const tables = Object.keys(rm);
      const threadRecords = [];
      if (rm.thread) {
        for (const tid of Object.keys(rm.thread)) {
          const tv = (rm.thread[tid] && rm.thread[tid].value && rm.thread[tid].value.value) || rm.thread[tid];
          threadRecords.push({
            id: tid,
            keys: tv && typeof tv === "object" ? Object.keys(tv) : [],
            idArrays: idArraysOf(tv),
          });
        }
      }
      const typeCounts = {};
      const msgs = ids
        .map((id) => {
          const v = h.valOf(id);
          const t = h.stepType(id);
          typeCounts[t || "(none)"] = (typeCounts[t || "(none)"] || 0) + 1;
          return {
            id,
            type: t,
            created_time: h.ctime(id),
            parent_id: (v && v.parent_id) || null,
            parent_table: (v && v.parent_table) || null,
            role: h.isPrompt(id) ? "prompt" : h.isLeadIn(id) ? "lead-in" : "work",
            valueKeys: v && typeof v === "object" ? Object.keys(v) : [],
            idArrays: idArraysOf(v),
          };
        })
        .sort((a, b) => a.created_time - b.created_time);

      const entry = {
        at: new Date().toISOString(),
        endpoint,
        version: VERSION,
        threadId: plan.threadId,
        topKeys: Object.keys(json),
        tables,
        messageCount: ids.length,
        stepTypeCounts: typeCounts,
        batchPromptCount: msgs.filter((m) => m.role === "prompt").length,
        threadRecords,
        trimPlan: {
          keep: plan.keep,
          batchExchanges: plan.batchExchanges,
          globalExchanges: plan.exchanges,
          cutoff: plan.cutoff,
          firstKeptIndex: plan.firstKeptIndex,
          wouldDropCount: plan.wouldDrop.length,
          wouldDrop: plan.wouldDrop.slice(0, 300),
        },
        orderByCreatedTime: msgs.map((m) => m.id),
        messages: msgs.slice(0, 4000),
      };
      diagBuf.push(entry);
      if (diagBuf.length > DIAG_MAX) diagBuf.shift();
      log("diag captured:", { endpoint, messages: ids.length, globalExchanges: plan.exchanges, wouldDrop: plan.wouldDrop.length });
    } catch (e) {
      log("diag capture error:", String((e && e.message) || e));
    }
  }

  function diagReport() {
    return {
      version: VERSION,
      host: location.host,
      capturedAt: new Date().toISOString(),
      trimEnabled: !!cfg.trim,
      keepRecords: cfg.keepRecords,
      threadsSeen: [...promptsByThread.entries()].map(([id, rec]) => ({ id, exchanges: rec.arr.length })),
      dom: lastDom,
      captures: diagBuf,
    };
  }

  function saveDiag() {
    try {
      const blob = new Blob([JSON.stringify(diagReport(), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `notion-turbo-diag-${Date.now()}.json`;
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      banner(`Notion Turbo: saved diagnostic (${diagBuf.length} capture${diagBuf.length === 1 ? "" : "s"})`);
      return true;
    } catch (e) {
      console.log("[NotionTurbo:net] diag save failed:", e);
      return false;
    }
  }

  window.__NOTION_TURBO_DIAG__ = () => { const r = diagReport(); console.log(JSON.stringify(r, null, 2)); return r; };
  window.__NOTION_TURBO_DIAG_JSON__ = () => JSON.stringify(diagReport(), null, 2);
  window.__NOTION_TURBO_DIAG_SAVE__ = saveDiag;
  window.addEventListener("notion-turbo-diag-save", saveDiag);
  window.addEventListener("notion-turbo-dom", (e) => { try { lastDom = (e && e.detail) || null; } catch (_) {} });

  // ---------- the trimmer ----------
  function tryTrim(res, text, p) {
    trimStats.attempts++;
    let json;
    try { json = JSON.parse(text); } catch { note("not-json", { p }); return null; }
    const rm = json && json.recordMap;
    if (!rm || !rm.thread_message) { note("no-thread_message", { p }); return null; }
    const blocksPresent = !!rm.block; // we still trim, but only ever touch thread_message keys
    const tm = rm.thread_message;
    const ids = Object.keys(tm);
    const keep = Math.max(1, Number(cfg.keepRecords) || 10);
    // Light-session model: only the initial bulk load is ever trimmed.
    const isInitialLoad = LOAD_SYNC.test(p);

    // Memoize the deep value lookup: each record's value is read several times
    // (order build, exchange detection, diagnostics), so cache it once per batch.
    const valCache = new Map();
    const valOf = (id) => {
      let v = valCache.get(id);
      if (v === undefined) { v = (tm[id] && tm[id].value && tm[id].value.value) || null; valCache.set(id, v); }
      return v;
    };
    const stepType = (id) => { const v = valOf(id); return (v && v.step && v.step.type) || ""; };
    const ctime = (id) => { const v = valOf(id); return (v && v.created_time) || 0; };
    const parentOf = (id) => { const v = valOf(id); return (v && v.parent_id) || ""; };

    // Which thread does this batch belong to? (All thread_message records share
    // one thread parent.) Used to keep per-thread global state separate.
    let threadId = "";
    for (const id of ids) { const pid = parentOf(id); if (pid) { threadId = pid; break; } }

    // ---- exchange detection (see header) ----
    const LEAD_IN = new Set(["attachment", "computer-file", "updated-config", "config", "context", "title"]);
    const isPrompt = (id) => stepType(id) === "user";
    const isLeadIn = (id) => LEAD_IN.has(stepType(id));

    // Stable chronological order (ties keep the server's original order).
    const order = ids
      .map((id, i) => ({ id, i, t: ctime(id) }))
      .sort((a, b) => (a.t - b.t) || (a.i - b.i));

    // Exchange starts in THIS batch: each prompt, walked back over its lead-ins,
    // paired with its prompt time.
    const starts = [];
    for (let i = 0; i < order.length; i++) {
      if (!isPrompt(order[i].id)) continue;
      let s = i;
      while (s - 1 >= 0 && isLeadIn(order[s - 1].id)) s--;
      const ptime = order[i].t;
      if (starts.length === 0 || starts[starts.length - 1].idx !== s) starts.push({ idx: s, ptime });
      else starts[starts.length - 1].ptime = ptime;
    }

    // Fold this batch's prompts into the per-thread global view, then trim the
    // batch against ONE global cutoff so multi-batch loads converge to the last
    // N exchanges of the whole thread (not "last N per batch"). Re-seed from
    // localStorage first so the cutoff is known on the very first batch of a
    // fresh load, then persist the merged timeline for the next load.
    seedFromStorage(threadId);
    const globalTimes = rememberPrompts(threadId, starts.map((st) => st.ptime));
    const cutoff = cutoffFor(globalTimes, keep);
    // Only touch localStorage when this batch actually contributed prompts —
    // prompt-less batches (streaming deltas, big tool-result bundles) never
    // change the timeline, so this avoids redundant synchronous writes.
    if (starts.length) persistPrompts(threadId, globalTimes);

    const plan = {
      keep,
      threadId,
      total: ids.length,
      batchExchanges: starts.length,
      exchanges: globalTimes.length,
      cutoff,
      firstKeptIndex: 0,
      wouldDrop: [],
    };

    if (cutoff > 0) {
      // First exchange in this batch at/after the global cutoff. If none, the
      // whole batch predates the cutoff and is dropped.
      let firstKept = order.length;
      for (let k = 0; k < starts.length; k++) {
        if (starts[k].ptime >= cutoff) { firstKept = starts[k].idx; break; }
      }
      plan.firstKeptIndex = firstKept;
      // Drop everything before the first kept exchange, by position; never drop a
      // record that lacks a usable timestamp.
      for (let idx = 0; idx < firstKept; idx++) {
        const r = order[idx];
        // Newest-safe: only ever drop records strictly older than the cutoff, so
        // the just-sent prompt and the in-progress streaming answer (always at or
        // after the cutoff) can never be removed.
        if (r.t && r.t < cutoff) plan.wouldDrop.push(r.id);
      }
    }

    if (cfg.debug) captureDiag(p, json, rm, tm, ids, { valOf, stepType, ctime, isPrompt, isLeadIn }, plan);

    // When trimming is disabled we NEVER mutate — diagnostics still ran above.
    if (!cfg.trim) { note("capture-only", { p, total: ids.length, batchEx: starts.length, globalEx: globalTimes.length, keep }); return null; }

    // LIVE SLIDING WINDOW: trimming now runs on every turn — the initial load
    // AND live record syncs — so the visible set tracks the last N exchanges as
    // the chat grows, without a manual refresh. This is newest-safe BY
    // CONSTRUCTION: wouldDrop only contains records that start strictly before
    // the global cutoff (the Nth-from-newest exchange), so the just-sent prompt
    // and the in-progress streaming answer are never dropped. A pure streaming
    // delta (no prompt boundary) is skipped by the no-prompt guard below, so an
    // in-progress answer always renders fully — no disappearing text, no refresh.
    if (!isInitialLoad) note("live-trim", { p, total: ids.length });

    // A batch with no user-prompt boundary can't be classified ON ITS OWN. But
    // if we already know this thread's global cutoff (from earlier batches or
    // the persisted timeline), we can STILL safely drop records that predate it.
    // These prompt-less batches are the big bundles of old agent tool-results /
    // inferences that previously sailed through untrimmed (logged as
    // "no-prompt-skip") and were the main cause of high RAM + slow loads in long
    // agentic chats. This stays newest-safe: wouldDrop only ever holds records
    // with created_time STRICTLY BEFORE the cutoff, so an in-progress streaming
    // answer (always at/after the cutoff, and the shape of an early delta when
    // no cutoff exists yet) is never touched.
    if (starts.length === 0 && cutoff <= 0) { note("no-prompt-skip", { p, total: ids.length }); return null; }

    if (plan.wouldDrop.length === 0) { note("nothing-to-drop", { p, total: ids.length, batchEx: starts.length, globalEx: globalTimes.length, keep, cutoff }); return null; }

    const dropCount = plan.wouldDrop.length;
    for (const id of plan.wouldDrop) delete tm[id];
    trimStats.trimmed++;
    note(blocksPresent ? "TRIMMED-mixed" : "TRIMMED", { p, total: ids.length, globalEx: globalTimes.length, keep, dropped: dropCount, withBlocks: blocksPresent });

    const headers = new Headers(res.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", "application/json; charset=utf-8");
    const out = new Response(JSON.stringify(json), {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
    try {
      if (res.url) Object.defineProperty(out, "url", { value: res.url });
      if (res.type) Object.defineProperty(out, "type", { value: res.type });
    } catch {}

    const key = `${keep}/${globalTimes.length}`;
    const now = Date.now();
    if (key !== lastBannerKey || now - lastBannerAt > 4000) {
      lastBannerKey = key;
      lastBannerAt = now;
      banner(`Notion Turbo: showing your last ${keep} exchanges`);
      log(`thread has ${globalTimes.length} exchanges seen; dropped ${dropCount} older records from this batch`);
    }
    return out;
  }

  // ---------- fetch patch ----------
  const nativeFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  if (nativeFetch) {
    window.fetch = async (...args) => {
      const res = await nativeFetch(...args);
      if (!cfg.trim && !cfg.debug) return res; // pass-through unless trimming or capturing diagnostics

      const arg0 = args[0];
      const url = typeof arg0 === "string" ? arg0 : (arg0 && arg0.url) || "";
      // Cheap substring pre-gate: the vast majority of requests never touch the
      // Notion record API, so skip the regex test entirely for those.
      if (url.indexOf("/api/v3/") === -1) return res;
      // Normal use (trim on): read the initial load AND live record syncs so the
      // last-N window is re-applied every turn. getRecordValues hydration stays
      // pass-through. With debug on we observe the broader set for diagnostics.
      // tryTrim is newest-safe, so in-progress streaming answers are untouched.
      const relevant = cfg.debug ? RECORD_SYNC.test(url) : TRIM_SYNC.test(url);
      if (!relevant) return res;

      // Skip oversized bodies cheaply via the declared length before cloning.
      const clen = Number(res.headers.get("content-length") || 0);
      if (clen > MAX_BODY) { note("too-large", { url, clen }); return res; }

      try {
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("json") || ct === "") {
          const text = await res.clone().text();
          if (text && text.length < MAX_BODY && text.indexOf('"thread_message"') !== -1) {
            const trimmed = tryTrim(res, text, url);
            if (trimmed) return trimmed;
          }
        }
      } catch (e) { note("error", { msg: String((e && e.message) || e) }); }
      return res;
    };
  }

  // ---------- console helper ----------
  window.__NOTION_TURBO_TRIM_STATS__ = () => {
    const out = {
      version: VERSION,
      trimEnabled: !!cfg.trim,
      keepRecords: cfg.keepRecords,
      attempts: trimStats.attempts,
      trimmed: trimStats.trimmed,
      threadsSeen: [...promptsByThread.entries()].map(([id, rec]) => ({ id, exchanges: rec.arr.length })),
      recent: trimStats.recent,
    };
    console.log("[NotionTurbo:net] trim stats:");
    console.log(JSON.stringify(out, null, 2));
    return out;
  };

  // ---------- config from the isolated content script ----------
  window.addEventListener("notion-turbo-config", (e) => {
    const d = (e && e.detail) || {};
    const wasTrim = cfg.trim;
    cfg = {
      trim: !!d.trim,
      keepRecords: Math.max(1, Number(d.keepRecords) || 10),
      debug: !!d.debug,
    };
    if (cfg.trim && !wasTrim) log(`trimmer ON — keeping last ${cfg.keepRecords} exchanges. Reload the chat to apply.`);
    if (!cfg.trim && wasTrim) log("trimmer OFF — reload to restore full history.");
  });
})();

// Google Rank Finder – content script
// Normal Google searches are left alone. A rank hunt only runs when it was started
// with the "Find rank" button (on the Google page or in the extension popup).

(() => {
  if (window.__rankFinderLoaded) return;
  window.__rankFinderLoaded = true;

  const JOB_KEY = "rfJob";
  const SETTINGS_KEY = "rfSettings";
  const HISTORY_KEY = "rfHistory";
  const DEFAULT_MAX = 100;

  const AD_SELECTORS = [
    "#tads", "#tadsb", "#bottomads", "[data-text-ad]", "[aria-label='Ads']",
    "[data-pla]", ".commercial-unit-desktop-top", ".cu-container"
  ].join(",");
  // Only clear-cut SERP features are skipped; anything unsure is counted as organic.
  const FEATURE_SELECTORS = [".related-question-pair", "[data-initq]", "#rhs"].join(",");
  // Result titles: Google uses <h3> on desktop and role="heading" in some layouts.
  const TITLE_SELECTORS = [
    "a h3", "h3 a[href]", "a [role='heading']", "a[role='heading']", "[role='heading'][aria-level='3'] a[href]"
  ].join(",");

  let running = false;
  let stopRequested = false;

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));
  const get = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k])));
  const set = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));

  function normalizeDomain(input) {
    let d = String(input || "").trim().toLowerCase();
    d = d.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "");
    return d.replace(/^www\./, "");
  }

  function normalizeQuery(q) {
    return String(q || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function currentQuery() {
    return new URLSearchParams(location.search).get("q") || "";
  }

  function realUrl(a) {
    let href = a.getAttribute("href") || "";
    try {
      const u = new URL(href, location.origin);
      if (u.pathname === "/url") {
        const target = u.searchParams.get("q") || u.searchParams.get("url");
        if (target) return new URL(target).href;
      }
      return u.href;
    } catch {
      return null;
    }
  }

  function hostMatches(url, domain) {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      return host === domain || host.endsWith("." + domain);
    } catch {
      return false;
    }
  }

  function isGoogleUrl(url) {
    try {
      const h = new URL(url).hostname;
      return /(^|\.)google\.[a-z.]+$/.test(h) || h.endsWith("googleusercontent.com") ||
        h === "webcache.googleusercontent.com";
    } catch {
      return true;
    }
  }

  // The whole page is scanned; Google's wrapper ids change too often to rely on them.
  function resultsRoot() {
    return document.body;
  }

  // Containers to skip. A container that also holds the main results (#rso) or many result
  // titles is not really an ad/feature block, so it is ignored, never the whole page.
  function skipContainers() {
    const list = [];
    const add = (sel) => document.querySelectorAll(sel).forEach((c) => {
      if (c.querySelector("#rso") || c.querySelectorAll("h3").length > 6) return;
      list.push(c);
    });
    add(AD_SELECTORS);
    add(FEATURE_SELECTORS);
    document.querySelectorAll("#rf-panel, #rf-modal, header, footer, #footcnt, [role='navigation'], form[role='search']")
      .forEach((c) => { if (!c.querySelector("#rso")) list.push(c); });
    return list;
  }
  const inAny = (list, el) => list.some((c) => c.contains(el));

  function externalUrl(a) {
    const url = realUrl(a);
    return url && /^https?:/.test(url) && !isGoogleUrl(url) ? url.split("#")[0] : null;
  }

  // Organic results in document order (ads and SERP features left out).
  function organicResults() {
    const out = [];
    const seenHere = new Set();
    const skip = skipContainers();
    const push = (a) => {
      if (!a || inAny(skip, a)) return;
      const key = externalUrl(a);
      if (!key || seenHere.has(key)) return;
      seenHere.add(key);
      out.push({ a, url: key });
    };
    resultsRoot().querySelectorAll(TITLE_SELECTORS).forEach((el) => push(el.tagName === "A" ? el : el.closest("a[href]")));
    if (!out.length) {
      // Fallback when no titles are recognised: one link per result block, in page order.
      const blocks = new Set();
      resultsRoot().querySelectorAll("a[href]").forEach((a) => {
        if ((a.textContent || "").trim().length < 12 || !externalUrl(a)) return;
        const block = resultBlock(a);
        if (blocks.has(block)) return;
        blocks.add(block);
        push(a);
      });
    }
    return out;
  }

  // Safety net: any non-ad link to the site on the page, even if it wasn't recognised as a title.
  function findLinkTo(domain) {
    const ads = [...document.querySelectorAll(AD_SELECTORS)].filter((c) => !c.querySelector("#rso"));
    for (const a of resultsRoot().querySelectorAll("a[href]")) {
      if (a.closest("#rf-panel, #rf-modal") || inAny(ads, a)) continue;
      const url = externalUrl(a);
      if (url && hostMatches(url, domain)) return { a, url };
    }
    return null;
  }

  // Paint every link to the user's sites green.
  function highlightLinks(domains) {
    if (!domains.length) return;
    let n = 0;
    const ads = [...document.querySelectorAll(AD_SELECTORS)].filter((c) => !c.querySelector("#rso"));
    resultsRoot().querySelectorAll("a[href]").forEach((a) => {
      if (a.closest("#rf-panel, #rf-modal") || inAny(ads, a)) return;
      const url = externalUrl(a);
      if (url && domains.some((d) => hostMatches(url, d))) {
        a.classList.add("rf-link-hit");
        const block = resultBlock(a);
        if (block && block !== document.body) block.classList.add("rf-block-hit");
        n++;
      }
    });
    return n;
  }

  function resultBlock(a) {
    return a.closest(".MjjYud, .g, [data-hveid], [data-snc]") || a.parentElement;
  }

  // ---------- floating status panel ----------
  let panel;
  function showPanel(html, { done = false, tone = "" } = {}) {
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "rf-panel";
      document.documentElement.appendChild(panel);
    }
    panel.className = tone ? "rf-" + tone : "";
    panel.innerHTML = `
      <div class="rf-head"><span class="rf-title">Rank Finder</span>
        <button class="rf-x" title="Close">×</button></div>
      <div class="rf-body">${html}</div>
      ${done ? "" : '<button class="rf-stop">Stop</button>'}`;
    panel.querySelector(".rf-x").onclick = () => { panel.remove(); panel = null; };
    const stop = panel.querySelector(".rf-stop");
    if (stop) stop.onclick = () => stopJob("Stopped by you.");
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- job control ----------
  function parseDomains(list) {
    const arr = Array.isArray(list) ? list : String(list || "").split(/[\s,]+/);
    return [...new Set(arr.map(normalizeDomain).filter(Boolean))];
  }

  function savedDomains(settings) {
    return parseDomains(settings.domains || settings.domain || []);
  }

  async function startJob(query, domains, maxResults) {
    domains = parseDomains(domains);
    if (!query || !domains.length) return;
    const job = {
      active: true, query, domains, found: {},
      maxResults: Math.max(10, Math.min(500, Number(maxResults) || DEFAULT_MAX)),
      checked: 0, seen: [], pages: 1, startedAt: Date.now(), status: "searching"
    };
    await set({ [JOB_KEY]: job });
    const url = new URL("/search", location.origin);
    url.searchParams.set("q", query);
    location.href = url.href;
  }

  async function stopJob(message) {
    stopRequested = true;
    const job = await get(JOB_KEY);
    if (job && job.active) {
      job.active = false;
      job.status = "stopped";
      await set({ [JOB_KEY]: job });
    }
    showPanel(esc(message || "Stopped."), { done: true });
  }

  async function finish(job, reason) {
    job.active = false;
    const foundCount = Object.keys(job.found).length;
    job.status = foundCount === job.domains.length ? "found" : foundCount ? "partial" : "not_found";
    job.reason = reason;
    const history = (await get(HISTORY_KEY)) || [];
    const at = Date.now();
    for (const d of [...job.domains].reverse()) {
      const f = job.found[d];
      history.unshift({ domain: d, query: job.query, found: !!f, rank: f ? f.rank : null,
        url: f ? f.url : null, checked: job.checked, at });
    }
    await set({ [JOB_KEY]: job, [HISTORY_KEY]: history.slice(0, 50) });
  }

  function rankList(job, done) {
    return '<ul class="rf-list">' + job.domains.map((d) => {
      const f = job.found[d];
      if (f) return `<li><span class="rf-rank">#${f.rank}</span> <b>${esc(d)}</b>
        <span class="rf-page">page ${Math.ceil(f.rank / 10)}</span>
        ${done && f.pageUrl && f.pageUrl !== location.href ? `<a class="rf-show" href="${esc(f.pageUrl)}">Show it on Google</a>` : ""}<br>
        <a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.url)}</a></li>`;
      return `<li><span class="rf-rank rf-none">${done ? "–" : "…"}</span> <b>${esc(d)}</b>
        <span class="rf-page">${done ? `not in top ${job.checked}` : "searching"}</span></li>`;
    }).join("") + "</ul>";
  }

  function markHit(a, rank) {
    const block = resultBlock(a);
    if (block.classList.contains("rf-hit")) return block;
    block.classList.add("rf-hit");
    a.classList.add("rf-link-hit");
    const badge = document.createElement("span");
    badge.className = "rf-badge";
    badge.textContent = "#" + rank;
    a.prepend(badge);
    return block;
  }

  // ---------- the hunt ----------
  async function hunt(job) {
    try {
      await huntInner(job);
    } catch (err) {
      running = false;
      console.error("[Rank Finder]", err);
      showPanel(`Something went wrong: <code>${esc(err && err.message || err)}</code><br>
        If you just updated the extension, refresh this Google tab and click Find rank again.`, { done: true, tone: "warn" });
    }
  }

  async function huntInner(job) {
    running = true;
    stopRequested = false;
    const seen = new Set(job.seen);
    const remaining = () => job.domains.filter((d) => !job.found[d]);
    const countedHere = []; // {a, rank} counted on this page, in order
    let firstHit = null;

    const progress = () => showPanel(
      `Searching “${esc(job.query)}”… checked <b>${job.checked}</b> of ${job.maxResults}
       results (page ${job.pages}).${rankList(job, false)}`);

    const done = async (reason, note) => {
      job.seen = [...seen];
      await finish(job, reason);
      const all = !remaining().length;
      showPanel(`${note ? note + "<br>" : ""}Results for “${esc(job.query)}”:${rankList(job, true)}`,
        { done: true, tone: all ? "ok" : Object.keys(job.found).length ? "" : "warn" });
      if (firstHit) firstHit.scrollIntoView({ behavior: "smooth", block: "center" });
      running = false;
    };

    progress();

    while (!stopRequested) {
      // Count every organic result we haven't seen yet, in order.
      for (const r of organicResults()) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        job.checked++;
        countedHere.push({ a: r.a, rank: job.checked });
        for (const d of remaining()) {
          if (hostMatches(r.url, d)) {
            job.found[d] = { rank: job.checked, url: r.url, pageUrl: location.href };
            const block = markHit(r.a, job.checked);
            if (!firstHit) firstHit = block;
          }
        }
        if (!remaining().length || job.checked >= job.maxResults) break;
      }

      // A site visible on the page but not recognised as a title still counts as found.
      for (const d of remaining()) {
        const hit = findLinkTo(d);
        if (!hit) continue;
        const block = resultBlock(hit.a);
        let rank = job.checked - countedHere.length + 1;
        for (const c of countedHere) {
          const cBlock = resultBlock(c.a);
          if (cBlock === block || cBlock.contains(hit.a)) { rank = c.rank; break; }
          if (c.a.compareDocumentPosition(hit.a) & Node.DOCUMENT_POSITION_FOLLOWING) rank = c.rank + 1;
        }
        job.found[d] = { rank, url: hit.url, pageUrl: location.href };
        const b = markHit(hit.a, rank);
        if (!firstHit) firstHit = b;
      }
      highlightLinks(job.domains);

      if (!remaining().length) return done("all_found");
      if (job.checked >= job.maxResults) return done("limit");

      if (stopRequested) break;
      job.seen = [...seen];
      await set({ [JOB_KEY]: job });
      progress();

      // Load more results: scroll (continuous scroll), click "More results", or go to the next page.
      const before = organicResults().length;
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
      if (await waitForMore(before, jitter(2500, 4000))) continue;

      const more = findMoreButton();
      if (more) {
        more.click();
        if (await waitForMore(before, 6000)) continue;
      }

      const next = document.querySelector("#pnnext, a[aria-label='Next page'], a[aria-label='Next']");
      if (next && next.href) {
        job.pages++;
        await set({ [JOB_KEY]: job });
        await sleep(jitter(800, 1600));
        if (stopRequested) break;
        location.href = next.href; // the hunt resumes on the next page
        return;
      }

      return done("no_more", `Google ran out of results after ${job.checked}.`);
    }
    running = false;
  }

  function findMoreButton() {
    const cands = document.querySelectorAll("a[aria-label='More results'], a[aria-label='More search results'], [role='button'], a, span");
    for (const el of cands) {
      const t = (el.getAttribute("aria-label") || el.textContent || "").trim().toLowerCase();
      if ((t === "more results" || t === "more search results") && el.offsetParent !== null) {
        return el.closest("a, [role='button']") || el;
      }
    }
    return null;
  }

  async function waitForMore(before, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (stopRequested) return false;
      await sleep(300);
      if (organicResults().length > before) {
        await sleep(400); // let the batch finish rendering
        return true;
      }
    }
    return false;
  }

  // ---------- "Find rank" button next to Google's search button ----------
  async function onFindRankClick(e, form) {
    e.preventDefault();
    e.stopPropagation();
    const box = form.querySelector("textarea[name='q'], input[name='q']");
    const query = (box && box.value.trim()) || currentQuery();
    const settings = (await get(SETTINGS_KEY)) || {};
    openPicker(query, settings);
  }

  // Picker: choose which saved websites to look for, or type a new one.
  function openPicker(query, settings) {
    document.getElementById("rf-modal")?.remove();
    const saved = savedDomains(settings);
    const m = document.createElement("div");
    m.id = "rf-modal";
    m.innerHTML = `
      <div class="rf-card" role="dialog" aria-label="Find rank">
        <div class="rf-card-head">Find rank<button class="rf-close" title="Close">×</button></div>
        <div class="rf-card-body">
          <label class="rf-lbl">Keyword</label>
          <input class="rf-q" value="${esc(query)}" placeholder="Type a keyword">
          <label class="rf-lbl">Which websites?</label>
          <div class="rf-sites">${saved.length ? saved.map((d) =>
            `<label class="rf-site"><input type="checkbox" value="${esc(d)}" checked> ${esc(d)}</label>`).join("")
            : '<p class="rf-empty">No saved websites yet. Type one below.</p>'}</div>
          <input class="rf-new" placeholder="Another website, e.g. example.com">
          <label class="rf-save"><input type="checkbox" class="rf-remember" checked> Save new websites to my list</label>
          <button class="rf-go">Start finding</button>
        </div>
      </div>`;
    document.documentElement.appendChild(m);
    const close = () => m.remove();
    m.addEventListener("click", (ev) => { if (ev.target === m) close(); });
    m.querySelector(".rf-close").onclick = close;
    const go = async () => {
      const q = m.querySelector(".rf-q").value.trim();
      const typed = parseDomains(m.querySelector(".rf-new").value);
      const picked = [...m.querySelectorAll(".rf-sites input:checked")].map((i) => i.value);
      const domains = parseDomains([...picked, ...typed]);
      if (!q) return m.querySelector(".rf-q").focus();
      if (!domains.length) return m.querySelector(".rf-new").focus();
      if (typed.length && m.querySelector(".rf-remember").checked) {
        await set({ [SETTINGS_KEY]: { ...settings, domains: parseDomains([...saved, ...typed]) } });
      }
      close();
      startJob(q, domains, settings.maxResults);
    };
    m.querySelector(".rf-go").onclick = go;
    m.querySelectorAll("input.rf-q, input.rf-new").forEach((i) =>
      i.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); go(); } }));
    (saved.length ? m.querySelector(query ? ".rf-go" : ".rf-q") : m.querySelector(query ? ".rf-new" : ".rf-q")).focus();
  }

  function makeButton(form, cls) {
    const b = document.createElement(cls === "rf-home-btn" ? "input" : "button");
    b.type = "button";
    b.className = "rf-find-btn " + cls;
    if (b.tagName === "INPUT") b.value = "Find rank";
    else b.textContent = "Find rank";
    b.title = "Search Google and keep loading results until your website is found";
    b.addEventListener("click", (e) => onFindRankClick(e, form));
    return b;
  }

  function injectButtons() {
    document.querySelectorAll("form[action='/search'], form[role='search']").forEach((form) => {
      if (!form.querySelector("textarea[name='q'], input[name='q']")) return;
      // Home page: next to the visible "Google Search" button.
      form.querySelectorAll("input[name='btnK']").forEach((btnK) => {
        const row = btnK.parentElement;
        if (row && !row.querySelector(".rf-find-btn")) btnK.after(makeButton(form, "rf-home-btn"));
      });
      // Results page: right after the magnifier search button.
      if (!form.querySelector(".rf-find-btn")) {
        const submit = form.querySelector("button[type='submit'], button[aria-label='Search']");
        if (submit) submit.after(makeButton(form, "rf-inline-btn"));
      }
    });
    // Fallback if Google's layout changed and nothing could be placed.
    if (!document.querySelector(".rf-find-btn")) {
      const form = document.querySelector("form[action='/search'], form[role='search']");
      if (form) {
        const b = makeButton(form, "rf-float-btn");
        document.documentElement.appendChild(b);
      }
    }
  }

  // ---------- boot ----------
  async function boot() {
    injectButtons();
    let t;
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (!document.querySelector(".rf-find-btn")) injectButtons();
      }, 300);
    }).observe(document.body, { childList: true, subtree: true });

    const settings = (await get(SETTINGS_KEY)) || {};
    if (location.pathname === "/search" && settings.alwaysHighlight !== false) {
      const domains = savedDomains(settings);
      highlightLinks(domains);
      setTimeout(() => highlightLinks(domains), 1500);
    }

    const job = await get(JOB_KEY);
    if (!job || !job.active) return;

    if (location.pathname.startsWith("/sorry") || document.querySelector("#captcha-form, form#captcha-form")) {
      showPanel("Google is asking for a CAPTCHA. Solve it, then the search will continue. " +
        "If it doesn't, click <b>Find rank</b> again.");
      return;
    }
    if (location.pathname !== "/search") return;

    // A normal search with a different query cancels the hunt, so Google behaves as usual.
    if (normalizeQuery(currentQuery()) !== normalizeQuery(job.query)) {
      job.active = false;
      job.status = "cancelled";
      await set({ [JOB_KEY]: job });
      return;
    }
    if (!job.domains) { job.domains = parseDomains(job.domain); job.found = {}; }
    hunt(job);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[JOB_KEY]) return;
    const nv = changes[JOB_KEY].newValue;
    if (running && nv && !nv.active && nv.status === "stopped") {
      stopRequested = true;
      showPanel("Stopped.", { done: true });
    }
  });

  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();

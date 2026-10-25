const $ = (id) => document.getElementById(id);
const get = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k])));
const set = (o) => new Promise((r) => chrome.storage.local.set(o, r));

function normalizeDomain(input) {
  let d = String(input || "").trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "");
  return d.replace(/^www\./, "");
}
function parseDomains(list) {
  const arr = Array.isArray(list) ? list : String(list || "").split(/[\s,]+/);
  return [...new Set(arr.map(normalizeDomain).filter(Boolean))];
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function load() {
  const s = (await get("rfSettings")) || {};
  $("domains").value = parseDomains(s.domains || s.domain || []).join("\n");
  $("query").value = s.query || "";
  if (s.maxResults) $("max").value = String(s.maxResults);
  render();
}

async function saveSettings() {
  const s = (await get("rfSettings")) || {};
  s.domains = parseDomains($("domains").value);
  delete s.domain;
  s.query = $("query").value.trim();
  s.maxResults = Number($("max").value);
  await set({ rfSettings: s });
  return s;
}

async function render() {
  const job = await get("rfJob");
  const st = $("status");
  st.className = "";
  if (job && job.domains) {
    st.classList.add("show");
    const found = job.found || {};
    const lines = job.domains.map((d) => found[d]
      ? `<b>#${found[d].rank}</b> ${esc(d)}`
      : `${job.active ? "…" : "–"} ${esc(d)}${job.active ? "" : ` <span class="muted">not in top ${job.checked}</span>`}`).join("<br>");
    if (job.active) st.innerHTML = `Searching “${esc(job.query)}”… checked ${job.checked} results (page ${job.pages}).<br>${lines}`;
    else if (job.status === "stopped") st.textContent = "Stopped.";
    else if (job.status === "cancelled") st.classList.remove("show");
    else {
      st.classList.add(job.status === "not_found" ? "warn" : "ok");
      st.innerHTML = `Results for “${esc(job.query)}”:<br>${lines}`;
    }
  }
  const h = (await get("rfHistory")) || [];
  $("history").innerHTML = h.length ? h.map((x) =>
    `<li>${x.found ? `<b>#${x.rank}</b>` : `<span class="nf">&gt;${x.checked}</span>`} ${esc(x.domain)} · “${esc(x.query)}”
     <span class="muted">${new Date(x.at).toLocaleString()}</span></li>`).join("")
    : '<li class="muted">None yet</li>';
}

$("find").onclick = async () => {
  const s = await saveSettings();
  if (!s.domains.length) return $("domains").focus();
  if (!s.query) return $("query").focus();
  await set({ rfJob: { active: true, query: s.query, domains: s.domains, found: {}, maxResults: s.maxResults,
    checked: 0, seen: [], pages: 1, startedAt: Date.now(), status: "searching" } });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let origin = "https://www.google." + (s.googleTld || "com");
  try {
    const u = new URL(tab.url);
    if (/^www\.google\.[a-z.]+$/.test(u.hostname)) origin = u.origin;
  } catch {}
  const url = `${origin}/search?q=${encodeURIComponent(s.query)}`;
  if (tab && /^https?:/.test(tab.url || "")) await chrome.tabs.update(tab.id, { url });
  else await chrome.tabs.create({ url });
  window.close();
};

$("settings").onclick = () => chrome.runtime.openOptionsPage();

$("stop").onclick = async () => {
  const job = await get("rfJob");
  if (job && job.active) { job.active = false; job.status = "stopped"; await set({ rfJob: job }); }
  render();
};

["domains", "query", "max"].forEach((id) => $(id).addEventListener("change", saveSettings));
chrome.storage.onChanged.addListener(render);
load();

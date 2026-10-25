const $ = (id) => document.getElementById(id);
const get = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k])));
const set = (o) => new Promise((r) => chrome.storage.local.set(o, r));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function normalizeDomain(input) {
  let d = String(input || "").trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "");
  return d.replace(/^www\./, "");
}
function parseDomains(list) {
  const arr = Array.isArray(list) ? list : String(list || "").split(/[\s,]+/);
  return [...new Set(arr.map(normalizeDomain).filter(Boolean))];
}
function hostMatches(url, domain) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host === domain || host.endsWith("." + domain);
  } catch { return false; }
}

const GOOGLE_SITES = ["com", "com.pk", "co.uk", "ca", "com.au", "co.in", "ae", "com.sa", "de", "fr", "es", "it", "nl",
  "com.br", "com.mx", "co.za", "ie", "co.nz", "com.sg", "com.ph", "com.ng", "com.tr", "com.bd", "com.eg", "com.my", "co.id"];

async function settings() {
  const s = (await get("rfSettings")) || {};
  s.domains = parseDomains(s.domains || s.domain || []);
  delete s.domain;
  return s;
}

let savedTimer;
async function save(patch) {
  const s = { ...(await settings()), ...patch };
  await set({ rfSettings: s });
  $("saved").classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $("saved").classList.remove("show"), 1400);
  return s;
}

function renderSites(domains) {
  $("sites").innerHTML = domains.length
    ? domains.map((d) => `<li>${esc(d)} <button data-d="${esc(d)}" title="Remove">×</button></li>`).join("")
    : '<li class="empty">No websites yet. Add your first one above.</li>';
  $("sites").querySelectorAll("button").forEach((b) => b.onclick = async () => {
    const s = await settings();
    renderSites((await save({ domains: s.domains.filter((x) => x !== b.dataset.d) })).domains);
  });
}

async function renderLast() {
  const job = await get("rfJob");
  if (!job || !job.domains) return;
  const found = job.found || {};
  const state = job.active ? "running now" : job.status === "stopped" ? "stopped" : "finished";
  $("last").innerHTML = `<p class="help">“${esc(job.query)}” · ${job.checked} results checked · ${state}</p>
    <div class="ranks">${job.domains.map((d) => found[d]
      ? `<div class="rank"><span class="num">#${found[d].rank}</span><div><b>${esc(d)}</b> · page ${Math.ceil(found[d].rank / 10)}<br>
         <a href="${esc(found[d].url)}" target="_blank" rel="noopener">${esc(found[d].url)}</a></div></div>`
      : `<div class="rank"><span class="num none">${job.active ? "…" : "–"}</span><div><b>${esc(d)}</b><br>
         <span class="help">${job.active ? "searching" : `not in the top ${job.checked}`}</span></div></div>`).join("")}</div>`;
  const seen = job.seen || [];
  $("countedWrap").hidden = !seen.length;
  $("counted").innerHTML = seen.map((u) =>
    `<li class="${job.domains.some((d) => hostMatches(u, d)) ? "mine" : ""}">${esc(u)}</li>`).join("");
}

async function renderHistory() {
  const h = (await get("rfHistory")) || [];
  $("history").innerHTML = h.length ? h.map((x) => `<tr>
      <td>${x.found ? `<span class="pill">#${x.rank}</span>` : `<span class="pill none">&gt;${x.checked}</span>`}</td>
      <td><b>${esc(x.domain)}</b></td><td>${esc(x.query)}</td>
      <td>${new Date(x.at).toLocaleString()}</td></tr>`).join("")
    : '<tr><td colspan="4" class="help">No checks yet.</td></tr>';
}

async function load() {
  const s = await settings();
  renderSites(s.domains);
  $("query").value = s.query || "";
  $("max").value = String(s.maxResults || 100);
  $("gdomain").innerHTML = GOOGLE_SITES.map((t) => `<option value="${t}">google.${t}</option>`).join("");
  $("gdomain").value = s.googleTld || "com";
  $("always").checked = s.alwaysHighlight !== false;
  renderLast();
  renderHistory();
}

$("addForm").onsubmit = async (e) => {
  e.preventDefault();
  const add = parseDomains($("newSite").value);
  if (!add.length) return $("newSite").focus();
  const s = await settings();
  renderSites((await save({ domains: parseDomains([...s.domains, ...add]) })).domains);
  $("newSite").value = "";
};
$("query").onchange = () => save({ query: $("query").value.trim() });
$("max").onchange = () => save({ maxResults: Number($("max").value) });
$("gdomain").onchange = () => save({ googleTld: $("gdomain").value });
$("always").onchange = () => save({ alwaysHighlight: $("always").checked });
$("clear").onclick = async () => { if (confirm("Clear all saved checks?")) { await set({ rfHistory: [] }); renderHistory(); } };

chrome.storage.onChanged.addListener((c) => {
  if (c.rfJob) renderLast();
  if (c.rfHistory) renderHistory();
});
load();

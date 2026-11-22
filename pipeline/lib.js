const crypto = require("crypto");
const cheerio = require("cheerio");

const CATEGORIES = [
  "Call for Papers", "Call for Proposal", "Upcoming Conferences", "UN & Regulatory Inputs",
  "Judgments & Legislation", "Grants & Fellowships", "Research Collaboration", "Investigative Brief"
];
const DEADLINE_TYPES = ["submission", "abstract", "registration", "application", "event_date", "none"];

const sha = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);
const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normUrl(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/.test(k)) x.searchParams.delete(k);
    return (x.origin + x.pathname.replace(/\/+$/, "") + x.search).toLowerCase();
  } catch { return null; }
}

function htmlToText(html) {
  const $ = cheerio.load(html || "");
  $("script,style,nav,footer,header,form,noscript,iframe").remove();
  return $("body").text().replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
function htmlLinks(html, base) {
  const $ = cheerio.load(html || "");
  const out = new Set();
  $("a[href]").each((_, a) => {
    try { const u = new URL($(a).attr("href"), base); if (/^https?:$/.test(u.protocol)) out.add(u.href); } catch {}
  });
  return [...out];
}

const UA = "LEXINTEL-bot/0.1 (academic opportunity aggregator; respects robots.txt)";
const lastHit = new Map();
const robotsCache = new Map();

async function rawFetch(url, { timeout = 20000, fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    return await fetchImpl(url, { signal: ctl.signal, headers: { "user-agent": UA, accept: "text/html,application/xml,application/rss+xml,*/*" }, redirect: "follow" });
  } finally { clearTimeout(t); }
}

async function robotsAllowed(url, opts) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    let rules = [];
    try {
      const r = await rawFetch(u.origin + "/robots.txt", opts);
      if (r.ok) {
        let applies = false;
        for (const line of (await r.text()).split(/\r?\n/)) {
          const m = line.replace(/#.*/, "").match(/^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i);
          if (!m) continue;
          const [k, v] = [m[1].toLowerCase(), m[2]];
          if (k === "user-agent") applies = v === "*" || /lexintel/i.test(v);
          else if (applies && k === "disallow" && v) rules.push(v);
        }
      }
    } catch { /* unreachable robots.txt: fail open */ }
    robotsCache.set(u.origin, rules);
  }
  return !robotsCache.get(u.origin).some((p) => (u.pathname + u.search).startsWith(p.replace(/\*$/, "")));
}

async function politeFetch(url, opts = {}) {
  if (!(await robotsAllowed(url, opts))) throw new Error(`blocked by robots.txt: ${url}`);
  const host = new URL(url).host;
  const wait = (lastHit.get(host) || 0) + (opts.delayMs ?? 600) - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
  const r = await rawFetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

module.exports = { CATEGORIES, DEADLINE_TYPES, sha, squash, slug, sleep, normUrl, htmlToText, htmlLinks, politeFetch, robotsCache, lastHit };

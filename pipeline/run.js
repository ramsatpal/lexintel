#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { sha, normUrl, slug } = require("./lib");
const { fetchSource } = require("./sources");
const { extractEntries } = require("./extract");

const ROOT = path.join(__dirname, "..");
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const daysBetween = (a, b) => Math.floor((new Date(a) - new Date(b)) / 864e5);
const ymd = (d) => d.toISOString().slice(0, 10);

async function pool(items, n, fn) {
  const res = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k]); } }));
  return res;
}

function dedupe(entries) {
  const byKey = new Map();
  for (const e of entries) {
    const key = e.official_url ? normUrl(e.official_url) : `${slug(e.title)}|${e.deadline || ""}`;
    const cur = byKey.get(key);
    if (!cur) { byKey.set(key, { ...e, also_listed_at: [] }); continue; }
    const better = (e.source_tier === "primary" && cur.source_tier !== "primary") || (!cur.deadline && e.deadline) || (!cur.official_url && e.official_url);
    const [keep, other] = better ? [{ ...e, also_listed_at: cur.also_listed_at }, cur] : [cur, e];
    keep.also_listed_at.push({ name: other.source_name, url: other.source_post_url });
    byKey.set(key, keep);
  }
  return [...byKey.values()];
}

async function run(opts) {
  const {
    sourcesPath = path.join(__dirname, "sources.json"), statePath = path.join(__dirname, "state.json"),
    reviewsPath = path.join(__dirname, "reviews.json"), outPath = path.join(ROOT, "docs", "feed.json"),
    llm, today = ymd(new Date()), fetchOpts = {}, maxExtractions = Number(process.env.MAX_EXTRACTIONS_PER_RUN || 60),
    maxPostAgeDays = 150, undatedKeepDays = 45
  } = opts;

  const sources = readJson(sourcesPath, []);
  const state = readJson(statePath, { posts: {} });
  const reviews = readJson(reviewsPath, {});
  const prior = readJson(outPath, { items: [] });
  const firstSeen = new Map((prior.items || []).map((i) => [i.id, i.first_seen]));
  const status = [];
  let budget = maxExtractions;
  const all = [];

  for (const src of sources) {
    const st = { id: src.id, name: src.name, tier: src.tier, ok: false, posts_seen: 0, posts_extracted: 0, posts_failed: 0, entries: 0, error: null };
    try {
      let posts = await fetchSource(src, fetchOpts);
      posts = posts.filter((p) => !p.published || daysBetween(today, p.published) <= maxPostAgeDays)
        .sort((a, b) => (b.published || "").localeCompare(a.published || ""));
      st.posts_seen = posts.length;
      const todo = [];
      for (const p of posts) {
        const hash = sha(p.text);
        const cached = state.posts[p.url];
        if (cached && cached.hash === hash) all.push(...cached.entries);
        else todo.push({ p, hash });
      }
      const batch = todo.slice(0, Math.max(0, budget));
      budget -= batch.length;
      await pool(batch, 3, async ({ p, hash }) => {
        try {
          const entries = await extractEntries(p, { llm, today, source: src });
          state.posts[p.url] = { hash, entries, extracted_at: new Date().toISOString() };
          all.push(...entries); st.posts_extracted++;
        } catch (e) { st.posts_failed++; st.error = `extraction: ${e.message}`.slice(0, 200); }
      });
      st.ok = true;
      if (todo.length > batch.length) st.error = `${todo.length - batch.length} post(s) deferred to next run (extraction budget)`;
    } catch (e) { st.error = String(e.message || e).slice(0, 240); }
    status.push(st);
  }

  if (!status.some((s) => s.ok)) {
    console.error("All sources failed; feed NOT overwritten.");
    status.forEach((s) => console.error(` - ${s.id}: ${s.error}`));
    return { ok: false, status };
  }

  const now = new Date().toISOString();
  let items = dedupe(all).filter((e) => !e.deadline || e.deadline >= today);
  items = items.filter((e) => e.deadline || daysBetween(today, (firstSeen.get(e.id) || now)) <= undatedKeepDays);
  items = items.filter((e) => reviews[e.id]?.status !== "rejected");
  items = items.map((e) => ({
    ...e, first_seen: firstSeen.get(e.id) || now,
    review: reviews[e.id]?.status === "approved" ? { status: "approved", by: reviews[e.id].by, at: reviews[e.id].at } : { status: "pending" }
  }));
  items.sort((a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999") || a.title.localeCompare(b.title));
  for (const s of status) s.entries = items.filter((i) => i.source_id === s.id).length;

  // prune state of posts no longer served
  const livePosts = new Set(all.map((e) => e.source_post_url));
  for (const [u, v] of Object.entries(state.posts)) if (!livePosts.has(u) && daysBetween(today, (v.extracted_at || now)) > maxPostAgeDays) delete state.posts[u];

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
  fs.writeFileSync(outPath, JSON.stringify({
    schema: 1, generated_at: now, today,
    counts: { total: items.length, reviewed: items.filter((i) => i.review.status === "approved").length, needs_check: items.filter((i) => i.needs_check).length },
    sources: status, items
  }, null, 1));
  console.log(`feed.json: ${items.length} items from ${status.filter((s) => s.ok).length}/${status.length} sources`);
  status.forEach((s) => console.log(` - ${s.ok ? "ok " : "ERR"} ${s.id}: ${s.entries} entries${s.error ? " | " + s.error : ""}`));
  return { ok: true, status, items };
}

module.exports = { run, dedupe };
if (require.main === module) {
  run({ llm: require("./llm")() }).then((r) => process.exit(r.ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
}

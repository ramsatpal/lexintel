const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const HTML = fs.readFileSync(path.join(__dirname, "..", "www", "index.html"), "utf8").replace("YOUR-GITHUB-USERNAME.github.io/YOUR-REPO", "example.test/lex");
const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const item = (o) => ({ id: "x" + Math.random().toString(36).slice(2, 8), title: "T", category: "Call for Papers", organiser: "Org", deadline: iso(10), deadline_type: "submission", evidence: null, official_url: "https://example.org/a", summary: "S", tags: ["AI"], needs_check: false, flags: [], source_id: "s", source_name: "Src", source_tier: "aggregator", source_post_url: "https://example.org/post", first_seen: "2026-11-01T00:00:00Z", review: { status: "pending" }, also_listed_at: [], ...o });

function boot(fetchImpl, storage = {}) {
  const dom = new JSDOM(HTML, { runScripts: "dangerously", url: "https://localhost/", pretendToBeVisual: true,
    beforeParse(w) { w.fetch = fetchImpl; for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v); } });
  return dom;
}
const ok = (feed) => async () => ({ ok: true, status: 200, json: async () => feed });
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const FEED = (items) => ({ schema: 1, generated_at: new Date().toISOString(), sources: [{ name: "Src", tier: "aggregator", ok: true, entries: items.length }, { name: "Broken", tier: "aggregator", ok: false, entries: 0, error: "HTTP 404" }], items });

test("renders live feed, hides expired, sorts by deadline, escapes hostile content", async () => {
  const evil = item({ title: '<img src=x onerror="window.__pwned=1">Evil', summary: "<script>window.__pwned=1</script>", official_url: "javascript:window.__pwned=1", tags: ['"><b>x</b>'] });
  const feed = FEED([item({ title: "Later", deadline: iso(40) }), item({ title: "Expired", deadline: iso(-1) }), item({ title: "Soon", deadline: iso(3), review: { status: "approved", by: "Aman" }, needs_check: true, flags: ["official_url_not_found_in_source"] }), item({ title: "Undated", deadline: null, deadline_type: "none" }), evil]);
  const dom = boot(ok(feed)); await settle();
  const doc = dom.window.document;
  const titles = [...doc.querySelectorAll("#feed h2")].map((h) => h.textContent);
  assert.ok(!titles.includes("Expired"));
  assert.deepStrictEqual([titles[0], titles[2], titles[3]], ["Soon", "Later", "Undated"]); // evil item (10d) sorts between; undated last
  assert.ok(titles[1].startsWith("<img"), "hostile title must render as literal text");
  assert.strictEqual(titles.filter((t) => t === "Undated").length, 1);
  assert.strictEqual(doc.querySelector("#showing").textContent, "Showing 4 of 4 open items");
  assert.ok(doc.querySelector("#feed").textContent.includes("✓ Reviewed by Aman"));
  assert.ok(doc.querySelector("#feed").textContent.includes("Verify details"));
  assert.ok(doc.querySelector("#status-line").textContent.startsWith("Live"));
  // hostile content inert
  assert.strictEqual(dom.window.__pwned, undefined);
  assert.strictEqual(doc.querySelectorAll("#feed img, #feed script").length, 0);
  assert.ok(![...doc.querySelectorAll("#feed a")].some((a) => a.href.startsWith("javascript:")));
  // sources shown honestly
  assert.ok(doc.querySelector("#sources").textContent.includes("FAILED"));
  dom.window.close();
});

test("filters, search, tracker with persistence, and offline fallback", async () => {
  const a = item({ title: "AI Liability", category: "Grants & Fellowships", deadline: iso(5), organiser: "LawAI", tags: ["AI Governance"] });
  const b = item({ title: "Marine Law", deadline: iso(60), organiser: "UN", tags: ["Environment"] });
  const feed = FEED([a, b]);
  let dom = boot(ok(feed)); await settle();
  let doc = dom.window.document;
  doc.querySelector("#f-within").value = "7"; doc.querySelector("#f-within").dispatchEvent(new dom.window.Event("change"));
  assert.deepStrictEqual([...doc.querySelectorAll("#feed h2")].map((h) => h.textContent), ["AI Liability"]);
  doc.querySelector("#f-within").value = "all"; doc.querySelector("#f-within").dispatchEvent(new dom.window.Event("change"));
  doc.querySelector("#q").value = "marine"; doc.querySelector("#q").dispatchEvent(new dom.window.Event("input"));
  assert.deepStrictEqual([...doc.querySelectorAll("#feed h2")].map((h) => h.textContent), ["Marine Law"]);
  doc.querySelector("#q").value = ""; doc.querySelector("#q").dispatchEvent(new dom.window.Event("input"));
  // track
  doc.querySelector(`[data-stage-id="${a.id}"][data-stage="Drafting"]`).click();
  assert.strictEqual(doc.querySelector("#pipeline-count").textContent, "1");
  const note = doc.querySelector(`[data-note-id="${a.id}"]`); note.value = "co-author: Sneha"; note.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.ok(doc.querySelector("#due-soon").textContent.includes("AI Liability"));
  const saved = { lexintel_user_v1: dom.window.localStorage.getItem("lexintel_user_v1"), lexintel_feed_cache_v1: dom.window.localStorage.getItem("lexintel_feed_cache_v1") };
  assert.ok(saved.lexintel_feed_cache_v1);
  dom.window.close();

  // offline relaunch: fetch fails, cache + tracked state survive
  dom = boot(async () => { throw new Error("network down"); }, saved); await settle();
  doc = dom.window.document;
  assert.strictEqual(doc.querySelectorAll("#feed h2").length, 2);
  assert.ok(doc.querySelector("#status-line").textContent.startsWith("Offline copy"));
  assert.ok(doc.querySelector("#banner").textContent.includes("Showing the last saved copy"));
  assert.ok(doc.querySelector(`[data-note-id="${a.id}"]`).value.includes("Sneha"));
  dom.window.close();
});

test("tracked item keeps living after it leaves the feed; deadline change is flagged", async () => {
  const a = item({ title: "Tracked One", deadline: iso(20) });
  let dom = boot(ok(FEED([a]))); await settle();
  dom.window.document.querySelector(`[data-stage-id="${a.id}"][data-stage="Saved"]`).click();
  const saved = { lexintel_user_v1: dom.window.localStorage.getItem("lexintel_user_v1"), lexintel_feed_cache_v1: dom.window.localStorage.getItem("lexintel_feed_cache_v1") };
  dom.window.close();
  dom = boot(ok(FEED([{ ...a, deadline: iso(25) }])), saved); await settle();
  assert.ok(dom.window.document.querySelector("#view-pipeline").textContent.includes("Deadline changed in the feed"));
  dom.window.close();
  dom = boot(ok(FEED([])), saved); await settle();
  assert.ok(dom.window.document.querySelector("#view-pipeline").textContent.includes("Tracked One"));
  dom.window.close();
});

test("empty/unconfigured/stale states are explained, not blank", async () => {
  let dom = boot(ok({ schema: 1, generated_at: null, sources: [], items: [] })); await settle();
  assert.ok(dom.window.document.querySelector("#banner").textContent.includes("hasn't run yet"));
  dom.window.close();
  dom = boot(async () => { throw new Error("x"); }); await settle();
  assert.ok(dom.window.document.querySelector("#banner").textContent.includes("Could not load the feed"));
  dom.window.close();
  const stale = FEED([item({})]); stale.generated_at = new Date(Date.now() - 5 * 864e5).toISOString();
  dom = boot(ok(stale)); await settle();
  assert.ok(dom.window.document.querySelector("#banner").textContent.includes("over 3 days"));
  dom.window.close();
});

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { run } = require("../pipeline/run");

const TODAY = "2026-11-22";
const POST_HTML = `<p>Call for papers: Digital Rights Symposium. Submission deadline is 31 January 2027, 11:59 pm IST.
Details at <a href="https://example.org/drs-2027">the symposium page</a>.</p>
<p>Special issue on AI liability. Abstracts due 15 December 2026. Apply via <a href="https://journal.example/ai-liability">this link</a>.</p>
<p>Fellowship on tech policy; no deadline stated yet.</p><p>Old workshop: deadline 1 October 2026.</p>`;

function server() {
  const feed = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>t</title>
  <item><title>Announcements roundup</title><link>http://HOST/post-1</link><pubDate>Mon, 16 Nov 2026 10:00:00 GMT</pubDate>
  <content:encoded><![CDATA[${POST_HTML}]]></content:encoded></item></channel></rss>`;
  return new Promise((res) => {
    const s = http.createServer((q, r) => {
      if (q.url === "/cat/feed/") { r.setHeader("content-type", "application/rss+xml"); r.end(feed.replace(/HOST/g, q.headers.host)); }
      else if (q.url === "/blocked/feed/") { r.statusCode = 500; r.end("x"); }
      else { r.statusCode = 404; r.end("nf"); }
    }).listen(0, "127.0.0.1", () => res(s));
  });
}

test("extraction guardrails, caching, expiry, review, source failure isolation", async () => {
  const s = await server();
  const base = `http://127.0.0.1:${s.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lx-"));
  const p = (f) => path.join(dir, f);
  fs.writeFileSync(p("sources.json"), JSON.stringify([
    { id: "good", name: "Good Source", tier: "aggregator", type: "wp", url: base + "/cat/", roundup: true, maxPosts: 5 },
    { id: "bad", name: "Broken Source", tier: "aggregator", type: "wp", url: base + "/blocked/", maxPosts: 5 }
  ]));
  let calls = 0;
  const llm = async () => { calls++; return "```json\n" + JSON.stringify([
    { title: "Digital Rights Symposium", category: "Call for Papers", organiser: null, deadline: "2027-01-31", deadline_type: "submission",
      evidence: "Submission deadline is 31 January 2027, 11:59 pm IST", official_url: "https://example.org/drs-2027", summary: "s", tags: ["Digital Rights"] },
    { title: "AI Liability Special Issue", category: "Call for Papers", deadline: "2026-12-15", deadline_type: "abstract",
      evidence: "Abstracts due 15 December 2026", official_url: "https://hallucinated.example/fake", summary: "s", tags: [] },
    { title: "Tech Policy Fellowship", category: "Grants & Fellowships", deadline: "2027-03-01", deadline_type: "application",
      evidence: "applications close 1 March 2027", official_url: null, summary: "s", tags: [] },
    { title: "Wrong Date Item", category: "Call for Papers", deadline: "2026-12-20", deadline_type: "abstract",
      evidence: "Abstracts due 15 December 2026", official_url: null, summary: "s", tags: [] },
    { title: "Old Workshop", category: "Upcoming Conferences", deadline: "2026-10-01", deadline_type: "submission",
      evidence: "deadline 1 October 2026", official_url: null, summary: "s", tags: [] },
    { title: "Bad Category", category: "Nonsense", deadline: null, deadline_type: "none", evidence: null, official_url: null, summary: "", tags: [] }
  ]) + "\n```"; };
  const args = { sourcesPath: p("sources.json"), statePath: p("state.json"), reviewsPath: p("reviews.json"), outPath: p("feed.json"), llm, today: TODAY, fetchOpts: { delayMs: 0 } };

  const r1 = await run(args);
  assert.ok(r1.ok);
  const feed = JSON.parse(fs.readFileSync(p("feed.json"), "utf8"));
  const byTitle = Object.fromEntries(feed.items.map((i) => [i.title, i]));

  assert.deepStrictEqual(Object.keys(byTitle).sort(), ["AI Liability Special Issue", "Digital Rights Symposium", "Tech Policy Fellowship", "Wrong Date Item"]);
  assert.strictEqual(byTitle["Digital Rights Symposium"].deadline, "2027-01-31");
  assert.strictEqual(byTitle["Digital Rights Symposium"].official_url, "https://example.org/drs-2027");
  assert.strictEqual(byTitle["Digital Rights Symposium"].needs_check, false);
  // hallucinated URL stripped + flagged, valid deadline kept
  assert.strictEqual(byTitle["AI Liability Special Issue"].official_url, null);
  assert.ok(byTitle["AI Liability Special Issue"].flags.includes("official_url_not_found_in_source"));
  assert.strictEqual(byTitle["AI Liability Special Issue"].deadline, "2026-12-15");
  // fabricated evidence -> deadline nulled
  assert.strictEqual(byTitle["Tech Policy Fellowship"].deadline, null);
  assert.ok(byTitle["Tech Policy Fellowship"].flags.includes("deadline_evidence_not_found_in_source"));
  // ISO date inconsistent with real evidence -> deadline nulled
  assert.strictEqual(byTitle["Wrong Date Item"].deadline, null);
  assert.ok(byTitle["Wrong Date Item"].flags.includes("deadline_does_not_match_evidence"));
  // sorted: dated first, undated last
  assert.strictEqual(feed.items[0].title, "AI Liability Special Issue");
  // broken source isolated and reported
  const bad = feed.sources.find((x) => x.id === "bad");
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /HTTP \d{3}|no feed/);
  assert.strictEqual(feed.sources.find((x) => x.id === "good").ok, true);
  assert.ok(feed.items.every((i) => i.review.status === "pending"));

  // cache: unchanged post is not re-extracted
  const before = calls;
  await run(args);
  assert.strictEqual(calls, before);

  // human review: approve one, reject one
  const dr = byTitle["Digital Rights Symposium"].id, ai = byTitle["AI Liability Special Issue"].id;
  fs.writeFileSync(p("reviews.json"), JSON.stringify({ [dr]: { status: "approved", by: "Aman", at: "2026-11-22T00:00:00Z" }, [ai]: { status: "rejected", by: "Aman", at: "x" } }));
  await run(args);
  const f2 = JSON.parse(fs.readFileSync(p("feed.json"), "utf8"));
  assert.strictEqual(f2.items.find((i) => i.id === dr).review.status, "approved");
  assert.strictEqual(f2.items.find((i) => i.id === dr).review.by, "Aman");
  assert.ok(!f2.items.some((i) => i.id === ai));

  // expiry on a later day, without re-calling the model
  await run({ ...args, today: "2027-02-01" });
  const f3 = JSON.parse(fs.readFileSync(p("feed.json"), "utf8"));
  assert.ok(!f3.items.some((i) => i.title === "Digital Rights Symposium"));

  // all sources failing must not overwrite the feed
  fs.writeFileSync(p("sources.json"), JSON.stringify([{ id: "bad", name: "x", tier: "aggregator", type: "wp", url: base + "/blocked/" }]));
  const sizeBefore = fs.statSync(p("feed.json")).mtimeMs;
  const r4 = await run(args);
  assert.strictEqual(r4.ok, false);
  assert.strictEqual(fs.statSync(p("feed.json")).mtimeMs, sizeBefore);
  s.closeAllConnections(); s.close();
});

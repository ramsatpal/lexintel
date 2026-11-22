#!/usr/bin/env node
// Human review CLI. Approvals are recorded in pipeline/reviews.json and committed to git, so every approval has an identity and timestamp.
//   node pipeline/review.js list
//   node pipeline/review.js approve <id...> --by "Your Name"
//   node pipeline/review.js reject <id...> --by "Your Name"
const fs = require("fs"), path = require("path");
const RV = path.join(__dirname, "reviews.json"), FEED = path.join(__dirname, "..", "docs", "feed.json");
const read = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const [cmd, ...rest] = process.argv.slice(2);
const byIdx = rest.indexOf("--by");
const by = byIdx >= 0 ? rest.splice(byIdx, 2)[1] : null;
const feed = read(FEED, { items: [] });
if (cmd === "list") {
  for (const i of feed.items.filter((x) => x.review.status === "pending")) {
    console.log(`\n${i.id}  [${i.category}]  ${i.title}\n  deadline: ${i.deadline || "—"} (${i.deadline_type})${i.needs_check ? "  ⚠ " + i.flags.join(",") : ""}\n  evidence: ${i.evidence ? `"${i.evidence}"` : "—"}\n  official: ${i.official_url || "—"}\n  listed at: ${i.source_name} ${i.source_post_url}`);
  }
} else if (cmd === "approve" || cmd === "reject") {
  if (!by) { console.error('Pass --by "Your Name" so the review is attributable.'); process.exit(1); }
  const rv = read(RV, {});
  for (const id of rest) {
    if (!feed.items.some((i) => i.id === id) && !rv[id]) { console.error("unknown id " + id); continue; }
    rv[id] = { status: cmd === "approve" ? "approved" : "rejected", by, at: new Date().toISOString() };
  }
  fs.writeFileSync(RV, JSON.stringify(rv, null, 1));
  console.log(`${cmd}d ${rest.length} item(s). Commit pipeline/reviews.json to publish.`);
} else { console.error("usage: review.js list | approve <id...> --by NAME | reject <id...> --by NAME"); process.exit(1); }

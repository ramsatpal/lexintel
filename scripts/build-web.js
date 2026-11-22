// Builds www/ from src/index.src.html: bundles Tailwind + Inter locally so the app works offline.
const fs = require("fs"), path = require("path"), cp = require("child_process");
const root = path.join(__dirname, "..");
const www = path.join(root, "www");
fs.mkdirSync(path.join(www, "fonts"), { recursive: true });
for (const w of [400, 500, 600, 700]) {
  fs.copyFileSync(
    path.join(root, `node_modules/@fontsource/inter/files/inter-latin-${w}-normal.woff2`),
    path.join(www, `fonts/inter-${w}.woff2`)
  );
}
cp.execSync(`npx tailwindcss -c tailwind.config.js -i src/input.css -o www/app.css --minify`, { cwd: root, stdio: "inherit" });
let html = fs.readFileSync(path.join(root, "src/index.src.html"), "utf8");
html = html
  .replace(/<script src="https:\/\/cdn\.tailwindcss\.com[^"]*"><\/script>/, "")
  .replace(/<link rel="preconnect"[^>]*>\s*/g, "")
  .replace(/<link href="https:\/\/fonts\.googleapis\.com[^>]*>/, '<link rel="stylesheet" href="app.css" />')
  .replace('content="width=device-width, initial-scale=1.0"', 'content="width=device-width, initial-scale=1.0, viewport-fit=cover"');
const cfg = JSON.parse(fs.readFileSync(path.join(root, "app.config.json"), "utf8"));
const feedUrl = process.env.LEXINTEL_FEED_URL || cfg.feedUrl || "";
html = html.replace("__FEED_URL__", JSON.stringify(feedUrl).slice(1, -1));
if (/YOUR-GITHUB/.test(feedUrl)) console.warn("WARNING: feedUrl in app.config.json is still the placeholder; the app will show 'Feed URL not configured'.");
if (/cdn\.tailwindcss|fonts\.googleapis/.test(html)) throw new Error("CDN reference still present");
fs.writeFileSync(path.join(www, "index.html"), html);
console.log("www/ built");

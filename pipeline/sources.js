const cheerio = require("cheerio");
const { XMLParser } = require("fast-xml-parser");
const { htmlToText, htmlLinks, politeFetch } = require("./lib");

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", processEntities: true });
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const txt = (x) => (x == null ? "" : typeof x === "object" ? x["#text"] ?? "" : String(x));
const looksXml = (s) => /^\s*(<\?xml|<rss|<feed|<rdf)/i.test(s);
const iso = (d) => { const t = new Date(d); return isNaN(t) ? null : t.toISOString(); };

function parseFeed(body, feedUrl) {
  const doc = xml.parse(body);
  const out = [];
  if (doc.rss) {
    for (const it of arr(doc.rss.channel?.item)) {
      const html = txt(it["content:encoded"]) || txt(it.description);
      out.push({ url: txt(it.link).trim(), title: txt(it.title).trim(), published: iso(txt(it.pubDate)), html });
    }
  } else if (doc.feed) {
    for (const e of arr(doc.feed.entry)) {
      const links = arr(e.link);
      const alt = links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") || links[0];
      out.push({ url: alt?.["@_href"] || "", title: txt(e.title).trim(), published: iso(txt(e.published) || txt(e.updated)), html: txt(e.content) || txt(e.summary) });
    }
  } else if (doc["rdf:RDF"]) {
    for (const it of arr(doc["rdf:RDF"].item)) out.push({ url: txt(it.link).trim(), title: txt(it.title).trim(), published: iso(txt(it["dc:date"])), html: txt(it.description) });
  } else throw new Error(`unrecognised feed format at ${feedUrl}`);
  return out.filter((p) => p.url);
}

async function fetchWp(src, opts) {
  const base = src.url.replace(/\/?$/, "/");
  let body = null, feedUrl = base + "feed/";
  try { body = await politeFetch(feedUrl, opts); } catch { body = null; }
  if (!body || !looksXml(body)) {
    const page = await politeFetch(src.url, opts);
    const $ = cheerio.load(page);
    const href = $('link[rel="alternate"][type*="rss"],link[rel="alternate"][type*="atom"]').first().attr("href");
    if (!href) throw new Error("no feed found (tried /feed/ and <link rel=alternate>)");
    feedUrl = new URL(href, src.url).href;
    body = await politeFetch(feedUrl, opts);
  }
  return parseFeed(body, feedUrl).slice(0, src.maxPosts || 10).map((p) => ({
    url: p.url, title: p.title, published: p.published, text: htmlToText(p.html), links: htmlLinks(p.html, p.url)
  }));
}

async function fetchHtmlLinks(src, opts) {
  const index = await politeFetch(src.url, opts);
  const re = new RegExp(src.linkPattern);
  const urls = htmlLinks(index, src.url).filter((u) => re.test(new URL(u).pathname)).slice(0, src.maxPosts || 20);
  if (urls.length === 0) throw new Error("index page contained no links matching linkPattern (page may be JS-rendered or changed)");
  const posts = [];
  for (const url of urls) {
    try {
      const html = await politeFetch(url, opts);
      const $ = cheerio.load(html);
      const title = ($('meta[property="og:title"]').attr("content") || $("h1").first().text() || $("title").text()).trim();
      const published = iso($('meta[property="article:published_time"]').attr("content") || "");
      const main = $("main").html() || $("article").html() || $("body").html();
      posts.push({ url, title, published, text: htmlToText(main), links: htmlLinks(main, url) });
    } catch (e) { /* skip single page; counted as partial by caller via fewer posts */ }
  }
  return posts;
}

async function fetchSource(src, opts = {}) {
  if (src.type === "wp") return fetchWp(src, opts);
  if (src.type === "html-links") return fetchHtmlLinks(src, opts);
  throw new Error(`unknown source type ${src.type}`);
}

module.exports = { fetchSource, parseFeed };

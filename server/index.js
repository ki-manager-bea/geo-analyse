// ---- Debug / Error Handling ----
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

import express from "express";
import cors from "cors";
import { load as loadHTML } from "cheerio";
import { parseStringPromise } from "xml2js";
import { z } from "zod";
import crypto from "node:crypto";
import { URL } from "node:url";

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/debug", (_req, res) => res.json({ pid: process.pid, ts: Date.now() }));

// In-Memory Job Store
const jobs = new Map(); // jobId -> { status, progress, result, error, logs: [] }

// ---------- Logger ----------
function log(jobId, level, msg, extra) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(extra ? { extra } : {}),
  };
  if (jobId && jobs.has(jobId)) {
    const j = jobs.get(jobId);
    j.logs = j.logs || [];
    j.logs.push(entry);
  }
  const prefix = jobId ? `[job ${jobId}]` : "";
  console[level === "error" ? "error" : "log"](
    `[${entry.ts}] [${level}] ${prefix} ${msg}`,
    extra ? extra : ""
  );
}

// ---------- Helpers ----------
const UA = "Mozilla/5.0 (compatible; GEO-Analyzer/1.3; +https://example.com/bot)";
const textLen = (s) => (s || "").trim().length;
const isHtmlCT = (ct) => (ct || "").toLowerCase().includes("text/html");
const ASSET_RE =
  /\.(?:xml|jpg|jpeg|png|gif|webp|svg|avif|pdf|zip|rar|7z|mp4|webm|mp3|wav|woff2?|ttf|ico)(?:\?|#|$)/i;
const DEFAULT_EXCLUDE =
  "/wp-content/|/uploads/|\\.(?:xml|jpg|jpeg|png|gif|webp|svg|avif|pdf|zip|rar|7z|mp4|webm|mp3|wav|woff2?|ttf|ico)(?:\\?.*)?$";
const normOrigin = (input) => {
  const u = new URL(input);
  return `${u.protocol}//${u.host}`;
};

function headingOrderIssues($) {
  const hs = $("h1,h2,h3,h4,h5,h6")
    .toArray()
    .map((el) => Number(el.tagName[1]));
  const issues = [];
  for (let i = 1; i < hs.length; i++) {
    const prev = hs[i - 1],
      cur = hs[i];
    if (cur - prev > 1) issues.push(`Sprung von H${prev} auf H${cur} (Index ${i})`);
  }
  return issues;
}
function parseRobotsTxt(text) {
  const lines = (text || "").split(/\r?\n/);
  const sitemaps = [];
  const disallow = [];
  for (const line of lines) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    const [kRaw, ...rest] = l.split(":");
    if (!kRaw || !rest.length) continue;
    const k = kRaw.trim().toLowerCase();
    const v = rest.join(":").trim();
    if (k === "sitemap") sitemaps.push(v);
    if (k === "disallow") disallow.push(v);
  }
  return { sitemaps, disallow };
}

// „Punkte“-Berechnung (100)
function scoreFromFlags(f) {
  let sd = 0;
  if (f.hasJSONLD) sd += 10;
  if (f.hasOrganization) sd += 6;
  if (f.hasLocalBusiness) sd += 6;
  if (f.hasWebsite) sd += 6;
  if (f.hasSearchAction) sd += 4;
  if (f.hasBreadcrumb) sd += 3;
  if (f.hasFAQ) sd += 4;
  if (f.hasArticle) sd += 3;

  let tech = 0;
  if (f.hasCanonical) tech += 6;
  if (f.indexable) tech += 12;
  if (f.robotsTxtFound) tech += 3;
  if (f.sitemapFound) tech += 3;
  if (f.langSet) tech += 3;
  if (f.hOrderOk) tech += 3;
  if (f.redirectChain <= 1) tech += 3;
  if (f.hreflangCount > 0 && f.hreflangXDefault) tech += 2;

  let content = 0;
  if (f.h1Count === 1) content += 5;
  if (f.h2Count >= 1) content += 3;
  if (f.wordCount >= 200) content += 6;
  if (f.goodAltRatio) content += 4;
  if (f.metaDescGood) content += 5;
  if (f.titleGood) content += 5;

  let social = 0;
  if (f.ogOk) social += 4;
  if (f.twitterOk) social += 3;

  const total = Math.max(0, Math.min(100, sd + tech + content + social));
  return { total, breakdown: { structuredData: sd, technical: tech, content, social } };
}

// ---------- Zod Body ----------
const AnalyzeBody = z.object({
  url: z.string().url(),
  seedSitemap: z.boolean().optional().default(true),
  sampleSitemap: z.boolean().optional().default(true),
  maxSamplePages: z.number().int().min(1).max(1000).optional().default(100),
  crawl: z.boolean().optional().default(true),
  renderCrawl: z.boolean().optional().default(true),
  maxCrawlPages: z.number().int().min(1).max(3000).optional().default(500),
  keepHashSections: z.boolean().optional().default(true),
  includeParams: z.boolean().optional().default(false),
  extraSeeds: z.array(z.string().url()).optional().default([]),
  includePatterns: z.array(z.string()).optional().default([]),
  excludePatterns: z.array(z.string()).optional().default([DEFAULT_EXCLUDE]),
  guessCommonPaths: z.boolean().optional().default(true),
  deepAnalyzeLimit: z.number().int().min(0).max(200).optional().default(30),
  debug: z.boolean().optional().default(false),
});

// ---------- Playwright ----------
async function getChromium() {
  const { chromium } = await import("playwright");
  return chromium;
}

// ---------- Full (rendered) analyse ----------
async function analyzeSinglePage(url) {
  // RAW vs DOM (CSR-Risiko)
  let rawWords = 0;
  let rawHtml = "";
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
    rawHtml = await r.text();
    rawWords = rawHtml
      .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean).length;
  } catch {}

  const chromium = await getChromium();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();

  // Asset-Heuristik
  const bytes = { total: 0, img: 0, js: 0, css: 0 };
  let bigImages = 0,
    respCount = 0;
  page.on("response", async (res) => {
    try {
      if (respCount > 80) return; // Deckelung
      respCount++;
      const u = res.url();
      const h = res.headers() || {};
      const ct = (h["content-type"] || "").toLowerCase();
      let len = parseInt(h["content-length"] || "0", 10);
      if (!len && !u.startsWith("data:")) {
        try {
          const b = await res.body();
          len = b?.length || 0;
        } catch {}
      }
      bytes.total += len || 0;
      if (ct.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg|avif)(\?|$)/i.test(u)) {
        bytes.img += len || 0;
        if ((len || 0) > 500_000) bigImages++;
      } else if (ct.includes("javascript") || /\.js(\?|$)/i.test(u)) bytes.js += len || 0;
      else if (ct.includes("css") || /\.css(\?|$)/i.test(u)) bytes.css += len || 0;
    } catch {}
  });

  let response;
  try {
    response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  } catch (e) {
    await browser.close();
    return { error: `Navigation failed: ${e.message}` };
  }

  const finalUrl = page.url();
  const status = response?.status() ?? 0;
  const headers = response?.headers() ?? {};
  const xRobots = headers["x-robots-tag"] || "";

  // Redirect-Kette
  let chain = 0;
  try {
    for (let req = response?.request(); req && req.redirectedFrom(); req = req.redirectedFrom()) chain++;
  } catch {}
  const redirectChain = chain;

  const html = await page.content();
  const $ = loadHTML(html);

  const title = $("title").first().text().trim();
  const metaDesc = $('meta[name="description"]').attr("content") || "";
  const lang = $("html").attr("lang") || "";
  const canonical = $('link[rel="canonical"]').attr("href") || "";
  const robotsMeta = $('meta[name="robots"]').attr("content") || "";

  // hreflang
  const hreflang = $('link[rel="alternate"][hreflang]')
    .toArray()
    .map((el) => ({
      lang: ($(el).attr("hreflang") || "").toLowerCase(),
      href: $(el).attr("href") || "",
    }));
  const hreflangXDefault = hreflang.some((h) => h.lang === "x-default");

  const h1s = $("h1")
    .toArray()
    .map((el) => $(el).text().trim());
  const h2Count = $("h2").length;

  const imgs = $("img").toArray();
  const missingAlt = imgs.filter((el) => !$(el).attr("alt") || $(el).attr("alt").trim() === "").length;
  const goodAltRatio = imgs.length === 0 ? true : missingAlt / imgs.length <= 0.2;

  // Fix: Kein Zugriff auf .attribs.loading
  const lazyCount = imgs.filter(
    (el) => ((($(el).attr("loading") || "").toLowerCase()) === "lazy")
  ).length;
  const lazyRatio = imgs.length ? Math.round((100 * lazyCount) / imgs.length) : 0;

  const textWords = $("body").text().replace(/\s+/g, " ").trim().split(" ").filter(Boolean).length;
  const renderDeltaPct = rawWords ? Math.round((100 * (textWords - rawWords)) / rawWords) : null;

  // OG/Twitter
  const og = {
    title: $('meta[property="og:title"]').attr("content") || "",
    description: $('meta[property="og:description"]').attr("content") || "",
    image: $('meta[property="og:image"]').attr("content") || "",
    type: $('meta[property="og:type"]').attr("content") || "",
    url: $('meta[property="og:url"]').attr("content") || "",
  };
  const twitter = {
    card: $('meta[name="twitter:card"]').attr("content") || "",
    title: $('meta[name="twitter:title"]').attr("content") || "",
    description: $('meta[name="twitter:description"]').attr("content") || "",
    image: $('meta[name="twitter:image"]').attr("content") || "",
  };
  const ogComplete = !!og.title && !!og.description && !!og.image;
  const twitterLarge = (twitter.card || "").toLowerCase().includes("summary_large_image");

  // JSON-LD
  const jsonLdBlocks = [];
  const jsonLdErrors = [];
  const jsonLdInHead = $('head script[type="application/ld+json"]').length;
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try {
      jsonLdBlocks.push(JSON.parse(raw));
    } catch (e) {
      jsonLdErrors.push(`Invalid JSON-LD: ${e.message}`);
    }
  });

  const jsonLdTypes = {};
  const collectTypes = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) return obj.forEach(collectTypes);
    if (obj["@type"]) {
      const ts = Array.isArray(obj["@type"]) ? obj["@type"] : [obj["@type"]];
      ts.forEach((t) => (jsonLdTypes[t] = (jsonLdTypes[t] || 0) + 1));
    }
    for (const v of Object.values(obj)) collectTypes(v);
  };
  jsonLdBlocks.forEach(collectTypes);

  const hasWebsite = !!jsonLdTypes["WebSite"];
  const hasOrganization = !!jsonLdTypes["Organization"];
  const hasLocalBusiness = !!jsonLdTypes["LocalBusiness"];
  const hasBreadcrumb = !!jsonLdTypes["BreadcrumbList"];
  const hasFAQ = !!jsonLdTypes["FAQPage"];
  const hasArticle =
    !!jsonLdTypes["Article"] || !!jsonLdTypes["BlogPosting"] || !!jsonLdTypes["NewsArticle"];
  const hasProduct = !!jsonLdTypes["Product"];

  let hasSearchAction = false;
  let localFields = { telephone: false, address: false, hours: false, rating: false };
  let productFields = { offer: false, price: false, currency: false, availability: false, rating: false };
  let articleFields = { author: false, datePublished: false, dateModified: false };
  jsonLdBlocks
    .flatMap((b) => (Array.isArray(b) ? b : [b]))
    .forEach((item) => {
      const t = item?.["@type"];
      if ((t === "WebSite" || (Array.isArray(t) && t.includes("WebSite"))) &&
          item.potentialAction?.["@type"] === "SearchAction") hasSearchAction = true;

      if (t === "LocalBusiness" || (Array.isArray(t) && t.includes("LocalBusiness"))) {
        const tel = item.telephone;
        const addr = item.address && (item.address.streetAddress || item.address.addressLocality);
        const hours = item.openingHours || item.openingHoursSpecification;
        const rating = !!item.aggregateRating || !!item.review;
        localFields = { telephone: !!tel, address: !!addr, hours: !!hours, rating };
      }

      if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) {
        const offer = item.offers;
        const p = Array.isArray(offer) ? offer[0] : offer;
        productFields = {
          offer: !!offer,
          price: !!p?.price,
          currency: !!p?.priceCurrency,
          availability: !!p?.availability,
          rating: !!item.aggregateRating || !!item.review,
        };
      }

      if (
        t === "Article" ||
        t === "BlogPosting" ||
        t === "NewsArticle" ||
        (Array.isArray(t) && (t.includes("Article") || t.includes("BlogPosting") || t.includes("NewsArticle")))
      ) {
        articleFields = {
          author: !!item.author,
          datePublished: !!item.datePublished,
          dateModified: !!item.dateModified,
        };
      }
    });

  // Trust / Legal heuristics (Main Page)
  const bodyText = $("body").text().toLowerCase();
  const hasConsentBanner = /cookie|consent|einwilligung/.test(bodyText);
  const hasFavicon = $('link[rel="icon"],link[rel="shortcut icon"]').length > 0;
  const hasManifest = $('link[rel="manifest"]').length > 0;

  const metaNoindex = (robotsMeta || "").toLowerCase().includes("noindex");
  const xRobotsNoindex = (xRobots || "").toLowerCase().includes("noindex");
  const indexable = status >= 200 && status < 400 && !metaNoindex && !xRobotsNoindex;

  // Title/Description „gut“ (breiter) – für Score
  const titleGood = textLen(title) >= 30 && textLen(title) <= 65;
  const metaDescGood = textLen(metaDesc) >= 80 && textLen(metaDesc) <= 180;

  // URL-„Sauberkeit“
  const urlObj = new URL(finalUrl || url);
  const urlClean =
    urlObj.pathname.length <= 120 &&
    !/[A-Z]/.test(urlObj.pathname) &&
    (urlObj.searchParams?.toString().split("&").filter(Boolean).length || 0) <= 4;

  // image format mix (modern)
  const srcs = $("img").toArray().map((el) => $(el).attr("src") || "");
  const extStats = { webp: 0, avif: 0, jpg: 0, png: 0, svg: 0, other: 0 };
  srcs.forEach((s) => {
    if (/\.webp(\?|$)/i.test(s)) extStats.webp++;
    else if (/\.avif(\?|$)/i.test(s)) extStats.avif++;
    else if (/\.jpe?g(\?|$)/i.test(s)) extStats.jpg++;
    else if (/\.png(\?|$)/i.test(s)) extStats.png++;
    else if (/\.svg(\?|$)/i.test(s)) extStats.svg++;
    else extStats.other++;
  });

  const cacheControl = (headers["cache-control"] || "").toLowerCase();
  const hasCaching = /max-age=\d{3,}/.test(cacheControl);

  const flags = {
    hasJSONLD: jsonLdBlocks.length > 0,
    hasOrganization,
    hasLocalBusiness,
    hasWebsite,
    hasSearchAction,
    hasBreadcrumb,
    hasFAQ,
    hasArticle,
    hasProduct,
    hasCanonical: !!canonical,
    indexable,
    robotsTxtFound: false,
    sitemapFound: false,
    h1Count: h1s.length,
    h2Count,
    hOrderOk: headingOrderIssues($).length === 0,
    goodAltRatio,
    lazyRatio,
    langSet: !!lang,
    ogOk: !!og.title || !!og.description || !!og.image,
    ogComplete,
    twitterOk: !!twitter.card || !!twitter.title || !!twitter.description,
    twitterLarge,
    wordCount: textWords,
    titleGood,
    metaDescGood,
    redirectChain,
    hreflangCount: hreflang.length,
    hreflangXDefault,
    jsonLdInHead: jsonLdInHead > 0,
    // perf-ish
    bytes,
    bigImages,
    renderDeltaPct,
    hasCaching,
    // trust-ish
    hasConsentBanner,
    hasFavicon,
    hasManifest,
    urlClean,
    // content-ish
    extStats,
    localFields,
    productFields,
    articleFields,
  };

  await browser.close();

  return {
    requestedUrl: url,
    finalUrl,
    fetchedAt: new Date().toISOString(),
    http: {
      status,
      contentType: headers["content-type"] || "",
      xRobotsTag: xRobots || "",
      cacheControl: headers["cache-control"] || "",
      redirectChain,
    },
    meta: {
      title,
      titleLength: textLen(title),
      metaDescription: metaDesc,
      metaDescriptionLength: textLen(metaDesc),
      lang,
      canonical,
      robotsMeta,
    },
    hreflang,
    headings: { h1Count: h1s.length, h1: h1s, orderIssues: headingOrderIssues($) },
    images: { count: imgs.length, missingAlt, missingAltRatio: imgs.length ? missingAlt / imgs.length : 0 },
    social: { og, twitter },
    structuredData: { jsonLdCount: jsonLdBlocks.length, types: jsonLdTypes, errors: jsonLdErrors },
    flags,
    rawHtmlLen: rawHtml.length
  };
}

// ---------- Sitemap (deep) ----------
async function getSitemapDeep(origin, cap = 3000) {
  const seenSitemaps = new Set();
  const urls = new Set();
  let robotsTxt = "";
  let candidates = [];
  let disallow = [];
  let listedInRobots = false;

  try {
    const r = await fetch(`${origin}/robots.txt`, { headers: { "User-Agent": UA }, redirect: "follow" });
    if (r.ok) {
      robotsTxt = await r.text();
      const parsed = parseRobotsTxt(robotsTxt);
      candidates = parsed.sitemaps;
      disallow = parsed.disallow;
      listedInRobots = candidates.length > 0;
    }
  } catch {}
  if (candidates.length === 0) candidates = [`${origin}/sitemap.xml`];

  async function fetchXml(u) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA }, redirect: "follow" });
      if (!r.ok) return null;
      return await r.text();
    } catch {
      return null;
    }
  }
  async function expand(smUrl) {
    if (seenSitemaps.has(smUrl) || urls.size >= cap) return;
    seenSitemaps.add(smUrl);
    const xml = await fetchXml(smUrl);
    if (!xml) return;
    let parsed = {};
    try {
      parsed = await parseStringPromise(xml);
    } catch {
      return;
    }

    if (parsed.sitemapindex?.sitemap) {
      for (const s of parsed.sitemapindex.sitemap) {
        const loc = s?.loc?.[0];
        if (loc) await expand(loc);
        if (urls.size >= cap) break;
      }
    } else if (parsed.urlset?.url) {
      for (const u of parsed.urlset.url) {
        const loc = u?.loc?.[0];
        if (!loc) continue;
        try {
          const href = new URL(loc);
          if (ASSET_RE.test(href.pathname)) continue;
          urls.add(href.toString());
        } catch {}
        if (urls.size >= cap) break;
      }
    }
  }
  for (const sm of candidates) {
    if (urls.size >= cap) break;
    await expand(sm);
  }
  const broadBlock = disallow.some((d) => d.trim() === "/");
  return {
    robotsTxtFound: !!robotsTxt,
    sitemapFound: urls.size > 0,
    sitemapCandidates: candidates,
    urls: Array.from(urls),
    disallow,
    broadBlock,
    sitemapListedInRobots: listedInRobots
  };
}

// ---------- Light Analyse ----------
async function lightweightSampleAnalyze(url) {
  try {
    const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": UA } });
    const status = res.status;
    const ct = res.headers.get("content-type") || "";
    if (!res.ok) return { url, status, ok: false, reason: "HTTP", ct };
    if (!isHtmlCT(ct)) return { url, status, ok: false, reason: "Non-HTML", ct };

    const html = await res.text();
    const $ = loadHTML(html);

    const title = $("title").first().text().trim();
    const metaDesc = $('meta[name="description"]').attr("content") || "";
    const canonical = $('link[rel="canonical"]').attr("href") || "";
    const robotsMeta = $('meta[name="robots"]').attr("content") || "";
    const lang = $("html").attr("lang") || "";

    const h1Count = $("h1").length;
    const h2Count = $("h2").length;
    const wordCount = $("body").text().replace(/\s+/g, " ").trim().split(" ").filter(Boolean).length;
    const orderIssues = headingOrderIssues($);

    // hreflang quick
    const hreflangEls = $('link[rel="alternate"][hreflang"]').toArray();
    const hreflangCount = hreflangEls.length;
    const hreflangXDefault = hreflangEls.some(
      (el) => (($(el).attr("hreflang") || "").toLowerCase()) === "x-default"
    );

    // Forms a11y (grob)
    const inputs = $("input,select,textarea").toArray();
    let unlabeled = 0;
    inputs.forEach((el) => {
      const $el = $(el);
      const id = $el.attr("id");
      const has =
        !!$el.attr("aria-label") ||
        !!$el.attr("aria-labelledby") ||
        (id && $(`label[for="${id}"]`).length > 0) ||
        ($el.parents("label").length > 0);
      if (!has) unlabeled++;
    });

    const imgs = $("img").toArray();
    const missingAlt = imgs.filter((el) => !$(el).attr("alt") || $(el).attr("alt").trim() === "").length;
    const jsonLdBlocks = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).contents().text();
      try {
        jsonLdBlocks.push(JSON.parse(raw));
      } catch {}
    });
    const types = {};
    const collect = (obj) => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) return obj.forEach(collect);
      if (obj["@type"]) {
        (Array.isArray(obj["@type"]) ? obj["@type"] : [obj["@type"]]).forEach(
          (t) => (types[t] = (types[t] || 0) + 1)
        );
      }
      for (const v of Object.values(obj)) collect(v);
    };
    jsonLdBlocks.forEach(collect);
    const jsonLdCount = jsonLdBlocks.length;
    const ogCore =
      $('meta[property="og:title"]').length +
      $('meta[property="og:description"]').length +
      $('meta[property="og:image"]').length;

    // Legal links quick
    const aHrefs = $("a[href]")
      .toArray()
      .map((a) => (($(a).attr("href") || "").toLowerCase()));
    const hasImpressumLink = aHrefs.some((h) => /impressum/.test(h));
    const hasDatenschutzLink = aHrefs.some((h) => /datenschutz|privacy/.test(h));

    return {
      url,
      status,
      ok: true,
      ct,
      titleLen: textLen(title),
      metaDescLen: textLen(metaDesc),
      canonical: !!canonical,
      robots: robotsMeta,
      lang: !!lang,
      h1Count,
      h2Count,
      wordCount,
      orderIssues: orderIssues.length,
      jsonLdCount,
      types,
      images: { count: imgs.length, missingAlt },
      ogCore,
      hreflangCount,
      hreflangXDefault,
      forms: { inputs: inputs.length, unlabeled },
      legal: { hasImpressumLink, hasDatenschutzLink },
    };
  } catch (e) {
    return { url, ok: false, reason: e.message };
  }
}

// ---------- Pattern Utils ----------
const compilePatterns = (arr) =>
  (arr || [])
    .map((s) => {
      try {
        return new RegExp(s, "i");
      } catch {
        return null;
      }
    })
    .filter(Boolean);
const matchAny = (res, s) => !res?.length || res.some((re) => re.test(s));
const matchNone = (res, s) => !res?.length || !res.some((re) => re.test(s));

// ---------- Common-path probe ----------
async function probeCommonPaths(origin) {
  const candidates = [
    "/geo",
    "/leistungen",
    "/service",
    "/kontakt",
    "/impressum",
    "/datenschutz",
    "/faq",
    "/standorte",
    "/ueber-uns",
    "/portfolio",
    "/cases",
    "/blog",
    "/news",
  ].flatMap((p) => [p, p + "/"]);
  const found = [];
  for (const p of candidates) {
    const r = await lightweightSampleAnalyze(origin + p);
    if (r.ok) found.push(origin + p);
  }
  return Array.from(new Set(found));
}

// ---------- Crawl (BFS; optional rendered) ----------
async function crawlInternal(
  startUrl,
  { maxPages = 500, includeParams = false, render = true, keepHashSections = true, seeds = [], includePatterns = [], excludePatterns = [] } = {}
) {
  const start = new URL(startUrl);
  const registrable = start.host.split(".").slice(-2).join(".");
  const incRE = compilePatterns(includePatterns);
  const excRE = compilePatterns(excludePatterns.length ? excludePatterns : [DEFAULT_EXCLUDE]);

  const seedList = [
    start.href,
    ...seeds.filter((s) => {
      try {
        const u = new URL(s);
        return u.host.split(".").slice(-2).join(".") === registrable;
      } catch {
        return false;
      }
    }),
  ];

  const seen = new Set(seedList);
  const out = [...seedList];
  const q = [...seedList];

  const chromium = render ? await getChromium() : null;
  const browser = render ? await chromium.launch({ headless: true }) : null;
  const ctx = render ? await browser.newContext({ userAgent: UA }) : null;

  while (q.length && out.length < maxPages) {
    const u = q.shift();
    try {
      const hrefs = [];
      if (render) {
        const page = await ctx.newPage();
        await page.goto(u, { waitUntil: "domcontentloaded", timeout: 25000 });
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        hrefs.push(
          ...(await page.$$eval("a[href]", (els) =>
            els.map((a) => a.getAttribute("href")).filter(Boolean)
          ))
        );
        await page.close();
      } else {
        const r = await fetch(u, { headers: { "User-Agent": UA }, redirect: "follow" });
        const ct = r.headers.get("content-type") || "";
        if (!isHtmlCT(ct)) continue;
        const html = await r.text();
        const $ = loadHTML(html);
        $("a[href]").each((_, a) => hrefs.push($(a).attr("href")));
      }
      for (let href of hrefs) {
        try {
          const abs = new URL(href, u);
          if (!["http:", "https:"].includes(abs.protocol)) continue;
          const reg2 = abs.host.split(".").slice(-2).join(".");
          if (reg2 !== registrable) continue;
          if (!includeParams) abs.search = "";
          if (!keepHashSections) abs.hash = "";
          const s = abs.toString();
          if (ASSET_RE.test(abs.pathname)) continue;
          if (!matchAny(incRE, s)) continue;
          if (!matchNone(excRE, s)) continue;
          if (!seen.has(s) && seen.size < maxPages * 6) {
            seen.add(s);
            q.push(s);
            out.push(s);
          }
        } catch {}
      }
    } catch {}
  }
  if (browser) await browser.close();
  return Array.from(new Set(out));
}

// ---------- Findings (8 Spalten) ----------
const mkFinding = (url, category, location, status, issue, fix, example, impact = "mittel") => ({
  url,
  category,
  location,
  status,
  issue,
  fix,
  example,
  impact,
});

// Regeln für Light-Pages
function findingsForQuickPage(p) {
  const F = [];
  if (!p || !p.ok) {
    if (typeof p?.status === "number" && (p.status < 200 || p.status >= 400))
      F.push(
        mkFinding(
          p.url,
          "Indexierung",
          "HTTP",
          "Fehler",
          `HTTP-Status ${p.status}`,
          "2xx/3xx sicherstellen",
          "Server/Route prüfen",
          "hoch"
        )
      );
    return F;
  }
  // Title/Description – strengere Ideal-Spannen
  if (p.titleLen < 50 || p.titleLen > 60)
    F.push(
      mkFinding(
        p.url,
        "Onpage",
        "<title>",
        "Hinweis",
        "Title ideal 50–60 Zeichen",
        "präzise, klickstark formulieren",
        "<title>Keyword | Marke</title>",
        "niedrig"
      )
    );
  if (!p.metaDescLen)
    F.push(
      mkFinding(
        p.url,
        "Onpage",
        "<meta description>",
        "Warnung",
        "Description fehlt",
        "unique Description ergänzen",
        "<meta name='description' content='…'>",
        "mittel"
      )
    );
  else if (p.metaDescLen < 140 || p.metaDescLen > 180)
    F.push(
      mkFinding(
        p.url,
        "Onpage",
        "<meta description>",
        "Hinweis",
        "Description ideal 140–180 Zeichen",
        "kurz, unique, CTA",
        "<meta name='description' ...>",
        "niedrig"
      )
    );

  if (!p.canonical)
    F.push(
      mkFinding(
        p.url,
        "Technik/Indexierung",
        "<head>",
        "Warnung",
        "Canonical fehlt",
        "<link rel='canonical'> setzen",
        "<link rel='canonical' href='…'>",
        "mittel"
      )
    );
  const robots = (p.robots || "").toLowerCase();
  if (robots.includes("noindex"))
    F.push(
      mkFinding(
        p.url,
        "Technik/Indexierung",
        "<meta robots>",
        "Fehler",
        "noindex gesetzt",
        "Indexierung erlauben",
        "<meta name='robots' content='index,follow'>",
        "hoch"
      )
    );
  if (!p.lang)
    F.push(
      mkFinding(
        p.url,
        "Internationalisierung",
        "<html lang>",
        "Warnung",
        "Sprachangabe fehlt",
        "lang-Attribut setzen",
        "<html lang='de'>",
        "niedrig"
      )
    );
  if (p.h1Count !== 1)
    F.push(
      mkFinding(
        p.url,
        "Struktur & Semantik",
        "Body",
        "Warnung",
        "Genau eine H1 je Seite empfohlen",
        "präzise H1 setzen",
        "<h1>Seitenfokus</h1>",
        "mittel"
      )
    );
  if (p.h2Count < 1)
    F.push(
      mkFinding(
        p.url,
        "Struktur & Semantik",
        "Body",
        "Hinweis",
        "Mindestens eine H2 sinnvoll",
        "Abschnitte strukturieren",
        "<h2>Abschnitt</h2>",
        "niedrig"
      )
    );
  if (p.orderIssues > 0)
    F.push(
      mkFinding(
        p.url,
        "Struktur & Semantik",
        "Headings",
        "Hinweis",
        "Überschriften-Sprünge",
        "hierarchisch gliedern",
        "H2→H3→H4…",
        "niedrig"
      )
    );
  if (typeof p.wordCount === "number" && p.wordCount < 200)
    F.push(
      mkFinding(
        p.url,
        "Content",
        "Body",
        "Warnung",
        "Sehr wenig Text (<200 Wörter)",
        "Informationsdichte erhöhen",
        "Antworten/FAQs integrieren",
        "mittel"
      )
    );
  if (!p.jsonLdCount)
    F.push(
      mkFinding(
        p.url,
        "Strukturierte Daten",
        "<head>",
        "Warnung",
        "Kein JSON-LD vorhanden",
        "passendes Schema.org ergänzen",
        '{"@context":"https://schema.org","@type":"…"}',
        "mittel"
      )
    );
  if (!p.ogCore)
    F.push(
      mkFinding(
        p.url,
        "Social Preview",
        "OG",
        "Hinweis",
        "OpenGraph-Basis fehlt",
        "og:title/description/image setzen",
        "og:title …",
        "niedrig"
      )
    );
  if (p.hreflangCount > 0 && !p.hreflangXDefault)
    F.push(
      mkFinding(
        p.url,
        "Internationalisierung",
        "<link rel='alternate'>",
        "Hinweis",
        "x-default fehlt",
        "x-default ergänzen",
        "<link rel='alternate' hreflang='x-default' …>",
        "niedrig"
      )
    );
  if (p.forms?.inputs > 0 && p.forms.unlabeled / p.forms.inputs > 0.5)
    F.push(
      mkFinding(
        p.url,
        "Barrierefreiheit",
        "Formulare",
        "Hinweis",
        ">50% Inputs ohne Label/ARIA",
        "Beschriftungen ergänzen",
        "<label for='…'>",
        "niedrig"
      )
    );
  if (!p.legal?.hasImpressumLink)
    F.push(
      mkFinding(
        p.url,
        "Recht",
        "Footer/Navi",
        "Hinweis",
        "Impressum-Link nicht gefunden",
        "sichtbar verlinken",
        "/impressum",
        "niedrig"
      )
    );
  if (!p.legal?.hasDatenschutzLink)
    F.push(
      mkFinding(
        p.url,
        "Recht",
        "Footer/Navi",
        "Hinweis",
        "Datenschutz-Link nicht gefunden",
        "sichtbar verlinken",
        "/datenschutz",
        "niedrig"
      )
    );
  return F;
}

// ---------- Job Runner ----------
async function runJob(jobId, url, opts) {
  const set = (patch) => {
    const cur = jobs.get(jobId) || {};
    jobs.set(jobId, { ...cur, ...patch });
  };
  const {
    seedSitemap,
    sampleSitemap,
    maxSamplePages,
    crawl,
    renderCrawl,
    maxCrawlPages,
    deepAnalyzeLimit,
    keepHashSections,
    includeParams,
    extraSeeds,
    includePatterns,
    excludePatterns,
    guessCommonPaths,
    debug,
  } = opts;

  try {
    set({ status: "running", progress: 2 });
    log(jobId, "info", "Job started", { url, opts: { ...opts, extraSeedsCount: (extraSeeds || []).length } });

    // 1) Main (deep)
    const main = await analyzeSinglePage(url);
    if (main.error) throw new Error(main.error);
    set({ progress: 18 });

    const origin = normOrigin(main.finalUrl || url);

    // 2) Sitemap deep
    const sm = seedSitemap
      ? await getSitemapDeep(origin, Math.max(maxSamplePages, maxCrawlPages))
      : { urls: [], disallow: [], sitemapListedInRobots: false };
    main.flags.robotsTxtFound = !!sm.robotsTxtFound;
    main.flags.sitemapFound = !!sm.sitemapFound;
    main.flags.sitemapListedInRobots = !!sm.sitemapListedInRobots;

    // 3) Seeds (manual + guess)
    let manualSeeds = Array.isArray(extraSeeds) ? extraSeeds.slice() : [];
    if (guessCommonPaths) {
      try {
        const guessed = await probeCommonPaths(origin);
        manualSeeds.push(...guessed);
      } catch {}
    }
    manualSeeds = Array.from(new Set(manualSeeds));

    // 4) Discovery = sitemap + crawl + seeds
    let discovered = new Set([...(sm.urls || []), ...manualSeeds]);
    let crawlList = [];
    if (crawl) {
      crawlList = await crawlInternal(main.finalUrl || url, {
        maxPages: maxCrawlPages,
        render: renderCrawl,
        keepHashSections,
        includeParams,
        seeds: manualSeeds,
        includePatterns,
        excludePatterns,
      });
      crawlList.forEach((u) => discovered.add(u));
    }
    const allUrls = Array.from(discovered);

    // Coverage/Orphans
    const smSet = new Set(sm.urls || []);
    const discSet = new Set(allUrls);
    const crawledSet = new Set(crawlList);
    const inSitemapOfDiscovered = [...discSet].filter((u) => smSet.has(u)).length;
    const sitemapCoveragePct = discSet.size ? Math.round((100 * inSitemapOfDiscovered) / discSet.size) : null;
    const orphanCandidates = [...smSet].filter((u) => !crawledSet.has(u)).slice(0, 50);

    set({ progress: 48 });

    // 5) Stichproben + Findings
    const sampledPages = [];
    const crawlAnalyses = [];
    const findings = [];

    if (sampleSitemap && sm.urls?.length) {
      for (const u of sm.urls.slice(0, maxSamplePages)) {
        const p = await lightweightSampleAnalyze(u);
        const F = findingsForQuickPage(p);
        p.findings = F;
        if (p.ok) sampledPages.push(p);
        findings.push(...F);
      }
    }
    for (const u of allUrls.slice(0, Math.min(maxCrawlPages, allUrls.length))) {
      const p = await lightweightSampleAnalyze(u);
      const F = findingsForQuickPage(p);
      p.findings = F;
      if (p.ok) crawlAnalyses.push(p);
      findings.push(...F);
    }
    set({ progress: 74 });

    // 6) Deep Analyse weiterer Seiten (rendered)
    const deepTargets = allUrls
      .filter((u) => u !== (main.finalUrl || url) && !ASSET_RE.test(new URL(u).pathname))
      .slice(0, deepAnalyzeLimit);

    for (let i = 0; i < deepTargets.length; i++) {
      const u = deepTargets[i];
      const d = await analyzeSinglePage(u);
      if (!d.flags.indexable)
        findings.push(
          mkFinding(
            u,
            "Indexierung",
            "HTTP",
            "Fehler",
            "Nicht indexierbar (Status/robots)",
            "Status/robots prüfen",
            "X-Robots/META anpassen",
            "hoch"
          )
        );
      if (d.http.redirectChain > 1)
        findings.push(
          mkFinding(
            u,
            "Technik/Indexierung",
            "HTTP",
            "Hinweis",
            "Redirect-Kette",
            "Weiterleitungen auflösen",
            "301 → Ziel direkt",
            "niedrig"
          )
        );
      if (!d.meta.canonical)
        findings.push(
          mkFinding(
            u,
            "Technik/Indexierung",
            "<head>",
            "Warnung",
            "Canonical fehlt",
            "<link rel='canonical'> setzen",
            "<link rel='canonical' href='…'>",
            "mittel"
          )
        );
      if (!d.flags.jsonLdInHead)
        findings.push(
          mkFinding(
            u,
            "Strukturierte Daten",
            "<head>",
            "Hinweis",
            "JSON-LD nicht im <head>",
            "JSON-LD früh laden",
            "<script type='application/ld+json'>…</script>",
            "niedrig"
          )
        );
      if (!d.flags.hasJSONLD)
        findings.push(
          mkFinding(
            u,
            "Strukturierte Daten",
            "<head>",
            "Warnung",
            "Kein JSON-LD",
            "Schema.org ergänzen",
            '{"@context":"https://schema.org","@type":"…"}',
            "mittel"
          )
        );
      if (d.flags.hasLocalBusiness) {
        if (!d.flags.localFields.telephone || !d.flags.localFields.address)
          findings.push(
            mkFinding(
              u,
              "GEO/NAP",
              "JSON-LD",
              "Warnung",
              "NAP unvollständig (Tel/Adresse)",
              "telephone/address ergänzen",
              '{"@type":"LocalBusiness","telephone":"…","address":{…}}',
              "mittel"
            )
          );
        if (!d.flags.localFields.hours)
          findings.push(
            mkFinding(
              u,
              "GEO/NAP",
              "JSON-LD",
              "Hinweis",
              "Öffnungszeiten fehlen",
              "openingHours ergänzen",
              '{"openingHours":"Mo-Fr 09:00-17:00"}',
              "niedrig"
            )
          );
      }
      if (d.flags.hasProduct) {
        const pf = d.flags.productFields;
        if (!pf.offer || !pf.price || !pf.currency)
          findings.push(
            mkFinding(
              u,
              "Shop/Product",
              "JSON-LD",
              "Fehler",
              "Product ohne Preis/Währung",
              "Offer ergänzen",
              '{"@type":"Offer","price":"…","priceCurrency":"EUR"}',
              "hoch"
            )
          );
      }
      if (d.flags.hasArticle) {
        const af = d.flags.articleFields;
        if (!af.author || !af.datePublished)
          findings.push(
            mkFinding(
              u,
              "Content",
              "JSON-LD",
              "Hinweis",
              "Autor/Datum fehlen",
              "author/datePublished ergänzen",
              '{"author":"…","datePublished":"YYYY-MM-DD"}',
              "niedrig"
            )
          );
      }
      if (d.flags.bigImages > 3)
        findings.push(
          mkFinding(
            u,
            "Performance",
            "Assets",
            "Hinweis",
            ">3 große Bilder (>500KB)",
            "Bilder komprimieren / WebP/AVIF",
            "<img src='…webp'>",
            "niedrig"
          )
        );
      if (d.flags.lazyRatio < 50 && d.images.count > 8)
        findings.push(
          mkFinding(
            u,
            "Performance",
            "<img>",
            "Hinweis",
            "Wenig Lazy-Load",
            'loading="lazy" ergänzen',
            "<img loading='lazy'>",
            "niedrig"
          )
        );
      if (d.flags.renderDeltaPct != null && d.flags.renderDeltaPct > 50)
        findings.push(
          mkFinding(
            u,
            "Rendering",
            "CSR",
            "Warnung",
            "Viele Inhalte erst clientseitig",
            "SSR/SSG bevorzugen",
            "Server-Rendering aktivieren",
            "mittel"
          )
        );
      set({ progress: 74 + Math.round(((i + 1) / Math.max(1, deepTargets.length)) * 20) });
      if (debug) log(jobId, "info", "Deep analyzed page", { url: u });
    }

    // 7) Main Issues + Score
    const issues = [];
    if (!main.flags.indexable) issues.push("Seite ist vermutlich nicht indexierbar (Status/robots).");
    if (main.http.redirectChain > 1) issues.push("Redirect-Kette vorhanden – bitte auflösen.");
    if (!main.meta.canonical) issues.push("Canonical-Tag fehlt.");
    if (!main.flags.hasJSONLD) issues.push("Keine JSON-LD Daten gefunden.");
    if (!main.flags.hasOrganization) issues.push("Organization Schema fehlt.");
    if (!main.flags.hasWebsite) issues.push("WebSite Schema fehlt.");
    if (!main.flags.hasSearchAction) issues.push("SearchAction im WebSite Schema fehlt.");
    if (!main.flags.langSet) issues.push("<html lang> nicht gesetzt.");
    if (main.headings.h1Count !== 1) issues.push(`H1-Anzahl ist ${main.headings.h1Count} (sollte 1 sein).`);
    if (!main.flags.ogOk) issues.push("OpenGraph-Tags fehlen/unvollständig.");
    if (!main.flags.ogComplete) issues.push("OG: Titel/Beschreibung/Bild nicht komplett.");
    if (main.images.missingAltRatio > 0.2) issues.push("Zu viele Bilder ohne ALT-Text (>20%).");
    if (!main.flags.metaDescGood) issues.push("Meta-Description fehlt/ist suboptimal (80–180).");
    if (!main.flags.titleGood) issues.push("Title-Länge unideal (30–65).");
    if (!main.flags.hOrderOk) issues.push("Überschriften-Sprünge erkannt.");
    if (!main.flags.urlClean) issues.push("URL-Struktur evtl. unsauber (Länge/Parameter/Großbuchstaben).");
    if (!main.flags.hasCaching) issues.push("Caching-Header wirken schwach – Cache-Control prüfen.");
    if (sm.broadBlock) issues.push("robots.txt blockiert breitflächig (Disallow: /) – prüfen.");

    const score = scoreFromFlags(main.flags);

    // Zähler
    const severityCounts = { Fehler: 0, Warnung: 0, Hinweis: 0 };
    findings.forEach((f) => {
      severityCounts[f.status] = (severityCounts[f.status] || 0) + 1;
    });
    const pagesWithIssues = new Set(findings.map((f) => f.url)).size;

    const result = {
      requestedUrl: url,
      main,
      robots: {
        found: !!sm.robotsTxtFound,
        disallow: sm.disallow,
        broadBlock: sm.broadBlock,
        sitemapListedInRobots: !!sm.sitemapListedInRobots
      },
      sitemap: {
        found: !!sm.sitemapFound,
        candidates: sm.sitemapCandidates || [],
        sampleCount: Math.min(maxSamplePages, sm.urls?.length || 0),
        coveragePct: sitemapCoveragePct,
      },
      discoveredCount: allUrls.length,
      orphanCandidates,
      sampledPages,
      crawl: { count: crawlAnalyses.length, analyses: crawlAnalyses },
      findings,
      counts: { pagesScanned: allUrls.length, pagesWithIssues, severityCounts },
      issues,
      score,
    };
    set({ status: "done", progress: 100, result });
    log(jobId, "info", "Job finished");
  } catch (e) {
    set({ status: "error", error: e.message });
    log(jobId, "error", "Job failed", { error: e.message });
  }
}

// ---------- API ----------
app.post("/api/analyze", (req, res) => {
  const parsed = AnalyzeBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: "queued", progress: 0, logs: [] });
  log(null, "info", "New job queued", { jobId, url: data.url });
  runJob(jobId, data.url, data);
  res.json({ jobId });
});
app.get("/api/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ status: job.status, progress: job.progress ?? 0 });
});
app.get("/api/result/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "done")
    return res.status(409).json({ error: "Job not finished", status: job.status });
  res.json(job.result);
});
app.get("/api/logs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ logs: job.logs || [] });
});

// ---------- PDF ----------
function esc(s) {
  return (s ?? "").toString().replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
}
const td = (v) => `<td>${esc(v)}</td>`;
function table(rows, headers, cls = "") {
  return `<table class="tbl ${cls}"><thead><tr>${headers
    .map((h) => `<th>${esc(h)}</th>`)
    .join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}
function totalToKB(x) { return Math.round((x || 0) / 1024); }

// Check-Matrix (True/False → Ampel)
function mark(v) {
  if (v === true || v === "ok") return "✅";
  if (v === "warn") return "⚠️";
  return "❌";
}

function buildReportHtml(r) {
  const host = new URL(r.requestedUrl).host;
  const main = r.main;
  const issues = r.issues?.map((x) => `<li>${esc(x)}</li>`).join("") || "";
  const sd = main.structuredData?.types || {};
  const sdList = Object.keys(sd)
    .map((k) => `${esc(k)} (${sd[k]})`)
    .join(", ");

  // nur Seiten MIT Findings
  const smRows = (r.sampledPages || [])
    .filter((p) => (p.findings?.length || 0) > 0)
    .map(
      (p) =>
        `<tr>${td(p.url)}${td(p.status)}${td(p.titleLen)}${td(p.metaDescLen)}${td(p.h1Count)}${td(
          p.h2Count
        )}${td(p.wordCount)}${td(p.jsonLdCount)}${td((p.findings || []).length)}</tr>`
    );

  const crRows = (r.crawl?.analyses || [])
    .filter((p) => (p.findings?.length || 0) > 0)
    .map(
      (p) =>
        `<tr>${td(p.url)}${td(p.status)}${td(p.titleLen)}${td(p.metaDescLen)}${td(p.h1Count)}${td(
          p.h2Count
        )}${td(p.wordCount)}${td(p.jsonLdCount)}${td((p.findings || []).length)}</tr>`
    );

  const findRows = (r.findings || []).map(
    (x) =>
      `<tr>${td(x.url)}${td(x.category)}${td(x.location)}${td(x.status)}${td(x.issue)}${td(
        x.fix
      )}${td(x.example)}${td(x.impact)}</tr>`
  );

  // --- Check-Matrix (deckt deine 14 Punkte ab) ---
  const idealTitle = main.meta.titleLength >= 50 && main.meta.titleLength <= 60;
  const idealDesc  = main.meta.metaDescriptionLength >= 140 && main.meta.metaDescriptionLength <= 180;

  const matrix = [
    ["Technik/Indexierung", "HTTP 2xx/3xx", mark(main.http.status >= 200 && main.http.status < 400)],
    ["Technik/Indexierung", "Redirect-Kette ≤1", mark(main.http.redirectChain <= 1)],
    ["Technik/Indexierung", "robots.txt erreichbar", mark(r.robots.found)],
    ["Technik/Indexierung", "Sitemap in robots.txt verlinkt", mark(r.robots.sitemapListedInRobots)],
    ["Technik/Indexierung", "Sitemap vorhanden", mark(r.sitemap.found)],
    ["Technik/Indexierung", "No broad Disallow", mark(!r.robots.broadBlock)],
    ["Technik/Indexierung", "<meta robots> nicht noindex", mark(!(main.meta.robotsMeta||"").toLowerCase().includes("noindex"))],
    ["Technik/Indexierung", "Canonical vorhanden", mark(!!main.meta.canonical)],
    ["Technik/Indexierung", "Sitemap-Abdeckung", `${r.sitemap.coveragePct ?? "—"}%`],

    ["Internationalisierung", "hreflang vorhanden", mark(main.flags.hreflangCount>0 || "warn")],
    ["Internationalisierung", "x-default vorhanden", mark(main.flags.hreflangCount>0 ? (main.flags.hreflangXDefault?"ok":"warn") : "warn")],

    ["Performance/Rendering", "Große Bilder (>500KB) ≤3", mark(main.flags.bigImages<=3 ? "ok" : "warn")],
    ["Performance/Rendering", "Lazy-Load sinnvoll", mark(main.flags.lazyRatio>=50 ? "ok" : "warn")],
    ["Performance/Rendering", "CSR-Delta moderat", mark(main.flags.renderDeltaPct!=null && main.flags.renderDeltaPct<=50 ? "ok" : "warn")],
    ["Performance/Rendering", "Caching-Header", mark(main.flags.hasCaching?"ok":"warn")],

    ["Struktur/Semantik", "Title 50–60", mark(idealTitle ? "ok" : "warn")],
    ["Struktur/Semantik", "Description 140–180", mark(idealDesc ? "ok" : "warn")],
    ["Struktur/Semantik", "1× H1", mark(main.headings.h1Count===1)],
    ["Struktur/Semantik", "H2 vorhanden", mark(main.flags.h2Count>=1 ? "ok":"warn")],
    ["Struktur/Semantik", "Heading-Hierarchie", mark(main.flags.hOrderOk?"ok":"warn")],
    ["Struktur/Semantik", "URL sauber", mark(main.flags.urlClean?"ok":"warn")],
    ["Struktur/Semantik", "Breadcrumb (Schema)", mark(main.flags.hasBreadcrumb?"ok":"warn")],

    ["OG/Social", "OG komplett (T/D/Img)", mark(main.flags.ogComplete?"ok":"warn")],
    ["OG/Social", "Twitter Card", mark(main.flags.twitterOk?"ok":"warn")],
    ["OG/Social", "summary_large_image", mark(main.flags.twitterLarge?"ok":"warn")],

    ["Schema.org", "WebSite (+SearchAction)", mark(main.flags.hasWebsite && main.flags.hasSearchAction?"ok":"warn")],
    ["Schema.org", "Organization/LocalBusiness", mark(main.flags.hasOrganization || main.flags.hasLocalBusiness?"ok":"warn")],
    ["Schema.org", "FAQ/Breadcrumb/Article", mark((main.flags.hasFAQ||main.flags.hasBreadcrumb||main.flags.hasArticle)?"ok":"warn")],
    ["Schema.org", "Product(+Offer)", mark(main.flags.hasProduct ? (main.flags.productFields.offer && main.flags.productFields.price && main.flags.productFields.currency ? "ok" : "warn") : "warn")],

    ["Content & LLM", "≥200 Wörter", mark(main.flags.wordCount>=200?"ok":"warn")],
    ["Content & LLM", "ALT-Quote ok", mark(main.images.missingAltRatio<=0.2?"ok":"warn")],
    ["Content & LLM", "JSON-LD im <head>", mark(main.flags.jsonLdInHead?"ok":"warn")],

    ["GEO/Local", "NAP vollständig", mark(main.flags.hasLocalBusiness ? ((main.flags.localFields.telephone && main.flags.localFields.address) ? "ok" : "warn") : "warn")],
    ["GEO/Local", "Öffnungszeiten vorhanden", mark(main.flags.hasLocalBusiness ? (main.flags.localFields.hours?"ok":"warn") : "warn")],

    ["Barrierefreiheit/Recht", "<html lang>", mark(!!main.meta.lang)],
    ["Barrierefreiheit/Recht", "Form-Labels (Stichprobe)", "→ siehe Tabelle"],
    ["Barrierefreiheit/Recht", "Impressum/Datenschutz verlinkt", "→ siehe Tabelle"],
  ];

  const matrixRows = matrix.map(rw => `<tr>${td(rw[0])}${td(rw[1])}${td(rw[2])}</tr>`);

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>GEO-Report ${esc(host)}</title>
<style>
  @page{ size:A4 landscape; margin:14mm 12mm; }
  body{ font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-size:12px; color:#111; }
  h1{ font-size:22px; margin:0 0 6px; } h2{ font-size:16px; margin:16px 0 8px; }
  .head{ display:flex; justify-content:space-between; gap:16px; margin-bottom:8px; }
  .brand{ font-weight:600; } .meta{ font-size:11px; color:#555; }
  .score{ display:flex; gap:10px; margin:6px 0 8px; flex-wrap:wrap; }
  .badge{ border:1px solid #ddd; padding:6px 8px; border-radius:8px; background:#fafafa; min-width:120px; text-align:center; }
  .tbl{ width:100%; border-collapse:collapse; table-layout:fixed; }
  .tbl th,.tbl td{ border:1px solid #e6e6e6; padding:5px 7px; vertical-align:top; word-break:break-word; }
  .tbl th{ background:#f7f7f7; text-align:left; white-space:nowrap; }
  .tbl.striped tbody tr:nth-child(odd){ background:#fcfcfc; }
  .tbl.narrow td,.tbl.narrow th{ font-size:11px; padding:4px 6px; }
  .grid{ display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
  ul{ margin:6px 0 0 16px; }
  .small{ color:#666; font-size:11px; }
</style></head>
<body>
  <div class="head">
    <div>
      <div class="brand">GEO-Analyse · Maschinenlesbarkeit</div>
      <div class="small">DMVConsult – Beate Zöllner – dmv daten- & medienverarbeitung – In der Esmecke 31 – 59846 Sundern – mobil 0171 64 79030</div>
    </div>
    <div class="meta">Domain: <b>${esc(host)}</b><br>Erstellt: ${new Date().toLocaleString()}</div>
  </div>

  <h1>Executive Summary</h1>
  <div class="score">
    <div class="badge"><b>Score</b><br>${r.score.total}/100</div>
    <div class="badge"><b>Structured</b><br>${r.score.breakdown.structuredData}</div>
    <div class="badge"><b>Technical</b><br>${r.score.breakdown.technical}</div>
    <div class="badge"><b>Content</b><br>${r.score.breakdown.content}</div>
    <div class="badge"><b>Social</b><br>${r.score.breakdown.social}</div>
    <div class="badge"><b>Seiten gescannt</b><br>${r.counts.pagesScanned}</div>
    <div class="badge"><b>Seiten mit Issues</b><br>${r.counts.pagesWithIssues}</div>
    <div class="badge"><b>Fehler/Warn/Hinw</b><br>${r.counts.severityCounts.Fehler||0} / ${r.counts.severityCounts.Warnung||0} / ${r.counts.severityCounts.Hinweis||0}</div>
    <div class="badge"><b>Sitemap-Coverage</b><br>${r.sitemap.coveragePct ?? "—"}%</div>
  </div>

  <div class="grid">
    <div>
      <h2>Auffälligkeiten (Hauptseite)</h2>
      <ul>${issues}</ul>
      ${r.orphanCandidates?.length ? `<h2>Orphan-Kandidaten (Sitemap, nicht gecrawlt · max 50)</h2><ul class="small">${r.orphanCandidates.map(u=>`<li>${esc(u)}</li>`).join("")}</ul>` : ""}
    </div>
    <div>
      <h2>Hauptseite – Kennzahlen</h2>
      ${table([
        `<tr>${td("URL")}${td(main.finalUrl)}</tr>`,
        `<tr>${td("HTTP-Status / Redirect-Kette")}${td(`${main.http.status} / ${main.http.redirectChain}`)}</tr>`,
        `<tr>${td("Indexierbar")}${td(main.flags.indexable ? "Ja" : "Nein")}</tr>`,
        `<tr>${td("Title/Description")}${td(`${main.meta.titleLength} / ${main.meta.metaDescriptionLength}`)}</tr>`,
        `<tr>${td("Wortzahl (Body)")}${td(main.flags.wordCount)}</tr>`,
        `<tr>${td("H1/H2")}${td(`${main.headings.h1Count}/${main.flags.h2Count}`)}</tr>`,
        `<tr>${td("ALT-Fehlquote / Lazy-Load")}${td(`${Math.round((main.images.missingAltRatio||0)*100)}% / ${main.flags.lazyRatio}%`)}</tr>`,
        `<tr>${td("JSON-LD Typen")}${td(sdList || "—")}</tr>`,
        `<tr>${td("RAW→DOM Delta")}${td((main.flags.renderDeltaPct??0)+"%")}</tr>`,
        `<tr>${td("Assets (KB) total / img / js / css")}${td(
          `${totalToKB(main.flags.bytes.total)} / ${totalToKB(main.flags.bytes.img)} / ${totalToKB(main.flags.bytes.js)} / ${totalToKB(main.flags.bytes.css)}`
        )}</tr>`,
        `<tr>${td("Caching / URL sauber")}${td((main.flags.hasCaching?"Ja":"Nein") + " / " + (main.flags.urlClean?"Ja":"Nein"))}</tr>`
      ], ["Feld","Wert"], "narrow")}
    </div>
  </div>

  <h2>Check-Matrix (1–14 Themenfelder)</h2>
  ${table(matrixRows, ["Kategorie","Prüfpunkt","Status"], "striped narrow")}

  <h2>Sitemap-Stichprobe (nur Seiten mit Findings)</h2>
  ${table(smRows, ["URL","Status","Title","Desc","H1","H2","Wörter","JSON-LD","#Findings"], "striped narrow")}

  <h2>Crawl-Stichprobe (nur Seiten mit Findings)</h2>
  ${table(crRows, ["URL","Status","Title","Desc","H1","H2","Wörter","JSON-LD","#Findings"], "striped narrow")}

  <h2>Befundtabelle (alle Findings)</h2>
  ${table(findRows, ["URL","Kategorie","Fundstelle","Status","Issue","Fix","Beispiel","Impact"], "striped narrow")}

  <h2>Was bedeuten die Fehler & wie beheben?</h2>
  <ul class="small">
    <li><b>Indexierung/Technik</b>: 2xx/3xx sicherstellen, keine Ketten; <b>robots.txt</b> nicht pauschal blocken; <b>Canonical</b> je Seite setzen; <b>Sitemap</b> in robots.txt verlinken.</li>
    <li><b>Performance/Rendering</b>: große Bilder verkleinern/komprimieren, <b>lazy</b>-Loading nutzen, CSS/JS minimieren, Caching (Cache-Control max-age) aktivieren; <b>CSR-Delta</b> groß → SSR/SSG erwägen.</li>
    <li><b>Struktur/Semantik</b>: Title 50–60, Description 140–180; genau 1× H1; H2/H3-Hierarchie ohne Sprünge; saubere, kurze URLs; Breadcrumbs im Markup (Schema).</li>
    <li><b>OG & Social</b>: og:title/description/image; Twitter <i>summary_large_image</i> für gute Previews.</li>
    <li><b>Schema.org</b>: WebSite(+SearchAction), Organization/LocalBusiness(+NAP), BreadcrumbList, FAQPage; Product→Offer mit price/priceCurrency/availability; Article→author/date.</li>
    <li><b>Content & LLM</b>: ≥200 Wörter Kerntext; Alt-Texte für Bilder; JSON-LD im <head>, nicht verspätet via JS injizieren.</li>
    <li><b>GEO</b>: NAP-Konsistenz (Telefon/Adresse/Öffnungszeiten) auszeichnen; Bewertungen/AggregateRating wo passend.</li>
    <li><b>A11y/Recht</b>: <code>&lt;html lang&gt;</code>, Formular-Labels/ARIA; Impressum & Datenschutz klar verlinken; Consent-Banner DSGVO-konform.</li>
  </ul>

  <p class="small">Hinweis: Ohne externe Messung (Lighthouse/CrUX) sind Performance-Werte Heuristiken.</p>
</body></html>`;
}

app.get("/api/report/:jobId.pdf", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "done")
    return res.status(409).json({ error: "Job not finished", status: job.status });

  const html = buildReportHtml(job.result);
  const chromium = await getChromium();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.setContent(html, { waitUntil: "load" });
  const pdf = await page.pdf({
    format: "A4",
    landscape: true,
    printBackground: true,
    margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
  });
  await browser.close();

  const filename = `geo-report_${new URL(job.result.requestedUrl).hostname}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(Buffer.from(pdf));
});

// ---------- Boot ----------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`GEO Analyzer Server listening on http://localhost:${PORT}`));

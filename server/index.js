// ---- Debug / Error Handling ----
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e);
});
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e);
});

console.log('[boot] Loading modules...');
import express from "express";
import cors from "cors";
import { load as loadHTML } from "cheerio";
import { parseStringPromise } from "xml2js";
import { z } from "zod";
import crypto from "node:crypto";
import { URL } from "node:url";

console.log('[boot] Modules loaded. Creating app...');
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// --- Health & Debug routes early ---
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/debug", (_req, res) => res.json({ pid: process.pid, ts: Date.now() }));

// In-Memory Job Store (MVP)
const jobs = new Map(); // jobId -> { status, progress, result, error }

const AnalyzeBody = z.object({
  url: z.string().url(),
  sampleSitemap: z.boolean().optional().default(true),
  maxSamplePages: z.number().int().min(1).max(50).optional().default(10)
});

function normOrigin(input) { const u = new URL(input); return `${u.protocol}//${u.host}`; }
const textLen = (s) => (s || "").trim().length;

function headingOrderIssues($) {
  const hs = $("h1, h2, h3, h4, h5, h6").toArray().map(el => Number(el.tagName.substring(1)));
  const issues = [];
  for (let i = 1; i < hs.length; i++) {
    const prev = hs[i - 1], cur = hs[i];
    if (cur - prev > 1) issues.push(`Heading jump from H${prev} to H${cur} at index ${i}`);
  }
  return issues;
}

function parseRobotsTxt(text) {
  const lines = (text || "").split(/\r?\n/);
  const sitemaps = []; const disallow = [];
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

function scoreFromFlags(f) {
  let sd=0; if (f.hasJSONLD) sd+=15; if (f.hasOrganization) sd+=8; if (f.hasWebsite) sd+=7; if (f.hasSearchAction) sd+=10;
  let tech=0; if (f.hasCanonical) tech+=8; if (f.indexable) tech+=12; if (f.robotsTxtFound) tech+=5; if (f.sitemapFound) tech+=5;
  let content=0; if (f.h1Count===1) content+=8; if (f.goodAltRatio) content+=7; if (f.langSet) content+=5;
  let social=0; if (f.ogOk) social+=6; if (f.twitterOk) social+=4;
  const total = Math.max(0, Math.min(100, sd+tech+content+social));
  return { total, breakdown: { structuredData: sd, technical: tech, content, social } };
}

// ---------- Analyse: Playwright jetzt DYNAMISCH importieren ----------
async function analyzeSinglePage(url) {
  // Playwright erst hier importieren; falls der Import fehlschlägt, bleibt der Server trotzdem oben
  console.log('[analyzeSinglePage] dynamic import playwright...');
  const { chromium } = await import("playwright");
  console.log('[analyzeSinglePage] launching chromium...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (compatible; GEO-Analyzer/1.0; +https://example.com/bot)"
  });
  const page = await context.newPage();

  let response;
  try {
    response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    await browser.close();
    return { error: `Navigation failed: ${e.message}` };
  }

  const finalUrl = page.url();
  const status = response?.status() ?? 0;
  const headers = response?.headers() ?? {};
  const xRobots = headers["x-robots-tag"] || "";

  const html = await page.content();
  const $ = loadHTML(html);

  const title = $("title").first().text().trim();
  const metaDesc = $('meta[name="description"]').attr("content") || "";
  const lang = $("html").attr("lang") || "";
  const canonical = $('link[rel="canonical"]').attr("href") || "";
  const robotsMeta = $('meta[name="robots"]').attr("content") || "";

  const h1s = $("h1").toArray().map(el => $(el).text().trim());
  const imgs = $("img").toArray();
  const missingAlt = imgs.filter(el => !$(el).attr("alt") || $(el).attr("alt").trim()==="").length;
  const goodAltRatio = imgs.length === 0 ? true : (missingAlt / imgs.length) <= 0.2;

  const og = {
    title: $('meta[property="og:title"]').attr("content") || "",
    description: $('meta[property="og:description"]').attr("content") || "",
    image: $('meta[property="og:image"]').attr("content") || "",
    type: $('meta[property="og:type"]').attr("content") || "",
    url: $('meta[property="og:url"]').attr("content") || ""
  };
  const twitter = {
    card: $('meta[name="twitter:card"]').attr("content") || "",
    title: $('meta[name="twitter:title"]').attr("content") || "",
    description: $('meta[name="twitter:description"]').attr("content") || "",
    image: $('meta[name="twitter:image"]').attr("content") || ""
  };

  const hreflang = $('link[rel="alternate"][hreflang]').toArray().map(el => ({
    lang: $(el).attr("hreflang"), href: $(el).attr("href")
  }));

  const jsonLdBlocks = [];
  const jsonLdErrors = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try { jsonLdBlocks.push(JSON.parse(raw)); }
    catch(e){ jsonLdErrors.push(`Invalid JSON-LD: ${e.message}`); }
  });

  const jsonLdTypes = {};
  const collectTypes = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) return obj.forEach(collectTypes);
    if (obj["@type"]) {
      const ts = Array.isArray(obj["@type"]) ? obj["@type"] : [obj["@type"]];
      ts.forEach(t => jsonLdTypes[t] = (jsonLdTypes[t] || 0) + 1);
    }
    for (const v of Object.values(obj)) collectTypes(v);
  };
  jsonLdBlocks.forEach(collectTypes);

  let hasSearchAction = false;
  jsonLdBlocks.flatMap(b => Array.isArray(b) ? b : [b]).forEach(item => {
    if (item?.["@type"]==="WebSite" && item.potentialAction?.["@type"]==="SearchAction") hasSearchAction = true;
  });

  const metaNoindex = (robotsMeta || "").toLowerCase().includes("noindex");
  const xRobotsNoindex = (xRobots || "").toLowerCase().includes("noindex");
  const indexable = status >= 200 && status < 400 && !metaNoindex && !xRobotsNoindex;

  const flags = {
    hasJSONLD: jsonLdBlocks.length > 0,
    hasOrganization: !!jsonLdTypes["Organization"] || !!jsonLdTypes["LocalBusiness"],
    hasWebsite: !!jsonLdTypes["WebSite"],
    hasSearchAction,
    hasCanonical: !!canonical,
    indexable,
    robotsTxtFound: false,
    sitemapFound: false,
    h1Count: h1s.length,
    goodAltRatio,
    langSet: !!lang,
    ogOk: !!og.title || !!og.description || !!og.image,
    twitterOk: !!twitter.card || !!twitter.title || !!twitter.description
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
      cacheControl: headers["cache-control"] || ""
    },
    meta: { title, titleLength: textLen(title), metaDescription: metaDesc, metaDescriptionLength: textLen(metaDesc), lang, canonical, robotsMeta },
    headings: { h1Count: h1s.length, h1: h1s, orderIssues: headingOrderIssues($) },
    images: { count: imgs.length, missingAlt, missingAltRatio: imgs.length ? (missingAlt / imgs.length) : 0 },
    social: { og, twitter },
    hreflang,
    structuredData: { jsonLdCount: jsonLdBlocks.length, types: jsonLdTypes, errors: jsonLdErrors },
    flags
  };
}

// --- Sitemap + Robots + Sampling (leicht) ----------------------
async function getSitemapUrls(origin) {
  let robotsTxt = ""; let sitemaps = []; let disallow = [];
  try {
    const r = await fetch(`${origin}/robots.txt`, { redirect: "follow" });
    if (r.ok) {
      robotsTxt = await r.text();
      const parsed = parseRobotsTxt(robotsTxt);
      sitemaps = parsed.sitemaps; disallow = parsed.disallow;
    }
  } catch { /* ignore */ }

  if (sitemaps.length === 0) sitemaps.push(`${origin}/sitemap.xml`);

  const urls = new Set();
  for (const sm of sitemaps) {
    try {
      const res = await fetch(sm, { redirect: "follow" });
      if (!res.ok) continue;
      const xml = await res.text();
      const parsed = await parseStringPromise(xml);
      if (parsed.sitemapindex?.sitemap) {
        for (const s of parsed.sitemapindex.sitemap) if (s.loc?.[0]) urls.add(s.loc[0]);
      } else if (parsed.urlset?.url) {
        for (const u of parsed.urlset.url) if (u.loc?.[0]) urls.add(u.loc[0]);
      }
    } catch { /* ignore */ }
  }
  return { robotsTxtFound: !!robotsTxt, disallow, sitemapFound: urls.size > 0, sitemapCandidates: sitemaps, urls: Array.from(urls) };
}

async function lightweightSampleAnalyze(url) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    const status = res.status;
    const ct = res.headers.get("content-type") || "";
    if (!res.ok || !ct.includes("text/html")) return { url, status, ok: false, reason: "Non-HTML or not OK" };
    const html = await res.text();
    const $ = loadHTML(html);
    const title = $("title").first().text().trim();
    const h1Count = $("h1").length;
    const types = {};
    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).contents().text();
      try {
        const data = JSON.parse(raw);
        (Array.isArray(data) ? data : [data]).forEach(item => {
          const t = item["@type"]; if (!t) return;
          (Array.isArray(t) ? t : [t]).forEach(tt => types[tt] = (types[tt] || 0) + 1);
        });
      } catch {}
    });
    return { url, status, ok: true, titleLen: textLen(title), h1Count, jsonLdCount: $('script[type="application/ld+json"]').length, types };
  } catch (e) {
    return { url, ok: false, reason: e.message };
  }
}

// --- Job Runner -------------------------------------------------
async function runJob(jobId, url, { sampleSitemap, maxSamplePages }) {
  const set = (patch) => { const cur = jobs.get(jobId) || {}; jobs.set(jobId, { ...cur, ...patch }); };

  try {
    set({ status: "running", progress: 2 });

    const main = await analyzeSinglePage(url);
    if (main.error) throw new Error(main.error);
    set({ progress: 35 });

    const origin = normOrigin(main.finalUrl || url);
    const sm = await getSitemapUrls(origin);

    main.flags.robotsTxtFound = sm.robotsTxtFound;
    main.flags.sitemapFound = sm.sitemapFound;
    set({ progress: 50 });

    let sampledPages = [];
    if (sampleSitemap && sm.urls.length > 0) {
      const take = sm.urls.slice(0, maxSamplePages);
      let done = 0;
      for (const u of take) {
        sampledPages.push(await lightweightSampleAnalyze(u));
        done++; set({ progress: 50 + Math.round((done / take.length) * 40) });
      }
    }

    const issues = [];
    if (!main.flags.indexable) issues.push("Seite ist vermutlich nicht indexierbar (Status/robots).");
    if (!main.meta.canonical) issues.push("Canonical-Tag fehlt.");
    if (!main.flags.hasJSONLD) issues.push("Keine JSON-LD Daten gefunden.");
    if (!main.flags.hasOrganization) issues.push("Organization/LocalBusiness Schema fehlt.");
    if (!main.flags.hasWebsite) issues.push("WebSite Schema fehlt.");
    if (!main.flags.hasSearchAction) issues.push("SearchAction im WebSite Schema fehlt.");
    if (main.headings.h1Count !== 1) issues.push(`H1-Anzahl ist ${main.headings.h1Count} (sollte 1 sein).`);
    if (!main.flags.langSet) issues.push("<html lang> nicht gesetzt.");
    if (!main.flags.ogOk) issues.push("OpenGraph-Tags fehlen/unvollständig.");
    if (main.images.missingAlt > 0 && main.images.missingAlt / (main.images.count || 1) > 0.2) issues.push("Zu viele Bilder ohne ALT-Text (>20%).");

    const score = scoreFromFlags(main.flags);

    const result = {
      requestedUrl: url,
      main,
      robots: { found: sm.robotsTxtFound, disallow: sm.disallow },
      sitemap: { found: sm.sitemapFound, candidates: sm.sitemapCandidates, sampleCount: sampledPages.length },
      sampledPages,
      issues,
      score
    };

    set({ status: "done", progress: 100, result });
  } catch (e) {
    set({ status: "error", error: e.message });
  }
}

// --- API Endpoints ----------------------------------------------
app.post("/api/analyze", (req, res) => {
  const parsed = AnalyzeBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { url, sampleSitemap, maxSamplePages } = parsed.data;
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: "queued", progress: 0 });

  // Fire-and-forget (läuft im Hintergrund)
  runJob(jobId, url, { sampleSitemap, maxSamplePages });

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
  if (job.status !== "done") return res.status(409).json({ error: "Job not finished", status: job.status });
  res.json(job.result);
});

const PORT = process.env.PORT || 3001;
console.log('[boot] calling listen...');
app.listen(PORT, () => {
  console.log(`GEO Analyzer Server listening on http://localhost:${PORT}`);
});

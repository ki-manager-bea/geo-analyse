// ---- Debug / Error Handling ----
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

console.log('[boot] Loading modules...');
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
const jobs = new Map();

// ---------- Helpers ----------
const UA = "Mozilla/5.0 (compatible; GEO-Analyzer/1.1; +https://example.com/bot)";
function normOrigin(input){ const u = new URL(input); return `${u.protocol}//${u.host}`; }
const textLen = (s) => (s || "").trim().length;
const isHtmlCT = (ct) => (ct||"").toLowerCase().includes("text/html");
const ASSET_RE = /\.(?:xml|jpg|jpeg|png|gif|webp|svg|avif|pdf|zip|rar|7z|mp4|webm|mp3|wav|woff2?|ttf|ico)(?:\?|#|$)/i;
const DEFAULT_EXCLUDE = "/wp-content/|/uploads/|\\.(?:xml|jpg|jpeg|png|gif|webp|svg|avif|pdf|zip|rar|7z|mp4|webm|mp3|wav|woff2?|ttf|ico)(?:\\?.*)?$";

function headingOrderIssues($){
  const hs = $("h1,h2,h3,h4,h5,h6").toArray().map(el => Number(el.tagName[1]));
  const issues = [];
  for (let i=1;i<hs.length;i++){
    const prev = hs[i-1], cur = hs[i];
    if (cur - prev > 1) issues.push(`Sprung von H${prev} auf H${cur} (Index ${i})`);
  }
  return issues;
}
function parseRobotsTxt(text){
  const lines = (text||"").split(/\r?\n/);
  const sitemaps = []; const disallow = [];
  for (const line of lines){
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
function scoreFromFlags(f){
  let sd=0; if (f.hasJSONLD) sd+=10; if (f.hasOrganization) sd+=8; if (f.hasLocalBusiness) sd+=10; if (f.hasWebsite) sd+=7; if (f.hasSearchAction) sd+=8; if (f.hasBreadcrumb) sd+=4; if (f.hasFAQ) sd+=6; if (f.hasArticle) sd+=5;
  let tech=0; if (f.hasCanonical) tech+=6; if (f.indexable) tech+=12; if (f.robotsTxtFound) tech+=4; if (f.sitemapFound) tech+=4; if (f.langSet) tech+=4; if (f.hOrderOk) tech+=4;
  let content=0; if (f.h1Count===1) content+=6; if (f.h2Count>=1) content+=3; if (f.wordCount>=200) content+=6; if (f.goodAltRatio) content+=5; if (f.metaDescGood) content+=5; if (f.titleGood) content+=5;
  let social=0; if (f.ogOk) social+=4; if (f.twitterOk) social+=3;
  const total = Math.max(0, Math.min(100, sd+tech+content+social));
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
  // default: filter Assets raus
  excludePatterns: z.array(z.string()).optional().default([DEFAULT_EXCLUDE]),
  guessCommonPaths: z.boolean().optional().default(true),
  deepAnalyzeLimit: z.number().int().min(0).max(200).optional().default(30)
});

// ---------- Playwright ----------
async function getChromium(){ const { chromium } = await import("playwright"); return chromium; }

// ---------- Full (rendered) analyse ----------
async function analyzeSinglePage(url){
  const chromium = await getChromium();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();

  let response;
  try{
    response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(()=>{});
  }catch(e){
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

  const h1s = $("h1").toArray().map(el=>$(el).text().trim());
  const h2Count = $("h2").length;
  const imgs = $("img").toArray();
  const missingAlt = imgs.filter(el => !$(el).attr("alt") || $(el).attr("alt").trim()==="").length;
  const goodAltRatio = imgs.length === 0 ? true : (missingAlt / imgs.length) <= 0.2;
  const textWords = $("body").text().replace(/\s+/g," ").trim().split(" ").filter(Boolean).length;

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

  const hasWebsite = !!jsonLdTypes["WebSite"];
  const hasOrganization = !!jsonLdTypes["Organization"];
  const hasLocalBusiness = !!jsonLdTypes["LocalBusiness"];
  const hasBreadcrumb = !!jsonLdTypes["BreadcrumbList"];
  const hasFAQ = !!jsonLdTypes["FAQPage"];
  const hasArticle = !!jsonLdTypes["Article"] || !!jsonLdTypes["BlogPosting"] || !!jsonLdTypes["NewsArticle"];

  let hasSearchAction = false;
  jsonLdBlocks.flatMap(b => Array.isArray(b) ? b : [b]).forEach(item => {
    if (item?.["@type"]==="WebSite" && item.potentialAction?.["@type"]==="SearchAction") hasSearchAction = true;
  });

  const metaNoindex = (robotsMeta || "").toLowerCase().includes("noindex");
  const xRobotsNoindex = (xRobots || "").toLowerCase().includes("noindex");
  const indexable = status>=200 && status<400 && !metaNoindex && !xRobotsNoindex;

  const flags = {
    hasJSONLD: jsonLdBlocks.length > 0,
    hasOrganization, hasLocalBusiness, hasWebsite, hasSearchAction, hasBreadcrumb, hasFAQ, hasArticle,
    hasCanonical: !!canonical,
    indexable,
    robotsTxtFound: false,
    sitemapFound: false,
    h1Count: h1s.length,
    h2Count,
    hOrderOk: headingOrderIssues($).length===0,
    goodAltRatio,
    langSet: !!lang,
    ogOk: !!og.title || !!og.description || !!og.image,
    twitterOk: !!twitter.card || !!twitter.title || !!twitter.description,
    wordCount: textWords,
    titleGood: textLen(title)>=30 && textLen(title)<=65,
    metaDescGood: textLen(metaDesc)>=80 && textLen(metaDesc)<=170
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
    meta: {
      title, titleLength: textLen(title),
      metaDescription: metaDesc, metaDescriptionLength: textLen(metaDesc),
      lang, canonical, robotsMeta
    },
    headings: { h1Count: h1s.length, h1: h1s, orderIssues: headingOrderIssues($) },
    images: { count: imgs.length, missingAlt, missingAltRatio: imgs.length ? (missingAlt / imgs.length) : 0 },
    social: { og, twitter },
    structuredData: { jsonLdCount: jsonLdBlocks.length, types: jsonLdTypes, errors: jsonLdErrors },
    flags
  };
}

// ---------- Sitemap (deep) ----------
async function getSitemapDeep(origin, cap = 3000){
  const seenSitemaps = new Set();
  const urls = new Set();
  let robotsTxt = ""; let candidates = [];

  try{
    const r = await fetch(`${origin}/robots.txt`, { headers: { "User-Agent": UA }, redirect: "follow" });
    if (r.ok){
      robotsTxt = await r.text();
      const parsed = parseRobotsTxt(robotsTxt);
      candidates = parsed.sitemaps;
    }
  }catch{}
  if (candidates.length === 0) candidates = [`${origin}/sitemap.xml`];

  async function fetchXml(u){
    try{ const r = await fetch(u, { headers: { "User-Agent": UA }, redirect: "follow" }); if (!r.ok) return null; return await r.text(); }catch{ return null; }
  }
  async function expand(smUrl){
    if (seenSitemaps.has(smUrl) || urls.size >= cap) return;
    seenSitemaps.add(smUrl);
    const xml = await fetchXml(smUrl);
    if (!xml) return;
    let parsed = {};
    try{ parsed = await parseStringPromise(xml); }catch{ return; }

    if (parsed.sitemapindex?.sitemap){
      for (const s of parsed.sitemapindex.sitemap){
        const loc = s?.loc?.[0];
        if (loc) await expand(loc);
        if (urls.size >= cap) break;
      }
    }else if (parsed.urlset?.url){
      for (const u of parsed.urlset.url){
        const loc = u?.loc?.[0];
        if (!loc) continue;
        try{
          const href = new URL(loc);
          if (ASSET_RE.test(href.pathname)) continue;
          urls.add(href.toString());
        }catch{}
        if (urls.size >= cap) break;
      }
    }
  }
  for (const sm of candidates){
    if (urls.size >= cap) break;
    await expand(sm);
  }
  return { robotsTxtFound: !!robotsTxt, sitemapFound: urls.size>0, sitemapCandidates: candidates, urls: Array.from(urls) };
}

// ---------- Light Analyse ----------
async function lightweightSampleAnalyze(url){
  try{
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
    const wordCount = $("body").text().replace(/\s+/g," ").trim().split(" ").filter(Boolean).length;
    const orderIssues = headingOrderIssues($);

    const jsonLdBlocks = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).contents().text();
      try{ jsonLdBlocks.push(JSON.parse(raw)); }catch{}
    });
    const types = {};
    const collect = (obj) => {
      if (!obj || typeof obj!=="object") return;
      if (Array.isArray(obj)) return obj.forEach(collect);
      if (obj["@type"]){ (Array.isArray(obj["@type"])?obj["@type"]:[obj["@type"]]).forEach(t=>types[t]=(types[t]||0)+1); }
      for (const v of Object.values(obj)) collect(v);
    };
    jsonLdBlocks.forEach(collect);

    const imgs = $("img").toArray();
    const missingAlt = imgs.filter(el => !$(el).attr("alt") || $(el).attr("alt").trim()==="").length;
    const jsonLdCount = jsonLdBlocks.length;

    const ogCore = $('meta[property="og:title"]').length + $('meta[property="og:description"]').length + $('meta[property="og:image"]').length;

    return {
      url, status, ok: true, ct,
      titleLen: textLen(title), metaDescLen: textLen(metaDesc),
      canonical: !!canonical, robots: robotsMeta, lang: !!lang,
      h1Count, h2Count, wordCount, orderIssues: orderIssues.length,
      jsonLdCount, types,
      images: { count: imgs.length, missingAlt },
      ogCore
    };
  }catch(e){
    return { url, ok: false, reason: e.message };
  }
}

// ---------- Pattern Utils ----------
function compilePatterns(arr){ return (arr||[]).map(s=>{ try{ return new RegExp(s,'i'); }catch{ return null; } }).filter(Boolean); }
function matchAny(res, s){ return !res?.length || res.some(re => re.test(s)); }
function matchNone(res, s){ return !res?.length || !res.some(re => re.test(s)); }

// ---------- Common-path probe ----------
async function probeCommonPaths(origin){
  const candidates = ["/geo","/leistungen","/service","/kontakt","/impressum","/datenschutz","/faq","/standorte","/ueber-uns","/portfolio","/cases","/blog","/news"]
    .flatMap(p=>[p,p+"/"]);
  const found = [];
  for (const p of candidates){
    const r = await lightweightSampleAnalyze(origin+p);
    if (r.ok) found.push(origin+p);
  }
  return Array.from(new Set(found));
}

// ---------- Crawl (BFS; optional rendered) ----------
async function crawlInternal(startUrl, {
  maxPages=500, includeParams=false, render=true, keepHashSections=true,
  seeds=[], includePatterns=[], excludePatterns=[]
} = {}) {
  const start = new URL(startUrl);
  const registrable = start.host.split(".").slice(-2).join(".");
  const incRE = compilePatterns(includePatterns);
  const excRE = compilePatterns(excludePatterns.length?excludePatterns:[DEFAULT_EXCLUDE]);

  const seedList = [start.href, ...seeds.filter(s=>{
    try{ const u=new URL(s); return u.host.split(".").slice(-2).join(".")===registrable; }catch{ return false; }
  })];

  const seen = new Set(seedList);
  const out = [...seedList];
  const q = [...seedList];

  const chromium = render ? await getChromium() : null;
  const browser = render ? await chromium.launch({ headless: true }) : null;
  const ctx = render ? await browser.newContext({ userAgent: UA }) : null;

  while (q.length && out.length < maxPages){
    const u = q.shift();
    try{
      const hrefs = [];
      if (render){
        const page = await ctx.newPage();
        await page.goto(u, { waitUntil:"domcontentloaded", timeout:25000 });
        await page.waitForLoadState("networkidle",{timeout:10000}).catch(()=>{});
        hrefs.push(...await page.$$eval("a[href]", els => els.map(a=>a.getAttribute("href")).filter(Boolean)));
        await page.close();
      }else{
        const r = await fetch(u, { headers: { "User-Agent": UA }, redirect:"follow" });
        const ct = r.headers.get("content-type") || "";
        if (!isHtmlCT(ct)) continue;
        const html = await r.text();
        const $ = loadHTML(html);
        $("a[href]").each((_,a)=>hrefs.push(a.attribs.href));
      }
      for (let href of hrefs){
        try{
          const abs = new URL(href, u);
          if (!["http:","https:"].includes(abs.protocol)) continue;
          const reg2 = abs.host.split(".").slice(-2).join(".");
          if (reg2 !== registrable) continue;
          if (!includeParams) abs.search = "";
          if (!keepHashSections) abs.hash = "";
          const s = abs.toString();
          if (ASSET_RE.test(abs.pathname)) continue;
          if (!matchAny(incRE, s)) continue;
          if (!matchNone(excRE, s)) continue;
          if (!seen.has(s) && seen.size < maxPages*6){ seen.add(s); q.push(s); out.push(s); }
        }catch{}
      }
    }catch{}
  }
  if (browser) await browser.close();
  return Array.from(new Set(out));
}

// ---------- Findings (8 Spalten) ----------
const mkFinding = (url,category,location,status,issue,fix,example,impact="mittel") =>
  ({ url, category, location, status, issue, fix, example, impact });

// Regeln für Light-Pages
function findingsForQuickPage(p){
  const F = [];
  if (!p || !p.ok) {
    // Nur echte HTTP-Fehler melden (kein Asset-„Fehler“ mehr)
    if (typeof p?.status==="number" && (p.status<200 || p.status>=400))
      F.push(mkFinding(p.url,"Indexierung","HTTP","Fehler",`HTTP-Status ${p.status}`,"2xx/3xx sicherstellen","Server/Route prüfen","hoch"));
    return F;
  }
  // Title
  if (p.titleLen<30 || p.titleLen>65)
    F.push(mkFinding(p.url,"Onpage","<title>","Warnung","Title-Länge unideal (30–65)","präzise, klickstark formulieren","<title>Keyword | Marke</title>","mittel"));
  // Description
  if (p.metaDescLen && (p.metaDescLen<80 || p.metaDescLen>170))
    F.push(mkFinding(p.url,"Onpage","<meta description>","Hinweis","Description außerhalb 80–170","kurz, unique, CTA","<meta name='description' ...>","niedrig"));
  if (!p.metaDescLen)
    F.push(mkFinding(p.url,"Onpage","<meta description>","Warnung","Description fehlt","unique Description ergänzen","<meta name='description' content='…'>","mittel"));
  // Canonical
  if (!p.canonical)
    F.push(mkFinding(p.url,"Technik/Indexierung","<head>","Warnung","Canonical fehlt","<link rel='canonical'> setzen","<link rel='canonical' href='…'>","mittel"));
  // Robots
  const robots = (p.robots||"").toLowerCase();
  if (robots.includes("noindex"))
    F.push(mkFinding(p.url,"Technik/Indexierung","<meta robots>","Fehler","noindex gesetzt","Indexierung erlauben","<meta name='robots' content='index,follow'>","hoch"));
  // Lang
  if (!p.lang)
    F.push(mkFinding(p.url,"Internationalisierung","<html lang>","Warnung","Sprachangabe fehlt","lang-Attribut setzen","<html lang='de'>","niedrig"));
  // Headings
  if (p.h1Count!==1)
    F.push(mkFinding(p.url,"Struktur & Semantik","Body","Warnung","Genau eine H1 je Seite empfohlen","präzise H1 setzen","<h1>Seitenfokus</h1>","mittel"));
  if (p.h2Count<1)
    F.push(mkFinding(p.url,"Struktur & Semantik","Body","Hinweis","Mindestens eine H2 sinnvoll","Abschnitte strukturieren","<h2>Abschnitt</h2>","niedrig"));
  if (p.orderIssues>0)
    F.push(mkFinding(p.url,"Struktur & Semantik","Headings","Hinweis","Überschriften-Sprünge","hierarchisch gliedern","H2→H3→H4…","niedrig"));
  // Content
  if (typeof p.wordCount==="number" && p.wordCount<200)
    F.push(mkFinding(p.url,"Content","Body","Warnung","Sehr wenig Text (<200 Wörter)","Informationsdichte erhöhen","Antworten/FAQs integrieren","mittel"));
  // JSON-LD
  if (!p.jsonLdCount)
    F.push(mkFinding(p.url,"Strukturierte Daten","<head>","Warnung","Kein JSON-LD vorhanden","passendes Schema.org ergänzen",'{"@context":"https://schema.org","@type":"…"}',"mittel"));
  // OG/Twitter
  if (!p.ogCore)
    F.push(mkFinding(p.url,"Social Preview","<meta property='og:*'>","Hinweis","OpenGraph-Basis fehlt","og:title/description/image setzen","og:title / og:description / og:image","niedrig"));
  return F;
}

// ---------- Job Runner ----------
async function runJob(jobId, url, opts){
  const set = (patch) => { const cur = jobs.get(jobId) || {}; jobs.set(jobId, { ...cur, ...patch }); };
  const {
    seedSitemap, sampleSitemap, maxSamplePages,
    crawl, renderCrawl, maxCrawlPages,
    deepAnalyzeLimit, keepHashSections, includeParams,
    extraSeeds, includePatterns, excludePatterns,
    guessCommonPaths
  } = opts;

  try{
    set({ status: "running", progress: 2 });

    // 1) Main (deep)
    const main = await analyzeSinglePage(url);
    if (main.error) throw new Error(main.error);
    set({ progress: 18 });

    const origin = normOrigin(main.finalUrl || url);

    // 2) Sitemap deep
    const sm = seedSitemap ? await getSitemapDeep(origin, Math.max(maxSamplePages, maxCrawlPages)) : { urls: [] };
    main.flags.robotsTxtFound = !!sm.robotsTxtFound;
    main.flags.sitemapFound  = !!sm.sitemapFound;
    set({ progress: 32 });

    // 3) Seeds (manual + guess)
    let manualSeeds = Array.isArray(extraSeeds)?extraSeeds.slice():[];
    if (guessCommonPaths){
      try{ const guessed = await probeCommonPaths(origin); manualSeeds.push(...guessed); }catch{}
    }
    manualSeeds = Array.from(new Set(manualSeeds));

    // 4) Discovery = sitemap + crawl + seeds
    let discovered = new Set([...(sm.urls||[]), ...manualSeeds]);
    if (crawl){
      const crawled = await crawlInternal(main.finalUrl || url, {
        maxPages: maxCrawlPages, render: renderCrawl, keepHashSections, includeParams,
        seeds: manualSeeds, includePatterns, excludePatterns
      });
      crawled.forEach(u => discovered.add(u));
    }
    const allUrls = Array.from(discovered);
    set({ progress: 48 });

    // 5) Stichproben + Findings
    const sampledPages = [];
    const crawlAnalyses = [];
    const findings = [];

    if (sampleSitemap && sm.urls?.length){
      for (const u of sm.urls.slice(0, maxSamplePages)){
        const p = await lightweightSampleAnalyze(u);
        // nur HTML-Seiten aufnehmen
        if (p.ok) sampledPages.push(p);
        findings.push(...findingsForQuickPage(p));
      }
    }
    for (const u of allUrls.slice(0, Math.min(maxCrawlPages, allUrls.length))){
      const p = await lightweightSampleAnalyze(u);
      if (p.ok) crawlAnalyses.push(p);
      findings.push(...findingsForQuickPage(p));
    }
    set({ progress: 74 });

    // 6) Deep Analyse weiterer Seiten (rendered)
    const deepTargets = allUrls.filter(u => u !== (main.finalUrl || url) && !ASSET_RE.test(new URL(u).pathname)).slice(0, deepAnalyzeLimit);
    for (let i=0;i<deepTargets.length;i++){
      const u = deepTargets[i];
      const d = await analyzeSinglePage(u);
      if (!d.flags.indexable) findings.push(mkFinding(u,"Indexierung","HTTP","Fehler","Nicht indexierbar (Status/robots)","Status/robots prüfen","X-Robots/META anpassen","hoch"));
      if (!d.meta.canonical) findings.push(mkFinding(u,"Technik/Indexierung","<head>","Warnung","Canonical fehlt","<link rel='canonical'> setzen","<link rel='canonical' href='…'>","mittel"));
      if (!d.flags.hasJSONLD) findings.push(mkFinding(u,"Strukturierte Daten","<head>","Warnung","Kein JSON-LD","passendes Schema.org ergänzen",'{"@context":"https://schema.org","@type":"…"}',"mittel"));
      if (!d.flags.titleGood) findings.push(mkFinding(u,"Onpage","<title>","Warnung","Title-Länge unideal (30–65)","präzise formulieren","<title>Keyword | Marke</title>","mittel"));
      if (!d.flags.metaDescGood) findings.push(mkFinding(u,"Onpage","<meta description>","Hinweis","Description 80–170","optimieren","<meta name='description' ...>","niedrig"));
      if (d.flags.h1Count!==1) findings.push(mkFinding(u,"Struktur & Semantik","Body","Warnung","Genau eine H1 empfohlen","präzise H1 setzen","<h1>…</h1>","mittel"));
      if (!d.flags.hOrderOk) findings.push(mkFinding(u,"Struktur & Semantik","Headings","Hinweis","Überschriften-Sprünge","hierarchisch gliedern","H2→H3→H4…","niedrig"));
      if (!d.flags.ogOk) findings.push(mkFinding(u,"Social Preview","OG","Hinweis","OG-Basis fehlt","og:title/description/image setzen","og:title …","niedrig"));
      if (d.images.missingAltRatio>0.2) findings.push(mkFinding(u,"Zugänglichkeit","<img>","Hinweis",">20% ohne ALT-Text","Alt-Texte ergänzen","<img alt='…'>","niedrig"));
      set({ progress: 74 + Math.round(((i+1)/Math.max(1,deepTargets.length))*20) });
    }

    // 7) Main Issues + Score
    const issues = [];
    if (!main.flags.indexable) issues.push("Seite ist vermutlich nicht indexierbar (Status/robots).");
    if (!main.meta.canonical) issues.push("Canonical-Tag fehlt.");
    if (!main.flags.hasJSONLD) issues.push("Keine JSON-LD Daten gefunden.");
    if (!main.flags.hasOrganization) issues.push("Organization Schema fehlt.");
    if (!main.flags.hasWebsite) issues.push("WebSite Schema fehlt.");
    if (!main.flags.hasSearchAction) issues.push("SearchAction im WebSite Schema fehlt.");
    if (!main.flags.langSet) issues.push("<html lang> nicht gesetzt.");
    if (main.headings.h1Count !== 1) issues.push(`H1-Anzahl ist ${main.headings.h1Count} (sollte 1 sein).`);
    if (!main.flags.ogOk) issues.push("OpenGraph-Tags fehlen/unvollständig.");
    if (main.images.missingAltRatio>0.2) issues.push("Zu viele Bilder ohne ALT-Text (>20%).");
    if (!main.flags.metaDescGood) issues.push("Meta-Description fehlt oder ist suboptimal (80–170).");
    if (!main.flags.titleGood) issues.push("Title-Länge unideal (30–65).");
    if (!main.flags.hOrderOk) issues.push("Überschriften-Sprünge erkannt.");

    const score = scoreFromFlags(main.flags);

    const result = {
      requestedUrl: url,
      main,
      robots: { found: !!sm.robotsTxtFound },
      sitemap: { found: !!sm.sitemapFound, candidates: sm.sitemapCandidates || [], sampleCount: Math.min(maxSamplePages, sm.urls?.length || 0) },
      discoveredCount: allUrls.length,
      discoveredPages: allUrls,
      sampledPages,
      crawl: { count: crawlAnalyses.length, analyses: crawlAnalyses },
      findings,
      issues,
      score
    };
    set({ status: "done", progress: 100, result });
  }catch(e){
    set({ status: "error", error: e.message });
  }
}

// ---------- API ----------
app.post("/api/analyze", (req, res) => {
  const parsed = AnalyzeBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: "queued", progress: 0 });
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
  if (job.status !== "done") return res.status(409).json({ error: "Job not finished", status: job.status });
  res.json(job.result);
});

// ---------- PDF ----------
function esc(s){return (s??"").toString().replace(/[&<>]/g,m=>({ "&":"&amp;","<":"&lt;",">":"&gt;"}[m]));}
function td(v){return `<td>${esc(v)}</td>`;}
function table(rows, headers, cls=""){
  return `<table class="tbl ${cls}"><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}
function buildReportHtml(r){
  const host = new URL(r.requestedUrl).host;
  const main = r.main;
  const issues = r.issues?.map(x=>`<li>${esc(x)}</li>`).join("") || "";
  const sd = main.structuredData?.types || {};
  const sdList = Object.keys(sd).map(k=>`${esc(k)} (${sd[k]})`).join(", ");

  const smRows = (r.sampledPages||[]).map(p=>`<tr>${td(p.url)}${td(p.status)}${td(p.titleLen)}${td(p.metaDescLen)}${td(p.h1Count)}${td(p.h2Count)}${td(p.wordCount)}${td(p.jsonLdCount)}${td(p.ogCore? "ja":"—")}</tr>`);
  const crRows = (r.crawl?.analyses||[]).map(p=>`<tr>${td(p.url)}${td(p.status)}${td(p.titleLen)}${td(p.metaDescLen)}${td(p.h1Count)}${td(p.h2Count)}${td(p.wordCount)}${td(p.jsonLdCount)}${td(p.ogCore? "ja":"—")}</tr>`);
  const findRows = (r.findings||[]).map(x=>`<tr>${td(x.url)}${td(x.category)}${td(x.location)}${td(x.status)}${td(x.issue)}${td(x.fix)}${td(x.example)}${td(x.impact)}</tr>`);

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>GEO-Report ${esc(host)}</title>
<style>
  @page{ size:A4; margin:16mm 12mm; }
  body{ font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-size:12px; color:#111; }
  h1{ font-size:22px; margin:0 0 6px; } h2{ font-size:16px; margin:18px 0 8px; }
  .head{ display:flex; justify-content:space-between; gap:16px; margin-bottom:8px; }
  .brand{ font-weight:600; } .meta{ font-size:11px; color:#555; }
  .score{ display:flex; gap:10px; margin:6px 0 8px; }
  .badge{ border:1px solid #ddd; padding:6px 8px; border-radius:8px; background:#fafafa; min-width:90px; text-align:center; }
  .tbl{ width:100%; border-collapse:collapse; table-layout:fixed; }
  .tbl th,.tbl td{ border:1px solid #e6e6e6; padding:6px 8px; vertical-align:top; word-break:break-word; }
  .tbl th{ background:#f7f7f7; text-align:left; white-space:nowrap; }
  .tbl.striped tbody tr:nth-child(odd){ background:#fcfcfc; }
  .tbl.narrow td,.tbl.narrow th{ font-size:11px; padding:5px 6px; }
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

  <h1>Gesamtbericht</h1>
  <div class="score">
    <div class="badge"><b>Score</b><br>${r.score.total}/100</div>
    <div class="badge"><b>Structured</b><br>${r.score.breakdown.structuredData}</div>
    <div class="badge"><b>Technical</b><br>${r.score.breakdown.technical}</div>
    <div class="badge"><b>Content</b><br>${r.score.breakdown.content}</div>
    <div class="badge"><b>Social</b><br>${r.score.breakdown.social}</div>
  </div>

  <div class="grid">
    <div>
      <h2>Auffälligkeiten (Hauptseite)</h2>
      <ul>${issues}</ul>
    </div>
    <div>
      <h2>Hauptseite – Kennzahlen</h2>
      ${table([
        `<tr>${td("URL")}${td(main.finalUrl)}</tr>`,
        `<tr>${td("HTTP-Status")}${td(main.http.status)}</tr>`,
        `<tr>${td("Indexierbar")}${td(main.flags.indexable ? "Ja" : "Nein")}</tr>`,
        `<tr>${td("Title-Länge")}${td(main.meta.titleLength)}</tr>`,
        `<tr>${td("Description-Länge")}${td(main.meta.metaDescriptionLength)}</tr>`,
        `<tr>${td("Wortzahl (Body)")}${td(main.flags.wordCount)}</tr>`,
        `<tr>${td("H1/H2")}${td(`${main.headings.h1Count}/${main.flags.h2Count}`)}</tr>`,
        `<tr>${td("ALT-Fehlquote")}${td(`${Math.round((main.images.missingAltRatio||0)*100)}%`)}</tr>`,
        `<tr>${td("JSON-LD Typen")}${td(sdList || "—")}</tr>`
      ], ["Feld","Wert"], "narrow")}
    </div>
  </div>

  <h2>Sitemap-Stichprobe (${r.sitemap.sampleCount})</h2>
  ${table(smRows, ["URL","Status","Title","Desc","H1","H2","Wörter","JSON-LD","OG"], "striped narrow")}

  <h2>Discovered Pages (gesamt: ${r.discoveredCount})</h2>
  ${table((r.discoveredPages||[]).map(u=>`<tr>${td(u)}</tr>`), ["URL"], "narrow")}

  <h2>Befundtabelle (alle Seiten)</h2>
  ${table(findRows, ["URL","Kategorie","Fundstelle","Status","Issue","Fix","Beispiel","Impact"], "striped narrow")}

  <h2>Crawl-Stichprobe (${r.crawl.count})</h2>
  ${table(crRows, ["URL","Status","Title","Desc","H1","H2","Wörter","JSON-LD","OG"], "striped narrow")}

  <h2>Legende</h2>
  <ul class="small">
    <li><b>Status</b>: Fehler = muss behoben werden; Warnung = sollte optimiert werden; Hinweis = nice-to-have.</li>
    <li><b>Impact</b>: hoch = Indexierung/Vertrauen gefährdet · mittel = Sichtbarkeit/CTR · niedrig = kosmetisch.</li>
    <li><b>Title/Description</b>: Zielspannweiten 30–65 / 80–170 Zeichen. <b>Wörter</b>: &ge; 200 empfehlenswert.</li>
    <li><b>JSON-LD</b>: Für KI-Sichtbarkeit wichtig: WebSite+SearchAction, Organization/LocalBusiness, BreadcrumbList, FAQPage, Article/BlogPosting.</li>
  </ul>

  <p class="small">Hinweis: „OK“ in Tabellen bedeutet: HTML 2xx/3xx und analysierbare Grunddaten. Für Core Web Vitals sind separate Messungen nötig.</p>
</body></html>`;
}

app.get("/api/report/:jobId.pdf", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "done") return res.status(409).json({ error: "Job not finished", status: job.status });

  const html = buildReportHtml(job.result);
  const chromium = await getChromium();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 960 } });
  await page.setContent(html, { waitUntil: "load" });
  const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "16mm", right: "12mm", bottom: "16mm", left: "12mm" } });
  await browser.close();

  const filename = `geo-report_${new URL(job.result.requestedUrl).hostname}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(Buffer.from(pdf));
});

// ---------- Boot ----------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`GEO Analyzer Server listening on http://localhost:${PORT}`));

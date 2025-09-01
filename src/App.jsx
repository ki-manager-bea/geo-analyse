// app.jsx
import { useEffect, useMemo, useRef, useState } from "react";

/* -------------------- HTTP Helpers -------------------- */
async function parseJsonSafe(res) {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  const text = await res.text();
  throw new Error(`HTTP ${res.status} ${res.statusText} – keine JSON-Antwort: ${text.slice(0, 200)}`);
}
async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    try {
      const data = await parseJsonSafe(res);
      throw new Error(data?.error ? JSON.stringify(data.error) : `HTTP ${res.status}`);
    } catch (e) {
      if (e.message?.startsWith?.("HTTP")) throw e;
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt.slice(0, 200)}`);
    }
  }
  return await parseJsonSafe(res);
}
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt.slice(0, 200)}`);
  }
  return await parseJsonSafe(res);
}

/* -------------------- Client HTML Report (iframe srcDoc) -------------------- */
function esc(s) {
  return (s ?? "").toString().replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
}
const td = (v) => `<td>${esc(v)}</td>`;
function table(rows, headers, cls = "") {
  return `<table class="tbl ${cls}"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}
function totalToKB(x) {
  return Math.round((x || 0) / 1024);
}
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

  const idealTitle = main.meta.titleLength >= 50 && main.meta.titleLength <= 60;
  const idealDesc = main.meta.metaDescriptionLength >= 140 && main.meta.metaDescriptionLength <= 180;

  const matrix = [
    ["Technik/Indexierung", "HTTP 2xx/3xx", mark(main.http.status >= 200 && main.http.status < 400)],
    ["Technik/Indexierung", "Redirect-Kette ≤1", mark(main.http.redirectChain <= 1)],
    ["Technik/Indexierung", "robots.txt erreichbar", mark(r.robots.found)],
    ["Technik/Indexierung", "Sitemap in robots.txt verlinkt", mark(r.robots.sitemapListedInRobots)],
    ["Technik/Indexierung", "Sitemap vorhanden", mark(r.sitemap.found)],
    ["Technik/Indexierung", "No broad Disallow", mark(!r.robots.broadBlock)],
    ["Technik/Indexierung", "<meta robots> nicht noindex", mark(!(main.meta.robotsMeta || "").toLowerCase().includes("noindex"))],
    ["Technik/Indexierung", "Canonical vorhanden", mark(!!main.meta.canonical)],
    ["Technik/Indexierung", "Sitemap-Abdeckung", `${r.sitemap.coveragePct ?? "—"}%`],

    ["Internationalisierung", "hreflang vorhanden", mark(main.flags.hreflangCount > 0 || "warn")],
    ["Internationalisierung", "x-default vorhanden", mark(main.flags.hreflangCount > 0 ? (main.flags.hreflangXDefault ? "ok" : "warn") : "warn")],

    ["Performance/Rendering", "Große Bilder (>500KB) ≤3", mark(main.flags.bigImages <= 3 ? "ok" : "warn")],
    ["Performance/Rendering", "Lazy-Load sinnvoll", mark(main.flags.lazyRatio >= 50 ? "ok" : "warn")],
    ["Performance/Rendering", "CSR-Delta moderat", mark(main.flags.renderDeltaPct != null && main.flags.renderDeltaPct <= 50 ? "ok" : "warn")],
    ["Performance/Rendering", "Caching-Header", mark(main.flags.hasCaching ? "ok" : "warn")],

    ["Struktur/Semantik", "Title 50–60", mark(idealTitle ? "ok" : "warn")],
    ["Struktur/Semantik", "Description 140–180", mark(idealDesc ? "ok" : "warn")],
    ["Struktur/Semantik", "1× H1", mark(main.headings.h1Count === 1)],
    ["Struktur/Semantik", "H2 vorhanden", mark(main.flags.h2Count >= 1 ? "ok" : "warn")],
    ["Struktur/Semantik", "Heading-Hierarchie", mark(main.flags.hOrderOk ? "ok" : "warn")],
    ["Struktur/Semantik", "URL sauber", mark(main.flags.urlClean ? "ok" : "warn")],
    ["Struktur/Semantik", "Breadcrumb (Schema)", mark(main.flags.hasBreadcrumb ? "ok" : "warn")],

    ["OG/Social", "OG komplett (T/D/Img)", mark(main.flags.ogComplete ? "ok" : "warn")],
    ["OG/Social", "Twitter Card", mark(main.flags.twitterOk ? "ok" : "warn")],
    ["OG/Social", "summary_large_image", mark(main.flags.twitterLarge ? "ok" : "warn")],

    ["Schema.org", "WebSite (+SearchAction)", mark(main.flags.hasWebsite && main.flags.hasSearchAction ? "ok" : "warn")],
    ["Schema.org", "Organization/LocalBusiness", mark(main.flags.hasOrganization || main.flags.hasLocalBusiness ? "ok" : "warn")],
    ["Schema.org", "FAQ/Breadcrumb/Article", mark(main.flags.hasFAQ || main.flags.hasBreadcrumb || main.flags.hasArticle ? "ok" : "warn")],
    ["Schema.org", "Product(+Offer)", mark(main.flags.hasProduct ? (main.flags.productFields.offer && main.flags.productFields.price && main.flags.productFields.currency ? "ok" : "warn") : "warn")],

    ["Content & LLM", "≥200 Wörter", mark(main.flags.wordCount >= 200 ? "ok" : "warn")],
    ["Content & LLM", "ALT-Quote ok", mark(main.images.missingAltRatio <= 0.2 ? "ok" : "warn")],
    ["Content & LLM", "JSON-LD im <head>", mark(main.flags.jsonLdInHead ? "ok" : "warn")],

    ["GEO/Local", "NAP vollständig", mark(main.flags.hasLocalBusiness ? (main.flags.localFields.telephone && main.flags.localFields.address ? "ok" : "warn") : "warn")],
    ["GEO/Local", "Öffnungszeiten vorhanden", mark(main.flags.hasLocalBusiness ? (main.flags.localFields.hours ? "ok" : "warn") : "warn")],

    ["Barrierefreiheit/Recht", "<html lang>", mark(!!main.meta.lang)],
    ["Barrierefreiheit/Recht", "Form-Labels (Stichprobe)", "→ siehe Tabellen"],
    ["Barrierefreiheit/Recht", "Impressum/Datenschutz verlinkt", "→ siehe Tabellen"],
  ];

  const matrixRows = matrix.map((rw) => `<tr>${td(rw[0])}${td(rw[1])}${td(rw[2])}</tr>`);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"><title>GEO-Report ${esc(host)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root{ --bg:#ffffff; --fg:#111; --muted:#666; --card:#fafafa; --border:#e6e6e6; --accent:#1e88e5; }
  body{ font-family:-apple-system, Segoe UI, Roboto, Arial, sans-serif; font-size:12px; color:var(--fg); margin:0; background:var(--bg); }
  .wrap{ padding:16px; }
  h1{ font-size:22px; margin:0 0 6px; } h2{ font-size:16px; margin:16px 0 8px; }
  .head{ display:flex; gap:16px; justify-content:space-between; align-items:flex-start; margin-bottom:8px; }
  .brand{ font-weight:600; } .meta{ font-size:11px; color:var(--muted); }
  .score{ display:flex; gap:10px; flex-wrap:wrap; margin:6px 0 8px; }
  .badge{ border:1px solid var(--border); padding:6px 8px; border-radius:8px; background:var(--card); min-width:120px; text-align:center; }
  .tbl{ width:100%; border-collapse:collapse; table-layout:fixed; }
  .tbl th,.tbl td{ border:1px solid var(--border); padding:5px 7px; vertical-align:top; word-break:break-word; }
  .tbl th{ background:#f7f7f7; text-align:left; white-space:nowrap; }
  .tbl.striped tbody tr:nth-child(odd){ background:#fcfcfc; }
  .tbl.narrow td,.tbl.narrow th{ font-size:11px; padding:4px 6px; }
  .grid{ display:grid; grid-template-columns: 1fr; gap:10px; }
  @media (min-width: 900px){ .grid{ grid-template-columns: 1fr 1fr; } }
  ul{ margin:6px 0 0 16px; }
  .small{ color:var(--muted); font-size:11px; }
</style>
</head>
<body>
  <div class="wrap">
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

    <h2>Hinweise zur Behebung</h2>
    <ul class="small">
      <li><b>Indexierung/Technik</b>: 2xx/3xx sicherstellen, keine Ketten; <b>robots.txt</b> nicht pauschal blocken; <b>Canonical</b> je Seite setzen; <b>Sitemap</b> in robots.txt verlinken.</li>
      <li><b>Performance/Rendering</b>: große Bilder verkleinern/komprimieren, <b>lazy</b>-Loading nutzen, CSS/JS minimieren, Caching aktivieren; <b>CSR-Delta</b> groß → SSR/SSG erwägen.</li>
      <li><b>Struktur/Semantik</b>: Title 50–60, Description 140–180; genau 1× H1; H2/H3-Hierarchie ohne Sprünge; saubere URLs; Breadcrumbs (Schema).</li>
      <li><b>OG & Social</b>: og:title/description/image; Twitter <i>summary_large_image</i> für gute Previews.</li>
      <li><b>Schema.org</b>: WebSite(+SearchAction), Organization/LocalBusiness(+NAP), BreadcrumbList, FAQPage; Product→Offer (price/currency/availability); Article→author/date.</li>
      <li><b>Content & LLM</b>: ≥200 Wörter Kerntext; Alt-Texte; JSON-LD früh im <head>.</li>
      <li><b>GEO</b>: NAP-Konsistenz (Telefon/Adresse/Öffnungszeiten) auszeichnen; Bewertungen/AggregateRating wo passend.</li>
      <li><b>A11y/Recht</b>: <code>&lt;html lang&gt;</code>, Formular-Labels/ARIA; Impressum & Datenschutz klar verlinken; Consent-Banner DSGVO-konform.</li>
    </ul>
  </div>
</body>
</html>`;
}

/* -------------------- UI -------------------- */
function Badge({ label, value }) {
  return (
    <div className="badge">
      <div className="small">{label}</div>
      <div className="score">{value}</div>
    </div>
  );
}

export default function App() {
  const [url, setUrl] = useState("https://dmv-consult.de/");
  const [sampling, setSampling] = useState(true);
  const [maxSamplePages, setMaxSamplePages] = useState(10);
  const [showDebug, setShowDebug] = useState(false);

  const [jobId, setJobId] = useState(null);
  const [status, setStatus] = useState(null);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [logs, setLogs] = useState([]);
  const pollingRef = useRef(null);
  const abortRef = useRef(null);

  const canAnalyze = useMemo(() => {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }, [url]);

  function clearPolling() {
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = null;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }

  async function startAnalyze() {
    setResult(null);
    setError("");
    setStatus("queued");
    setProgress(0);
    setJobId(null);
    setLogs([]);
    clearPolling();

    try {
      const data = await postJson("/api/analyze", {
        url,
        seedSitemap: true,
        sampleSitemap: sampling,
        maxSamplePages: Number(maxSamplePages),
        crawl: true,
        renderCrawl: true,
        maxCrawlPages: 800,
        deepAnalyzeLimit: 50,
        keepHashSections: true,
        includeParams: false,
        includePatterns: [],
        excludePatterns: [],
        guessCommonPaths: true,
        debug: showDebug,
      });
      if (!data?.jobId) throw new Error("Antwort ohne jobId");
      setJobId(data.jobId);
    } catch (e) {
      setStatus("error");
      setError(e.message || "Unbekannter Fehler beim Start");
    }
  }

  useEffect(() => {
    if (!jobId) return;
    clearPolling();

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    async function tick() {
      try {
        const s = await getJson(`/api/status/${jobId}`);
        setStatus(s.status);
        setProgress(s.progress ?? 0);

        if (showDebug) {
          const l = await getJson(`/api/logs/${jobId}`);
          setLogs(l.logs || []);
        }

        if (s.status === "done") {
          clearPolling();
          const data = await getJson(`/api/result/${jobId}`);
          setResult(data);
        } else if (s.status === "error") {
          clearPolling();
          setError("Job ist im Backend mit Fehler abgebrochen.");
        }
      } catch (e) {
        clearPolling();
        setStatus("error");
        setError(e.message || "Polling fehlgeschlagen.");
      }
    }

    tick();
    pollingRef.current = setInterval(tick, 1500);
    return () => clearPolling();
  }, [jobId, showDebug]);

  function downloadJSON() {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u;
    a.download = "geo-analysis.json";
    a.click();
    URL.revokeObjectURL(u);
  }

  function openBrowserReport() {
    if (!result) return;
    const html = buildReportHtml(result);
    const win = window.open("", "_blank");
    if (win) {
      win.document.open();
      win.document.write(html);
      win.document.close();
    }
  }

  const downloading = status === "running" || status === "queued";

  return (
    <div className="container">
      <style>{`
        :root{ --bg:#0b0f19; --card:#12172a; --fg:#e9eefc; --muted:#9fb0d9; --line:#233056; --accent:#3ea6ff; --danger:#ff5577; }
        body{ background:var(--bg); color:var(--fg); }
        .container{ max-width:1080px; margin:36px auto; padding:0 16px; }
        .card{ background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; }
        h1{ margin:0 0 12px; font-size:22px; }
        .row{ display:flex; gap:10px; }
        input[type="url"]{ flex:1; background:#0e1426; color:var(--fg); border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
        input[type="number"]{ background:#0e1426; color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:6px 8px; }
        label.small{ font-size:13px; color:var(--muted); display:flex; align-items:center; gap:6px; }
        button{ background:var(--accent); color:#000; border:none; padding:10px 14px; border-radius:10px; font-weight:600; cursor:pointer; }
        button[disabled]{ opacity:.5; cursor:not-allowed; }
        .small{ color:var(--muted); font-size:12px; }
        .progress{ background:#0e1426; border:1px solid var(--line); border-radius:8px; height:8px; overflow:hidden; }
        .progress>div{ background:linear-gradient(90deg,#3ea6ff,#72f3ff); height:100%; transition:width .4s ease; }
        .error{ color:#ffd5dd; background:#3a0f1e; border:1px solid #5b1a2d; padding:10px; border-radius:8px; }
        .score{ font-size:26px; font-weight:700; }
        .badge{ display:inline-flex; flex-direction:column; gap:2px; align-items:flex-start; background:#0e1426; border:1px solid var(--line); padding:10px; border-radius:10px; min-width:120px; }
        .actions{ display:flex; gap:8px; flex-wrap:wrap; }
        .iframeWrap{ margin-top:12px; height:75vh; border:1px solid var(--line); border-radius:12px; overflow:hidden; }
        .logs{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,"Liberation Mono","Courier New", monospace; white-space:pre; color:#9fd3ff; font-size:12px; }
      `}</style>

      <div className="card">
        <h1>GEO-Analyse (Frontend)</h1>
        <div className="row">
          <input
            type="url"
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={downloading}
          />
          <button onClick={startAnalyze} disabled={!canAnalyze || downloading}>
            {downloading ? "Analysiere…" : "Analysieren"}
          </button>
        </div>

        <div className="row" style={{ marginTop: 8, gap: 20, alignItems: "center", flexWrap: "wrap" }}>
          <label className="small">
            <input type="checkbox" checked={sampling} onChange={(e) => setSampling(e.target.checked)} disabled={downloading} />
            Zusätzlich bis zu
            <input
              style={{ width: 60 }}
              type="number"
              min={1}
              max={400}
              value={maxSamplePages}
              onChange={(e) => setMaxSamplePages(e.target.value)}
              disabled={!sampling || downloading}
            />
            Sitemap-URLs samplen
          </label>

          <label className="small">
            <input
              type="checkbox"
              checked={showDebug}
              onChange={(e) => setShowDebug(e.target.checked)}
              disabled={downloading && !jobId}
            />
            Debug-Logs anzeigen
          </label>
        </div>

        {status && (
          <div style={{ marginTop: 16 }}>
            <div className="small">
              Status: {status} ({progress || 0}%)
            </div>
            <div className="progress" style={{ marginTop: 6 }}>
              <div style={{ width: `${progress || 0}%` }} />
            </div>
            {error && (
              <div className="error" style={{ marginTop: 8 }}>
                {error}
              </div>
            )}
          </div>
        )}

        {showDebug && logs.length > 0 && (
          <div className="card" style={{ marginTop: 12, maxHeight: 220, overflow: "auto", background: "#0f1220" }}>
            <div className="logs">
              {logs.map((l) => `[${l.ts}] [${l.level}] ${l.msg}${l.extra ? " " + JSON.stringify(l.extra) : ""}`).join("\n")}
            </div>
          </div>
        )}
      </div>

      {result && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="row" style={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
            <div>
              <div className="small">Analyzed</div>
              <div>
                <strong>{result.requestedUrl}</strong>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="small">GEO Score</div>
              <div className="score">{result.score.total}</div>
              <div className="small">
                SD {result.score.breakdown.structuredData} • Tech {result.score.breakdown.technical} • Content{" "}
                {result.score.breakdown.content} • Social {result.score.breakdown.social}
              </div>
            </div>
          </div>

          <div className="actions" style={{ marginTop: 16 }}>
            <button onClick={downloadJSON}>JSON exportieren</button>
            <a href={`/api/report/${jobId}.pdf`} target="_blank" rel="noopener noreferrer">
              <button>PDF herunterladen</button>
            </a>
            <button onClick={openBrowserReport}>Bericht im Browser öffnen</button>
          </div>

          {/* Live-Ansicht im Browser via iframe */}
          <div className="iframeWrap">
            <iframe
              title="GEO Report"
              style={{ width: "100%", height: "100%", border: "0" }}
              srcDoc={buildReportHtml(result)}
              sandbox="allow-same-origin allow-popups allow-top-navigation-by-user-activation"
            />
          </div>
        </div>
      )}
    </div>
  );
}

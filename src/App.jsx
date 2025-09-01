import { useEffect, useMemo, useRef, useState } from "react";

async function parseJsonSafe(res) {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  const text = await res.text();
  throw new Error(`HTTP ${res.status} ${res.statusText} – keine JSON-Antwort: ${text.slice(0,200)}`);
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
      if (e.message.startsWith("HTTP")) throw e;
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt.slice(0,200)}`);
    }
  }
  return await parseJsonSafe(res);
}
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt.slice(0,200)}`);
  }
  return await parseJsonSafe(res);
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
    try { new URL(url); return true; } catch { return false; }
  }, [url]);

  function clearPolling() {
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = null;
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
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
        debug: showDebug
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
    a.href = u; a.download = "geo-analysis.json"; a.click();
    URL.revokeObjectURL(u);
  }

  const downloading = status === "running" || status === "queued";

  return (
    <div className="container">
      <div className="card">
        <h1>GEO-Analyse (Frontend)</h1>
        <div className="row">
          <input
            type="url"
            placeholder="https://example.com"
            value={url}
            onChange={e => setUrl(e.target.value)}
            disabled={downloading}
          />
          <button onClick={startAnalyze} disabled={!canAnalyze || downloading}>
            {downloading ? "Analysiere…" : "Analysieren"}
          </button>
        </div>

        <div className="row" style={{ marginTop: 8, gap: 20, alignItems:"center" }}>
          <label className="small">
            <input type="checkbox" checked={sampling} onChange={e => setSampling(e.target.checked)} disabled={downloading}/>
            &nbsp;Zusätzlich bis zu&nbsp;
            <input
              style={{ width: 60 }}
              type="number"
              min={1}
              max={400}
              value={maxSamplePages}
              onChange={e => setMaxSamplePages(e.target.value)}
              disabled={!sampling || downloading}
            />
            &nbsp;Sitemap-URLs samplen
          </label>

          <label className="small">
            <input type="checkbox" checked={showDebug} onChange={e => setShowDebug(e.target.checked)} disabled={downloading && !jobId}/>
            &nbsp;Debug-Logs anzeigen
          </label>
        </div>

        {status && (
          <div style={{ marginTop: 16 }}>
            <div className="small">Status: {status} ({progress || 0}%)</div>
            <div className="progress" style={{ marginTop: 6 }}>
              <div style={{ width: `${progress || 0}%` }} />
            </div>
            {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
          </div>
        )}

        {showDebug && logs.length > 0 && (
          <div className="card" style={{ marginTop: 12, maxHeight: 220, overflow: "auto", background: "#0f1220" }}>
            <pre style={{ margin: 0, padding: 10, color: "#9fd3ff", fontSize: 12 }}>
{logs.map(l => `[${l.ts}] [${l.level}] ${l.msg}${l.extra ? " " + JSON.stringify(l.extra) : ""}`).join("\n")}
            </pre>
          </div>
        )}
      </div>

      {result && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div className="small">Analyzed</div>
              <div><strong>{result.requestedUrl}</strong></div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="small">GEO Score</div>
              <div className="score">{result.score.total}</div>
              <div className="small">
                SD {result.score.breakdown.structuredData} • Tech {result.score.breakdown.technical} • Content {result.score.breakdown.content} • Social {result.score.breakdown.social}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button onClick={downloadJSON}>JSON exportieren</button>
            <a href={`/api/report/${jobId}.pdf`} target="_blank" rel="noopener noreferrer">
              <button>PDF herunterladen</button>
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

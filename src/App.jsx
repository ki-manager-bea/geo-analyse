import { useEffect, useMemo, useRef, useState } from "react";

export default function App() {
  const [url, setUrl] = useState("");
  const [sampling, setSampling] = useState(true);
  const [maxSamplePages, setMaxSamplePages] = useState(10);

  const [jobId, setJobId] = useState(null);
  const [status, setStatus] = useState(null);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const pollingRef = useRef(null);

  const canAnalyze = useMemo(() => {
    try { new URL(url); return true; } catch { return false; }
  }, [url]);

  async function startAnalyze() {
    setResult(null); setError(""); setStatus("queued"); setProgress(0); setJobId(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, sampleSitemap: sampling, maxSamplePages: Number(maxSamplePages) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ? JSON.stringify(data.error) : "API-Fehler");
      setJobId(data.jobId);
    } catch {
      setStatus("error");
      setError("API nicht erreichbar oder noch nicht vorhanden. (Backend folgt im nächsten Schritt.)");
    }
  }

  useEffect(() => {
    if (!jobId) return;
    pollingRef.current && clearInterval(pollingRef.current);
    async function tick() {
      try {
        const r = await fetch(`/api/status/${jobId}`);
        if (!r.ok) throw new Error("Status-API nicht erreichbar");
        const s = await r.json();
        setStatus(s.status); setProgress(s.progress || 0);
        if (s.status === "done") {
          clearInterval(pollingRef.current);
          const rr = await fetch(`/api/result/${jobId}`);
          const data = await rr.json();
          setResult(data);
        }
        if (s.status === "error") clearInterval(pollingRef.current);
      } catch {
        setStatus("error"); setError("Polling fehlgeschlagen. Ist das Backend schon gestartet?");
        clearInterval(pollingRef.current);
      }
    }
    tick();
    pollingRef.current = setInterval(tick, 1500);
    return () => pollingRef.current && clearInterval(pollingRef.current);
  }, [jobId]);

  function downloadJSON() {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = u; a.download = "geo-analysis.json"; a.click();
    URL.revokeObjectURL(u);
  }

  function Badge({ ok, warn, children }) {
    const cls = ok ? "badge ok" : warn ? "badge warn" : "badge bad";
    return <span className={cls}>{children}</span>;
  }

  const sdTypes = result?.main?.structuredData?.types || {};
  const hasSd = !!result && Object.keys(sdTypes).length > 0;

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
          />
          <button onClick={startAnalyze} disabled={!canAnalyze || status === "queued" || status === "running"}>
            {status === "running" || status === "queued" ? "Analysiere…" : "Analysieren"}
          </button>
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          <label className="small">
            <input type="checkbox" checked={sampling} onChange={e => setSampling(e.target.checked)} />
            &nbsp;Zusätzlich bis zu&nbsp;
            <input
              style={{ width: 60 }}
              type="number"
              min={1}
              max={50}
              value={maxSamplePages}
              onChange={e => setMaxSamplePages(e.target.value)}
              disabled={!sampling}
            />
            &nbsp;Sitemap-URLs samplen
          </label>
        </div>

        {status && (
          <div style={{ marginTop: 16 }}>
            <div className="small">Status: {status}</div>
            <div className="progress" style={{ marginTop: 6 }}>
              <div style={{ width: `${progress || 0}%` }} />
            </div>
            {error && <div className="error">{error}</div>}
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

          <div className="grid" style={{ marginTop: 16 }}>
            <div className="card">
              <h3>Meta</h3>
              <div className="kv">
                <div>HTTP Status</div><div>{result.main.http.status}</div>
                <div>Title</div><div className="wrap">{result.main.meta.title || "—"}</div>
                <div>Meta-Description</div><div className="wrap">{result.main.meta.metaDescription || "—"}</div>
                <div>Lang</div><div>{result.main.meta.lang || "—"}</div>
                <div>Canonical</div><div className="wrap">{result.main.meta.canonical || "—"}</div>
              </div>
            </div>

            <div className="card">
              <h3>Strukturierte Daten</h3>
              <div className="small">JSON-LD Blöcke: {result.main.structuredData.jsonLdCount}</div>
              <pre className="code">
                {hasSd ? JSON.stringify(sdTypes, null, 2) : "—"}
              </pre>
            </div>

            <div className="card">
              <h3>Headings & Bilder</h3>
              <div className="kv">
                <div>H1-Anzahl</div><div>{result.main.headings.h1Count}</div>
                <div>Bilder</div><div>{result.main.images.count}</div>
                <div>Ohne ALT</div><div>{result.main.images.missingAlt}</div>
              </div>
            </div>

            <div className="card">
              <h3>Social</h3>
              <div className="badges">
                <Badge ok={!!(result.main.social.og.title || result.main.social.og.image)}>OpenGraph</Badge>
                <Badge ok={!!(result.main.social.twitter.card || result.main.social.twitter.title)}>Twitter Card</Badge>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <h3>Issues</h3>
            {result.issues.length === 0 ? (
              <div className="small">Keine Probleme erkannt.</div>
            ) : (
              <ul>
                {result.issues.map((x, i) => <li key={i}>{x}</li>)}
              </ul>
            )}
          </div>

          <div style={{ marginTop: 16 }}>
            <button onClick={downloadJSON}>JSON exportieren</button>
          </div>
        </div>
      )}
    </div>
  );
}

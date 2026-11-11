import { useEffect, useMemo, useState } from 'react';

type Metric = {
  breathingRate: number | null;
  confidence: number | null;
  stable: boolean;
  chestTrace: number | null;
  abdomenTrace: number | null;
  state: string;
  timestampUs: number;
};

export default function App() {
  const [cameras, setCameras] = useState<Array<{id:string;label:string}>>([]);
  const [cameraId, setCameraId] = useState('');
  const [consent, setConsent] = useState(false);
  const [running, setRunning] = useState(false);
  const [metric, setMetric] = useState<Metric | null>(null);
  const [status, setStatus] = useState('Not started');
  const [error, setError] = useState('');

  useEffect(() => {
    window.breatheSync.getCameras()
      .then((items) => {
        setCameras(items);
        if (items[0]) setCameraId(items[0].id);
      })
      .catch((e) => setError(e.message || 'Camera discovery failed'));

    const offMetrics = window.breatheSync.onMetrics((payload) => setMetric(payload as Metric));
    const offStatus = window.breatheSync.onStatus((payload: any) => {
      setStatus(payload.hint || payload.detail || payload.kind || 'Status updated');
    });
    const offError = window.breatheSync.onError((payload: any) => {
      setError(payload.message || 'SmartSpectra error');
    });

    return () => {
      offMetrics();
      offStatus();
      offError();
    };
  }, []);

  const confidenceLabel = useMemo(() => {
    if (metric?.confidence == null) return 'Waiting for a measurement';
    return metric.stable ? 'Stable measurement' : 'Measurement not yet stable';
  }, [metric]);

  async function start() {
    setError('');
    setMetric(null);
    try {
      await window.breatheSync.start(cameraId);
      setRunning(true);
    } catch (e: any) {
      setError(e.message || 'Unable to start measurement');
      setRunning(false);
    }
  }

  async function stop() {
    setError('');
    try {
      await window.breatheSync.stop();
    } catch (e: any) {
      setError(e.message || 'Unable to stop cleanly');
    } finally {
      setRunning(false);
    }
  }

  const waveform = metric?.chestTrace ?? metric?.abdomenTrace ?? 0;
  const scale = metric?.state === 'valid' ? 1 + Math.max(-0.18, Math.min(0.18, waveform * 0.08)) : 1;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-mark">B</div>
        <div><strong>BreatheSync</strong><small>Human sensing experience · Technical POC</small></div>
        <span className="status-pill">{running ? '● Measuring' : '○ Idle'}</span>
      </header>

      <section className="intro">
        <p className="eyebrow">PRESAGE SMARTSPECTRA INTEGRATION</p>
        <h1>See your breathing<br/><span>in real time.</span></h1>
        <p className="subcopy">A live-signal proof of concept. Measurements appear only when received from SmartSpectra.</p>
      </section>

      <section className="grid">
        <article className="card visual-card">
          <div className="card-heading"><div><p className="eyebrow">LIVE VISUAL</p><h2>Breathing field</h2></div><span className="live-dot"/></div>
          <div className="orb-stage">
            <div className="orb-ring ring-one" />
            <div className="orb-ring ring-two" />
            <div className="orb" style={{ transform: `scale(${scale})` }} />
            <span className="orb-caption">{metric?.state === 'valid' ? 'Signal responding' : 'Waiting for valid signal'}</span>
          </div>
          <p className="helper">The visual remains neutral until a valid breathing trace is available.</p>
        </article>

        <article className="card metrics-card">
          <p className="eyebrow">SMARTSPECTRA OUTPUT</p>
          <h2>Live measurements</h2>
          <div className="metric-block">
            <span>Breathing rate</span>
            <strong>{metric?.breathingRate == null ? '—' : metric.breathingRate.toFixed(1)} <small>{metric?.breathingRate == null ? '' : 'br/min'}</small></strong>
          </div>
          <div className="metric-block">
            <span>Confidence</span>
            <strong>{metric?.confidence == null ? '—' : `${metric.confidence.toFixed(0)}%`}</strong>
          </div>
          <div className="quality">{confidenceLabel}</div>
          <div className="trace-values">
            <div><span>Chest trace</span><b>{metric?.chestTrace == null ? '—' : metric.chestTrace.toFixed(3)}</b></div>
            <div><span>Abdominal trace</span><b>{metric?.abdomenTrace == null ? '—' : metric.abdomenTrace.toFixed(3)}</b></div>
          </div>
        </article>
      </section>

      <section className="card setup-card">
        <div><p className="eyebrow">SESSION CONTROL</p><h2>Camera and consent</h2></div>
        <label className="field-label" htmlFor="camera">Camera device</label>
        <select id="camera" value={cameraId} onChange={(e) => setCameraId(e.target.value)} disabled={running}>
          {cameras.length === 0 && <option value="">No camera detected</option>}
          {cameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.label}</option>)}
        </select>
        <label className="consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={running}/>
          <span>I understand that BreatheSync uses my camera to process breathing signals. This POC does not store raw video or session measurements. It is not a medical device.</span>
        </label>
        <div className="actions">
          {!running
            ? <button onClick={start} disabled={!consent || !cameraId}>Start measurement</button>
            : <button className="stop" onClick={stop}>Stop measurement</button>}
          <span className="status-text">{status}</span>
        </div>
        {error && <div className="error" role="alert">{error}</div>}
      </section>

      <footer>Local proof of concept · No diagnosis or treatment · SmartSpectra telemetry disabled in this configuration</footer>
    </main>
  );
}

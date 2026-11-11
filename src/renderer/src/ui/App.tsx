import React, { useEffect, useMemo, useState } from 'react';
import { WaveformGraph } from './WaveformGraph';
import {
  Activity,
  Camera,
  ShieldCheck,
  AlertCircle,
  Sun,
  Clock,
  RefreshCw,
  Info,
  RotateCcw,
} from 'lucide-react';
import { ACQUISITION_TIMEOUT_MS } from '../../../common/telemetry-utils';

type Metric = {
  breathingRate: number | null;
  confidence: number | null;
  stable: boolean;
  chestTrace: number | null;
  abdomenTrace: number | null;
  state: string;
  timestampUs: number;
  receivedAtMs?: number;
};

export default function App() {
  const [cameras, setCameras] = useState<Array<{ id: string; label: string }>>([]);
  const [cameraId, setCameraId] = useState('');
  const [consent, setConsent] = useState(false);
  const [running, setRunning] = useState(false);
  const [metric, setMetric] = useState<Metric | null>(null);
  const [status, setStatus] = useState('System standing by');
  const [error, setError] = useState('');
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [showTips, setShowTips] = useState(false);
  const [lastMetricTime, setLastMetricTime] = useState<number | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [acquisitionTimedOut, setAcquisitionTimedOut] = useState(false);

  // Load cameras
  const refreshCameras = () => {
    window.breatheSync.getCameras()
      .then((items) => {
        setCameras(items);
        if (items.length > 0 && !cameraId) {
          setCameraId(items[0].id);
        }
      })
      .catch((e) => setError(e.message || 'Camera discovery failed'));
  };

  useEffect(() => {
    refreshCameras();

    const offMetrics = window.breatheSync.onMetrics((payload) => {
      setMetric(payload as Metric);
      setLastMetricTime(Date.now());
      setIsStale(false);
      setAcquisitionTimedOut(false);
    });

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

  // Measurement freshness heartbeat: flags as stale if no new sample arrives in 2.5s
  useEffect(() => {
    if (!running) {
      setIsStale(false);
      return;
    }

    const interval = setInterval(() => {
      if (lastMetricTime && Date.now() - lastMetricTime > 2500) {
        setIsStale(true);
      }
    }, 500);

    return () => clearInterval(interval);
  }, [running, lastMetricTime]);

  // P1: Initial acquisition timeout: arms once per measurement session until a valid breathing rate arrives.
  // Trace-only frames do NOT reset this timer.
  const hasValidBreathingRate = metric?.breathingRate != null;

  useEffect(() => {
    if (!running) {
      setAcquisitionTimedOut(false);
      return;
    }

    if (hasValidBreathingRate) {
      setAcquisitionTimedOut(false);
      return;
    }

    const timeout = setTimeout(() => {
      setAcquisitionTimedOut(true);
    }, ACQUISITION_TIMEOUT_MS);

    return () => clearTimeout(timeout);
  }, [running, hasValidBreathingRate]);

  // Session elapsed timer
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (running) {
      setSessionSeconds(0);
      timer = setInterval(() => {
        setSessionSeconds((prev) => prev + 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [running]);

  const formatTimer = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const confidenceState = useMemo(() => {
    if (!running) return { label: 'Sensors Idle', color: 'neutral', icon: '○' };
    if (acquisitionTimedOut) return { label: 'Acquisition Timeout (No Face/Chest Detected)', color: 'warning', icon: '⚠️' };
    if (isStale) return { label: 'Signal Paused (Awaiting fresh samples)', color: 'warning', icon: '⏸' };
    if (metric?.confidence == null) return { label: 'Acquiring signal...', color: 'warning', icon: '◌' };
    if (metric.stable) return { label: 'Signal Stable (Confidence >= 45%)', color: 'success', icon: '●' };
    return { label: 'Calibrating (Low Confidence)', color: 'warning', icon: '◌' };
  }, [metric, running, isStale, acquisitionTimedOut]);

  async function start() {
    setError('');
    setMetric(null);
    setLastMetricTime(null);
    setIsStale(false);
    setAcquisitionTimedOut(false);

    try {
      await window.breatheSync.start(cameraId);
      setRunning(true);
    } catch (e: any) {
      setError(e.message || 'Unable to start measurement');
      setRunning(false);
    }
  }

  async function stop() {
    try {
      await window.breatheSync.stop();
    } catch (e: any) {
      setError(e.message || 'Unable to stop cleanly');
    } finally {
      setRunning(false);
      setMetric(null);
      setLastMetricTime(null);
      setIsStale(false);
      setAcquisitionTimedOut(false);
    }
  }

  async function restartMeasurement() {
    await stop();
    setTimeout(() => {
      start();
    }, 400);
  }

  const waveform = metric?.chestTrace ?? metric?.abdomenTrace ?? 0;
  const scale = (metric?.state === 'valid' && !isStale && !acquisitionTimedOut)
    ? 1 + Math.max(-0.16, Math.min(0.16, waveform * 0.08))
    : 1;

  return (
    <main className="shell">
      {/* Top Bar */}
      <header className="topbar">
        <div className="brand-group">
          <div className="brand-mark">
            <Activity size={22} strokeWidth={2.6} />
          </div>
          <div>
            <strong>BreatheSync</strong>
            <small>Presage SmartSpectra Physiological Telemetry</small>
          </div>
        </div>

        <div className="topbar-right">
          {running && (
            <div className="timer-badge">
              <Clock size={13} />
              <span>{formatTimer(sessionSeconds)}</span>
            </div>
          )}
          <span className={`status-pill ${running ? (isStale || acquisitionTimedOut ? 'stale' : 'measuring') : 'idle'}`}>
            <span className="pill-dot" />
            {running
              ? (acquisitionTimedOut ? 'Acquisition Delay' : isStale ? 'Signal Paused' : 'Live Measuring')
              : 'Sensor Idle'}
          </span>
        </div>
      </header>

      {/* Intro Section */}
      <section className="intro">
        <div className="intro-meta">
          <span className="eyebrow">SMARTSPECTRA HUMAN SENSING DEMO</span>
          <button
            type="button"
            className="tips-toggle-btn"
            onClick={() => setShowTips((prev) => !prev)}
          >
            <Info size={14} />
            <span>{showTips ? 'Hide Camera Tips' : 'Camera & Lighting Tips'}</span>
          </button>
        </div>
        <h1>
          Real-time respiratory sensing<br />
          <span>driven by continuous computer vision.</span>
        </h1>
        <p className="subcopy">
          Non-contact, camera-based measurement of respiratory kinematics. Every trace
          and rate metric is processed in volatile memory from live webcam video frames.
        </p>

        {/* Collapsible Tips Drawer */}
        {showTips && (
          <div className="tips-drawer">
            <div className="tip-item">
              <Sun size={16} className="tip-icon" />
              <div>
                <strong>Adequate Lighting</strong>
                <p>Ensure your face and chest are evenly lit without strong backlighting or shadows.</p>
              </div>
            </div>
            <div className="tip-item">
              <Camera size={16} className="tip-icon" />
              <div>
                <strong>Camera Framing</strong>
                <p>Position your webcam roughly 0.5 to 1.0 meters away so your upper torso is in frame.</p>
              </div>
            </div>
            <div className="tip-item">
              <Activity size={16} className="tip-icon" />
              <div>
                <strong>Steady Posture</strong>
                <p>Sit comfortably and remain relatively still while the neural model locks onto breathing motion.</p>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Main Grid: Visuals and Metrics */}
      <section className="grid">
        {/* Left Column: Breathing Field Orb & Oscilloscope Waveform */}
        <div className="visual-column">
          {/* Breathing Orb Card */}
          <article className="card visual-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">RESONANCE FIELD</p>
                <h2>Thoracic motion</h2>
              </div>
              <span className={`live-dot ${running ? (isStale || acquisitionTimedOut ? 'stale' : 'active') : ''}`} />
            </div>

            <div className="orb-stage">
              <div className="orb-ring ring-one" />
              <div className="orb-ring ring-two" />
              <div className="orb" style={{ transform: `scale(${scale})` }} />
              <span className="orb-caption">
                {!running
                  ? 'Sensors standing by'
                  : acquisitionTimedOut
                  ? 'Acquisition taking longer than expected · Check lighting & position'
                  : isStale
                  ? 'Signal paused · Waiting for fresh camera frames'
                  : metric?.state === 'valid'
                  ? 'Motion signal tracked & responding'
                  : 'Acquiring respiratory motion...'}
              </span>
            </div>
          </article>

          {/* Real-Time Waveform Graph */}
          <WaveformGraph currentMetric={metric} running={running} isStale={isStale || acquisitionTimedOut} />
        </div>

        {/* Right Column: Measurements & Quality Card */}
        <div className="metrics-column">
          <article className="card metrics-card">
            <div className="metrics-header">
              <p className="eyebrow">TELEMETRY STREAM</p>
              <h2>Live Measurements</h2>
            </div>

            {/* Breathing Rate Block */}
            <div className="metric-block rate-block">
              <div className="metric-label-row">
                <span className="metric-name">Breathing Rate</span>
                <span className="reference-tag">
                  {acquisitionTimedOut ? 'Waiting for Lock' : isStale ? 'Signal Paused' : 'Sensor Telemetry'}
                </span>
              </div>
              <div className="metric-value-row">
                <span className={`huge-number ${isStale || acquisitionTimedOut ? 'stale-value' : ''}`}>
                  {metric?.breathingRate == null ? '—' : metric.breathingRate.toFixed(1)}
                </span>
                <span className="metric-unit">
                  {metric?.breathingRate != null ? 'br/min' : ''}
                </span>
              </div>
            </div>

            {/* Confidence Block with Meter */}
            <div className="metric-block confidence-block">
              <div className="metric-label-row">
                <span className="metric-name">Signal Confidence</span>
                <span className="metric-percent">
                  {metric?.confidence != null ? `${metric.confidence.toFixed(0)}%` : '—'}
                </span>
              </div>
              <div className="confidence-meter-track">
                <div
                  className="confidence-meter-bar"
                  style={{
                    width: `${Math.min(100, Math.max(0, metric?.confidence ?? 0))}%`,
                    opacity: isStale || acquisitionTimedOut ? 0.4 : 1,
                  }}
                />
              </div>
            </div>

            {/* Confidence Status Badge */}
            <div className={`quality-badge ${confidenceState.color}`}>
              <span className="quality-icon">{confidenceState.icon}</span>
              <span>{confidenceState.label}</span>
            </div>

            {/* Trace Telemetry Breakdown */}
            <div className="trace-telemetry-box">
              <p className="trace-telemetry-title">Continuous Signal Offsets</p>
              <div className="trace-row">
                <div className="trace-chip chest">
                  <span className="chip-indicator" />
                  <span className="chip-label">Upper Thorax (Chest)</span>
                  <span className={`chip-value ${isStale || acquisitionTimedOut ? 'stale-value' : ''}`}>
                    {metric?.chestTrace != null ? metric.chestTrace.toFixed(3) : '—'}
                  </span>
                </div>
                <div className="trace-chip abdomen">
                  <span className="chip-indicator" />
                  <span className="chip-label">Lower Thorax (Abdomen)</span>
                  <span className={`chip-value ${isStale || acquisitionTimedOut ? 'stale-value' : ''}`}>
                    {metric?.abdomenTrace != null ? metric.abdomenTrace.toFixed(3) : '—'}
                  </span>
                </div>
              </div>
            </div>

            {/* Live Camera Engine Status */}
            <div className="engine-status-box">
              <div className="status-label-group">
                <Activity size={14} className="engine-status-icon" />
                <span className="engine-status-title">Engine Feedback:</span>
              </div>
              <p className="engine-status-text">{status}</p>
            </div>
          </article>
        </div>
      </section>

      {/* P1: Acquisition Timeout Recovery Banner */}
      {acquisitionTimedOut && (
        <section className="acquisition-timeout-banner" role="alert">
          <AlertCircle size={20} className="timeout-icon" />
          <div className="timeout-content">
            <strong>Initial Acquisition Taking Longer Than Expected</strong>
            <p>
              The camera is active, but the computer vision model hasn't isolated your respiratory movements yet.
              Please ensure your face and chest are well-lit, sit facing the webcam, and keep your upper torso in view.
            </p>
          </div>
          <button type="button" className="restart-btn" onClick={restartMeasurement}>
            <RotateCcw size={14} />
            <span>Restart Sensor</span>
          </button>
        </section>
      )}

      {/* Session Controls Card */}
      <section className="card setup-card">
        <div className="setup-header">
          <p className="eyebrow">DEVICE & SESSION CONTROL</p>
          <h2>Webcam configuration</h2>
        </div>

        <div className="setup-controls-row">
          <div className="camera-picker">
            <label className="field-label" htmlFor="camera">
              <Camera size={14} />
              <span>Video Input Device</span>
            </label>
            <div className="select-wrapper">
              <select
                id="camera"
                value={cameraId}
                onChange={(e) => setCameraId(e.target.value)}
                disabled={running}
              >
                {cameras.length === 0 && <option value="">No camera detected</option>}
                {cameras.map((camera) => (
                  <option key={camera.id} value={camera.id}>
                    {camera.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="refresh-btn"
                onClick={refreshCameras}
                disabled={running}
                title="Refresh camera list"
              >
                <RefreshCw size={14} />
              </button>
            </div>
          </div>

          <div className="consent-box">
            <label className="consent">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                disabled={running}
              />
              <div className="consent-text">
                <ShieldCheck size={16} className="consent-icon" />
                <span>
                  <strong>Privacy Guard:</strong> BreatheSync processes live video in volatile memory only.
                  No video or measurements are saved or recorded. Telemetry is disabled.
                </span>
              </div>
            </label>
          </div>
        </div>

        <div className="actions-bar">
          {!running ? (
            <button
              type="button"
              className="start-btn"
              onClick={start}
              disabled={!consent || !cameraId}
            >
              Start Real-Time Measurement
            </button>
          ) : (
            <button type="button" className="stop-btn" onClick={stop}>
              Stop & Release Camera
            </button>
          )}
          <span className="status-badge-inline">{status}</span>
        </div>

        {error && (
          <div className="error-banner" role="alert">
            <AlertCircle size={16} className="error-icon" />
            <div className="error-content">
              <strong>Measurement Notice</strong>
              <p>{error}</p>
            </div>
            <button
              type="button"
              className="error-dismiss-btn"
              onClick={() => setError('')}
            >
              Dismiss
            </button>
          </div>
        )}
      </section>

      {/* Footer */}
      <footer>
        <p>
          BreatheSync Technical Proof of Concept · Presage SmartSpectra v3.5 · Not for medical diagnosis or clinical treatment
        </p>
      </footer>
    </main>
  );
}

import React, { useEffect, useRef } from 'react';

interface WaveformPoint {
  timestampUs: number;
  chest: number | null;
  abdomen: number | null;
  stable: boolean;
}

interface WaveformGraphProps {
  currentMetric: {
    timestampUs: number;
    chestTrace: number | null;
    abdomenTrace: number | null;
    stable: boolean;
    state: string;
  } | null;
  running: boolean;
  isStale?: boolean;
}

export const WaveformGraph: React.FC<WaveformGraphProps> = ({ currentMetric, running, isStale }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const historyRef = useRef<WaveformPoint[]>([]);
  const animFrameRef = useRef<number | null>(null);

  // Append new data points into rolling window
  useEffect(() => {
    if (!running) {
      historyRef.current = [];
      return;
    }

    if (currentMetric && (currentMetric.chestTrace != null || currentMetric.abdomenTrace != null)) {
      const history = historyRef.current;
      history.push({
        timestampUs: currentMetric.timestampUs || Date.now() * 1000,
        chest: currentMetric.chestTrace,
        abdomen: currentMetric.abdomenTrace,
        stable: currentMetric.stable,
      });

      // Keep ~180 samples (roughly 6-8 seconds at ~25-30fps)
      if (history.length > 200) {
        history.shift();
      }
    }
  }, [currentMetric, running]);

  // Canvas drawing loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let active = true;

    const render = () => {
      if (!active) return;

      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      // Background - Deep monitor dark
      ctx.fillStyle = '#0B1319';
      ctx.fillRect(0, 0, width, height);

      // Draw subtle grid
      ctx.strokeStyle = '#16282E';
      ctx.lineWidth = 1;

      const gridStepX = 35;
      const gridStepY = 25;

      ctx.beginPath();
      for (let x = 0; x < width; x += gridStepX) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let y = 0; y < height; y += gridStepY) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();

      // Center baseline
      ctx.strokeStyle = '#1F3A3A';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
      ctx.setLineDash([]);

      const data = historyRef.current;

      if (!running || data.length < 2) {
        // Flat resting line
        ctx.strokeStyle = '#299B78';
        ctx.lineWidth = 2;
        ctx.beginPath();
        const midY = height / 2;
        ctx.moveTo(0, midY);
        ctx.lineTo(width, midY);
        ctx.stroke();

        ctx.fillStyle = '#6E8B83';
        ctx.font = '500 12px "DM Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(
          running ? 'ACQUIRING RESPIRATORY TRACES...' : 'STANDBY · START MEASUREMENT TO STREAM LIVE WAVEFORM',
          width / 2,
          midY - 18
        );
      } else {
        // Calculate dynamic range for auto-scaling with sane clamping
        let minVal = -0.5;
        let maxVal = 0.5;

        for (const pt of data) {
          if (pt.chest != null) {
            if (pt.chest < minVal) minVal = pt.chest;
            if (pt.chest > maxVal) maxVal = pt.chest;
          }
          if (pt.abdomen != null) {
            if (pt.abdomen < minVal) minVal = pt.abdomen;
            if (pt.abdomen > maxVal) maxVal = pt.abdomen;
          }
        }

        const range = Math.max(0.6, (maxVal - minVal) * 1.25);
        const midVal = (maxVal + minVal) / 2;

        const getY = (val: number | null) => {
          if (val == null) return height / 2;
          const normalized = (val - midVal) / (range / 2); // -1 to 1
          return (height / 2) - normalized * (height * 0.38);
        };

        const drawSeries = (
          selector: (p: WaveformPoint) => number | null,
          strokeColor: string,
          glowColor: string
        ) => {
          ctx.save();
          ctx.beginPath();
          let started = false;

          const step = width / Math.max(data.length - 1, 1);

          for (let i = 0; i < data.length; i++) {
            const val = selector(data[i]);
            if (val == null) {
              // Lift the pen on missing data so gaps are not falsely connected
              started = false;
              continue;
            }
            const x = i * step;
            const y = getY(val);

            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else {
              const prevVal = selector(data[i - 1]);
              if (prevVal == null) {
                ctx.moveTo(x, y);
              } else {
                const prevX = (i - 1) * step;
                const prevY = getY(prevVal);
                const cpX = (prevX + x) / 2;
                ctx.bezierCurveTo(cpX, prevY, cpX, y, x, y);
              }
            }
          }

          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = 2.5;
          ctx.shadowColor = glowColor;
          ctx.shadowBlur = 8;
          ctx.stroke();

          // Draw head dot on the latest sample
          const latestIdx = data.length - 1;
          const latestVal = selector(data[latestIdx]);
          if (latestVal != null) {
            const headX = latestIdx * step;
            const headY = getY(latestVal);
            ctx.fillStyle = '#FFFFFF';
            ctx.beginPath();
            ctx.arc(headX, headY, 3.5, 0, Math.PI * 2);
            ctx.fill();
          }

          ctx.restore();
        };

        // Draw Abdominal Trace (Cyan / Sky)
        drawSeries((p) => p.abdomen, '#06B6D4', 'rgba(6, 182, 212, 0.6)');

        // Draw Chest Trace (Emerald Green)
        drawSeries((p) => p.chest, '#10B981', 'rgba(16, 185, 129, 0.7)');

        // Stale warning overlay if frames stopped arriving
        if (isStale) {
          ctx.fillStyle = 'rgba(11, 19, 25, 0.65)';
          ctx.fillRect(0, 0, width, height);

          ctx.fillStyle = '#F59E0B';
          ctx.font = '600 12px "DM Sans", sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('SIGNAL PAUSED · AWAITING FRESH SAMPLES', width / 2, height / 2);
        }
      }

      ctx.restore();
      animFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      active = false;
      if (animFrameRef.current != null) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [running, isStale]);

  const latestChest = currentMetric?.chestTrace;
  const latestAbdomen = currentMetric?.abdomenTrace;

  return (
    <div className="waveform-container">
      <div className="waveform-header">
        <div className="waveform-title-group">
          <span className={`live-pulse-dot ${isStale ? 'stale' : ''}`} />
          <span className="waveform-title">
            {isStale ? 'OSCILLOSCOPE WAVEFORM (PAUSED)' : 'OSCILLOSCOPE WAVEFORM'}
          </span>
        </div>
        <div className="waveform-legend">
          <div className="legend-item chest">
            <span className="legend-color chest-color" />
            <span>Chest:</span>
            <b>{latestChest != null ? latestChest.toFixed(3) : '—'}</b>
          </div>
          <div className="legend-item abdomen">
            <span className="legend-color abdomen-color" />
            <span>Abdomen:</span>
            <b>{latestAbdomen != null ? latestAbdomen.toFixed(3) : '—'}</b>
          </div>
        </div>
      </div>
      <canvas ref={canvasRef} className="waveform-canvas" />
    </div>
  );
};

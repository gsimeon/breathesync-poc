/**
 * Browser Mock Provider for BreatheSync Web Deployments (e.g. Vercel)
 * Enables full UI interactivity, webcam access for framing/lighting check,
 * and realistic physiological telemetry streaming when running outside Electron.
 */

export function setupBrowserMockIfNeeded(): void {
  if (typeof window === 'undefined' || window.breatheSync) {
    return;
  }

  let metricInterval: any = null;
  let activeStream: MediaStream | null = null;
  const metricsListeners = new Set<(payload: any) => void>();
  const statusListeners = new Set<(payload: any) => void>();
  const errorListeners = new Set<(payload: any) => void>();
  const stateListeners = new Set<(payload: any) => void>();

  let isMeasuring = false;
  let simTime = 0;

  window.breatheSync = {
    getCameras: async () => {
      try {
        if (navigator.mediaDevices?.enumerateDevices) {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const videoDevices = devices.filter((d) => d.kind === 'videoinput');
          if (videoDevices.length > 0) {
            return videoDevices.map((d, i) => ({
              id: d.deviceId || `cam-${i}`,
              label: d.label || `Camera ${i + 1}`,
            }));
          }
        }
      } catch {
        // Fall back to default
      }
      return [
        { id: 'web-cam-default', label: 'Integrated Webcam (Browser Video Input)' },
      ];
    },

    getState: async () => {
      return {
        state: isMeasuring ? 'running' : 'idle',
        isCleanupPending: false,
        wasLastTeardownSuccessful: true,
        teardownError: null,
      };
    },

    start: async (_cameraId: string) => {
      isMeasuring = true;

      // Broadcast session state
      for (const l of stateListeners) {
        l({
          state: 'running',
          isCleanupPending: false,
          wasLastTeardownSuccessful: true,
          teardownError: null,
        });
      }

      for (const l of statusListeners) {
        l({ kind: 'session', detail: 'Requesting browser video input...' });
      }

      // Try accessing real webcam for physical camera activation indicator
      try {
        if (navigator.mediaDevices?.getUserMedia) {
          activeStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 } },
          });
        }
      } catch (err: any) {
        console.warn('Browser webcam preview access notice:', err?.message);
      }

      for (const l of statusListeners) {
        l({ kind: 'processing', detail: 'Tracking thoracic kinematics (Web Demonstration Mode)' });
      }

      // Start realistic respiratory telemetry simulation (15.4 breaths/min)
      simTime = 0;
      metricInterval = setInterval(() => {
        simTime += 0.1;
        const breathCycle = Math.sin(simTime * 1.6);
        const breathRate = 15.4 + Math.sin(simTime * 0.3) * 0.8;
        const confidence = 82 + Math.cos(simTime * 0.2) * 6;

        const payload = {
          breathingRate: Number(breathRate.toFixed(1)),
          confidence: Number(confidence.toFixed(0)),
          stable: true,
          chestTrace: Number((breathCycle * 0.45).toFixed(3)),
          abdomenTrace: Number((Math.sin(simTime * 1.6 - 0.4) * 0.35).toFixed(3)),
          state: 'valid',
          timestampUs: Date.now() * 1000,
          receivedAtMs: Date.now(),
        };

        for (const l of metricsListeners) {
          l(payload);
        }
      }, 100);

      return { started: true };
    },

    stop: async () => {
      isMeasuring = false;
      if (metricInterval) {
        clearInterval(metricInterval);
        metricInterval = null;
      }
      if (activeStream) {
        activeStream.getTracks().forEach((t) => t.stop());
        activeStream = null;
      }

      for (const l of statusListeners) {
        l({ kind: 'session', detail: 'Measurement stopped. Camera released.' });
      }

      for (const l of stateListeners) {
        l({
          state: 'idle',
          isCleanupPending: false,
          wasLastTeardownSuccessful: true,
          teardownError: null,
        });
      }

      return { stopped: true };
    },

    onMetrics: (listener: (payload: any) => void) => {
      metricsListeners.add(listener);
      return () => metricsListeners.delete(listener);
    },

    onStatus: (listener: (payload: any) => void) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },

    onError: (listener: (payload: any) => void) => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },

    onSessionState: (listener: (payload: any) => void) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  };
}


/**
 * Core physiological telemetry, session state machine, and signal freshness utilities.
 * Shared between Electron main, React renderer, and automated unit test suites.
 */

export type SessionState = 'idle' | 'starting' | 'running' | 'stopping' | 'shutting_down';

export type SessionAction = 'start' | 'start_success' | 'start_failed' | 'stop' | 'stop_success' | 'shutdown';

export interface CameraInput {
  id: string;
  name?: string | null;
  label?: string | null;
}

export interface NormalizedCamera {
  id: string;
  label: string;
}

export interface MetricSample {
  value?: number | null;
  confidence?: number | null;
  stable?: boolean | null;
}

export interface DecodedBreathingData {
  breathing?: {
    rate?: MetricSample[] | null;
    upperTrace?: MetricSample[] | null;
    lowerTrace?: MetricSample[] | null;
  } | null;
}

export interface NormalizedTelemetry {
  timestampUs: number;
  receivedAtMs: number;
  breathingRate: number | null;
  confidence: number | null;
  stable: boolean;
  chestTrace: number | null;
  abdomenTrace: number | null;
  state: 'acquiring' | 'valid' | 'low_confidence';
}

/**
 * Standard Presage SmartSpectra minimum confidence threshold for stable measurement (+/- 1 br/min).
 * See Presage Breathing Model Card: confidence >= 45 is marked stable.
 */
export const STABILITY_CONFIDENCE_THRESHOLD = 45;

/** Maximum age in milliseconds before a live measurement is considered stale/paused. */
export const SIGNAL_FRESHNESS_TIMEOUT_MS = 2500;

/** Timeout in milliseconds before flagging that initial acquisition took too long. */
export const ACQUISITION_TIMEOUT_MS = 15000;

/** Validation code to human-readable message mapping. */
export const VALIDATION_MESSAGES: Record<number, string> = {
  0: 'Optimal framing and lighting',
  1: 'No face detected — please look directly at the camera',
  2: 'Multiple faces detected — ensure only one person is in view',
  3: 'Face not centered — position yourself in the center',
  4: 'Adjust distance from camera',
  5: 'Lighting is too dark — please increase light on your face and chest',
  6: 'Too bright or glare — reduce harsh light or backlighting',
  7: 'Chest not visible — position camera to include your upper chest',
  10: 'Calibrating camera...',
  11: 'Camera frame rate too low',
  12: 'Excessive motion — please remain still',
  13: 'Face too close — step back slightly',
  14: 'Face too far — move closer to camera',
  15: 'Position face lower in frame',
  16: 'Position face higher in frame',
  17: 'Please face forward towards the camera',
};

/** Get the latest element of a typed array or null. */
export function getLatest<T>(items?: T[] | null): T | null {
  return items && items.length > 0 ? items[items.length - 1] : null;
}

/** Check if confidence score qualifies as stable. */
export function isConfidenceStable(confidence: number | null | undefined): boolean {
  return confidence != null && confidence >= STABILITY_CONFIDENCE_THRESHOLD;
}

/** Check if a sample timestamp is fresh. */
export function isSampleFresh(
  sampleTimestampMs: number | null | undefined,
  nowMs: number = Date.now(),
  maxAgeMs: number = SIGNAL_FRESHNESS_TIMEOUT_MS
): boolean {
  if (sampleTimestampMs == null) return false;
  return nowMs - sampleTimestampMs <= maxAgeMs;
}

/** Map camera objects to a consistent normalized shape. */
export function normalizeCamera(camera: CameraInput): NormalizedCamera {
  const label = (camera.name && camera.name.trim().length > 0)
    ? camera.name
    : (camera.label && camera.label.trim().length > 0)
    ? camera.label
    : 'Camera Device';

  return {
    id: camera.id,
    label,
  };
}

/** Map validation code and SDK hint to user-friendly status message. */
export function getValidationMessage(code: number, hint?: string | null): string {
  if (hint && typeof hint === 'string' && hint.trim().length > 0) {
    return hint.trim();
  }
  return VALIDATION_MESSAGES[code] || `Validation code: ${code}`;
}

/** Process and normalize decoded protobuf breathing metrics. */
export function normalizeBreathingMetrics(
  decoded: DecodedBreathingData,
  timestampUs: number,
  receivedAtMs: number = Date.now()
): NormalizedTelemetry {
  const rate = getLatest(decoded?.breathing?.rate);
  const chest = getLatest(decoded?.breathing?.upperTrace);
  const abdomen = getLatest(decoded?.breathing?.lowerTrace);

  const confidence = rate?.confidence ?? null;
  const stable = rate?.stable ?? isConfidenceStable(confidence);

  return {
    timestampUs,
    receivedAtMs,
    breathingRate: rate?.value ?? null,
    confidence,
    stable,
    chestTrace: chest?.value ?? null,
    abdomenTrace: abdomen?.value ?? null,
    state: !rate ? 'acquiring' : stable ? 'valid' : 'low_confidence',
  };
}

/** Pure state-machine transition validator. */
export function transitionSessionState(
  currentState: SessionState,
  action: SessionAction
): { nextState: SessionState; allowed: boolean; error?: string } {
  // If shutting down, no transition may revert it
  if (currentState === 'shutting_down') {
    return { nextState: 'shutting_down', allowed: false, error: 'Application is shutting down' };
  }

  switch (action) {
    case 'start':
      if (currentState === 'idle') {
        return { nextState: 'starting', allowed: true };
      }
      return { nextState: currentState, allowed: false, error: `Cannot start when state is '${currentState}'` };

    case 'start_success':
      if (currentState === 'starting') {
        return { nextState: 'running', allowed: true };
      }
      return { nextState: currentState, allowed: false, error: `Invalid transition to running from '${currentState}'` };

    case 'start_failed':
      if (currentState === 'starting') {
        return { nextState: 'idle', allowed: true };
      }
      return { nextState: currentState, allowed: false };

    case 'stop':
      if (currentState === 'running' || currentState === 'starting') {
        return { nextState: 'stopping', allowed: true };
      }
      if (currentState === 'idle') {
        return { nextState: 'idle', allowed: true };
      }
      return { nextState: currentState, allowed: false, error: `Cannot stop when state is '${currentState}'` };

    case 'stop_success':
      return { nextState: 'idle', allowed: true };

    case 'shutdown':
      return { nextState: 'shutting_down', allowed: true };

    default:
      return { nextState: currentState, allowed: false, error: 'Unknown session action' };
  }
}

/**
 * Core physiological telemetry, session state machine, and signal freshness utilities.
 * Shared between Electron main, React renderer, and automated unit test suites.
 */

export type SessionState = 'idle' | 'starting' | 'running' | 'stopping' | 'shutting_down' | 'degraded';

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

/** Standard Presage SmartSpectra minimum confidence threshold for stable measurement (+/- 1 br/min).
 * See Presage Breathing Model Card: confidence >= 45 is marked stable.
 */
export const STABILITY_CONFIDENCE_THRESHOLD = 45;

/** Maximum age in milliseconds before a live measurement is considered stale/paused. */
export const SIGNAL_FRESHNESS_TIMEOUT_MS = 2500;

/** Timeout in milliseconds before flagging that initial acquisition took too long. */
export const ACQUISITION_TIMEOUT_MS = 15000;

/** Structured error code when hardware release / camera driver teardown fails or cannot be confirmed. */
export const ERROR_CODE_TEARDOWN_FAILED = 'TEARDOWN_FAILED';

/**
 * Defensive check for hardware teardown failure.
 * Prioritizes structured error codes (`code === 'TEARDOWN_FAILED'`) and supports
 * nested teardownError objects and fallback message inspection.
 */
export function isTeardownError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object') {
    const errObj = error as Record<string, unknown>;
    if (errObj.code === ERROR_CODE_TEARDOWN_FAILED) {
      return true;
    }
    if (errObj.teardownError && typeof errObj.teardownError === 'object') {
      const nested = errObj.teardownError as Record<string, unknown>;
      if (nested.code === ERROR_CODE_TEARDOWN_FAILED) {
        return true;
      }
    }
    if (typeof errObj.message === 'string') {
      const msg = errObj.message;
      return (
        msg.includes(ERROR_CODE_TEARDOWN_FAILED) ||
        msg.includes('Camera release failed') ||
        msg.includes('could not be released cleanly') ||
        msg.includes('could not be cleanly released')
      );
    }
  }
  if (typeof error === 'string') {
    return (
      error.includes(ERROR_CODE_TEARDOWN_FAILED) ||
      error.includes('Camera release failed') ||
      error.includes('could not be released cleanly') ||
      error.includes('could not be cleanly released')
    );
  }
  return false;
}

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

  const rawRate = rate?.value;
  const isRateValid = typeof rawRate === 'number' && Number.isFinite(rawRate) && rawRate > 0;
  const breathingRate = isRateValid ? rawRate : null;

  const confidence = rate?.confidence ?? null;
  const stable = rate?.stable ?? isConfidenceStable(confidence);

  return {
    timestampUs,
    receivedAtMs,
    breathingRate,
    confidence,
    stable,
    chestTrace: chest?.value ?? null,
    abdomenTrace: abdomen?.value ?? null,
    state: !breathingRate ? 'acquiring' : stable ? 'valid' : 'low_confidence',
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

  // If degraded due to failed camera release, block starts until application restart
  if (currentState === 'degraded') {
    if (action === 'shutdown') {
      return { nextState: 'shutting_down', allowed: true };
    }
    return {
      nextState: 'degraded',
      allowed: false,
      error: 'Camera resource could not be released cleanly. Please restart the application.',
    };
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
      if (currentState === 'running' || currentState === 'starting' || currentState === 'stopping') {
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

/** Check if a normalized telemetry object or metric sample has a valid breathing rate (finite, positive number). */
export function hasBreathingRate(sample?: { breathingRate?: number | null } | null): boolean {
  const rate = sample?.breathingRate;
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
}

export interface ManagedSdkInstance {
  start: () => Promise<void> | void;
  stopAsync?: () => Promise<void> | void;
  destroy: () => Promise<void> | void;
}

/**
 * P0 Lifecycle Coordinator: Decouples startup and cleanup promises to eliminate
 * circular waits, handles concurrent stop/shutdown during startup, and ensures
 * deterministic teardown without deadlocks.
 */
export class SessionLifecycleCoordinator {
  private sessionState: SessionState = 'idle';
  private sdk: ManagedSdkInstance | null = null;
  private activeStartupPromise: Promise<void> | null = null;
  private activeCleanupPromise: Promise<void> | null = null;
  private activeShutdownPromise: Promise<void> | null = null;
  private isShutdownInitiatedState: boolean = false;
  private isShutdownCompleteState: boolean = false;
  private teardownFailed: boolean = false;
  private teardownError: Error | null = null;

  getState(): SessionState {
    return this.sessionState;
  }

  getSdk(): ManagedSdkInstance | null {
    return this.sdk;
  }

  isShutdown(): boolean {
    return this.isShutdownInitiatedState;
  }

  isShutdownInitiated(): boolean {
    return this.isShutdownInitiatedState;
  }

  isShutdownComplete(): boolean {
    return this.isShutdownCompleteState;
  }

  wasLastTeardownSuccessful(): boolean {
    return !this.teardownFailed;
  }

  getTeardownError(): Error | null {
    return this.teardownError;
  }

  async cleanup(): Promise<void> {
    if (this.activeCleanupPromise) {
      return this.activeCleanupPromise;
    }

    this.activeCleanupPromise = (async () => {
      // If startup is currently in flight, await it to settle first so we never destroy mid-start
      if (this.activeStartupPromise) {
        try {
          await this.activeStartupPromise;
        } catch {
          // Handled by the startup caller
        }
      }

      const current = this.sdk;
      this.sdk = null;

      let stopErr: unknown = null;
      let destroyErr: unknown = null;

      if (current) {
        if (typeof current.stopAsync === 'function') {
          try {
            await current.stopAsync();
          } catch (e) {
            stopErr = e;
            console.warn('SDK stop warning:', e);
          }
        }
        if (typeof current.destroy === 'function') {
          try {
            await current.destroy();
          } catch (e) {
            destroyErr = e;
            console.warn('SDK destroy warning:', e);
          }
        }

        // P2 Conservative Teardown: If either stopAsync or destroy rejects,
        // camera release cannot be confirmed. Mark as degraded and throw.
        if (destroyErr || stopErr) {
          const parts: string[] = [];
          if (stopErr) parts.push(`stopAsync: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`);
          if (destroyErr) parts.push(`destroy: ${destroyErr instanceof Error ? destroyErr.message : String(destroyErr)}`);
          this.teardownFailed = true;
          const teardownErr = new Error(`Camera release failed (${parts.join(', ')})`);
          (teardownErr as any).code = ERROR_CODE_TEARDOWN_FAILED;
          this.teardownError = teardownErr;
          throw this.teardownError;
        } else {
          // Confirmed clean release of active SDK instance
          this.teardownFailed = false;
          this.teardownError = null;
        }
      } else {
        // P1: No active SDK instance was present. If a previous teardown had failed,
        // we must PRESERVE the existing teardown failure state. Never clear it on empty cleanup.
        if (this.teardownFailed && this.teardownError) {
          throw this.teardownError;
        }
      }
    })().finally(() => {
      this.activeCleanupPromise = null;
      if (!this.isShutdownInitiatedState) {
        this.sessionState = this.teardownFailed ? 'degraded' : 'idle';
      }
    });

    return this.activeCleanupPromise;
  }

  async start(
    instanceFactory: () => Promise<ManagedSdkInstance> | ManagedSdkInstance,
    onStarted?: () => void
  ): Promise<void> {
    // Guard against re-entry while previous session cleanup is still finalizing
    if (this.activeCleanupPromise) {
      throw new Error('Previous session teardown in progress. Please wait before starting.');
    }

    if (this.sessionState === 'degraded' || this.teardownFailed) {
      const degradedErr = new Error('Camera resource could not be released cleanly. Please restart the application.');
      (degradedErr as any).code = ERROR_CODE_TEARDOWN_FAILED;
      throw degradedErr;
    }

    const transition = transitionSessionState(this.sessionState, 'start');
    if (!transition.allowed) {
      throw new Error(transition.error || `Cannot start measurement in state '${this.sessionState}'.`);
    }

    this.sessionState = 'starting';

    const startupTask = (async () => {
      let instance: ManagedSdkInstance | null = null;
      try {
        instance = await instanceFactory();
        this.sdk = instance;
        await instance.start();

        if (this.sessionState === 'starting') {
          this.sessionState = 'running';
          if (onStarted) onStarted();
        } else {
          // Stop or shutdown was requested while startup was in-flight.
          // The external stop/shutdown caller is awaiting activeStartupPromise and will
          // execute cleanup. We must NEVER await cleanup here to avoid circular waits.
        }
      } catch (error) {
        if (this.sessionState === 'starting') {
          // P1: Track startup-failure teardown as activeCleanupPromise and keep state non-idle
          // until both teardown operations settle, completely preventing a concurrent second SDK start.
          if (instance) {
            this.sdk = null;
            const failedInstance = instance;
            this.activeCleanupPromise = (async () => {
              let stopErr: unknown = null;
              let destroyErr: unknown = null;
              if (typeof failedInstance.stopAsync === 'function') {
                try {
                  await failedInstance.stopAsync();
                } catch (e) {
                  stopErr = e;
                  console.warn('SDK stop error on startup failure:', e);
                }
              }
              if (typeof failedInstance.destroy === 'function') {
                try {
                  await failedInstance.destroy();
                } catch (e) {
                  destroyErr = e;
                  console.warn('SDK destroy error on startup failure:', e);
                }
              }

              // P2 Conservative Teardown: If either fails, mark as degraded
              if (destroyErr || stopErr) {
                const parts: string[] = [];
                if (stopErr) parts.push(`stopAsync: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`);
                if (destroyErr) parts.push(`destroy: ${destroyErr instanceof Error ? destroyErr.message : String(destroyErr)}`);
                this.teardownFailed = true;
                const teardownErr = new Error(`Camera release failed on startup (${parts.join(', ')})`);
                (teardownErr as any).code = ERROR_CODE_TEARDOWN_FAILED;
                this.teardownError = teardownErr;
              } else {
                this.teardownFailed = false;
                this.teardownError = null;
              }
            })().finally(() => {
              this.activeCleanupPromise = null;
              if (this.sessionState === 'starting') {
                this.sessionState = this.teardownFailed ? 'degraded' : 'idle';
              }
            });
            await this.activeCleanupPromise;
          } else {
            this.sessionState = 'idle';
          }
        }
        // Preserve startup error and attach teardownError if teardown failed
        if (this.teardownFailed && this.teardownError && error && typeof error === 'object') {
          (error as any).teardownError = this.teardownError;
        }
        throw error;
      } finally {
        this.activeStartupPromise = null;
      }
    })();

    this.activeStartupPromise = startupTask;
    await startupTask;
  }

  async stop(): Promise<void> {
    if (this.sessionState === 'idle') {
      return;
    }

    if (this.sessionState === 'stopping') {
      return this.cleanup();
    }

    const transition = transitionSessionState(this.sessionState, 'stop');
    if (!transition.allowed) {
      throw new Error(transition.error || `Cannot stop measurement in state '${this.sessionState}'.`);
    }

    this.sessionState = 'stopping';

    try {
      await this.cleanup();
    } finally {
      if (!this.isShutdownInitiatedState) {
        this.sessionState = this.teardownFailed ? 'degraded' : 'idle';
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.activeShutdownPromise) {
      return this.activeShutdownPromise;
    }

    this.isShutdownInitiatedState = true;
    this.sessionState = 'shutting_down';

    this.activeShutdownPromise = (async () => {
      try {
        await this.cleanup();
      } finally {
        this.isShutdownCompleteState = true;
      }
    })();

    return this.activeShutdownPromise;
  }
}



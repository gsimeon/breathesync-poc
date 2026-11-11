import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STABILITY_CONFIDENCE_THRESHOLD,
  SIGNAL_FRESHNESS_TIMEOUT_MS,
  ACQUISITION_TIMEOUT_MS,
  isConfidenceStable,
  isSampleFresh,
  normalizeCamera,
  getValidationMessage,
  normalizeBreathingMetrics,
  transitionSessionState,
} from '../src/common/telemetry-utils.ts';

test('isConfidenceStable matches Presage model card standards', () => {
  assert.equal(STABILITY_CONFIDENCE_THRESHOLD, 45);
  assert.equal(isConfidenceStable(45), true);
  assert.equal(isConfidenceStable(80), true);
  assert.equal(isConfidenceStable(44.9), false);
  assert.equal(isConfidenceStable(0), false);
  assert.equal(isConfidenceStable(null), false);
  assert.equal(isConfidenceStable(undefined), false);
});

test('isSampleFresh identifies fresh vs stale physiological samples', () => {
  const now = 100000;
  assert.equal(SIGNAL_FRESHNESS_TIMEOUT_MS, 2500);

  // Fresh samples within 2500ms
  assert.equal(isSampleFresh(now - 100, now), true);
  assert.equal(isSampleFresh(now - 2450, now), true);

  // Stale samples beyond threshold
  assert.equal(isSampleFresh(now - 2501, now), false);
  assert.equal(isSampleFresh(now - 5000, now), false);
  assert.equal(isSampleFresh(null, now), false);
  assert.equal(isSampleFresh(undefined, now), false);
});

test('normalizeCamera maps Windows hardware camera devices correctly', () => {
  // DirectShow / MediaFoundation Windows name preference
  assert.deepEqual(
    normalizeCamera({ id: 'usb#vid_1bcf&pid_2b93', name: 'Integrated Webcam', label: 'Cam 1' }),
    { id: 'usb#vid_1bcf&pid_2b93', label: 'Integrated Webcam' }
  );

  // Fallback to label
  assert.deepEqual(
    normalizeCamera({ id: 'cam-2', label: 'USB Video Device' }),
    { id: 'cam-2', label: 'USB Video Device' }
  );

  // Graceful fallback when both are missing
  assert.deepEqual(
    normalizeCamera({ id: 'cam-unknown' }),
    { id: 'cam-unknown', label: 'Camera Device' }
  );
});

test('getValidationMessage maps SDK codes and hints', () => {
  assert.equal(getValidationMessage(0), 'Optimal framing and lighting');
  assert.equal(getValidationMessage(5), 'Lighting is too dark — please increase light on your face and chest');
  assert.equal(getValidationMessage(7), 'Chest not visible — position camera to include your upper chest');

  // Custom hint from SDK overrides default template
  assert.equal(getValidationMessage(5, 'Custom vendor lighting hint'), 'Custom vendor lighting hint');

  // Unknown codes fall back gracefully
  assert.equal(getValidationMessage(999), 'Validation code: 999');
});

test('normalizeBreathingMetrics decodes protobuf structure cleanly', () => {
  const mockPayload = {
    breathing: {
      rate: [
        { value: 16.2, confidence: 75, stable: true },
        { value: 16.5, confidence: 82, stable: true },
      ],
      upperTrace: [
        { value: -0.842 },
        { value: -0.850 },
      ],
      lowerTrace: [
        { value: -0.910 },
        { value: -0.925 },
      ],
    },
  };

  const normalized = normalizeBreathingMetrics(mockPayload, 123456789, 5000);
  assert.equal(normalized.timestampUs, 123456789);
  assert.equal(normalized.receivedAtMs, 5000);
  assert.equal(normalized.breathingRate, 16.5);
  assert.equal(normalized.confidence, 82);
  assert.equal(normalized.stable, true);
  assert.equal(normalized.chestTrace, -0.850);
  assert.equal(normalized.abdomenTrace, -0.925);
  assert.equal(normalized.state, 'valid');
});

test('normalizeBreathingMetrics handles empty and uncalibrated samples', () => {
  const emptyPayload = { breathing: null };
  const normalized = normalizeBreathingMetrics(emptyPayload, 100, 200);

  assert.equal(normalized.breathingRate, null);
  assert.equal(normalized.confidence, null);
  assert.equal(normalized.stable, false);
  assert.equal(normalized.chestTrace, null);
  assert.equal(normalized.abdomenTrace, null);
  assert.equal(normalized.state, 'acquiring');
});

test('transitionSessionState validates complete session state machine', () => {
  // Normal start flow
  const step1 = transitionSessionState('idle', 'start');
  assert.equal(step1.allowed, true);
  assert.equal(step1.nextState, 'starting');

  const step2 = transitionSessionState('starting', 'start_success');
  assert.equal(step2.allowed, true);
  assert.equal(step2.nextState, 'running');

  // Normal stop flow
  const step3 = transitionSessionState('running', 'stop');
  assert.equal(step3.allowed, true);
  assert.equal(step3.nextState, 'stopping');

  const step4 = transitionSessionState('stopping', 'stop_success');
  assert.equal(step4.allowed, true);
  assert.equal(step4.nextState, 'idle');

  // Repeated stop when already idle is safe and idempotent
  const repeatedStop = transitionSessionState('idle', 'stop');
  assert.equal(repeatedStop.allowed, true);
  assert.equal(repeatedStop.nextState, 'idle');

  // Startup failure flow
  const failedStart = transitionSessionState('starting', 'start_failed');
  assert.equal(failedStart.allowed, true);
  assert.equal(failedStart.nextState, 'idle');

  // Concurrency protections: reject start while already starting or running
  const concurrentStart1 = transitionSessionState('starting', 'start');
  assert.equal(concurrentStart1.allowed, false);

  const concurrentStart2 = transitionSessionState('running', 'start');
  assert.equal(concurrentStart2.allowed, false);

  // Shutdown locks out any new sessions
  const shutdownStep = transitionSessionState('running', 'shutdown');
  assert.equal(shutdownStep.allowed, true);
  assert.equal(shutdownStep.nextState, 'shutting_down');

  const startAfterShutdown = transitionSessionState('shutting_down', 'start');
  assert.equal(startAfterShutdown.allowed, false);
  assert.equal(startAfterShutdown.nextState, 'shutting_down');
});

test('ACQUISITION_TIMEOUT_MS is configured to 15 seconds', () => {
  assert.equal(ACQUISITION_TIMEOUT_MS, 15000);
});

test('trace-only events keep state as acquiring and do not produce a false rate', () => {
  const traceOnlyPayload = {
    breathing: {
      rate: null,
      upperTrace: [{ value: -0.849 }],
      lowerTrace: [{ value: -0.924 }],
    },
  };

  const normalized = normalizeBreathingMetrics(traceOnlyPayload, 99999, 1000);
  assert.equal(normalized.breathingRate, null);
  assert.equal(normalized.chestTrace, -0.849);
  assert.equal(normalized.abdomenTrace, -0.924);
  assert.equal(normalized.state, 'acquiring');
});

test('startup failure allows clean recovery on subsequent start attempt', () => {
  // Simulate starting
  const startAttempt1 = transitionSessionState('idle', 'start');
  assert.equal(startAttempt1.nextState, 'starting');

  // Simulate SDK startup error
  const failure = transitionSessionState('starting', 'start_failed');
  assert.equal(failure.allowed, true);
  assert.equal(failure.nextState, 'idle');

  // Verify that a subsequent start is immediately allowed
  const startAttempt2 = transitionSessionState(failure.nextState, 'start');
  assert.equal(startAttempt2.allowed, true);
  assert.equal(startAttempt2.nextState, 'starting');
});

test('concurrent shutdown during startup locks state to shutting_down and rejects start_success', () => {
  // Session starts
  const start = transitionSessionState('idle', 'start');
  assert.equal(start.nextState, 'starting');

  // User closes app while startup is in flight
  const shutdown = transitionSessionState('starting', 'shutdown');
  assert.equal(shutdown.allowed, true);
  assert.equal(shutdown.nextState, 'shutting_down');

  // Delayed startup completion cannot overwrite shutting_down
  const delayedSuccess = transitionSessionState(shutdown.nextState, 'start_success');
  assert.equal(delayedSuccess.allowed, false);
  assert.equal(delayedSuccess.nextState, 'shutting_down');
});


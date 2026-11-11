import test from 'node:test';
import assert from 'node:assert/strict';

test('Signal stability inherits from confidence score threshold', () => {
  // Presage documented standard: confidence >= 45 is stable (+/- 1 br/min)
  const isStable = (confidence) => confidence != null && confidence >= 45;

  assert.equal(isStable(50), true);
  assert.equal(isStable(45), true);
  assert.equal(isStable(44), false);
  assert.equal(isStable(0), false);
  assert.equal(isStable(null), false);
});

test('Freshness timeout detects stale samples', () => {
  const isSampleFresh = (sampleTimestamp, now, maxAgeMs = 2500) => {
    if (!sampleTimestamp) return false;
    return now - sampleTimestamp <= maxAgeMs;
  };

  const now = 1700000000000;
  assert.equal(isSampleFresh(now - 1000, now), true);
  assert.equal(isSampleFresh(now - 2400, now), true);
  assert.equal(isSampleFresh(now - 2600, now), false);
  assert.equal(isSampleFresh(null, now), false);
});

test('Camera field normalization falls back gracefully', () => {
  const normalizeCamera = (camera) => ({
    id: camera.id,
    label: camera.name || camera.label || 'Default Camera',
  });

  assert.deepEqual(
    normalizeCamera({ id: 'cam-1', name: 'Integrated Webcam' }),
    { id: 'cam-1', label: 'Integrated Webcam' }
  );

  assert.deepEqual(
    normalizeCamera({ id: 'cam-2', label: 'USB Video Device' }),
    { id: 'cam-2', label: 'USB Video Device' }
  );

  assert.deepEqual(
    normalizeCamera({ id: 'cam-3' }),
    { id: 'cam-3', label: 'Default Camera' }
  );
});

test('Validation status messages map properly', () => {
  const VALIDATION_MESSAGES = {
    0: 'Optimal framing and lighting',
    1: 'No face detected — please look directly at the camera',
    5: 'Lighting is too dark — please increase light on your face and chest',
    7: 'Chest not visible — position camera to include your upper chest',
  };

  const getMessage = (code, hint) =>
    (hint && hint.trim().length > 0) ? hint : (VALIDATION_MESSAGES[code] || `Validation code: ${code}`);

  assert.equal(getMessage(5, ''), 'Lighting is too dark — please increase light on your face and chest');
  assert.equal(getMessage(0, ''), 'Optimal framing and lighting');
  assert.equal(getMessage(1, 'Custom hint from SDK'), 'Custom hint from SDK');
  assert.equal(getMessage(99, ''), 'Validation code: 99');
});

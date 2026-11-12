import test from 'node:test';
import assert from 'node:assert/strict';
import { SensorRestartCoordinator } from '../src/common/telemetry-utils.ts';

// Helper to simulate timers with precision
function createMockTimers() {
  let timerCounter = 1;
  const activeTimers = new Map();

  return {
    setTimeoutFn: (cb, ms) => {
      const id = timerCounter++;
      activeTimers.set(id, { cb, ms });
      return id;
    },
    clearTimeoutFn: (id) => {
      activeTimers.delete(id);
    },
    triggerAll: () => {
      const timers = Array.from(activeTimers.entries());
      activeTimers.clear();
      for (const [, { cb }] of timers) {
        cb();
      }
    },
    getActiveTimerCount: () => activeTimers.size,
  };
}

test('Renderer restart regression: successful stop schedules restart after delay', async () => {
  let stopCount = 0;
  let startCount = 0;
  const timers = createMockTimers();

  const coordinator = new SensorRestartCoordinator({
    stop: async () => {
      stopCount++;
      return true;
    },
    start: async () => {
      startCount++;
      return true;
    },
    getFatalError: () => null,
    delayMs: 400,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  const scheduled = await coordinator.restart();
  assert.equal(scheduled, true, 'restart() must return true when stop succeeds');
  assert.equal(stopCount, 1, 'stop() must be invoked once');
  assert.equal(startCount, 0, 'start() must not be called synchronously');
  assert.equal(coordinator.isRestartPending(), true, 'restart must be pending in timer queue');
  assert.equal(timers.getActiveTimerCount(), 1);

  // Trigger the 400ms delay callback
  timers.triggerAll();

  assert.equal(startCount, 1, 'start() must be invoked after the delay expires');
  assert.equal(coordinator.isRestartPending(), false);
});

test('Renderer restart regression: failed stop does not schedule restart', async () => {
  let stopCount = 0;
  let startCount = 0;
  const timers = createMockTimers();

  const coordinator = new SensorRestartCoordinator({
    stop: async () => {
      stopCount++;
      // Backend failed to stop camera
      return false;
    },
    start: async () => {
      startCount++;
      return true;
    },
    getFatalError: () => null,
    delayMs: 400,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  const scheduled = await coordinator.restart();
  assert.equal(scheduled, false, 'restart() must return false when stop fails');
  assert.equal(stopCount, 1, 'stop() was attempted');
  assert.equal(startCount, 0, 'start() must never be called on failed stop');
  assert.equal(coordinator.isRestartPending(), false, 'no timer should be active');
  assert.equal(timers.getActiveTimerCount(), 0);

  // Firing any queued timers would do nothing
  timers.triggerAll();
  assert.equal(startCount, 0);
});

test('Renderer restart regression: fatal teardown error prevents restart entirely', async () => {
  let stopCount = 0;
  let startCount = 0;
  const timers = createMockTimers();
  let fatalError = 'Camera release could not be confirmed. Close and restart BreatheSync.';

  const coordinator = new SensorRestartCoordinator({
    stop: async () => {
      stopCount++;
      return true;
    },
    start: async () => {
      startCount++;
      return true;
    },
    getFatalError: () => fatalError,
    delayMs: 400,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  const scheduled = await coordinator.restart();
  assert.equal(scheduled, false, 'restart() must return false when fatal error is active');
  assert.equal(stopCount, 0, 'stop() must not be invoked when fatal error is active');
  assert.equal(startCount, 0, 'start() must not be invoked when fatal error is active');
  assert.equal(coordinator.isRestartPending(), false);
  assert.equal(timers.getActiveTimerCount(), 0);
});

test('Renderer restart regression: fatal error arriving during the 400 ms delay cancels pending restart', async () => {
  let stopCount = 0;
  let startCount = 0;
  const timers = createMockTimers();
  let fatalError = null;

  const coordinator = new SensorRestartCoordinator({
    stop: async () => {
      stopCount++;
      return true;
    },
    start: async () => {
      startCount++;
      return true;
    },
    getFatalError: () => fatalError,
    delayMs: 400,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  // 1. Initial stop succeeds and schedules restart
  const scheduled = await coordinator.restart();
  assert.equal(scheduled, true);
  assert.equal(stopCount, 1);
  assert.equal(coordinator.isRestartPending(), true);
  assert.equal(timers.getActiveTimerCount(), 1);

  // 2. While the 400ms delay is counting down, unconfirmed hardware error arrives
  fatalError = 'Camera release could not be confirmed. Close and restart BreatheSync.';
  coordinator.cancelPendingRestart();

  // 3. Confirm pending timer was cancelled
  assert.equal(coordinator.isRestartPending(), false);
  assert.equal(timers.getActiveTimerCount(), 0);

  // 4. Even if a delayed callback somehow executed, guard prevents calling start
  timers.triggerAll();
  assert.equal(startCount, 0, 'start() must never be invoked if fatal error arrived');
});


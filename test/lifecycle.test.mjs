import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionLifecycleCoordinator,
  hasBreathingRate,
} from '../src/common/telemetry-utils.ts';

// Helper to create a deferred promise that can be resolved/rejected on command
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('SessionLifecycleCoordinator: standard start and stop cycle', async () => {
  const coordinator = new SessionLifecycleCoordinator();
  assert.equal(coordinator.getState(), 'idle');

  let stopped = false;
  let destroyed = false;
  let started = false;

  const mockSdk = {
    start: async () => { started = true; },
    stopAsync: async () => { stopped = true; },
    destroy: async () => { destroyed = true; },
  };

  let onStartedFired = false;
  await coordinator.start(() => mockSdk, () => { onStartedFired = true; });

  assert.equal(started, true);
  assert.equal(onStartedFired, true);
  assert.equal(coordinator.getState(), 'running');
  assert.equal(coordinator.getSdk(), mockSdk);

  await coordinator.stop();
  assert.equal(stopped, true);
  assert.equal(destroyed, true);
  assert.equal(coordinator.getState(), 'idle');
  assert.equal(coordinator.getSdk(), null);
});

test('SessionLifecycleCoordinator: startup failure cleans up directly and recovers to idle without deadlock', async () => {
  const coordinator = new SessionLifecycleCoordinator();
  let destroyed = false;

  const failingSdk = {
    start: async () => {
      throw new Error('Hardware camera initialization failed');
    },
    destroy: async () => {
      destroyed = true;
    },
  };

  await assert.rejects(
    async () => {
      await coordinator.start(() => failingSdk);
    },
    { message: 'Hardware camera initialization failed' }
  );

  assert.equal(destroyed, true);
  assert.equal(coordinator.getState(), 'idle');
  assert.equal(coordinator.getSdk(), null);

  // Subsequent start can proceed normally
  const recoveredSdk = {
    start: async () => {},
    destroy: async () => {},
  };
  await coordinator.start(() => recoveredSdk);
  assert.equal(coordinator.getState(), 'running');
  await coordinator.stop();
});

test('SessionLifecycleCoordinator: stop called during in-flight startup does not deadlock', async () => {
  const coordinator = new SessionLifecycleCoordinator();
  const startupDeferred = createDeferred();
  let stopped = false;
  let destroyed = false;

  const mockSdk = {
    start: () => startupDeferred.promise,
    stopAsync: async () => { stopped = true; },
    destroy: async () => { destroyed = true; },
  };

  // Launch startup in background
  const startPromise = coordinator.start(() => mockSdk);
  assert.equal(coordinator.getState(), 'starting');

  // Concurrently request stop while start() is awaiting
  const stopPromise = coordinator.stop();
  assert.equal(coordinator.getState(), 'stopping');

  // Complete startup now
  startupDeferred.resolve();

  // Both promises must settle cleanly without circular wait
  await Promise.all([startPromise, stopPromise]);

  assert.equal(stopped, true);
  assert.equal(destroyed, true);
  assert.equal(coordinator.getState(), 'idle');
  assert.equal(coordinator.getSdk(), null);
});

test('SessionLifecycleCoordinator: shutdown requested during in-flight startup settles cleanly', async () => {
  const coordinator = new SessionLifecycleCoordinator();
  const startupDeferred = createDeferred();
  let stopped = false;
  let destroyed = false;

  const mockSdk = {
    start: () => startupDeferred.promise,
    stopAsync: async () => { stopped = true; },
    destroy: async () => { destroyed = true; },
  };

  const startPromise = coordinator.start(() => mockSdk);
  assert.equal(coordinator.getState(), 'starting');

  // Trigger app shutdown while startup is pending
  const shutdownPromise = coordinator.shutdown();
  assert.equal(coordinator.getState(), 'shutting_down');
  assert.equal(coordinator.isShutdown(), true);

  // Settle startup
  startupDeferred.resolve();

  await Promise.all([startPromise, shutdownPromise]);

  assert.equal(stopped, true);
  assert.equal(destroyed, true);
  assert.equal(coordinator.getState(), 'shutting_down');
  assert.equal(coordinator.getSdk(), null);
});

test('SessionLifecycleCoordinator: startup rejection during pending stop is handled cleanly', async () => {
  const coordinator = new SessionLifecycleCoordinator();
  const startupDeferred = createDeferred();
  let destroyed = false;

  const mockSdk = {
    start: () => startupDeferred.promise,
    stopAsync: async () => {},
    destroy: async () => { destroyed = true; },
  };

  const startPromise = coordinator.start(() => mockSdk);
  const stopPromise = coordinator.stop();

  // Reject the pending startup operation
  startupDeferred.reject(new Error('USB device disconnected mid-start'));

  // Start must reject with the original error
  await assert.rejects(startPromise, { message: 'USB device disconnected mid-start' });

  // Stop must resolve cleanly and complete teardown
  await stopPromise;

  assert.equal(destroyed, true);
  assert.equal(coordinator.getState(), 'idle');
});

test('SessionLifecycleCoordinator: concurrent stop calls share the same cleanup promise', async () => {
  const coordinator = new SessionLifecycleCoordinator();
  let stopCount = 0;
  let destroyCount = 0;

  const mockSdk = {
    start: async () => {},
    stopAsync: async () => { stopCount++; },
    destroy: async () => { destroyCount++; },
  };

  await coordinator.start(() => mockSdk);

  // Concurrent stop invocations
  await Promise.all([coordinator.stop(), coordinator.stop(), coordinator.stop()]);

  assert.equal(stopCount, 1);
  assert.equal(destroyCount, 1);
  assert.equal(coordinator.getState(), 'idle');
});

test('hasBreathingRate correctly differentiates valid rates from trace-only samples', () => {
  assert.equal(hasBreathingRate({ breathingRate: 15.4 }), true);
  assert.equal(hasBreathingRate({ breathingRate: 0 }), true);
  assert.equal(hasBreathingRate({ breathingRate: null }), false);
  assert.equal(hasBreathingRate({ breathingRate: undefined }), false);
  assert.equal(hasBreathingRate(null), false);
  assert.equal(hasBreathingRate(undefined), false);
});

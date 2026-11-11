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

test('SessionLifecycleCoordinator: startup failure attempts both stopAsync and destroy independently', async () => {
  const coordinator = new SessionLifecycleCoordinator();
  let stopped = false;
  let destroyed = false;

  const failingSdk = {
    start: async () => {
      throw new Error('Hardware camera initialization failed');
    },
    stopAsync: async () => {
      stopped = true;
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

  assert.equal(stopped, true);
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

test('SessionLifecycleCoordinator: startup failure where stopAsync itself rejects still runs destroy', async () => {
  const coordinator = new SessionLifecycleCoordinator();
  let destroyed = false;

  const failingSdk = {
    start: async () => {
      throw new Error('Camera device offline');
    },
    stopAsync: async () => {
      throw new Error('Failed to stop camera stream');
    },
    destroy: async () => {
      destroyed = true;
    },
  };

  await assert.rejects(
    async () => {
      await coordinator.start(() => failingSdk);
    },
    { message: 'Camera device offline' }
  );

  assert.equal(destroyed, true);
  assert.equal(coordinator.getState(), 'idle');
  assert.equal(coordinator.getSdk(), null);
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
  assert.equal(coordinator.isShutdownInitiated(), true);
  assert.equal(coordinator.isShutdownComplete(), false);

  // Settle startup
  startupDeferred.resolve();

  await Promise.all([startPromise, shutdownPromise]);

  assert.equal(stopped, true);
  assert.equal(destroyed, true);
  assert.equal(coordinator.getState(), 'shutting_down');
  assert.equal(coordinator.isShutdownComplete(), true);
  assert.equal(coordinator.getSdk(), null);
});

test('SessionLifecycleCoordinator: startup failure while shutdown is already pending', async () => {
  const coordinator = new SessionLifecycleCoordinator();
  const startupDeferred = createDeferred();
  let destroyed = false;

  const mockSdk = {
    start: () => startupDeferred.promise,
    stopAsync: async () => {},
    destroy: async () => { destroyed = true; },
  };

  const startPromise = coordinator.start(() => mockSdk);
  const shutdownPromise = coordinator.shutdown();

  assert.equal(coordinator.getState(), 'shutting_down');
  assert.equal(coordinator.isShutdownInitiated(), true);

  // Startup rejects while shutdown is awaiting it
  startupDeferred.reject(new Error('Device disconnected during startup'));

  await assert.rejects(startPromise, { message: 'Device disconnected during startup' });
  await shutdownPromise;

  assert.equal(destroyed, true);
  assert.equal(coordinator.getState(), 'shutting_down');
  assert.equal(coordinator.isShutdownComplete(), true);
});

test('SessionLifecycleCoordinator: simultaneous stop and shutdown settle cleanly', async () => {
  const coordinator = new SessionLifecycleCoordinator();
  let stopCount = 0;
  let destroyCount = 0;

  const mockSdk = {
    start: async () => {},
    stopAsync: async () => { stopCount++; },
    destroy: async () => { destroyCount++; },
  };

  await coordinator.start(() => mockSdk);
  assert.equal(coordinator.getState(), 'running');

  // Trigger stop and shutdown concurrently
  const [stopRes, shutdownRes] = await Promise.allSettled([
    coordinator.stop(),
    coordinator.shutdown(),
  ]);

  assert.equal(stopRes.status, 'fulfilled');
  assert.equal(shutdownRes.status, 'fulfilled');
  assert.equal(stopCount, 1);
  assert.equal(destroyCount, 1);
  assert.equal(coordinator.getState(), 'shutting_down');
  assert.equal(coordinator.isShutdownComplete(), true);
});

test('SessionLifecycleCoordinator: repeated shutdown calls while teardown is pending share single promise', async () => {
  const coordinator = new SessionLifecycleCoordinator();
  const cleanupDeferred = createDeferred();
  let destroyCount = 0;

  const mockSdk = {
    start: async () => {},
    stopAsync: async () => {},
    destroy: () => {
      destroyCount++;
      return cleanupDeferred.promise;
    },
  };

  await coordinator.start(() => mockSdk);

  // Trigger shutdown multiple times while teardown is in flight
  const p1 = coordinator.shutdown();
  assert.equal(coordinator.isShutdownInitiated(), true);
  assert.equal(coordinator.isShutdownComplete(), false);

  const p2 = coordinator.shutdown();
  const p3 = coordinator.shutdown();

  // Release teardown
  cleanupDeferred.resolve();
  await Promise.all([p1, p2, p3]);

  assert.equal(destroyCount, 1);
  assert.equal(coordinator.isShutdownComplete(), true);
});

test('SessionLifecycleCoordinator: startup failure teardown blocks second SDK start until settled', async () => {
  const coordinator = new SessionLifecycleCoordinator();
  const teardownDeferred = createDeferred();
  let instancesCreated = 0;

  const failingSdk = {
    start: async () => {
      instancesCreated++;
      throw new Error('Hardware camera failed to initialize');
    },
    stopAsync: () => teardownDeferred.promise,
    destroy: async () => {},
  };

  // Launch failed startup in background
  const startPromise = coordinator.start(() => failingSdk);

  // Allow start() to reject and enter startup-failure teardown
  await new Promise((r) => setTimeout(r, 10));

  // A second start attempt while teardown is pending must be rejected
  await assert.rejects(
    async () => {
      await coordinator.start(() => {
        instancesCreated++;
        return failingSdk;
      });
    },
    { message: /Previous session teardown in progress|Cannot start measurement in state/ }
  );

  // Verify second instance was NOT created
  assert.equal(instancesCreated, 1);

  // Complete cleanup now
  teardownDeferred.resolve();

  // First start must reject with the initial error
  await assert.rejects(startPromise, { message: 'Hardware camera failed to initialize' });

  // State returns to idle once teardown is complete
  assert.equal(coordinator.getState(), 'idle');

  // Now a subsequent start is permitted
  const goodSdk = {
    start: async () => { instancesCreated++; },
    destroy: async () => {},
  };
  await coordinator.start(() => goodSdk);
  assert.equal(instancesCreated, 2);
  assert.equal(coordinator.getState(), 'running');
  await coordinator.stop();
});

test('SessionLifecycleCoordinator: normal session stop teardown blocks second SDK start until settled', async () => {
  const coordinator = new SessionLifecycleCoordinator();
  const cleanupDeferred = createDeferred();
  let instancesCreated = 0;

  const mockSdk = {
    start: async () => {},
    stopAsync: async () => {},
    destroy: () => cleanupDeferred.promise,
  };

  await coordinator.start(() => {
    instancesCreated++;
    return mockSdk;
  });

  // Begin stop (cleanup will pause on deferred promise)
  const stopPromise = coordinator.stop();

  // Attempting to start a second instance while cleanup is in flight must be rejected
  await assert.rejects(
    async () => {
      await coordinator.start(() => {
        instancesCreated++;
        return mockSdk;
      });
    },
    { message: /Previous session teardown in progress/ }
  );

  assert.equal(instancesCreated, 1);

  // Complete cleanup
  cleanupDeferred.resolve();
  await stopPromise;

  assert.equal(coordinator.getState(), 'idle');
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

test('hasBreathingRate validates finite positive rates and defensively rejects invalid values', () => {
  // Valid positive finite rates
  assert.equal(hasBreathingRate({ breathingRate: 15.4 }), true);
  assert.equal(hasBreathingRate({ breathingRate: 1.0 }), true);
  assert.equal(hasBreathingRate({ breathingRate: 35.8 }), true);

  // Invalid rates: 0, negative, NaN, Infinity, null, undefined, strings
  assert.equal(hasBreathingRate({ breathingRate: 0 }), false);
  assert.equal(hasBreathingRate({ breathingRate: -1 }), false);
  assert.equal(hasBreathingRate({ breathingRate: -15.4 }), false);
  assert.equal(hasBreathingRate({ breathingRate: NaN }), false);
  assert.equal(hasBreathingRate({ breathingRate: Infinity }), false);
  assert.equal(hasBreathingRate({ breathingRate: -Infinity }), false);
  assert.equal(hasBreathingRate({ breathingRate: null }), false);
  assert.equal(hasBreathingRate({ breathingRate: undefined }), false);
  assert.equal(hasBreathingRate({ breathingRate: '15.4' }), false);
  assert.equal(hasBreathingRate(null), false);
  assert.equal(hasBreathingRate(undefined), false);
});

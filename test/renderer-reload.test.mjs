import test from 'node:test';
import assert from 'node:assert/strict';
import { RendererSessionSyncCoordinator } from '../src/common/telemetry-utils.ts';

test('Renderer reload regression: reload while cleanup is pending puts interface in stopping state', () => {
  let isStoppingVal = false;
  let runningVal = true;
  let statusVal = '';
  let fatalErrorVal = null;

  const coordinator = new RendererSessionSyncCoordinator({
    setIsStopping: (v) => { isStoppingVal = v; },
    setRunning: (v) => { runningVal = v; },
    setStatus: (v) => { statusVal = v; },
    setFatalSessionError: (v) => { fatalErrorVal = v; },
  });

  // Renderer mounts while main process teardown is pending (isCleanupPending: true)
  coordinator.handleStateSnapshot({
    state: 'stopping',
    isCleanupPending: true,
    wasLastTeardownSuccessful: true,
    teardownError: null,
  });

  assert.equal(isStoppingVal, true, 'isStopping must be set to true while cleanup is pending');
  assert.equal(coordinator.isStopping(), true);
  assert.equal(statusVal, 'Camera finalizing release; standing by...');
  assert.equal(fatalErrorVal, null);
});

test('Renderer reload regression: cleanup succeeds after reload and resets stopping state to usable', () => {
  let isStoppingVal = false;
  let runningVal = true;
  let statusVal = '';
  let fatalErrorVal = null;

  const coordinator = new RendererSessionSyncCoordinator({
    setIsStopping: (v) => { isStoppingVal = v; },
    setRunning: (v) => { runningVal = v; },
    setStatus: (v) => { statusVal = v; },
    setFatalSessionError: (v) => { fatalErrorVal = v; },
  });

  // Initial snapshot: reload happened while camera release was in progress
  coordinator.handleStateSnapshot({
    state: 'stopping',
    isCleanupPending: true,
    wasLastTeardownSuccessful: true,
    teardownError: null,
  });
  assert.equal(isStoppingVal, true);

  // Main process broadcast: teardown completes cleanly
  coordinator.handleSessionStateEvent({
    state: 'idle',
    isCleanupPending: false,
    wasLastTeardownSuccessful: true,
    teardownError: null,
  });

  assert.equal(isStoppingVal, false, 'isStopping must be reset to false once cleanup settles');
  assert.equal(coordinator.isStopping(), false);
  assert.equal(runningVal, false, 'running must be false');
  assert.equal(statusVal, 'System standing by', 'status must return to standing by');
  assert.equal(fatalErrorVal, null, 'no fatal error on successful cleanup');
});

test('Renderer reload regression: cleanup fails after reload and transitions to persistent fatal error', () => {
  let isStoppingVal = false;
  let runningVal = true;
  let statusVal = '';
  let fatalErrorVal = null;
  let cancelRestartCalled = false;

  const coordinator = new RendererSessionSyncCoordinator({
    setIsStopping: (v) => { isStoppingVal = v; },
    setRunning: (v) => { runningVal = v; },
    setStatus: (v) => { statusVal = v; },
    setFatalSessionError: (v) => { fatalErrorVal = v; },
    cancelPendingRestart: () => { cancelRestartCalled = true; },
  });

  // Initial snapshot: reload while cleanup pending
  coordinator.handleStateSnapshot({
    state: 'stopping',
    isCleanupPending: true,
    wasLastTeardownSuccessful: true,
    teardownError: null,
  });
  assert.equal(isStoppingVal, true);

  // Main process broadcast: hardware teardown failed
  coordinator.handleSessionStateEvent({
    state: 'degraded',
    isCleanupPending: false,
    wasLastTeardownSuccessful: false,
    teardownError: 'DirectShow graph locked',
  });

  assert.equal(isStoppingVal, false, 'isStopping must be cleared even when cleanup fails');
  assert.equal(runningVal, false);
  assert.match(fatalErrorVal, /Camera release could not be confirmed/);
  assert.equal(coordinator.getFatalError(), fatalErrorVal);
  assert.equal(cancelRestartCalled, true, 'pending restart timers must be cancelled');
});

test('Renderer reload regression: interface becomes usable again after successful cleanup', () => {
  let isStoppingVal = false;
  let runningVal = false;
  let statusVal = '';
  let fatalErrorVal = null;

  const coordinator = new RendererSessionSyncCoordinator({
    setIsStopping: (v) => { isStoppingVal = v; },
    setRunning: (v) => { runningVal = v; },
    setStatus: (v) => { statusVal = v; },
    setFatalSessionError: (v) => { fatalErrorVal = v; },
  });

  // Mount with pending cleanup
  coordinator.handleStateSnapshot({
    state: 'stopping',
    isCleanupPending: true,
    wasLastTeardownSuccessful: true,
  });
  assert.equal(isStoppingVal, true);

  // Cleanup settles successfully
  coordinator.handleSessionStateEvent({
    state: 'idle',
    isCleanupPending: false,
    wasLastTeardownSuccessful: true,
  });
  assert.equal(isStoppingVal, false);

  // Simulated start measurement action
  const canStart = !isStoppingVal && !runningVal && !fatalErrorVal;
  assert.equal(canStart, true, 'Start button must be fully interactive after cleanup finishes');
});

test('Renderer reload regression: intermediate stopping event with isCleanupPending: false preserves stopping indicator until settled idle', () => {
  let isStoppingVal = false;
  let runningVal = true;
  let statusVal = '';
  let fatalErrorVal = null;

  const coordinator = new RendererSessionSyncCoordinator({
    setIsStopping: (v) => { isStoppingVal = v; },
    setRunning: (v) => { runningVal = v; },
    setStatus: (v) => { statusVal = v; },
    setFatalSessionError: (v) => { fatalErrorVal = v; },
  });

  // Intermediate event: state is 'stopping', but isCleanupPending is false
  coordinator.handleSessionStateEvent({
    state: 'stopping',
    isCleanupPending: false,
    wasLastTeardownSuccessful: true,
    teardownError: null,
  });

  assert.equal(isStoppingVal, true, 'isStopping must remain true when state is stopping even if isCleanupPending is false');
  assert.equal(coordinator.isStopping(), true);
  assert.equal(statusVal, 'Camera finalizing release; standing by...');

  // Event when teardown genuinely settles
  coordinator.handleSessionStateEvent({
    state: 'idle',
    isCleanupPending: false,
    wasLastTeardownSuccessful: true,
    teardownError: null,
  });

  assert.equal(isStoppingVal, false, 'isStopping must clear only after cleanup settles to idle');
  assert.equal(coordinator.isStopping(), false);
  assert.equal(statusVal, 'System standing by');
});



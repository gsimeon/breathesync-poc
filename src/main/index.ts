import 'dotenv/config';
import { app, BrowserWindow, ipcMain } from 'electron';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SmartSpectraSDK,
  CameraSelection,
  breathingMetrics,
} from '@smartspectra/node-sdk';
import { decodeMetrics } from '@smartspectra/node-sdk/messages';
import {
  SessionState,
  transitionSessionState,
  normalizeCamera,
  getValidationMessage,
  normalizeBreathingMetrics,
} from '../common/telemetry-utils';

let mainWindow: BrowserWindow | null = null;
let sdk: SmartSpectraSDK | null = null;
let sessionState: SessionState = 'idle';
let isShuttingDown = false;

// P0: Coordinate in-flight startup with shutdown and stop
let activeStartupPromise: Promise<void> | null = null;
let activeCleanupPromise: Promise<void> | null = null;

function send(channel: string, payload: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function registerSdkEvents(instance: SmartSpectraSDK) {
  instance.on('processingStatus', (status: unknown) => {
    send('breathesync:status', { kind: 'processing', detail: String(status) });
  });

  instance.on('validationStatus', (code: unknown, timestamp: unknown, hint: unknown) => {
    const numCode = Number(code);
    const friendlyMessage = getValidationMessage(numCode, typeof hint === 'string' ? hint : null);

    send('breathesync:status', {
      kind: 'validation',
      code: numCode,
      timestamp: String(timestamp),
      detail: friendlyMessage,
      hint: friendlyMessage,
    });
  });

  instance.on('metrics', (buffer: Buffer, timestampUs: number) => {
    try {
      const decoded = decodeMetrics(buffer) as any;
      const normalized = normalizeBreathingMetrics(decoded, timestampUs, Date.now());
      send('breathesync:metrics', normalized);
    } catch (error) {
      send('breathesync:error', {
        message: error instanceof Error ? error.message : 'Unable to decode SDK metrics',
      });
    }
  });

  instance.on('error', (code: unknown, message: unknown, retryable: unknown) => {
    send('breathesync:error', {
      code: String(code),
      message: String(message),
      retryable: Boolean(retryable),
    });
  });
}

function getExpectedPackagedRendererUrl(): string {
  return pathToFileURL(resolve(__dirname, '../renderer/index.html')).href;
}

/**
 * P1 Security: Validate both IPC sender webContents, main-frame context, and exact origin/URL.
 */
function validateIpcSender(event: Electron.IpcMainInvokeEvent) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Unauthorized IPC invocation: untrusted sender');
  }

  // P1 Security: Ensure invocation comes strictly from the top-level main frame
  if (event.senderFrame && (event.senderFrame.parent !== null || event.sender.mainFrame !== event.senderFrame)) {
    throw new Error('Unauthorized IPC invocation: non-main frame');
  }

  const senderUrl = event.senderFrame?.url || '';

  if (app.isPackaged) {
    const expectedUrl = getExpectedPackagedRendererUrl();
    if (senderUrl !== expectedUrl) {
      throw new Error(`Unauthorized IPC invocation in packaged mode: ${senderUrl}`);
    }
  } else {
    // In development mode, strictly allow local development server URL or local packaged file
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    let isAllowed = false;
    if (devUrl && (devUrl.startsWith('http://localhost:') || devUrl.startsWith('http://127.0.0.1:'))) {
      try {
        const expectedOrigin = new URL(devUrl).origin;
        const senderOrigin = new URL(senderUrl).origin;
        isAllowed = senderOrigin === expectedOrigin;
      } catch {
        isAllowed = false;
      }
    }
    if (!isAllowed) {
      const expectedFile = getExpectedPackagedRendererUrl();
      isAllowed = senderUrl === expectedFile;
    }

    if (!isAllowed) {
      throw new Error(`Unauthorized IPC invocation origin: ${senderUrl}`);
    }
  }
}

ipcMain.handle('breathesync:cameras', async (event) => {
  validateIpcSender(event);
  try {
    const cameras = SmartSpectraSDK.availableCameras();
    return cameras.map(normalizeCamera);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Camera discovery failed');
  }
});

/**
 * P0: Execute cleanup exactly once and allow all concurrent callers (stop, shutdown, etc.)
 * to await the identical cleanup operation without deadlocks.
 *
 * @param callerIsStartup - set to true when called from inside startupTask failure branch
 *                          so cleanup doesn't deadlock by awaiting activeStartupPromise.
 */
function cleanupSdk(callerIsStartup = false): Promise<void> {
  if (activeCleanupPromise) {
    return activeCleanupPromise;
  }

  activeCleanupPromise = (async () => {
    // If called externally (not from startup failure itself), wait for startup to settle first
    if (activeStartupPromise && !callerIsStartup) {
      console.log('Awaiting in-flight startup to settle before running cleanup...');
      try {
        await activeStartupPromise;
      } catch {
        // Startup error will be handled by its own caller
      }
      activeStartupPromise = null;
    }

    const current = sdk;
    sdk = null;

    if (current) {
      console.log('Stopping and destroying SmartSpectra session...');
      try { await current.stopAsync(); } catch (e) { console.warn('SDK stop warning:', e); }
      try { await current.destroy(); } catch (e) { console.warn('SDK destroy warning:', e); }
      console.log('SmartSpectra session successfully torn down.');
    }
  })().finally(() => {
    activeCleanupPromise = null;
  });

  return activeCleanupPromise;
}

ipcMain.handle('breathesync:start', async (event, cameraId: string) => {
  validateIpcSender(event);

  const transition = transitionSessionState(sessionState, 'start');
  if (!transition.allowed) {
    throw new Error(transition.error || 'Cannot start measurement in current state.');
  }

  const apiKey = process.env.SMARTSPECTRA_API_KEY;
  if (!apiKey) {
    throw new Error('SMARTSPECTRA_API_KEY is missing. Add it to your local .env file and restart the app.');
  }

  if (!cameraId || typeof cameraId !== 'string') {
    throw new Error('Select a camera before starting measurement.');
  }

  // Validate cameraId against discovered hardware devices
  const available = SmartSpectraSDK.availableCameras();
  const cameraFound = available.some((c) => c.id === cameraId);
  if (!cameraFound) {
    throw new Error('Selected camera ID does not match any detected hardware camera.');
  }

  sessionState = 'starting';
  send('breathesync:status', { kind: 'session', detail: 'Initializing SmartSpectra camera session...' });

  const startupTask = (async () => {
    try {
      const instance = new SmartSpectraSDK({
        apiKey,
        requestedMetrics: [...breathingMetrics],
        enableTelemetry: false,
      });

      sdk = instance;
      registerSdkEvents(instance);
      instance.useCamera(CameraSelection.byId(cameraId));
      await instance.start();

      // P0 race check: ensure shutdown or stop did not begin while start was awaiting
      if (sessionState === 'starting') {
        sessionState = 'running';
        send('breathesync:status', { kind: 'session', detail: 'Measurement started; waiting for valid samples.' });
      } else {
        console.log(`Startup settled but session state was '${sessionState}'; triggering deferred teardown.`);
        await cleanupSdk(false);
      }
    } catch (error) {
      if (sessionState === 'starting') {
        sessionState = 'idle';
      }
      activeStartupPromise = null; // Clear before calling cleanup so no circular await occurs
      await cleanupSdk(true);
      throw error;
    } finally {
      activeStartupPromise = null;
    }
  })();

  activeStartupPromise = startupTask;
  await startupTask;
  return { started: true };
});

ipcMain.handle('breathesync:stop', async (event) => {
  validateIpcSender(event);

  if (sessionState === 'idle') {
    return { stopped: true };
  }

  const transition = transitionSessionState(sessionState, 'stop');
  if (!transition.allowed) {
    throw new Error(transition.error || 'Cannot stop measurement in current state.');
  }

  sessionState = 'stopping';
  send('breathesync:status', { kind: 'session', detail: 'Stopping measurement and releasing camera...' });

  try {
    await cleanupSdk(false);
  } finally {
    if (!isShuttingDown) {
      sessionState = 'idle';
    }
  }

  send('breathesync:status', { kind: 'session', detail: 'Measurement stopped. Camera released.' });
  return { stopped: true };
});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 680,
    title: 'BreatheSync — SmartSpectra POC',
    backgroundColor: '#F7FAF8',
    show: true,
    webPreferences: {
      preload: resolve(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // P0 Security: Prevent unexpected external navigation
  mainWindow.webContents.on('will-navigate', (navEvent, url) => {
    const isLocalDev = !app.isPackaged && (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:'));
    const isLocalFile = url.startsWith('file://');
    if (!isLocalDev && !isLocalFile) {
      console.warn('Blocked unauthorized in-app navigation to:', url);
      navEvent.preventDefault();
    }
  });

  // P0 Security: Deny window.open / external windows
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.warn('Blocked external window creation attempt to:', url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('Failed to load renderer UI:', code, desc, url);
  });

  // P0 Security: In packaged builds, NEVER trust process.env.ELECTRON_RENDERER_URL
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const isDevUrlSafe = devUrl && (devUrl.startsWith('http://localhost:') || devUrl.startsWith('http://127.0.0.1:'));

  if (!app.isPackaged && isDevUrlSafe) {
    console.log('Development mode: loading verified local renderer URL:', devUrl);
    await mainWindow.loadURL(devUrl);
  } else {
    const localHtmlPath = resolve(__dirname, '../renderer/index.html');
    console.log('Production / secure mode: loading local packaged HTML:', localHtmlPath);
    await mainWindow.loadFile(localHtmlPath);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow().catch((err) => console.error('Error creating window:', err));
});

// P0: Graceful asynchronous shutdown guaranteeing camera and SDK teardown before process exit
app.on('before-quit', async (event) => {
  if (isShuttingDown) {
    return; // Teardown completed, proceed with exit
  }

  event.preventDefault();
  isShuttingDown = true;
  sessionState = 'shutting_down';
  console.log('App quitting: beginning graceful camera and SDK teardown...');

  try {
    await cleanupSdk(false);
  } catch (error) {
    console.error('Error during shutdown cleanup:', error);
  } finally {
    console.log('Teardown complete. Exiting application.');
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

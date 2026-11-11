import 'dotenv/config';
import { app, BrowserWindow, ipcMain } from 'electron';
import { resolve } from 'node:path';
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
let isCleaningUp = false;

// P0: Coordinate in-flight startup with shutdown and stop
let activeStartupPromise: Promise<void> | null = null;

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

/**
 * P0 Security: Validate both IPC sender webContents and origin/URL.
 */
function validateIpcSender(event: Electron.IpcMainInvokeEvent) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Unauthorized IPC invocation: untrusted sender');
  }

  // Validate sender URL origin
  const senderUrl = event.senderFrame?.url || '';
  const isAllowedDev = !app.isPackaged && (senderUrl.startsWith('http://localhost:') || senderUrl.startsWith('http://127.0.0.1:'));
  const isAllowedFile = senderUrl.startsWith('file://');

  if (!isAllowedDev && !isAllowedFile) {
    throw new Error(`Unauthorized IPC invocation origin: ${senderUrl}`);
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
 * Perform idempotent, sequential cleanup of the active SDK instance.
 */
async function cleanupSdk(): Promise<void> {
  if (isCleaningUp) return;
  isCleaningUp = true;

  try {
    // If a startup operation is actively in flight, await its settlement first
    if (activeStartupPromise) {
      console.log('Awaiting in-flight SDK startup before teardown...');
      try {
        await activeStartupPromise;
      } catch {
        // Startup failure will be handled by its own error branch
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
  } finally {
    isCleaningUp = false;
  }
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
        await cleanupSdk();
      }
    } catch (error) {
      if (sessionState === 'starting') {
        sessionState = 'idle';
      }
      await cleanupSdk();
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
    await cleanupSdk();
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
    await cleanupSdk();
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

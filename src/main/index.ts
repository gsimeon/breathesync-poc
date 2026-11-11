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
  SessionLifecycleCoordinator,
} from '../common/telemetry-utils';

let mainWindow: BrowserWindow | null = null;
const coordinator = new SessionLifecycleCoordinator();

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

ipcMain.handle('breathesync:start', async (event, cameraId: string) => {
  validateIpcSender(event);

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

  send('breathesync:status', { kind: 'session', detail: 'Initializing SmartSpectra camera session...' });

  try {
    await coordinator.start(
      async () => {
        const instance = new SmartSpectraSDK({
          apiKey,
          requestedMetrics: [...breathingMetrics],
          enableTelemetry: false,
        });

        registerSdkEvents(instance);
        instance.useCamera(CameraSelection.byId(cameraId));
        return instance;
      },
      () => {
        send('breathesync:status', { kind: 'session', detail: 'Measurement started; waiting for valid samples.' });
      }
    );
    return { started: true };
  } catch (error: any) {
    // P1: Check if startup failed AND camera release failed (coordinator in degraded state)
    if (!coordinator.wasLastTeardownSuccessful() || coordinator.getState() === 'degraded') {
      const teardownErrMsg = coordinator.getTeardownError()?.message || 'Teardown failure';
      send('breathesync:status', {
        kind: 'session',
        detail: 'Startup failed and camera release could not be confirmed. Please restart the application.',
        error: teardownErrMsg,
      });
      send('breathesync:error', {
        code: 'TEARDOWN_FAILED',
        message: `Startup failed and camera release could not be confirmed (${teardownErrMsg}). Please restart the application.`,
        retryable: false,
      });
    }
    throw error;
  }
});

ipcMain.handle('breathesync:stop', async (event) => {
  validateIpcSender(event);

  if (coordinator.getState() === 'idle') {
    return { stopped: true };
  }

  send('breathesync:status', { kind: 'session', detail: 'Stopping measurement and releasing camera...' });
  try {
    await coordinator.stop();
    send('breathesync:status', { kind: 'session', detail: 'Measurement stopped. Camera released.' });
    return { stopped: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Teardown failure';
    send('breathesync:status', {
      kind: 'session',
      detail: 'Measurement stopped, but camera hardware release could not be confirmed.',
      error: message,
    });
    send('breathesync:error', {
      code: 'TEARDOWN_FAILED',
      message: `Camera resource could not be cleanly released: ${message}`,
      retryable: false,
    });
    throw error;
  }
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
    let isAllowed = false;
    if (app.isPackaged) {
      isAllowed = url === getExpectedPackagedRendererUrl();
    } else {
      const devUrl = process.env.ELECTRON_RENDERER_URL;
      if (devUrl && (devUrl.startsWith('http://localhost:') || devUrl.startsWith('http://127.0.0.1:'))) {
        try {
          isAllowed = new URL(url).origin === new URL(devUrl).origin;
        } catch {
          isAllowed = false;
        }
      }
      if (!isAllowed) {
        isAllowed = url === getExpectedPackagedRendererUrl();
      }
    }

    if (!isAllowed) {
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

// P0: Graceful asynchronous shutdown coordinating camera and SDK teardown before process exit
app.on('before-quit', async (event) => {
  if (coordinator.isShutdownComplete()) {
    return; // Teardown fully completed, proceed with normal exit
  }

  // Prevent immediate process exit while teardown is pending
  event.preventDefault();

  if (coordinator.isShutdownInitiated()) {
    console.log('Teardown already initiated; awaiting completion before quit...');
    await coordinator.shutdown();
    app.quit();
    return;
  }

  console.log('App quitting: beginning graceful camera and SDK teardown...');

  try {
    await coordinator.shutdown();
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

import 'dotenv/config';
import { app, BrowserWindow, ipcMain } from 'electron';
import { resolve } from 'node:path';
import {
  SmartSpectraSDK,
  CameraSelection,
  breathingMetrics,
} from '@smartspectra/node-sdk';
import { decodeMetrics } from '@smartspectra/node-sdk/messages';

let mainWindow: BrowserWindow | null = null;
let sdk: SmartSpectraSDK | null = null;
let isStartingOrRunning = false;

function send(channel: string, payload: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

  function getLatest<T>(items?: T[] | null): T | null {
    return items && items.length > 0 ? items[items.length - 1] : null;
  }

const VALIDATION_MESSAGES: Record<number, string> = {
  0: 'Optimal framing and lighting',
  1: 'No face detected — please look at the camera',
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

function registerSdkEvents(instance: SmartSpectraSDK) {
  instance.on('processingStatus', (status: unknown) => {
    send('breathesync:status', { kind: 'processing', detail: String(status) });
  });

  instance.on('validationStatus', (code: unknown, timestamp: unknown, hint: unknown) => {
    const numCode = Number(code);
    const friendlyMessage = (typeof hint === 'string' && hint.trim().length > 0)
      ? hint
      : (VALIDATION_MESSAGES[numCode] || `Validation code: ${code}`);

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
        const decoded = decodeMetrics(buffer);

        const rate = getLatest(decoded?.breathing?.rate);
        const chest = getLatest(decoded?.breathing?.upperTrace);
        const abdomen = getLatest(decoded?.breathing?.lowerTrace);

        send('breathesync:metrics', {
          timestampUs,
          breathingRate: rate?.value ?? null,
          confidence: rate?.confidence ?? null,
          stable: rate?.stable ?? false,
          chestTrace: chest?.value ?? null,
          abdomenTrace: abdomen?.value ?? null,
          state: !rate ? 'acquiring' : rate.stable ? 'valid' : 'low_confidence',
        });
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

  ipcMain.handle('breathesync:cameras', async () => {
    try {
      const cameras = SmartSpectraSDK.availableCameras();
      return cameras.map((camera) => ({
        id: camera.id,
        label: camera.name || (camera as { label?: string }).label || 'Camera',
      }));
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Camera discovery failed');
    }
  });

  ipcMain.handle('breathesync:start', async (_event, cameraId: string) => {
    if (isStartingOrRunning) {
      throw new Error('A measurement session is already starting or running.');
    }

    const apiKey = process.env.SMARTSPECTRA_API_KEY;
    if (!apiKey) {
      throw new Error('SMARTSPECTRA_API_KEY is missing. Add it to your local .env file and restart the app.');
    }
    if (!cameraId || typeof cameraId !== 'string') {
      throw new Error('Select a camera before starting measurement.');
    }

    isStartingOrRunning = true;
    try {
      sdk = new SmartSpectraSDK({
        apiKey,
        requestedMetrics: [...breathingMetrics],
        enableTelemetry: false,
      });

      registerSdkEvents(sdk);
      sdk.useCamera(CameraSelection.byId(cameraId));
      await sdk.start();

      send('breathesync:status', { kind: 'session', detail: 'Measurement started; waiting for valid samples.' });
      return { started: true };
    } catch (error) {
      isStartingOrRunning = false;
      if (sdk) {
        try { await sdk.stopAsync(); } catch { /* best-effort cleanup */ }
        try { await sdk.destroy(); } catch { /* best-effort cleanup */ }
        sdk = null;
      }
      throw new Error(error instanceof Error ? error.message : 'SmartSpectra failed to start');
    }
  });

  ipcMain.handle('breathesync:stop', async () => {
    const current = sdk;
    sdk = null;
    isStartingOrRunning = false;

    if (current) {
      try { await current.stopAsync(); } finally { await current.destroy(); }
    }

    send('breathesync:status', { kind: 'session', detail: 'Measurement stopped.' });
    return { stopped: true };
  });

async function createWindow() {
  console.log('Creating main BrowserWindow...');
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

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Renderer UI loaded successfully');
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('Failed to load renderer UI:', code, desc, url);
  });

  const url = process.env.ELECTRON_RENDERER_URL;
  console.log('Loading renderer URL:', url);
  if (url) {
    await mainWindow.loadURL(url);
  } else {
    await mainWindow.loadFile(resolve(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  console.log('Electron app is ready');
  createWindow().catch((err) => console.error('Error creating window:', err));
});

  app.on('before-quit', async () => {
    const current = sdk;
    sdk = null;
    if (current) {
      try { await current.stopAsync(); } catch { /* best-effort shutdown */ }
      try { await current.destroy(); } catch { /* best-effort shutdown */ }
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

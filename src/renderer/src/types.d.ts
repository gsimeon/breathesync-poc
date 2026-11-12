export {};

declare global {
  interface Window {
    breatheSync: {
      getCameras: () => Promise<Array<{ id: string; label: string }>>;
      getState?: () => Promise<{
        state: string;
        isCleanupPending: boolean;
        wasLastTeardownSuccessful: boolean;
        teardownError: string | null;
      }>;
      start: (cameraId: string) => Promise<{ started: boolean }>;
      stop: () => Promise<{ stopped: boolean }>;
      onMetrics: (listener: (payload: any) => void) => () => void;
      onStatus: (listener: (payload: any) => void) => () => void;
      onError: (listener: (payload: any) => void) => () => void;
      onSessionState?: (listener: (payload: {
        state: string;
        isCleanupPending: boolean;
        wasLastTeardownSuccessful: boolean;
        teardownError: string | null;
      }) => void) => () => void;
    };
  }
}

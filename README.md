# BreatheSync — SmartSpectra Technical Proof of Concept

Windows x64-first Electron + React + TypeScript proof of concept for integrating Presage SmartSpectra non-contact physiological sensing.

> **Status:** Actively verified on Windows x64 hardware with live webcam integration, real-time dual-trace oscilloscope waveform, graceful shutdown state machine, and measurement freshness tracking.

## Scope of this proof of concept

- **Hardware Camera Discovery**: Enumerate cameras using `@smartspectra/node-sdk` DirectShow / MediaFoundation on Windows.
- **Strict Device Selection**: Select a camera by its verified hardware device ID.
- **Respiratory Session**: Start a breathing-only SmartSpectra session via the Electron main process.
- **Normalized Telemetry IPC**: Decode live protobuf metrics and forward only sanitized values over secure IPC.
- **Real-Time Dual Waveform**: Render dynamic oscilloscope-style chest and abdominal respiration traces.
- **Freshness Heartbeat**: Detect signal pauses and prevent stale measurements from being presented as live.
- **Graceful Teardown**: Asynchronous `before-quit` teardown guaranteeing complete camera release before process exit.
- **Zero Disk Persistence**: Raw video frames are processed exclusively in volatile memory; zero frames or telemetry saved to disk.
- **Disabled SDK Telemetry**: Explicitly sets `enableTelemetry: false` in the SDK configuration.

## Prerequisites

- Windows 10/11 x64
- Node.js 20+ (Presage recommends Node 24 LTS)
- npm
- A SmartSpectra developer API key from https://physiology.presagetech.com/
- A working webcam with adequate ambient lighting

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` and set your developer API key:

```dotenv
SMARTSPECTRA_API_KEY=your_developer_key_here
```

> **Security Note:** Never commit `.env` or embed an unrestricted developer key in public binaries or repository history.

## Development & Testing

Run the development app on your desktop:

```powershell
npm run dev
# or double-click start-app.bat
```

Run automated typechecks and unit tests:

```powershell
npm test
```

Build the standalone Windows NSIS installer:

```powershell
npm run package:win
# Output: release/BreatheSync Setup 0.1.0.exe
```

## Architecture & Security Boundaries

1. **Process Isolation**: The Electron main process owns the SmartSpectra SDK and the API key. The React renderer bundle contains zero keys or direct Node.js bindings.
2. **IPC Sender Validation**: All IPC channels enforce `validateIpcSender(event)` to ensure invocation calls originate exclusively from the authenticated application window.
3. **Session State Machine**: Governed by an explicit finite state machine (`idle` → `starting` → `running` → `stopping` → `shutting_down`) to eliminate race conditions.
4. **Lifecycle & Clean Exit**: `app.on('before-quit')` intercepts process shutdown with `event.preventDefault()`, awaits `stopAsync()` and `destroy()`, and then terminates cleanly.
5. **Measurement Freshness**: An active heartbeat monitors sample arrival. If samples cease for more than 2.5s (e.g. obscured camera, framing loss), the UI marks the signal as paused instead of freezing stale numbers.

## API Key Provisioning Strategy (Desktop Distribution)

For local development and internal judge evaluations:
- The key is loaded strictly via environment variables (`SMARTSPECTRA_API_KEY` in `.env`).

For production distribution:
- **Never embed an unrestricted developer key in the installer binary.**
- Production releases should authenticate users via an application backend proxy or an ephemeral short-lived session token issued through Presage's approved partner provisioning flow.

## Verification Checklist

- [x] Install dependencies on Windows x64 (Node 24 LTS, npm 11)
- [x] Confirm native SDK package loads (v3.5.0 verified in Electron main process)
- [x] Confirm valid API key authentication against Presage backend
- [x] Confirm hardware camera enumeration (Discovered `Integrated Webcam`)
- [x] Confirm camera start and hardware stream acquisition
- [x] Confirm actual `metrics` and protobuf decoding
- [x] Confirm chest and abdominal trace values (verified on hardware)
- [x] Confirm real-time dual-trace oscilloscope waveform graph
- [x] Confirm sample freshness detection and stale-signal handling
- [x] Confirm telemetry setting in SDK (`enableTelemetry: false`)
- [x] Confirm graceful asynchronous shutdown and camera device release
- [x] Automated CI workflow and unit tests configured

## Official References

- Documentation: https://presagetech.com/docs/smartspectra-sdk/nodejs
- Metrics & Formats: https://smartspectra.presagetech.com/docs/nodejs/metrics/
- Telemetry & Privacy: https://smartspectra.presagetech.com/docs/telemetry-and-privacy/

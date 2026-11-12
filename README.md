# BreatheSync — SmartSpectra Technical Proof of Concept

Windows x64-first Electron + React + TypeScript proof of concept for integrating Presage SmartSpectra non-contact physiological sensing.

> **Status:** Technical proof of concept with automated Windows CI validation (typecheck, 34 unit and renderer regression tests, NSIS installer build) and preliminary Windows x64 local testing with an integrated webcam. Hardware verification across arbitrary external cameras and clean machine setups is ongoing.

## Scope of this proof of concept

- **Hardware Camera Discovery**: Enumerate cameras using `@smartspectra/node-sdk` DirectShow / MediaFoundation on Windows.
- **Strict Device Selection**: Select a camera by its verified hardware device ID.
- **Respiratory Session**: Start a breathing-only SmartSpectra session via the Electron main process.
- **Normalized Telemetry IPC**: Decode live protobuf metrics and forward only sanitized values over secure IPC.
- **Real-Time Dual Waveform**: Render dynamic oscilloscope-style chest and abdominal respiration traces.
- **Freshness Heartbeat**: Detect signal pauses and prevent stale measurements from being presented as live.
- **Graceful Application Teardown**: Asynchronous `before-quit` handler coordinating camera and SDK teardown before standard process exit (OS-level sudden termination, logoff, or forced kill may bypass application lifecycle hooks per standard Electron and Windows behavior).
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
4. **Lifecycle & Clean Exit**: `app.on('before-quit')` intercepts standard application shutdown with `event.preventDefault()`, tracks shutdown completion state, awaits `stopAsync()` and `destroy()`, and then permits process exit. Note that sudden OS-level shutdown, crash, or `SIGKILL` can bypass Electron lifecycle hooks.
5. **Measurement Freshness**: An active heartbeat monitors sample arrival. If samples cease for more than 2.5s (e.g. obscured camera, framing loss), the UI marks the signal as paused instead of freezing stale numbers.

## API Key Provisioning Strategy (Desktop Distribution)

For local development and internal judge evaluations:
- The key is loaded strictly via environment variables (`SMARTSPECTRA_API_KEY` in `.env`).

For production distribution:
- **Never embed an unrestricted developer key in the installer binary.**
- Production releases should authenticate users via an application backend proxy or an ephemeral short-lived session token issued through Presage's approved partner provisioning flow.

## Physical Hardware Acceptance Test Protocol (Windows 10/11)

To independently validate BreatheSync outside mocked developer test harnesses, complete the following physical camera test matrix:

1. **Integrated Webcam Baseline**: Start a measurement session with the built-in webcam. Verify initial calibration, confidence meter settling (`Confidence >= 45%`), and stable real-time respiratory waveform output.
2. **Repeated Start/Stop Stress Cycle**: Execute `Start Measurement` → `Stop & Release Camera` at least 10 consecutive times to prove DirectShow / MediaFoundation filter graph handles release cleanly without driver deadlocks or memory leaks.
3. **Mid-Session Hardware Disconnection**: Unplug an active USB webcam while measurement is running. Verify that the UI displays the hardware error notice and transitions to a safe idle/degraded state rather than crashing.
4. **Hot-Plug Reconnection & Recovery**: Plug the webcam back in, click `Refresh camera list`, and start a new measurement to confirm hardware re-enumeration.
5. **Multi-Camera Switching**: On a system with multiple video input devices, switch between cameras and verify the SDK binds to the chosen device ID without cross-device handle collision.
6. **Active Session Process Termination**: Close the application window while a measurement session is running. Verify that the `before-quit` handler intercepts exit, awaits `stopAsync()` and `destroy()`, and leaves no dangling background processes or camera locks.
7. **Clean-Machine Installer Execution**: Run `release/BreatheSync Setup 0.1.0.exe` on a clean Windows 10/11 machine without Node.js or developer tooling installed, confirming self-contained runtime execution.

## Verification Checklist

- [x] Install dependencies on Windows x64 (Node 24 LTS, npm 11)
- [x] Confirm native SDK package loads (`@smartspectra/node-sdk` v3.5.0 verified in Electron main process)
- [x] Confirm valid API key authentication against Presage backend
- [x] Confirm hardware camera enumeration (Observed `Integrated Webcam` DirectShow discovery)
- [x] Confirm camera start and hardware stream acquisition
- [x] Confirm actual `metrics` and protobuf decoding
- [x] Confirm chest and abdominal trace values (observed in local development session)
- [x] Confirm real-time dual-trace oscilloscope waveform graph
- [x] Confirm sample freshness detection and stale-signal handling
- [x] Confirm telemetry setting in SDK (`enableTelemetry: false`)
- [x] Confirm graceful asynchronous application shutdown and camera device release on standard exit
- [x] Automated Windows CI workflow and unit tests configured (passing in GitHub Actions)

## Official References

- Documentation: https://presagetech.com/docs/smartspectra-sdk/nodejs
- Metrics & Formats: https://smartspectra.presagetech.com/docs/nodejs/metrics/
- Telemetry & Privacy: https://smartspectra.presagetech.com/docs/telemetry-and-privacy/

# BreatheSync — SmartSpectra Technical Proof of Concept

Windows x64-first Electron + React + TypeScript proof of concept for integrating Presage SmartSpectra.

> **Status:** starter scaffold only. The SDK has not been installed, authenticated, or run in this environment. No live signal or camera operation is claimed as verified.

## Scope of this proof of concept

- Enumerate cameras using the Node.js SmartSpectra SDK.
- Select a camera by its discovered ID (important on Windows).
- Start a breathing-only SmartSpectra session.
- Decode live metrics and forward only normalized measurements to the UI.
- Display breathing rate, confidence/stability, and the latest chest/abdomen trace values.
- Stop and destroy the SDK session.
- Keep the API key in the Electron main process environment, not the React renderer bundle.
- Disable SDK telemetry in the POC configuration. Revisit this choice only with an updated user disclosure.

## Prerequisites

- Windows 10/11 x64
- Node.js 20+ (Presage currently recommends Node 24 LTS)
- npm
- A SmartSpectra developer API key from https://physiology.presagetech.com/
- A working webcam

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` and set your key:

```dotenv
SMARTSPECTRA_API_KEY=replace_with_your_developer_key
```

Do not commit `.env`. Do not paste the key into source files, screenshots, issues, or public logs.

## Run

```powershell
npm run dev
```

The first run downloads the SDK and its platform runtime packages. Presage notes that the install can be several hundred MB because the npm package pulls platform runtime dependencies.

## POC test procedure

1. Launch the app.
2. Read and accept the camera/data notice.
3. Select a camera from the discovered list.
4. Start measurement.
5. Wait for the SDK to initialize and produce measurements. Do not expect a breathing rate immediately.
6. Confirm that values appear from the live SDK stream and that confidence/stability is shown.
7. Stop the session.
8. Confirm the UI reports the session stopped and that the camera is released.

A simulated signal may be used in separate UI tests, but it must never be presented as a real SmartSpectra measurement.

## Important SDK facts

- Node.js SDK: `@smartspectra/node-sdk`
- Current documentation identifies v3.4.0 as latest stable at the time this scaffold was prepared.
- Windows x64 is supported.
- Node.js >= 20; Electron >= 28 when using Electron.
- The default breathing bundle contains chest breathing, abdomen breathing, and breathing rate.
- Breathing rate samples expose `value`, `confidence` (0–100), and `stable`.
- Chest and abdomen traces expose `value` and `stable`; trace stability is inherited from the breathing-rate verdict.
- Do not request unavailable metrics such as breathing amplitude, apnea, baseline, or inhale/exhale ratio; doing so causes `start()` to fail.
- SDK telemetry defaults to enabled. This POC explicitly sets `enableTelemetry: false`.

Official references:
- https://presagetech.com/docs/smartspectra-sdk/nodejs
- https://smartspectra.presagetech.com/docs/nodejs/metrics/
- https://smartspectra.presagetech.com/docs/data-types/
- https://smartspectra.presagetech.com/docs/telemetry-and-privacy/

## Known limitations / verification gates

- This code is an integration starting point, not a verified build.
- The SmartSpectra API key must be valid and active.
- Camera availability, driver compatibility, lighting, movement, and measurement quality affect results.
- Windows camera discovery should use the returned camera ID. Do not assume `front`/`back` facing metadata is available.
- The POC does not store raw video or session measurements.
- The POC does not make health, stress, anxiety, diagnosis, or treatment claims.
- The SDK key is not a durable production secret merely because it is read from `.env`. A distributed desktop app needs an approved key provisioning/restriction strategy. Never ship a personal unrestricted developer key in a public binary.

## Current status checklist

- [x] Install dependencies on Windows x64
- [x] Confirm native SDK package loads (v3.5.0 verified in Electron)
- [ ] Confirm valid API key authentication
- [x] Confirm camera enumeration (discovered Integrated Webcam)
- [ ] Confirm camera start/stop
- [ ] Confirm actual `metrics` events
- [ ] Confirm decoded breathing rate and confidence
- [ ] Confirm chest/abdomen trace events
- [x] Confirm telemetry setting in the installed SDK version (`enableTelemetry: false`)
- [ ] Confirm camera is released after stop and app shutdown

Only mark a box after a real test on hardware.

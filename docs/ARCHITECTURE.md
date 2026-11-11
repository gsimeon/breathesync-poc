# Architecture decisions

## POC integration choice

Use the low-level Node.js SmartSpectra SDK from the Electron main process. The main process owns the API key and native SDK instance; the renderer receives only a narrow set of normalized measurements over explicitly named IPC channels.

This avoids putting the API key in the React/Vite renderer bundle. It does **not** make a developer key safe to distribute inside a desktop binary. The POC is for local development and judge testing with an approved key provisioning strategy.

## Signal contract

- `breathingRate`: latest `breathing.rate[].value`
- `confidence`: latest `breathing.rate[].confidence` (0–100)
- `stable`: latest `breathing.rate[].stable`
- `chestTrace`: latest `breathing.upperTrace[].value`
- `abdomenTrace`: latest `breathing.lowerTrace[].value`

Presage documents that trace stability is inherited from the breathing-rate verdict. Do not invent a confidence score for the trace.

## Camera selection

On Windows, discover cameras and select using `CameraSelection.byId(id)`. Presage documents that Windows camera facing metadata may be unknown and `.front`/`.back` may fail.

## Privacy boundaries

- No raw frames are sent to renderer or persisted by this POC.
- No measurements are persisted by this POC.
- SmartSpectra telemetry is explicitly disabled in SDK configuration.
- If telemetry configuration or SDK behavior differs in the installed release, update the privacy disclosure before demo.
- The user must explicitly accept the notice before invoking start.

## Future production hardening

- Confirm Presage-approved API key provisioning and distribution approach.
- Consider code signing and Windows packaging.
- Add explicit camera lifecycle state and app-close teardown tests.
- Add IPC sender validation and strict schema validation.
- Add measurement freshness checks to prevent stale values being rendered as live.
- Add a session model and opt-in local persistence only after privacy review.

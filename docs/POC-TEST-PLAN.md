# SmartSpectra POC test plan

Do not mark any test as passed without running it on a Windows x64 machine with a real webcam and valid Presage key.

| ID | Test | Expected result |
|---|---|---|
| POC-01 | Install Node 20+ dependencies | npm install completes |
| POC-02 | Start app without API key | Clear configuration error; no SDK start |
| POC-03 | Enumerate cameras | Camera IDs and labels returned |
| POC-04 | Start with invalid key | SDK error surfaced; app remains recoverable |
| POC-05 | Start with valid key | SDK processing status events received |
| POC-06 | Wait for breathing metrics | Decoded breathing rate and confidence received |
| POC-07 | Observe trace values | Chest and/or abdomen trace values update |
| POC-08 | Low-confidence sample | UI identifies measurement as not stable |
| POC-09 | Stop session | SDK stop/destroy called; UI returns to idle |
| POC-10 | Close app during session | Best-effort SDK teardown occurs |
| POC-11 | Inspect renderer bundle | No API key present |
| POC-12 | Inspect repo history | No `.env` or real key committed |
| POC-13 | Inspect telemetry config | `enableTelemetry: false` passed to SDK |

# Native device-recovery checks

Last updated: 2026-11-12

Two new cases qualify the existing recovery repair, without replaying its unit
suite or the previously accepted ordinary editor journeys:

- R01, desktop 1440 × 1000: a saved workspace with duplicate page IDs must stay
  byte-equivalent in native IndexedDB while new tab edits and an actual Markdown
  import remain unsaved. Export the real recovery JSON, dismiss the transient
  notice, retry the still-invalid read, then explicitly repair only the authored
  fixture. Retry must merge all tab pages with the retained valid page. Reload
  and compare IDs and exact title/Markdown content.
- R02, narrow 390 × 844 with touch emulation: an unreadable non-array database
  record must retain its exact original value. Recovery exports explicitly have
  `savedPages: null`; tab edits/imports are retained. Repeat the failed retry and
  explicit fixture repair, then verify the actual merged commit and reload.

Seed the initial page through native UI. Only the deliberate fault, inspection
and repair use native IndexedDB transactions in the fresh browser context;
these are fixture operations, not claimed user-facing repair controls. Keep an
unrelated localStorage sentinel. Every export is an actual browser download.
Capture blocked/recovered PNGs, original JSON/Markdown downloads, native saved
records and all actual local HTTP bodies. Refuse unexpected network traffic,
WebSockets, application errors, non-GETs and any cloud/Auth/MCP calls. Four PNGs
must be inspected before accepting visual evidence. Narrow emulation does not
establish physical touch, browser/device coverage or accessibility acceptance.

Use Node 24.22.2 and Playwright 1.61.1 in one task-owned public Ubuntu 24.04
job, maximum ten minutes. The checkout is pinned to the preparation commit;
the activation adds only its one-off workflow. The controller preserves complete
command streams, exact tracked-source hashes before/after, native server exit,
owned process-group absence and owned scratch removal. It caps commands at
420 seconds, scratch at 2 GiB and evidence at 16 MiB; admission requires 4 GiB
free and a 2 GiB reserve. Only tools/Chromium are installed; no app install/build,
provider, database service, paid service, model, production data or account.
HOME is retained. Original evidence is uploaded before the control disables
its own workflow and deletes only its exact activation ref. Preserve any failure;
do not retry unchanged. GitHub runner disposal/cache absence is not attested.

Storage Guard failed locally at 5.7 GiB free / 34 GiB required. Local syntax,
parsing, source review and whitespace checks are permitted; no local browser,
server, dependency installation or application execution is authorized below
the reserve. The source receipt and hosted delivery are separate from this
local-production-file browser boundary. Email/Auth/MCP acceptance stays pending.

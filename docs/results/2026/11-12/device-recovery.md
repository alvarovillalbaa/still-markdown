# Native recovery accepted; local static server repaired

12 November 2026. **R01 and R02 passed together** in
[run 43308242928](https://github.com/alvarovillalbaa/still-markdown/actions/runs/43308242928),
job 131497106679, checked source `552a08a2d3cdf83fc0d3420a15808fe2c5da7efb`,
activation `69426fcc7f1afb191688b1dadee2e60d890926ee`.

The actual browser/editor/storage modules are unchanged from the earlier
published app. `scripts/dev.mjs` now normalizes its public directory before
applying the existing containment check: its previous trailing separator made
normal files fail the `public//` prefix. Native HTTP returned exact icon/index
bytes and refused the encoded parent-directory request with 403. No production
configuration, dependency, schema, Auth, cloud or MCP implementation changed.

## Accepted behavior

| Case | Actual boundary and observations |
| --- | --- |
| R01 | Desktop 1440 × 1000. A duplicate-ID native IndexedDB record stays unchanged during new edits, an actual Markdown import and a failed recovery retry. Both downloaded JSON archives retain the malformed saved rows and two exact tab pages. Dismissing a notice leaves recovery controls available. |
| R02 | Narrow 390 × 844 with touch emulation. A non-array native IndexedDB record stays unchanged. Actual exports contain `savedPages: null` and both complete tab pages; failed retry preserves them. The tab-only notice is visible. |
| Both | Explicitly repairing only the disposable fixture lets the actual Retry control merge the original saved page and both tab pages under three distinct IDs. Actual reload retains those IDs, titles and exact Markdown. Real downloaded Markdown equals the imported CRLF bytes, including trailing spaces. An unrelated localStorage sentinel remains unchanged. |

The initial page was authored through UI; only fault injection, independent
inspection and repair use native IndexedDB transactions. These are test fixture
operations, not a new user-facing repair/import control. App/storage functions
were not replaced or invoked by the observer. No response fulfillment, raw
session, account or production data was used. All fifty real local HTTP bodies
are retained and hashed; static bodies independently match native source bytes.
No unexpected network request, WebSocket, page error or response failure occurred.

All four original PNGs were viewed: paused/recovered desktop and narrow states.
Recovery notices and both 44-pixel controls remain visible within the viewport;
document widths match 1440/390. Recovered pages render correctly. This does not
establish screen-reader, physical-device, Safari or broad visual acceptance.

## Preserved evidence and teardown

[Passing packet](device-recovery-attempt-4.zip): **408,643 bytes / 72 members**,
SHA-256 `31a492cc1540ed4540672e7534e36fad3da00c37350aaed0861a72b31535cf06`.
It contains all four PNGs, six real downloads, fifty response bodies, browser
observations, two 55-file source vectors, controller and complete original
command/server streams. The [full job log](device-recovery-attempt-4.log) retains
the independently checksummed lossless packet and six original retirement API
responses. [Independent review](device-recovery-independent-check.json) verifies
every tracked-source body/mode, source/index equivalence, all eight command
streams, all fifty response hashes/source comparisons, six download hashes and
recovery content/IDs. The native and remote source trees agree; their commit IDs
differ because publication used GitHub Git objects after local commits.

Node 24.22.2 / Playwright 1.61.1 on Ubuntu 24.04; four commands exited zero.
Duration **18.706 seconds**, owned tool bytes **731,659,651**. The browser and both
contexts acknowledged closure. The four registered command process groups and
server group were absent; server shutdown was intentional SIGTERM / exit -15.
Owned tools/scratch were removed, then artifact 13984991322 uploaded. The exact
activation ref was checked before workflow disable/readback, ref deletion and
absence readback; the proof directory was then removed. Fresh reads confirm
disabled workflow 416586458 and absent ref. Runner disposal, process groups not
registered by this controller and host-wide/cache absence are not attested.

The three preceding failures remain false, with no accepted case carried from
them: [workflow validation](device-recovery-attempt-1.md),
[readiness](device-recovery-attempt-2.md) and
[traversal observer](device-recovery-attempt-3.md). The original readiness status
was not retained; the later server source repair does not fill that evidence
gap. The first two actual CI jobs stopped before browser launch. All three
temporary workflow controls are disabled and their exact owned refs are absent.
The permanent verify workflow is unchanged; skipped normal CI is not a pass.

## Remaining boundaries

This closes the two focused local guest-recovery identities and native static
server repair. It does not prove hosted recovery, cloud account transitions,
email/signup/password delivery, authenticated MCP, cross-tab stale-write safety,
all corruption types, inaccessible/quota-limited storage, browser/device coverage
or complete Still/portfolio delivery. There is no new JSON recovery importer;
the exported archive remains for manual recovery. Existing unit/editor suites
were not replayed. Local Storage Guard failed at 5.7 GiB free / 34 GiB required:
only parsing/static checks ran locally. No paid plan, model call or new account.

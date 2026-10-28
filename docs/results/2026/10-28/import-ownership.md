# Keep import results in their workspace

28 October 2026. Status: source repair and 62 focused frontend checks passed;
publication readback is pending. Browser acceptance remains unverified. The
all-project goal is active.

Baseline: [6e9078ff8aea4e0962e788e8dedbfdd0e6608c6d](https://github.com/alvarovillalbaa/still-markdown/commit/6e9078ff8aea4e0962e788e8dedbfdd0e6608c6d).
An import checked workspace ownership after a successful file read, but a late
rejection could still publish an obsolete filename/error and clear a newer file
selection. An older overlapping batch could replace the newer batch's result.
The terminal limit warning also reread the original, potentially expired/live
file list after asynchronous work.

## Behavior

[The app](../../../../public/app.js) snapshots each original file list and its
length synchronously. The picker clears immediately after that snapshot, so
later import completion never resets another selection; drops do not reset the
picker. Empty selections do not take feedback ownership from a pending batch.

Owner and workspace-generation checks guard reads, failures, iteration and the
continuation after page creation. Changing account, returning to the original
account, or retrying the same workspace invalidates the old continuation. The
latest nonempty batch owns terminal feedback. Older accepted batches still add
their valid pages when the workspace remains the same.

The existing 50-file, 1 MiB, extension, strict UTF-8, NUL and 240-character title
limits remain. Exact Markdown source remains intact. Import counts acknowledge
page creation, not completion of background saves. If device saving has failed
or is paused for an unread workspace, terminal feedback retains its warning and
working **Export page** action alongside the count and file errors. A pending
save that fails later continues to report through the existing persistence path.
The persistent recovery panel and unread-owner write gate remain unchanged.

Only app source, its existing frontend VM test file, this receipt, README and the
nearest architecture reference changed. No storage format, cloud/Auth client,
editor/parser, API, SQL, dependency, configuration or workflow changed.

## Focused evidence

Node `v24.21.0` from the same repository shell ran:

```sh
node --test scripts/recovery.test.mjs
node --test scripts/storage.test.mjs scripts/markdown.test.mjs
npm run check
git diff --check
```

**62 cases passed, zero failures/skips/cancellations**: 41 recovery/import cases
plus 21 existing storage/Markdown cases. The complete actual app module executes
in the existing VM with controlled DOM/editor/cloud/storage/download boundaries;
production business logic is not copied. The registered picker and drop handlers
are exercised. The original 23 recovery test bodies remain byte-identical.

The identical final recovery test file against the immutable baseline app gives
**28 pass / 13 fail**, with zero skips/cancellations. All 23 original recovery
cases and five preserved import behaviors pass on that baseline. Failures expose
the repaired behavior, rather than missing new production helpers. Coverage
includes owner changes, same-owner retry, returning to an earlier owner, the
post-page-creation microtask, overlapping batches, live lists, empty selections,
encoding/limits, and both known storage-warning/export states. Independent
read-only source review found no remaining scoped blocker.

| Frozen artifact | SHA-256 |
| --- | --- |
| Baseline app | `0a8045874b9e88d33e2d079481e4055d5bb8f269d40a57c168413b70d58b9523` |
| Checked app | `4a34c2d4a3455fc125682283c64a1ec2ed2217e70bda263d453e959e34f45268` |
| Identical final recovery/import checks | `06d1e73c51263fa6d98b97b9f1b7533c61b7cabd4756f9df2cc9dc2183f9a677` |

## Publication and proof limits

The existing main-push workflow includes backend suites, live Auth/MCP and
Chromium, which remain outside this repair's approved checks. Publication uses
the same commit-specific `[skip actions]` boundary documented in the [previous
recovery receipt](../10-27/draft-recovery.md#publication-and-proof-limits).
No workflow/check is removed or relaxed, and no green hosted CI claim is made.
Git-linked Vercel source delivery is checked separately.

These are authored in-memory frontend checks and static validation. No browser,
native chooser/download, actual IndexedDB transaction, account transition,
backend, Auth/MCP or provider check ran. Hosted source bytes do not establish
those behaviors. Existing email/signup, account sync and authenticated MCP proof
remain open; this repair does not complete Still or the wider project goal.

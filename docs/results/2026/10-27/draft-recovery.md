# Preserve incomplete saved workspaces

27 October 2026. Status: source repair published, 44 focused frontend checks passed, and exact-source hosted delivery verified. Browser recovery acceptance remains unverified. The all-project goal is active.

Baseline: [2f0a83b0a0d5c96d35d2a5da66cddcbd397808ed](https://github.com/alvarovillalbaa/still-markdown/commit/2f0a83b0a0d5c96d35d2a5da66cddcbd397808ed). The [owning audit](source-audit.md) found that startup and owner transitions silently filtered saved rows and immediately persisted the subset over the original snapshot.

## Behavior

[The app](../../../../public/app.js) now validates the entire stored array before hydration: required strings, unique nonempty IDs, the existing 240-character title and 1 MiB Markdown limits, and dense array entries. Valid and empty workspaces keep their existing behavior. A rejected snapshot is not partially opened or automatically replaced. The existing unread-owner write gate protects its committed copy, while new tab pages remain in owner-scoped memory with a visible saving-paused state and unload warning.

A persistent [recovery panel](../../../../public/index.html) remains reachable when temporary notices change or close. Export prepares `still-recovery.json` with `format`, `version`, `savedPages` and `tabPages`; it never clears the write gate. When the original could not be read, `savedPages` is null and the UI explicitly says that only tab pages were copied. JSON-incompatible, cyclic or silently lossy values are rejected with a visible message while the saved copy remains untouched. The archive supports manual recovery, not automatic JSON restoration. The [responsive styles](../../../../public/styles.css) keep the recovery panel bounded and its buttons at least 44 pixels high; rendered desktop/mobile acceptance has not run.

Retry must reread a completely valid workspace before clearing its gate. It merges every in-tab page, including blank pages, and retains changed same-ID drafts under fresh IDs rather than dropping edits. Repeated failed reads retain both the saved snapshot and tab pages. Captured owner/generation checks prevent stale success/errors from publishing recovery state into another workspace. Guest-to-account copying refuses unread or partially valid guest snapshots and waits for explicit guest recovery, preserving device originals.

No device store/schema, migration, Auth/cloud client, server/API, editor/parser, dependency, configuration or workflow file changed. No live device data or account was read, repaired or deleted by these checks.

## Focused evidence

Node 24.21.0 ran **44 cases: 44 pass, zero failures/skips/cancellations**:

```sh
node --test scripts/recovery.test.mjs scripts/storage.test.mjs scripts/markdown.test.mjs
```

The new [23-case recovery file](../../../../scripts/recovery.test.mjs) executes the complete actual app module, including startup and registered actions, in a VM with controlled DOM/editor/cloud/storage/download boundaries. Imports alone are replaced by those boundaries; business logic is not copied. Existing storage tests contribute 12 cases and Markdown contributes nine. These are authored in-memory frontend checks, not a real DOM, IndexedDB/browser, cloud, backend or provider execution.

The identical final test file selected nine `^protects` regression cases against the immutable baseline app: **0 pass / 9 fail**, with no skipped/cancelled cases. Seven fail at automatic snapshot writes; the other two catch stale-owner recovery state and partial guest copying. Missing new recovery helpers or controls are not counted as baseline failures. All owned baseline copies were removed after terminal execution.

| Frozen artifact | SHA-256 |
| --- | --- |
| Baseline app | `33bdf53df24ec04de4a653b918b76fecce08ea1a2e90733cec2c150418daa7df` |
| Checked app | `0a8045874b9e88d33e2d079481e4055d5bb8f269d40a57c168413b70d58b9523` |
| Identical final recovery checks | `e3672e406ae65338b18650ac685e007a2fe9bd3c8e9acf6889e241b568be778a` |

Coverage includes mixed/all-invalid snapshots, duplicate/empty IDs, missing fields, sparse rows, UTF-8 bounds, valid/empty workspaces, guest/account transitions, stale errors and malformed results, failed/corrected retry, blank pages, same-ID edits, complete recovery/tab-only export, lossy/cyclic refusal, persistent controls, ordinary Markdown export and guest-copy refusal. Independent source review found no remaining scoped blocker. `npm run check` and `git diff --check` passed. All eight owned text files passed whitespace/newline checks, and 24 local Markdown file targets resolved. Protected subsystem/configuration/workflow paths compare unchanged against baseline.

## Publication and proof limits

The existing main-push workflow also runs backend suites, live Auth/MCP and Chromium. Those operations are outside this repair's approved checks. Source publication used GitHub's commit-specific `[skip actions]` annotation, which [suppresses push/PR workflow runs without changing the workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs). The source-SHA/event-filtered Actions API returned zero push runs after publication. No green CI claim is made and no workflow/check was removed or relaxed. Vercel source delivery was verified separately.

No browser, native file download, actual IndexedDB recovery or real account transition ran for this repair. Earlier guest/editor browser evidence retains its original scope. Email delivery/signup, account sync and authenticated MCP still require their existing proof. This repair does not complete Still or the wider project goal.

Source [3ba83a184c64e55bab8f482f1d8f8e781ca6261b](https://github.com/alvarovillalbaa/still-markdown/commit/3ba83a184c64e55bab8f482f1d8f8e781ca6261b) was pushed to personal-repository `main`. An immutable connected GitHub read of `public/app.js` returned blob `1d4ff2c49842867e0a0bec491c8f6168606a4cec`, equal to the local blob.

Production deployment `dpl_4o8Q5nrriZrVW4ND8GmPum3XXqRT` reached `READY` at that exact SHA and owns the canonical Still alias. Connected public GETs returned 200 for [the editor](https://still-markdown.vercel.app/) and its app module. The HTML contains all recovery controls; the served app script exactly equals the immutable published source. This proves source/hosted delivery, not rendered browser recovery or real storage behavior. A documentation-only follow-up preserves all checked runtime/test bytes.

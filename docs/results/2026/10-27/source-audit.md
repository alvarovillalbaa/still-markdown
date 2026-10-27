# Stored-draft recovery finding

Status: historical source finding, now covered by the [draft-recovery repair](draft-recovery.md). Originally inspected clean source `2777b1a0206cf596a48726b54039ea47b8de3c84` on 2026-10-27. The later receipt owns checks, publication status and remaining acceptance limits.

`AGENTS.md` requires preserving guest drafts and failed/conflicting edits without silent overwrites. `public/storage.js` accepts any array as a readable workspace. `validDocuments` in `public/app.js` then silently removes rows with invalid/missing fields, a title over 240 characters, or Markdown over the input limit.

Startup immediately persists that filtered result. Guest workspace transitions repeat the same pattern. A mixed valid/invalid IndexedDB snapshot can therefore be replaced by only its valid subset without an unread-owner/recovery gate. A malformed row can contain text worth recovering even though it cannot be safely opened as a normal page. An older legacy localStorage copy may or may not exist; it is not sufficient recovery proof for an overwritten IndexedDB snapshot.

The repair should validate completeness before normal hydration, preserve the original committed snapshot when any row is rejected, and expose a recovery/export path without allowing automatic saves to replace it. Cover both initial guest load and subsequent owner transitions, including mixed rows, duplicate identities and retry after correction. Reuse existing workspace ownership and persistence gates; no Auth/schema/dependency change is implied.

Evidence: [app validation/startup](../../../../public/app.js), [storage read/write contract](../../../../public/storage.js), [owner instructions](../../../../AGENTS.md). No tests, browser, storage operations, cloud requests, installs or source mutations ran for the original inspection. Subsequent source changes and focused checks are recorded in the repair receipt, separately from browser acceptance.

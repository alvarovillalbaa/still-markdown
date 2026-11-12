# Still

An in-house, continuous-document Markdown editor. Native HTML, CSS, JavaScript,
DOM Selection/Range, and Node APIs only; no editor or Markdown framework.

- `public/` owns the browser app, first-party parser/serializer, and editor.
- `api/` owns Vercel HTTP endpoints. `lib/` owns shared server code.
- `supabase/` owns the SQL contract, ownership policies, and scoped MCP tokens.
- Markdown text is the portable document source; there is no block data model.
- Preserve guest drafts and failed/conflicting cloud edits. Never silently overwrite.
- Never expose service-role keys. Auth uses Supabase publishable keys and RLS.
- Manual edits use apply_patch. Run git diff --check and focused syntax checks.
- Do not install dependencies or build locally while Storage Guard fails.
- Follow the user's verification gates: no backend suites or browser smoke checks
  without explicit authorization. Record any missing runtime proof honestly.

## Approved device-recovery qualification — 12 November 2026

The owner's standing "I approve everything / Keep going / Do all the work"
covers the two new Chromium cases in `docs/proposals/device-recovery-checks.md`
and one temporary public Ubuntu job capped at ten minutes. Use actual local
application files, native disposable IndexedDB fixtures and actual downloads;
do not substitute application/storage functions or fulfill responses. Preserve
failed evidence before changing a candidate. Existing unit/editor/Auth/MCP checks
remain closed; no account, provider request, app dependency or production change.
Local Storage Guard still prohibits local runtime below its reserve. Preserve
the permanent verify workflow; the new QA control must retire only itself and
its exact owned ref after uploading the bounded original evidence.

R01/R02 are now accepted together at source
`552a08a2d3cdf83fc0d3420a15808fe2c5da7efb`, run 43308242928; see
`docs/results/2026/11-12/device-recovery.md`. Keep these identities closed and
all three earlier failed packets immutable. The local-server containment fix
and actual static HTTP/traversal probes passed. All three one-off workflows
are disabled and their exact owned refs are absent; main retains only the
permanent workflow and an inactive example. No local Storage Guard exception
or cloud/Auth/email/MCP acceptance follows from this packet.

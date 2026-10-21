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

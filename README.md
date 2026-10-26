# Still

A quiet Markdown editor that opens onto a blank page. Write in one continuous
document, select text to format it, or switch to Markdown source. There is no
block data model and no external Markdown parser, editor framework, SDK, or
runtime dependency. HTML, CSS, JavaScript, native Selection/Range, and Node APIs
implement the app.

Live editor: [still-markdown.vercel.app](https://still-markdown.vercel.app).
Device editing has desktop and mobile browser evidence. New account signup and
password recovery remain gated until email delivery is verified. Existing
confirmed accounts can sign in; account-backed MCP still needs live verification.
See the [historical release receipt](docs/deployment-verification.json) and
[confirmed-email policy update](docs/results/2026-10-26-confirmed-email-policy.md).

## What you can do

- Write headings, paragraphs, lists, tasks, quotes, links, images, code, and tables.
- Format selected text with the floating toolbar and use keyboard shortcuts.
- Import UTF-8 `.md`, `.markdown`, or `.txt` files by choosing files or dropping them
  onto the page. Export pages as Markdown. Imports are limited to 50 files per
  batch and 1 MiB per page; titles are limited to 240 characters.
- Keep guest pages on the device, then sign up for private cloud pages. Copy
  guest pages into an account explicitly; the device originals remain available.
- Give external AI apps scoped access through MCP. See [connection instructions](docs/mcp.md).

Imported Markdown retains its exact source until the first edit in the rich
editor. Rich editing serializes the displayed document into the supported
Markdown subset and can normalize formatting. Use source mode to preserve and
edit unsupported extensions, such as footnotes or custom HTML. The renderer
escapes raw HTML.

## Run locally

Use Node.js 22 or newer. No package installation or build is needed.

```sh
npm run dev
```

Open `http://127.0.0.1:3210`. Set `PORT` to change the port.

The public project settings in [lib/project.js](lib/project.js) are the default.
Optional `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` environment variables
override them. Both are public client settings; the app never needs a service
role or secret key. To use a local environment file:

```sh
cp .env.example .env
# Edit .env with your project's public settings.
node --env-file=.env scripts/dev.mjs
```

`APP_ORIGIN` optionally permits one additional browser origin for MCP requests.
Without it, browser requests must match the endpoint's origin.

For another Supabase project, apply [supabase/schema.sql](supabase/schema.sql) to
that project, configure its auth site URL and allowed redirect URLs,
then set the public environment variables. Vercel serves `public/` and the two
HTTP functions using [vercel.json](vercel.json); install and build commands are
empty.

The owner-approved policy is confirmed email, superseding the earlier deferred
immediate-signup policy. Keep email confirmation enabled; do not enable
autoconfirm. The signup form checks the live confirmation policy and requires
`EMAIL_DELIVERY_VERIFIED=true`, set only after custom SMTP, allowed redirects and
real confirmation delivery are verified. A successful signup remains signed out
until the email is confirmed; guest pages stay on the device. Password-reset
handlers also require verified delivery and `PASSWORD_RECOVERY_ENABLED=true`.
Neither flag configures SMTP or proves delivery by itself.

Still and Kickoff share one email/password identity in the existing Still
Supabase project under the approved free-project consolidation. A password change
affects both apps; app sessions and app data stay separate. Still signs out only
its current session, leaving Kickoff signed in. Still owns its page/MCP SQL in
[supabase/schema.sql](supabase/schema.sql); Kickoff owns its sports SQL in
[its own repository](https://github.com/alvarovillalbaa/kickoff/blob/main/supabase/schema.sql).
Provider migration and authenticated cross-app checks require their own receipts;
these source changes do not establish that consolidation or delivery is complete.

## Persistence and connections

Device workspaces use IndexedDB, separated by guest/account owner. A bounded
localStorage fallback supports browsers without IndexedDB before migration;
storage failures are surfaced so the open draft can be exported. Clearing browser
data removes device-only pages. Signed-in saves use Supabase Auth and database
row level security. Version checks reject conflicting browser or MCP edits, and
the UI offers to preserve the local draft as a separate page.

MCP uses manually issued bearer tokens, with read access by default and optional
read/write access. Token digests are stored, tokens expire, and connections can
be revoked. OAuth and dynamic client registration are not implemented. Native
HTTP configuration and the included dependency-free stdio bridge are documented
in [docs/mcp.md](docs/mcp.md).

## Checks and evidence

```sh
npm run check
node --test scripts/*.test.mjs
git diff --check
```

The earlier release recorded 67 passing local tests; two real HTTP bridge tests skipped because
this sandbox cannot listen on a loopback socket. The bridge checks exercise real
subprocess stdio with a mocked HTTP boundary. Earlier hosted CI recorded all 69 tests passing,
including both native HTTP/stdio bridge cases. Those hosted browser checks verified
desktop/mobile writing, selection formatting, source preservation, CRLF imports/exports, reload
persistence, search, focus mode, safe rich rendering, and modal focus.
The [hosted run](https://github.com/alvarovillalbaa/still-markdown/actions/runs/39558387109)
remains failed at the intentionally visible cloud-readiness gate. Its original
immediate-signup expectation predates the confirmed-email policy. The browser
verifier now uses explicitly supplied `STILL_CONFIRMED_EMAIL` and
`STILL_CONFIRMED_PASSWORD` credentials for an authorized, already-confirmed fixture
account; provide them only through a private environment when running approved
checks. It creates a new synthetic page and records data cleanup IDs without
requesting account deletion. It does not prove signup or SMTP delivery. Never
disable confirmation to make a check pass. New confirmation delivery, account
sessions and authenticated MCP need fresh proof.
Separately, [the rollback-only database harness](scripts/verify-database.sql)
passed 26 assertion groups against the installed database: owner isolation,
role grants, token scopes/expiry/revocation, and sequential version conflicts.
It simulates transaction-local claims, leaves no fixture rows, and does not prove
signup, JWT validation, HTTP transport, or browser account sync. Run it only as a
database administrator in the Still project; it makes no schema changes.
See the [release receipt](docs/deployment-verification.json) and
[architecture and boundaries](docs/architecture.md).

# Still

A quiet Markdown editor that opens onto a blank page. Write in one continuous
document, select text to format it, or switch to Markdown source. There is no
block data model and no external Markdown parser, editor framework, SDK, or
runtime dependency. HTML, CSS, JavaScript, native Selection/Range, and Node APIs
implement the app.

Live editor: [still-markdown.vercel.app](https://still-markdown.vercel.app).
Device editing is verified on desktop and mobile. Cloud signup activation is
waiting for the Auth setting deferred by the owner; account-backed MCP remains
unverified. See the [release receipt](docs/deployment-verification.json).

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
that dedicated project, configure its auth site URL and allowed redirect URLs,
then set the public environment variables. Vercel serves `public/` and the two
HTTP functions using [vercel.json](vercel.json); install and build commands are
empty.

The chosen launch policy is immediate signup without email confirmation, approved
by the owner. That setting is still pending: the live Auth API currently reports
confirmation required. The owner deferred this configuration step. The signup
form checks live readiness and explains that cloud signup is waiting, while
device pages stay usable. Applying the approved setting does not verify email
ownership. Password-reset handlers remain hidden until custom SMTP, allowed
redirects, and real delivery have been verified and
`PASSWORD_RECOVERY_ENABLED=true` is set.

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

Local checks pass 67 tests; two real HTTP bridge tests explicitly skip because
this sandbox cannot listen on a loopback socket. The bridge checks exercise real
subprocess stdio with a mocked HTTP boundary. Hosted browser checks verified desktop/mobile writing,
selection formatting, source preservation, CRLF imports/exports, reload
persistence, search, focus mode, safe rich rendering, and modal focus.
The [hosted run](https://github.com/alvarovillalbaa/still-markdown/actions/runs/39556247922)
remains failed at the intentionally visible cloud-readiness gate. Live signup,
account sessions and authenticated MCP are pending the deferred Auth setup.
Separately, [the rollback-only database harness](scripts/verify-database.sql)
passed 26 assertion groups against the installed database: owner isolation,
role grants, token scopes/expiry/revocation, and sequential version conflicts.
It simulates transaction-local claims, leaves no fixture rows, and does not prove
signup, JWT validation, HTTP transport, or browser account sync. Run it only as a
database administrator in the dedicated Still project; it makes no schema changes.
See the
[release receipt](docs/deployment-verification.json) and
[architecture and boundaries](docs/architecture.md).

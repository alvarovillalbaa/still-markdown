# Architecture

Still stores a page as a title and a Markdown string. The rich editor is a native
`contenteditable` document; its HTML is a rendering of that string, not a block
database. There are no external editor/parser packages or runtime dependencies.

| Owner | Responsibility |
| --- | --- |
| `public/markdown.js` | First-party Markdown rendering, URL filtering, HTML escaping, and DOM serialization |
| `public/editor.js` | Selection/Range formatting, history, plain-text paste, composition input, and shortcuts |
| `public/app.js` | Page UI, imports/exports, workspace changes, draft preservation, and cloud save queues |
| `public/storage.js` | Per-owner durable device snapshots and legacy migration |
| `public/cloud.js` | Direct Supabase Auth/REST requests, sessions, document saves, and token management |
| `api/config.js`, `lib/project.js` | Public connection configuration and explicit email-delivery/recovery gates, with optional environment overrides |
| `api/mcp.js`, `lib/supabase.js` | Stateless MCP HTTP transport and database RPC calls |
| `supabase/schema.sql` | Page ownership, RLS, optimistic concurrency, and token-scoped database operations |
| `scripts/mcp-stdio.mjs` | First-party stdio-to-HTTP MCP bridge |

## Editing boundary

`MarkdownEditor` exposes `setMarkdown`, `getMarkdown`, `format`, `undo`, `redo`,
`focus`, and `destroy`. Change callbacks receive Markdown; selection callbacks
receive selected text and its viewport rectangle, or `null`. Both selection
endpoints must belong to the editor before formatting is applied. Toolbar
buttons preserve selection while receiving pointer input.

`setMarkdown` renders the page and retains the supplied string exactly.
`getMarkdown` returns that string until the DOM changes. A rich edit serializes
the DOM, so spacing and equivalent Markdown notation can normalize. Source mode
edits the string directly and is the preservation path for unsupported syntax.
The parser supports headings, paragraphs, nested lists and tasks, quotes, rules,
links, images, fenced/inline code, emphasis, strike, and single-line table cells.
It is a deliberate subset rather than a full CommonMark implementation.

Raw HTML is displayed as text. Link/image destinations pass protocol filtering;
images allow HTTP(S), and links additionally allow `mailto` and `tel`. Relative
destinations are allowed. Clipboard HTML is not inserted into the editable DOM.
Undo/redo history is in memory and resets when another page or source rendering
is loaded. Import size limits are enforced before file text becomes a page.

Imports snapshot the original file list during the picker/drop event, including
its length for the 50-file limit. The picker resets after that synchronous
snapshot, so an old import cannot clear a newer selection. Owner/workspace
generation checks fence both successful and failed reads and the continuation
after page creation. A newer batch takes ownership of terminal import feedback;
older batches can still finish adding valid pages in the same workspace. Import
counts acknowledge page creation, not completion of background device/cloud
saves. Known device-save failures and unread-workspace gates retain their export
warning/action alongside that feedback. See the [import receipt](results/2026/10-28/import-ownership.md).

## Device and cloud state

IndexedDB database `still-workspaces` stores committed workspace snapshots under
each guest/account owner. Saves clone their input immediately and serialize
transactions per owner. A transaction's completion, rather than request success,
acknowledges durability. Existing `still.pages.*` localStorage workspaces migrate
when loaded. A migration marker prevents an old localStorage copy from replacing
a newer IndexedDB workspace during database unavailability. Storage errors keep
the open work in memory and present an export action.

The app validates each complete stored page list before hydration, including
unique nonempty IDs, required text fields, title length and Markdown byte bounds.
It does not filter and resave a partial list. An incomplete read gates all device
writes for that owner; raw rows are held separately from editable tab drafts.
Persistent recovery controls export JSON-compatible saved rows and tab pages
without lifting the gate. Lossy or unserializable archive values fail visibly.
A complete retry merges tab drafts, preserves changed same-ID drafts under new
IDs, then resumes normal persistence. Owner/generation checks fence stale reads.
See [focused recovery evidence](results/2026/10-27/draft-recovery.md).

The app separates device persistence from cloud save queues. Saves carry the
document's expected version; the database creates with a null version or updates
only the matching owner, ID, and version. An update increments the version. Stale
writes fail instead of replacing remote changes. The conflict action first
preserves a separately identified draft, then attempts to reload the remote page.
Account/workspace generation checks prevent delayed results from applying to a
newly selected account.

Browser requests use a Supabase user JWT and publishable key. RLS limits page
reads/deletes and token management to the current user. Direct document
insert/update grants are absent; the `save_document` RPC derives ownership from
`auth.uid()`. Sessions refresh through the first-party client; browser storage
holds recoverable session credentials.

The owner-approved auth policy requires email confirmation, superseding the
earlier deferred immediate-signup policy. `/api/config` exposes
`emailDeliveryVerified` only when `EMAIL_DELIVERY_VERIFIED=true`. Public signup
requires that gate and live Auth health with email/signup enabled and confirmation
required. `CloudClient.signUp` rechecks those settings before sending the signup
request. A confirmation-pending response returns `{ session: null,
confirmationRequired: true }` without publishing a sign-in event or switching the
guest workspace. An unexpected immediate session is rejected rather than accepted
as cloud readiness. Existing confirmed accounts use the independent sign-in path.
Recovery controls additionally require `PASSWORD_RECOVERY_ENABLED=true`; both
flags remain off until custom SMTP, allowed redirects, and delivery are verified.

## Shared Still and Kickoff project

The approved consolidation target is the existing Still Supabase project selected
by `lib/project.js`. The shared `auth.users` identity means one email/password
works across Still and Kickoff, and a password change affects both apps. Browser
sessions remain app-specific: Still's session keys are prefixed with `still.auth.`,
and logout retains `scope=local` so it does not revoke a Kickoff session.

Sharing a project does not combine product ownership or grant cross-app access:

- This repository's `supabase/schema.sql` is canonical for `public.documents`,
  `public.mcp_tokens`, `still_private`, and the public `save_document` and
  `mcp_dispatch` RPCs. Still's owner-scoped RLS and MCP capability checks remain.
- [Kickoff's SQL](https://github.com/alvarovillalbaa/kickoff/blob/main/supabase/schema.sql)
  remains canonical for its sports data, policies and RPCs. Its application roles
  do not grant access to Still documents or connection tokens.
- Consolidation migrations must preserve both contracts. Auth settings, allowed
  redirects, email delivery and Auth-user deletion affect both apps and need
  coordinated owner review. App-specific schemas are not permission to reset
  the shared database or delete shared identities.

This policy/source update does not apply provider SQL or verify the migration.
Provider receipts and fresh authenticated checks must establish the deployed
state separately; no custom SMTP or delivery readiness is claimed here.

## MCP and hosting

MCP requests carry opaque bearer tokens. The server hashes the token and sends
its digest to a database RPC, which checks expiry, ownership, and read/write scope
within the operation's transaction. The private token digest is not exposed by
browser token-list grants. MCP initialization and discovery also require a valid
token. The transport uses stateless JSON responses over Streamable HTTP; OAuth
and dynamic registration are outside this implementation. See
[docs/mcp.md](mcp.md) for operations, protocol limits, and client configuration.

Vercel serves static browser files and runs `/api/config` and `/api/mcp` as Node
functions. Public fallback settings are in `lib/project.js`; environment values
can override them. Neither path uses a service-role key. `scripts/dev.mjs` serves
the same handlers and static files locally without a build.

Production is `https://still-markdown.vercel.app`. The
[release receipt](deployment-verification.json) records the exact deployed code
and proof boundaries. Desktop/mobile editing and imports/exports have hosted
browser evidence. The database migration and RLS/grants are installed; live
account isolation, confirmed-email signup, and authenticated external MCP need
fresh verification under the shared-project policy.
The rollback-only `scripts/verify-database.sql` harness passed 26 assertion groups
against the installed database. It switches to actual `authenticated` and `anon`
roles, sets transaction-local user claims, and checks RLS, owner isolation,
capability scope/expiry/revocation, and sequential version conflicts. All fixture
rows are rolled back. This proves database enforcement under those roles; it
does not validate signup, JWTs, Auth sessions, HTTP transport, or concurrent clients.
The database advisor flags the intentionally callable SECURITY DEFINER RPCs:
`save_document` derives its owner from `auth.uid()`, and `mcp_dispatch` validates
the opaque capability before every operation. Private helpers are not exposed.
The real two-account HTTP/browser verification suite remains pending new proof.
`scripts/browser-verify.mjs` now accepts an authorized confirmed fixture through
`STILL_CONFIRMED_EMAIL` and `STILL_CONFIRMED_PASSWORD`, creates a fresh test page,
and records `delete_user: false` with its cleanup IDs. It neither creates nor
confirms an account. Its evidence explicitly excludes signup and SMTP delivery;
use a real email-confirmation flow to establish those separately.

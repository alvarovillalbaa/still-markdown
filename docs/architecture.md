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
| `api/config.js`, `lib/project.js` | Public connection configuration, with optional environment overrides |
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

## Device and cloud state

IndexedDB database `still-workspaces` stores committed workspace snapshots under
each guest/account owner. Saves clone their input immediately and serialize
transactions per owner. A transaction's completion, rather than request success,
acknowledges durability. Existing `still.pages.*` localStorage workspaces migrate
when loaded. A migration marker prevents an old localStorage copy from replacing
a newer IndexedDB workspace during database unavailability. Storage errors keep
the open work in memory and present an export action.

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

The approved initial auth policy permits immediate signup without email
confirmation. Applying that setting was deferred by the user; the live project
still requires confirmation. The signup UI reads live health and displays a
setup state rather than promising an immediate account. Email ownership will be
unverified under the chosen initial policy. Recovery handlers stay hidden until
custom SMTP and an end-to-end delivery check are complete.

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
account isolation, signup, and authenticated external MCP still await Auth setup.
The rollback-only `scripts/verify-database.sql` harness passed 26 assertion groups
against the installed database. It switches to actual `authenticated` and `anon`
roles, sets transaction-local user claims, and checks RLS, owner isolation,
capability scope/expiry/revocation, and sequential version conflicts. All fixture
rows are rolled back. This proves database enforcement under those roles; it
does not validate signup, JWTs, Auth sessions, HTTP transport, or concurrent clients.
The database advisor flags the intentionally callable SECURITY DEFINER RPCs:
`save_document` derives its owner from `auth.uid()`, and `mcp_dispatch` validates
the opaque capability before every operation. Private helpers are not exposed.
The real two-account HTTP/browser verification suite remains pending Auth setup.

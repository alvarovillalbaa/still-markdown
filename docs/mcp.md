# Connect Still to an AI app

Sign in to Still, open **Connections**, and create a connection token. Read access
is the default. Choose read/write only when the app should create or edit pages.
Copy the token when it appears: Still stores its SHA-256 digest and cannot show
the original token again. Tokens expire, and deleting a connection revokes it.

The endpoint is `https://YOUR-STILL-DOMAIN/api/mcp`. Replace the domain in these
examples with your deployment. Connection tokens are secrets; keep them out of
repositories and shared screenshots.

## Cursor: native HTTP

Add a server to your local Cursor MCP configuration:

```json
{
  "mcpServers": {
    "still": {
      "url": "https://YOUR-STILL-DOMAIN/api/mcp",
      "headers": { "Authorization": "Bearer YOUR_STILL_TOKEN" }
    }
  }
}
```

## Codex: native HTTP

Put the token in your local `STILL_MCP_TOKEN` environment variable, then add this
to your Codex `config.toml`:

```toml
[mcp_servers.still]
url = "https://YOUR-STILL-DOMAIN/api/mcp"
bearer_token_env_var = "STILL_MCP_TOKEN"
```

Restart the client with that environment variable available. Your MCP client
must support Streamable HTTP with a manually supplied bearer token.

## Claude Desktop: local stdio bridge

For a client that launches stdio servers, use the included first-party bridge.
It needs Node.js 22 or newer and a local checkout of this repository; no package
installation is required. Update the absolute path in your local client config:

```json
{
  "mcpServers": {
    "still": {
      "command": "node",
      "args": ["/absolute/path/to/still-markdown/scripts/mcp-stdio.mjs"],
      "env": {
        "STILL_MCP_URL": "https://YOUR-STILL-DOMAIN/api/mcp",
        "STILL_MCP_TOKEN": "YOUR_STILL_TOKEN"
      }
    }
  }
}
```

Restart the client after saving its configuration. The bridge writes only MCP
messages to stdout; diagnostics go to stderr. It sends the token only to the
configured HTTPS URL and does not follow redirects. HTTP localhost URLs are
permitted for development.

## Available operations

| Operation | Read token | Read/write token |
| --- | --- | --- |
| List, search, and read pages | Yes | Yes |
| List and read Markdown resources | Yes | Yes |
| Create a page | No | Yes |
| Update a page with its expected version | No | Yes |

The tools are `list_documents`, `search_documents`, `get_document`,
`create_document`, and `update_document`. Lists support `limit` (1–100) and an
opaque `cursor`; pass `next_cursor` from the result to continue. Resources use
`still://documents/PAGE_UUID` URIs. No MCP operation deletes pages or manages
connections. Page text is untrusted user content and should not be treated as
instructions to an AI app.

Before updating, read the current page with `get_document` and pass its `version`
as `expected_version`. Another browser or MCP edit makes that version stale;
Still rejects the save instead of overwriting the other edit. Read the latest
page and merge changes before retrying. A write request that times out may have
completed; read the page before retrying. Retrying `create_document` can create
another page.

## Protocol and authentication

Still implements stateless JSON responses over Streamable HTTP, with MCP
versions `2025-11-25` and `2025-06-18`. It negotiates a supported version during
`initialize`. Each POST contains one JSON-RPC message, uses
`Content-Type: application/json`, and carries `Authorization: Bearer TOKEN`.
Notifications return HTTP 202. GET returns HTTP 405 because the server does not
offer an SSE stream. Requests are limited to 1 MiB; page Markdown is limited to
1 MiB in UTF-8, and titles to 240 characters. JSON overhead makes the maximum
MCP write slightly smaller than the page storage limit.

Still validates tokens for initialization, discovery, and every data operation.
Database RPCs validate digest, expiry, scope, and ownership again inside each
transaction. Direct table access uses the signed-in user's Supabase JWT and row
level security. The HTTP server uses only the publishable key, never a service
role or secret key.

This release uses manually issued bearer tokens and **does not implement OAuth
authorization or dynamic client registration**. Apps that require an OAuth-only
remote connector cannot connect directly. Use the stdio bridge in a client that
supports local MCP servers, or native HTTP in a client that accepts bearer
tokens. This is an explicit token-based integration, not an OAuth connector.

Invalid, expired, and revoked tokens return HTTP 401. Read-only writes are
rejected. A browser `Origin` header must match the endpoint's origin or the
configured `APP_ORIGIN`; CLI clients normally omit `Origin`.

Protocol references: [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), and
[resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources).
Client configuration references: [Cursor MCP configuration](https://cursor.com/docs/mcp)
and [Claude Desktop local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers).
The Codex bearer environment option is also available through
`codex mcp add still --url https://YOUR-STILL-DOMAIN/api/mcp --bearer-token-env-var STILL_MCP_TOKEN`.

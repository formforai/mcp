# FormFor MCP Server

Remote MCP (Model Context Protocol) server for FormFor. Runs on Cloudflare Workers as a `McpAgent` Durable Object with SSE transport. Lets any MCP-compatible AI client create forms, collect data, and check responses.

## Quick Start

Connect any MCP client to:

```
https://mcp.formfor.ai/sse
```

With header:

```
Authorization: Bearer ff_live_...
```

## Tools

| Tool | Description |
|------|-------------|
| `formfor_ask` | Ask a human a yes/no question. Sends an email, returns `{ approved: true/false }`. |
| `formfor_collect` | Collect structured data via a multi-field form. Supports 14 field types. |
| `formfor_check` | Check if a form has been completed and retrieve the response data. |
| `formfor_list` | List recent forms with optional status filter. |

### formfor_ask

```json
{
  "question": "Deploy to production?",
  "to": "ops@company.com",
  "context": "All tests passing on staging",
  "expires": "4h"
}
```

### formfor_collect

```json
{
  "title": "Bug Report Triage",
  "to": "eng@company.com",
  "fields": [
    { "id": "severity", "type": "select", "label": "Severity", "options": ["P0", "P1", "P2"] },
    { "id": "description", "type": "textarea", "label": "Description", "required": true }
  ],
  "expires": "24h"
}
```

### formfor_check

```json
{
  "form_id": "form_abc123"
}
```

### formfor_list

```json
{
  "status": "pending",
  "limit": 10
}
```

## Architecture

```
MCP Client --> SSE (/sse) --> FormForMCP (McpAgent Durable Object)
                                    |
                                    +-- API (service binding) -- form CRUD
                                    +-- Agents (service binding) -- agent state
                                    +-- D1 -- API key auth
```

### Auth Flow

1. MCP client connects to `/sse` with `Authorization: Bearer ff_live_...`
2. Worker authenticates the API key against D1 (SHA-256 hash lookup)
3. Auth header is captured in `onConnect` and forwarded to API service binding on every tool call

### Transport

SSE (Server-Sent Events) via the Agents SDK `McpAgent.serveSSE()`. CORS is configured for cross-origin access.

## Development

```bash
npm install
npm run dev
```

## Deployment

```bash
npm run deploy
```

## Environment Variables

### Bindings

| Binding | Type | Description |
|---------|------|-------------|
| `MCP_AGENT` | Durable Object | FormForMCP class |
| `DB` | D1 | API key authentication |
| `API` | Service | formfor-api worker |
| `AGENTS` | Service | formfor-agents worker |

## License

MIT

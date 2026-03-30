# @gdpa/openviking-memory-mcp

MCP server for OpenViking long-term memory and resource retrieval with recall, store, and forget operations.

## Installation

```bash
npm install @gdpa/openviking-memory-mcp
```

## Usage

Run as an MCP server via stdio transport:

```bash
npx @gdpa/openviking-memory-mcp --base-url <OPENVIKING_URL> --api-key <API_KEY> --agent-id <AGENT_ID> [--resource-uri <VIKING_RESOURCE_URI>] [--tools <ACTION_LIST>]
```

### Cursor MCP Configuration

Add to your `mcp.json`:

```json
{
  "mcpServers": {
    "openviking-memory": {
      "command": "npx",
      "args": [
        "--registry",
        "https://bnpm.byted.org",
        "@gdpa/openviking-memory-mcp",
        "--base-url", "https://gdpa.bytedance.net/openviking-public",
        "--api-key", "<YOUR_API_KEY>",
        "--agent-id", "<YOUR_AGENT_ID>",
        "--resource_uri", "viking://resources/your/project/subpath",
        "--tools", "recall"
      ]
    }
  }
}
```

### CLI Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `--base-url` | Yes | OpenViking API base URL |
| `--api-key` | Yes | API key for authentication |
| `--agent-id` | Yes | Agent identifier |
| `--resource-uri`, `--resource_uri` | No | Default resource search scope. When set, recall only searches resources under this URI prefix while still searching memories normally. If a tool call explicitly passes a resource `targetUri`, it must stay inside this configured scope. |
| `--tools` | No | Comma-separated action allowlist. Supported values: `recall`, `store`, `forget`. Default is all actions. Example: `--tools recall` or `--tools recall,store`. |

## MCP Tool: `memory`

This server exposes a single `memory` tool. The available actions are controlled by `--tools`.

Example:

```json
"--tools", "recall"
```

With this configuration, the MCP tool only allows `action: "recall"`.

### `recall` — Semantic search over stored memories and resources

- `query` (string, required): Search query
- `limit` (number, optional): Max results (default 10)
- `scoreThreshold` (number, optional): Minimum relevance score
- `targetUri` (string, optional): Narrow search to a specific memory or resource URI. If `resource_uri` is configured, any resource `targetUri` must be within that prefix.

### `store` — Store new information as memory

- `text` (string, required): Content to store
- `role` (string, optional): Message role
- `sessionId` (string, optional): Session identifier

### `forget` — Delete stored memories

- `uri` (string, optional): Specific URI to delete
- `query` (string, optional): Query-based deletion
- `scoreThreshold` (number, optional): Score threshold for query-based deletion

## Requirements

- Node.js >= 18.0.0

# @gdpa/openviking-memory-mcp

MCP server for OpenViking long-term memory and filesystem operations with recall, store, forget, fs/ls, fs/read, and fs/grep actions.

## Installation

```bash
npm install @gdpa/openviking-memory-mcp
```

## Usage

Run as an MCP server via stdio transport:

```bash
npx @gdpa/openviking-memory-mcp --base-url <OPENVIKING_URL> --api-key <API_KEY> --agent-id <AGENT_ID>
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
        "--agent-id", "<YOUR_AGENT_ID>"
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

## Optional Arguments

These parameters are supported, but they are not part of the default example configuration:

| Argument | Description |
|----------|-------------|
| `--resource-uri`, `--resource_uri` | Default resource search scope. When set, recall only searches resources under this URI prefix while still searching memories normally. If a tool call explicitly passes a resource `targetUri`, it must stay inside this configured scope. |
| `--tools` | Comma-separated action allowlist. Supported values: `recall`, `store`, `forget`, `fs/ls`, `fs/read`, `fs/grep`. Default is all actions. Example: `--tools recall` or `--tools recall,store,fs/read`. |

## MCP Tool: `memory`

### `recall` — Semantic search over stored memories and resources

- `query` (string, required): Search query
- `limit` (number, optional): Max results (default 10)
- `scoreThreshold` (number, optional): Minimum relevance score
- `targetUri` (string, optional): Narrow search to a specific memory or resource URI. If `resource_uri` is configured, any resource `targetUri` must be within that prefix.
- Result format: each recall line includes both `context_type` and `is_leaf` marker.

### `store` — Store new information as memory

- `text` (string, required): Content to store
- `role` (string, optional): Message role
- `sessionId` (string, optional): Session identifier

### `forget` — Delete stored memories

- `uri` (string, optional): Specific URI to delete
- `query` (string, optional): Query-based deletion
- `scoreThreshold` (number, optional): Score threshold for query-based deletion

### `fs/ls` — List directory contents

- `uri` (string, required): Target Viking URI (used to locate readable `is_leaf=true` nodes)
- `recursive` (boolean, optional): Recursively list descendants
- `simple` (boolean, optional): Return simpler relative path output

### `fs/read` — Read full content

- `uri` (string, required): Target Viking URI for an `is_leaf=true` node only

### `fs/grep` — Pattern search in content

- `uri` (string, required): Target Viking URI scope
- `pattern` (string, required): Regex search pattern
- `caseInsensitive` (boolean, optional): Ignore case (alias: `case_insensitive`)

## Requirements

- Node.js >= 18.0.0

#!/usr/bin/env node

import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base-url" && i + 1 < argv.length) {
      args.baseUrl = argv[++i];
    } else if (arg === "--api-key" && i + 1 < argv.length) {
      args.apiKey = argv[++i];
    } else if (arg === "--agent-id" && i + 1 < argv.length) {
      args.agentId = argv[++i];
    } else if (
      (arg === "--resource-uri" || arg === "--resource_uri") &&
      i + 1 < argv.length
    ) {
      args.resourceUri = argv[++i];
    } else if (arg === "--tools" && i + 1 < argv.length) {
      args.tools = argv[++i];
    }
  }
  if (!args.baseUrl) {
    console.error("Missing required argument: --base-url <url>");
    process.exit(1);
  }
  if (!args.apiKey) {
    console.error("Missing required argument: --api-key <key>");
    process.exit(1);
  }
  if (!args.agentId) {
    console.error("Missing required argument: --agent-id <id>");
    process.exit(1);
  }
  args.enabledActions = parseEnabledActions(args.tools);
  args.resourceUri = parseConfiguredResourceUri(args.resourceUri);
  return args;
}

const config = parseArgs(process.argv);

// ---------------------------------------------------------------------------
// OpenViking HTTP client
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 15_000;

const MEMORY_URI_PATTERNS = [
  /^viking:\/\/user\/(?:[^/]+\/)?memories(?:\/|$)/,
  /^viking:\/\/agent\/(?:[^/]+\/)?memories(?:\/|$)/,
];

const USER_STRUCTURE_DIRS = new Set(["memories"]);
const AGENT_STRUCTURE_DIRS = new Set([
  "memories",
  "skills",
  "instructions",
  "workspaces",
]);

const ALL_ACTIONS = ["recall", "store", "forget"];

function md5Short(input) {
  return createHash("md5").update(input).digest("hex").slice(0, 12);
}

function isMemoryUri(uri) {
  return MEMORY_URI_PATTERNS.some((pattern) => pattern.test(uri));
}

function clampScore(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeOptionalUri(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseEnabledActions(value) {
  const normalized = normalizeOptionalUri(value);
  if (!normalized) return [...ALL_ACTIONS];

  const actions = normalized
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const invalid = actions.filter((action) => !ALL_ACTIONS.includes(action));
  if (invalid.length > 0) {
    console.error(
      `Invalid --tools value: ${invalid.join(", ")}. Allowed values: ${ALL_ACTIONS.join(", ")}`
    );
    process.exit(1);
  }

  const unique = [...new Set(actions)];
  if (unique.length === 0) {
    console.error(
      `Invalid --tools value: empty list. Allowed values: ${ALL_ACTIONS.join(", ")}`
    );
    process.exit(1);
  }
  return unique;
}

function normalizeUriPrefix(uri) {
  const normalized = normalizeOptionalUri(uri);
  if (!normalized) return undefined;
  return normalized.replace(/\/+$/, "");
}

function isResourceUri(uri) {
  return /^viking:\/\/resources(?:\/|$)/.test(uri);
}

function parseConfiguredResourceUri(value) {
  const normalized = normalizeUriPrefix(value);
  if (!normalized) return undefined;
  if (!isResourceUri(normalized)) {
    console.error(
      `Invalid --resource-uri value: ${normalized}. Expected a viking://resources URI prefix.`
    );
    process.exit(1);
  }
  return normalized;
}

function isUriWithinScope(uri, scope) {
  const normalizedUri = normalizeUriPrefix(uri);
  const normalizedScope = normalizeUriPrefix(scope);
  if (!normalizedUri || !normalizedScope) return false;
  return (
    normalizedUri === normalizedScope ||
    normalizedUri.startsWith(`${normalizedScope}/`)
  );
}

class OpenVikingClient {
  constructor(baseUrl, apiKey, agentId, resourceUri) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.agentId = agentId;
    this.resourceUri = normalizeUriPrefix(resourceUri);
    this.resolvedSpaceByScope = {};
    this.runtimeIdentity = null;
  }

  async request(path, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const headers = new Headers(init.headers ?? {});
      if (this.apiKey) headers.set("X-API-Key", this.apiKey);
      if (this.agentId) headers.set("X-OpenViking-Agent", this.agentId);
      if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }

      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok || payload.status === "error") {
        const code = payload.error?.code ? ` [${payload.error.code}]` : "";
        const message = payload.error?.message ?? `HTTP ${response.status}`;
        throw new Error(`OpenViking request failed${code}: ${message}`);
      }

      return payload.result ?? payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async ls(uri) {
    return this.request(
      `/api/v1/fs/ls?uri=${encodeURIComponent(uri)}&output=original`
    );
  }

  async getRuntimeIdentity() {
    if (this.runtimeIdentity) return this.runtimeIdentity;
    const fallback = {
      userId: "default",
      agentId: this.agentId || "default",
    };
    try {
      const status = await this.request("/api/v1/system/status");
      const userId =
        typeof status.user === "string" && status.user.trim()
          ? status.user.trim()
          : "default";
      this.runtimeIdentity = { userId, agentId: this.agentId || "default" };
      return this.runtimeIdentity;
    } catch {
      this.runtimeIdentity = fallback;
      return fallback;
    }
  }

  async resolveScopeSpace(scope) {
    const cached = this.resolvedSpaceByScope[scope];
    if (cached) return cached;

    const identity = await this.getRuntimeIdentity();
    const fallbackSpace =
      scope === "user"
        ? identity.userId
        : md5Short(`${identity.userId}:${identity.agentId}`);
    const reservedDirs =
      scope === "user" ? USER_STRUCTURE_DIRS : AGENT_STRUCTURE_DIRS;
    const preferredSpace =
      scope === "user"
        ? identity.userId
        : md5Short(`${identity.userId}:${identity.agentId}`);

    try {
      const entries = await this.ls(`viking://${scope}`);
      const spaces = entries
        .filter((entry) => entry?.isDir === true)
        .map((entry) =>
          typeof entry.name === "string" ? entry.name.trim() : ""
        )
        .filter(
          (name) => name && !name.startsWith(".") && !reservedDirs.has(name)
        );

      if (spaces.length > 0) {
        if (spaces.includes(preferredSpace)) {
          this.resolvedSpaceByScope[scope] = preferredSpace;
          return preferredSpace;
        }
        if (scope === "user" && spaces.includes("default")) {
          this.resolvedSpaceByScope[scope] = "default";
          return "default";
        }
        if (spaces.length === 1) {
          this.resolvedSpaceByScope[scope] = spaces[0];
          return spaces[0];
        }
      }
    } catch {
      // Fall back to identity-derived space when listing fails
    }

    this.resolvedSpaceByScope[scope] = fallbackSpace;
    return fallbackSpace;
  }

  async normalizeTargetUri(targetUri) {
    if (typeof targetUri !== "string" || !targetUri.trim()) return undefined;
    const trimmed = normalizeUriPrefix(targetUri);
    const match = trimmed.match(/^viking:\/\/(user|agent)(?:\/(.*))?$/);
    if (!match) return trimmed;

    const scope = match[1];
    const rawRest = (match[2] ?? "").trim();
    if (!rawRest) return trimmed;

    const parts = rawRest.split("/").filter(Boolean);
    if (parts.length === 0) return trimmed;

    const reservedDirs =
      scope === "user" ? USER_STRUCTURE_DIRS : AGENT_STRUCTURE_DIRS;
    if (!reservedDirs.has(parts[0])) return trimmed;

    const space = await this.resolveScopeSpace(scope);
    return `viking://${scope}/${space}/${parts.join("/")}`;
  }

  async find(query, options) {
    const normalizedTargetUri = await this.normalizeTargetUri(options.targetUri);
    if (
      normalizedTargetUri &&
      isResourceUri(normalizedTargetUri) &&
      this.resourceUri &&
      !isUriWithinScope(normalizedTargetUri, this.resourceUri)
    ) {
      throw new Error(
        `Resource targetUri is outside configured resource scope: ${normalizedTargetUri}. Allowed scope: ${this.resourceUri}`
      );
    }
    const body = {
      query,
      limit: options.limit,
      score_threshold: options.scoreThreshold,
    };
    if (normalizedTargetUri) {
      body.target_uri = normalizedTargetUri;
    }
    return this.request("/api/v1/search/find", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  getDefaultResourceTargetUri() {
    return this.resourceUri || "viking://resources";
  }

  async createSession() {
    const result = await this.request("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({}),
    });
    return result.session_id;
  }

  async addSessionMessage(sessionId, role, content) {
    await this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ role, content }),
      }
    );
  }

  async getSession(sessionId) {
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      { method: "GET" }
    );
  }

  async extractSessionMemories(sessionId) {
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/extract`,
      { method: "POST", body: JSON.stringify({}) }
    );
  }

  async deleteSession(sessionId) {
    await this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" }
    );
  }

  async deleteUri(uri) {
    await this.request(
      `/api/v1/fs?uri=${encodeURIComponent(uri)}&recursive=false`,
      { method: "DELETE" }
    );
  }
}

// ---------------------------------------------------------------------------
// Memory helpers (from reference memory-ranking.ts)
// ---------------------------------------------------------------------------

function postProcessMemories(items, options) {
  const deduped = [];
  const seen = new Set();
  const sorted = [...items].sort(
    (a, b) => clampScore(b.score) - clampScore(a.score)
  );
  for (const item of sorted) {
    if (options.leafOnly && !isLeafMemory(item)) continue;
    if (clampScore(item.score) < options.scoreThreshold) continue;
    const key = getMemoryDedupeKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= options.limit) break;
  }
  return deduped;
}

function getMemoryDedupeKey(item) {
  const abstract = (item.abstract ?? item.overview ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const category = (item.category ?? "").toLowerCase() || "unknown";
  const uri = item.uri.toLowerCase();
  const isEventOrCase =
    category === "events" ||
    category === "cases" ||
    uri.includes("/events/") ||
    uri.includes("/cases/");
  if (abstract && !isEventOrCase) {
    return `abstract:${category}:${abstract}`;
  }
  return `uri:${item.uri}`;
}

function getContextType(item) {
  if (typeof item.context_type === "string" && item.context_type.trim()) {
    return item.context_type.trim();
  }
  if (isMemoryUri(item.uri)) return "memory";
  if (item.uri.startsWith("viking://resources")) return "resource";
  if (item.uri.startsWith("viking://skills")) return "skill";
  return "context";
}

function isLeafMemory(item) {
  if (typeof item.is_leaf === "boolean") return item.is_leaf;
  if (typeof item.isLeaf === "boolean") return item.isLeaf;
  if (typeof item.level === "number") return item.level === 2;
  return false;
}

function getContextDedupeKey(item) {
  if (getContextType(item) === "memory") {
    return getMemoryDedupeKey(item);
  }
  return `uri:${item.uri}`;
}

function postProcessContexts(items, options) {
  const deduped = [];
  const seen = new Set();
  const sorted = [...items].sort(
    (a, b) => clampScore(b.score) - clampScore(a.score)
  );
  for (const item of sorted) {
    if (options.leafOnlyMemories && getContextType(item) === "memory") {
      if (!isLeafMemory(item)) continue;
    }
    if (clampScore(item.score) < options.scoreThreshold) continue;
    const key = getContextDedupeKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= options.limit) break;
  }
  return deduped;
}

function formatMemoryLines(items) {
  return items
    .map((item, index) => {
      const score = clampScore(item.score);
      const abstract =
        item.abstract?.trim() || item.overview?.trim() || item.uri;
      const category = item.category ?? "memory";
      return `${index + 1}. [${category}] ${abstract} (${(score * 100).toFixed(0)}%)`;
    })
    .join("\n");
}

function formatContextLines(items) {
  return items
    .map((item, index) => {
      const score = clampScore(item.score);
      const contextType = getContextType(item);
      const summary =
        item.abstract?.trim() ||
        item.overview?.trim() ||
        item.match_reason?.trim() ||
        item.uri;
      return `${index + 1}. [${contextType}] ${summary} (${(
        score * 100
      ).toFixed(0)}%)\n   ${item.uri}`;
    })
    .join("\n");
}

function summarizeContextCounts(items) {
  const counts = {
    memories: 0,
    resources: 0,
    skills: 0,
    other: 0,
  };
  for (const item of items) {
    const contextType = getContextType(item);
    if (contextType === "memory") counts.memories += 1;
    else if (contextType === "resource") counts.resources += 1;
    else if (contextType === "skill") counts.skills += 1;
    else counts.other += 1;
  }
  return counts;
}

function mergeFindResults(results) {
  const merged = {
    memories: [],
    resources: [],
    skills: [],
    total: 0,
  };
  for (const result of results) {
    merged.memories.push(...(result.memories ?? []));
    merged.resources.push(...(result.resources ?? []));
    merged.skills.push(...(result.skills ?? []));
  }
  merged.total =
    merged.memories.length + merged.resources.length + merged.skills.length;
  return merged;
}

function formatSettledSearchError(scopeLabel, reason) {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : String(reason);
  return `${scopeLabel}: ${message}`;
}

// ---------------------------------------------------------------------------
// Tool action handlers
// ---------------------------------------------------------------------------

const DEFAULT_RECALL_LIMIT = 10;
const DEFAULT_SCORE_THRESHOLD = 0.01;
const DEFAULT_TARGET_URI = "viking://user/memories";

async function handleRecall(client, params) {
  const query = params.query;
  const limit =
    typeof params.limit === "number"
      ? Math.max(1, Math.floor(params.limit))
      : DEFAULT_RECALL_LIMIT;
  const scoreThreshold =
    typeof params.scoreThreshold === "number"
      ? Math.max(0, Math.min(1, params.scoreThreshold))
      : DEFAULT_SCORE_THRESHOLD;
  const targetUri =
    typeof params.targetUri === "string" ? params.targetUri : undefined;
  const requestLimit = Math.max(limit * 4, 20);

  let result;
  if (targetUri) {
    result = await client.find(query, {
      targetUri,
      limit: requestLimit,
      scoreThreshold: 0,
    });
  } else {
    const recallScopes = [
      {
        label: "user memories",
        promise: client.find(query, {
          targetUri: "viking://user/memories",
          limit: requestLimit,
          scoreThreshold: 0,
        }),
      },
      {
        label: "agent memories",
        promise: client.find(query, {
          targetUri: "viking://agent/memories",
          limit: requestLimit,
          scoreThreshold: 0,
        }),
      },
      {
        label: "resources",
        promise: client.find(query, {
          targetUri: client.getDefaultResourceTargetUri(),
          limit: requestLimit,
          scoreThreshold: 0,
        }),
      },
    ];
    const settled = await Promise.allSettled(
      recallScopes.map((scope) => scope.promise)
    );
    const successes = [];
    const failures = [];
    for (const [index, entry] of settled.entries()) {
      if (entry.status === "fulfilled") {
        successes.push(entry.value);
      } else {
        failures.push(
          formatSettledSearchError(recallScopes[index].label, entry.reason)
        );
      }
    }
    if (successes.length === 0) {
      throw new Error(
        `Recall failed for all scopes. ${failures.join(" | ")}`
      );
    }
    result = mergeFindResults(successes);
    if (failures.length > 0 && result.total === 0) {
      throw new Error(
        `Recall returned no results and some scopes failed. ${failures.join(" | ")}`
      );
    }
    result.partialFailures = failures;
  }

  const contexts = postProcessContexts(
    [
      ...(result.memories ?? []),
      ...(result.resources ?? []),
      ...(result.skills ?? []),
    ],
    {
      limit,
      scoreThreshold,
      leafOnlyMemories: !targetUri,
    }
  );
  const partialFailures = Array.isArray(result.partialFailures)
    ? result.partialFailures
    : [];
  if (contexts.length === 0) {
    if (partialFailures.length > 0) {
      throw new Error(
        `Recall produced no usable results and some scopes failed. ${partialFailures.join(" | ")}`
      );
    }
    return {
      content: [{ type: "text", text: "No relevant results found." }],
    };
  }
  const counts = summarizeContextCounts(contexts);
  const countParts = [];
  if (counts.memories > 0) countParts.push(`${counts.memories} memories`);
  if (counts.resources > 0) countParts.push(`${counts.resources} resources`);
  if (counts.skills > 0) countParts.push(`${counts.skills} skills`);
  if (counts.other > 0) countParts.push(`${counts.other} other`);
  const partialFailureNote =
    partialFailures.length > 0
      ? `\n\nPartial results only. Failed scopes: ${partialFailures.join(" | ")}`
      : "";
  return {
    content: [
      {
        type: "text",
        text: `Found ${contexts.length} results${
          countParts.length > 0 ? ` (${countParts.join(", ")})` : ""
        }:\n\n${formatContextLines(contexts)}${partialFailureNote}`,
      },
    ],
  };
}

async function handleStore(client, params) {
  const text = params.text;
  const role = typeof params.role === "string" ? params.role : "user";
  const sessionIdIn =
    typeof params.sessionId === "string" ? params.sessionId : undefined;

  let sessionId = sessionIdIn;
  let createdTempSession = false;
  try {
    if (!sessionId) {
      sessionId = await client.createSession();
      createdTempSession = true;
    }
    await client.addSessionMessage(sessionId, role, text);
    await client.getSession(sessionId).catch(() => ({}));
    const extracted = await client.extractSessionMemories(sessionId);
    return {
      content: [
        {
          type: "text",
          text: `Stored in session ${sessionId} and extracted ${extracted.length} memories.`,
        },
      ],
    };
  } finally {
    if (createdTempSession && sessionId) {
      await client.deleteSession(sessionId).catch(() => {});
    }
  }
}

async function handleForget(client, params) {
  const uri = typeof params.uri === "string" ? params.uri : undefined;

  if (uri) {
    if (!isMemoryUri(uri)) {
      return {
        content: [
          { type: "text", text: `Refusing to delete non-memory URI: ${uri}` },
        ],
      };
    }
    await client.deleteUri(uri);
    return { content: [{ type: "text", text: `Forgotten: ${uri}` }] };
  }

  const query = typeof params.query === "string" ? params.query : undefined;
  if (!query) {
    return {
      content: [{ type: "text", text: "Provide uri or query." }],
      isError: true,
    };
  }

  const limit =
    typeof params.limit === "number"
      ? Math.max(1, Math.floor(params.limit))
      : 5;
  const scoreThreshold =
    typeof params.scoreThreshold === "number"
      ? Math.max(0, Math.min(1, params.scoreThreshold))
      : DEFAULT_SCORE_THRESHOLD;
  const targetUri =
    typeof params.targetUri === "string"
      ? params.targetUri
      : DEFAULT_TARGET_URI;
  const requestLimit = Math.max(limit * 4, 20);

  const result = await client.find(query, {
    targetUri,
    limit: requestLimit,
    scoreThreshold: 0,
  });
  const candidates = postProcessMemories(result.memories ?? [], {
    limit: requestLimit,
    scoreThreshold,
    leafOnly: true,
  }).filter((item) => isMemoryUri(item.uri));

  if (candidates.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No matching leaf memory candidates found. Try a more specific query.",
        },
      ],
    };
  }

  const top = candidates[0];
  if (candidates.length === 1 && clampScore(top.score) >= 0.85) {
    await client.deleteUri(top.uri);
    return { content: [{ type: "text", text: `Forgotten: ${top.uri}` }] };
  }

  const list = candidates
    .map(
      (item) =>
        `- ${item.uri} (${(clampScore(item.score) * 100).toFixed(0)}%)`
    )
    .join("\n");

  return {
    content: [
      {
        type: "text",
        text: `Found ${candidates.length} candidates. Specify uri:\n${list}`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const client = new OpenVikingClient(
  config.baseUrl,
  config.apiKey,
  config.agentId,
  config.resourceUri
);

const server = new McpServer({
  name: "openviking-memory",
  version: "1.0.0",
});

const enabledActions = config.enabledActions;

server.tool(
  "memory",
  `Manage long-term memory and retrieval powered by OpenViking. This tool supports three actions:

## When to use this tool
- Use "recall" to search past memories and indexed resources BEFORE answering questions about user preferences, history, past decisions, project docs, or anything the user may have told you before. Always search first when the user asks "do you remember", "what did I say about", or references past interactions or project documentation.
- Use "store" to save important information the user shares — preferences, facts about themselves, key decisions, project context, or anything that should be remembered across conversations. Proactively store when the user shares personal details, makes decisions, or explicitly asks you to remember something.
- Use "forget" to delete a specific memory when the user asks you to forget something, or to correct outdated/wrong information. You can delete by exact URI (from a prior recall result) or search by query.

## Actions

### recall
Search memories and resources by semantic query. Returns ranked results with relevance scores.
Required params: query
Optional params: limit (default 10), scoreThreshold (default 0.01), targetUri

### store
Store text into the memory pipeline. The text is written to a session and memories are asynchronously extracted by the OpenViking server in the background. This means a successful store response does NOT mean the memories are immediately available — calling recall right after store may not find the newly stored content. It typically takes a few seconds for extraction to complete.
Required params: text
Optional params: role (default "user"), sessionId

### forget
Delete a memory by exact URI, or search-then-delete. When searching, if a single strong match (>=85% score) is found it is deleted automatically; otherwise candidates are returned for you to pick from.
Required params: uri OR query (at least one)
Optional params: targetUri, limit (default 5), scoreThreshold (default 0.01)`,
  {
    action: z
      .enum(["recall", "store", "forget"])
      .describe("Operation to perform: recall (search memories and resources), store (save new memory), or forget (delete memory)"),

    query: z
      .string()
      .optional()
      .describe("Search query — required for recall, optional for forget. Use natural language describing what you want to find."),
    limit: z
      .number()
      .optional()
      .describe("Max number of results to return (default: 10 for recall, 5 for forget)"),
    scoreThreshold: z
      .number()
      .optional()
      .describe("Minimum relevance score between 0 and 1 (default: 0.01). Increase to filter out weak matches."),
    targetUri: z
      .string()
      .optional()
      .describe("Search scope URI to narrow search, e.g. 'viking://user/memories', 'viking://agent/memories', or 'viking://resources/project/docs'. When omitted, user memories, agent memories, and configured resources are searched."),

    text: z
      .string()
      .optional()
      .describe("The information to store as memory — required for store action. Write clear, factual text that captures what should be remembered."),
    role: z
      .string()
      .optional()
      .describe("Message role for the stored session entry (default: 'user'). Typically 'user' or 'assistant'."),
    sessionId: z
      .string()
      .optional()
      .describe("An existing OpenViking session ID to append to, instead of creating a temporary session."),

    uri: z
      .string()
      .optional()
      .describe("Exact memory URI to delete — for forget action. Use a URI returned from a prior recall result (e.g. 'viking://user/.../memories/...')."),
  },
  async (params) => {
    try {
      if (!enabledActions.includes(params.action)) {
        return {
          content: [
            {
              type: "text",
              text: `Action "${params.action}" is disabled. Enabled actions: ${enabledActions.join(", ")}`,
            },
          ],
          isError: true,
        };
      }
      switch (params.action) {
        case "recall": {
          if (!params.query) {
            return {
              content: [
                { type: "text", text: "Missing required parameter: query" },
              ],
              isError: true,
            };
          }
          return await handleRecall(client, params);
        }
        case "store": {
          if (!params.text) {
            return {
              content: [
                { type: "text", text: "Missing required parameter: text" },
              ],
              isError: true,
            };
          }
          return await handleStore(client, params);
        }
        case "forget": {
          return await handleForget(client, params);
        }
        default:
          return {
            content: [
              {
                type: "text",
                text: `Unknown action: ${params.action}. Enabled actions: ${enabledActions.join(", ")}`,
              },
            ],
            isError: true,
          };
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

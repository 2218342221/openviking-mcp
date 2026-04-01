#!/usr/bin/env node

import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OpenVikingSessionClient } from "./session-client.js";

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

// ---------------------------------------------------------------------------
// OpenViking HTTP client
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 60_000;

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

const ALL_ACTIONS = [
  "recall",
  "store",
  "forget",
  "fs/ls",
  "fs/read",
  "fs/grep",
];

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

function getErrorMessage(err) {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

function getScopeEntryName(entry, scope) {
  if (!entry || typeof entry !== "object") return "";
  if (typeof entry.name === "string" && entry.name.trim()) {
    return entry.name.trim();
  }
  if (typeof entry.uri === "string") {
    const match = entry.uri
      .trim()
      .match(new RegExp(`^viking://${scope}/([^/]+)/*$`));
    if (match && match[1]) return match[1].trim();
  }
  return "";
}

class OpenVikingClient {
  constructor(baseUrl, apiKey, agentId, resourceUri) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.agentId = agentId;
    this.resourceUri = normalizeUriPrefix(resourceUri);
    this.resolvedSpaceByScope = {};
    this.runtimeIdentity = null;
    this.sessions = new OpenVikingSessionClient((path, init) =>
      this.request(path, init)
    );
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

  async ls(uri, options = {}) {
    const normalizedUri = await this.normalizeFsUri(uri);
    const recursive = options.recursive === true ? "true" : "false";
    const simple = options.simple === true ? "true" : "false";
    return this.request(
      `/api/v1/fs/ls?uri=${encodeURIComponent(normalizedUri)}&recursive=${recursive}&simple=${simple}`
    );
  }

  async read(uri) {
    const normalizedUri = await this.normalizeFsUri(uri);
    return this.request(
      `/api/v1/content/read?uri=${encodeURIComponent(normalizedUri)}`
    );
  }

  async grep(uri, pattern, caseInsensitive = false) {
    const normalizedUri = await this.normalizeFsUri(uri);
    return this.request("/api/v1/search/grep", {
      method: "POST",
      body: JSON.stringify({
        uri: normalizedUri,
        pattern,
        case_insensitive: caseInsensitive,
      }),
    });
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
        .map((entry) => getScopeEntryName(entry, scope))
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

  async getScopedMemoriesUri(scope) {
    const space = await this.resolveScopeSpace(scope);
    return `viking://${scope}/${space}/memories`;
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

    // Keep shorthand scope URIs (for example viking://user/memories)
    // untouched and let backend resolve the actual runtime space.
    return trimmed;
  }

  async normalizeFsUri(uri) {
    const normalized = normalizeOptionalUri(uri);
    if (!normalized) {
      throw new Error("Missing required parameter: uri");
    }
    const match = normalized.match(/^viking:\/\/(user|agent)(?:\/(.*))?$/);
    if (!match) return normalized;

    const scope = match[1];
    const rawRest = (match[2] ?? "").trim();
    if (!rawRest) return normalized;

    const parts = rawRest.split("/").filter(Boolean);
    if (parts.length === 0) return normalized;

    const reservedDirs =
      scope === "user" ? USER_STRUCTURE_DIRS : AGENT_STRUCTURE_DIRS;
    if (!reservedDirs.has(parts[0])) return normalized;

    // Keep shorthand scope URIs (for example viking://user/memories)
    // untouched and let backend resolve the actual runtime space.
    return normalized;
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

function getContextIsLeaf(item) {
  if (typeof item.is_leaf === "boolean") return item.is_leaf;
  if (typeof item.isLeaf === "boolean") return item.isLeaf;
  if (typeof item.level === "number") return item.level === 2;
  return null;
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
      const isLeaf = getContextIsLeaf(item);
      const isLeafLabel = isLeaf === null ? "is_leaf=unknown" : `is_leaf=${isLeaf}`;
      const summary =
        item.abstract?.trim() ||
        item.overview?.trim() ||
        item.match_reason?.trim() ||
        item.uri;
      return `${index + 1}. [${contextType}] [${isLeafLabel}] ${summary} (${(
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

function isShorthandMemoriesTargetUri(value) {
  if (typeof value !== "string") return false;
  const normalized = normalizeUriPrefix(value);
  return (
    normalized === "viking://user/memories" ||
    normalized === "viking://agent/memories"
  );
}

function getShorthandMemoriesScope(targetUri) {
  if (typeof targetUri !== "string") return undefined;
  const normalized = normalizeUriPrefix(targetUri);
  if (normalized === "viking://user/memories") return "user";
  if (normalized === "viking://agent/memories") return "agent";
  return undefined;
}

async function buildShorthandMemoriesHint(client, targetUri) {
  const scope = getShorthandMemoriesScope(targetUri);
  if (!scope) return "";

  try {
    const fullUri = await client.getScopedMemoriesUri(scope);
    return (
      ` Hint: this shorthand URI may not map to your data space in this environment. ` +
      `Try targetUri=${fullUri}, or omit targetUri.`
    );
  } catch {
    const fallbackFullUri =
      scope === "user"
        ? "viking://user/<space>/memories"
        : "viking://agent/<space>/memories";
    return (
      ` Hint: this shorthand URI may not map to your data space in this environment. ` +
      `Try targetUri=${fallbackFullUri}, or omit targetUri.`
    );
  }
}

async function buildShorthandMemoriesFsHint(client, uri, err) {
  const scope = getShorthandMemoriesScope(uri);
  if (!scope) return "";

  const message = getErrorMessage(err).toLowerCase();
  if (!message.includes("not_found") && !message.includes("not found")) {
    return "";
  }

  try {
    const fullUri = await client.getScopedMemoriesUri(scope);
    return (
      ` Hint: this shorthand URI may not map to your data space in this environment. ` +
      `Try uri=${fullUri}.`
    );
  } catch {
    const fallbackFullUri =
      scope === "user"
        ? "viking://user/<space>/memories"
        : "viking://agent/<space>/memories";
    return (
      ` Hint: this shorthand URI may not map to your data space in this environment. ` +
      `Try uri=${fallbackFullUri}.`
    );
  }
}

const config = parseArgs(process.argv);

// ---------------------------------------------------------------------------
// Tool action handlers
// ---------------------------------------------------------------------------

const DEFAULT_RECALL_LIMIT = 10;
const DEFAULT_SCORE_THRESHOLD = 0.01;

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
    const [userMemoriesUri, agentMemoriesUri] = await Promise.all([
      client
        .getScopedMemoriesUri("user")
        .catch(() => "viking://user/memories"),
      client
        .getScopedMemoriesUri("agent")
        .catch(() => "viking://agent/memories"),
    ]);
    const recallScopes = [
      {
        label: "user memories",
        promise: client.find(query, {
          targetUri: userMemoriesUri,
          limit: requestLimit,
          scoreThreshold: 0,
        }),
      },
      {
        label: "agent memories",
        promise: client.find(query, {
          targetUri: agentMemoriesUri,
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
    const hint = await buildShorthandMemoriesHint(client, targetUri);
    return {
      content: [
        { type: "text", text: `No relevant results found.${hint}` },
      ],
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
  const text = typeof params.text === "string" ? params.text : undefined;
  const hasText = typeof text === "string" && text.length > 0;
  const role = typeof params.role === "string" ? params.role : "user";
  const sessionIdIn =
    typeof params.session_id === "string"
      ? params.session_id
      : typeof params.sessionId === "string"
        ? params.sessionId
        : undefined;
  const hasCreateSessionParam =
    typeof params.create_session === "boolean" ||
    typeof params.createSession === "boolean";
  const createSession =
    typeof params.create_session === "boolean"
      ? params.create_session
      : typeof params.createSession === "boolean"
        ? params.createSession
        : undefined;
  const commitSession =
    typeof params.commit_session === "boolean"
      ? params.commit_session
      : typeof params.commitSession === "boolean"
        ? params.commitSession
        : false;

  let sessionId = sessionIdIn;
  let createdTempSession = false;
  let messageStored = false;
  try {
    if (!hasText && !commitSession) {
      return {
        content: [
          {
            type: "text",
            text: "Missing required parameter: text. For commit-only, set commit_session=true and provide a session selector (session_id or create_session=true).",
          },
        ],
        isError: true,
      };
    }
    if (!sessionId) {
      if (!hasCreateSessionParam) {
        return {
          content: [
            {
              type: "text",
              text: "Missing session selector: provide session_id, or explicitly pass create_session=true to create a new session.",
            },
          ],
          isError: true,
        };
      }
      if (createSession !== true) {
        return {
          content: [
            {
              type: "text",
              text: "session_id=none and create_session is not true. When session_id is absent, set create_session=true to create a new session.",
            },
          ],
          isError: true,
        };
      }
      sessionId = await client.sessions.createSession();
      createdTempSession = true;
    }
    if (hasText) {
      await client.sessions.addSessionMessage(sessionId, role, text);
      messageStored = true;
    }

    if (!commitSession) {
      return {
        content: [
          {
            type: "text",
            text: `Stored message in session ${sessionId}. You can continue appending by passing session_id=${sessionId}. IMPORTANT: memories are not extracted yet. You must call store with commit_session=true as the final step. After commit_session=true, this session_id is considered closed; do not push new messages to it.`,
          },
        ],
      };
    }

    let commitResult;
    try {
      commitResult = await client.sessions.commitSession(sessionId);
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Commit failed for session ${sessionId}: ${getErrorMessage(err)}. Retry with action=store, session_id=${sessionId}, commit_session=true, and no text to avoid duplicate messages.`,
          },
        ],
        isError: true,
      };
    }
    const taskId =
      typeof commitResult?.task_id === "string" ? commitResult.task_id : "";
    const commitStatus =
      typeof commitResult?.status === "string" ? commitResult.status : "accepted";
    if (taskId) {
      client.sessions.scheduleCleanupAfterCommit(
        sessionId,
        taskId,
        "store commit_session"
      );
    }
    return {
      content: [
        {
          type: "text",
          text: `${hasText ? `Stored message in session ${sessionId}. ` : `Commit requested for existing session ${sessionId} without adding new messages. `}Commit requested (status=${commitStatus}${taskId ? `, task_id=${taskId}` : ""}). This session_id is now closed for new messages. If you need to store more text, create/use another session_id. Background worker will delete this session after commit task completion.`,
        },
      ],
    };
  } catch (err) {
    const sidPart = sessionId ? `session_id=${sessionId}` : "session_id=none";
    return {
      content: [
        {
          type: "text",
          text: `${sidPart}. Store failed: ${getErrorMessage(err)}.`,
        },
      ],
      isError: true,
    };
  } finally {
    if (createdTempSession && sessionId && !messageStored) {
      await client.sessions.deleteSession(sessionId).catch(() => {});
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
    typeof params.targetUri === "string" ? params.targetUri : undefined;
  const requestLimit = Math.max(limit * 4, 20);

  let searchResult;
  let partialFailures = [];
  if (targetUri) {
    searchResult = await client.find(query, {
      targetUri,
      limit: requestLimit,
      scoreThreshold: 0,
    });
  } else {
    const [userMemoriesUri, agentMemoriesUri] = await Promise.all([
      client
        .getScopedMemoriesUri("user")
        .catch(() => "viking://user/memories"),
      client
        .getScopedMemoriesUri("agent")
        .catch(() => "viking://agent/memories"),
    ]);
    const forgetScopes = [
      {
        label: "user memories",
        promise: client.find(query, {
          targetUri: userMemoriesUri,
          limit: requestLimit,
          scoreThreshold: 0,
        }),
      },
      {
        label: "agent memories",
        promise: client.find(query, {
          targetUri: agentMemoriesUri,
          limit: requestLimit,
          scoreThreshold: 0,
        }),
      },
    ];
    const settled = await Promise.allSettled(
      forgetScopes.map((scope) => scope.promise)
    );
    const successes = [];
    const failures = [];
    for (const [index, entry] of settled.entries()) {
      if (entry.status === "fulfilled") {
        successes.push(entry.value);
      } else {
        failures.push(
          formatSettledSearchError(forgetScopes[index].label, entry.reason)
        );
      }
    }
    if (successes.length === 0) {
      throw new Error(
        `Forget search failed for all scopes. ${failures.join(" | ")}`
      );
    }
    searchResult = mergeFindResults(successes);
    partialFailures = failures;
  }

  const candidates = postProcessMemories(searchResult.memories ?? [], {
    limit: requestLimit,
    scoreThreshold,
    leafOnly: true,
  }).filter((item) => isMemoryUri(item.uri));

  const partialFailureNote =
    partialFailures.length > 0
      ? ` Failed scopes: ${partialFailures.join(" | ")}`
      : "";
  if (candidates.length === 0) {
    const hint = await buildShorthandMemoriesHint(client, targetUri);
    return {
      content: [
        {
          type: "text",
          text: `No matching leaf memory candidates found. Try a more specific query.${partialFailureNote}${hint}`,
        },
      ],
    };
  }

  const top = candidates[0];
  if (
    candidates.length === 1 &&
    clampScore(top.score) >= 0.85 &&
    partialFailures.length === 0
  ) {
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
        text: `Found ${candidates.length} candidates. Specify uri:\n${list}${partialFailureNote ? `\n\n${partialFailureNote}` : ""}`,
      },
    ],
  };
}

async function handleFsLs(client, params) {
  const uri = typeof params.uri === "string" ? params.uri : undefined;
  const recursive = typeof params.recursive === "boolean" ? params.recursive : false;
  const simple = typeof params.simple === "boolean" ? params.simple : false;
  try {
    const entries = await client.ls(uri, { recursive, simple });
    const items = Array.isArray(entries) ? entries : [];
    if (items.length === 0) {
      return {
        content: [{ type: "text", text: `No items found at ${uri}.` }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ uri, recursive, simple, count: items.length, items }, null, 2),
        },
      ],
    };
  } catch (err) {
    const hint = await buildShorthandMemoriesFsHint(client, uri, err);
    return {
      content: [
        {
          type: "text",
          text: `fs/ls failed for ${uri}: ${getErrorMessage(err)}.${hint}`,
        },
      ],
      isError: true,
    };
  }
}

async function handleFsRead(client, params) {
  const uri = typeof params.uri === "string" ? params.uri : undefined;
  const result = await client.read(uri);
  if (result === undefined || result === null || result === "") {
    return {
      content: [{ type: "text", text: `No content found at ${uri}.` }],
    };
  }
  return {
    content: [
      {
        type: "text",
        text:
          typeof result === "string" ? result : JSON.stringify(result, null, 2),
      },
    ],
  };
}

async function handleFsGrep(client, params) {
  const uri = typeof params.uri === "string" ? params.uri : undefined;
  const pattern =
    typeof params.pattern === "string" ? params.pattern : undefined;
  const caseInsensitive =
    typeof params.caseInsensitive === "boolean"
      ? params.caseInsensitive
      : typeof params.case_insensitive === "boolean"
        ? params.case_insensitive
        : false;

  const result = await client.grep(uri, pattern, caseInsensitive);
  const matches = Array.isArray(result?.matches) ? result.matches : [];
  const count =
    typeof result?.count === "number" && Number.isFinite(result.count)
      ? result.count
      : matches.length;
  if (matches.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No matches found for pattern "${pattern}" under ${uri}.`,
        },
      ],
    };
  }

  const lines = matches
    .map((item, index) => {
      const matchUri =
        typeof item?.uri === "string" ? item.uri : "unknown://unknown";
      const line = typeof item?.line === "number" ? item.line : "?";
      const content =
        typeof item?.content === "string" ? item.content : String(item?.content);
      return `${index + 1}. ${matchUri}:${line}\n   ${content}`;
    })
    .join("\n");

  return {
    content: [
      {
        type: "text",
        text: `Found ${count} matches for "${pattern}" in ${uri}:\n\n${lines}`,
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
  `Manage long-term memory and retrieval powered by OpenViking. This tool supports six actions:

## When to use this tool
- Use "recall" to search past memories and indexed resources BEFORE answering questions about user preferences, history, past decisions, project docs, or anything the user may have told you before. Always search first when the user asks "do you remember", "what did I say about", or references past interactions or project documentation.
- Use "store" to save important information the user shares — preferences, facts about themselves, key decisions, project context, or anything that should be remembered across conversations. Proactively store when the user shares personal details, makes decisions, or explicitly asks you to remember something.
- Use "forget" to delete a specific memory when the user asks you to forget something, or to correct outdated/wrong information. You can delete by exact URI (from a prior recall result) or search by query.
- Use "fs/ls" to inspect URI structure and identify readable 'is_leaf=true' nodes.
- Use "fs/read" to read full content only from 'is_leaf=true' nodes (leaf/file nodes), not from directory nodes.
- Use "fs/grep" to run regex-like content search within a URI scope.

## Actions

### recall
Search memories and resources by semantic query. Returns ranked results with relevance scores, context_type, and is_leaf markers.
Required params: query
Optional params: limit (default 10), scoreThreshold (default 0.01), targetUri

### store
Store text into a session. By default this only appends a message and returns the session_id so you can continue writing to the same session in later calls. Set commit_session=true when you want to commit the session. Commit returns quickly with a task_id, and the server completes extraction in the background.
Important lifecycle rule: if you do not commit, memories are not extracted; you must eventually call commit_session=true as the final step. After commit_session=true, this session_id is considered closed for new messages.
If a commit request fails, retry commit-only with the same session_id and commit_session=true, without text, to avoid duplicate writes.
Required params: text OR commit_session=true
Session selector (required): each store call must provide session_id, OR explicitly pass create_session=true when session_id is absent. Both session_id and create_session can be used with commit_session.
Other params: role (default "user"), commit_session (default false), aliases sessionId/createSession/commitSession

### forget
Delete a memory by exact URI, or search-then-delete. When searching, if a single strong match (>=85% score) is found it is deleted automatically; otherwise candidates are returned for you to pick from.
Required params: uri OR query (at least one)
Optional params: targetUri, limit (default 5), scoreThreshold (default 0.01). When targetUri is omitted, query search runs across both user and agent memories.

### fs/ls
List directory entries under a URI to locate 'is_leaf=true' readable nodes.
Required params: uri
Optional params: recursive (default false), simple (default false)

### fs/read
Read full content (L2) only from 'is_leaf=true' nodes (leaf/file nodes).
Required params: uri

### fs/grep
Pattern search under a URI.
Required params: uri, pattern
Optional params: caseInsensitive (default false)`,
  {
    action: z
      .enum(["recall", "store", "forget", "fs/ls", "fs/read", "fs/grep"])
      .describe(
        "Operation to perform: recall, store, forget, fs/ls, fs/read, or fs/grep."
      ),

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
      .describe("The information to store as memory. Required unless using commit-only mode (commit_session=true, without text)."),
    role: z
      .string()
      .optional()
      .describe("Message role for the stored session entry (default: 'user'). Typically 'user' or 'assistant'."),
    session_id: z
      .string()
      .optional()
      .describe("Existing session ID for appending messages. Preferred over sessionId. Do not reuse a session_id after a successful commit_session=true call."),
    sessionId: z
      .string()
      .optional()
      .describe("Alias of session_id for backward compatibility."),
    create_session: z
      .boolean()
      .optional()
      .describe("Session selector. Required when session_id is absent. Must be explicitly set to true to create a new session."),
    createSession: z
      .boolean()
      .optional()
      .describe("Alias of create_session for backward compatibility. Same rule: required when session_id is absent."),
    commit_session: z
      .boolean()
      .optional()
      .describe("Whether to commit the session after this call (default: false). Supports commit-only mode when used without text. Commit should be called as the final step; after commit_session=true the session is considered closed for new messages."),
    commitSession: z
      .boolean()
      .optional()
      .describe("Alias of commit_session for backward compatibility."),

    uri: z
      .string()
      .optional()
      .describe("Viking URI. Required for fs/ls, fs/read, fs/grep. For fs/read, pass a URI corresponding to an is_leaf=true node. For forget, this is the exact memory URI to delete."),
    recursive: z
      .boolean()
      .optional()
      .describe("Whether fs/ls lists descendants recursively."),
    simple: z
      .boolean()
      .optional()
      .describe("Whether fs/ls returns simplified relative path output."),
    pattern: z
      .string()
      .optional()
      .describe("Regex pattern for fs/grep action."),
    caseInsensitive: z
      .boolean()
      .optional()
      .describe("Whether fs/grep ignores case (maps to case_insensitive)."),
    case_insensitive: z
      .boolean()
      .optional()
      .describe("Alias of caseInsensitive for fs/grep compatibility."),
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
          const hasText =
            typeof params.text === "string" && params.text.length > 0;
          const wantsCommitOnly =
            params.commit_session === true || params.commitSession === true;
          const sessionId =
            typeof params.session_id === "string"
              ? params.session_id
              : typeof params.sessionId === "string"
                ? params.sessionId
                : "";
          const hasCreateSessionParam =
            typeof params.create_session === "boolean" ||
            typeof params.createSession === "boolean";
          const createSession =
            typeof params.create_session === "boolean"
              ? params.create_session
              : typeof params.createSession === "boolean"
                ? params.createSession
                : undefined;
          if (!hasText && !wantsCommitOnly) {
            return {
              content: [
                {
                  type: "text",
                  text: "Missing required parameter: text (or set commit_session=true for commit-only).",
                },
              ],
              isError: true,
            };
          }
          if (!sessionId && !hasCreateSessionParam) {
            return {
              content: [
                {
                  type: "text",
                  text: "Missing session selector: provide session_id, or explicitly pass create_session=true.",
                },
              ],
              isError: true,
            };
          }
          if (!sessionId && createSession !== true) {
            return {
              content: [
                {
                  type: "text",
                  text: "session_id is absent and create_session is not true. Pass create_session=true to create a session.",
                },
              ],
              isError: true,
            };
          }
          return await handleStore(client, params);
        }
        case "forget": {
          return await handleForget(client, params);
        }
        case "fs/ls": {
          if (!params.uri) {
            return {
              content: [{ type: "text", text: "Missing required parameter: uri" }],
              isError: true,
            };
          }
          return await handleFsLs(client, params);
        }
        case "fs/read": {
          if (!params.uri) {
            return {
              content: [{ type: "text", text: "Missing required parameter: uri" }],
              isError: true,
            };
          }
          return await handleFsRead(client, params);
        }
        case "fs/grep": {
          if (!params.uri) {
            return {
              content: [{ type: "text", text: "Missing required parameter: uri" }],
              isError: true,
            };
          }
          if (!params.pattern) {
            return {
              content: [
                { type: "text", text: "Missing required parameter: pattern" },
              ],
              isError: true,
            };
          }
          return await handleFsGrep(client, params);
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

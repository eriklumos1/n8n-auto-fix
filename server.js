const http = require("http");
const fs = require("fs");
const path = require("path");

// =============================================================================
// CONFIGURATION
// =============================================================================

const PORT = process.env.PORT || 10000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const N8N_API_URL = process.env.N8N_API_URL;
const N8N_API_KEY = process.env.N8N_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SLACK_CHANNEL = "C09FEFUG5FT";

// Never auto-fix the error workflow itself
const ERROR_WORKFLOW_ID = "JtMGyvm5ub4nlDxe";

// Cooldown to prevent repeated fix attempts
const COOLDOWN_MS = 5 * 60 * 1000;

// Circuit breaker: stop after N consecutive failures per workflow
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_MS = 60 * 60 * 1000; // 1 hour

// Recurrence detection: if same error returns within this window, prior "success" was false
const RECURRENCE_WINDOW_MS = 72 * 60 * 60 * 1000; // 72 hours
const RECURRENCE_CIRCUIT_THRESHOLD = 2; // Open circuit after 2 recurrences

// Batch notification delay (ms) to group simultaneous errors
const ACK_BATCH_DELAY = 30000; // 30 seconds

// Use the most intelligent model
const CLAUDE_MODEL = "claude-opus-4-6";

// Token limits
const MAX_TOKEN_ESTIMATE = 180000; // Opus 4.6 handles full 200K context well
const MAX_STRING_LENGTH = 1000; // Truncate strings to this length
const MAX_UPSTREAM_ITEMS = 2; // Max items per upstream node
const MAX_UPSTREAM_NODES = 10; // Max upstream nodes to include

// Persistent storage paths
const DATA_DIR = path.join(__dirname, "data");
const PROCESSED_FILE = path.join(DATA_DIR, "processed-executions.json");
const FIX_HISTORY_FILE = path.join(DATA_DIR, "fix-history.json");
const SNAPSHOTS_DIR = path.join(DATA_DIR, "snapshots");

// =============================================================================
// STATE
// =============================================================================

const queue = [];
let processing = false;
const lastProcessed = new Map();

// Execution-level dedup: Set of execution IDs already processed
let processedExecutions = new Set();

// Fix attempt memory: workflowId -> [{timestamp, executionId, errorMessage, fixAttempted, success}]
let fixHistory = {};

// Circuit breaker: workflowId -> {failures, openedAt, lastError}
const circuitBreakers = new Map();

// Batch notification accumulator: workflowId -> {count, errors[], timer}
const pendingAcks = new Map();

// =============================================================================
// REDIS CLIENT
// =============================================================================

const { Redis } = require("@upstash/redis");

let redis = null;
let redisAvailable = false;

function initRedis() {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    log("WARNING: Upstash Redis not configured. Using in-memory-only mode.");
    log("Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for persistence.");
    return;
  }
  try {
    redis = new Redis({
      url: UPSTASH_REDIS_REST_URL,
      token: UPSTASH_REDIS_REST_TOKEN,
    });
    redisAvailable = true;
    log("Upstash Redis client initialized");
  } catch (err) {
    log(`WARNING: Failed to initialize Redis client: ${err.message}`);
    log("Falling back to in-memory-only mode.");
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// =============================================================================
// ERROR FINGERPRINTING & RECURRENCE DETECTION
// =============================================================================

/**
 * Normalize an error message into a comparable fingerprint.
 * Strips execution IDs, timestamps, UUIDs, and variable data so the same
 * logical error always produces the same fingerprint.
 */
function errorFingerprint(errorMessage) {
  return (errorMessage || "")
    .toLowerCase()
    .replace(/execution \d+/g, "execution X")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*/g, "TIMESTAMP")
    .replace(/#\d+/g, "#X")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "UUID")
    .replace(/\d{5,}/g, "ID")
    .trim()
    .slice(0, 150);
}

/**
 * Detect if this error is a recurrence of a previously "fixed" error.
 * If so, retroactively mark prior "successful" fixes as actually failed.
 *
 * Returns { isRecurring, attemptCount, previousAttempts }
 */
async function detectRecurrence(workflowId, errorMessage) {
  const history = fixHistory[workflowId] || [];
  if (history.length === 0) {
    return { isRecurring: false, attemptCount: 0, previousAttempts: [] };
  }

  const currentFP = errorFingerprint(errorMessage);
  const now = Date.now();
  const matchingAttempts = [];

  for (const entry of history) {
    const entryFP = entry.errorFingerprint || errorFingerprint(entry.errorMessage);
    if (entryFP !== currentFP) continue;

    const age = now - (entry.timestamp || 0);
    if (age > RECURRENCE_WINDOW_MS) continue;

    matchingAttempts.push(entry);

    // Retroactively mark "successful" fixes as actually failed
    if (entry.success && entry.actualSuccess !== false) {
      entry.actualSuccess = false;
      entry.recurrenceDetected = true;
      log(`Retroactively marked fix as ACTUALLY FAILED: "${entry.fixAttempted}" (workflow ${workflowId})`);
    }
  }

  if (matchingAttempts.length > 0) {
    await saveFixHistory(workflowId); // Persist the retroactive updates
  }

  return {
    isRecurring: matchingAttempts.length > 0,
    attemptCount: matchingAttempts.length,
    previousAttempts: matchingAttempts
  };
}

// =============================================================================
// TRUNCATION UTILITIES
// =============================================================================

/**
 * Truncate a string to maxLength, adding ellipsis if truncated
 */
function truncateString(str, maxLength = MAX_STRING_LENGTH) {
  if (typeof str !== 'string') return str;
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '... [truncated]';
}

/**
 * Recursively truncate all string values in an object
 */
function truncateObject(obj, maxStringLength = MAX_STRING_LENGTH, depth = 0) {
  if (depth > 10) return '[max depth reached]'; // Prevent infinite recursion

  if (typeof obj === 'string') {
    return truncateString(obj, maxStringLength);
  }

  if (Array.isArray(obj)) {
    return obj.slice(0, 10).map(item => truncateObject(item, maxStringLength, depth + 1));
  }

  if (typeof obj === 'object' && obj !== null) {
    const truncated = {};
    const keys = Object.keys(obj).slice(0, 50); // Limit number of keys
    for (const key of keys) {
      truncated[key] = truncateObject(obj[key], maxStringLength, depth + 1);
    }
    if (Object.keys(obj).length > 50) {
      truncated['_truncated'] = `${Object.keys(obj).length - 50} more keys omitted`;
    }
    return truncated;
  }

  return obj;
}

/**
 * Estimate token count (rough approximation: 1 token ≈ 4 chars)
 */
function estimateTokens(obj) {
  const jsonStr = JSON.stringify(obj);
  return Math.ceil(jsonStr.length / 4);
}

/**
 * Truncate data to fit within token budget
 */
function truncateToTokenBudget(data, maxTokens = MAX_TOKEN_ESTIMATE) {
  let current = data;
  let tokens = estimateTokens(current);

  // If already within budget, return as-is
  if (tokens <= maxTokens) {
    return { data: current, tokens, truncated: false };
  }

  log(`Data exceeds token budget (${tokens} > ${maxTokens}), truncating...`);

  // Progressive truncation strategy
  const strategies = [
    // 1. Truncate upstream data more aggressively
    () => {
      if (current.upstreamData) {
        const truncated = {};
        const nodeNames = Object.keys(current.upstreamData).slice(0, 5);
        for (const nodeName of nodeNames) {
          const nodeData = current.upstreamData[nodeName];
          if (Array.isArray(nodeData)) {
            truncated[nodeName] = nodeData.slice(0, 1).map(item =>
              truncateObject(item, 200)
            );
          } else {
            truncated[nodeName] = truncateObject(nodeData, 200);
          }
        }
        current = { ...current, upstreamData: truncated };
      }
    },
    // 2. Remove upstream data entirely if still too large
    () => {
      if (current.upstreamData) {
        current = {
          ...current,
          upstreamData: { _note: 'Upstream data omitted due to size constraints' }
        };
      }
    },
    // 3. Truncate failed node config
    () => {
      if (current.failedNodeConfig) {
        current = {
          ...current,
          failedNodeConfig: truncateObject(current.failedNodeConfig, 300)
        };
      }
    },
    // 4. Keep only essential fields
    () => {
      current = {
        id: current.id,
        workflowId: current.workflowId,
        workflowName: current.workflowName,
        status: current.status,
        error: truncateObject(current.error, 500),
        failedNode: current.failedNode,
        failedNodeType: current.failedNodeType,
        executionPath: current.executionPath?.slice(0, 10),
        _note: 'Data heavily truncated due to size constraints'
      };
    }
  ];

  for (const strategy of strategies) {
    strategy();
    tokens = estimateTokens(current);
    if (tokens <= maxTokens) {
      log(`Truncation successful: ${tokens} tokens`);
      return { data: current, tokens, truncated: true };
    }
  }

  log(`Warning: Could not reduce to target token count. Current: ${tokens}`);
  return { data: current, tokens, truncated: true };
}

// =============================================================================
// PERSISTENT STORAGE
// =============================================================================

function ensureDataDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
}

async function loadProcessedExecutions() {
  // Try Redis first
  if (redisAvailable) {
    try {
      const members = await redis.smembers("autofix:processed");
      if (members && members.length > 0) {
        processedExecutions = new Set(members);
        log(`Loaded ${processedExecutions.size} processed execution IDs from Redis`);
        return;
      }
    } catch (err) {
      log(`Redis read failed (processed): ${err.message}. Trying file fallback.`);
    }
  }
  // File fallback (local dev or Redis unavailable)
  try {
    const data = fs.readFileSync(PROCESSED_FILE, "utf8");
    const arr = JSON.parse(data);
    processedExecutions = new Set(arr);
    if (processedExecutions.size > 500) {
      const trimmed = [...processedExecutions].slice(-500);
      processedExecutions = new Set(trimmed);
    }
    log(`Loaded ${processedExecutions.size} processed execution IDs from file`);
  } catch {
    processedExecutions = new Set();
  }
}

async function addProcessedExecution(executionId) {
  processedExecutions.add(executionId);

  // Trim in-memory
  if (processedExecutions.size > 500) {
    const trimmed = [...processedExecutions].slice(-500);
    processedExecutions = new Set(trimmed);
  }

  // Write to Redis (incremental SADD)
  if (redisAvailable) {
    try {
      await redis.sadd("autofix:processed", executionId);
      // Periodically trim the Redis set (every ~100 additions)
      const size = await redis.scard("autofix:processed");
      if (size > 600) {
        const pipeline = redis.pipeline();
        pipeline.del("autofix:processed");
        const members = [...processedExecutions];
        if (members.length > 0) {
          pipeline.sadd("autofix:processed", ...members);
        }
        await pipeline.exec();
        log(`Trimmed Redis processed set from ${size} to ${processedExecutions.size}`);
      }
    } catch (err) {
      log(`Redis write failed (processed): ${err.message}`);
    }
  }
  // File backup
  try {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...processedExecutions]));
  } catch { /* best-effort */ }
}

async function loadFixHistory() {
  // Try Redis first
  if (redisAvailable) {
    try {
      const data = await redis.hgetall("autofix:history");
      if (data && Object.keys(data).length > 0) {
        fixHistory = {};
        for (const [workflowId, value] of Object.entries(data)) {
          fixHistory[workflowId] = typeof value === "string" ? JSON.parse(value) : value;
        }
        const total = Object.values(fixHistory).reduce((sum, arr) => sum + arr.length, 0);
        log(`Loaded fix history from Redis: ${total} entries across ${Object.keys(fixHistory).length} workflows`);
        return;
      }
    } catch (err) {
      log(`Redis read failed (history): ${err.message}. Trying file fallback.`);
    }
  }
  // File fallback
  try {
    const data = fs.readFileSync(FIX_HISTORY_FILE, "utf8");
    fixHistory = JSON.parse(data);
    const total = Object.values(fixHistory).reduce((sum, arr) => sum + arr.length, 0);
    log(`Loaded fix history from file: ${total} entries across ${Object.keys(fixHistory).length} workflows`);
  } catch {
    fixHistory = {};
  }
}

async function saveFixHistory(changedWorkflowId) {
  // Write to Redis
  if (redisAvailable) {
    try {
      if (changedWorkflowId) {
        // Targeted save — only the changed workflow
        const value = fixHistory[changedWorkflowId] || [];
        await redis.hset("autofix:history", { [changedWorkflowId]: JSON.stringify(value) });
      } else {
        // Full save (e.g., after bulk modifications)
        const pipeline = redis.pipeline();
        for (const [workflowId, attempts] of Object.entries(fixHistory)) {
          pipeline.hset("autofix:history", { [workflowId]: JSON.stringify(attempts) });
        }
        await pipeline.exec();
      }
    } catch (err) {
      log(`Redis write failed (history): ${err.message}`);
    }
  }
  // File backup
  try {
    fs.writeFileSync(FIX_HISTORY_FILE, JSON.stringify(fixHistory, null, 2));
  } catch { /* best-effort */ }
}

async function addFixAttempt(workflowId, entry) {
  if (!fixHistory[workflowId]) fixHistory[workflowId] = [];
  fixHistory[workflowId].push({
    ...entry,
    timestamp: Date.now(),
    errorFingerprint: errorFingerprint(entry.errorMessage),
    actualSuccess: entry.success ? null : false, // null = pending verification, false = confirmed failure
    recurrenceDetected: false
  });
  // Keep last 20 attempts per workflow
  if (fixHistory[workflowId].length > 20) {
    fixHistory[workflowId] = fixHistory[workflowId].slice(-20);
  }
  await saveFixHistory(workflowId);
}

// =============================================================================
// CIRCUIT BREAKER (recurrence-aware)
// =============================================================================

async function loadCircuitBreakers() {
  if (!redisAvailable) return;
  try {
    const data = await redis.hgetall("autofix:circuits");
    if (data && Object.keys(data).length > 0) {
      for (const [workflowId, value] of Object.entries(data)) {
        const cb = typeof value === "string" ? JSON.parse(value) : value;
        circuitBreakers.set(workflowId, cb);
      }
      log(`Loaded ${circuitBreakers.size} circuit breakers from Redis`);
    }
  } catch (err) {
    log(`Redis read failed (circuits): ${err.message}`);
  }
}

async function saveCircuitBreaker(workflowId) {
  if (!redisAvailable) return;
  try {
    const cb = circuitBreakers.get(workflowId);
    if (cb) {
      await redis.hset("autofix:circuits", { [workflowId]: JSON.stringify(cb) });
    } else {
      await redis.hdel("autofix:circuits", workflowId);
    }
  } catch (err) {
    log(`Redis write failed (circuit ${workflowId}): ${err.message}`);
  }
}

function isCircuitOpen(workflowId) {
  const cb = circuitBreakers.get(workflowId);
  if (!cb) return false;

  const isOpenByFailures = cb.failures >= CIRCUIT_BREAKER_THRESHOLD;
  const isOpenByRecurrences = cb.recurrences >= RECURRENCE_CIRCUIT_THRESHOLD;

  if (isOpenByFailures || isOpenByRecurrences) {
    // Auto-reset after timeout
    if (Date.now() - cb.openedAt > CIRCUIT_BREAKER_RESET_MS) {
      circuitBreakers.delete(workflowId);
      // Fire-and-forget Redis cleanup
      saveCircuitBreaker(workflowId).catch(() => {});
      log(`Circuit breaker reset for ${workflowId}`);
      return false;
    }
    return true;
  }
  return false;
}

async function recordCircuitFailure(workflowId, errorMessage) {
  const cb = circuitBreakers.get(workflowId) || { failures: 0, recurrences: 0, openedAt: null, lastError: "" };
  cb.failures++;
  cb.lastError = errorMessage;
  const threshold = cb.failures >= CIRCUIT_BREAKER_THRESHOLD || cb.recurrences >= RECURRENCE_CIRCUIT_THRESHOLD;
  if (threshold && !cb.openedAt) {
    cb.openedAt = Date.now();
  }
  circuitBreakers.set(workflowId, cb);
  await saveCircuitBreaker(workflowId);
  return threshold;
}

async function recordCircuitRecurrence(workflowId, errorMessage) {
  const cb = circuitBreakers.get(workflowId) || { failures: 0, recurrences: 0, openedAt: null, lastError: "" };
  cb.recurrences++;
  cb.lastError = errorMessage;
  const threshold = cb.recurrences >= RECURRENCE_CIRCUIT_THRESHOLD;
  if (threshold && !cb.openedAt) {
    cb.openedAt = Date.now();
    log(`Circuit breaker OPENED for ${workflowId} due to ${cb.recurrences} recurrences`);
  }
  circuitBreakers.set(workflowId, cb);
  await saveCircuitBreaker(workflowId);
  return threshold;
}

async function resetCircuitBreaker(workflowId) {
  circuitBreakers.delete(workflowId);
  await saveCircuitBreaker(workflowId);
}

// =============================================================================
// ERROR PRE-CLASSIFICATION
// =============================================================================

function classifyError(errorData) {
  const msg = (errorData.errorMessage || "").toLowerCase();

  // Infrastructure errors — never auto-fixable
  if (msg.includes("out-of-memory") || msg.includes("out of memory") || msg.includes("possible out-of-memory"))
    return { fixable: false, category: "infrastructure", reason: "Server OOM — check Render instance memory" };
  if (msg.includes("gateway timed out") || msg.includes("502 bad gateway"))
    return { fixable: false, category: "infrastructure", reason: "Gateway timeout — n8n instance may be overloaded" };

  // Credential errors — never auto-fixable
  if (msg.includes("authorization failed") || msg.includes("please check your credentials"))
    return { fixable: false, category: "credentials", reason: "Invalid or expired API credentials" };

  // External service errors — not auto-fixable
  if (msg.includes("connection terminated due to connection timeout"))
    return { fixable: false, category: "external_service", reason: "External service timeout — not a workflow config issue" };

  // Likely auto-fixable
  if (msg.includes("unknown field name"))
    return { fixable: true, category: "airtable_field" };
  if (msg.includes("cannot read properties"))
    return { fixable: true, category: "expression_error" };
  if (msg.includes("could not find property option"))
    return { fixable: true, category: "switch_node" };
  if (msg.includes("your request is invalid"))
    return { fixable: true, category: "airtable_request" };

  // Unknown — let the agent analyze
  return { fixable: null, category: "unknown" };
}

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

const TOOLS = [
  {
    name: "get_execution_details",
    description: `Fetch detailed execution information including error context, failed node configuration, input data, and execution path. This is ESSENTIAL - always call this first to understand what went wrong.

Returns:
- Error message and description
- HTTP status code if applicable
- Failed node name and full configuration
- Upstream node data (what was fed into the failed node) - NOTE: Large data is truncated to prevent token limits
- Execution path showing which nodes ran`,
    input_schema: {
      type: "object",
      properties: {
        execution_id: {
          type: "string",
          description: "The execution ID to fetch details for"
        }
      },
      required: ["execution_id"]
    }
  },
  {
    name: "get_workflow",
    description: "Fetch the complete workflow structure including all nodes, their configurations, and connections.",
    input_schema: {
      type: "object",
      properties: {
        workflow_id: {
          type: "string",
          description: "The workflow ID to fetch"
        }
      },
      required: ["workflow_id"]
    }
  },
  {
    name: "scan_workflow_for_pattern",
    description: `CRITICAL: After identifying a root cause, use this to find ALL nodes in the workflow with the same problematic pattern.

This prevents partial fixes where only the immediately failing node gets fixed while other nodes with the same bug remain broken.

Examples of patterns to scan for:
- Expression patterns: "$('Check Existing Record').item.json.id"
- Field references: "total_messages"
- Node references: specific node names in expressions
- Configuration patterns: missing required fields

Returns all nodes that contain the pattern, so you can fix them ALL.`,
    input_schema: {
      type: "object",
      properties: {
        workflow_id: {
          type: "string",
          description: "The workflow ID to scan"
        },
        pattern: {
          type: "string",
          description: "The exact string pattern to search for in node configurations"
        },
        pattern_type: {
          type: "string",
          enum: ["expression", "field_name", "node_reference", "config_value"],
          description: "Type of pattern being searched"
        }
      },
      required: ["workflow_id", "pattern"]
    }
  },
  {
    name: "update_node",
    description: `Update a specific node's parameters and/or top-level options in the workflow.

IMPORTANT: Only updates the specified node - all other nodes remain unchanged.

Two update modes:
1. **parameters** — The COMPLETE new parameters object for the node (replaces all parameters)
2. **node_options** — Top-level node properties like alwaysOutputData, continueOnFail, retryOnFail, maxTries, waitBetweenTries. These are set OUTSIDE the parameters object on the node itself.

You can provide parameters, node_options, or both in a single call.`,
    input_schema: {
      type: "object",
      properties: {
        workflow_id: {
          type: "string",
          description: "The workflow ID containing the node"
        },
        node_name: {
          type: "string",
          description: "The exact name of the node to update"
        },
        parameters: {
          type: "object",
          description: "The complete new parameters object for the node (optional if only updating node_options)"
        },
        node_options: {
          type: "object",
          description: "Top-level node properties to set. Valid keys: alwaysOutputData, continueOnFail, retryOnFail, maxTries, waitBetweenTries, onError, executeOnce, disabled",
          properties: {
            alwaysOutputData: { type: "boolean" },
            continueOnFail: { type: "boolean" },
            retryOnFail: { type: "boolean" },
            maxTries: { type: "number" },
            waitBetweenTries: { type: "number" },
            onError: { type: "string" },
            executeOnce: { type: "boolean" },
            disabled: { type: "boolean" }
          }
        }
      },
      required: ["workflow_id", "node_name"]
    }
  },
  {
    name: "validate_workflow",
    description: "Validate that a workflow can be loaded and executed by n8n. Call this AFTER making fixes to verify they work.",
    input_schema: {
      type: "object",
      properties: {
        workflow_id: {
          type: "string",
          description: "The workflow ID to validate"
        }
      },
      required: ["workflow_id"]
    }
  },
  {
    name: "send_slack_notification",
    description: "Send a notification to the #n8n-errors Slack channel. Use mrkdwn formatting.",
    input_schema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The Slack message to send (supports mrkdwn formatting)"
        }
      },
      required: ["message"]
    }
  },
  {
    name: "rollback_workflow",
    description: `Revert a workflow to its state before the most recent auto-fix attempt. Use this when:
- A fix made things worse
- You realize the fix was incorrect

This restores the workflow from the snapshot taken before the last update_node call.`,
    input_schema: {
      type: "object",
      properties: {
        workflow_id: {
          type: "string",
          description: "The workflow ID to rollback"
        }
      },
      required: ["workflow_id"]
    }
  },
  {
    name: "complete",
    description: "Call this when finished. Indicate whether the fix was successful and provide a summary.",
    input_schema: {
      type: "object",
      properties: {
        success: {
          type: "boolean",
          description: "Whether the error was successfully fixed"
        },
        summary: {
          type: "string",
          description: "Brief summary of what was done"
        },
        fix_description: {
          type: "string",
          description: "Concise description of what fix was applied (e.g., 'Changed Airtable operation Search to search in 5 nodes'). Used for tracking fix history to avoid repeating failed fixes."
        }
      },
      required: ["success", "summary"]
    }
  }
];

// =============================================================================
// EXPERT KNOWLEDGE SYSTEM PROMPT
// =============================================================================

const SYSTEM_PROMPT = `You are an expert n8n workflow debugger powered by Claude Opus 4.6, the most intelligent AI model. Your job is to analyze workflow errors and fix them with precision.

## Your Process (COMPREHENSIVE FIX)
1. ALWAYS start by calling get_execution_details to understand the full error context
2. **CHECK FIX HISTORY** (provided in the error info) — if previous attempts are listed, DO NOT repeat fixes that already failed. Try a completely different approach or classify as not auto-fixable.
3. Analyze the error type and determine if it's auto-fixable
4. **CRITICAL: If the error involves a pattern (expression, field reference, node reference):**
   a. Call scan_workflow_for_pattern to find ALL nodes with the same problematic pattern
   b. This prevents partial fixes where only the failing node gets fixed
5. Fix ALL affected nodes, not just the immediately failing one
6. Validate with validate_workflow after ALL fixes are applied
7. Send a Slack notification with complete results (list ALL nodes fixed)
8. Call complete() with fix_description so it's recorded in history
9. **If your fix was wrong**: Use rollback_workflow to revert your changes

## Fix History Rules (CRITICAL)
- The error info includes a "Previous Fix Attempts" section showing what was already tried
- If a fix was already attempted and FAILED, DO NOT try the same fix again
- If a fix "APPEARED TO WORK BUT RECURRED", it means validation passed but the error came back — this fix does NOT work, do NOT repeat it
- If 3+ different fixes have already failed for the same error pattern, classify as NOT auto-fixable
- Always provide a fix_description when calling complete() so future attempts know what was tried

## Recurrence Rules (CRITICAL)
- If the prompt says "RECURRING ERROR", previous fixes did NOT actually work despite passing validation
- You MUST try a fundamentally different approach — not a variation of the same fix
- "Fundamentally different" means: change the node's mappingMode, use a different node type, restructure the data flow, etc.
- If you cannot think of a genuinely different approach, call complete({success: false}) and recommend manual investigation
- NEVER apply the same schema/config fix that has already recurred

## Rollback Rules
- If you realize a fix was incorrect, use rollback_workflow to undo your changes
- This prevents stacking bad fixes on top of each other
- After rolling back, try a different approach or classify as not auto-fixable

## IMPORTANT: Comprehensive Fix Rule
When you identify a root cause like:
- Wrong node reference: "$('Check Existing Record').item.json.id" should be "$('Create or update a record').item.json.id"
- Unknown field: "total_messages" doesn't exist in Airtable
- Missing data reference: Previous node returns empty, need to reference source node

**You MUST scan the ENTIRE workflow for the same pattern before fixing.**
Other nodes likely have the same bug and will fail later if not fixed now.

Example: If "Update Handoff Status" fails because it references "$('Check Existing Record').item.json.id":
1. Get execution details → identify the bad pattern
2. SCAN: scan_workflow_for_pattern(workflow_id, "$('Check Existing Record').item.json.id")
3. Results show 3 nodes use this pattern: "Update Handoff Status", "Update Record (Preserve Status)", "Push to Clay"
4. FIX ALL 3 nodes, not just the one that happened to fail first
5. Validate, notify, complete

## Auto-Fixable Errors (YOU MUST FIX THESE)

### UNKNOWN_FIELD_NAME (Airtable)
The field doesn't exist in Airtable. Fix by removing the field from BOTH:
1. columns.value - Remove the key-value pair
2. columns.schema - Remove the object with matching id

Example fix for "Unknown field name: total_messages":
- Remove from value: "total_messages": "={{ $json.fresh_total_messages }}"
- Remove from schema: { "id": "total_messages", ... }

### INVALID_RECORDS (Airtable)
Usually means the record ID is empty/null. Common causes:
- IF node passing empty data
- Search node returning no results but alwaysOutputData: true
- Expression referencing wrong node
- Airtable Delete operation without explicit id mapping

Fix: Check the IF condition or expression that provides the record ID.
For Delete operations: MUST have "id": "={{ $json.id }}" explicitly mapped.

### Expression Errors
- Wrong property path: Fix the $json reference
- Referencing wrong node: Use $('Node Name').item.json.field
- $json is empty: Previous node returned no data, reference source node directly
- Accessing Airtable fields wrong: Use $json.fields['Field Name'], NOT $json.fieldName

### Missing resource/operation (Anthropic node)
The Anthropic node REQUIRES both resource and operation:
- Add: "resource": "text"
- Add: "operation": "message"

### Switch Node Import Error ("Could not find property option")
The Switch node v3.4 has a specific structure. Fix:
- Change rules.rules to rules.values
- Change version: 2 to version: 3 in conditions.options
- Add looseTypeValidation: true at top level

### IF Node Operator Errors
- Wrong: operator.operation: "isNotEmpty" with singleValue: true
- Correct: operator.operation: "notEmpty" (no singleValue needed)

### Zero-Output Nodes (alwaysOutputData fix)
When a search, filter, or lookup node returns 0 results, n8n outputs 0 items and ALL downstream nodes are silently skipped. This is the #1 cause of "workflow didn't complete" bugs for new/first-time data.

Symptoms: Execution shows "success" but only 2-3 nodes ran out of many. The node before the stop point shows itemsOutput: 0.

Fix: Set alwaysOutputData: true on the node (this is a TOP-LEVEL node property, NOT inside parameters). This makes it output one empty item {} instead of nothing, allowing downstream IF/Switch nodes to evaluate and route properly.

Use the update_node tool with node_options: { alwaysOutputData: true } to set this property.

Common nodes that need this:
- Airtable Search operations that may return no results (dedup checks, lookups)
- HTTP Request nodes that may return empty responses
- Filter nodes that may filter out all items
- Code nodes that conditionally return empty arrays

IMPORTANT: When adding alwaysOutputData, verify that the NEXT node properly handles the empty item (e.g., an IF node checking if $json.id is empty).

### Stale $json References (Wrong Data Source)
When nodes are inserted between a trigger and a downstream node, expressions using $json.field break because $json only contains data from the IMMEDIATELY PREVIOUS node.

Symptoms: Fields return undefined even though the trigger clearly has the data. The expression works in isolation but fails in the workflow.

Fix: Replace $json.field with $('Source Node Name').item.json.field to reference the original data source directly. Use scan_workflow_for_pattern to find ALL nodes with the same stale pattern.

Example: A node using $json.data.object.customer_name after an Airtable node will get undefined because $json now contains the Airtable record, not the Stripe trigger data. Fix: $('Stripe Trigger').item.json.data.object.customer_name

## NOT Auto-Fixable (Notify Only)
- 401/403: Authentication/credential failures
- 429/500/502/503: External API issues
- Network connectivity problems (ECONNRESET, ETIMEDOUT)
- Missing external resources
- Permission denied errors
- Credential expiration

## Lumos Expert Knowledge

### Verified Credentials (ALWAYS use these IDs)
| Service | Credential ID | Name |
|---------|--------------|------|
| Slack | uN0eQ3WPFX1KUvug | Slack account |
| Anthropic | tOV9sEG5g7qxBy3v | Lumos - Anthropic |
| OpenAI | SGBYTOrjNKrLWMao | Lumos - OpenAI |
| Airtable | nnp50zxomNRPb9PV | Airtable - Agentic |

### Verified typeVersions (MUST use these - from live instance)
| Node Type | Version |
|-----------|---------|
| n8n-nodes-base.webhook | 2.1 |
| n8n-nodes-base.httpRequest | 4.2 |
| n8n-nodes-base.code | 2 |
| n8n-nodes-base.set | 3.4 |
| n8n-nodes-base.if | 2.2 |
| n8n-nodes-base.filter | 2.2 |
| n8n-nodes-base.slack | 2.2 |
| n8n-nodes-base.airtable | 2.1 |
| n8n-nodes-base.switch | 3.4 |
| n8n-nodes-base.noOp | 1 |
| n8n-nodes-base.splitOut | 1 |
| n8n-nodes-base.gmailTrigger | 1.3 |
| @n8n/n8n-nodes-langchain.anthropic | 1 |
| @n8n/n8n-nodes-langchain.openAi | 1.6 |

### Airtable Table IDs (Content OS)
| Table | Base ID | Table ID |
|-------|---------|----------|
| Content OS Base | appP3XYuyhYRTmEDv | - |
| Reddit Posts | appP3XYuyhYRTmEDv | tblkv7c4M7RnVi11c |
| Transcripts | appP3XYuyhYRTmEDv | tblBLZeR6ZrV6IrL9 |
| LinkedIn Posts (Viral) | appP3XYuyhYRTmEDv | tbldVw24D6YnBjwqm |
| Content Queue | appP3XYuyhYRTmEDv | tbl5nA0KhexsSobz2 |
| Content Ready Queue | appP3XYuyhYRTmEDv | tbl1xc0xmffTBvgFi |
| Hook Library | appP3XYuyhYRTmEDv | tbl0jCr4oCQPqTELo |
| Brand Voice | appP3XYuyhYRTmEDv | tblDXGrmtgAp7H1bc |
| LI Conversations | app5AMIkyZZ8OOygP | tblnh62jE0TLIICCY |

### Expression Data Flow Rules (CRITICAL)
$json ONLY contains data from the IMMEDIATELY PREVIOUS node.

When to use $('Node Name').item.json.field:
- Previous node is a lookup/search that may return empty
- Previous node is an IF/Switch that doesn't carry forward data
- Previous node transforms or filters data
- After ANY Airtable operation (they only return the Airtable record)
- Any time the field you need is NOT from immediate predecessor

### Airtable Output Format (v2.1)
Airtable Update/Create operations return records with a fields wrapper:
- Record ID at top level: $json.id
- All fields nested: $json.fields['Field Name']
- WRONG: $json.fieldName or $json['Field Name']
- CORRECT: $json.fields['Field Name']

### Data Loss After Airtable Operations
Airtable Update/Create ONLY returns the Airtable record — all upstream workflow data is LOST.
When a node after Airtable needs upstream data:
- WRONG: $json.prospectName (undefined!)
- CORRECT: $('Source Node').item.json.prospectName

### IF Node with alwaysOutputData Issue
If a search node has alwaysOutputData: true, it outputs an empty item even with no results.
Checking array length will always be > 0.
FIX: Check for actual data, not just item existence:
- Wrong: $('Search Node').all().length > 0
- Right: $('Search Node').first().json.id (check for actual field)

### Airtable CRUD Operations
- Operations are CAPITALIZED: "Delete", "Update", "Create" (NOT lowercase)
- Delete REQUIRES explicit id mapping: "id": "={{ $json.id }}"
- Update uses matchingColumns: ["id"]
- ALWAYS enable typecast: true in options for reliability
- ALWAYS add retry settings: retryOnFail: true, maxTries: 3, waitBetweenTries: 2000

### Number Field Deletion Bug (Airtable)
When removing number fields from mappings, the default value (0) can persist.
If you see unexpected 0 values being written, the field needs to be removed from BOTH:
- columns.value object (remove the key-value pair)
- columns.schema array (remove the object with matching id)

### Switch Node v3.4 Structure (EXACT FORMAT)
{
  "parameters": {
    "rules": {
      "values": [  // MUST be "values", NOT "rules"
        {
          "conditions": {
            "options": {
              "version": 3,  // MUST be 3, NOT 2
              "typeValidation": "loose"
            },
            "conditions": [...],
            "combinator": "and"
          },
          "outputKey": "OutputName"
        }
      ]
    },
    "looseTypeValidation": true  // REQUIRED at top level
  },
  "typeVersion": 3.4
}

### Anthropic Node Requirements (CRITICAL)
MUST have ALL of these:
- resource: "text" (REQUIRED)
- operation: "message" (REQUIRED)
- messages.values[].role: "user" (each message needs role)
- typeVersion: 1 (NOT 1.3)
- System prompt goes in options.systemMessage, NOT in messages array

### Slack Node Attribution
ALWAYS ensure otherOptions.includeLinkToWorkflow: false
This prevents "Automate with n8n" footers in messages.

### Common Model IDs
- Claude Opus 4.6: claude-opus-4-6
- Claude Sonnet 4.5: claude-sonnet-4-5-20250929
- GPT-5.2: gpt-5.2

### Node-Level Retry Settings (for resilience)
Add to API/external nodes:
{
  "retryOnFail": true,
  "maxTries": 3,
  "waitBetweenTries": 5000,
  "continueOnFail": false  // or true for non-critical nodes
}

Recommended wait times:
- API Rate Limit: 60000ms (60s)
- Transient Network: 5000ms (5s)
- External Service: 15000ms (15s)
- Database: 2000ms (2s)

## Guardrails
- NEVER modify credentials or authentication settings
- NEVER delete nodes from a workflow
- NEVER change trigger configurations
- NEVER modify the error monitoring workflow (ID: JtMGyvm5ub4nlDxe)
- Only fix the specific error - don't refactor or "improve" other parts
- If uncertain, mark as not auto-fixable

## Slack Message Format

For FIXED errors (SINGLE NODE):
\`:white_check_mark: *Auto-Fixed: {workflow_name}*

*Error:* {error_message}
*Failed Node:* {node_name}
*Execution:* <{execution_url}|View Execution #{execution_id}>

*Fix Applied:* {specific description of what was changed}
*Validation:* Passed

_Auto-fixed by Claude Opus 4.6 at {timestamp}_\`

For FIXED errors (MULTIPLE NODES - use this when scan found related issues):
\`:white_check_mark: *Auto-Fixed: {workflow_name}* (Comprehensive)

*Original Error:* {error_message}
*Root Cause:* {pattern or issue identified}
*Execution:* <{execution_url}|View Execution #{execution_id}>

*Comprehensive Fix Applied:*
• {node_name_1}: {what was changed}
• {node_name_2}: {what was changed}
• {node_name_3}: {what was changed}

*Pattern Scan:* Found {N} nodes with same issue - all fixed
*Validation:* Passed

_Comprehensively fixed by Claude Opus 4.6 at {timestamp}_\`

For NOT FIXABLE errors:
\`:rotating_light: *Action Required: {workflow_name}*

*Error:* {error_message}
*Failed Node:* {node_name}
*Execution:* <{execution_url}|View Execution #{execution_id}>

*Why this can't be auto-fixed:* {explanation}

*Suggested manual steps:*
1. {step 1}
2. {step 2}
3. {step 3}

_Analyzed by Claude Opus 4.6 at {timestamp}_\``;

// =============================================================================
// TOOL HANDLERS
// =============================================================================

async function handleGetExecutionDetails(executionId) {
  log(`Fetching execution ${executionId}...`);

  const url = `${N8N_API_URL}/api/v1/executions/${executionId}?includeData=true`;
  const res = await fetch(url, {
    headers: { "X-N8N-API-KEY": N8N_API_KEY }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch execution: ${res.status} - ${text}`);
  }

  const execution = await res.json();

  // Build comprehensive result
  const result = {
    id: execution.id,
    workflowId: execution.workflowId,
    workflowName: execution.workflowData?.name || "Unknown",
    status: execution.status,
    startedAt: execution.startedAt,
    stoppedAt: execution.stoppedAt,
    error: null,
    failedNode: null,
    failedNodeType: null,
    failedNodeConfig: null,
    upstreamData: {},
    executionPath: []
  };

  // Extract error info
  if (execution.data?.resultData?.error) {
    const error = execution.data.resultData.error;
    result.error = {
      message: truncateString(error.message || "Unknown error", 500),
      description: truncateString(error.description || "", 500),
      httpCode: error.httpCode || "",
      context: truncateObject(error.context || {}, 200)
    };

    if (error.node) {
      result.failedNode = error.node.name;
      result.failedNodeType = error.node.type;
      result.failedNodeConfig = {
        name: error.node.name,
        type: error.node.type,
        typeVersion: error.node.typeVersion,
        parameters: truncateObject(error.node.parameters, MAX_STRING_LENGTH),
        credentials: error.node.credentials
      };
    }
  }

  // Extract execution path and upstream data (with truncation)
  if (execution.data?.resultData?.runData) {
    const runData = execution.data.resultData.runData;
    let nodeCount = 0;

    for (const [nodeName, nodeRuns] of Object.entries(runData)) {
      if (nodeRuns && nodeRuns.length > 0) {
        const lastRun = nodeRuns[nodeRuns.length - 1];

        // Add to execution path
        result.executionPath.push({
          node: nodeName,
          success: !lastRun.error,
          itemCount: lastRun.data?.main?.[0]?.length || 0
        });

        // Store sample data (truncated) - limit number of upstream nodes
        if (lastRun.data?.main?.[0] && nodeCount < MAX_UPSTREAM_NODES) {
          result.upstreamData[nodeName] = lastRun.data.main[0]
            .slice(0, MAX_UPSTREAM_ITEMS)
            .map(item => truncateObject(item.json, MAX_STRING_LENGTH));
          nodeCount++;
        }
      }
    }
  }

  // Apply token budget truncation
  const { data: truncatedResult, tokens, truncated } = truncateToTokenBudget(result);

  if (truncated) {
    truncatedResult._tokenInfo = {
      estimatedTokens: tokens,
      truncationApplied: true,
      note: "Large data was truncated to fit within token limits"
    };
  }

  log(`Execution details fetched: ~${tokens} tokens${truncated ? ' (truncated)' : ''}`);

  return truncatedResult;
}

async function handleGetWorkflow(workflowId) {
  log(`Fetching workflow ${workflowId}...`);

  const url = `${N8N_API_URL}/api/v1/workflows/${workflowId}`;
  const res = await fetch(url, {
    headers: { "X-N8N-API-KEY": N8N_API_KEY }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch workflow: ${res.status} - ${text}`);
  }

  const workflow = await res.json();

  // Truncate large node parameters (like Code nodes with long scripts)
  const truncatedNodes = workflow.nodes.map(n => ({
    id: n.id,
    name: n.name,
    type: n.type,
    typeVersion: n.typeVersion,
    parameters: truncateObject(n.parameters, 2000), // Allow longer for workflow context
    credentials: n.credentials,
    position: n.position,
    disabled: n.disabled,
    alwaysOutputData: n.alwaysOutputData
  }));

  const result = {
    id: workflow.id,
    name: workflow.name,
    active: workflow.active,
    nodes: truncatedNodes,
    connections: workflow.connections
  };

  // Check token budget
  const tokens = estimateTokens(result);
  log(`Workflow fetched: ~${tokens} tokens`);

  if (tokens > MAX_TOKEN_ESTIMATE) {
    log(`Warning: Workflow data is large (${tokens} tokens). Some truncation may occur in Claude's context.`);
  }

  return result;
}

async function handleScanWorkflowForPattern(workflowId, pattern, patternType) {
  log(`Scanning workflow ${workflowId} for pattern: "${pattern}" (${patternType || 'any'})...`);

  const url = `${N8N_API_URL}/api/v1/workflows/${workflowId}`;
  const res = await fetch(url, {
    headers: { "X-N8N-API-KEY": N8N_API_KEY }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch workflow: ${res.status} - ${text}`);
  }

  const workflow = await res.json();
  const matches = [];

  // Deep search function to find pattern in any nested object/string
  function searchInValue(value, path = []) {
    if (typeof value === 'string') {
      if (value.includes(pattern)) {
        return [{ path: path.join('.'), value: truncateString(value, 200), matchType: 'string' }];
      }
      return [];
    }
    if (Array.isArray(value)) {
      const results = [];
      value.forEach((item, index) => {
        results.push(...searchInValue(item, [...path, `[${index}]`]));
      });
      return results;
    }
    if (typeof value === 'object' && value !== null) {
      const results = [];
      for (const [key, val] of Object.entries(value)) {
        results.push(...searchInValue(val, [...path, key]));
      }
      return results;
    }
    return [];
  }

  // Scan each node
  for (const node of workflow.nodes) {
    const nodeMatches = searchInValue(node.parameters, ['parameters']);

    if (nodeMatches.length > 0) {
      matches.push({
        nodeName: node.name,
        nodeType: node.type,
        nodeId: node.id,
        occurrences: nodeMatches.map(m => ({
          location: m.path,
          currentValue: m.value
        })),
        fullParameters: truncateObject(node.parameters, 1000) // Truncate for safety
      });
    }
  }

  return {
    workflowId,
    workflowName: workflow.name,
    pattern,
    patternType: patternType || 'any',
    totalMatches: matches.length,
    affectedNodes: matches,
    recommendation: matches.length > 1
      ? `CRITICAL: Found ${matches.length} nodes with this pattern. Fix ALL of them to prevent future failures.`
      : matches.length === 1
        ? `Found 1 node with this pattern.`
        : `No nodes found with this pattern.`
  };
}

async function handleUpdateNode(workflowId, nodeName, newParameters, nodeOptions) {
  log(`Updating node "${nodeName}" in workflow ${workflowId}...`);

  // Fetch current workflow
  const getUrl = `${N8N_API_URL}/api/v1/workflows/${workflowId}`;
  const getRes = await fetch(getUrl, {
    headers: { "X-N8N-API-KEY": N8N_API_KEY }
  });

  if (!getRes.ok) {
    throw new Error(`Failed to fetch workflow for update: ${getRes.status}`);
  }

  const workflow = await getRes.json();

  // Save snapshot before modifying (for rollback)
  try {
    const snapshotFile = path.join(SNAPSHOTS_DIR, `${workflowId}-${Date.now()}.json`);
    fs.writeFileSync(snapshotFile, JSON.stringify(workflow, null, 2));
    log(`Snapshot saved: ${snapshotFile}`);
  } catch (err) {
    log(`Warning: Failed to save snapshot: ${err.message}`);
  }

  // Allowed top-level node options
  const ALLOWED_NODE_OPTIONS = [
    "alwaysOutputData", "continueOnFail", "retryOnFail",
    "maxTries", "waitBetweenTries", "onError", "executeOnce", "disabled"
  ];

  // Find and update the specific node
  let nodeFound = false;
  const updatedNodes = workflow.nodes.map(node => {
    if (node.name === nodeName) {
      nodeFound = true;
      const updated = { ...node };
      // Update parameters if provided
      if (newParameters) {
        updated.parameters = newParameters;
      }
      // Apply node-level options if provided
      if (nodeOptions) {
        for (const key of ALLOWED_NODE_OPTIONS) {
          if (nodeOptions[key] !== undefined) {
            updated[key] = nodeOptions[key];
          }
        }
      }
      return updated;
    }
    return node;
  });

  if (!nodeFound) {
    throw new Error(`Node "${nodeName}" not found in workflow`);
  }

  // Clean nodes for API
  const cleanNodes = updatedNodes.map(node => {
    const clean = {
      id: node.id,
      name: node.name,
      type: node.type,
      typeVersion: node.typeVersion,
      position: node.position,
      parameters: node.parameters || {}
    };
    if (node.credentials) clean.credentials = node.credentials;
    if (node.disabled) clean.disabled = node.disabled;
    if (node.onError) clean.onError = node.onError;
    if (node.continueOnFail) clean.continueOnFail = node.continueOnFail;
    if (node.retryOnFail) clean.retryOnFail = node.retryOnFail;
    if (node.maxTries) clean.maxTries = node.maxTries;
    if (node.waitBetweenTries) clean.waitBetweenTries = node.waitBetweenTries;
    if (node.executeOnce) clean.executeOnce = node.executeOnce;
    if (node.alwaysOutputData) clean.alwaysOutputData = node.alwaysOutputData;
    return clean;
  });

  // Clean settings
  const cleanSettings = {};
  const allowedSettings = [
    "executionOrder", "timezone", "errorWorkflow",
    "saveDataErrorExecution", "saveDataSuccessExecution",
    "saveExecutionProgress", "saveManualExecutions", "executionTimeout"
  ];
  if (workflow.settings) {
    for (const key of allowedSettings) {
      if (workflow.settings[key] !== undefined) {
        cleanSettings[key] = workflow.settings[key];
      }
    }
  }

  // Update the workflow
  const updateRes = await fetch(getUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": N8N_API_KEY
    },
    body: JSON.stringify({
      name: workflow.name,
      nodes: cleanNodes,
      connections: workflow.connections,
      settings: cleanSettings
    })
  });

  if (!updateRes.ok) {
    const text = await updateRes.text();
    throw new Error(`Failed to update workflow: ${updateRes.status} - ${text}`);
  }

  return {
    success: true,
    message: `Updated node "${nodeName}" in workflow "${workflow.name}"`
  };
}

async function handleValidateWorkflow(workflowId) {
  log(`Validating workflow ${workflowId}...`);

  // Try to fetch the workflow - if it loads without error, it's valid
  const url = `${N8N_API_URL}/api/v1/workflows/${workflowId}`;
  const res = await fetch(url, {
    headers: { "X-N8N-API-KEY": N8N_API_KEY }
  });

  if (!res.ok) {
    const text = await res.text();
    return {
      valid: false,
      error: `Workflow failed to load: ${text}`
    };
  }

  const workflow = await res.json();

  // Basic validation checks
  const issues = [];

  if (!workflow.nodes || workflow.nodes.length === 0) {
    issues.push("Workflow has no nodes");
  }

  if (!workflow.connections || Object.keys(workflow.connections).length === 0) {
    issues.push("Workflow has no connections");
  }

  // Check for nodes with missing required parameters
  for (const node of workflow.nodes || []) {
    if (node.type === "@n8n/n8n-nodes-langchain.anthropic") {
      if (!node.parameters?.resource || !node.parameters?.operation) {
        issues.push(`Anthropic node "${node.name}" missing resource/operation`);
      }
    }
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  return {
    valid: true,
    message: `Workflow "${workflow.name}" validated successfully`,
    nodeCount: workflow.nodes.length,
    connectionCount: Object.keys(workflow.connections).length
  };
}

async function handleSendSlackNotification(message) {
  log("Sending Slack notification...");

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL,
      text: message,
      mrkdwn: true
    })
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }

  return { success: true, message: "Notification sent to Slack" };
}

async function handleRollbackWorkflow(workflowId) {
  log(`Rolling back workflow ${workflowId}...`);

  // Find the most recent snapshot for this workflow
  const files = fs.readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.startsWith(`${workflowId}-`) && f.endsWith(".json"))
    .sort()
    .reverse();

  if (files.length === 0) {
    throw new Error(`No snapshots found for workflow ${workflowId}`);
  }

  const snapshotFile = path.join(SNAPSHOTS_DIR, files[0]);
  const workflow = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));

  // Clean nodes for API
  const cleanNodes = workflow.nodes.map(node => {
    const clean = {
      id: node.id,
      name: node.name,
      type: node.type,
      typeVersion: node.typeVersion,
      position: node.position,
      parameters: node.parameters || {}
    };
    if (node.credentials) clean.credentials = node.credentials;
    if (node.disabled) clean.disabled = node.disabled;
    if (node.onError) clean.onError = node.onError;
    if (node.continueOnFail) clean.continueOnFail = node.continueOnFail;
    if (node.retryOnFail) clean.retryOnFail = node.retryOnFail;
    if (node.maxTries) clean.maxTries = node.maxTries;
    if (node.waitBetweenTries) clean.waitBetweenTries = node.waitBetweenTries;
    if (node.executeOnce) clean.executeOnce = node.executeOnce;
    if (node.alwaysOutputData) clean.alwaysOutputData = node.alwaysOutputData;
    return clean;
  });

  // Clean settings
  const cleanSettings = {};
  const allowedSettings = [
    "executionOrder", "timezone", "errorWorkflow",
    "saveDataErrorExecution", "saveDataSuccessExecution",
    "saveExecutionProgress", "saveManualExecutions", "executionTimeout"
  ];
  if (workflow.settings) {
    for (const key of allowedSettings) {
      if (workflow.settings[key] !== undefined) {
        cleanSettings[key] = workflow.settings[key];
      }
    }
  }

  // Restore the workflow
  const url = `${N8N_API_URL}/api/v1/workflows/${workflowId}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": N8N_API_KEY
    },
    body: JSON.stringify({
      name: workflow.name,
      nodes: cleanNodes,
      connections: workflow.connections,
      settings: cleanSettings
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to rollback workflow: ${res.status} - ${text}`);
  }

  // Remove used snapshot
  fs.unlinkSync(snapshotFile);

  return {
    success: true,
    message: `Rolled back workflow "${workflow.name}" to snapshot from ${files[0]}`,
    snapshotUsed: files[0]
  };
}

async function executeTool(toolName, toolInput) {
  log(`Executing tool: ${toolName}`);

  try {
    switch (toolName) {
      case "get_execution_details":
        return await handleGetExecutionDetails(toolInput.execution_id);

      case "get_workflow":
        return await handleGetWorkflow(toolInput.workflow_id);

      case "scan_workflow_for_pattern":
        return await handleScanWorkflowForPattern(
          toolInput.workflow_id,
          toolInput.pattern,
          toolInput.pattern_type
        );

      case "update_node":
        return await handleUpdateNode(
          toolInput.workflow_id,
          toolInput.node_name,
          toolInput.parameters || null,
          toolInput.node_options || null
        );

      case "validate_workflow":
        return await handleValidateWorkflow(toolInput.workflow_id);

      case "send_slack_notification":
        return await handleSendSlackNotification(toolInput.message);

      case "rollback_workflow":
        return await handleRollbackWorkflow(toolInput.workflow_id);

      case "complete":
        return {
          done: true,
          success: toolInput.success,
          summary: toolInput.summary,
          fix_description: toolInput.fix_description || ""
        };

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    log(`Tool error (${toolName}): ${error.message}`);
    throw error;
  }
}

// =============================================================================
// CLAUDE API WITH TOOL USE (AGENTIC LOOP)
// =============================================================================

async function runAgentLoop(errorData, recurrence = { isRecurring: false, attemptCount: 0, previousAttempts: [] }) {
  const timestamp = errorData.timestamp || new Date().toISOString();

  // Build fix history context from persistent storage
  const history = fixHistory[errorData.workflowId] || [];
  const recentHistory = history.slice(-5);
  let historyContext = "";

  if (recurrence.isRecurring && recurrence.previousAttempts.length > 0) {
    // CRITICAL: This is a recurring error — previous "fixes" didn't actually work
    historyContext = `\n\n## ⚠️ CRITICAL: RECURRING ERROR (attempt #${recurrence.attemptCount + 1})
This EXACT error has been "fixed" ${recurrence.attemptCount} time(s) before but KEEPS COMING BACK.
The previous fixes appeared to work (passed validation) but the error recurred within 24-48 hours.

**Previous fixes that APPEARED to work but DID NOT actually fix the issue:**\n`;
    for (const h of recurrence.previousAttempts) {
      const time = new Date(h.timestamp).toLocaleDateString();
      historyContext += `- ${time}: "${h.fixAttempted}" → APPEARED TO WORK BUT RECURRED\n`;
    }
    historyContext += `
**YOU MUST NOT apply the same type of fix again.** The schema/config approach has been tried repeatedly and fails.
Either:
1. Try a FUNDAMENTALLY DIFFERENT approach (e.g., change mappingMode from "defineBelow" to "autoMapInputData", restructure the node entirely, or use a different node type)
2. Classify as NOT auto-fixable and explain why in the Slack notification — recommend specific manual investigation steps

If you cannot identify a genuinely new approach, call complete({success: false}) and explain that this requires manual investigation.\n`;
  } else if (recentHistory.length > 0) {
    historyContext = `\n\n## Previous Fix Attempts (IMPORTANT — DO NOT REPEAT FAILED FIXES)\n`;
    for (const h of recentHistory) {
      const time = new Date(h.timestamp).toISOString();
      let status;
      if (h.recurrenceDetected) {
        status = "APPEARED TO WORK BUT RECURRED";
      } else if (h.success) {
        status = "SUCCESS";
      } else {
        status = "FAILED";
      }
      historyContext += `- ${time}: "${h.fixAttempted}" → ${status} (error: ${h.errorMessage || "N/A"})\n`;
    }
    historyContext += `\nDo NOT try the same fix that already failed or recurred. Try a different approach or classify as not auto-fixable.\n`;
  }

  const messages = [
    {
      role: "user",
      content: `An n8n workflow has failed. Analyze and fix if possible.

## Error Information
- **Workflow ID**: ${errorData.workflowId}
- **Workflow Name**: ${errorData.workflowName}
- **Failed Node**: ${errorData.failedNodeName}
- **Error Message**: ${truncateString(errorData.errorMessage, 500)}
- **Execution ID**: ${errorData.executionId}
- **Execution URL**: ${errorData.executionUrl}
- **Timestamp**: ${timestamp}${historyContext}

Start by fetching the execution details to get full context about the error.`
    }
  ];

  const maxIterations = 15; // Allow more iterations for complex fixes
  let iteration = 0;
  let agentResult = { success: false, summary: "", fix_description: "" };

  while (iteration < maxIterations) {
    iteration++;
    log(`Agent iteration ${iteration}/${maxIterations}`);

    // Estimate current message size
    const messageTokens = estimateTokens(messages);
    log(`Current message context: ~${messageTokens} tokens`);

    // Call Claude Opus 4.6
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 16384,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: messages
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${text}`);
    }

    const result = await response.json();

    // Add assistant response to messages
    messages.push({
      role: "assistant",
      content: result.content
    });

    // Check if we're done
    if (result.stop_reason === "end_turn") {
      const hasToolUse = result.content.some(block => block.type === "tool_use");
      if (!hasToolUse) {
        log("Agent completed (no more tool calls)");
        break;
      }
    }

    // Process tool calls
    const toolUseBlocks = result.content.filter(block => block.type === "tool_use");

    if (toolUseBlocks.length === 0) {
      log("No tool calls, agent finished");
      break;
    }

    // Execute each tool
    const toolResults = [];
    let shouldStop = false;

    for (const toolUse of toolUseBlocks) {
      try {
        const toolResult = await executeTool(toolUse.name, toolUse.input);

        if (toolResult.done) {
          shouldStop = true;
          agentResult = {
            success: toolResult.success || false,
            summary: toolResult.summary || "",
            fix_description: toolResult.fix_description || ""
          };
          log(`Agent completed: ${toolResult.summary}`);
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(toolResult, null, 2)
        });
      } catch (error) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: error.message }),
          is_error: true
        });
      }
    }

    // Add tool results to messages
    messages.push({
      role: "user",
      content: toolResults
    });

    if (shouldStop) {
      break;
    }
  }

  if (iteration >= maxIterations) {
    log("Agent reached max iterations");
    await handleSendSlackNotification(
      `:warning: *Auto-Fix Timeout*\n\nWorkflow: ${errorData.workflowName}\nExecution: ${errorData.executionId}\n\nThe auto-fix agent reached maximum iterations without completing.\n\n_Manual investigation required._`
    );
  }

  return agentResult;
}

// =============================================================================
// CORE PROCESSING
// =============================================================================

async function processError(errorData) {
  const workflowId = errorData.workflowId;
  const workflowName = errorData.workflowName || "Unknown";
  const executionId = errorData.executionId;

  // Guard: never auto-fix the error workflow itself
  if (workflowId === ERROR_WORKFLOW_ID) {
    log(`Skipping error workflow itself (${ERROR_WORKFLOW_ID})`);
    await handleSendSlackNotification(
      `:warning: *Error Workflow Failed*\n\nThe error monitoring workflow itself encountered an error.\n*Error:* ${errorData.errorMessage}\n\n_This cannot be auto-fixed. Please check manually._`
    );
    return;
  }

  // Mark execution as processed (dedup)
  await addProcessedExecution(executionId);

  // Check circuit breaker
  if (isCircuitOpen(workflowId)) {
    log(`Circuit breaker OPEN for ${workflowName} — silently dropping`);
    return;
  }

  // Pre-classify error
  const classification = classifyError(errorData);
  if (classification.fixable === false) {
    log(`Error pre-classified as not fixable: ${classification.category} — ${classification.reason}`);

    // Record in circuit breaker
    const tripped = await recordCircuitFailure(workflowId, errorData.errorMessage);

    if (tripped) {
      await handleSendSlackNotification(
        `:no_entry: *Circuit Breaker Opened: ${workflowName}*\n\nThis workflow has failed ${CIRCUIT_BREAKER_THRESHOLD} consecutive times with auto-fix unable to resolve.\nSuppressing further notifications for 1 hour.\n\n*Last error:* ${errorData.errorMessage}\n*Category:* ${classification.category}\n*Reason:* ${classification.reason}\n\n_Manual investigation required._`
      );
    } else {
      await handleSendSlackNotification(
        `:rotating_light: *${classification.category}: ${workflowName}*\n\n*Error:* ${errorData.errorMessage}\n*Failed Node:* ${errorData.failedNodeName}\n*Reason:* ${classification.reason}\n\n_Not auto-fixable. Manual action required._`
      );
    }
    return;
  }

  // Recurrence detection: check if this error was "fixed" before but came back
  const recurrence = await detectRecurrence(workflowId, errorData.errorMessage);

  if (recurrence.isRecurring) {
    log(`RECURRENCE DETECTED for ${workflowName}: attempt #${recurrence.attemptCount + 1}`);

    // Record recurrence in circuit breaker
    const tripped = await recordCircuitRecurrence(workflowId, errorData.errorMessage);

    if (tripped) {
      // Circuit breaker opened due to recurrences — escalate and stop
      const prevFixes = recurrence.previousAttempts
        .map((a, i) => `${i + 1}. "${a.fixAttempted}" (${new Date(a.timestamp).toLocaleDateString()})`)
        .join("\n");

      await handleSendSlackNotification(
        `:no_entry: *Recurring Issue — Circuit Breaker Opened: ${workflowName}*\n\nThe error "${truncateString(errorData.errorMessage, 150)}" on node "${errorData.failedNodeName}" has been "fixed" ${recurrence.attemptCount} times but keeps returning.\n\n*Previous fix attempts (all recurred):*\n${prevFixes}\n\n*Recommendation:* This is likely a deeper issue (node version bug, n8n UI stripping config on save, or wrong fix approach). Manual investigation required.\n\n_Suppressing further auto-fix attempts for 1 hour._`
      );
      return;
    }
  }

  log(`Starting agent for: ${workflowName} (${workflowId})`);

  let agentSuccess = false;
  let agentFixDescription = "";

  try {
    const result = await runAgentLoop(errorData, recurrence);
    if (result) {
      agentSuccess = result.success || false;
      agentFixDescription = result.fix_description || result.summary || "";
    }
  } catch (error) {
    log(`Agent error: ${error.message}`);
    await handleSendSlackNotification(
      `:rotating_light: *Auto-Fix System Error*\n\nWorkflow: ${workflowName}\nOriginal Error: ${truncateString(errorData.errorMessage, 200)}\n\n*System error:* ${error.message}\n\n_Manual investigation required._`
    );
  }

  // Record fix attempt in history
  await addFixAttempt(workflowId, {
    executionId,
    errorMessage: errorData.errorMessage,
    fixAttempted: agentFixDescription || "Agent analyzed but no fix applied",
    success: agentSuccess
  });

  // Update circuit breaker — DON'T reset on self-reported success if this is a recurring error
  // The real test is whether the error comes back (checked by detectRecurrence on next occurrence)
  if (agentSuccess && !recurrence.isRecurring) {
    await resetCircuitBreaker(workflowId);
  } else if (!agentSuccess) {
    await recordCircuitFailure(workflowId, errorData.errorMessage);
  }
  // If agentSuccess && recurrence.isRecurring: leave circuit breaker as-is (pending verification)
}

// =============================================================================
// QUEUE MANAGEMENT
// =============================================================================

function isOnCooldown(workflowId) {
  const last = lastProcessed.get(workflowId);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_MS;
}

async function processNext() {
  if (processing || queue.length === 0) return;

  const errorData = queue.shift();
  const workflowId = errorData.workflowId;
  const executionId = errorData.executionId;

  // Execution-level dedup: skip if already processed
  if (processedExecutions.has(executionId)) {
    log(`Skipping already-processed execution ${executionId}`);
    processNext();
    return;
  }

  // Circuit breaker: skip if circuit is open for this workflow
  if (isCircuitOpen(workflowId)) {
    log(`Skipping ${workflowId} - circuit breaker OPEN`);
    processNext();
    return;
  }

  if (isOnCooldown(workflowId)) {
    log(`Skipping ${workflowId} - on cooldown`);
    processNext();
    return;
  }

  processing = true;
  lastProcessed.set(workflowId, Date.now());

  try {
    await processError(errorData);
  } catch (err) {
    log(`Unexpected error: ${err.message}`);
  }

  processing = false;
  processNext();
}

// =============================================================================
// BATCH NOTIFICATION SUPPRESSION
// =============================================================================

function queueAcknowledgment(errorData) {
  const key = errorData.workflowId;
  if (!pendingAcks.has(key)) {
    pendingAcks.set(key, { count: 0, errors: [], workflowName: errorData.workflowName, timer: null });
    const timer = setTimeout(() => flushAcks(key), ACK_BATCH_DELAY);
    pendingAcks.get(key).timer = timer;
  }
  const ack = pendingAcks.get(key);
  ack.count++;
  ack.errors.push(errorData.executionId);
}

async function flushAcks(workflowId) {
  const ack = pendingAcks.get(workflowId);
  if (!ack) return;
  pendingAcks.delete(workflowId);

  if (ack.count === 1) {
    await handleSendSlackNotification(
      `:gear: *Auto-Fix Server Received Error*\n\nWorkflow: ${ack.workflowName}\nExecution: ${ack.errors[0]}\n\n_Processing..._`
    );
  } else {
    await handleSendSlackNotification(
      `:gear: *Auto-Fix Server Received ${ack.count} Errors*\n\nWorkflow: ${ack.workflowName}\nExecutions: ${ack.errors.slice(0, 5).join(", ")}${ack.count > 5 ? ` (+${ack.count - 5} more)` : ""}\n\n_Processing most recent error. ${ack.count - 1} duplicates will be skipped._`
    );
  }
}

// =============================================================================
// HTTP SERVER
// =============================================================================

const server = http.createServer((req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      version: "7.0.0",
      persistence: redisAvailable ? "redis" : "memory-only",
      model: CLAUDE_MODEL,
      features: [
        "comprehensive_scan", "pattern_detection", "multi_node_fix",
        "token_truncation", "data_budget_management",
        "always_output_data_fix", "stale_json_detection", "node_options_support",
        "execution_dedup", "fix_memory", "circuit_breaker", "error_classification",
        "workflow_snapshots", "rollback", "batch_notifications",
        "recurrence_detection", "outcome_verification", "escalation_notifications"
      ],
      maxTokenEstimate: MAX_TOKEN_ESTIMATE,
      circuitBreakerThreshold: CIRCUIT_BREAKER_THRESHOLD,
      processedExecutions: processedExecutions.size,
      openCircuitBreakers: [...circuitBreakers.entries()]
        .filter(([, cb]) => cb.failures >= CIRCUIT_BREAKER_THRESHOLD)
        .map(([id]) => id),
      queueLength: queue.length,
      processing
    }));
    return;
  }

  // Bridge data endpoint for Claude Code compound engineering
  if (req.method === "GET" && req.url === "/api/bridge-data") {
    let snapshotCount = 0;
    try {
      snapshotCount = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith(".json")).length;
    } catch (e) { /* snapshots dir may not exist */ }

    const circuitBreakerState = {};
    for (const [id, cb] of circuitBreakers.entries()) {
      circuitBreakerState[id] = {
        failures: cb.failures,
        recurrences: cb.recurrences || 0,
        openedAt: cb.openedAt || null,
        lastError: cb.lastError || null,
        isOpen: cb.failures >= CIRCUIT_BREAKER_THRESHOLD || (cb.recurrences || 0) >= RECURRENCE_CIRCUIT_THRESHOLD
      };
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      fixHistory,
      circuitBreakers: circuitBreakerState,
      snapshotCount,
      processedExecutionCount: processedExecutions.size,
      generatedAt: new Date().toISOString()
    }));
    return;
  }

  // Error webhook
  if (req.method === "POST" && req.url === "/n8n-error") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const errorData = JSON.parse(body);
        const executionId = errorData.executionId;
        log(`Received error for: ${errorData.workflowName || "unknown"} (exec: ${executionId})`);

        // Execution-level dedup at the gate
        if (processedExecutions.has(executionId)) {
          log(`Dropping already-processed execution ${executionId}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ queued: false, reason: "already_processed" }));
          return;
        }

        // Circuit breaker check at the gate
        if (isCircuitOpen(errorData.workflowId)) {
          log(`Dropping error for ${errorData.workflowName} - circuit breaker OPEN`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ queued: false, reason: "circuit_breaker_open" }));
          return;
        }

        queue.push(errorData);
        queueAcknowledgment(errorData);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ queued: true, position: queue.length }));
        processNext();
      } catch (err) {
        log(`Bad request: ${err.message}`);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  // Not found
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// =============================================================================
// STARTUP
// =============================================================================

function checkConfig() {
  const missing = [];
  if (!ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!N8N_API_URL) missing.push("N8N_API_URL");
  if (!N8N_API_KEY) missing.push("N8N_API_KEY");
  if (!SLACK_BOT_TOKEN) missing.push("SLACK_BOT_TOKEN");

  if (missing.length > 0) {
    log(`WARNING: Missing required env vars: ${missing.join(", ")}`);
  }

  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    log("WARNING: Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN — persistence disabled");
  }

  log("═══════════════════════════════════════════════════════════");
  log("  n8n Auto-Fix Server v7.0.0");
  log("  Model: Claude Opus 4.6 (Most Intelligent)");
  log(`  Persistence: ${redisAvailable ? "Upstash Redis" : "IN-MEMORY ONLY (no Redis)"}`);
  log("  Features: Comprehensive scan, pattern detection, auto-fix");
  log("  Recurrence detection, outcome verification, escalation");
  log(`  Max Token Estimate: ${MAX_TOKEN_ESTIMATE}`);
  log(`  Recurrence Window: ${RECURRENCE_WINDOW_MS / 3600000}h | Circuit Threshold: ${RECURRENCE_CIRCUIT_THRESHOLD} recurrences`);
  log("═══════════════════════════════════════════════════════════");
}

// Initialize persistent storage and load state
async function startup() {
  ensureDataDirs(); // still needed for snapshots
  initRedis();

  await loadProcessedExecutions();
  await loadFixHistory();
  await loadCircuitBreakers();

  checkConfig();

  server.listen(PORT, () => {
    log(`Server listening on port ${PORT}`);
  });
}

startup().catch(err => {
  log(`FATAL: Startup failed: ${err.message}`);
  process.exit(1);
});

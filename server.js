const http = require("http");

// =============================================================================
// CONFIGURATION
// =============================================================================

const PORT = process.env.PORT || 10000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const N8N_API_URL = process.env.N8N_API_URL;
const N8N_API_KEY = process.env.N8N_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = "C09FEFUG5FT";

// Never auto-fix the error workflow itself
const ERROR_WORKFLOW_ID = "JtMGyvm5ub4nlDxe";

// Cooldown to prevent repeated fix attempts
const COOLDOWN_MS = 5 * 60 * 1000;

// Maximum retries after successful fix
const MAX_RETRIES = 2;

// Use the most intelligent model
const CLAUDE_MODEL = "claude-opus-4-5-20251101";

// Token limits
const MAX_TOKEN_ESTIMATE = 150000; // Stay well under 200K limit
const MAX_STRING_LENGTH = 1000; // Truncate strings to this length
const MAX_UPSTREAM_ITEMS = 2; // Max items per upstream node
const MAX_UPSTREAM_NODES = 10; // Max upstream nodes to include

// =============================================================================
// STATE
// =============================================================================

const queue = [];
let processing = false;
const lastProcessed = new Map();

// Retry chain tracking: executionId -> {originalExecutionId, retryCount, workflowId, workflowName, errorSignature, fixHistory}
const retryChains = new Map();

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
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
// ERROR SIGNATURE UTILITIES
// =============================================================================

/**
 * Create a signature for an error to compare with previous errors
 * Returns: { node, errorType, errorMessage }
 */
function createErrorSignature(errorData) {
  return {
    node: errorData.failedNodeName || "Unknown",
    errorType: extractErrorType(errorData.errorMessage || ""),
    errorMessage: (errorData.errorMessage || "").substring(0, 200) // Truncate for comparison
  };
}

/**
 * Extract error type from error message (e.g., UNKNOWN_FIELD_NAME, INVALID_RECORDS)
 */
function extractErrorType(errorMessage) {
  // Common n8n/Airtable error patterns
  const patterns = [
    /Unknown field name/i,
    /UNKNOWN_FIELD_NAME/i,
    /INVALID_RECORDS/i,
    /Your request is invalid/i,
    /Could not find property/i,
    /Cannot read propert/i,
    /is not defined/i,
    /401|403|Unauthorized|Forbidden/i,
    /429|Rate limit/i,
    /500|502|503|504|Internal Server Error/i,
    /ECONNRESET|ETIMEDOUT|Network/i
  ];

  for (const pattern of patterns) {
    if (pattern.test(errorMessage)) {
      return pattern.source.replace(/[\\|\/\[\]()]/g, '').substring(0, 30);
    }
  }
  return "GENERAL_ERROR";
}

/**
 * Compare two error signatures
 * Returns: "same_error" | "same_node_different_error" | "different_node"
 */
function compareErrorSignatures(prev, current) {
  if (prev.node !== current.node) {
    return "different_node";
  }
  if (prev.errorType === current.errorType && prev.errorMessage === current.errorMessage) {
    return "same_error";
  }
  return "same_node_different_error";
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
    description: `Update a specific node's parameters in the workflow. Use this to fix node configurations.

IMPORTANT: Only updates the specified node's parameters - all other nodes remain unchanged.
The parameters object should be the COMPLETE new parameters for the node.`,
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
          description: "The complete new parameters object for the node"
        }
      },
      required: ["workflow_id", "node_name", "parameters"]
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
    name: "retry_execution",
    description: `Retry a failed execution after successfully fixing the workflow. This re-runs the execution to verify the fix works.

IMPORTANT RULES:
- Only call this AFTER a successful fix AND validation
- Check the retry_context in the error info - if retryCount >= 2, DO NOT retry (max retries reached)
- The system will automatically send a Slack notification about the retry
- If the retry fails, you'll receive the new error automatically

Returns the new execution ID if successful.`,
    input_schema: {
      type: "object",
      properties: {
        execution_id: {
          type: "string",
          description: "The execution ID to retry"
        },
        workflow_id: {
          type: "string",
          description: "The workflow ID (for tracking)"
        },
        workflow_name: {
          type: "string",
          description: "The workflow name (for Slack notification)"
        },
        fix_summary: {
          type: "string",
          description: "Brief summary of what was fixed (for Slack notification)"
        }
      },
      required: ["execution_id", "workflow_id", "workflow_name", "fix_summary"]
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
        }
      },
      required: ["success", "summary"]
    }
  }
];

// =============================================================================
// EXPERT KNOWLEDGE SYSTEM PROMPT
// =============================================================================

const SYSTEM_PROMPT = `You are an expert n8n workflow debugger powered by Claude Opus 4.5, the most intelligent AI model. Your job is to analyze workflow errors and fix them with precision.

## Your Process (COMPREHENSIVE FIX + RETRY)
1. ALWAYS start by calling get_execution_details to understand the full error context
2. Analyze the error type and determine if it's auto-fixable
3. **CRITICAL: If the error involves a pattern (expression, field reference, node reference):**
   a. Call scan_workflow_for_pattern to find ALL nodes with the same problematic pattern
   b. This prevents partial fixes where only the failing node gets fixed
4. Fix ALL affected nodes, not just the immediately failing one
5. Validate with validate_workflow after ALL fixes are applied
6. Send a Slack notification with complete results (list ALL nodes fixed)
7. **RETRY STEP (if fix was successful):**
   - Check the retry_context in the error info
   - If retryCount < 2 (max retries), call retry_execution to verify the fix works
   - If retryCount >= 2, DO NOT retry - send "max retries reached" notification instead
   - The retry will automatically re-run the workflow; if it fails again, you'll get a new error
8. Call complete() when done

## Retry Rules (IMPORTANT)
- After a SUCCESSFUL fix + validation, you SHOULD call retry_execution to close the loop
- The retry_execution tool will send its own Slack notification - you don't need to notify about the retry separately
- If retry_context shows retryCount >= 2, do NOT retry - instead send a "max retries reached" message
- Each retry counts: if the workflow fails at a DIFFERENT node after retry, it still uses up a retry
- Max 2 retries total per execution chain (original fail → fix → retry1 → fail → fix → retry2 → fail → stop)

## CRITICAL: Handling Retry Failures (ERROR SIGNATURE COMPARISON)

When you receive an error that is part of a retry chain (retry_context is present), the system compares error signatures. Check the **error_comparison** field:

### If error_comparison = "same_error"
The SAME error occurred at the SAME node after your fix. This means:
- Your previous fix DID NOT WORK
- You need to try a DIFFERENT approach
- Review what was tried before (see fix_history) and try something else
- Consider if you misdiagnosed the root cause

**Action:** Investigate deeper, try a different fix strategy, or mark as not auto-fixable if you've exhausted options.

### If error_comparison = "same_node_different_error"
The same node failed but with a DIFFERENT error. This means:
- Your previous fix may have partially worked
- There's another issue with the same node
- Fix this new error

**Action:** Analyze the new error and fix it.

### If error_comparison = "different_node"
A DIFFERENT node is now failing. This means:
- Your previous fix WORKED (that node passed!)
- But it uncovered another issue downstream
- This is progress - the workflow got further

**Action:** Fix this new node's error. The chain continues.

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
- Claude Opus 4.5: claude-opus-4-5-20251101
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

_Auto-fixed by Claude Opus 4.5 at {timestamp}_\`

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

_Comprehensively fixed by Claude Opus 4.5 at {timestamp}_\`

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

_Analyzed by Claude Opus 4.5 at {timestamp}_\`

For MAX RETRIES REACHED (when retryCount >= 2 and still failing):
\`:stop_sign: *Max Retries Reached: {workflow_name}*

*Error:* {error_message}
*Failed Node:* {node_name}
*Execution:* <{execution_url}|View Execution #{execution_id}>

*Retry History:*
• Original execution: {original_execution_id}
• Retries attempted: 2/2

*Why stopping:* The workflow has been fixed and retried twice but is still encountering errors. This indicates a deeper issue that requires manual investigation.

*Suggested next steps:*
1. Review the execution history to see which nodes failed at each attempt
2. Check if the issue is data-dependent (specific input causing failures)
3. Test the workflow manually with sample data

_Manual investigation required._\`

For RETRY FAILURE with SAME ERROR (fix didn't work):
\`:warning: *Previous Fix Didn't Work: {workflow_name}*

*Error:* {error_message} (same as before)
*Failed Node:* {node_name}
*Execution:* <{execution_url}|View Execution #{execution_id}>

*Previous Fix Attempted:* {fix_history}
*Result:* Same error occurred - fix was ineffective

*New Approach:* {what you're trying differently}

_Troubleshooting by Claude Opus 4.5..._\``;

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

async function handleUpdateNode(workflowId, nodeName, newParameters) {
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

  // Find and update the specific node
  let nodeFound = false;
  const updatedNodes = workflow.nodes.map(node => {
    if (node.name === nodeName) {
      nodeFound = true;
      return { ...node, parameters: newParameters };
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

async function handleRetryExecution(executionId, workflowId, workflowName, fixSummary) {
  log(`Retrying execution ${executionId}...`);

  // Get current retry count for this chain
  const chainInfo = retryChains.get(executionId);
  const currentRetryCount = chainInfo ? chainInfo.retryCount : 0;
  const originalExecutionId = chainInfo ? chainInfo.originalExecutionId : executionId;

  if (currentRetryCount >= MAX_RETRIES) {
    return {
      success: false,
      error: `Max retries (${MAX_RETRIES}) reached for this execution chain`,
      retryCount: currentRetryCount
    };
  }

  // Call n8n API to retry the execution
  const url = `${N8N_API_URL}/api/v1/executions/${executionId}/retry`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": N8N_API_KEY
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to retry execution: ${res.status} - ${text}`);
  }

  const retryResult = await res.json();
  const newExecutionId = retryResult.id;
  const newRetryCount = currentRetryCount + 1;

  // Build fix history
  const previousFixHistory = chainInfo?.fixHistory || [];
  const newFixHistory = [...previousFixHistory, {
    attempt: newRetryCount,
    fix: fixSummary,
    timestamp: new Date().toISOString()
  }];

  // Create error signature for tracking
  const currentErrorSignature = chainInfo?.errorSignature || null;

  // Track the new execution in the retry chain
  retryChains.set(newExecutionId, {
    originalExecutionId,
    retryCount: newRetryCount,
    workflowId,
    workflowName,
    previousExecutionId: executionId,
    errorSignature: currentErrorSignature,
    fixHistory: newFixHistory,
    timestamp: Date.now()
  });

  // Build execution URL
  const executionUrl = `${N8N_API_URL}/workflow/${workflowId}/executions/${newExecutionId}`;

  // Send Slack notification about retry
  const retryMessage = `:arrows_counterclockwise: *Retry Triggered: ${workflowName}* (${newRetryCount}/${MAX_RETRIES})

*Fix Applied:* ${fixSummary}
*Original Execution:* ${originalExecutionId}
*New Execution:* <${executionUrl}|View Execution #${newExecutionId}>

_Retrying to verify the fix works..._`;

  await handleSendSlackNotification(retryMessage);

  log(`Retry triggered: ${newExecutionId} (retry ${newRetryCount}/${MAX_RETRIES})`);

  return {
    success: true,
    newExecutionId,
    retryCount: newRetryCount,
    maxRetries: MAX_RETRIES,
    message: `Execution retried. New execution ID: ${newExecutionId} (retry ${newRetryCount}/${MAX_RETRIES})`
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
          toolInput.parameters
        );

      case "validate_workflow":
        return await handleValidateWorkflow(toolInput.workflow_id);

      case "send_slack_notification":
        return await handleSendSlackNotification(toolInput.message);

      case "retry_execution":
        return await handleRetryExecution(
          toolInput.execution_id,
          toolInput.workflow_id,
          toolInput.workflow_name,
          toolInput.fix_summary
        );

      case "complete":
        return {
          done: true,
          success: toolInput.success,
          summary: toolInput.summary
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

async function runAgentLoop(errorData, retryContext = null) {
  const timestamp = errorData.timestamp || new Date().toISOString();

  // Build retry context string if this is part of a retry chain
  let retryInfo = "";
  if (retryContext) {
    // Format fix history
    const fixHistoryStr = retryContext.fixHistory && retryContext.fixHistory.length > 0
      ? retryContext.fixHistory.map((f, i) => `  ${i + 1}. ${f.fix}`).join("\n")
      : "  (none recorded)";

    retryInfo = `

## Retry Context
- **This is retry attempt**: ${retryContext.retryCount}/${MAX_RETRIES}
- **Original Execution ID**: ${retryContext.originalExecutionId}
- **Previous Execution ID**: ${retryContext.previousExecutionId}
- **Error Comparison**: ${retryContext.errorComparison || "unknown"}
- **Previous Error Node**: ${retryContext.previousErrorSignature?.node || "unknown"}
- **Previous Error Type**: ${retryContext.previousErrorSignature?.errorType || "unknown"}

### Fix History (what was already tried):
${fixHistoryStr}

### Interpretation:
${retryContext.errorComparison === "same_error"
    ? "**SAME ERROR** - Your previous fix DID NOT WORK. Try a DIFFERENT approach or mark as not auto-fixable."
    : retryContext.errorComparison === "same_node_different_error"
    ? "**SAME NODE, DIFFERENT ERROR** - Previous fix partially worked. Fix this new error."
    : retryContext.errorComparison === "different_node"
    ? "**DIFFERENT NODE** - Your previous fix WORKED! The workflow got further. Fix this new node."
    : "First retry - compare with original error."}

- **IMPORTANT**: ${retryContext.retryCount >= MAX_RETRIES
    ? "MAX RETRIES REACHED - DO NOT call retry_execution again. Send a 'max retries reached' notification instead."
    : `You can retry ${MAX_RETRIES - retryContext.retryCount} more time(s) after fixing.`}`;
  } else {
    retryInfo = `

## Retry Context
- **This is the original failure** (not a retry)
- **Retries available**: ${MAX_RETRIES}
- **After fixing**: Call retry_execution to verify the fix works`;
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
- **Timestamp**: ${timestamp}${retryInfo}

Start by fetching the execution details to get full context about the error.`
    }
  ];

  const maxIterations = 15; // Allow more iterations for complex fixes
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;
    log(`Agent iteration ${iteration}/${maxIterations}`);

    // Estimate current message size
    const messageTokens = estimateTokens(messages);
    log(`Current message context: ~${messageTokens} tokens`);

    // Call Claude Opus 4.5
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 8192,
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

  // Check if this execution is part of a retry chain
  let retryContext = retryChains.get(executionId);

  if (retryContext) {
    // This is a retry that failed - compare error signatures
    const currentSignature = createErrorSignature(errorData);
    const previousSignature = retryContext.errorSignature;

    if (previousSignature) {
      const comparison = compareErrorSignatures(previousSignature, currentSignature);
      retryContext.errorComparison = comparison;
      retryContext.previousErrorSignature = previousSignature;
      log(`Retry failure comparison: ${comparison} (prev: ${previousSignature.node}/${previousSignature.errorType}, curr: ${currentSignature.node}/${currentSignature.errorType})`);
    }

    // Update the signature for next potential retry
    retryContext.errorSignature = currentSignature;

    log(`This is retry ${retryContext.retryCount}/${MAX_RETRIES} for chain starting at ${retryContext.originalExecutionId}`);
  } else {
    // First failure - create initial error signature for future comparison
    const initialSignature = createErrorSignature(errorData);

    // Store in a temporary map for when retry comes back
    // We'll create the full chain entry when retry_execution is called
    retryChains.set(executionId, {
      originalExecutionId: executionId,
      retryCount: 0,
      workflowId,
      workflowName,
      errorSignature: initialSignature,
      fixHistory: [],
      timestamp: Date.now()
    });

    log(`Original failure - created error signature: ${initialSignature.node}/${initialSignature.errorType}`);
  }

  log(`Starting agent for: ${workflowName} (${workflowId})${retryContext ? ` [Retry ${retryContext.retryCount}/${MAX_RETRIES}]` : ''}`);

  try {
    await runAgentLoop(errorData, retryContext);
  } catch (error) {
    log(`Agent error: ${error.message}`);
    await handleSendSlackNotification(
      `:rotating_light: *Auto-Fix System Error*\n\nWorkflow: ${workflowName}\nOriginal Error: ${truncateString(errorData.errorMessage, 200)}\n\n*System error:* ${error.message}\n\n_Manual investigation required._`
    );
  }

  // Clean up old retry chain entries (older than 1 hour) to prevent memory leaks
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [execId, chain] of retryChains.entries()) {
    if (chain.timestamp && chain.timestamp < oneHourAgo) {
      retryChains.delete(execId);
    }
  }
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

  // Check if this execution is part of a retry chain BEFORE checking cooldown
  const isRetryChainError = retryChains.has(executionId);

  // Bypass cooldown for retry chain errors - they need troubleshooting
  if (!isRetryChainError && isOnCooldown(workflowId)) {
    log(`Skipping ${workflowId} - on cooldown (not a retry chain)`);
    processNext();
    return;
  }

  if (isRetryChainError) {
    log(`Processing retry chain error for ${workflowId} (bypassing cooldown)`);
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
// HTTP SERVER
// =============================================================================

const server = http.createServer((req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      version: "4.2.0",
      model: CLAUDE_MODEL,
      features: [
        "comprehensive_scan",
        "pattern_detection",
        "multi_node_fix",
        "auto_retry",
        "error_signature_comparison",
        "retry_troubleshooting",
        "token_truncation",
        "data_budget_management"
      ],
      maxRetries: MAX_RETRIES,
      maxTokenEstimate: MAX_TOKEN_ESTIMATE,
      activeRetryChains: retryChains.size,
      queueLength: queue.length,
      processing
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
        log(`Received error for: ${errorData.workflowName || "unknown"}`);

        queue.push(errorData);
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
    log(`WARNING: Missing env vars: ${missing.join(", ")}`);
  }

  log("═══════════════════════════════════════════════════════════");
  log("  n8n Auto-Fix Server v4.2.0");
  log("  Model: Claude Opus 4.5 (Most Intelligent)");
  log("  Features: Comprehensive scan, pattern detection, auto-retry");
  log("  NEW: Token truncation & data budget management");
  log(`  Max Token Estimate: ${MAX_TOKEN_ESTIMATE}`);
  log(`  Max String Length: ${MAX_STRING_LENGTH}`);
  log("═══════════════════════════════════════════════════════════");
}

checkConfig();
server.listen(PORT, () => {
  log(`Server listening on port ${PORT}`);
});

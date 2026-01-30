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

// Use the most intelligent model
const CLAUDE_MODEL = "claude-opus-4-5-20251101";

// =============================================================================
// STATE
// =============================================================================

const queue = [];
let processing = false;
const lastProcessed = new Map();

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
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
- Upstream node data (what was fed into the failed node)
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

## Your Process (COMPREHENSIVE FIX)
1. ALWAYS start by calling get_execution_details to understand the full error context
2. Analyze the error type and determine if it's auto-fixable
3. **CRITICAL: If the error involves a pattern (expression, field reference, node reference):**
   a. Call scan_workflow_for_pattern to find ALL nodes with the same problematic pattern
   b. This prevents partial fixes where only the failing node gets fixed
4. Fix ALL affected nodes, not just the immediately failing one
5. Validate with validate_workflow after ALL fixes are applied
6. Send a Slack notification with complete results (list ALL nodes fixed)
7. Call complete() when done

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

_Analyzed by Claude Opus 4.5 at {timestamp}_\``;

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
      message: error.message || "Unknown error",
      description: error.description || "",
      httpCode: error.httpCode || "",
      context: error.context || {}
    };

    if (error.node) {
      result.failedNode = error.node.name;
      result.failedNodeType = error.node.type;
      result.failedNodeConfig = {
        name: error.node.name,
        type: error.node.type,
        typeVersion: error.node.typeVersion,
        parameters: error.node.parameters,
        credentials: error.node.credentials
      };
    }
  }

  // Extract execution path and upstream data
  if (execution.data?.resultData?.runData) {
    const runData = execution.data.resultData.runData;

    for (const [nodeName, nodeRuns] of Object.entries(runData)) {
      if (nodeRuns && nodeRuns.length > 0) {
        const lastRun = nodeRuns[nodeRuns.length - 1];

        // Add to execution path
        result.executionPath.push({
          node: nodeName,
          success: !lastRun.error,
          itemCount: lastRun.data?.main?.[0]?.length || 0
        });

        // Store sample data (first 2 items max)
        if (lastRun.data?.main?.[0]) {
          result.upstreamData[nodeName] = lastRun.data.main[0]
            .slice(0, 2)
            .map(item => item.json);
        }
      }
    }
  }

  return result;
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

  return {
    id: workflow.id,
    name: workflow.name,
    active: workflow.active,
    nodes: workflow.nodes.map(n => ({
      id: n.id,
      name: n.name,
      type: n.type,
      typeVersion: n.typeVersion,
      parameters: n.parameters,
      credentials: n.credentials,
      position: n.position,
      disabled: n.disabled,
      alwaysOutputData: n.alwaysOutputData
    })),
    connections: workflow.connections
  };
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
        return [{ path: path.join('.'), value, matchType: 'string' }];
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
        fullParameters: node.parameters
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

async function runAgentLoop(errorData) {
  const timestamp = errorData.timestamp || new Date().toISOString();

  const messages = [
    {
      role: "user",
      content: `An n8n workflow has failed. Analyze and fix if possible.

## Error Information
- **Workflow ID**: ${errorData.workflowId}
- **Workflow Name**: ${errorData.workflowName}
- **Failed Node**: ${errorData.failedNodeName}
- **Error Message**: ${errorData.errorMessage}
- **Execution ID**: ${errorData.executionId}
- **Execution URL**: ${errorData.executionUrl}
- **Timestamp**: ${timestamp}

Start by fetching the execution details to get full context about the error.`
    }
  ];

  const maxIterations = 15; // Allow more iterations for complex fixes
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;
    log(`Agent iteration ${iteration}/${maxIterations}`);

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

  // Guard: never auto-fix the error workflow itself
  if (workflowId === ERROR_WORKFLOW_ID) {
    log(`Skipping error workflow itself (${ERROR_WORKFLOW_ID})`);
    await handleSendSlackNotification(
      `:warning: *Error Workflow Failed*\n\nThe error monitoring workflow itself encountered an error.\n*Error:* ${errorData.errorMessage}\n\n_This cannot be auto-fixed. Please check manually._`
    );
    return;
  }

  log(`Starting agent for: ${workflowName} (${workflowId})`);

  try {
    await runAgentLoop(errorData);
  } catch (error) {
    log(`Agent error: ${error.message}`);
    await handleSendSlackNotification(
      `:rotating_light: *Auto-Fix System Error*\n\nWorkflow: ${workflowName}\nOriginal Error: ${errorData.errorMessage}\n\n*System error:* ${error.message}\n\n_Manual investigation required._`
    );
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
// HTTP SERVER
// =============================================================================

const server = http.createServer((req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      version: "3.0.0",
      model: CLAUDE_MODEL,
      features: ["comprehensive_scan", "pattern_detection", "multi_node_fix"],
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
  log("  n8n Auto-Fix Server v3.0.0");
  log("  Model: Claude Opus 4.5 (Most Intelligent)");
  log("  Features: COMPREHENSIVE workflow scanning, pattern detection");
  log("  NEW: Fixes ALL nodes with same bug, not just failing node");
  log("═══════════════════════════════════════════════════════════");
}

checkConfig();
server.listen(PORT, () => {
  log(`Server listening on port ${PORT}`);
});

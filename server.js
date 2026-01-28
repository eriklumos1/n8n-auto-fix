const http = require("http");

// =============================================================================
// CONFIGURATION
// =============================================================================

const PORT = process.env.PORT || 10000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const N8N_API_URL = process.env.N8N_API_URL; // e.g., https://n8n-tlkm.onrender.com
const N8N_API_KEY = process.env.N8N_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = "C09FEFUG5FT"; // #n8n-errors

// Never auto-fix the error workflow itself
const ERROR_WORKFLOW_ID = "JtMGyvm5ub4nlDxe";

// Cooldown to prevent repeated fix attempts
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

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
// TOOL DEFINITIONS FOR CLAUDE
// =============================================================================

const TOOLS = [
  {
    name: "get_execution_details",
    description: "Fetch detailed execution information including the error context, failed node configuration, and input data that caused the failure. This is essential for understanding what went wrong.",
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
    description: "Fetch the complete workflow structure including all nodes and connections.",
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
    name: "update_node",
    description: "Update a specific node's parameters in the workflow. Only updates the specified node, leaving everything else unchanged.",
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
    name: "send_slack_notification",
    description: "Send a notification to the #n8n-errors Slack channel with the analysis results.",
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
    description: "Call this when you have finished analyzing and either fixed the error or determined it cannot be auto-fixed. This ends the session.",
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
// SYSTEM PROMPT WITH EXPERT KNOWLEDGE
// =============================================================================

const SYSTEM_PROMPT = `You are an expert n8n workflow debugger with deep knowledge of n8n automation patterns. Your job is to analyze workflow errors and fix them when possible.

## Your Capabilities
You have access to tools that let you:
1. Fetch execution details (including input data and error context)
2. Get the full workflow configuration
3. Update specific nodes to fix issues
4. Send Slack notifications with your analysis

## Debugging Process
1. ALWAYS start by calling get_execution_details to understand the full error context
2. If needed, call get_workflow to see the complete workflow structure
3. Analyze the error and determine if it's auto-fixable
4. If fixable: use update_node to apply the fix, then send a success notification
5. If not fixable: send a notification explaining why and what manual steps are needed
6. ALWAYS call complete() when done

## Auto-Fixable Errors (FIX THESE)
- UNKNOWN_FIELD_NAME: Airtable field was renamed/deleted → Remove the field from the node's value mapping and schema
- Expression syntax errors: Typos in $json references → Fix the expression
- Missing resource/operation: Node missing required params → Add them
- Wrong field mappings: Incorrect $json paths → Fix the path
- Type mismatches: Can be fixed with type conversion
- Empty record ID (INVALID_RECORDS): Usually an upstream data issue → Fix the IF condition or expression

## NOT Auto-Fixable Errors (NOTIFY ONLY)
- 401/403: Authentication/credential failures
- 429/500/502/503: External API issues
- Network connectivity problems
- Missing external resources (deleted Airtable bases, etc.)
- Permission/access denied

## Expert Knowledge: Lumos n8n Patterns

### Verified Working typeVersions (ALWAYS use these)
- n8n-nodes-base.webhook: 2.1
- n8n-nodes-base.httpRequest: 4.2
- n8n-nodes-base.code: 2
- n8n-nodes-base.set: 3.4
- n8n-nodes-base.if: 2.2
- n8n-nodes-base.filter: 2.2
- n8n-nodes-base.slack: 2.2
- n8n-nodes-base.airtable: 2.1
- n8n-nodes-base.switch: 3.4

### Lumos Credentials (use these IDs)
- Slack: { id: "zxjXo2rPXuHjq0Ei", name: "Lumos Slack" }
- Anthropic: { id: "tOV9sEG5g7qxBy3v", name: "Lumos - Anthropic" }
- OpenAI: { id: "SGBYTOrjNKrLWMao", name: "Lumos - OpenAI" }
- Airtable: { id: "nnp50zxomNRPb9PV", name: "Airtable - Agentic" }

### Common Airtable Fixes
When you see UNKNOWN_FIELD_NAME for a field like "total_messages":
1. Remove the field from columns.value (e.g., delete "total_messages": "={{ $json.fresh_total_messages }}")
2. Remove the field from columns.schema array (find and remove the object with id: "total_messages")

### Expression Data Flow Issues
If error involves empty data or undefined fields:
- Check if the previous node returns empty (IF nodes, search nodes with no results)
- Use explicit node references: $('Node Name').item.json.field instead of $json.field
- Check if alwaysOutputData is causing empty items to pass through

## Guardrails
- NEVER modify credentials or authentication settings
- NEVER delete nodes from a workflow
- NEVER change trigger configurations (webhooks, schedules)
- NEVER modify the error monitoring workflow itself
- Only fix the specific error, don't refactor or "improve" other parts
- If uncertain, mark as not auto-fixable and explain why

## Response Style
Be concise and specific. When sending Slack notifications:
- Use emoji indicators: :white_check_mark: for fixed, :rotating_light: for action required
- Include the specific fix applied or specific manual steps needed
- Always include execution ID for reference`;

// =============================================================================
// TOOL HANDLERS
// =============================================================================

async function handleGetExecutionDetails(executionId) {
  const url = `${N8N_API_URL}/api/v1/executions/${executionId}?includeData=true`;

  const res = await fetch(url, {
    headers: { "X-N8N-API-KEY": N8N_API_KEY }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch execution: ${res.status} - ${text}`);
  }

  const execution = await res.json();

  // Extract the most relevant information
  const result = {
    id: execution.id,
    workflowId: execution.workflowId,
    status: execution.status,
    mode: execution.mode,
    startedAt: execution.startedAt,
    stoppedAt: execution.stoppedAt,
    error: null,
    failedNode: null,
    failedNodeConfig: null,
    inputData: null
  };

  // Extract error info
  if (execution.data?.resultData?.error) {
    const error = execution.data.resultData.error;
    result.error = {
      message: error.message,
      description: error.description,
      httpCode: error.httpCode,
      node: error.node?.name,
      nodeType: error.node?.type
    };
    result.failedNode = error.node?.name;
    result.failedNodeConfig = error.node;
  }

  // Try to find input data for the failed node
  if (result.failedNode && execution.data?.resultData?.runData) {
    const runData = execution.data.resultData.runData;

    // Find the node that fed into the failed node
    for (const [nodeName, nodeRuns] of Object.entries(runData)) {
      if (nodeRuns && nodeRuns.length > 0) {
        const lastRun = nodeRuns[nodeRuns.length - 1];
        if (lastRun.data?.main?.[0]) {
          // Store first few items as context
          result.inputData = result.inputData || {};
          result.inputData[nodeName] = lastRun.data.main[0].slice(0, 3);
        }
      }
    }
  }

  return result;
}

async function handleGetWorkflow(workflowId) {
  const url = `${N8N_API_URL}/api/v1/workflows/${workflowId}`;

  const res = await fetch(url, {
    headers: { "X-N8N-API-KEY": N8N_API_KEY }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch workflow: ${res.status} - ${text}`);
  }

  const workflow = await res.json();

  // Return a cleaned version focused on what's needed for debugging
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
      position: n.position
    })),
    connections: workflow.connections
  };
}

async function handleUpdateNode(workflowId, nodeName, newParameters) {
  // First, fetch the current workflow
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
      return {
        ...node,
        parameters: newParameters
      };
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
  const updateUrl = `${N8N_API_URL}/api/v1/workflows/${workflowId}`;
  const updateRes = await fetch(updateUrl, {
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

  return { success: true, message: `Updated node "${nodeName}" in workflow "${workflow.name}"` };
}

async function handleSendSlackNotification(message) {
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

  switch (toolName) {
    case "get_execution_details":
      return await handleGetExecutionDetails(toolInput.execution_id);

    case "get_workflow":
      return await handleGetWorkflow(toolInput.workflow_id);

    case "update_node":
      return await handleUpdateNode(
        toolInput.workflow_id,
        toolInput.node_name,
        toolInput.parameters
      );

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
}

// =============================================================================
// CLAUDE API WITH TOOL USE
// =============================================================================

async function runAgentLoop(errorData) {
  const messages = [
    {
      role: "user",
      content: `An n8n workflow has failed. Please analyze and fix if possible.

## Error Information
- **Workflow ID**: ${errorData.workflowId}
- **Workflow Name**: ${errorData.workflowName}
- **Failed Node**: ${errorData.failedNodeName}
- **Error Message**: ${errorData.errorMessage}
- **Execution ID**: ${errorData.executionId}
- **Timestamp**: ${errorData.timestamp}

Start by fetching the execution details to understand what went wrong.`
    }
  ];

  const maxIterations = 10;
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;
    log(`Agent iteration ${iteration}`);

    // Call Claude
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 4096,
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

    // Check if we're done (no tool use, or stop_reason is end_turn without tools)
    if (result.stop_reason === "end_turn") {
      const hasToolUse = result.content.some(block => block.type === "tool_use");
      if (!hasToolUse) {
        log("Agent completed without tool use");
        break;
      }
    }

    // Process tool calls
    const toolUseBlocks = result.content.filter(block => block.type === "tool_use");

    if (toolUseBlocks.length === 0) {
      log("No tool calls, agent finished");
      break;
    }

    // Execute each tool and collect results
    const toolResults = [];
    let shouldStop = false;

    for (const toolUse of toolUseBlocks) {
      try {
        const toolResult = await executeTool(toolUse.name, toolUse.input);

        // Check if this is the complete tool
        if (toolResult.done) {
          shouldStop = true;
          log(`Agent completed: ${toolResult.summary}`);
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(toolResult)
        });
      } catch (error) {
        log(`Tool error (${toolUse.name}): ${error.message}`);
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
      `:warning: *Auto-Fix Timeout*\n\nWorkflow: ${errorData.workflowName}\nThe auto-fix agent reached maximum iterations without completing.\n\n_Manual investigation required._`
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

  log(`Starting agent for workflow: ${workflowName} (${workflowId})`);

  try {
    await runAgentLoop(errorData);
  } catch (error) {
    log(`Agent error: ${error.message}`);
    await handleSendSlackNotification(
      `:rotating_light: *Auto-Fix Failed*\n\nWorkflow: ${workflowName}\nError: ${errorData.errorMessage}\n\n*Agent error:* ${error.message}\n\n_Manual investigation required._`
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
    log(`Skipping ${workflowId} (${errorData.workflowName}) - on cooldown`);
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
      queueLength: queue.length,
      processing,
      version: "2.0.0"
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
    log(`WARNING: Missing environment variables: ${missing.join(", ")}`);
  }

  log("n8n Auto-Fix Server v2.0.0");
  log("Features: Tool-based agent, execution context fetching, expert n8n knowledge");
}

checkConfig();
server.listen(PORT, () => {
  log(`Server listening on port ${PORT}`);
});

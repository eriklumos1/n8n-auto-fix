const http = require("http");

// --- Configuration (from environment variables) ---
const PORT = process.env.PORT || 3456;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const N8N_API_URL = process.env.N8N_API_URL;
const N8N_API_KEY = process.env.N8N_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = "C09FEFUG5FT"; // #n8n-errors

// The error workflow itself -- never attempt to auto-fix it
const ERROR_WORKFLOW_ID = "JtMGyvm5ub4nlDxe";

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per workflow ID

// --- State ---
const queue = [];
let processing = false;
const lastProcessed = new Map();

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- API Helpers ---

async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text}`);
  }
  return res.json();
}

async function getWorkflow(workflowId) {
  const res = await fetch(`${N8N_API_URL}/api/v1/workflows/${workflowId}`, {
    headers: { "X-N8N-API-KEY": N8N_API_KEY },
  });
  if (!res.ok) throw new Error(`n8n GET workflow ${res.status}`);
  return res.json();
}

function cleanNode(node) {
  // Only include properties the n8n API accepts for a node
  const clean = {
    id: node.id,
    name: node.name,
    type: node.type,
    typeVersion: node.typeVersion,
    position: node.position,
    parameters: node.parameters || {},
  };
  if (node.credentials) clean.credentials = node.credentials;
  if (node.disabled) clean.disabled = node.disabled;
  if (node.onError) clean.onError = node.onError;
  if (node.continueOnFail) clean.continueOnFail = node.continueOnFail;
  if (node.retryOnFail) clean.retryOnFail = node.retryOnFail;
  if (node.maxTries) clean.maxTries = node.maxTries;
  if (node.waitBetweenTries) clean.waitBetweenTries = node.waitBetweenTries;
  if (node.notes) clean.notes = node.notes;
  if (node.executeOnce) clean.executeOnce = node.executeOnce;
  return clean;
}

function cleanSettings(settings) {
  if (!settings) return {};
  const allowed = [
    "executionOrder", "timezone", "errorWorkflow",
    "saveDataErrorExecution", "saveDataSuccessExecution",
    "saveExecutionProgress", "saveManualExecutions", "executionTimeout",
  ];
  const clean = {};
  for (const key of allowed) {
    if (settings[key] !== undefined) clean[key] = settings[key];
  }
  return clean;
}

async function updateWorkflow(workflowId, workflow) {
  const payload = {
    name: workflow.name,
    nodes: (workflow.nodes || []).map(cleanNode),
    connections: workflow.connections,
    settings: cleanSettings(workflow.settings),
  };

  const res = await fetch(`${N8N_API_URL}/api/v1/workflows/${workflowId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": N8N_API_KEY,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`n8n PUT workflow ${res.status}: ${text}`);
  }
  return res.json();
}

async function sendSlack(text) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text, mrkdwn: true }),
  });
  const data = await res.json();
  if (!data.ok) {
    log(`Slack API error: ${data.error}`);
  }
  return data;
}

// --- Prompt Builder ---

function buildPrompt(errorData, workflow) {
  const workflowJson = JSON.stringify(workflow, null, 2);
  return `You are an n8n workflow repair expert. A workflow has failed and you need to analyze the error and determine if you can fix it.

## Error Details
- Workflow: ${errorData.workflowName} (ID: ${errorData.workflowId})
- Failed Node: ${errorData.failedNodeName}
- Error Message: ${errorData.errorMessage}
- Execution ID: ${errorData.executionId}

## Current Workflow
${workflowJson}

## Task
Analyze the error in the context of the full workflow. Determine if the error can be fixed by modifying node configuration.

AUTO-FIXABLE errors (you should provide a fix):
- Expression syntax errors (typos, wrong property paths)
- Missing or incorrect parameter values that can be inferred
- Incorrect node configuration (wrong operation, missing required fields)
- JSON parsing errors in Code nodes
- Wrong field mappings
- Type mismatches fixable with conversion
- Missing resource or operation parameters

NOT AUTO-FIXABLE errors (report only):
- Authentication/credential failures (expired tokens, wrong API keys)
- External API downtime or rate limiting (HTTP 429, 500, 502, 503)
- Network connectivity issues
- Missing external resources (deleted databases, renamed channels)
- Data-dependent errors from external sources
- Permission/access denied errors

## Response Format
Respond with ONLY valid JSON. No markdown code fences, no extra text.

If fixable:
{"fixable":true,"explanation":"Brief description of what was wrong and what you changed","nodes":[THE COMPLETE UPDATED NODES ARRAY WITH ALL NODES]}

If not fixable:
{"fixable":false,"explanation":"Why it cannot be auto-fixed","manualSteps":["Step 1","Step 2","Step 3"]}

## Rules
- Only fix the specific error. Do not change anything else.
- Never modify credentials or authentication settings.
- Never delete nodes.
- Never change trigger node configurations.
- Return the COMPLETE nodes array (every node in the workflow, not just the changed one).
- If you are not confident the fix is correct, return fixable: false.`;
}

// --- Core Processing ---

async function processError(errorData) {
  const workflowId = errorData.workflowId;
  const workflowName = errorData.workflowName || "Unknown";
  const failedNode = errorData.failedNodeName || "Unknown";
  const errorMsg = errorData.errorMessage || "No error message";
  const executionId = errorData.executionId || "unknown";
  const timestamp = errorData.timestamp || new Date().toISOString();

  // Guard: never auto-fix the error workflow itself
  if (workflowId === ERROR_WORKFLOW_ID) {
    log(`Skipping error workflow itself (${ERROR_WORKFLOW_ID})`);
    await sendSlack(
      `:warning: *Error Workflow Failed*\n\nThe error monitoring workflow itself encountered an error.\n*Error:* ${errorMsg}\n\n_This cannot be auto-fixed. Please check the error workflow manually._`
    );
    return;
  }

  // Step 1: Fetch the workflow
  log(`Fetching workflow ${workflowId}...`);
  let workflow;
  try {
    workflow = await getWorkflow(workflowId);
  } catch (err) {
    log(`Failed to fetch workflow: ${err.message}`);
    await sendSlack(
      `:rotating_light: *Action Required: ${workflowName}*\n\n*Error:* ${errorMsg}\n*Failed Node:* ${failedNode}\n*Execution:* ${executionId}\n\n_Could not fetch workflow for analysis (${err.message}). Manual investigation required._\n\n_${timestamp}_`
    );
    return;
  }

  // Step 2: Ask Claude to analyze
  log(`Analyzing error with Claude...`);
  let analysis;
  try {
    const prompt = buildPrompt(errorData, workflow);
    const response = await callClaude(prompt);
    const content = response.content?.[0]?.text || "";

    // Parse JSON from Claude's response (strip code fences if present)
    const jsonStr = content.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
    analysis = JSON.parse(jsonStr);
  } catch (err) {
    log(`Claude analysis failed: ${err.message}`);
    await sendSlack(
      `:rotating_light: *Action Required: ${workflowName}*\n\n*Error:* ${errorMsg}\n*Failed Node:* ${failedNode}\n*Execution:* ${executionId}\n\n_Auto-analysis failed (${err.message}). Manual investigation required._\n\n_${timestamp}_`
    );
    return;
  }

  // Step 3: Act on analysis
  if (analysis.fixable && Array.isArray(analysis.nodes)) {
    // Attempt the fix
    log(`Fix identified: ${analysis.explanation}`);
    try {
      const updatedWorkflow = {
        ...workflow,
        nodes: analysis.nodes,
      };
      await updateWorkflow(workflowId, updatedWorkflow);
      log(`Workflow ${workflowId} updated successfully`);

      await sendSlack(
        `:white_check_mark: *Auto-Fixed: ${workflowName}*\n\n*Error:* ${errorMsg}\n*Failed Node:* ${failedNode}\n*Execution:* ${executionId}\n\n*Fix Applied:* ${analysis.explanation}\n\n_Auto-fixed by Claude at ${timestamp}_`
      );
    } catch (err) {
      log(`Failed to apply fix: ${err.message}`);
      await sendSlack(
        `:rotating_light: *Action Required: ${workflowName}*\n\n*Error:* ${errorMsg}\n*Failed Node:* ${failedNode}\n*Execution:* ${executionId}\n\n*Claude identified a fix:* ${analysis.explanation}\n*But could not apply it:* ${err.message}\n\n_Manual intervention required. ${timestamp}_`
      );
    }
  } else {
    // Not fixable
    const steps = Array.isArray(analysis.manualSteps)
      ? analysis.manualSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : "Check the workflow manually.";

    await sendSlack(
      `:rotating_light: *Action Required: ${workflowName}*\n\n*Error:* ${errorMsg}\n*Failed Node:* ${failedNode}\n*Execution:* ${executionId}\n\n*Why this can't be auto-fixed:* ${analysis.explanation}\n\n*Suggested steps:*\n${steps}\n\n_Analyzed by Claude at ${timestamp}_`
    );
  }
}

// --- Queue Management ---

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
  log(`Processing error for: ${errorData.workflowName} (${workflowId})`);

  try {
    await processError(errorData);
  } catch (err) {
    log(`Unexpected error processing ${workflowId}: ${err.message}`);
  }

  processing = false;
  processNext();
}

// --- HTTP Server ---

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", queueLength: queue.length, processing }));
    return;
  }

  if (req.method === "POST" && req.url === "/n8n-error") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const errorData = JSON.parse(body);
        log(`Received error for: ${errorData.workflowName || "unknown"} (${errorData.workflowId || "unknown"})`);

        if (isOnCooldown(errorData.workflowId)) {
          log(`Workflow ${errorData.workflowId} on cooldown - accepted but will skip`);
        }

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

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// --- Startup ---

function checkConfig() {
  const missing = [];
  if (!ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!N8N_API_URL) missing.push("N8N_API_URL");
  if (!N8N_API_KEY) missing.push("N8N_API_KEY");
  if (!SLACK_BOT_TOKEN) missing.push("SLACK_BOT_TOKEN");
  if (missing.length > 0) {
    log(`WARNING: Missing environment variables: ${missing.join(", ")}`);
    log("The server will start but error processing will fail.");
  }
}

checkConfig();
server.listen(PORT, () => {
  log(`Auto-fix server listening on port ${PORT}`);
});

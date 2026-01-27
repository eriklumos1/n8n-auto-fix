# n8n Auto-Fix Task

An n8n workflow has failed. Your job is to analyze the error, attempt to fix the workflow if possible, and send a Slack notification with the results.

## Error Details

- **Workflow ID**: {{WORKFLOW_ID}}
- **Workflow Name**: {{WORKFLOW_NAME}}
- **Failed Node**: {{FAILED_NODE_NAME}}
- **Error Message**: {{ERROR_MESSAGE}}
- **Execution ID**: {{EXECUTION_ID}}
- **Timestamp**: {{TIMESTAMP}}

## Instructions

### Step 1: Fetch the Workflow

Use `n8n_get_workflow` to retrieve workflow ID `{{WORKFLOW_ID}}`. Examine the full workflow structure, focusing on the failed node `{{FAILED_NODE_NAME}}`.

### Step 2: Categorize the Error

Determine if this error is **auto-fixable** or **requires manual intervention**.

**Auto-fixable errors** (you SHOULD fix these):
- Expression syntax errors (typos, wrong property paths)
- Missing or incorrect parameter values that can be inferred from context
- Incorrect node configuration (wrong operation, missing required fields)
- JSON parsing errors in Code nodes
- Wrong field mappings (e.g., referencing `$json.data` when it should be `$json.body`)
- Type mismatches that can be resolved with type conversion
- Missing `resource` or `operation` parameters on nodes that require them

**NOT auto-fixable** (send notification only):
- Authentication/credential failures (expired tokens, wrong API keys)
- External API downtime or rate limiting (HTTP 429, 500, 502, 503)
- Network connectivity issues
- Missing external resources (deleted Airtable bases, renamed Slack channels)
- Data-dependent errors (e.g., input data missing expected fields from an external source)
- Permission/access denied errors

### Step 3A: If Auto-Fixable

1. Identify the minimal change needed to fix the issue
2. Apply the fix using `n8n_update_partial_workflow`
3. Validate the updated workflow using `n8n_validate_workflow`
4. Send a Slack message to channel `C09FEFUG5FT` (#n8n-errors) with this format:

```
:white_check_mark: *Auto-Fixed: {{WORKFLOW_NAME}}*

*Error*: {{ERROR_MESSAGE}}
*Failed Node*: {{FAILED_NODE_NAME}}
*Execution*: {{EXECUTION_ID}}

*Fix Applied*: [Describe exactly what was changed]
*Validation*: Passed

_Auto-fixed by Claude Code at {{TIMESTAMP}}_
```

### Step 3B: If NOT Auto-Fixable

Send a Slack message to channel `C09FEFUG5FT` (#n8n-errors) with this format:

```
:rotating_light: *Action Required: {{WORKFLOW_NAME}}*

*Error*: {{ERROR_MESSAGE}}
*Failed Node*: {{FAILED_NODE_NAME}}
*Execution*: {{EXECUTION_ID}}

*Why this can't be auto-fixed*: [Brief explanation]
*Suggested manual steps*:
1. [Step 1]
2. [Step 2]
3. [Step 3]

_Analyzed by Claude Code at {{TIMESTAMP}}_
```

## Guardrails

- **NEVER** modify credentials or authentication settings
- **NEVER** delete nodes from a workflow
- **NEVER** change trigger configurations (webhooks, schedules, error triggers)
- **NEVER** modify more than the minimum needed to fix the specific error
- **NEVER** add new nodes unless absolutely necessary for the fix
- **ALWAYS** validate after making changes
- **ALWAYS** send a Slack notification regardless of outcome
- If uncertain whether a fix is correct, treat it as NOT auto-fixable and notify instead

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

### Step 3A: If Auto-Fixable — Pick the Right Tool

Error type decision tree:

**1. Expression syntax / typo / string value error** (escaped apostrophe, wrong field name in a template, outdated URL, typo in an Instantly merge tag)
→ Use `patch_node_field` with a minimal find/replace. Cap the `find` string to the shortest unambiguous substring. NEVER use `update_node` for these — it forces a whole-parameters rewrite and has caused data loss in the past.

**2. Node config issue** (missing `alwaysOutputData` on an empty-response node, need `retryOnFail`, wrong `continueOnFail`)
→ Use `update_node` with the `node_options` argument ONLY. Do NOT pass `parameters` — leave it unset so the existing parameters are preserved.

**3. Parameter restructuring** (wrong resource/operation, missing required param that doesn't exist yet in the node, adding a brand-new header)
→ Use `update_node` with a complete `parameters` object. **First call `get_workflow` and read the current `parameters` — then modify it and include ALL existing fields in your new object.** If you're not confident you can reproduce every field correctly, classify as NOT auto-fixable.

**4. Anything else** (unfamiliar error pattern, authentication-adjacent, external API issue, cross-node data flow)
→ Classify as NOT auto-fixable.

After any successful fix, validate with `validate_workflow` and Slack per the format below.

```
:white_check_mark: *Auto-Fixed: {{WORKFLOW_NAME}}*

*Error*: {{ERROR_MESSAGE}}
*Failed Node*: {{FAILED_NODE_NAME}}
*Execution*: {{EXECUTION_ID}}

*Tool Used*: patch_node_field | update_node(node_options) | update_node(parameters)
*Field Changed*: [field_path or parameter name]
*Diff*: `{{before}}` → `{{after}}`
*Validation*: Passed

_Auto-fixed by Claude Code at {{TIMESTAMP}}_
```

If you see `CONCURRENT_EDIT_DETECTED` from a tool, someone else edited the workflow while you were planning. **Re-read with `get_workflow` and re-plan against the fresh state — do not blindly retry.**

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

- **NEVER rewrite an entire `parameters` object when a single-string find/replace would fix the error.** Default to `patch_node_field`.
- **NEVER** modify credentials or authentication settings
- **NEVER** delete nodes from a workflow
- **NEVER** change trigger configurations (webhooks, schedules, error triggers)
- **NEVER** modify more than the minimum needed to fix the specific error
- **NEVER** add new nodes unless absolutely necessary for the fix
- **ALWAYS** validate after making changes
- **ALWAYS** send a Slack notification regardless of outcome, showing the before/after diff of what changed
- If the runtime tells you the workflow is in `FIX_EXCLUDED_WORKFLOWS`, diagnose and Slack only — the fix tools will not be available to you.
- If uncertain whether a fix is correct, treat it as NOT auto-fixable and notify instead

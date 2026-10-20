# LocalPilot diagnostics logs

LocalPilot appends one JSON object per line to `localpilot-YYYY-MM-DD.jsonl` in this folder.
Logs are written through the PC bridge (`node host/install.mjs`). Without the bridge, up to 1000 events wait in the browser and are written here once the bridge is available. Turn logging off in Settings, under "Write diagnostic logs".

Never logged: API keys or any field named like key/token/password/authorization, and screenshot pixels (only their size). Strings longer than 2000 characters are truncated. Prompts, URLs, tool inputs and short tool results **are** logged. Treat these files as private.

## Quick summary

```bash
node scripts/summarize-logs.mjs            # all days
node scripts/summarize-logs.mjs 2026-10-19 # one day
```

## Asking an AI to analyze them

Point the AI at this folder and the source, for example:

> Read D:\AI\BrowserExtension\logs\*.jsonl (format in logs/README.md) and the code in D:\AI\BrowserExtension\src. Find the most common failures (model errors, failing tools, bot checks, slow steps) and propose fixes.

## Event types

Every event has `ts` (ISO time) and `type`. Agent events share a `runId`, so you can follow one task from start to end.

| type | When | Main fields |
| --- | --- | --- |
| `sw_start` | service worker (re)started | `version` |
| `sw_error` | uncaught error or unhandled promise rejection in the service worker | `kind`, `error`, `stack` |
| `run_start` | a task starts, or is resumed with Retry | `runId`, `tabId`, `url`, `prompt`, `resumed`, `provider`, `baseUrl`, `model`, `fallbackModels`, `permissionMode`, `pcBridge`, `historyMessages` |
| `model_request` | each model call attempt | `step`, `model`, `attempt`, `ok`, `ms`, plus `usage`, `stopReason`, `toolCalls` (success) or `status`, `retryable`, `error` (failure) |
| `model_retry` | before waiting to retry | `model`, `attempt`, `delayMs`, `status` |
| `model_fallback` | switching to the next fallback model | `from`, `to` |
| `tool_call` | each tool the model ran | `step`, `name`, `input`, `ok`, `ms`, `result` (first 300 chars) or `error` |
| `bot_check` | CAPTCHA or bot check detected after a tool | `tool`, `host`, `kind`, `signals`, `url`, `title` |
| `bot_check_decision` | the user's answer to the verification card | `kind`, `decision` (`continue` / `deny`), `round` |
| `bot_check_cleared` | the check disappeared after the user handled it | `host`, `kind` |
| `bot_check_click_refused` | the model tried to click a CAPTCHA widget | `x`, `y`, `widget` |
| `boss_pause` | the BOSS recipe waits for login or verification | `reason` |
| `mcp_call` | a tool call from Claude Code or another MCP client | `name`, `input`, `ok`, `ms`, `error` |
| `run_error` | a task failed | `error`, `status`, `stack` |
| `run_end` | a task finished | `reason` (`end_turn` / `stopped` / `max_steps` / `error`), `steps`, `ms` |

`bot_check.kind` values: `recaptcha`, `hcaptcha`, `cloudflare-turnstile`, `cloudflare-challenge`, `geetest`, `arkose-funcaptcha`, `datadome`, `perimeterx`, `aliyun-slider`, `netease-yidun`, `tencent-captcha`, `aws-waf-captcha`, `slider-captcha`, `human-verification`, `press-and-hold`, `google-unusual-traffic`, `chinese-verification`, `rate-limited`, `blocked`.

The native host also keeps its own operational log in `host/localpilot-host.log` (method calls, relay start).

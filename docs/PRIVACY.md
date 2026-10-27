# Privacy and security

Short version: **LocalPilot has no account, no telemetry, and no server of its own.** Your pages go to the model server you configure — usually a model running on your own computer.

This page explains exactly what is stored, what is sent, and why each permission is needed.

---

## What leaves your computer

| Destination | When | What |
| --- | --- | --- |
| **Your model server** (the Base URL in Settings) | Every model request | The task, the page state/controls, screenshots (if enabled), and tool results needed for the step. If that URL is a cloud API, the data goes there — your choice. |
| **A search engine** (DuckDuckGo, Bing, Google, or your own URL) | When the model uses `web_search` | The search query, in a normal browser tab. |
| **Websites you visit** | Always | Normal browsing traffic in your Chrome profile. |

There is **no LocalPilot cloud, no analytics, no crash reporting, no account and no license check.** Nothing is written to any server you did not configure.

---

## What is stored on your computer

| Where | What | Cleared by |
| --- | --- | --- |
| `chrome.storage.local` (the browser profile) | Settings, approved sites, saved tasks and their last results, per-tab chats, site notes, saved values, remembered "quiet" hosts, MCP token | Removing the extension |
| `logs/localpilot-YYYY-MM-DD.jsonl` | Diagnostic events (JSON lines), only with **Write diagnostic logs** on and the PC bridge installed | Deleting the folder |
| `host/config.json` | The folders the PC bridge may use | Editing the file |
| `host/bridge.json` and the named pipe | A random token for local MCP clients; deleted when the host exits | Automatic |
| `Downloads/LocalPilot/` | Screenshots, PDFs, reports and GIFs you asked for | Deleting the folder |

API keys, bearer tokens and passwords are **redacted in logs**. Screenshot pixels are never written to logs.

---

## Permissions, and why each exists

| Permission | Why |
| --- | --- |
| `sidePanel` | The chat lives in Chrome's side panel. |
| `storage` | Settings, chats, saved tasks, approvals. |
| `tabs`, `tabGroups`, `activeTab` | Read the tab list, switch tabs, group the tabs the agent uses. |
| `scripting` | Read page structure (the accessibility tree, forms), show the working frame, inject the page helper. |
| `debugger` | Chrome's DevTools Protocol: trusted clicks/keys, screenshots, console/network reads. The same permission Claude in Chrome asks for. Chrome shows a “started debugging this browser” banner while an agent is attached. |
| `webNavigation` | Know when a page really finished loading; catch new tabs. |
| `alarms` | Saved tasks on a schedule; keepalive after a service-worker restart. |
| `notifications` | Tell you when a scheduled task needs attention. |
| `downloads` | Save PDFs, reports and GIFs with the browser's download manager. |
| `nativeMessaging` | The optional PC bridge (local files) and the MCP server for Claude Code. |
| Host permission `<all_urls>` | The agent must be able to read and act on whatever site you point it at. There is no background scraping: every action is a tool call you can see in the panel, gated by approvals. |

---

## Passwords and sensitive data

- LocalPilot **never types passwords, card numbers or government ID numbers.** If a task needs one, it asks you to do it yourself.
- **Saved values** (Settings → Saved values) are typed by placeholder (`{{email}}`), the model never sees them, they are filled only on the sites you allow, and never in password fields.
- The job-application helper fills a form and **stops before submitting** for your review.
- Page text is treated as data. The system prompt tells the model to ignore instructions embedded in pages, and a separate check judges whether a task was really completed.

---

## The PC bridge

Optional, and off unless you install it:

1. `node host/install.mjs` registers a native messaging host for Chrome.
2. It reads and writes **only** the folders listed under `roots` in `host/config.json`.
3. It only writes `.csv .json .md .txt .html .tsv`, and never overwrites an existing file unless you ask.
4. `node host/install.mjs --uninstall` removes the registration.

The bridge can run allowlisted Node scripts (`scripts` in the same config) — review that list before adding your own.

---

## MCP and Claude Code

The optional MCP server (`host/mcp-server.mjs`) talks to the extension over a **local named pipe** protected by a random token in `host/bridge.json`. Any process running as your user that can read that file could connect, so treat other local software as you would any tool with access to your browser. MCP calls run in their own unfocused “LocalPilot MCP” window and are gated by your MCP permission setting.

---

## CAPTCHA solving

The solver works **locally**: it reads the page, moves the mouse and clicks. It does not call a CAPTCHA-solving service, and it uploads nothing. Enabling it is a choice you make in Settings; disabling it restores “detect and hand over to the user”.

---

## Removing everything

1. `chrome://extensions` → remove LocalPilot (clears its storage).
2. Delete the project folder (code, logs, `host/config.json`).
3. `node host/install.mjs --uninstall` if you installed the PC bridge (do this before deleting the folder).
4. Remove `Downloads/LocalPilot` if you saved files.

---

## Threat model, in plain words

An extension with the `debugger` permission can do what you can do in a browser tab. LocalPilot's safety comes from **how it is built and how you use it**, not from Chrome sandboxing it further:

- keep the project folder somewhere only you can change;
- review changes before reloading an updated copy;
- use “Ask once per site”, not “Act without asking”, on sites with real consequences;
- keep the PC bridge roots narrow;
- remember that a local model can be wrong; the panel's Stop button and the end-of-task check exist for that.

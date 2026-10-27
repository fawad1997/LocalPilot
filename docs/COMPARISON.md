# How LocalPilot compares

LocalPilot is a Chrome extension that lets a model **you choose** drive **your own Chrome**. The two tools people compare it with most are **Claude in Chrome** (Anthropic's extension) and **Browser Use** (the open-source browser agent).

They solve overlapping problems from different directions:

- **LocalPilot**: a browser extension with a side panel, driven by a local model server (Ollama, LM Studio, llama.cpp, vLLM, LiteLLM, FreeLLMAPI) or any OpenAI/Anthropic-compatible endpoint. No account, no telemetry, optional PC file access, optional MCP server for Claude Code.
- **Claude in Chrome**: Anthropic's extension, running Claude in the cloud, for paid plans. Strong built-in knowledge of popular apps, managed safety checks, sessions that follow your account.
- **Browser Use**: an MIT-licensed Python/TypeScript **library and CLI** (plus a hosted cloud) that drives a browser with any model. Powerful and programmable; you bring the code, and stealth/CAPTCHA handling is part of its cloud browser.

> Checked against public documentation on **27 October 2026**. All three ship often; treat competitor details as a snapshot, and open an issue if something is out of date.

---

## Under the hood, LocalPilot and Claude in Chrome share the same building blocks

An inspection of Claude in Chrome (summarised in [REFERENCE.md](REFERENCE.md#what-rea-showed-about-claude-in-chrome)) found the same building blocks LocalPilot uses: an MV3 extension, a side panel, `chrome.debugger` for trusted input and screenshots, `chrome.scripting` for page access, a content script that builds a ref-tagged accessibility tree, and an overlay with a Stop button.

That is good news for users: the interaction layer is no longer the differentiator. The differences that remain are **where the model runs, what the product is allowed to do, and what it costs** — and that is where LocalPilot makes different choices (local model, open code, opt-in CAPTCHA solver, local file bridge).

---

## At a glance

| | **LocalPilot** | **Claude in Chrome** | **Browser Use** |
| --- | --- | --- | --- |
| What it is | Unpacked Chrome extension + side panel | Chrome extension + side panel | Python/TS library, CLI, and cloud service |
| Where the model runs | **Your** server: local LLM, or your own endpoint | Anthropic cloud | Any LLM you configure (OpenAI, Anthropic, Gemini, Ollama, BU2) |
| Account needed | **None** | Claude account, **paid plan** (Pro/Max/Team/Enterprise) | None for the library; a model API key; optional cloud account |
| Where page data goes | To the model server **you** run | To Anthropic (Cowork sessions are saved and synced) | To your model provider; to Browser Use Cloud if you use its browsers |
| Browser it drives | **Your normal Chrome**, your cookies and logins | Your normal Chrome | A local Chrome profile (`Browser.from_system_chrome()`) or a cloud browser |
| Human control | Per-site approvals, "ask before every action", plan mode, pause cards, Stop | Manual / Auto / Skip approvals, safety classifiers | Whatever you code (no built-in UI) |
| CAPTCHA handling | **Built-in, local, opt-in**: Turnstile, "verify you are human", reCAPTCHA/hCaptcha checkboxes, sliders, press-and-hold; hands over when it cannot pass | **Prohibited**: Anthropic lists "bypassing bot authorizations" under prohibited actions | Local library: none built-in; **cloud browsers** add stealth, residential proxies and CAPTCHA solving |
| Local / offline | Yes (local model + local browser) | No | With a local model + local browser, yes |
| Cost | Free software; you pay for hardware/model | Subscription | MIT library free; models billed by provider; cloud browsers from ~$0.02/browser-hour |
| Local files | Allowlisted folders via the optional PC bridge | Through Claude Desktop/connectors | Full filesystem through your code (Bash tool in the Claude integration) |
| Scheduling | Saved tasks: daily, weekly, interval, page watch | Scheduled tasks and shortcuts | Your own cron/code; cloud scheduling |
| Extensibility | Tools + recipes + MCP server + PC bridge | Skills, connectors, site knowledge | Custom tools, large ecosystem, benchmarks |
| Site-specific app knowledge | Generic (reads the page) + job-board recipes | **Strong**: Slack, Gmail, Calendar, Docs, GitHub, … | Generic |
| Website testing / recording | `/test` audit report + GIF, `/record`, scheduled runs | Recorded workflows (classic panel), console logs | Replay of runs, cloud recordings |
| License | TBD before publishing | Proprietary | MIT |

---

## Where LocalPilot is the better fit

### 1. Nothing leaves your computer by default

The model runs on your machine and reads pages in your browser. There is **no account, no telemetry and no vendor in the loop** — the only network calls are to the model server you configure. Claude in Chrome is cloud-only by design; Browser Use can run locally, but its convenience features (stealth browsers, CAPTCHA solving, profiles) are cloud services.

If your work involves client sites, internal tools, health/finance pages, or simply pages you would rather not hand to a vendor, this is the difference that matters.

### 2. It is a real extension on your real browser

LocalPilot lives in the side panel of **your** Chrome, with your logins, cookies and extensions. You watch every click, approve sites, and can hit Stop at any time. Browser Use is a framework: you write Python/TypeScript, and its local mode drives Chrome through automation APIs with no in-browser UI; its cloud mode uses a separate browser whose profile sync copies cookies only (not local storage or extensions).

### 3. CAPTCHA solving is built in — locally and opt-in

This is the feature neither competitor offers the same way:

- **Claude in Chrome forbids it.** Anthropic's permissions guide lists "bypassing bot authorizations" among prohibited actions, whatever approval mode you choose.
- **Browser Use leaves it to its cloud.** Stealth and CAPTCHA solving come with Browser Use Cloud browsers; the local library makes no such promise, and results vary by site.

LocalPilot's solver is off by default, runs entirely in your browser (no solving service), and **falls back to you** when a check needs a human. It loads pages with the debugger disconnected, clicks the real control — including widgets hidden in closed shadow roots — with human-shaped mouse input, and verifies success against the page's own token. See [CAPTCHA.md](CAPTCHA.md) for the sites it passed and how to reproduce each one.

### 4. Human-in-the-loop is the default, not a mode

Approvals are per site by default ("Allow once / Always allow / Deny"), there is a plan-first mode, a pause card whenever a verification appears, a Stop button on the page, and a separate model check at the end of a task that tells you whether it was actually done. Claude in Chrome has comparable approval modes; Browser Use leaves the policy to your code.

### 5. A bundled toolkit, not just a driver

Out of the box LocalPilot also gives you:

- **PC bridge** for reading/writing files in allowlisted folders (CSV exports, CV uploads, download moves);
- **Recipes** for job boards (BOSS直聘, 猎聘, 51job, 智联, LinkedIn) and a guided job-application filler that stops before submitting;
- **`/test`** — a read-only website audit with screenshots, a report and a GIF;
- **`/record`** — a captioned GIF of any task;
- **MCP server** so Claude Code (or another MCP client) can drive the same browser;
- **Saved tasks** with schedules, change detection and desktop notifications.

Browser Use gives you a driving engine and a large ecosystem; Claude in Chrome gives you connectors and app knowledge. LocalPilot gives you these workflows pre-built, with the code open to inspect.

---

## Where the others are stronger

Being honest about this is part of the product:

- **Claude in Chrome** has real advantages: built-in knowledge for Slack, Gmail, Calendar, Docs and GitHub; polished safety classifiers tuned by Anthropic; sessions that move between browser, desktop and mobile; 1Password sign-in (beta, macOS); enterprise admin controls. If you already pay for Claude and want the most polished cloud agent, it is excellent.
- **Browser Use** has a much larger community, benchmark leadership, a mature agent loop, a huge integration list, and cloud scaling with stealth browsers, proxies and CAPTCHA solving you can rent by the hour. If you need to run thousands of sessions in a data centre, it is the better foundation.
- **LocalPilot** has the opposite trade-offs: a smaller project, a self-managed local model (which is weaker than frontier cloud models at complex reasoning), an unpacked install rather than the Chrome Web Store, and a CAPTCHA solver that is a best-effort convenience rather than a guaranteed service.

---

## Choose by what you need

| If you need… | Best fit |
| --- | --- |
| Your pages and prompts to stay on your machine | **LocalPilot** (local model) |
| An agent in your side panel that you can watch and stop, with no account | **LocalPilot** |
| CAPTCHA handling on the sites you test, with a human fallback | **LocalPilot** |
| Job-search collection and application filling in one tool | **LocalPilot** |
| Deep knowledge of Slack/Gmail/Docs, managed safety, mobile+desktop sessions | **Claude in Chrome** |
| Programmatic agents inside your own Python/TS system | **Browser Use** |
| Thousands of concurrent cloud sessions with stealth and proxies | **Browser Use Cloud** |

---

## Sources

- Claude in Chrome — [Get started](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome) and [permissions guide](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide) (“Prohibited actions”, permission list, plans); architecture notes from our own inspection in [REFERENCE.md](REFERENCE.md#what-rea-showed-about-claude-in-chrome).
- Browser Use — [GitHub README](https://github.com/browser-use/browser-use), [browser-use.com](https://browser-use.com/) (open-source library, cloud browsers, CAPTCHA solving, pricing).
- LocalPilot — this repository: [REFERENCE.md](REFERENCE.md) for tools and settings, [CAPTCHA.md](CAPTCHA.md) for the solver.

*Product names and logos belong to their owners. LocalPilot is not affiliated with Anthropic, Google, or Browser Use.*

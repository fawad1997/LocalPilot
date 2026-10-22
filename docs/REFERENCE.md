# LocalPilot: full reference

A Chrome side-panel browser agent that runs on **your local LLM API**. It reads the page, clicks, types, fills forms, takes screenshots and navigates, with the same tool model as Claude in Chrome. No cloud account and no telemetry.

It is an independent implementation. The design came from studying how Claude in Chrome (v1.0.100) is built, using [REA](https://github.com/morluto/rea). No code or assets were copied from it.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked**, open `D:\AI\BrowserExtension`, and click **Select Folder**. The picker shows folders only, so the files inside are not listed. That is normal.
3. Click the toolbar icon, or press `Alt+Shift+L`, to open the side panel.
4. Set the model server in **Settings** (gear icon) and click **Test & list models**. If the server can't be reached or rejects the key, the panel says so.

**Personal defaults stay out of the code.** `src/local-defaults.json` (gitignored) supplies your machine's defaults, such as the FreeLLMAPI URL, model `auto` and API key. Copy `src/local-defaults.example.json` to start one. Settings saved in the UI override it.

## Using the panel

- **Help** (`?` icon, or type `/help`): setup status for the model server and the PC bridge, with the steps and a **Copy** button for the install command, the list of commands, and example prompts you can click to try. Clicking the **PC: off** badge opens the setup steps.
- **Commands:** type `/` in the box to see them. Built in: `/help`, `/tasks` (saved tasks), `/attach` (pick files), `/new` (new chat), `/test` (test this website for bugs), `/record <task>` (do a task and save it as a GIF). Every saved task is also a command (`/name`). Arrow keys pick, Tab completes, Enter runs.
- **Attach files:** the paperclip next to the box, drag and drop onto the panel, or paste. Up to 15 MB per file. The model gets the list of files, the text of small text files (txt, csv, json, md…) and images (when screenshots are on). It can upload an attached file into a page's file field ("Upload the attached CV to the resume field") without the PC bridge. Attached files stay available until **New chat**; they are not kept after a browser restart.

## One chat per tab

Click the toolbar icon (or press `Alt+Shift+L`) on a tab to open LocalPilot for that tab. Each tab has its own panel and its own conversation.
- The panel hides when you switch to a tab where LocalPilot was not opened, and comes back when you return.
- Runs in different tabs work at the same time. Closing a tab ends its chat.
- The panel header shows which tab the chat belongs to.

## Claude Code / MCP (phase 2)

`host/mcp-server.mjs` is an MCP server. Claude Code (or any MCP client) starts it, and it connects to your running browser:

```
Claude Code ⇄ (stdio MCP) mcp-server.mjs ⇄ (named pipe + token) native host ⇄ (native messaging) extension ⇄ browser
```

It is registered for the Jobs project (local scope), so Claude Code started in `D:\Personal Projects\Jobs` can use it:

```bash
claude mcp add localpilot -s local -- "C:\Program Files\nodejs\node.exe" "D:\AI\BrowserExtension\host\mcp-server.mjs"
claude mcp remove localpilot -s local   # undo
```

- **Tools:** Claude Code gets:
  - the browser tools (`navigate`, `computer`, `read_page`, `find`, `form_input`, `get_page_text`, `tabs_*`, `handle_dialog`, the console/network readers);
  - the capture tools, `extract_list`, `site_note`, `file_upload`, `downloads_wait`, the job-board recipes (`boss_collect_jobs`, `liepin_collect_jobs`, `job51_collect_jobs`, `zhaopin_collect_jobs`, `linkedin_collect_jobs`), the trading-research recipes (`econ_calendar_collect`, `news_collect`), the read-only Quantara tools when they are on, and `localpilot_status`.
  - The `pc_*` tools are not exposed, because Claude Code has its own file access. `apply_assist` is not exposed either: its review card and "I submitted it" confirmation live in the side panel. Neither is `quantara_halt`, which is confirmed in the side panel every time.
- **Window and tabs:** calls run in their own **unfocused window**, in a purple **LocalPilot MCP** tab group, so they never take over the window or tabs you are using. Every tool also accepts an optional `tab_id` to act on a specific tab (ids come from `tabs_context`, which can list `all_windows`).
- **Cancel and progress:**
  - Stopping a call in Claude Code (`notifications/cancelled`) stops it in the browser and frees the queue right away.
  - Long tools such as `boss_collect_jobs` send `notifications/progress` ("40 jobs collected…").
- **Reconnects:** if the extension's background worker restarts, an alarm reconnects the bridge within a minute. The MCP server waits up to 15 s for the browser before failing a call. `bridge.json` is deleted when the host exits.
- **Permissions:** Claude Code's own tool-permission prompts gate each call. The extension does not ask again (`mcpPermissionMode: 'auto'`).
- **Security:** the pipe requires a random token. The host writes that token to `%LOCALAPPDATA%\LocalPilot\bridge.json` each time it starts. Wrong tokens are rejected.
- **Requirements:** Chrome must be open with LocalPilot enabled. You can switch the bridge off in Settings ("Let Claude Code / MCP clients drive this browser").

Example, in Claude Code inside the Jobs folder:

> Use localpilot to collect 30 全栈工程师 jobs on BOSS in Shenzhen, then run evaluate-job-fit on the imported file.

## When the model server fails

Errors such as `HTTP 502 … All 2 routed attempt(s) failed` (FreeLLMAPI), 429s, 5xx, timeouts and dropped connections are retried automatically:
- **Backoff:** waits about 2, 4, 8, then 16 seconds, with jitter. If the server sends `Retry-After`, that wait is used instead. The panel shows "Retrying in Ns (2/4)…", and Stop cancels the wait.
- **Fallback models:** after the main model keeps failing, LocalPilot tries each one in Settings → "Fallback models", in order.
- **Retry button:** if everything fails, the panel shows **Retry**. It resumes from the failed step with the conversation intact; nothing is re-typed.
- **Not retried:** errors such as 400 and 401 fail straight away.

Settings: Retries per model call (default 4), Model request timeout (default 180 s), Fallback models.

## CAPTCHAs and bot checks

LocalPilot never solves, clicks or bypasses CAPTCHAs, and it does not hide that it is automation.

**When it checks:** after `navigate`, clicks, typing, key presses, `read_page`, `find`, `get_page_text`, and tab switches.

**What it looks for:**
- reCAPTCHA, hCaptcha, Cloudflare Turnstile and challenge pages, GeeTest, Arkose, DataDome, PerimeterX "Press & Hold", AWS WAF;
- Aliyun / NetEase / Tencent sliders;
- Google's "unusual traffic" page;
- Chinese 安全验证 / 人机验证 / 滑块 pages, and rate-limit or "blocked" pages.

**When it finds one:**
- **Side panel:** the agent pauses and shows an orange card: "LocalPilot paused: <site> showed a verification". Solve it yourself in the tab, then press **I've solved it, continue**. LocalPilot confirms the check is gone and tells the model to re-read the page. Press **Stop** to end the task instead.
- **Claude Code / MCP:** the tool result starts with `⚠ BOT CHECK DETECTED (…)`, so Claude Code can ask you to handle it.
- **Clicks on CAPTCHA widgets** (including inside their iframes) are refused, even if the model tries.
- The system prompt also tells the model never to attempt one.
- To get only the warning without pausing, turn off "Pause and hand over to me…" in Settings.

## Diagnostic logs

Every task writes JSON lines to `logs/localpilot-YYYY-MM-DD.jsonl` (needs the PC bridge). The log records:
- task start and end;
- every model call (model, attempt, latency, status, error);
- retries and fallbacks;
- every tool call (input, result preview, duration, error);
- bot checks and your decisions;
- MCP calls and service-worker errors.

API keys and screenshot pixels are never written. See [logs/README.md](../logs/README.md) for the format and an AI prompt. For a quick overview:

```bash
npm run logs:summary
```

## Permission modes

Pick a mode in the side panel's shield menu or in Settings. A change takes effect immediately, including during a running task.

| Mode | Behavior |
| --- | --- |
| Ask once per site (default) | Asks the first time the agent acts on a domain: Allow once, Always allow, or Deny |
| Ask every action | Asks before every action that changes something: Allow, Allow rest of task, or Deny |
| Plan, then act | The model first writes a numbered plan without using any tools. The panel shows it with **Approve**, **Edit** (change the steps, then approve) and **Cancel**. After approval it acts, asking once per site. |
| Act without asking | Bypasses all permission prompts. The shield turns red as a reminder. |

Read-only tools (`read_page`, `find`, `get_page_text`, screenshots, the tab list, the Quantara read tools, `site_note`, and `extract_list` unless it pages or saves) never ask. `quantara_halt` is the opposite: it asks every time, in every mode.

## Local servers

| Server | Base URL | Notes |
| --- | --- | --- |
| Ollama | `http://localhost:11434/v1` | Ollama rejects extension origins by default. Set `OLLAMA_ORIGINS=chrome-extension://*` and restart Ollama. |
| LM Studio | `http://localhost:1234/v1` | Start the server in the Developer tab. |
| llama.cpp | `http://localhost:8080/v1` | Run `llama-server --jinja` so tool calling works. |
| vLLM | `http://localhost:8000/v1` | Use `--enable-auto-tool-choice --tool-call-parser <parser>`. |
| LiteLLM / Anthropic-style gateway | `http://localhost:4000` | Choose the "Anthropic-compatible" API format. |

Windows (PowerShell), Ollama origins:

```powershell
setx OLLAMA_ORIGINS "chrome-extension://*"
```

**Models.** Use a model that supports tool calling. A vision model also lets the agent read screenshots: for example `qwen2.5vl`, `qwen3-vl`, `gemma3`, `llama3.2-vision` or `mistral-small3.1`. With a text-only model, turn off **Send screenshots**. The agent can still work from `read_page`, `find` and `get_page_text`. If a model writes `<tool_call>{…}</tool_call>` as text instead of using native tool calls, LocalPilot parses that too. It also repairs two common slips of small models: chat-format tokens leaking into the tool name (`wait<|channel|>commentary`) are dropped, and a computer action called as if it were a tool (`wait_for`, `scroll`, `click`) becomes the matching `computer` call.

## PC bridge (files + scripts)

A native messaging host (`host/localpilot-host.mjs`) gives the agent sandboxed access to folders on your PC. Chrome starts the host itself, and only this extension's ID may talk to it. It needs Node.js 18 or newer. The panel's Help (or a click on **PC: off**) shows the same steps.

```bash
node host/install.mjs              # register for Chrome, Edge, Brave (current user)
node host/install.mjs --uninstall  # remove the registry entries
```

The first install adds a fixed `key` to `manifest.json`, which pins the extension ID to `eaopjpgoeolndjijbelfidajiciihllh`. After installing, reload the extension in `chrome://extensions`. The side-panel header shows **PC: on** when the bridge works.

`host/config.json` controls access:
- `roots`: the folders the agent may use. The defaults are `jobs` = `D:\Personal Projects\Jobs` and `trading` = `D:\AI\Trading\quantara_v0.1\research` (for the calendar and news recipes), both writable. Job recipes use the first writable root.
- `scripts`: allowlisted Node scripts: `import-manual-jobs`, and `log-application` (marked `"internal": true`, see **Application assistant**). Internal scripts are hidden from the model's `pc_run_script` and refused there; only LocalPilot's own flows run them.

What the sandbox enforces:
- Paths must stay inside a root. Writes through `..`, absolute paths, alternate data streams, and junctions or symlinks that point outside are refused.
- The agent can only write `.csv .json .md .txt .html .tsv` files. It never overwrites a file unless asked, and it cannot create scripts.
- Scripts run with `node`, with no shell, a 2-minute timeout and capped output.
- Dotfiles and `node_modules` are hidden from directory listings.
- Every call is logged to `host/localpilot-host.log`.

PC writes and script runs go through the same permission modes as websites (e.g. "PC folder: jobs").

## Saving website data: response capture

`capture_start` records the response bodies of a site's own API calls (matched by URL substring) over CDP. `capture_save` writes the JSON items at a dot path straight to CSV or JSON on the PC, so the model never has to copy data by hand. This works for any site that loads data through XHR or fetch.

## Any list on any page → CSV: `extract_list`

For sites without a recipe (Indeed, Wellfound, a price table, a directory), `extract_list` reads the page's repeating items itself:
1. **`detect`** finds up to three lists: groups of at least 4 same-looking items with real text. Menus and pagers score low. Each comes back as `list1`… with its item selector, count and two sample rows.
2. **`extract`** returns the rows. By default each row has `title`, `link` (absolute) and `text1…n`; `fields` picks your own columns: `{"name": "h3", "price": ".price", "url": "a@href", "id": "@data-id"}`.
3. **Paging:** `pages` (max 20) with `next: "scroll"` for endless lists, or the Next control's text (`"Next"`, `"下一页"`, `"›"`). It waits between pages, stops when a page adds nothing new, and pauses on bot checks.
4. **Saving:** `save: {root, path}` writes the CSV on the PC. Rows are de-duplicated by link.

It only reads, so it needs no approval, except when it pages (acting on the site) or saves (PC folder).

## Job-board recipes → CSV

Recipes are fixed, tested flows that the model calls as one tool. They live in `src/recipes/` and are registered in `src/recipes/index.js` (`{definition, domains, approval, promptHint, run(ctx, input)}`); the tool list and the system prompt are built from that registry. Shared pieces (pauses for the user, page guards, CSV + draft output, de-duplication, the generic job-board collector) are in `src/recipes/common.js`.

Log in to the site in Chrome, open the LocalPilot side panel and ask, for example:

> Find 全栈工程师 jobs on BOSS in Wuhan, 40 jobs, and save them.
> Collect 30 Python jobs on Liepin in Shenzhen.
> Get LinkedIn Full Stack Engineer jobs in Amsterdam.

| Tool | Site | Data source | Endpoint status |
| --- | --- | --- | --- |
| `boss_collect_jobs` | BOSS直聘 zhipin.com | `/wapi/zpgeek/search/joblist.json` while scrolling | confirmed live (2026-04) |
| `liepin_collect_jobs` | 猎聘 liepin.com | `api-c.liepin.com/…pc-search-job` per page (`currentPage`) | **not yet confirmed live** |
| `job51_collect_jobs` | 前程无忧 we.51job.com | `/api/job/search-pc` per page (`pageNum`); includes the description | **not yet confirmed live** |
| `zhaopin_collect_jobs` | 智联 sou.zhaopin.com | `…/search/positions` per page (`p`) | **not yet confirmed live** |
| `linkedin_collect_jobs` | LinkedIn jobs search | Job ids from the result page itself (job links / `data-*-job-id`, scrolling the list), plus any `/voyager/api/` responses; then every `/jobs/view/<id>/` page is read | Job-page reader checked on a real public job page; signed-in search not yet confirmed live |

Each job-board recipe:
1. Reads the jobs already known: the ledger `processed-jobs.json` (ids, URLs, company + title) and every earlier `<Region>/*-manual-*.json` import (ids, links, company + title + location). Those jobs are skipped, so `max_jobs` counts **new** jobs only, and the result says how many were skipped and which files were checked. `include_seen: true` turns this off.
2. Opens the site's search page and reads the site's own API responses over CDP, scrolling or paging at a slow, human pace.
3. Opens the first `details` job pages (default: all) for the full description. 51job skips this, because its search API already has the description.
4. Writes `<Region>/<site>-<query>-<city>-<date>.csv` (UTF-8 BOM, so Excel shows Chinese correctly) and `…-draft.json`, then runs `node import-manual-jobs.mjs build <Region>/…-draft.json`. The resulting `<Region>/*-manual-<date>.json` is ready for `evaluate-job-fit` and `tailor-cv-china`.

The region folder is `China` for the Chinese sites. LinkedIn uses the country folder named in the location (`Netherlands`, `Germany`, …), else `Europe`; `out_dir` overrides it. Drafts carry the site's job id (`liepin-123`, LinkedIn's numeric id, which matches the ledger) so later runs recognise them. BOSS keeps its old ids.

**LinkedIn output.** The CSV has these columns:
- `title, company, location, workplaceType, employmentType, seniorityLevel, salary, postedAt, applicantsCount`;
- `applyType` (easy_apply / external), `applyUrl, link, jobId`;
- `industries, jobFunction, companyEmployeesCount, companyWebsite, companyLinkedinUrl, companyDescription`;
- `sponsorship, languages, yearsExperience` (sentences quoted from the description for the evaluate-job-fit gates), and the full `description`.

The draft fills the matching `import-manual-jobs` fields (seniority, employment type, applicants, apply URL, company size, website and description). Jobs whose page could not be read are marked `[Summary from the LinkedIn search list…]`, never made up. If the search finds nothing, the tool says so; the agent is told not to write job entries by hand.

**Confirming a new endpoint.** The four new recipes were built against mock sites (`tests/mock-llm.mjs`) from the sites' known API shapes. Before relying on one, log in, run a small search (`max_jobs: 5, run_import: false`) and check the CSV. If nothing is captured, find the real request: `capture_start` with a broad pattern (for example `search`) plus `read_network_requests` in a manual session. Then set `<key>ApiPattern` in settings (`liepinApiPattern`, `job51ApiPattern`, `zhaopinApiPattern`, `linkedinApiPattern`) without changing code. `<key>BaseUrl` overrides the site URL (the tests point it at the mock server).

If a site shows a login or 安全验证 page, or its API returns an error (BOSS code 37, "您的环境存在异常"), the recipe pauses and asks you to handle it in the tab. It waits up to 5 minutes. It never solves verifications itself. Scraping is against these sites' terms and fast browsing can get an account restricted, so keep `max_jobs` modest.

City names (Chinese or English) map to each site's codes: 全国, 北京, 上海, 深圳, 广州, 杭州, 武汉, 成都, 南京, 苏州, 西安, 长沙 and more. Each site's raw city code also works (BOSS 9 digits, 51job 6 digits, Liepin `dq`, Zhaopin `jl`).

## Application assistant

Open a job's application form in a tab and ask, for example:

> Fill this application for Full Stack Engineer at Acme with China/Applications/Acme_FullStack/CV_Fawad.pdf.

`apply_assist`:
1. Reads `cv_data.json` from the jobs folder and fills the form in every frame: names, email, phone, LinkedIn / GitHub / website, city, country, nationality, current title, and summary or cover letter (text areas only). Extra answers can be passed by label (`answers: {"notice period": "1 month"}`).
2. Leaves alone: fields that already have a value, password / passport / ID / bank fields, and personal decisions (salary, gender, birth date, marital status) unless you gave an answer.
3. Attaches the tailored CV PDF to the CV / resume file input.
4. **Stops.** It never submits. After `apply_assist`, a guard refuses clicks on Submit / Apply / 投递 / 提交 buttons, Enter in a form field, and `javascript_tool` on that site, even if the model tries or you ask it to.
5. Shows a card in the side panel: what was filled, what was left for you, and the upload. Review the form, press Submit yourself, then press **I submitted it — log it**. Only then does LocalPilot run the internal `log-application` script, which adds the application to `application_tracker.json` (through `lib/tracker-utils.mjs`; same-day duplicates are ignored). **Not submitted** discards it.

`log-application.mjs` lives in the Jobs folder; its source is `host/jobs-scripts/log-application.mjs`. Limit: the Submit guard checks the top page and same-origin iframes; for a form inside a cross-origin iframe it relies on the system-prompt rule.

## Trading: Quantara

LocalPilot can read **Quantara** (`D:\AI\Trading\quantara_v0.1`), the local MT5 bot, through its own dashboard API at `http://127.0.0.1:8787`. Turn it on in **Settings → Quantara** and press **Test**. The bot must be running (`scripts\7_run_bot.bat`, or `6_run_simulation.bat` for a simulated market).

| Tool | Reads | Use it for |
| --- | --- | --- |
| `quantara_status` | `/api/state` | Running and allowed to trade? Why not? Today's P/L, open positions, risk state, emergency stop, stopped symbols, next news event |
| `quantara_trades` | `/api/trades/today`, `/api/analysis/losses` | Trades closed today, or losing trades over a period |
| `quantara_analysis` | `/api/candidates/summary`, `/api/analysis/{sessions, blocked, losses, portfolio, scoreboard}` | "Why is it not trading more?" (the reasons, biggest first), results per session or hour, refused signals, per-strategy scoreboard |
| `quantara_research` | `/api/research/lab` | The research lab's latest verdict per symbol and strategy |
| `quantara_halt` | `POST /api/control/halt` | Emergency stop (no new entries). Only with the dashboard token set; see below |

- **Plain words.** Codes such as `SPREAD_TOO_LARGE_VS_STOP` come with the dashboard's own glossary text ("The broker's gap would eat the trade").
- **Small results.** The model gets a trimmed summary of a few KB. The MT5 login and server name are never passed on.
- **Rules for the model:**
  - quote numbers as returned;
  - no trading or investment advice, price predictions or settings recommendations;
  - fewer than 30 trades in a group is "not enough data yet", the same rule as Quantara's own Analysis page.
- **Read-only, except one button.** Nothing here can resume trading, close positions, start or stop symbols or change settings; those stay on Quantara's dashboard. With `DASHBOARD_TOKEN` (from Quantara's `.env`) entered in Settings, the agent also gets `quantara_halt`:
  - it asks **every time**, with only Allow / Deny, even in "Act without asking" mode or after "Allow rest of task";
  - scheduled runs and MCP clients can never use it;
  - resuming is done by you on the dashboard.
- **Localhost only.** The URL must be `127.0.0.1`, `localhost` or `[::1]`, matching Quantara's own rule.

**Morning check.** Save a task `quantara-morning` with "Check Quantara: is it ready to trade, today's P/L, and why it isn't trading more", **on weekdays at** 07:45. The answer arrives as a desktop notification. With **Notify: only when it contains…** `halted`, you hear about it only when something stopped it.

### Research data for Quantara (PC root `trading`)

Both recipes write to `D:\AI\Trading\quantara_v0.1\research\datasets\`. They never place, gate or suggest trades.

- **`econ_calendar_collect`**: the economic calendar from ForexFactory, week by week, `from`/`to` up to two years per run. Default: USD, high impact (Quantara's `events` defaults).
  - **Why:** Quantara's backtests read news times from its `economic_events` table. That table only had a few future FOMC dates plus the current week, so 2024–2026 backtests ran without real news blocking.
  - **Output:**
    - `calendar_<from>_<to>.csv`: `datetime_utc,currency,impact,title`, without a BOM, because Quantara reads it as plain UTF-8;
    - `…_detailed.csv`: adds actual, forecast, previous, and all-day or tentative events.
  - **Next step:** the result gives the command, `python -m app.main import-events research/datasets/calendar_….csv`. You or Claude Code run it in the Quantara folder; the PC bridge only runs Node.
  - **Times:**
    - They come from the page's own calendar data (epoch seconds) when present. Otherwise they come from the table, with the time zone worked out from releases whose New York time never changes (NFP, CPI, retail sales, claims at 8:30; FOMC at 14:00).
    - Either way, those releases must land on their New York time (DST included), or nothing is written. If a week has no such release and the page's zone is unknown, pass `page_utc_offset`.
  - **Pace and checks:** it pauses 3–6 s between weeks and pauses for you on Cloudflare checks.
  - **Live status:** the real page's calendar data was checked on 2026-10-20. The fields match, and the week of Sep 27 2026 has NFP, the unemployment rate and core PCE at 12:30 UTC. A full run through the extension has not been done yet: run one past month first.
- **`news_collect`**: recent headlines tagged by symbol, appended to `news_<date>.csv` (`published_utc, source, symbol_tags, headline, url, summary`).
  - **Sources:** the Fed, ECB, FXStreet and Investing.com forex RSS feeds by default, each checked on 2026-10-20. Settings → Quantara → News feeds replaces the list; `pages` also reads news-list pages in the tab.
  - **Tags:** keyword lists per symbol (`XAUUSD`: gold, bullion…; `USD`: Fed, FOMC, CPI, payrolls…). Broker names like `XAUUSDm` work. Words must match whole, so "federation" is not "Fed".
  - **De-duplication:** by URL across the day's file.

## Saved tasks and schedules

The bookmark icon in the panel header opens **Saved tasks**: a name, a prompt and an optional start URL (**Use this tab's URL** fills it in).
- **Run from the composer:** type `/name` (plus optional extra words, which are added to the prompt). The panel's tab goes to the start URL first. **Run** in the list does the same.
- **Schedule ("Run"):** only when you run it, every day at a time, on weekdays at a time (skips Saturday and Sunday), or every N minutes (at least 15). A `chrome.alarms` alarm runs the task in its own unfocused window, and a desktop notification reports the result.
- **Notify:**
  - **after every run** (default);
  - **only when the result changes**: compared with the last run's answer, best for page watches;
  - **only when it contains…** a word, and only when the result changed, so a word that stays on the page notifies once.
  - Failed runs always notify. Editing a task starts a new baseline.
- **Page watch, no AI:**
  - Tick it and give the start URL (plus an optional CSS selector). The task then never calls the model: it opens the page, reads the text, and compares it with the last run.
  - The notification lists the first changed lines ("Changed: Price: 250"). The first run saves the baseline.
  - Good for a careers page, a job alert list or a price, every 30 minutes, at no model cost.
- **Scheduled runs ask nothing.** They use the sites you approved with **Always allow** (or "Act without asking" mode). If a step needs a site that is not approved, it is not done, the notification says "needs attention" and names the site, and the window stays open. Run the task once from the panel and choose **Always allow** to fix that. Verification pages also leave the window open for you. Tools that ask every time (`quantara_halt`) are refused.
- The last run's time, status and answer show in the list.

Examples:
- A task `wuhan-jobs` with "Collect 30 new 全栈工程师 jobs on BOSS in Wuhan and Shenzhen", daily at 08:00.
- A watch `acme-careers` on `https://acme.com/careers`, selector `.openings`, every 60 min, notify on change.

## Testing mode: `test_website`

`/test` in the panel (or "Test this website for bugs") runs `test_website`. It is a read-only crawler on the site of the current tab or `url`.

**What it does on each page** (up to `max_pages`, default 8, max 40, same origin only):
1. Opens the page and waits for it to settle, then 1.2 s more for late errors.
2. Reads the console and network capture for that page:
   - console errors, uncaught exceptions;
   - failed requests (4xx/5xx or network errors, ignoring aborted and ad-blocked ones);
   - the page's own HTTP status.
3. Audits the page itself:
   - broken images, images without alt text;
   - visible bug text (`undefined`, `NaN`, `[object Object]`, `{{ template }}`, `${…}`), placeholder "Lorem ipsum";
   - form fields without a label, buttons without a name, links without text;
   - duplicate ids, missing title / h1 / viewport / lang;
   - insecure `http` resources on `https` pages, horizontal overflow, load time over 3 s.
4. Outlines the problem elements in red, then takes a viewport shot (for the GIF) and a full-page shot (up to 4000 px, for the report).
5. **Phone check** (`mobile`, default on): emulates a 390 × 844 phone, reports when the page is wider than the screen (and which element sticks out), and takes a phone screenshot.

**After the crawl:**
- **Link check:** up to `check_links` links (default 60, max 300) get HEAD (GET when HEAD is refused), 4 at a time. Broken internal links are errors; external 404/410 are warnings; 403/429 from other sites are ignored as bot protection.
- **Files:**
  - `Downloads/LocalPilot/test-<host>-<time>.html`: a self-contained report with summary cards, problems by type with plain-language explanations, the GIF, and every page with screenshots and its problems;
  - `…gif`: the recording.
- **Report tab:** the report opens in a new tab (`open_report`, not for MCP calls). `save_to: {root, path}` also copies both files into a PC root.
- **Result for the model:** counts and the 30 most serious problems, so it can explain them.

**Safety:** it only opens pages with GET. It never types, fills or submits forms, and it skips links that look like log-out, delete, unsubscribe, add-to-cart, checkout, pay or order, plus file downloads. Bot checks pause for the user as everywhere else. Acting on the site needs the normal site approval.

**Limits:** examples are capped at 8 per problem type per page; the count still includes all of them. The phone check uses Chrome's device emulation and clears it afterwards.

## GIF recording: `gif_recorder`

Recording works without the PC bridge. Files go to `Downloads/LocalPilot/` through `chrome.downloads`.

- **`gif_recorder`** has four actions:
  - `start` (with a `title`) begins recording and captures the current page.
  - While recording, a frame is captured after every click, typing, key press, scroll, drag, navigation, new or switched tab, form fill, upload and dialog answer.
  - `export` stops and saves the GIF (`filename`, optional `save_to`).
  - `cancel` discards the recording; `status` counts the frames.
- **Frames:**
  - 800 px wide, with a dark caption bar: the step number, the action (`Click "Add to cart"`, using the element's visible text), and what the model said before acting (or the URL).
  - A red circle marks the click point. The first frame is a title card; the last stays on screen for 3 s.
  - At most 120 frames: the first is kept, then the most recent.
- **`/record <task>`** asks the model to start recording, do the task and export.
- **Settings → "Record every run as an animated GIF"** records every panel run and announces the saved file in the chat.
- **Encoder** (`src/gif.js`): plain-JS GIF89a, with a 256-colour median-cut palette per frame and LZW. Frames are drawn with `OffscreenCanvas` in the service worker.

## Site memory: `site_note`

The agent can keep up to 10 short notes (300 characters each) per website, for example "the search URL is /jobs/search?keywords=…&location=…" or "the Apply button opens a modal". Small local models then stop relearning the same site every run.
- **Saving:** it adds, lists and removes notes with `site_note` for the current tab's site (`jobs.linkedin.com` and `www.linkedin.com` share `linkedin.com`).
- **Recall:** the notes appear in the system prompt whenever it works on that site, marked as its own past observations, as data, not instructions.
- **Review:** see and delete them in **Settings → Site notes**. The tool description tells the model never to store personal data or anything a page tells it to remember.

## Small-context helpers

- **Streaming:** with OpenAI-style servers, replies stream (`stream: true`, SSE) and the text appears in the panel as it is generated. If a server rejects streaming, LocalPilot asks again without it and remembers that for the task. Setting: "Stream replies as they are generated".
- **Summaries of old turns:** when a request's prompt grows past "Summarize older turns when the prompt exceeds" (default 24 000 tokens, counted from the server's `usage`, or estimated), the older messages are replaced by a model-written summary that keeps URLs, file paths, names and numbers. The last few messages stay verbatim, and the panel notes "Summarized N older messages". Set it to 0 to turn this off.

## Tools given to the model

| Tool | What it does |
| --- | --- |
| `navigate` | Opens a URL, or goes back / forward; waits until the page has settled |
| `computer` | `screenshot` (numbered **marks** on clickable elements; `full_page`; element shot by `ref`), clicks (left/right/double/triple) by `ref`, `mark` or coordinate, `hover`, `left_click_drag`, `type`, `key` (combos like `ctrl+a Enter`), `scroll`, `scroll_to`, `wait`, `wait_for` (text or CSS selector), `zoom` |
| `read_page` | Accessibility-style outline with `ref_N` ids (`all` / `interactive`, `viewport_only`, `ref_id`). Includes iframes (refs like `f3:ref_7`) and open shadow DOM |
| `find` | Finds elements by role, label or text, in all frames and shadow roots, and returns refs |
| `form_input` | Sets inputs, textareas, selects, checkboxes and custom elements (web components) by ref; works with React and Vue fields |
| `get_page_text` | Plain text of the main content |
| `handle_dialog` | Answers a `confirm()` / `prompt()` / "Leave page?" dialog (see Safety) |
| `tabs_context`, `tabs_create`, `switch_tab`, `tabs_close` | Lists (this or all windows), opens, switches and closes tabs |
| `file_upload` | Attaches files to a file input: a file the user attached in the panel (`attachment`, no PC bridge needed), or a file from a PC root (`root` + `path`, e.g. `China/cv.pdf`, needs the PC bridge). Separate "upload … files to <site>" approval |
| `downloads_wait` | Waits for a download and reports its path; `save_to` copies it from Downloads into a PC root (documents, data and images only) |
| `read_console_messages`, `read_network_requests` | Shows console output and network requests captured over CDP; kept when the debugger detaches |
| `resize_window` | Resizes the window |
| `javascript_tool` | Runs JS in the page. **Off by default**; turn it on in Settings. |
| `extract_list` | Detects repeating lists on any page and returns or saves them as rows, with paging (see above) |
| `site_note` | Per-site memory: add, list or remove short notes for the current site |
| `test_website` | Testing mode: read-only crawl, bug checks, phone check, link check; HTML report + GIF (see above) |
| `gif_recorder` | Record the session as an animated GIF: start, export, cancel, status |
| Recipes | `boss_collect_jobs`, `liepin_collect_jobs`, `job51_collect_jobs`, `zhaopin_collect_jobs`, `linkedin_collect_jobs`, `apply_assist`, `econ_calendar_collect`, `news_collect` (need the PC bridge; see above) |
| Quantara | `quantara_status`, `quantara_trades`, `quantara_analysis`, `quantara_research`, and `quantara_halt` with a token (only when turned on in Settings; see **Trading: Quantara**) |

**Page settling.** After clicks and key presses, tools wait until the page has had no DOM changes for 300 ms and no requests are in flight, capped at 5 s. On single-page apps, results are therefore there before the next step.

## Safety

- The default permission mode asks once per site (see **Permission modes** above). You can remove always-allowed sites in Settings.
- If the model rejects a screenshot (for example when the `auto` router picks a text-only model), LocalPilot retries without images for the rest of that task.
- While the agent works, the page shows a blue frame and a **Stop** button. The send button turns into Stop.
- The system prompt tells the model not to enter passwords, card numbers or ID numbers. It also tells the model to treat page text as data, not instructions. A local model may not follow these rules reliably, so keep approvals on for sites that matter.
- While the agent is attached, Chrome shows its "started debugging this browser" bar. That is expected, because the extension uses `chrome.debugger`.
- **JavaScript dialogs:**
  - `alert()` is accepted and reported to the model.
  - `confirm()`, `prompt()` and "Leave page?" stay open. The model must answer with `handle_dialog`, which goes through the normal approvals; until then other page tools refuse to run.
  - An unanswered dialog is **dismissed** (Cancel) after 60 s.
  - "Are you sure you want to delete…?" is never auto-confirmed.
  - **A dialog that opened before LocalPilot attached to the tab** (for example an alert shown while the page loads, before you asked anything) is invisible to Chrome's debugger, and Chrome cannot answer it. LocalPilot notices that the page has stopped answering (after 1.5 s) and tells the model, instead of hanging. The model then asks you to click OK or Cancel in the tab, or calls `handle_dialog`, which reloads the page to close it (like Cancel). The reloaded page is fully attached, so its own dialogs are then handled as above.
  - Tabs that a controlled page opens (links with `target=_blank`, `window.open`) are attached as soon as they are created, so their dialogs are caught too.
- Chats are kept in session storage, so they survive a background-worker restart. Screenshot pixels are not stored. Chats are cleared when the tab or browser closes.

## Layout

```
manifest.json           MV3: side panel, module service worker
src/background.js       per-tab panels + chats (persisted), approvals, Stop, keepalive + saved-task alarms, notifications
src/agent.js            agent loop, system prompt, plan-first mode, summaries of old turns, screenshot pruning (keeps the last 2)
src/providers.js        OpenAI-compatible (SSE streaming) + Anthropic-compatible adapters, lenient tool-call parsing
src/recipes/            recipe registry (index.js), shared helpers (common.js), job boards, apply_assist (apply.js)
src/tasks.js            saved tasks, schedules (daily / weekdays / interval), change detection
src/quantara.js         Quantara dashboard tools (read-only + emergency stop that always asks)
src/sitenotes.js        per-site notes (site_note) and their system-prompt section
src/sitetest.js         testing mode (test_website): page audit, phone check, link check, HTML report
src/recorder.js         GIF recording: frames, captions, click markers, saving through chrome.downloads
src/gif.js              GIF89a encoder (median-cut palette + LZW)
src/ui/report.html      shows the latest test report in a tab
examples/               demos and prompts: real/ (recorded in Chrome), demo-ai/ (`npm run demo:ai`), demo/ (`npm run demo`)
host/jobs-scripts/      scripts installed into the Jobs folder (log-application.mjs)
src/tools.js            tool schemas and executors (CDP input, screenshots, page scripts)
src/cdp.js              chrome.debugger attach/release, per-tab store (console, network, captures, dialogs), input
src/content/page-agent.js  ref-tagged accessibility tree, find, form setting (injected on demand)
src/content/indicator.js   "agent is working" frame + Stop button
src/ui/                 side panel + settings
tests/                  unit tests, mock model server, Chromium end-to-end test
```

## Develop and test

```bash
npm install
npm test            # unit tests: providers (incl. SSE), recipes, saved tasks
npm run test:e2e    # loads the extension in Playwright Chromium and runs a scripted agent task against tests/mock-llm.mjs
npm run test:e2e:boss  # PC bridge + BOSS flow against a mock BOSS site (needs host:install)
npm run test:e2e:mcp   # MCP client -> mcp-server -> host -> extension -> browser (needs host:install)
npm run test:e2e:resilience  # retries, fallback, Retry/resume, bot-check handoff, CAPTCHA click guard, logs
npm run test:e2e:phase-a     # captures survive detach, chats survive SW restart, dialogs, shadow DOM, MCP cancel/progress/window
npm run test:e2e:phase-b     # smart wait, wait_for, marks, iframes, upload, downloads, full-page shots, zoom
npm run test:e2e:phase-c     # recipe registry, mock Liepin/51job/Zhaopin/LinkedIn + dedup, apply_assist, saved tasks + alarm, plan mode, summaries, streaming, Help + "/" menu + attached-file upload
npm run test:e2e:phase-d     # mock Quantara (status, analysis, halt asks every time), interval/weekday schedules, no-AI page watch, extract_list paging, calendar (page data + table, UTC self-check), news feeds, site notes
npm run test:e2e:phase-e     # testing mode on a buggy mock shop (every check, logout never opened, report + GIF), gif_recorder, record every run, /test and /record
npm run test:e2e:dialogs     # a dialog open before attach: reported at once, freed by handle_dialog; new tabs attached at once
npm run demo                 # regenerate examples/demo: the buggy demo shop (offline, no model)
npm run demo:ai              # regenerate examples/demo-ai: LocalPilot's agent with your model on real sites (model from src/local-defaults.json or LP_BASE_URL / LP_MODEL / LP_API_KEY)
npm run test:all       # everything
npm run mock        # standalone mock model on http://127.0.0.1:11999/v1 (test page at /page)
```

Add `--headed` to `node tests/e2e.mjs` to watch the run.

## What REA showed about Claude in Chrome

- MV3 extension with a React side panel, a module service worker that runs the agent loop against `/v1/messages`, and an offscreen document.
- Tools run through `chrome.debugger` CDP calls (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Page.captureScreenshot`, `Runtime.evaluate`, and `Network.*` / `Runtime.consoleAPICalled` for capture). It also uses `chrome.scripting` for page access.
- A content script in every frame builds a ref-tagged accessibility tree (a ref → element map). An overlay script draws the "agent active" frame with a Stop button.
- Features of Claude in Chrome that LocalPilot has since added in its own way: tab groups for agent tabs, GIF recording, file/image upload, saved shortcuts and scheduled tasks, and an MCP / native-messaging bridge to Claude Code.

## Not done yet

- The Liepin, 51job, Zhaopin and LinkedIn endpoints still need a check in a live logged-in session (see **Confirming a new endpoint**).
- `econ_calendar_collect`: ForexFactory's live page data matches what it reads, but the recipe itself has only run against a mock. Run one past month before a long run. The Quantara tools were tested against a mock of its dashboard API, built from Quantara's source, not against the running bot.
- Streaming is implemented for OpenAI-style servers only; Anthropic-style gateways reply whole.
- Out-of-process iframes on a *different site* (e.g. a payment provider) are read, filled and clicked through `chrome.scripting`. `file_upload` into them is not supported.
- Marks are drawn for the top frame only.

# LocalPilot

LocalPilot is a Chrome extension that lets an AI assistant use your browser for you. It opens pages, reads them, clicks buttons, fills in forms and takes screenshots, while you watch in a side panel.

The important part: the AI runs **on your own computer** (a "local LLM"), so your pages and chats do not go to a cloud service. There is no account and no telemetry.

![LocalPilot's AI finds the cheapest travel book on a real website, step by step](examples/demo-ai/books.gif)

*Above: LocalPilot's AI answering "Find the cheapest book in the Travel category on this site" on books.toscrape.com, recorded as a GIF. It answered £23.21, which is correct.*

**See what it can do:** [examples on real websites](examples/README.md): the AI doing tasks by itself, testing websites for bugs, recordings, turning a page into a spreadsheet, and prompts to copy.

> **New to this?** Follow the steps in order. You will need about 30 minutes the first time. Nothing here changes your computer's security settings, and you can remove everything by deleting the folder and the extension.

---

## What you need

| You need | Why | Where to get it |
| --- | --- | --- |
| Google Chrome (or Edge / Brave) | LocalPilot runs inside it | [google.com/chrome](https://www.google.com/chrome/) |
| A local AI model server | The "brain". Pick one of the options in step 2 | Ollama is the easiest free choice |
| Node.js 18 or newer | Needed only for the optional PC bridge (step 4) | [nodejs.org](https://nodejs.org/) (choose the LTS version) |

---

## Step 1: Load the extension in Chrome

1. Download or clone this project into a folder, for example `D:\AI\BrowserExtension`.
2. Open Chrome and go to `chrome://extensions` (paste it into the address bar).
3. Turn on **Developer mode** (switch in the top right).
4. Click **Load unpacked**, pick the project folder, and click **Select Folder**. The picker shows folders only, so the files inside are hidden. That is normal.
5. Pin the extension to the toolbar (the puzzle icon, then the pin next to LocalPilot).

Open the side panel by clicking the LocalPilot icon, or by pressing **Alt+Shift+L**.

---

## Step 2: Connect a local AI model

Choose **one** option. The simplest free one is **Ollama**.

### Option A: Ollama (recommended for beginners)

1. Install Ollama from [ollama.com](https://ollama.com/download) and open it.
2. Download a model. Open a terminal and run:

   ```bash
   ollama pull qwen2.5vl:7b
   ```

   `qwen2.5vl` can also read screenshots. Any model that supports tool calling works.
3. Allow Chrome extensions to talk to Ollama. In **PowerShell** (Windows), run this once and then restart Ollama:

   ```powershell
   setx OLLAMA_ORIGINS "chrome-extension://*"
   ```

### Option B: Another server

LM Studio, llama.cpp, vLLM, LiteLLM or a FreeLLMAPI gateway also work. The full list of addresses is in [docs/REFERENCE.md](docs/REFERENCE.md#local-servers).

### Then tell LocalPilot where it is

1. In the side panel, click the **gear icon** (Settings).
2. Pick the matching **Preset** from the list (for Ollama, "Ollama (localhost:11434)").
3. Click **Test & list models**. You should see "Connected" and a list of models.
4. Pick your model and click **Save**.

If it fails, read the message in the panel. It names what is wrong, usually the address or the Ollama setting above.

---

## Step 3: Try your first task

Open any website, for example `https://example.com`. Open the LocalPilot side panel and type:

> Summarize this page in three bullet points.

Watch the blue frame on the page. LocalPilot reads the page and answers. Try a few more:

- "Find the contact link and open it."
- "Fill this form with my name Jane Doe and email jane@example.com, but do not submit."
- "Search this site for pricing and open the first result."

### Permissions: you stay in control

The first time LocalPilot wants to act on a website (click, type, navigate), it **asks you**:

- **Allow once**, **Always allow**, or **Deny**.
- The shield menu in the panel changes the mode. "Ask once per site" is the default and the safest choice for everyday use.
- "Act without asking" exists, but use it only for sites you fully trust.

LocalPilot never solves CAPTCHAs or "I am not a robot" checks. When one appears, it pauses and asks you to complete it in the tab, then press **I've solved it, continue**.

It also never types passwords, card numbers or ID numbers. Please keep it that way and enter those yourself.

---

## Step 4 (optional): Let LocalPilot read and write files on your PC

Some features need LocalPilot to save files, for example job-search results as a spreadsheet. This is optional.

1. Install Node.js 18 or newer from [nodejs.org](https://nodejs.org/).
2. Open a terminal in the project folder and run:

   ```bash
   node host/install.mjs
   ```

3. Go to `chrome://extensions` and click the reload arrow on LocalPilot.
4. The panel's header shows **PC: on** when it works.

**Choose which folders LocalPilot may use.** Open `host/config.json` in a text editor. The `roots` list names the folders it can read and write. The default points at `D:\Personal Projects\Jobs`, which probably does not exist on your PC, so change the path to a folder you want to use, then run `node host/install.mjs` again.

LocalPilot can only write these file types: `.csv .json .md .txt .html .tsv`. It never overwrites a file unless you ask it to.

To remove the PC bridge later, run `node host/install.mjs --uninstall`.

---

## Things you can ask it to do

| Example | What happens |
| --- | --- |
| "Collect 30 Python jobs on Liepin in Shenzhen" | Gathers job listings into a spreadsheet (needs step 4). Works on BOSS, 51job, Zhaopin and LinkedIn too |
| "Find the email address of Dr. X, who teaches computer science at Y University" | Searches the web, opens the likely pages and reports what it found, with links |
| "Save every result on this page and the next 2 pages as a CSV" | Reads any list on any site and saves it (needs step 4) |
| "Fill this application for Full Stack Engineer at Acme with my CV" | Fills a job application form, attaches your CV, and **stops before submitting** for you to check |
| "/tasks" | Opens **saved tasks**: prompts you can rerun with `/name`, or run every day, every hour or on a schedule |

Type `/` in the box to see all commands. Click the **?** icon for setup status and more examples.

### Test a website for bugs: `/test`

Open any website and type **`/test`**. LocalPilot opens the site's pages one by one, without filling in forms or clicking log-out or delete links. It looks for:
- code errors, and broken links and images;
- "undefined" or "NaN" showing on the page;
- form fields without labels;
- pages too wide for a phone, and slow pages.

When it finishes, a **report** opens in a new tab, with screenshots where every problem is outlined in red and an animated **GIF** of the whole test. Both are saved in your `Downloads/LocalPilot` folder. The AI then explains the most important problems in plain words.

### Record what it does: `/record`

Type **`/record`** and a task, for example `/record search this site for pricing`. LocalPilot does the task and saves a GIF where every step has a caption and a red circle shows each click. To record every task automatically, tick **Record every run as an animated GIF** in Settings.

See the [examples page](examples/README.md) for real reports and GIFs.

---

## Problems and fixes

| What you see | What to do |
| --- | --- |
| "Failed" when you test the model | Check that the model server is running and the address in Settings matches. For Ollama, check step 2 |
| **PC: off** in the panel | Run `node host/install.mjs` (step 4), then reload the extension |
| "Not connected" after restarting Chrome | Reload LocalPilot in `chrome://extensions` |
| The answer keeps timing out | Use a smaller model, or raise "Model request timeout" in Settings |
| LocalPilot stops and says a verification appeared | Complete it in the browser tab yourself, then press **I've solved it, continue** |

Diagnostic logs stay on your PC in `logs/`. They never include API keys or screenshot images.

---

## Optional: use LocalPilot from Claude Code

LocalPilot can also be controlled by Claude Code through a small bridge. Setup and the commands are in [docs/REFERENCE.md](docs/REFERENCE.md#claude-code--mcp-phase-2).

---

## Trading research (optional, advanced)

LocalPilot can read the status of a local trading bot and collect economic calendar and news data for it. It never places trades, and it only reads the bot's status (plus one emergency stop you can enable). The setup is in [docs/REFERENCE.md](docs/REFERENCE.md#trading-quantara). Skip this section if you do not use that bot.

---

## Keeping secrets out of this project

- **Your API key** goes into Settings in the panel, or into `src/local-defaults.json`. That file is listed in `.gitignore` and is never committed. Start from `src/local-defaults.example.json`.
- **Private keys** (`host/extension-key.pem`) and **logs** (`logs/`, `host/localpilot-host.log`) are ignored by Git too.
- Before you share or push the project, run `git status` and check that none of those files are listed.

---

## For developers

```bash
npm install          # test tools only
npm test             # unit tests
npm run test:all     # every end-to-end suite (needs Chrome / Chromium)
npm run demo         # remake examples/demo (offline)
npm run demo:ai      # remake examples/demo-ai with the model in src/local-defaults.json
```

Project layout, the full list of tools, the recipe and extension design, and all settings are in [docs/REFERENCE.md](docs/REFERENCE.md).

## License

Not yet chosen. Until a license file is added, all rights are reserved by the author.

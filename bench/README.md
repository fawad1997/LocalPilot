# Benchmark: LocalPilot vs browser-use

30 browser tasks with known answers ([tasks.json](tasks.json)) on public practice sites: books.toscrape.com, quotes.toscrape.com, the-internet.herokuapp.com, Wikipedia and one web search. They cover reading, paging, forms, dropdowns, hovers, key presses, a JavaScript confirm dialog, iframes, shadow DOM, a large table and dynamic loading. The answers were checked against the live pages on 2026-10-25.

The latest numbers are in [RESULTS.md](RESULTS.md).

## Rules (the same for both agents)

- The **same model** on the same server (from `src/local-defaults.json`).
- The task starts on the given page. The instruction is the task plus one sentence asking for the answer in one short sentence ([score.mjs](score.mjs)).
- A task **passes** when the final answer contains every expected value (case-insensitive patterns).
- At most **25 steps** and 6 minutes per task.
- Extra checks off on both sides: LocalPilot's check after a task and browser-use's judge. Both cost extra model calls and do not change the answer.
- browser-use: telemetry and cloud sync off, default extensions (ad blocker and others) off so both agents see the same pages, screenshots every step only with `--vision` (text-only models cannot use them).

## Run

```bash
node bench/run-localpilot.mjs --model llama-3.3-70b-fp8-fast --mode json
node bench/run-localpilot.mjs --model llama-3.3-70b-fp8-fast --mode tools
bench/.venv/Scripts/python bench/run_browser_use.py --model llama-3.3-70b-fp8-fast
node bench/compare.mjs
```

`--tasks id,id` runs only some tasks; `--headed` shows the browser. Each run writes `bench/results/<agent>-<model>-<mode>-<time>.json`; `compare.mjs` takes the newest full run of each and writes RESULTS.md.

browser-use runs in its own Python environment:

```bash
python -m venv bench/.venv
bench/.venv/Scripts/python -m pip install browser-use==0.13.11
```

## Reading the numbers

- One run per agent and model: rate limits and slow upstream replies on shared model routers add noise. A difference of one or two tasks is not meaningful; rerun before drawing conclusions.
- "Steps" are model calls per task for both agents. Seconds include model latency, which depends on the router at that moment.
- The tasks are the kind of thing a person asks a browser assistant. They are not WebVoyager or another published benchmark, so the numbers are not comparable with published scores.

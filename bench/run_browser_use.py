"""Benchmark: browser-use on bench/tasks.json with the same model, server and rules as LocalPilot.

    bench/.venv/Scripts/python bench/run_browser_use.py --model gemma-4-26b-a4b-it [--tasks id,id] [--max-steps 25] [--vision] [--headed]

Same as the LocalPilot runner: the model server and key from src/local-defaults.json, the start
page opened first, the same instruction suffix and pass rule (bench/score.mjs), the same step
limit. browser-use's own judge is off (LocalPilot's check is off in the benchmark too), its
telemetry and cloud sync are off, and its default extensions (ad blocker etc.) are off so both
agents see the same pages. Screenshots every step only with --vision (the model must see images).
"""
import argparse
import asyncio
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

os.environ['ANONYMIZED_TELEMETRY'] = 'false'
os.environ['BROWSER_USE_CLOUD_SYNC'] = 'false'
os.environ.setdefault('NO_PROXY', '127.0.0.1,localhost')

from browser_use import Agent, Browser, ChatOpenAI  # noqa: E402
from browser_use.browser.profile import ProxySettings  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SUFFIX = re.search(r"ANSWER_SUFFIX = '([^']*)'", (ROOT / 'bench' / 'score.mjs').read_text(encoding='utf8')).group(1)


def score(task, answer):
    return all(re.search(p, answer or '', re.I) for p in task['expect'])


def summarize(results):
    n = len(results) or 1
    passed = [r for r in results if r['ok']]

    def avg(rows, k):
        return round(sum(r[k] for r in rows) / len(rows), 1) if rows else 0

    return {
        'tasks': len(results), 'passed': len(passed), 'successRate': f'{round(len(passed) / n * 100)}%',
        'avgSteps': avg(results, 'steps'), 'avgSeconds': avg(results, 'seconds'),
        'avgStepsWhenPassed': avg(passed, 'steps'), 'avgSecondsWhenPassed': avg(passed, 'seconds'),
    }


def chromium_path():
    base = Path(os.environ['LOCALAPPDATA']) / 'ms-playwright'
    found = sorted(base.glob('chromium-*/chrome-win64/chrome.exe'))
    return str(found[-1]) if found else None


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--tasks', default='')
    ap.add_argument('--max-steps', type=int, default=25)
    ap.add_argument('--timeout', type=int, default=360)
    ap.add_argument('--vision', action='store_true')
    ap.add_argument('--headed', action='store_true')
    ap.add_argument('--proxy', default='http://127.0.0.1:10809', help='proxy for the browser ("" for none)')
    args = ap.parse_args()

    defaults = json.loads((ROOT / 'src' / 'local-defaults.json').read_text(encoding='utf8'))
    tasks = json.loads((ROOT / 'bench' / 'tasks.json').read_text(encoding='utf8'))['tasks']
    only = [t for t in args.tasks.split(',') if t]
    chosen = [t for t in tasks if t['id'] in only] if only else tasks
    llm = ChatOpenAI(model=args.model, base_url=defaults['baseUrl'], api_key=defaults.get('apiKey') or 'none', temperature=0.2)

    results = []
    invalid = None
    for i, task in enumerate(chosen, 1):
        browser = Browser(
            executable_path=chromium_path(), headless=not args.headed, enable_default_extensions=False,
            proxy=ProxySettings(server=args.proxy, bypass='127.0.0.1,localhost') if args.proxy else None,
        )
        agent = Agent(
            task=task['task'] + SUFFIX, llm=llm, browser=browser,
            initial_actions=[{'navigate': {'url': task['url'], 'new_tab': False}}],
            use_vision=args.vision, use_judge=False,
        )
        started = time.time()
        error, answer, steps = None, '', 0
        try:
            history = await asyncio.wait_for(agent.run(max_steps=args.max_steps), timeout=args.timeout)
            answer = history.final_result() or ''
            steps = history.number_of_steps()
            errors = [e for e in history.errors() if e]
            if not answer and errors:
                error = str(errors[-1])[:400]
        except Exception as e:  # noqa: BLE001 - every failure is a failed task
            error = f'{type(e).__name__}: {e}'[:400]
        finally:
            try:
                await browser.kill()
            except Exception:  # noqa: BLE001
                pass
        r = {'id': task['id'], 'ok': not error and score(task, answer), 'answer': answer[:500], 'steps': steps,
             'seconds': round(time.time() - started, 1), 'end': 'error' if error else 'done'}
        if error:
            r['error'] = error
        results.append(r)
        quota = re.compile(r'429|exhausted|rate.?limit', re.I)
        if len(results) >= 2 and all(quota.search(x.get('error', '')) for x in results[-2:]):
            invalid = f'stopped after task {i}: the model server kept answering 429 (quota or rate limit)'
        print(f"{i:2}/{len(chosen)} {'PASS' if r['ok'] else 'fail'} {task['id']} — {steps} steps, {r['seconds']}s — {' '.join(answer.split())[:90]}", flush=True)
        if invalid:
            print(invalid)
            break

    import browser_use
    report = {
        'agent': 'browser-use', 'version': getattr(browser_use, '__version__', None) or _dist_version(), 'model': args.model,
        'mode': 'vision' if args.vision else 'text', 'maxSteps': args.max_steps, 'at': datetime.now(timezone.utc).isoformat(), **({'invalid': invalid} if invalid else {}),
        'summary': summarize(results), 'results': results,
    }
    out = ROOT / 'bench' / 'results'
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime('%Y-%m-%dT%H-%M-%S')
    safe_model = re.sub(r'[^\w.-]+', '_', args.model)
    file = out / f"browser-use-{safe_model}-{report['mode']}-{stamp}.json"
    file.write_text(json.dumps(report, indent=1), encoding='utf8')
    print(f"\n{json.dumps(report['summary'])}\nSaved {file}")


def _dist_version():
    from importlib.metadata import version
    return version('browser-use')


if __name__ == '__main__':
    asyncio.run(main())

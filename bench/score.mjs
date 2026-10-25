// Shared by the benchmark runners and the comparison: the same instruction suffix for every
// agent, the same pass rule (every expected pattern found in the final answer), the same summary.
export const ANSWER_SUFFIX = ' When you have the answer, reply with it in one short sentence.';

export function score(task, answer) {
  return task.expect.every((p) => new RegExp(p, 'i').test(String(answer || '')));
}

export function summarize(results) {
  const n = results.length || 1;
  const passed = results.filter((r) => r.ok);
  const avg = (list, k) => (list.length ? Math.round((list.reduce((s, r) => s + (r[k] || 0), 0) / list.length) * 10) / 10 : 0);
  return {
    tasks: results.length,
    passed: passed.length,
    successRate: `${Math.round((passed.length / n) * 100)}%`,
    avgSteps: avg(results, 'steps'),
    avgSeconds: avg(results, 'seconds'),
    avgStepsWhenPassed: avg(passed, 'steps'),
    avgSecondsWhenPassed: avg(passed, 'seconds'),
  };
}

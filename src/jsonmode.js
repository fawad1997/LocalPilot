// JSON action mode (settings.actionMode = 'json'): instead of native tool calling, the model
// answers every step with one JSON object whose shape the server enforces (response_format
// json_schema: Ollama, LM Studio, llama.cpp, vLLM). Tool names are an enum, so a small model
// cannot invent tools, and every step carries a self-check, a running memory and the next goal.
// The agent turns the actions into ordinary tool_use blocks, so the rest of the loop is unchanged.
import { parseArgs } from './providers.js';

export const MAX_JSON_ACTIONS = 5;

export function stepSchema(toolNames) {
  return {
    type: 'object',
    properties: {
      evaluation_previous_goal: { type: 'string', description: 'Did your last actions work? One sentence: Success / Failed / Unknown, and why.' },
      memory: { type: 'string', description: 'What you have found and done so far, and what is left. Kept between steps.' },
      next_goal: { type: 'string', description: 'What you do now, in one sentence.' },
      actions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_JSON_ACTIONS,
        items: {
          type: 'object',
          properties: { tool: { type: 'string', enum: [...toolNames, 'done'] }, input: { type: 'object' } },
          required: ['tool', 'input'],
        },
      },
    },
    required: ['evaluation_previous_goal', 'memory', 'next_goal', 'actions'],
  };
}

function paramsLine(schema) {
  const props = schema?.properties || {};
  const req = new Set(schema?.required || []);
  const parts = Object.entries(props).map(([k, v]) => {
    const type = v.enum ? v.enum.map((e) => JSON.stringify(e)).join('|') : v.type || 'any';
    return `${k}${req.has(k) ? '' : '?'}: ${type}`;
  });
  return parts.length ? `{ ${parts.join(', ')} }` : '{}';
}

export function jsonInstructions(tools) {
  const list = tools.map((t) => `- ${t.name} ${paramsLine(t.input_schema)}: ${String(t.description || '').split(/(?<=\.)\s/)[0]}`);
  return [
    '',
    'REPLY FORMAT: every reply is exactly one JSON object and nothing else:',
    '{"evaluation_previous_goal": "Success: the search results are shown", "memory": "Found 2 of 5 prices: A=3, B=4. Next: page 2.", "next_goal": "Open page 2", "actions": [{"tool": "computer", "input": {"action": "left_click", "ref": "ref_12"}}]}',
    `- actions: 1 to ${MAX_JSON_ACTIONS} tool calls, run in order. If the page changes, the remaining page actions are skipped.`,
    '- memory: keep it current and specific (values found, pages done, what is left). It is shown to you every step and survives when old turns are summarized.',
    '- To finish, use the action {"tool": "done", "input": {"success": true, "text": "your final answer for the user"}}. Before that, check that every part of the request is done and every fact comes from a page or file you actually read. If something could not be done, set success to false and say what is missing.',
    'Tools (input fields; ? = optional):',
    ...list,
    '- done { success: boolean, text: string }: Finish and give the user the result.',
  ].join('\n');
}

// History for a JSON-mode request: only text and images. Assistant steps become their JSON,
// tool results become a numbered "Results" message.
export function toTextTranscript(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const stepBlock = m.content.find((b) => b.step);
      const uses = m.content.filter((b) => b.type === 'tool_use');
      if (stepBlock) return { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(stepBlock.step) }] };
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const actions = uses.map((u) => ({ tool: u.name, input: u.input }));
      return { role: 'assistant', content: [{ type: 'text', text: actions.length ? JSON.stringify({ next_goal: text, actions }) : text || '(no reply)' }] };
    }
    const content = [];
    const results = m.content.filter((b) => b.type === 'tool_result');
    if (results.length) {
      const lines = results.map((r, i) => {
        const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        return `${i + 1}. ${r.isError ? 'ERROR: ' : ''}${t || (r.content.some((c) => c.type === 'image') ? '(screenshot attached)' : 'ok')}`;
      });
      content.push({ type: 'text', text: `Results of your actions:\n${lines.join('\n')}` });
      for (const r of results) content.push(...r.content.filter((c) => c.type === 'image'));
    }
    content.push(...m.content.filter((b) => b.type === 'text' || b.type === 'image'));
    return { role: 'user', content: content.length ? content : [{ type: 'text', text: '(empty)' }] };
  });
}

let seq = 0;

// Lenient: code fences, text around the object, "action" instead of "actions", "name"/"args"
// instead of "tool"/"input". Throws when there is no usable step.
export function parseStep(raw) {
  const text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object found');
  const obj = parseArgs(text.slice(start, end + 1));
  let actions = obj.actions ?? obj.action ?? [];
  if (!Array.isArray(actions)) actions = [actions];
  actions = actions
    .map((a) => (typeof a === 'object' && a ? { tool: a.tool ?? a.name, input: a.input ?? a.args ?? a.arguments ?? a.params ?? {} } : null))
    .filter((a) => a && typeof a.tool === 'string');
  if (!actions.length) throw new Error('"actions" is empty');
  const step = {
    evaluation_previous_goal: String(obj.evaluation_previous_goal ?? obj.evaluation ?? ''),
    memory: String(obj.memory ?? ''),
    next_goal: String(obj.next_goal ?? obj.goal ?? ''),
    actions: actions.slice(0, MAX_JSON_ACTIONS),
  };
  const done = step.actions.find((a) => a.tool === 'done');
  const uses = step.actions
    .filter((a) => a.tool !== 'done')
    .map((a) => ({ type: 'tool_use', id: `json_${Date.now().toString(36)}_${(seq += 1)}`, name: a.tool, input: typeof a.input === 'object' && a.input ? a.input : {} }));
  // "done" after other actions in the same reply waits: the actions run first, the model then finishes.
  return { step, uses, done: done && !uses.length ? { success: done.input?.success !== false, text: String(done.input?.text ?? done.input?.answer ?? '') } : null };
}

// PC bridge tools (files + allowlisted scripts via the native host) and
// network response capture tools.
import * as pc from './pcbridge.js';
import * as cdp from './cdp.js';

const text = (t) => ({ type: 'text', text: t });

export function pcToolDefinitions(host) {
  if (!host) return [];
  const roots = host.roots.map((r) => `${r.name} = ${r.path}${r.writable ? '' : ' (read-only)'}`).join('; ');
  // Internal scripts (e.g. log-application) run only from LocalPilot's own flows, never by the model.
  const callable = host.scripts.filter((s) => !s.internal);
  const scripts = callable.map((s) => `${s.name}: ${s.description}`).join('; ') || 'none';
  const rootProp = { type: 'string', enum: host.roots.map((r) => r.name), description: `PC folder root. ${roots}` };
  return [
    {
      name: 'pc_list_dir',
      description: `List a folder on the user's PC. Roots: ${roots}`,
      input_schema: { type: 'object', properties: { root: rootProp, path: { type: 'string', description: 'Relative path, default "."' } }, required: ['root'] },
    },
    {
      name: 'pc_read_file',
      description: 'Read a text file on the PC (relative to a root). Returns the first 20 KB unless max_bytes is set (max 200 KB); large data files are better left to collector tools.',
      input_schema: { type: 'object', properties: { root: rootProp, path: { type: 'string' }, max_bytes: { type: 'number' } }, required: ['root', 'path'] },
    },
    {
      name: 'pc_write_file',
      description: 'Write a text file on the PC (.csv .json .md .txt .html .tsv only). Refuses to overwrite unless overwrite is true.',
      input_schema: {
        type: 'object',
        properties: { root: rootProp, path: { type: 'string' }, content: { type: 'string' }, overwrite: { type: 'boolean' } },
        required: ['root', 'path', 'content'],
      },
    },
    {
      name: 'pc_write_csv',
      description: 'Write rows (array of objects) as a CSV file on the PC, UTF-8 with BOM so Excel shows Chinese correctly.',
      input_schema: {
        type: 'object',
        properties: {
          root: rootProp,
          path: { type: 'string' },
          rows: { type: 'array', items: { type: 'object' } },
          columns: { type: 'array', items: { type: 'string' } },
          overwrite: { type: 'boolean' },
        },
        required: ['root', 'path', 'rows'],
      },
    },
    {
      name: 'pc_run_script',
      description: `Run an allowlisted Node script on the PC. Scripts: ${scripts}`,
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string', enum: callable.map((s) => s.name) }, args: { type: 'array', items: { type: 'string' } } },
        required: ['name'],
      },
    },
  ];
}

export const captureToolDefinitions = [
  {
    name: 'capture_start',
    description:
      'Start recording response bodies of network requests whose URL contains url_pattern, in the current tab. ' +
      'Use it before navigating/scrolling so the site\'s own API responses (usually JSON) are captured exactly, instead of scraping the page.',
    input_schema: { type: 'object', properties: { url_pattern: { type: 'string' } }, required: ['url_pattern'] },
  },
  {
    name: 'capture_read',
    description: 'Read captured response bodies. With json_path (dot path like "data.items"), returns the extracted values from every JSON body.',
    input_schema: {
      type: 'object',
      properties: { url_pattern: { type: 'string' }, json_path: { type: 'string' }, max_chars: { type: 'number' } },
    },
  },
  {
    name: 'capture_save',
    description:
      'Save captured JSON data straight to a file on the PC without passing it through the conversation. ' +
      'Extracts the array at json_path from every captured body matching url_pattern, keeps `fields` (dot paths; all keys if omitted), dedupes on dedupe_key, and writes CSV or JSON.',
    input_schema: {
      type: 'object',
      properties: {
        url_pattern: { type: 'string' },
        json_path: { type: 'string' },
        fields: { type: 'array', items: { type: 'string' } },
        dedupe_key: { type: 'string' },
        root: { type: 'string' },
        path: { type: 'string' },
        format: { type: 'string', enum: ['csv', 'json'] },
        overwrite: { type: 'boolean' },
      },
      required: ['url_pattern', 'json_path', 'root', 'path'],
    },
  },
];

export function getPath(obj, dotted) {
  if (!dotted) return obj;
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export function extractItems(captured, jsonPath) {
  const items = [];
  for (const c of captured) {
    const val = getPath(parseJson(c.body), jsonPath);
    if (Array.isArray(val)) items.push(...val);
    else if (val !== undefined) items.push(val);
  }
  return items;
}

export function pickFields(items, fields, dedupeKey) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (dedupeKey) {
      const k = getPath(it, dedupeKey);
      if (k != null && seen.has(k)) continue;
      if (k != null) seen.add(k);
    }
    if (!fields?.length) {
      out.push(it);
      continue;
    }
    const row = {};
    for (const f of fields) row[f] = getPath(it, f);
    out.push(row);
  }
  return out;
}

export async function runPcOrCaptureTool(ctx, name, input) {
  switch (name) {
    case 'pc_list_dir': {
      const res = await pc.call('list_dir', { root: input.root, path: input.path || '.' });
      const lines = res.entries.map((e) => `${e.type === 'dir' ? '[dir] ' : '      '}${e.name}${e.size != null ? `  (${e.size} B)` : ''}`);
      return [text(`${res.path}\n${lines.join('\n') || '(empty)'}`)];
    }
    case 'pc_read_file': {
      const res = await pc.call('read_file', { root: input.root, path: input.path, maxBytes: Math.min(Number(input.max_bytes) || 20000, 200000) }); // keep the model's context small
      return [text(`${res.path} (${res.size} B${res.truncated ? ', truncated' : ''})\n${res.content}`)];
    }
    case 'pc_write_file': {
      const res = await pc.call('write_file', { root: input.root, path: input.path, content: input.content, overwrite: !!input.overwrite });
      return [text(`Wrote ${res.bytes} bytes to ${res.path}`)];
    }
    case 'pc_write_csv': {
      const res = await pc.call('write_csv', { root: input.root, path: input.path, rows: input.rows, columns: input.columns, overwrite: !!input.overwrite });
      return [text(`Wrote ${res.rows} rows to ${res.path}`)];
    }
    case 'pc_run_script': {
      if (ctx.host?.scripts.find((s) => s.name === input.name)?.internal) throw new Error(`Script "${input.name}" is internal to LocalPilot and cannot be run as a tool.`);
      const res = await pc.call('run_script', { name: input.name, args: input.args || [] });
      return [text(`exit ${res.exitCode}${res.timedOut ? ' (timed out)' : ''}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`)];
    }
    case 'capture_start': {
      await cdp.startCapture(ctx.tabId, input.url_pattern);
      return [text(`Capturing responses whose URL contains "${input.url_pattern}" in tab ${ctx.tabId}. Now load or scroll the page.`)];
    }
    case 'capture_read': {
      const caps = cdp.readCaptured(ctx.tabId, { pattern: input.url_pattern });
      const max = input.max_chars || 20000;
      if (!caps.length) return [text('Nothing captured yet. Call capture_start first, then trigger the requests (navigate, scroll, click).')];
      if (input.json_path) {
        const items = extractItems(caps, input.json_path);
        const json = JSON.stringify(items);
        return [text(`${caps.length} response(s), ${items.length} item(s) at ${input.json_path}:\n${json.length > max ? `${json.slice(0, max)}… truncated` : json}`)];
      }
      const parts = caps.map((c) => `#${c.seq} ${c.status} ${c.url}\n${c.body.slice(0, 2000)}${c.body.length > 2000 ? '…' : ''}`);
      const joined = parts.join('\n\n');
      return [text(joined.length > max ? `${joined.slice(0, max)}… truncated` : joined)];
    }
    case 'capture_save': {
      const caps = cdp.readCaptured(ctx.tabId, { pattern: input.url_pattern });
      const rows = pickFields(extractItems(caps, input.json_path), input.fields, input.dedupe_key);
      if (!rows.length) throw new Error(`No items found at "${input.json_path}" in ${caps.length} captured response(s).`);
      const format = input.format || (input.path.toLowerCase().endsWith('.json') ? 'json' : 'csv');
      const res = format === 'csv'
        ? await pc.call('write_csv', { root: input.root, path: input.path, rows, columns: input.fields, overwrite: !!input.overwrite })
        : await pc.call('write_file', { root: input.root, path: input.path, content: JSON.stringify(rows, null, 2), overwrite: !!input.overwrite });
      return [text(`Saved ${rows.length} item(s) from ${caps.length} response(s) to ${res.path}`)];
    }
    default:
      return null;
  }
}

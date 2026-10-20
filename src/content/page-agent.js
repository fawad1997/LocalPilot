// Injected on demand into the top frame. Builds a compact, ref-tagged view of the
// page so the model can target elements by `ref_N` instead of pixel coordinates.
(() => {
  if (window.__lpAgent) return;

  const refToEl = new Map(); // ref -> WeakRef<Element>
  const elToRef = new WeakMap();
  let counter = 0;

  function refFor(el) {
    let ref = elToRef.get(el);
    if (!ref) {
      counter += 1;
      ref = `ref_${counter}`;
      elToRef.set(el, ref);
      refToEl.set(ref, new WeakRef(el));
    }
    return ref;
  }

  function lookup(ref) {
    const el = refToEl.get(ref)?.deref();
    if (!el || !el.isConnected) throw new Error(`${ref} is stale or unknown. Call read_page or find again.`);
    return el;
  }

  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox',
    text: 'textbox', password: 'textbox', date: 'textbox', 'datetime-local': 'textbox',
    month: 'textbox', week: 'textbox', time: 'textbox', color: 'button', file: 'button',
  };
  const TAG_ROLES = {
    BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary',
    FORM: 'form', TABLE: 'table', UL: 'list', OL: 'list', LI: 'listitem', DIALOG: 'dialog',
    SUMMARY: 'button', OPTION: 'option', TR: 'row', TD: 'cell', TH: 'columnheader',
    P: 'paragraph', LABEL: 'label', SECTION: 'region', ARTICLE: 'article', IFRAME: 'iframe',
    VIDEO: 'video', AUDIO: 'audio',
  };
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
    'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider',
    'spinbutton', 'treeitem',
  ]);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'SVG', 'PATH']);

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    if (el.tagName === 'A') return el.hasAttribute('href') ? 'link' : 'generic';
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return null;
      return INPUT_ROLES[type] || 'textbox';
    }
    if (el.isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox';
    return TAG_ROLES[el.tagName] || 'generic';
  }

  function clean(text, max = 100) {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }

  function nameOf(el, role) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (t.trim()) return clean(t);
    }
    if (el.labels && el.labels.length) return clean([...el.labels].map((l) => l.textContent).join(' '));
    if (el.tagName === 'IMG') return clean(el.getAttribute('alt') || el.getAttribute('title') || '');
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return clean(el.value);
    const placeholder = el.getAttribute('placeholder');
    if (['textbox', 'searchbox', 'combobox'].includes(role) && placeholder) return clean(placeholder);
    const title = el.getAttribute('title');
    if (['button', 'link', 'heading', 'tab', 'menuitem', 'option', 'cell', 'columnheader', 'listitem', 'label', 'paragraph', 'checkbox', 'radio', 'switch', 'treeitem'].includes(role)) {
      const txt = clean(el.innerText || el.textContent, role === 'paragraph' ? 200 : 100);
      if (txt) return txt;
    }
    return clean(title || placeholder || '');
  }

  function isVisible(el) {
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  function isInteractive(el, role) {
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    const tabindex = el.getAttribute('tabindex');
    return tabindex !== null && Number(tabindex) >= 0;
  }

  function stateOf(el, role) {
    const bits = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
    if (['checkbox', 'radio', 'switch'].includes(role)) {
      const checked = el.checked ?? el.getAttribute('aria-checked') === 'true';
      bits.push(checked ? 'checked' : 'unchecked');
    }
    if (el.getAttribute('aria-expanded')) bits.push(el.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-selected') === 'true') bits.push('selected');
    if (role === 'heading') bits.push(`level=${el.tagName.match(/H(\d)/)?.[1] || el.getAttribute('aria-level') || '?'}`);
    if (role === 'link' && el.href) bits.push(`href="${clean(el.getAttribute('href'), 80)}"`);
    if (['textbox', 'searchbox', 'combobox', 'slider', 'spinbutton'].includes(role)) {
      const value = el.tagName === 'SELECT' ? el.options[el.selectedIndex]?.text : el.value ?? el.textContent;
      if (value) bits.push(`value="${clean(value, 60)}"`);
      if (el.type === 'password') bits.pop();
    }
    return bits.length ? ` ${bits.join(' ')}` : '';
  }

  function* children(el) {
    if (el.shadowRoot) yield* el.shadowRoot.children;
    yield* el.children;
  }

  function buildTree({ filter = 'all', viewportOnly = false, maxChars = 30000, refId } = {}) {
    const lines = [];
    let size = 0;
    let truncated = false;
    const interactiveOnly = filter === 'interactive';
    const root = refId ? lookup(refId) : document.body;

    function walk(el, depth) {
      if (truncated || SKIP_TAGS.has(el.tagName)) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      const visible = isVisible(el);
      const role = roleOf(el);
      let include = false;
      if (role && visible && (!viewportOnly || inViewport(el))) {
        const interactive = isInteractive(el, role);
        if (interactiveOnly) include = interactive;
        else include = interactive || (role !== 'generic' && role !== 'paragraph' && role !== 'label') || (role === 'paragraph' && el.textContent.trim().length > 0);
      }
      let nextDepth = depth;
      if (include) {
        const name = nameOf(el, role);
        const line = `${'  '.repeat(depth)}- ${role}${name ? ` "${name.replace(/"/g, "'")}"` : ''}${stateOf(el, role)} [${refFor(el)}]`;
        size += line.length + 1;
        if (size > maxChars) {
          truncated = true;
          return;
        }
        lines.push(line);
        nextDepth = depth + 1;
        // Leaf-like roles: their text is already the name.
        if (['button', 'link', 'heading', 'option', 'paragraph', 'img', 'textbox', 'searchbox', 'combobox'].includes(role)) return;
      }
      for (const child of children(el)) walk(child, nextDepth);
    }

    walk(root, 0);
    const header = `Page: ${document.title}\nURL: ${location.href}\nViewport: ${innerWidth}x${innerHeight}, scroll ${Math.round(scrollX)},${Math.round(scrollY)} of ${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}`;
    return `${header}\n${lines.join('\n')}${truncated ? `\n… truncated at ${maxChars} chars. Use filter "interactive", viewportOnly, or ref_id to narrow.` : ''}`;
  }

  // Every element under root, including inside open shadow roots (web components).
  function* allElements(root) {
    for (const el of root.children) {
      yield el;
      if (el.shadowRoot) yield* allElements(el.shadowRoot);
      yield* allElements(el);
    }
  }

  function find(query, limit = 20) {
    const q = query.toLowerCase();
    const hits = [];
    for (const el of allElements(document.body)) {
      if (hits.length >= limit) break;
      if (SKIP_TAGS.has(el.tagName) || !isVisible(el)) continue;
      const role = roleOf(el);
      if (!role) continue;
      const name = nameOf(el, role);
      const hay = `${role} ${name} ${el.getAttribute('placeholder') || ''} ${el.id || ''} ${el.getAttribute('name') || ''}`.toLowerCase();
      if (!hay.includes(q)) continue;
      // Prefer the innermost meaningful element: skip generic containers whose text matched through children.
      if (role === 'generic' && !isInteractive(el, role)) continue;
      hits.push(`- ${role}${name ? ` "${name.replace(/"/g, "'")}"` : ''}${stateOf(el, role)} [${refFor(el)}]`);
    }
    return hits.length ? hits.join('\n') : `No visible elements matching "${query}".`;
  }

  function locate(ref) {
    const el = lookup(ref);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    // What a person would call the element (for recording captions such as: Click "Add to cart").
    const field = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
    const label = ((field ? el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.placeholder || el.name : '')
      || el.innerText || el.getAttribute('aria-label') || el.value || el.placeholder || el.title || el.alt || '').replace(/[\s:]+$/, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, label };
  }

  function setValue(ref, value) {
    const el = lookup(ref);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    if (el.tagName === 'SELECT') {
      const opt = [...el.options].find((o) => o.value === String(value) || o.text.trim() === String(value));
      if (!opt) throw new Error(`No option "${value}" in ${ref}. Options: ${[...el.options].map((o) => o.text.trim()).join(', ')}`);
      el.value = opt.value;
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      const want = value === true || value === 'true' || value === 'on' || value === 1;
      if (el.checked !== want) el.click();
      return `${ref} is now ${el.checked ? 'checked' : 'unchecked'}`;
    } else if (el.isContentEditable) {
      el.textContent = String(value);
    } else if ('value' in el) {
      // Use the setter from the element's own class (skipping any instance-level
      // override), so frameworks such as React notice the change and custom
      // elements (<fluent-text-field>, <sl-input>…) get their own setter.
      let setter;
      for (let proto = Object.getPrototypeOf(el); proto && !setter; proto = Object.getPrototypeOf(proto)) {
        setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      }
      try {
        if (setter) setter.call(el, String(value));
        else el.value = String(value);
      } catch {
        el.value = String(value);
      }
    } else if (el.shadowRoot?.querySelector('input, textarea')) {
      return setInner(el.shadowRoot.querySelector('input, textarea'), ref, value);
    } else if (el.tagName.includes('-')) {
      // Custom element: its class (and value setter) only exists in the page's own
      // JS world. Mark it so a MAIN-world script can find it and set the value.
      const nonce = `lp${Math.random().toString(36).slice(2)}`;
      el.setAttribute('data-lp-target', nonce);
      return { needsMainWorld: true, nonce };
    } else {
      throw new Error(`${ref} (${el.tagName.toLowerCase()}) is not a form field`);
    }
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return `Set ${ref} to "${value}"`;
  }

  // A web component that wraps a native field in its shadow root.
  function setInner(input, ref, value) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    if (setter) setter.call(input, String(value));
    else input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return `Set ${ref} to "${value}"`;
  }

  function pageText(maxChars = 50000) {
    const main = document.querySelector('main, article, [role="main"]') || document.body;
    const text = (main.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    const head = `Title: ${document.title}\nURL: ${location.href}\n\n`;
    return head + (text.length > maxChars ? `${text.slice(0, maxChars)}\n… truncated` : text);
  }

  // Text of the elements matching selector (all of them), or of the main content; for page watches.
  function selectorText(selector = '', maxChars = 20000) {
    let text;
    if (selector) {
      const els = [...document.querySelectorAll(selector)];
      if (!els.length) throw new Error(`Nothing on ${location.href} matches "${selector}".`);
      text = els.map((e) => e.innerText || e.textContent || '').join('\n');
    } else {
      text = (document.querySelector('main, article, [role="main"]') || document.body).innerText || '';
    }
    text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }

  // ---- extract_list: repeating items (result cards, table rows) -> rows ----------------

  // Class names that look generated (hashes, long numbers, CSS-in-JS prefixes) change between
  // builds and pages, so they are left out of signatures and selectors.
  function stableClasses(el) {
    return [...el.classList]
      .filter((c) => /^[A-Za-z][\w-]{0,30}$/.test(c) && !/\d{3,}/.test(c) && !/^(css|sc|jsx|svelte|emotion|tw)-/.test(c))
      .sort()
      .slice(0, 3);
  }

  function signature(el) {
    const cls = stableClasses(el);
    return el.tagName.toLowerCase() + (cls.length ? `.${cls.map((c) => CSS.escape(c)).join('.')}` : '');
  }

  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visibleText = (el) => squash(el.innerText || '');

  function absUrl(href) {
    try {
      return href ? new URL(href, location.href).href : '';
    } catch {
      return '';
    }
  }

  // A selector that matches only el (or as close as five levels allow).
  function cssPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id) && !/\d{3,}/.test(n.id)) {
        parts.unshift(`#${n.id}`);
        break;
      }
      let part = signature(n);
      const parent = n.parentElement;
      if (parent && [...parent.children].filter((c) => c !== n && c.matches(part)).length) part += `:nth-child(${[...parent.children].indexOf(n) + 1})`;
      parts.unshift(part);
      const sel = parts.join(' > ');
      if (document.querySelectorAll(sel).length === 1 || parts.length >= 6) return sel;
    }
    return parts.join(' > ');
  }

  // Fields read without a spec: title, link, then the other distinct texts in reading order.
  function autoRow(item) {
    const row = {};
    const heading = item.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"], strong, b');
    // The first link with real text (not an icon such as an up-vote arrow).
    const links = [...(item.matches('a[href]') ? [item] : []), ...item.querySelectorAll('a[href]')];
    const link = links.find((a) => visibleText(a).length > 2) || links[0];
    row.title = visibleText(heading || link || item).slice(0, 300);
    if (link) row.link = absUrl(link.getAttribute('href'));
    const seen = new Set([row.title]);
    let n = 1;
    for (const el of item.querySelectorAll('*')) {
      const own = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
      if (!own) continue;
      const t = visibleText(el);
      if (!t || t.length > 400 || seen.has(t)) continue;
      seen.add(t);
      row[`text${n}`] = t;
      n += 1;
      if (n > 10) break;
    }
    return row;
  }

  // spec: "relative selector", "selector@attr" or "@attr" (href/src become absolute URLs).
  function fieldValue(item, spec) {
    const s = String(spec || '');
    const at = s.lastIndexOf('@');
    const attr = at >= 0 && /^[\w:-]+$/.test(s.slice(at + 1)) ? s.slice(at + 1) : '';
    const sel = (attr ? s.slice(0, at) : s).trim();
    const el = sel ? item.querySelector(sel) : item;
    if (!el) return '';
    if (attr) {
      const v = el.getAttribute(attr) || '';
      return /^(href|src)$/i.test(attr) ? absUrl(v) : squash(v);
    }
    return visibleText(el);
  }

  function shown(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  // The page's biggest groups of same-looking siblings with real text (menus and pagers score low).
  function detectLists(max = 3) {
    const groups = [];
    for (const parent of document.body.querySelectorAll('*')) {
      if (parent.children.length < 4) continue;
      const bySig = new Map();
      for (const child of parent.children) {
        if (/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|BR|HR)$/.test(child.tagName) || !shown(child)) continue;
        const sig = signature(child);
        if (!bySig.has(sig)) bySig.set(sig, []);
        bySig.get(sig).push(child);
      }
      for (const [sig, items] of bySig) {
        if (items.length < 4) continue;
        const avg = items.reduce((sum, it) => sum + visibleText(it).length, 0) / items.length;
        if (avg < 20) continue;
        const linked = items.filter((it) => it.matches('a[href]') || it.querySelector('a[href]')).length / items.length;
        groups.push({ parent, sig, items, score: items.length * Math.min(avg, 400) * (0.5 + linked) });
      }
    }
    groups.sort((a, b) => b.score - a.score);
    const chosen = [];
    for (const g of groups) {
      if (chosen.some((c) => c.items.some((it) => it.contains(g.parent)) || g.items.some((it) => it.contains(c.parent)))) continue;
      chosen.push(g);
      if (chosen.length >= max) break;
    }
    return chosen.map((g, i) => ({
      id: `list${i + 1}`,
      selector: `${cssPath(g.parent)} > ${g.sig}`,
      signature: g.sig,
      count: g.items.length,
      sample: g.items.slice(0, 2).map(autoRow),
    }));
  }

  function extractList(selector, fields = null, maxRows = 500) {
    const items = [...document.querySelectorAll(selector)].filter(shown);
    if (!items.length) throw new Error(`No items match "${selector}" on ${location.href}.`);
    const spec = fields && typeof fields === 'object' && Object.keys(fields).length ? fields : null;
    return items.slice(0, maxRows).map((it) => (spec ? Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, fieldValue(it, v)])) : autoRow(it)));
  }

  // Paging for extract_list: scroll the list's last item into view (infinite lists) ...
  function scrollListEnd(selector) {
    const items = document.querySelectorAll(selector);
    const last = items[items.length - 1];
    if (last) last.scrollIntoView({ block: 'end' });
    window.scrollBy(0, Math.round(window.innerHeight * 0.8));
    return items.length;
  }

  // ... or click the visible link/button whose text or label is `label` ("Next", "下一页", "›").
  function clickByText(label) {
    const want = squash(label).toLowerCase();
    const candidates = [...document.querySelectorAll('a, button, [role="button"], [role="link"], input[type="button"], input[type="submit"]')]
      .filter((el) => shown(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    const textOf = (el) => squash(el.innerText || el.value || '').toLowerCase();
    const labelOf = (el) => squash(el.getAttribute('aria-label') || el.title || '').toLowerCase();
    const el = candidates.find((c) => textOf(c) === want || labelOf(c) === want)
      || candidates.find((c) => textOf(c).startsWith(want) || labelOf(c).startsWith(want));
    if (!el) return null;
    el.click();
    return squash(el.innerText || el.getAttribute('aria-label') || el.value || label).slice(0, 60);
  }

  // Tags the <input type=file> for ref (or one inside / labelled by it) so CDP can find it.
  function markFileInput(ref) {
    const el = lookup(ref);
    const isFile = (n) => n?.tagName === 'INPUT' && n.type === 'file';
    let input = isFile(el) ? el : el.querySelector?.('input[type=file]') || el.shadowRoot?.querySelector('input[type=file]');
    if (!input && el.tagName === 'LABEL' && isFile(el.control)) input = el.control;
    if (!input) input = el.closest('form, label, div')?.querySelector('input[type=file]');
    if (!input) throw new Error(`${ref} is not a file input and has none nearby. Use find "file" or read_page to locate the <input type=file>.`);
    const nonce = `lp${Math.random().toString(36).slice(2)}`;
    input.setAttribute('data-lp-target', nonce);
    return { nonce, multiple: input.multiple, accept: input.accept || '' };
  }

  function unmark(nonce) {
    for (const el of allElements(document.documentElement)) if (el.getAttribute?.('data-lp-target') === nonce) el.removeAttribute('data-lp-target');
  }

  // Resolves once the DOM has had no mutations for quietMs (or after timeoutMs).
  function quiet(quietMs = 300, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const start = performance.now();
      let last = performance.now();
      const obs = new MutationObserver(() => {
        last = performance.now();
      });
      obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const tick = () => {
        const now = performance.now();
        if (now - last >= quietMs || now - start >= timeoutMs) {
          obs.disconnect();
          resolve({ quiet: now - last >= quietMs, waitedMs: Math.round(now - start) });
        } else setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
    });
  }

  // Waits until text or a CSS selector is present (piercing open shadow roots).
  function waitFor({ text, selector, timeoutMs = 10000 }) {
    return new Promise((resolve) => {
      const start = performance.now();
      const check = () => {
        let hit = false;
        if (selector) {
          for (const el of [document.documentElement, ...allElements(document.documentElement)]) {
            if (el.matches?.(selector) && isVisible(el)) {
              hit = true;
              break;
            }
          }
        }
        if (text) hit = (document.body?.innerText || '').includes(text) || hit;
        if (hit || performance.now() - start >= timeoutMs) resolve({ found: hit, waitedMs: Math.round(performance.now() - start) });
        else setTimeout(check, 150);
      };
      check();
    });
  }

  // Set-of-Marks: numbered badges over visible interactive elements, for screenshots.
  const MARKS_ID = '__localpilot_marks__';
  function drawMarks(max = 80) {
    clearMarks();
    const host = document.createElement('div');
    host.id = MARKS_ID;
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;';
    const root = host.attachShadow({ mode: 'closed' });
    const marks = [];
    for (const el of allElements(document.body)) {
      if (marks.length >= max) break;
      if (SKIP_TAGS.has(el.tagName)) continue;
      const role = roleOf(el);
      if (!role || !isInteractive(el, role) || !isVisible(el) || !inViewport(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const n = marks.length + 1;
      marks.push({ n, ref: refFor(el), role, name: nameOf(el, role) });
      const box = document.createElement('div');
      box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:2px solid #e8590c;outline-offset:-1px;`;
      const badge = document.createElement('div');
      badge.textContent = String(n);
      badge.style.cssText = `position:fixed;left:${Math.max(0, r.left - 2)}px;top:${Math.max(0, r.top - 14)}px;font:bold 11px/13px Arial,sans-serif;color:#fff;background:#e8590c;padding:0 3px;border-radius:3px;`;
      root.append(box, badge);
    }
    document.documentElement.appendChild(host);
    return marks;
  }
  function clearMarks() {
    document.getElementById(MARKS_ID)?.remove();
  }

  window.__lpAgent = { buildTree, find, locate, setValue, pageText, selectorText, detectLists, extractList, scrollListEnd, clickByText, quiet, waitFor, drawMarks, clearMarks, markFileInput, unmark };
})();

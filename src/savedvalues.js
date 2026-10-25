// Saved values (Settings -> Saved values): personal details such as an email address or phone
// number that the model types by placeholder, {{email}}, without ever seeing them. Each can be
// limited to some sites. Tool results and the browser state are masked back to placeholders.

export function allowedHost(host, sites) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  return sites.some((d) => h === d || h.endsWith(`.${d}`));
}

function sitesOf(v) {
  return String(v.sites || '').split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean);
}

export function savedValueNames(values) {
  return (values || []).filter((v) => v?.name && v.value).map((v) => {
    const sites = sitesOf(v);
    return `{{${v.name}}}${sites.length ? ` (on ${sites.join(', ')})` : ''}`;
  });
}

export function fillSavedValues(str, values, host) {
  return str.replace(/\{\{(\w+)\}\}/g, (whole, name) => {
    const v = (values || []).find((x) => x?.name === name && x.value);
    if (!v) throw new Error(`There is no saved value called {{${name}}}. Saved values: ${savedValueNames(values).join(', ') || 'none'}.`);
    const sites = sitesOf(v);
    if (sites.length && !allowedHost(host, sites)) throw new Error(`{{${name}}} may only be used on ${sites.join(', ')}, not on ${host}.`);
    return v.value;
  });
}

export function maskSavedValues(text, values) {
  let out = String(text ?? '');
  for (const v of values || []) {
    if (v?.name && v.value && String(v.value).length >= 3) out = out.split(String(v.value)).join(`{{${v.name}}}`);
  }
  return out;
}

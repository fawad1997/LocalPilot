import { test } from 'node:test';
import assert from 'node:assert/strict';

// Recipe modules register chrome.* listeners at load (via cdp.js): stub them out.
const stub = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : stub), apply: () => Promise.resolve({}) });
globalThis.chrome = stub;
const { RECIPES, getRecipe, recipeDefinitions, mcpHiddenRecipes } = await import('../../src/recipes/index.js');
const { rowKeys, isSeen, toDraftEntry, emptyRow, fitSignals } = await import('../../src/recipes/common.js');
const { parseVoyager, postedDate, applicants, employeesNumber, idsInText } = await import('../../src/recipes/linkedin.js');
const { liepinSpec } = await import('../../src/recipes/liepin.js');
const { profileFrom } = await import('../../src/recipes/apply.js');

test('registry: every recipe has a definition, approval and prompt hint', () => {
  assert.deepEqual(RECIPES.map((r) => r.definition.name), ['boss_collect_jobs', 'liepin_collect_jobs', 'job51_collect_jobs', 'zhaopin_collect_jobs', 'linkedin_collect_jobs', 'apply_assist', 'econ_calendar_collect', 'news_collect']);
  for (const r of RECIPES) {
    assert.ok(r.definition.input_schema.required.length, r.definition.name);
    assert.ok(r.approval && r.promptHint && typeof r.run === 'function', r.definition.name);
  }
  assert.equal(getRecipe('liepin_collect_jobs'), RECIPES[1]);
  assert.deepEqual(recipeDefinitions(null), [], 'recipes need the PC bridge');
  assert.deepEqual(mcpHiddenRecipes(), ['apply_assist']);
});

test('dedup keys: id, link, LinkedIn id, company+title(+location)', () => {
  const row = { ...emptyRow(), title: 'Full Stack Engineer', company: 'Acme', city: '武汉', district: '洪山区', jobId: '42', link: 'https://www.linkedin.com/jobs/view/full-stack-4012345678/' };
  const keys = rowKeys(row, { country: 'China', draftId: 'x-42' });
  assert.ok(keys.includes('4012345678'));
  assert.ok(keys.includes('x-42'));
  assert.ok(keys.includes('ct:acme|full stack engineer'));
  assert.ok(keys.includes('ctl:acme|full stack engineer|武汉 洪山区, china'));
  assert.ok(isSeen(new Set(['ct:acme|full stack engineer']), row, {}));
  assert.ok(!isSeen(new Set(['43']), row, {}));
  assert.equal(toDraftEntry(row, '2026-10-19', { source: 'Liepin', label: 'Liepin', id: 'x-42' }).id, 'x-42');
});

test('LinkedIn Voyager parse keeps job cards only, with paging', () => {
  const out = parseVoyager({
    data: { paging: { start: 0, count: 25, total: 30 } },
    included: [
      { $type: 'com.linkedin.voyager.dash.jobs.JobPostingCard', jobPostingUrn: 'urn:li:fsd_jobPosting:4012345678', jobPostingTitle: 'Dev', primaryDescription: { text: 'Co' }, secondaryDescription: { text: 'Berlin, Germany' } },
      { $type: 'com.linkedin.voyager.dash.common.Geo' },
    ],
  });
  assert.deepEqual(out.items.map((i) => [i.id, i.title, i.company, i.location]), [['4012345678', 'Dev', 'Co', 'Berlin, Germany']]);
});

test('LinkedIn field helpers: posted date, applicants, employees, ids in API text', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  assert.equal(postedDate('2 weeks ago', now), '2026-10-05');
  assert.equal(postedDate('Reposted 3 days ago', now), '2026-10-16');
  assert.equal(postedDate('1 month ago', now), '2026-09-19');
  assert.equal(postedDate('', now), '');
  assert.equal(applicants('Over 100 applicants'), '100+');
  assert.equal(applicants('21 people clicked apply'), '21');
  assert.equal(applicants('45 applicants'), '45');
  assert.equal(employeesNumber('1,001-5,000 employees'), 1001);
  assert.equal(employeesNumber('10,001+ employees'), 10001);
  assert.deepEqual(idsInText('{"x":"urn:li:fsd_jobPosting:4479002229","y":"urn:li:jobPosting:4012345678"}').sort(), ['4012345678', '4479002229']);
});

test('fitSignals quotes visa, language and experience lines', () => {
  const s = fitSignals('We build music AI. You have 5+ years of experience with Python.\nWe offer visa sponsorship and relocation support. Fluent English is required; Dutch is a plus.');
  assert.match(s.sponsorship, /visa sponsorship and relocation/);
  assert.match(s.languages, /Fluent English/);
  assert.match(s.yearsExperience, /^5\+ years/);
  assert.deepEqual(fitSignals(''), { sponsorship: '', languages: '', yearsExperience: '' });
  assert.equal(fitSignals('Great team, nice office.').sponsorship, '');
});

test('Liepin parse + map', () => {
  const got = liepinSpec.parse({ flag: 1, data: { data: { jobCardList: [{ job: { jobId: 7, title: 'T', dq: '武汉-洪山区' }, comp: { compName: 'C' } }], pagination: { currentPage: 2, totalPage: 3 } } } });
  assert.equal(got.hasMore, false);
  const row = liepinSpec.mapRow(got.items[0], 'https://www.liepin.com');
  assert.deepEqual([row.city, row.district, row.link], ['武汉', '洪山区', 'https://www.liepin.com/job/7.shtml']);
  assert.match(liepinSpec.parse({ flag: 0, msg: '请登录' }).error, /请登录/);
});

test('apply profile from cv_data.json', () => {
  const p = profileFrom({ personal: { name: 'Fawad Bin Tariq', location: '1106 AN, Amsterdam, Netherlands', linkedin: 'fawadbintariq', github: 'fawad1997' }, summary: 'S' });
  assert.deepEqual([p.firstName, p.lastName, p.city, p.country], ['Fawad', 'Bin Tariq', 'Amsterdam', 'Netherlands']);
  assert.equal(p.linkedin, 'https://www.linkedin.com/in/fawadbintariq');
  assert.equal(p.website, 'https://github.com/fawad1997');
});

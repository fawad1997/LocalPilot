// Scripted OpenAI-compatible server + a test web page, for end-to-end tests
// without a real model. `node tests/mock-llm.mjs` runs it standalone on :11999.
import http from 'node:http';

export const TEST_PAGE = `<!doctype html><html><head><title>Signup test</title></head><body>
<main>
  <h1>Join the club</h1>
  <form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Hello, ' + document.getElementById('name').value + ' (' + document.getElementById('plan').value + ')';">
    <label for="name">Name</label> <input id="name" placeholder="Your name">
    <label for="plan">Plan</label>
    <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
    <button type="submit">Submit</button>
  </form>
  <p id="out">Waiting</p>
</main>
<script>console.log('page ready')</script>
</body></html>`;

// ---------------------------------------------------------------------------
// Mock BOSS直聘: infinite-scroll search page backed by /wapi/zpgeek/search/joblist.json,
// 3 pages x 15 jobs, plus job_detail pages. The first API call fails with code 37
// (the real "environment abnormal" response) to exercise the pause-and-retry path.

const BOSS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>BOSS mock</title>
<style>.job-card{height:120px;border-bottom:1px solid #ccc}</style></head><body>
<ul class="job-list-container" id="list"></ul>
<script>
const params = new URLSearchParams(location.search);
let page = 0, loading = false, more = true;
async function load() {
  if (loading || !more) return; loading = true; page++;
  const r = await fetch('/wapi/zpgeek/search/joblist.json?query=' + encodeURIComponent(params.get('query')) + '&city=' + params.get('city') + '&page=' + page);
  const data = await r.json(); loading = false;
  if (data.code !== 0) { page--; return; }
  more = data.zpData.hasMore;
  for (const j of data.zpData.jobList) {
    const li = document.createElement('li'); li.className = 'job-card';
    li.innerHTML = '<a href="/job_detail/' + j.encryptJobId + '.html">' + j.jobName + '</a> ' + j.brandName;
    document.getElementById('list').appendChild(li);
  }
}
window.addEventListener('scroll', () => { if (innerHeight + scrollY >= document.body.scrollHeight - 50) load(); });
load();
</script></body></html>`;

function bossJob(n) {
  return {
    encryptJobId: `job${String(n).padStart(3, '0')}~~`,
    jobName: n % 2 ? '全栈工程师' : 'Python开发工程师',
    salaryDesc: `${20 + (n % 10)}-${35 + (n % 10)}K·14薪`,
    brandName: `公司${n}`,
    brandScaleName: '100-499人',
    brandIndustry: '互联网',
    brandStageName: 'B轮',
    cityName: '武汉',
    areaDistrict: '洪山区',
    businessDistrict: '光谷',
    jobExperience: '3-5年',
    jobDegree: '本科',
    skills: ['React', 'Python', 'FastAPI'],
    jobLabels: ['3-5年', '本科'],
    welfareList: ['五险一金', '带薪年假'],
    bossName: '王先生',
    bossTitle: 'HR',
  };
}

let bossApiCalls = 0;
function bossApi(url) {
  bossApiCalls += 1;
  if (bossApiCalls === 1) return { code: 37, message: '您的环境存在异常.', zpData: {} };
  const page = Number(url.searchParams.get('page')) || 1;
  const jobs = Array.from({ length: 15 }, (_, i) => bossJob((page - 1) * 15 + i + 1));
  return { code: 0, message: 'Success', zpData: { hasMore: page < 3, jobList: jobs } };
}

function isBossFlow(messages) {
  const first = messages.find((m) => m.role === 'user');
  const text = typeof first?.content === 'string' ? first.content : '';
  return /BOSS/.test(text);
}

function bossReply(messages) {
  const step = messages.filter((m) => m.role === 'assistant').length;
  if (step === 0) {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_boss', type: 'function', function: { name: 'boss_collect_jobs', arguments: JSON.stringify({ query: '全栈工程师', city: 'Wuhan', max_jobs: 40, details: 5 }) } }],
    };
  }
  const result = messages.filter((m) => m.role === 'tool').pop()?.content || '';
  return { role: 'assistant', content: `Finished.\n${result.split('\n').slice(0, 4).join('\n')}` };
}

// ---------------------------------------------------------------------------
// Bot-check pages: /captcha clears itself after 1.5 s (as if the user solved it);
// /widget has a permanent reCAPTCHA-style checkbox.

const CAPTCHA_PAGE = `<!doctype html><html><head><title>Just a moment...</title></head><body>
<h1>Just a moment...</h1><p>Checking if the site connection is secure</p>
<div class="cf-turnstile" style="width:300px;height:65px;border:1px solid #888"></div>
<script>setTimeout(() => { document.title = 'Real site'; document.body.innerHTML = '<main><h1>Welcome to the real site</h1><p>Content loaded.</p></main>'; }, 1500);</script>
</body></html>`;

const WIDGET_PAGE = `<!doctype html><html><head><title>Contact</title></head><body><main>
<h1>Contact us</h1><p>Please confirm before sending.</p>
<div class="g-recaptcha" role="checkbox" aria-label="I'm not a robot" style="width:300px;height:78px;border:1px solid #888">I'm not a robot</div>
</main></body></html>`;

// ---------------------------------------------------------------------------
// Phase C mock job boards. Each search page fetches its own JSON API (like the real
// sites do) for the page number in its URL; 10 jobs per page.

const listPage = (title, apiCall) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
<ul id="list"></ul>
<script>
const params = new URLSearchParams(location.search);
(async () => {
  const items = await (${apiCall})(params);
  for (const it of items) { const li = document.createElement('li'); li.textContent = it; document.getElementById('list').appendChild(li); }
})();
</script></body></html>`;

const LIEPIN_PAGE = listPage('Liepin mock', `async (p) => {
  const r = await fetch('/api/com.liepin.searchfront4c.pc-search-job', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { mainSearchPcConditionForm: { key: p.get('key'), dq: p.get('dq'), currentPage: Number(p.get('currentPage')) } } }) });
  const j = await r.json(); return j.data.data.jobCardList.map((c) => c.job.title + ' ' + c.comp.compName);
}`);
const JOB51_PAGE = listPage('51job mock', `async (p) => {
  const r = await fetch('/api/job/search-pc?keyword=' + encodeURIComponent(p.get('keyword')) + '&jobArea=' + p.get('jobArea') + '&pageNum=' + p.get('pageNum'));
  const j = await r.json(); return j.resultbody.job.items.map((i) => i.jobName + ' ' + i.companyName);
}`);
const ZHAOPIN_PAGE = listPage('Zhaopin mock', `async (p) => {
  const r = await fetch('/c/i/search/positions?jl=' + p.get('jl') + '&kw=' + encodeURIComponent(p.get('kw')) + '&p=' + p.get('p'));
  const j = await r.json(); return j.data.list.map((i) => i.name + ' ' + i.companyName);
}`);
// LinkedIn search page like the real one: a scrollable result list whose job cards
// (li[data-occludable-job-id] with a /jobs/view/ link) appear only as you scroll. The
// cards come from a Voyager API call, which the extension may or may not get to see.
const LINKEDIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Jobs | LinkedIn</title>
<style>#results{height:400px;overflow-y:auto;border:1px solid #ccc} li{height:120px}</style></head><body><main>
<h1>Full Stack Engineer jobs</h1><ul id="results"></ul></main>
<script>
const p = new URLSearchParams(location.search);
(async () => {
  const r = await fetch('/voyager/api/voyagerJobsDashJobCards?decorationId=x&count=25&q=jobSearch&start=' + (p.get('start') || 0), { headers: { accept: 'application/vnd.linkedin.normalized+json+2.1' } });
  const cards = (await r.json()).included.filter((e) => e.jobPostingTitle);
  const list = document.getElementById('results');
  let shown = 0;
  const more = () => {
    for (const c of cards.slice(shown, shown + 4)) {
      const id = c.jobPostingUrn.split(':').pop();
      const li = document.createElement('li');
      li.setAttribute('data-occludable-job-id', id);
      li.innerHTML = '<div><a href="/jobs/view/' + id + '/?trk=x">' + c.jobPostingTitle + '</a></div><div>' + c.jobPostingTitle + ' with verification</div><div>' + c.primaryDescription.text + '</div><div>' + c.secondaryDescription.text + '</div><div>Promoted</div><div>Easy Apply</div>';
      list.appendChild(li);
    }
    shown += 4;
  };
  more();
  list.addEventListener('scroll', () => { if (list.scrollTop + list.clientHeight >= list.scrollHeight - 20) more(); });
})();
</script></body></html>`;

// A logged-in job page with the fields the extension extracts (no stable class names).
function linkedinJobPage(id) {
  const n = Number(id) - 4000000000;
  const company = `LI Company ${n}`;
  const easy = n % 2 === 0;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Full Stack Engineer | ${company} | LinkedIn</title></head><body><main>
<div class="a1x"><div class="b2y">
  <div><a href="/company/li-company-${n}/life/?trk=x">${company}</a></div>
  <h1>Full Stack Engineer</h1>
  <div><span>Amsterdam, North Holland, Netherlands</span> · <span>2 weeks ago</span> · <span>Over 100 applicants</span></div>
  <div><span>€60K/yr - €80K/yr</span> <span>Hybrid</span> <span>Full-time</span> <span>Mid-Senior level</span></div>
  ${easy ? '<button>Easy Apply</button>' : `<a href="https://careers.example.com/jobs/${n}">Apply</a>`}
</div></div>
<div class="c3z"><h2>About the job</h2><div>Job ${id}: build React + Python products for our music AI platform.
You have 5+ years of experience with Python and React.
We offer visa sponsorship and relocation support for this role.
Fluent English is required; Dutch is a plus.</div><button>…more</button></div>
<section><h2>About the company</h2><div>${company}</div><div>12,345 followers</div>
<div>Software Development • 1,001-5,000 employees • 300 on LinkedIn</div>
<p>${company} builds tools for musicians and creators around the world, with offices in Amsterdam, London and New York and a remote-first engineering team.</p>
<a href="https://www.li-company-${n}.example.com">Website</a></section>
</main></body></html>`;
}

function liepinApi(body, origin) {
  const page = body?.data?.mainSearchPcConditionForm?.currentPage || 0;
  const list = Array.from({ length: 10 }, (_, i) => {
    const n = page * 10 + i + 1;
    return {
      job: { jobId: 1000 + n, title: `全栈工程师 L${n}`, salary: '20-30k', dq: '武汉-洪山区', requireWorkYears: '3-5年', requireEduLevel: '本科', labels: ['React', 'Python'], link: `${origin}/job/${1000 + n}.shtml` },
      comp: { compName: `猎聘公司${n}`, compIndustry: '互联网', compScale: '100-499人', compStage: 'A轮' },
      recruiter: { recruiterName: '李女士', recruiterTitle: 'HRBP' },
    };
  });
  return { flag: 1, data: { data: { jobCardList: list, pagination: { currentPage: page, totalPage: 3 } } } };
}

function job51Api(url, origin) {
  const page = Number(url.searchParams.get('pageNum')) || 1;
  const items = page > 2 ? [] : Array.from({ length: 10 }, (_, i) => {
    const n = (page - 1) * 10 + i + 1;
    return {
      jobId: `5100${n}`, jobName: `Python开发 F${n}`, companyName: `前程公司${n}`, fullCompanyName: `前程公司${n}有限公司`, provideSalaryString: '1.5-2.5万',
      jobAreaString: '武汉·东湖新技术开发区', workYearString: '3-4年经验', degreeString: '本科', jobTags: ['Python', 'Django'], companySizeString: '500-1000人',
      industryType1Str: '计算机软件', companyTypeString: '民营', hrName: '张先生', hrPosition: '招聘经理', jobHref: `${origin}/51/5100${n}.html`,
      jobDescribe: `51job description ${n}: 负责后端开发。`,
    };
  });
  return { status: '1', message: 'ok', resultbody: { job: { totalCount: 20, items } } };
}

function zhaopinApi(url, origin) {
  const page = Number(url.searchParams.get('p')) || 1;
  const list = page > 2 ? [] : Array.from({ length: 8 }, (_, i) => {
    const n = (page - 1) * 8 + i + 1;
    return {
      number: `CC${700 + n}J`, name: `前端工程师 Z${n}`, companyName: `智联公司${n}`, salary60: '1.2-2万', workCity: '武汉', cityDistrict: '江夏区',
      workingExp: '3-5年', education: '本科', jobSkillTags: [{ name: 'Vue' }, { name: 'TypeScript' }], welfareTagList: ['五险一金'],
      companySize: '20-99人', industryName: 'IT服务', property: '民营', staffCard: { staffName: '陈女士', hrJob: 'HR' }, positionUrl: `${origin}/zpjob/${700 + n}.htm`,
    };
  });
  return { code: 200, data: { count: 16, list } };
}

function linkedinApi(url) {
  const start = Number(url.searchParams.get('start')) || 0;
  const page = Math.floor(start / 25);
  const cards = page > 1 ? [] : Array.from({ length: 10 }, (_, i) => {
    const n = page * 10 + i + 1;
    return {
      $type: 'com.linkedin.voyager.dash.jobs.JobPostingCard', jobPostingUrn: `urn:li:fsd_jobPosting:${4000000000 + n}`, jobPostingTitle: 'Full Stack Engineer',
      primaryDescription: { text: `LI Company ${n}` }, secondaryDescription: { text: 'Amsterdam, North Holland, Netherlands (Hybrid)' }, tertiaryDescription: { text: `${n} applicants` },
    };
  });
  // Normalized responses also carry unrelated entities and repeated cards.
  const noise = [{ $type: 'com.linkedin.voyager.dash.common.Geo', entityUrn: 'urn:li:fsd_geo:102890719' }, ...(cards[0] ? [cards[0]] : [])];
  return { data: { paging: { start, count: 25, total: 50 } }, included: [...cards, ...noise] };
}

// Application form for apply_assist: submitting it sets window.__submitted.
const APPLY_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Apply: Full Stack Engineer</title></head><body><main>
<h1>Apply for Full Stack Engineer at Acme</h1>
<form id="app" onsubmit="event.preventDefault(); window.__submitted = true; document.getElementById('out').textContent = 'SUBMITTED';">
  <label>First name <input id="fn" name="first_name"></label>
  <label>Last name <input id="ln" name="last_name"></label>
  <label for="em">Email address</label> <input id="em" type="email">
  <label>Phone <input id="ph" type="tel"></label>
  <label>LinkedIn profile <input id="li"></label>
  <label>City <input id="city"></label>
  <label>Country <select id="country"><option value="">Choose…</option><option value="nl">Netherlands</option><option value="cn">China</option></select></label>
  <label>Notice period <input id="notice"></label>
  <label>Expected salary <input id="salary"></label>
  <label>Password <input id="pw" type="password"></label>
  <label>Cover letter <textarea id="cover"></textarea></label>
  <label>Resume / CV <input id="cv" type="file" accept=".pdf"></label>
  <button type="submit" id="submit">Submit application</button>
</form>
<p id="out">not submitted</p>
<p id="file">no file</p>
<script>document.getElementById('cv').addEventListener('change', (e) => { document.getElementById('file').textContent = e.target.files[0].name + ' ' + e.target.files[0].size; });</script>
</main></body></html>`;

// 0.8.0 quick wins: change reports, forgiving selects, search result pages in three engines' markup.
const QW_FORM = `<!doctype html><html><head><meta charset="utf-8"><title>Quick wins</title></head><body><main>
<h1>Contact form</h1>
<label>Phone type <select id="ptype"><option value="">Choose…</option><option value="primary">Primary Phone</option><option value="mobile">Mobile Phone</option></select></label>
<label>Nationality <select id="nat"><option value="">------</option><option>Pakistani</option><option>Palauan</option><option>Other</option></select></label>
<label>Region <select id="region"><option>Select Region</option><option>Guangdong Sheng</option><option>Guangxi Zhuangzu Zizhiqu</option></select></label>
<label>Contact by <select id="contact"><option>Work Email</option><option>Work Phone</option></select></label>
<label>Search <input id="q" oninput="sug()"></label><ul id="sug"></ul>
<button id="open" onclick="document.getElementById('dlg').showModal()">Open dialog</button>
<dialog id="dlg"><p>Are you sure?</p><button onclick="this.closest('dialog').close()">Close</button></dialog>
<button id="noop">Does nothing</button>
<a href="/qw/next">Next page</a> <a href="/qw/next?popped" target="_blank">Pop out</a>
<script>function sug() { const v = document.getElementById('q').value; document.getElementById('sug').innerHTML = v ? '<li><a href="/qw/next">' + v + ' suggestion</a></li>' : ''; }</script>
</main></body></html>`;

const QW_NEXT = '<!doctype html><html><head><title>Next</title></head><body><h1>Next page</h1><a href="/qw/form">Back to form</a></body></html>';

const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function qwSearch(kind, q) {
  const esc = (t) => t.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  const head = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(q)} - search</title></head><body>`;
  if (kind === 'ddg') {
    return `${head}<div class="result result--ad"><a class="result__a" href="https://ads.example/x">Sponsored thing</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.org/muhammad-aleem')}&rut=abc">Dr. Muhammad Aleem - FAST</a><a class="result__snippet">Associate Professor, email m.aleem@example.org, Islamabad campus.</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.org/faculty')}">Faculty list</a><a class="result__snippet">All faculty of the computing department.</a></div>
<a href="/qw/search?q=next">Next page</a></body></html>`;
  }
  if (kind === 'bing') {
    return `${head}<ol id="b_results"><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=abc&u=a1${b64url('https://example.net/bing-one')}&ntb=1">Bing result one</a></h2><div class="b_caption"><p>Snippet for the first Bing result.</p></div></li>
<li class="b_algo"><h2><a href="https://example.net/bing-two">Bing result two</a></h2><div class="b_caption"><p>Second snippet.</p></div></li></ol></body></html>`;
  }
  if (kind === 'google') {
    return `${head}<div id="search"><div class="g"><a href="/url?q=https://example.com/google-one&sa=U"><h3>Google result one</h3></a><div>This is the snippet text of the first Google result, long enough to keep.</div></div>
<div class="g"><a href="https://example.com/google-two"><h3>Google result two</h3></a><div>Another snippet text that is also long enough to be kept as the snippet.</div></div>
<div class="g"><a href="/goto?url=CAESabc123"><h3>Google result three</h3><cite>2.4K+ followers</cite><cite>https://example.edu › people</cite></a><div>A result whose link is Google's own redirect, as google.com.hk serves them.</div></div></div></body></html>`;
  }
  return `${head}<p>Our systems have detected unusual traffic from your computer network.</p></body></html>`;
}

function firstUserText(messages) {
  const first = messages.find((m) => m.role === 'user');
  return typeof first?.content === 'string' ? first.content : (first?.content || []).map((p) => p.text || '').join(' ');
}

function scriptedFlow(messages, base, steps) {
  // After a context summary the earlier steps are gone: the summary says how many calls were made.
  const summarized = Number(firstUserText(messages).match(/SUMMARY: (\d+) calls done/)?.[1] || 0);
  const step = messages.filter((m) => m.role === 'assistant').length + summarized;
  const tools = messages.filter((m) => m.role === 'tool');
  const last = tools.at(-1)?.content || '';
  const next = steps[step];
  if (!next) return { role: 'assistant', content: `FINAL: ${tools.map((t) => t.content).join(' || ')}` };
  const [name, args] = next(last, tools.map((t) => t.content).join('\n'));
  return { role: 'assistant', content: null, tool_calls: [{ id: `call_${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

const FLOWS = {
  'CAPTCHA-FLOW': [() => ['navigate', { url: 'BASE/captcha' }]],
  // Plan mode: the approved plan is assistant message 0, so tool steps start at 1.
  'PLAN-FLOW': [null, () => ['navigate', { url: 'BASE/page' }], () => ['get_page_text', {}]],
  'LONG-FLOW': Array.from({ length: 8 }, () => () => ['get_page_text', {}]),
  'SCHEDULED-FLOW': [() => ['get_page_text', {}]],
  'NAV-FLOW': [() => ['navigate', { url: 'BASE/page' }]],
  'APPLY-FLOW': [
    () => ['navigate', { url: 'BASE/apply' }],
    () => ['apply_assist', { company: 'Acme', role: 'Full Stack Engineer', cv_path: 'China/Applications/Acme/CV_Fawad.pdf', answers: { 'notice period': '1 month' } }],
    () => ['find', { query: 'Submit application' }],
    (last) => ['computer', { action: 'left_click', ref: last.match(/\[(ref_\d+)\]/)?.[1] || 'ref_missing' }],
    () => ['find', { query: 'Notice period' }],
    (last) => ['computer', { action: 'left_click', ref: last.match(/\[(ref_\d+)\]/)?.[1] || 'ref_missing' }],
    () => ['computer', { action: 'key', text: 'Enter' }],
  ],
  // Files attached in the side panel: upload one into the page's file input.
  'ATTACH-FLOW': [
    () => ['navigate', { url: 'BASE/upload' }],
    () => ['find', { query: 'Resume' }],
    (last) => ['file_upload', { ref: last.match(/\[(ref_\d+)\]/)?.[1] || 'ref_missing', attachment: 'cv.pdf' }],
  ],
  'CLICK-FLOW': [
    () => ['navigate', { url: 'BASE/widget' }],
    () => ['find', { query: 'robot' }],
    (last) => ['computer', { action: 'left_click', ref: last.match(/\[(ref_\d+)\]/)?.[1] || 'ref_missing' }],
  ],
  // Phase D: Quantara tools and per-site notes.
  'QUANTARA-FLOW': [() => ['quantara_status', {}]],
  'HALT-FLOW': [() => ['quantara_halt', { reason: 'test halt' }]],
  'NOTE-FLOW': [() => ['site_note', { action: 'add', text: 'Search URL is /list?page=N' }]],
  // 0.8.0: a repeated made-up address, a button that does nothing clicked twice, then the step limit.
  'LOOP-FLOW': [
    () => ['navigate', { url: 'BASE/qw/missing' }],
    () => ['navigate', { url: 'BASE/qw/missing/' }],
    () => ['navigate', { url: 'BASE/qw/form' }],
    () => ['find', { query: 'Does nothing' }],
    (last) => ['computer', { action: 'left_click', ref: last.match(/\[(ref_\d+)\]/)?.[1] || 'ref_missing' }],
    (last, all) => ['click', { ref: all.match(/button "Does nothing" \[(ref_\d+)\]/)?.[1] || 'ref_missing' }],
    () => ['get_page_text', {}],
  ],
};

// Requests without tools: plan-first planning and context summaries.
function noToolsReply(parsed) {
  if (parsed.tools?.length) return null;
  const system = parsed.messages.find((m) => m.role === 'system')?.content || '';
  if (/STEP LIMIT REACHED/.test(system)) return { role: 'assistant', content: 'PROGRESS: /qw/missing is a 404; the form is at /qw/form. Next: fill in the form.' };
  if (/PLANNING STEP/.test(system)) return { role: 'assistant', content: '1. Open the test page\n2. Read its text\n3. Report what it says' };
  if (/compress the history/.test(system)) {
    const text = parsed.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    const prior = Number(text.match(/SUMMARY: (\d+) calls done/)?.[1] || 0);
    const flows = Object.keys(FLOWS).filter((k) => text.includes(k)).join(' ');
    return { role: 'assistant', content: `SUMMARY: ${prior + (text.match(/^CALL /gm) || []).length} calls done. Task: ${flows}. The user asked to read the long page repeatedly.` };
  }
  return null;
}

// Each step inspects the conversation and decides the next tool call.
function nextReply(messages, base) {
  if (isBossFlow(messages)) return bossReply(messages);
  const flow = Object.keys(FLOWS).find((k) => firstUserText(messages).includes(k));
  if (flow) {
    const steps = FLOWS[flow].map((fn) => (last, all) => {
      const [name, args] = fn(last, all);
      return [name, JSON.parse(JSON.stringify(args).replace(/BASE/g, base))];
    });
    return scriptedFlow(messages, base, steps.map((st, i) => (FLOWS[flow][i] ? st : null)));
  }
  const step = messages.filter((m) => m.role === 'assistant').length;
  const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
  const toolText = lastTool?.content || '';
  const refOf = (pattern) => toolText.split('\n').find((l) => pattern.test(l))?.match(/\[(ref_\d+)\]/)?.[1];
  const call = (name, args) => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: `call_${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  });

  switch (step) {
    case 0:
      return call('read_page', { filter: 'interactive' });
    case 1: {
      const name = refOf(/textbox "Name"/);
      return call('form_input', { ref: name || 'ref_missing', value: 'Ada' });
    }
    case 2:
      return call('find', { query: 'plan' });
    case 3: {
      const plan = refOf(/combobox/);
      return call('form_input', { ref: plan || 'ref_missing', value: 'Pro' });
    }
    case 4:
      return call('find', { query: 'submit' });
    case 5: {
      const submit = refOf(/button "Submit"/);
      return call('computer', { action: 'left_click', ref: submit || 'ref_missing' });
    }
    case 6:
      return call('computer', { action: 'screenshot' });
    case 7:
      // Text-protocol tool call (no native tool_calls) to exercise the fallback parser.
      return { role: 'assistant', content: 'Reading result.\n<tool_call>{"name": "get_page_text", "arguments": {}}</tool_call>' };
    case 8:
      return call('read_console_messages', {});
    default: {
      const said = messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
      const greeting = said.match(/Hello, [^\n]+/)?.[0] || 'no greeting found';
      return { role: 'assistant', content: `Done. The page now says: ${greeting}` };
    }
  }
}

export function startMockServer(port = 11999) {
  const requests = [];
  const stats = { flaky: 0, failures: 0 };
  const server = http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(TEST_PAGE);
      return;
    }
    const url = new URL(req.url, 'http://x');
    // ---- Phase B pages ----
    if (url.pathname === '/spa') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><title>SPA</title></head><body><main>
<button id="load" onclick="setTimeout(async () => { const r = await fetch('/slow-api'); const j = await r.json(); const li = document.createElement('li'); li.textContent = j.item; document.getElementById('list').appendChild(li); }, 300)">Load results</button>
<button id="later" onclick="setTimeout(() => { const p = document.createElement('p'); p.className = 'done'; p.textContent = 'Later done'; document.body.appendChild(p); }, 2500)">Later</button>
<ul id="list"></ul></main></body></html>`);
      return;
    }
    if (url.pathname === '/slow-api') {
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ item: 'Result A' })), 900);
      return;
    }
    if (url.pathname === '/frames') {
      const other = url.searchParams.get('other');
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><title>Frames</title></head><body><main>
<h1>Outer page</h1><div style="height:120px"></div>
<iframe id="same" src="/frame-inner?name=same" style="width:400px;height:160px;border:4px solid #888"></iframe>
<iframe id="cross" src="${other}/frame-inner?name=cross" style="width:400px;height:160px;border:4px solid #888;margin-left:30px"></iframe>
</main></body></html>`);
      return;
    }
    if (url.pathname === '/frame-inner') {
      const name = url.searchParams.get('name');
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><title>inner ${name}</title></head><body>
<label>City (${name}) <input id="city"></label>
<button onclick="document.getElementById('out').textContent = 'clicked:' + document.getElementById('city').value">Go ${name}</button>
<p id="out">waiting</p></body></html>`);
      return;
    }
    if (url.pathname === '/upload') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><title>Upload</title></head><body><main>
<label>Resume <input type="file" id="f" accept=".pdf"></label>
<p id="out">none</p>
<script>document.getElementById('f').addEventListener('change', (e) => { const f = e.target.files[0]; document.getElementById('out').textContent = f.name + ' ' + f.size; });</script>
</main></body></html>`);
      return;
    }
    if (url.pathname === '/download') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><head><title>Download</title></head><body><a id="dl" href="/files/report.csv">Download report</a></body></html>');
      return;
    }
    if (url.pathname === '/files/report.csv') {
      res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' }).end('id,title\n1,全栈工程师\n');
      return;
    }
    if (url.pathname === '/long') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><title>Long</title></head><body style="margin:0">${Array.from({ length: 30 }, (_, i) => `<section style="height:100px;border-bottom:1px solid #ccc">Section ${i + 1}</section>`).join('')}</body></html>`);
      return;
    }
    if (url.pathname === '/confirm') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><title>Danger zone</title></head><body><main>
<button id="del" onclick="document.getElementById('out').textContent = confirm('Delete everything?') ? 'deleted' : 'kept'">Delete account</button>
<button id="al" onclick="alert('Saved!'); document.getElementById('out').textContent = 'alerted'">Save</button>
<p id="out">idle</p></main></body></html>`);
      return;
    }
    if (url.pathname === '/components') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><title>Components</title></head><body><main>
<h1>Web components</h1>
<shadow-field></shadow-field>
<my-input id="custom"></my-input>
<script>
customElements.define('shadow-field', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<label>Email <input id="email" placeholder="Email address"></label>'; }
});
customElements.define('my-input', class extends HTMLElement {
  constructor() { super(); this._v = ''; this.setAttribute('role', 'textbox'); this.setAttribute('aria-label', 'Nickname'); this.style.display = 'block'; this.style.height = '20px'; }
  get value() { return this._v; }
  set value(v) { this._v = String(v); this.textContent = 'nick:' + v; }
});
</script></main></body></html>`);
      return;
    }
    if (url.pathname === '/zhaopin/' || url.pathname === '/zhaopin') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(LIEPIN_PAGE);
      return;
    }
    if (url.pathname === '/api/com.liepin.searchfront4c.pc-search-job') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(liepinApi(JSON.parse(body || '{}'), `http://${req.headers.host}`))));
      return;
    }
    const liepinJob = url.pathname.match(/^\/job\/(\d+)\.shtml$/);
    if (liepinJob) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head><meta charset="utf-8"><title>job</title></head><body><section class="job-intro-container"><dt>职位介绍</dt><dd>猎聘职位 ${liepinJob[1]}：负责全栈开发。</dd></section></body></html>`);
      return;
    }
    if (url.pathname === '/pc/search') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(JOB51_PAGE);
      return;
    }
    if (url.pathname === '/api/job/search-pc') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(job51Api(url, `http://${req.headers.host}`)));
      return;
    }
    if (url.pathname === '/zp/' || url.pathname === '/zp') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(ZHAOPIN_PAGE);
      return;
    }
    if (url.pathname === '/c/i/search/positions') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(zhaopinApi(url, `http://${req.headers.host}`)));
      return;
    }
    const zpJob = url.pathname.match(/^\/zpjob\/(\d+)\.htm$/);
    if (zpJob) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head><meta charset="utf-8"><title>zp</title></head><body><div class="describtion__detail-content">智联职位 ${zpJob[1]}：Vue 前端开发。</div></body></html>`);
      return;
    }
    if (url.pathname === '/jobs/search/' || url.pathname === '/jobs/search') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(LINKEDIN_PAGE);
      return;
    }
    if (url.pathname === '/voyager/api/voyagerJobsDashJobCards') {
      res.writeHead(200, { 'content-type': 'application/vnd.linkedin.normalized+json+2.1; charset=utf-8' }).end(JSON.stringify(linkedinApi(url)));
      return;
    }
    const liJob = url.pathname.match(/^\/jobs\/view\/(\d+)\/?$/);
    if (liJob) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(linkedinJobPage(liJob[1]));
      return;
    }
    if (url.pathname === '/apply') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(APPLY_PAGE);
      return;
    }
    if (url.pathname === '/qw/form') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(QW_FORM);
      return;
    }
    if (url.pathname === '/qw/next') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(QW_NEXT);
      return;
    }
    const qwKind = { '/qw/search': 'ddg', '/qw/search-bing': 'bing', '/qw/search-google': 'google', '/qw/search-blocked': 'blocked' }[url.pathname];
    if (qwKind) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(qwSearch(qwKind, url.searchParams.get('q') || ''));
      return;
    }
    if (url.pathname.startsWith('/qw/')) {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>Not found</title><h1>404</h1>');
      return;
    }
    if (url.pathname === '/captcha') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(CAPTCHA_PAGE);
      return;
    }
    if (url.pathname === '/widget') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(WIDGET_PAGE);
      return;
    }
    if (url.pathname === '/web/geek/jobs') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(BOSS_PAGE);
      return;
    }
    if (url.pathname === '/wapi/zpgeek/search/joblist.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(bossApi(url)));
      return;
    }
    const detail = url.pathname.match(/^\/job_detail\/(.+)\.html$/);
    if (detail) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        `<!doctype html><html><head><meta charset="utf-8"><title>detail</title></head><body><h3>职位描述</h3><div class="job-sec-text">岗位职责：负责 ${decodeURIComponent(detail[1])} 的全栈开发。\n任职要求：React + Python。</div></body></html>`,
      );
      return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json', ...cors }).end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        requests.push(parsed);
        // Failure models, shaped like the FreeLLMAPI router errors.
        if (parsed.model === 'dead-model' || (parsed.model === 'flaky-model' && (stats.flaky += 1) <= 2)) {
          const status = parsed.model === 'dead-model' ? 502 : 503;
          stats.failures += 1;
          res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '1', ...cors }).end(
            JSON.stringify({ error: { message: 'All 2 routed attempt(s) failed with upstream provider errors (upstream_error ×1, timeout ×1)' } }),
          );
          return;
        }
        if (parsed.stream && parsed.model === 'nostream-model') {
          stats.streamRejected = (stats.streamRejected || 0) + 1;
          res.writeHead(400, { 'content-type': 'application/json', ...cors }).end(JSON.stringify({ error: { message: 'stream is not supported' } }));
          return;
        }
        const message = noToolsReply(parsed) || nextReply(parsed.messages, `http://${req.headers.host}`);
        const usage = { prompt_tokens: Math.round(JSON.stringify(parsed.messages).length / 4), completion_tokens: 20 };
        const finish = message.tool_calls ? 'tool_calls' : 'stop';
        if (parsed.stream) {
          stats.streamed = (stats.streamed || 0) + 1;
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...cors });
          const chunk = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`);
          chunk({ role: 'assistant' });
          const content = message.content || '';
          if (content) {
            const mid = Math.ceil(content.length / 2);
            chunk({ content: content.slice(0, mid) });
            chunk({ content: content.slice(mid) });
          }
          for (const [index, tc] of (message.tool_calls || []).entries()) {
            const args = tc.function.arguments;
            const mid = Math.ceil(args.length / 2);
            chunk({ tool_calls: [{ index, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: args.slice(0, mid) } }] });
            chunk({ tool_calls: [{ index, function: { arguments: args.slice(mid) } }] });
          }
          res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [], usage })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', ...cors }).end(
          JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], usage }),
        );
      });
      return;
    }
    res.writeHead(404, cors).end('not found');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, requests, port, stats })));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const { port } = await startMockServer(Number(process.env.PORT) || 11999);
  console.log(`mock LLM on http://127.0.0.1:${port}/v1, test page on http://127.0.0.1:${port}/page`);
}

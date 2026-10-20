// BOSS直聘 (zhipin.com) jobs -> CSV + import-ready draft, in the user's own logged-in browser.
// Reads the site's own search API responses (captured over CDP) instead of scraping HTML.
// Never solves verification or logs in: when BOSS asks for that, it pauses for the user.
import { collectJobBoard, jobBoardSchema, emptyRow } from './common.js';

export const CITY_CODES = {
  全国: '100010000', 北京: '101010100', 上海: '101020100', 天津: '101030100', 重庆: '101040100',
  广州: '101280100', 深圳: '101280600', 珠海: '101280700', 东莞: '101281600', 杭州: '101210100',
  南京: '101190100', 苏州: '101190400', 武汉: '101200100', 成都: '101270100', 西安: '101110100',
  长沙: '101250100', 厦门: '101230200', 合肥: '101220100', 郑州: '101180100', 青岛: '101120200',
  大连: '101070200',
};
const CITY_ALIASES = {
  china: '全国', nationwide: '全国', all: '全国', beijing: '北京', shanghai: '上海', tianjin: '天津',
  chongqing: '重庆', guangzhou: '广州', shenzhen: '深圳', zhuhai: '珠海', dongguan: '东莞',
  hangzhou: '杭州', nanjing: '南京', suzhou: '苏州', wuhan: '武汉', chengdu: '成都', xian: '西安',
  "xi'an": '西安', changsha: '长沙', xiamen: '厦门', hefei: '合肥', zhengzhou: '郑州', qingdao: '青岛', dalian: '大连',
};

export function resolveCity(city) {
  if (!city) return { name: '全国', code: CITY_CODES['全国'] };
  const raw = String(city).trim();
  if (/^\d{9}$/.test(raw)) return { name: Object.keys(CITY_CODES).find((k) => CITY_CODES[k] === raw) || raw, code: raw };
  const name = CITY_CODES[raw] ? raw : CITY_ALIASES[raw.toLowerCase()];
  if (!name) throw new Error(`Unknown city "${city}". Known: ${Object.keys(CITY_CODES).join(', ')} or a 9-digit BOSS city code.`);
  return { name, code: CITY_CODES[name] };
}

const definition = {
  name: 'boss_collect_jobs',
  description:
    'Collect job postings from BOSS直聘 (zhipin.com) in this browser tab and save them on the PC: a CSV (opens in Excel) plus a draft JSON for import-manual-jobs, then runs the import. ' +
    'Jobs already in processed-jobs.json or earlier China imports are skipped. ' +
    'The user must already be logged in to zhipin.com in this browser. If BOSS shows a login or verification page, the tool pauses until the user handles it. Runs at a deliberately slow pace.',
  input_schema: jobBoardSchema({
    locationDesc: 'City in Chinese or English (武汉 / Wuhan, 深圳, 上海, 北京, 全国…) or a 9-digit BOSS city code. Default 全国.',
    outDirDesc: 'Folder in the jobs root (default "China"). The import step expects the region folder.',
  }),
};

export function mapJob(j, base) {
  return {
    ...emptyRow(),
    title: j.jobName || '',
    company: j.brandName || '',
    salary: j.salaryDesc || '',
    city: j.cityName || '',
    district: [j.areaDistrict, j.businessDistrict].filter(Boolean).join(' '),
    experience: j.jobExperience || '',
    degree: j.jobDegree || '',
    skills: (j.skills || []).join('; '),
    labels: (j.jobLabels || []).join('; '),
    welfare: (j.welfareList || []).join('; '),
    companySize: j.brandScaleName || '',
    industry: j.brandIndustry || '',
    stage: j.brandStageName || '',
    recruiter: [j.bossName, j.bossTitle].filter(Boolean).join(' · '),
    jobId: j.encryptJobId || '',
    link: j.encryptJobId ? `${base}/job_detail/${j.encryptJobId}.html` : '',
  };
}

// Endpoint confirmed in a live logged-in session (2026-04).
export const bossSpec = {
  key: 'boss',
  label: 'BOSS',
  source: 'BOSS Zhipin',
  country: 'China',
  defaultBase: 'https://www.zhipin.com',
  defaultOutDir: () => 'China',
  apiPattern: '/wapi/zpgeek/search/joblist.json',
  paging: 'scroll',
  listSelector: '.job-list-container, .rec-job-list, .job-list-box, .search-job-result',
  loginHost: 'zhipin.com',
  probe: { loginUrl: '/web/user/|login' },
  resolveLocation: (input) => resolveCity(input.city),
  searchUrl: (base, query, city, page) => `${base}/web/geek/jobs?query=${encodeURIComponent(query)}&city=${city.code}${page > 1 ? `&page=${page}` : ''}`,
  parse: (data) => {
    if (data.code !== 0) return { error: `${data.message || 'API error'} (code ${data.code})`, items: [] };
    return { items: data.zpData?.jobList || [], hasMore: data.zpData?.hasMore !== false };
  },
  idOf: (j) => j.encryptJobId,
  mapRow: mapJob,
  // Keep the id import-manual-jobs derives itself, so BOSS drafts stay comparable with earlier imports.
  draftId: () => undefined,
  detailSelectors: ['.job-sec-text', '.job-detail-section .text', '[class*="job-sec-text"]', '.job-description'],
  detailHeading: '职位描述',
};

export default {
  definition,
  domains: ['zhipin.com'],
  approval: 'zhipin.com + PC files',
  promptHint: 'For BOSS直聘 / zhipin.com job searches, use boss_collect_jobs.',
  run: (ctx, input) => collectJobBoard(ctx, input, bossSpec),
};

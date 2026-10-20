// 猎聘 Liepin (liepin.com) jobs -> CSV + import draft, from the site's own search API.
// ENDPOINT NOT YET CONFIRMED in a live logged-in session: check it with capture_start +
// read_network_requests on a real search before relying on it, and set the setting
// `liepinApiPattern` if the request URL differs. Built and tested against tests/mock-llm.mjs.
import { collectJobBoard, jobBoardSchema, emptyRow, joinList } from './common.js';

// Liepin "dq" city codes.
export const LIEPIN_CITIES = {
  全国: '', 北京: '010', 上海: '020', 天津: '030', 重庆: '040', 广州: '050020', 深圳: '050090',
  杭州: '070020', 南京: '060020', 苏州: '060080', 武汉: '170020', 成都: '280020', 西安: '270020', 长沙: '180020',
};
export const CITY_ALIASES = {
  china: '全国', nationwide: '全国', all: '全国', beijing: '北京', shanghai: '上海', tianjin: '天津', chongqing: '重庆',
  guangzhou: '广州', shenzhen: '深圳', hangzhou: '杭州', nanjing: '南京', suzhou: '苏州', wuhan: '武汉',
  chengdu: '成都', xian: '西安', "xi'an": '西安', changsha: '长沙',
};

// table: { 城市: code }. A raw code that matches `codeRe` is passed through.
export function resolveFrom(table, city, codeRe, siteName) {
  if (!city) return { name: '全国', code: table['全国'] };
  const raw = String(city).trim();
  if (codeRe.test(raw)) return { name: Object.keys(table).find((k) => table[k] === raw) || raw, code: raw };
  const name = table[raw] !== undefined ? raw : CITY_ALIASES[raw.toLowerCase()];
  if (!name || table[name] === undefined) throw new Error(`Unknown city "${city}" for ${siteName}. Known: ${Object.keys(table).join(', ')} or a ${siteName} city code.`);
  return { name, code: table[name] };
}

export const liepinSpec = {
  key: 'liepin',
  label: 'Liepin',
  source: 'Liepin',
  country: 'China',
  defaultBase: 'https://www.liepin.com',
  defaultOutDir: () => 'China',
  apiPattern: 'pc-search-job',
  paging: 'url',
  loginHost: 'liepin.com',
  probe: { loginUrl: '/login|passport' },
  resolveLocation: (input) => resolveFrom(LIEPIN_CITIES, input.city, /^\d{3,6}$/, 'Liepin'),
  // currentPage is 0-based on liepin.com.
  searchUrl: (base, query, city, page) => `${base}/zhaopin/?key=${encodeURIComponent(query)}&dq=${city.code}&currentPage=${page - 1}`,
  parse: (data) => {
    if (data.flag === 0) return { error: `${data.msg || 'API error'} (flag 0)`, items: [] };
    const d = data.data?.data || {};
    const items = d.jobCardList || [];
    const pg = d.pagination;
    return { items, hasMore: pg ? pg.currentPage + 1 < pg.totalPage : items.length > 0 };
  },
  idOf: (it) => (it.job?.jobId != null ? String(it.job.jobId) : ''),
  mapRow: (it, base) => {
    const job = it.job || {};
    const comp = it.comp || {};
    const rec = it.recruiter || {};
    const [city, ...district] = String(job.dq || '').split('-');
    return {
      ...emptyRow(),
      title: job.title || '',
      company: comp.compName || '',
      salary: job.salary || '',
      city,
      district: district.join(' '),
      experience: job.requireWorkYears || '',
      degree: job.requireEduLevel || '',
      skills: joinList(job.labels),
      companySize: comp.compScale || '',
      industry: comp.compIndustry || '',
      stage: comp.compStage || '',
      recruiter: [rec.recruiterName, rec.recruiterTitle].filter(Boolean).join(' · '),
      jobId: job.jobId != null ? String(job.jobId) : '',
      link: job.link || (job.jobId ? `${base}/job/${job.jobId}.shtml` : ''),
    };
  },
  detailSelectors: ['.job-intro-container dd', '[data-selector="job-intro-content"]', '.job-intro-container', '.job-description'],
  detailHeading: '职位介绍',
};

export default {
  definition: {
    name: 'liepin_collect_jobs',
    description:
      'Collect job postings from 猎聘 Liepin (liepin.com) in this browser tab and save a CSV + import-manual-jobs draft on the PC (China folder), then run the import. ' +
      'Skips jobs collected before. The user must be logged in to liepin.com; on a login or verification page the tool pauses for the user.',
    input_schema: jobBoardSchema({
      locationDesc: `City in Chinese or English (${Object.keys(LIEPIN_CITIES).join(', ')}) or a Liepin dq code. Default 全国.`,
      outDirDesc: 'Folder in the jobs root (default "China").',
    }),
  },
  domains: ['liepin.com'],
  approval: 'liepin.com + PC files',
  promptHint: 'For 猎聘 Liepin job searches, use liepin_collect_jobs.',
  run: (ctx, input) => collectJobBoard(ctx, input, liepinSpec),
};

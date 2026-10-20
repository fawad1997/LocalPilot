// 智联招聘 Zhaopin (sou.zhaopin.com) jobs -> CSV + import draft, from the site's own search API.
// ENDPOINT NOT YET CONFIRMED in a live logged-in session: check it with capture_start +
// read_network_requests on a real search before relying on it, and set the setting
// `zhaopinApiPattern` if the request URL differs (the first page may be server-rendered).
// Built and tested against tests/mock-llm.mjs.
import { collectJobBoard, jobBoardSchema, emptyRow, joinList } from './common.js';
import { resolveFrom } from './liepin.js';

// Zhaopin "jl" city codes.
export const ZHAOPIN_CITIES = {
  全国: '489', 北京: '530', 上海: '538', 广州: '763', 深圳: '765', 武汉: '736', 杭州: '653',
  南京: '635', 苏州: '639', 成都: '801', 西安: '854', 长沙: '749',
};

export const zhaopinSpec = {
  key: 'zhaopin',
  label: 'Zhaopin',
  source: 'Zhaopin',
  country: 'China',
  defaultBase: 'https://sou.zhaopin.com',
  defaultOutDir: () => 'China',
  apiPattern: '/search/positions',
  paging: 'url',
  loginHost: 'zhaopin.com',
  probe: { loginUrl: '/login|passport' },
  resolveLocation: (input) => resolveFrom(ZHAOPIN_CITIES, input.city, /^\d{3}$/, 'Zhaopin'),
  searchUrl: (base, query, city, page) => `${base}/?jl=${city.code}&kw=${encodeURIComponent(query)}&p=${page}`,
  parse: (data) => {
    if (data.code !== 200) return { error: `${data.message || 'API error'} (code ${data.code})`, items: [] };
    const items = data.data?.list || [];
    return { items, hasMore: items.length > 0 };
  },
  idOf: (it) => String(it.number || it.jobId || ''),
  mapRow: (it) => {
    const staff = it.staffCard || {};
    return {
      ...emptyRow(),
      title: it.name || '',
      company: it.companyName || '',
      salary: it.salary60 || it.salaryReal || '',
      city: it.workCity || '',
      district: it.cityDistrict || '',
      experience: it.workingExp || '',
      degree: it.education || '',
      skills: joinList(it.jobSkillTags || it.skillLabel),
      welfare: joinList(it.welfareTagList),
      companySize: it.companySize || '',
      industry: it.industryName || '',
      stage: it.property || '',
      recruiter: [staff.staffName, staff.hrJob].filter(Boolean).join(' · '),
      jobId: String(it.number || it.jobId || ''),
      link: it.positionUrl || '',
    };
  },
  detailSelectors: ['.describtion__detail-content', '.job-detail__describe', '.describtion'],
  detailHeading: '职位描述',
};

export default {
  definition: {
    name: 'zhaopin_collect_jobs',
    description:
      'Collect job postings from 智联招聘 Zhaopin (zhaopin.com) in this browser tab and save a CSV + import-manual-jobs draft on the PC (China folder), then run the import. ' +
      'Skips jobs collected before. On a login or verification page the tool pauses for the user.',
    input_schema: jobBoardSchema({
      locationDesc: `City in Chinese or English (${Object.keys(ZHAOPIN_CITIES).join(', ')}) or a Zhaopin jl code. Default 全国.`,
      outDirDesc: 'Folder in the jobs root (default "China").',
    }),
  },
  domains: ['zhaopin.com'],
  approval: 'zhaopin.com + PC files',
  promptHint: 'For 智联招聘 Zhaopin job searches, use zhaopin_collect_jobs.',
  run: (ctx, input) => collectJobBoard(ctx, input, zhaopinSpec),
};

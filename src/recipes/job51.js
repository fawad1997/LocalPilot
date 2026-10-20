// 前程无忧 51job (we.51job.com) jobs -> CSV + import draft, from the site's own search API.
// ENDPOINT NOT YET CONFIRMED in a live logged-in session: check it with capture_start +
// read_network_requests on a real search before relying on it, and set the setting
// `job51ApiPattern` if the request URL differs. Built and tested against tests/mock-llm.mjs.
import { collectJobBoard, jobBoardSchema, emptyRow, joinList } from './common.js';
import { resolveFrom } from './liepin.js';

// 51job "jobArea" codes.
export const JOB51_CITIES = {
  全国: '000000', 北京: '010000', 上海: '020000', 广州: '030200', 深圳: '040000', 武汉: '180200',
  杭州: '080200', 南京: '070200', 苏州: '070300', 成都: '090200', 西安: '200200', 长沙: '190200',
};

export const job51Spec = {
  key: 'job51',
  label: '51job',
  source: '51job',
  country: 'China',
  defaultBase: 'https://we.51job.com',
  defaultOutDir: () => 'China',
  apiPattern: '/api/job/search-pc',
  paging: 'url',
  loginHost: '51job.com',
  probe: { loginUrl: '/login|passport' },
  resolveLocation: (input) => resolveFrom(JOB51_CITIES, input.city, /^\d{6}$/, '51job'),
  searchUrl: (base, query, city, page) => `${base}/pc/search?keyword=${encodeURIComponent(query)}&jobArea=${city.code}&pageNum=${page}`,
  parse: (data) => {
    if (String(data.status) !== '1') return { error: `${data.message || 'API error'} (status ${data.status})`, items: [] };
    const job = data.resultbody?.job || {};
    const items = job.items || [];
    return { items, hasMore: items.length > 0 };
  },
  idOf: (it) => (it.jobId != null ? String(it.jobId) : ''),
  mapRow: (it) => {
    const [city, ...district] = String(it.jobAreaString || '').split(/[·-]/);
    return {
      ...emptyRow(),
      title: it.jobName || '',
      company: it.fullCompanyName || it.companyName || '',
      salary: it.provideSalaryString || '',
      city,
      district: district.join(' '),
      experience: it.workYearString || '',
      degree: it.degreeString || '',
      skills: joinList(it.jobTags),
      welfare: joinList(it.jobWelfareCodeDataList || it.jobWelfare),
      companySize: it.companySizeString || '',
      industry: it.industryType1Str || '',
      stage: it.companyTypeString || '',
      recruiter: [it.hrName, it.hrPosition].filter(Boolean).join(' · '),
      jobId: it.jobId != null ? String(it.jobId) : '',
      link: it.jobHref || '',
      // The search API already carries the full description.
      description: String(it.jobDescribe || '').trim(),
    };
  },
  detailSelectors: ['.job_msg', '.bmsg.job_msg', '.tBorderTop_box .bmsg'],
  detailHeading: '职位信息',
};

export default {
  definition: {
    name: 'job51_collect_jobs',
    description:
      'Collect job postings from 前程无忧 51job (we.51job.com) in this browser tab and save a CSV + import-manual-jobs draft on the PC (China folder), then run the import. ' +
      'Skips jobs collected before. Descriptions come with the search data. On a login or verification page the tool pauses for the user.',
    input_schema: jobBoardSchema({
      locationDesc: `City in Chinese or English (${Object.keys(JOB51_CITIES).join(', ')}) or a 6-digit 51job jobArea code. Default 全国.`,
      outDirDesc: 'Folder in the jobs root (default "China").',
    }),
  },
  domains: ['51job.com'],
  approval: '51job.com + PC files',
  promptHint: 'For 前程无忧 51job job searches, use job51_collect_jobs.',
  run: (ctx, input) => collectJobBoard(ctx, input, job51Spec),
};

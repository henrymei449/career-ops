import { test } from 'node:test';
import assert from 'node:assert/strict';
import provider, { approvedQueryTerms, buildProfile, fetchOfficialDomainJobs, laneFallbackQueries } from '../../providers/official-domain-search.mjs';

const OVERRIDES = [
  { companies: ['Onto Innovation', 'HORIBA', 'Advantest'], positive_extra: ['Applications Engineer', 'Technical Program Manager + factory', 'Technical Program Manager + factory'] },
  { companies: ['KLA Corporation'], positive_extra: ['Should Not Leak'] },
];

test('provider is explicit-only (no detect) and registered under its id', () => {
  assert.equal(provider.id, 'official-domain-search');
  assert.equal(provider.detect, undefined);
});

test('approvedQueryTerms: exact-name match, AND-groups expanded, deduped, nothing invented', () => {
  assert.deepEqual(approvedQueryTerms('onto innovation', OVERRIDES), ['"Applications Engineer"', '"Technical Program Manager" factory']);
  assert.deepEqual(approvedQueryTerms('Nobody Corp', OVERRIDES), []);
  assert.ok(!approvedQueryTerms('HORIBA', OVERRIDES).includes('"Should Not Leak"'));
});

test('buildProfile requires host and job_path_re; regex strings compile case-insensitively', () => {
  assert.throws(() => buildProfile({}), /host is required/);
  assert.throws(() => buildProfile({ host: 'x.com' }), /job_path_re is required/);
  const p = buildProfile({ host: 'X.com', job_path_re: '/jobs/', lowercase_path: true, require_json_ld: true });
  assert.equal(p.host, 'x.com');
  assert.ok(p.jobPathRe.test('/JOBS/1'));
  assert.equal(p.requireJsonLd, true);
});

const ONTO_ENTRY = {
  name: 'Onto Innovation',
  official_domain_search: {
    host: 'wd1.myworkdaysite.com', path_prefix: '/recruiting/onto',
    job_path_re: '/onto_careers/(job/|details/)', req_id_re: '_(r-\\d+)', strip_path_suffix_re: '/apply$',
    lowercase_path: true, prefer_re: '/job/', require_json_ld: true,
  },
};
const jobHtml = (t) => `<script type="application/ld+json">{"@type":"JobPosting","title":"${t}","jobLocation":{"address":{"addressLocality":"Milpitas-CA","addressCountry":"United States of America"}}}</script>`;

test('fetchOfficialDomainJobs: only live pages become jobs; stale, 404 and duplicates never do; queries come from the approved terms', async () => {
  const queries = [];
  const search = async (q) => {
    queries.push(q);
    return [
      { title: 'a', url: 'https://wd1.myworkdaysite.com/recruiting/onto/ONTO_Careers/job/Milpitas-CA/Applications-Engineer-3_R-100' },
      { title: 'a', url: 'https://wd1.myworkdaysite.com/recruiting/onto/ONTO_Careers/job/Milpitas-CA/Applications-Engineer-3_R-100/apply' },
      { title: 'b', url: 'https://wd1.myworkdaysite.com/recruiting/onto/ONTO_Careers/job/Milpitas-CA/Stale-Role_R-200' },
      { title: 'c', url: 'https://wd1.myworkdaysite.com/recruiting/onto/ONTO_Careers/job/Milpitas-CA/Gone-Role_R-300' },
      { title: 'x', url: 'https://example.com/recruiting/onto/ONTO_Careers/job/x_R-1' },
    ];
  };
  const ctx = {
    titleFilterOverridesRaw: OVERRIDES,
    fetchText: async (url) => {
      if (/r-100/.test(url)) return jobHtml('Applications Engineer 3');
      if (/r-200/.test(url)) return '<html><title></title></html>'; // empty shell, no payload
      const e = new Error('HTTP 404'); e.status = 404; throw e;
    },
  };
  const jobs = await fetchOfficialDomainJobs(ONTO_ENTRY, ctx, { search });
  assert.equal(queries.length, 2, 'one query per approved term');
  assert.match(queries[0], /^site:wd1\.myworkdaysite\.com\/recruiting\/onto "Applications Engineer"$/);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Applications Engineer 3');
  assert.equal(jobs[0].company, 'Onto Innovation');
  assert.match(jobs[0].location, /Milpitas-CA/);
});

test('fetchOfficialDomainJobs: unavailable location becomes empty string (unknown), never a guess', async () => {
  const entry = {
    name: 'HORIBA',
    official_domain_search: { host: 'www.horiba.com', query_scope: 'horiba.com', query_extra: '"job-specification"', job_path_re: '/career/job-specification/action/show/Job/', req_id_re: '/Job/[^/]*?-(\\d+)$', body_location: true },
  };
  const search = async () => [{ title: 'Job Specification', url: 'https://www.horiba.com/gbr/company/career/job-specification/action/show/Job/service-engineer-i-1449/' }];
  const ctx = { titleFilterOverridesRaw: OVERRIDES, fetchText: async () => '<html><h1>Service Engineer I</h1><p>Support customers.</p></html>' };
  const jobs = await fetchOfficialDomainJobs(entry, ctx, { search });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].location, '', 'no location inferred from the /gbr/ locale path');
});

test('fetchOfficialDomainJobs: fails loudly with no approved queries, and when every fetch is a transport failure', async () => {
  await assert.rejects(fetchOfficialDomainJobs({ ...ONTO_ENTRY, name: 'Nobody Corp' }, { titleFilterOverridesRaw: OVERRIDES, fetchText: async () => '' }, { search: async () => [] }), /no approved title queries/);
  const search = async () => [{ title: 'a', url: 'https://wd1.myworkdaysite.com/recruiting/onto/ONTO_Careers/job/M/Role_R-1' }];
  await assert.rejects(fetchOfficialDomainJobs(ONTO_ENTRY, { titleFilterOverridesRaw: OVERRIDES, fetchText: async () => { throw new Error('ENOTFOUND'); } }, { search }), /every page fetch failed/);
});

test('search errors (missing key, quota) propagate as provider errors, not empty results', async () => {
  await assert.rejects(fetchOfficialDomainJobs(ONTO_ENTRY, { titleFilterOverridesRaw: OVERRIDES, fetchText: async () => '' }, { search: async () => { throw new Error('SERPER_API_KEY is not set'); } }), /SERPER_API_KEY/);
});

const LANES = [{ name: 'lane_b', companies: ['Onto Innovation', 'HORIBA'], fallback_queries: ['"Manufacturing Engineer"', '"Quality Engineer"', '"Manufacturing Engineer"'] }];

test('laneFallbackQueries: explicit list only, company-scoped, deduped, nothing invented', () => {
  assert.deepEqual(laneFallbackQueries('onto innovation', LANES), ['"Manufacturing Engineer"', '"Quality Engineer"']);
  assert.deepEqual(laneFallbackQueries('KLA Corporation', LANES), []);
  assert.deepEqual(laneFallbackQueries('HORIBA', undefined), []);
});

test('fetchOfficialDomainJobs: one single pass issues Lane A queries (unchanged) then the separate bounded lane B list', async () => {
  const queries = [];
  const ctx = { titleFilterOverridesRaw: OVERRIDES, titleFilterLanesRaw: LANES, fetchText: async () => '' };
  await fetchOfficialDomainJobs(ONTO_ENTRY, ctx, { search: async (q) => { queries.push(q); return []; } });
  const laneA = approvedQueryTerms('Onto Innovation', OVERRIDES);
  assert.equal(queries.length, laneA.length + 2);
  assert.deepEqual(queries.slice(0, laneA.length).map((q) => q.split(' ').slice(1).join(' ')), laneA, 'Lane A queries first, unchanged');
  assert.match(queries.at(-1), /"Quality Engineer"$/);
  const capped = { ...ONTO_ENTRY, official_domain_search: { ...ONTO_ENTRY.official_domain_search, max_lane_queries: 1 } };
  const q2 = []; await fetchOfficialDomainJobs(capped, ctx, { search: async (q) => { q2.push(q); return []; } });
  assert.equal(q2.length, laneA.length + 1, 'lane B list is bounded by max_lane_queries');
});

test('fetchOfficialDomainJobs: a lane-only company (no title_filter_overrides) still runs, and no queries at all is still an error', async () => {
  const ctx = { titleFilterOverridesRaw: [], titleFilterLanesRaw: LANES, fetchText: async () => '' };
  const q = []; await fetchOfficialDomainJobs(ONTO_ENTRY, ctx, { search: async (x) => { q.push(x); return []; } });
  assert.equal(q.length, 2);
  await assert.rejects(fetchOfficialDomainJobs({ ...ONTO_ENTRY, name: 'Nobody Corp' }, { titleFilterOverridesRaw: [], titleFilterLanesRaw: LANES, fetchText: async () => '' }, { search: async () => [] }), /no approved title queries/);
});

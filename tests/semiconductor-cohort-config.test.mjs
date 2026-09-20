// Narrow checks for the unified-semiconductor expansion (Pass 1 + Pass 2, 2026-09-19/20):
// Qnity, Air Liquide, Solstice, EMD, Pfeiffer Vacuum (provider-backed) and
// Edwards Vacuum, Henkel (official-domain-search) + Kurt J. Lesker, Brewer Science (local parsers).
// MacDermid Alpha was evaluated and REMOVED.
// Reads the operator's real portals.yml + semiconductor cohort file from the data root;
// skipped when that data root is not present (e.g. CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildTitleFilterOverrides, buildTitleFilterWithOverrides, buildTitleLanes, buildLaneTitleFilter } from '../scan.mjs';
import { resolveConfig as sfConfig } from '../providers/successfactors.mjs';

const yaml = createRequire(import.meta.url)('js-yaml');
// Data root: CAREER_OPS_DATA_DIR, else the repo's `.career-ops-data` marker file. No machine-specific default.
const REPO_ROOT = join(import.meta.dirname, '..');
const marker = join(REPO_ROOT, '.career-ops-data');
const DATA_ROOT = process.env.CAREER_OPS_DATA_DIR
  || (existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '');
const PORTALS = join(DATA_ROOT || '.', 'portals.yml');
const COHORT = join(DATA_ROOT || '.', 'semiconductor-15-companies.yml');
const REPO = REPO_ROOT;
const present = Boolean(DATA_ROOT) && existsSync(PORTALS) && existsSync(COHORT);
const opts = { skip: present ? false : 'data root portals.yml / cohort file not present' };

const NEW = ['Qnity Electronics', 'Air Liquide', 'Solstice Advanced Materials', 'EMD Electronics', 'Pfeiffer Vacuum',
  'Edwards Vacuum', 'Henkel', 'Kurt J. Lesker', 'Brewer Science'];
const load = () => {
  const cfg = yaml.load(readFileSync(PORTALS, 'utf8'));
  const gate = buildTitleFilterWithOverrides(cfg.title_filter, buildTitleFilterOverrides(cfg.title_filter_overrides));
  const lane = buildLaneTitleFilter(cfg.title_filter, buildTitleLanes(cfg.title_filter_lanes));
  return { cfg, gate, lane };
};
const admits = (c, title, company) => !!(c.gate(title, company) || c.lane(title, company));

test('provider / fallback-backed additions are enabled tracked entries with the expected providers', opts, () => {
  const { cfg } = load();
  const want = { 'Qnity Electronics': 'workday', 'Air Liquide': 'workday', 'Solstice Advanced Materials': 'oraclecloud',
    'EMD Electronics': 'phenom', 'Pfeiffer Vacuum': 'successfactors', 'Edwards Vacuum': 'official-domain-search',
    Henkel: 'official-domain-search' };
  for (const [name, provider] of Object.entries(want)) {
    const e = cfg.tracked_companies.filter((c) => c.name === name);
    assert.equal(e.length, 1, `${name}: exactly one tracked entry`);
    assert.equal(e[0].provider, provider);
    assert.equal(e[0].enabled, true);
  }
  for (const name of ['Kurt J. Lesker', 'Brewer Science']) {
    const e = cfg.tracked_companies.find((c) => c.name === name);
    assert.equal(e.scan_method, 'local_parser');
    assert.equal(e.parser.command, 'node');
    assert.ok(existsSync(join(REPO, e.parser.script)), `${name} parser script exists in the repo`);
  }
  assert.ok(!cfg.tracked_companies.some((c) => /macdermid/i.test(c.name)), 'MacDermid Alpha is removed');
});

test('Pfeiffer is scoped to the /pfeiffervacuum/ brand path, never the bare Busch host', opts, () => {
  const { cfg } = load();
  const e = cfg.tracked_companies.find((c) => c.name === 'Pfeiffer Vacuum');
  const r = sfConfig(e);
  assert.equal(r.tileApi, 'https://jobs.buschvacuum.com/pfeiffervacuum/tile-search-results/');
});

test('unified cohort: 15 originals + 5 Pass 1 + 4 Pass 2 = 24, all resolvable, MacDermid absent', opts, () => {
  const { cfg } = load();
  const names = [...readFileSync(COHORT, 'utf8').matchAll(/^\s*-\s*name:\s*(.+?)\s*$/gm)].map((m) => m[1]);
  assert.equal(names.length, 24);
  assert.ok(!names.some((n) => /macdermid/i.test(n)));
  for (const n of NEW) assert.ok(names.includes(n), `cohort has ${n}`);
  const tracked = new Set(cfg.tracked_companies.map((c) => c.name));
  for (const n of names) assert.ok(tracked.has(n), `${n} resolves to a tracked_companies entry`);
});

test('equipment-wide override block and Lane B are NOT polluted by the new companies', opts, () => {
  const { cfg } = load();
  const inEquipment = (list) => (list || []).filter((b) => (b.companies || []).includes('KLA Corporation'));
  for (const b of inEquipment(cfg.title_filter_overrides)) for (const n of NEW) assert.ok(!b.companies.includes(n), `override block leaked ${n}`);
  for (const l of inEquipment(cfg.title_filter_lanes)) for (const n of NEW) assert.ok(!l.companies.includes(n), `lane leaked ${n}`);
  // each new company sits in a block that contains ONLY new companies
  for (const b of cfg.title_filter_overrides) {
    const hits = (b.companies || []).filter((c) => NEW.includes(c));
    if (hits.length) assert.equal(hits.length, b.companies.length, 'new-company block must not mix in equipment companies');
  }
});

test('per-company vocabulary: approved titles pass, other companies\' titles do not', opts, () => {
  const c = load();
  assert.ok(admits(c, 'Senior Manufacturing Technology Engineer', 'Qnity Electronics'));
  assert.ok(admits(c, 'Automation & Process Control Engineer (MT)', 'Qnity Electronics'));
  assert.ok(!admits(c, 'Customer Technical Service Engineer', 'Qnity Electronics'));
  assert.ok(!admits(c, 'Customer Technical Service Engineer', 'Pfeiffer Vacuum'));
  assert.ok(admits(c, 'Technical Service and Applications Leader', 'Solstice Advanced Materials'));
  assert.ok(admits(c, 'Key Account Manager', 'Pfeiffer Vacuum'));
  assert.ok(admits(c, 'Key Account Customer Quality Engineer', 'Pfeiffer Vacuum'));
  assert.ok(admits(c, 'Applications Engineer, Semiconductor', 'Pfeiffer Vacuum'));
  assert.ok(!admits(c, 'Applications Engineer', 'Pfeiffer Vacuum'), 'unqualified Application Engineer stays out for Pfeiffer');
  assert.ok(admits(c, 'Senior Process Engineer', 'Air Liquide'));
  assert.ok(admits(c, 'Senior Reliability Engineer', 'Air Liquide'));
  assert.ok(!admits(c, 'Process Engineer', 'Air Liquide'), 'only the Senior Process Engineer form is approved for Air Liquide');
  // equipment vocabulary must not reach a new company, and new vocabulary must not reach equipment companies
  assert.ok(!admits(c, 'Applications Engineer', 'Solstice Advanced Materials'));
  assert.ok(!admits(c, 'Technical Program Manager', 'Qnity Electronics'));
  assert.ok(!admits(c, 'Key Account Manager', 'KLA Corporation'));
  assert.ok(!admits(c, 'Manufacturing Integration Engineer', 'ASML'));
});

test('EMD: title-expressible Gate 2B families pass; IT/OT-by-JD-only roles are a known deferred-recall gap', opts, () => {
  const c = load();
  assert.ok(admits(c, 'Automation Controls Engineer', 'EMD Electronics'));
  assert.ok(admits(c, 'Senior Applications Engineer', 'EMD Electronics'));
  // Not recoverable from the title alone (deferred recall): a role whose title carries no family word.
  assert.ok(!admits(c, 'Plant Systems Specialist', 'EMD Electronics'));
});

test('qualified leadership lanes: Engineering Manager admitted only where the approved tie is in the title', opts, () => {
  const c = load();
  assert.equal(c.lane('Applications Engineering Manager', 'EMD Electronics'), 'semiconductor_leadership');
  assert.equal(c.lane('Manufacturing Engineering Manager', 'EMD Electronics'), 'semiconductor_leadership');
  assert.equal(c.lane('Technical Engineering Manager, Advanced Materials', 'Air Liquide'), 'semiconductor_leadership');
  assert.equal(c.lane('Engineering Manager', 'Air Liquide'), null, 'bare Engineering Manager stays vetoed');
  assert.equal(c.lane('Applications Engineering Manager', 'Qnity Electronics'), null, 'lane is company-scoped');
  assert.equal(c.lane('Applications Engineering Manager Intern', 'EMD Electronics'), null, 'lane negatives apply');
});

test('Pass 2 per-company vocabulary: Edwards / KDF / Brewer approved titles pass, avoided titles and other companies do not', opts, () => {
  const c = load();
  for (const ttl of ['Applications Engineer', 'Senior Applications Engineer', 'Technical Support Engineer', 'Senior Technical Support Engineer', 'Service Sales Engineer', 'Territory Sales Engineer - Great Lakes']) {
    assert.ok(admits(c, ttl, 'Edwards Vacuum'), `Edwards: ${ttl}`);
  }
  for (const ttl of ['Field Service Engineer', 'Service Technician', 'Equipment Technician', 'Installation Technician', 'Mechanical Design Engineer']) {
    assert.ok(!admits(c, ttl, 'Edwards Vacuum'), `Edwards must not admit: ${ttl}`);
  }
  assert.ok(admits(c, 'Applications Engineer', 'Kurt J. Lesker'));
  assert.ok(admits(c, 'Electrical Controls Engineer', 'Kurt J. Lesker'));
  assert.ok(!admits(c, 'Electrical Engineer II', 'Kurt J. Lesker'), 'generic electrical design stays out');
  assert.ok(!admits(c, 'Mechanical Engineer II', 'Kurt J. Lesker'));
  for (const ttl of ['Process Engineer I', 'Process Engineer II or III', 'Process Engineer IV', 'Principal Applications Engineer I, II, or III']) {
    assert.ok(admits(c, ttl, 'Brewer Science'), `Brewer: ${ttl}`);
  }
  for (const ttl of ['Controls Engineer II, III, or IV', 'Quality Engineer I', 'Process Engineer Intern', 'Formulation Scientist']) {
    assert.ok(!admits(c, ttl, 'Brewer Science'), `Brewer must not admit: ${ttl}`);
  }
  // company scoping: none of these titles leak to other companies
  assert.ok(!admits(c, 'Technical Support Engineer', 'Kurt J. Lesker'));
  assert.ok(!admits(c, 'Electrical Controls Engineer', 'Brewer Science'));
});

test('Henkel lane: application-engineer family admitted; Commercial only when electronics/semiconductor-qualified', opts, () => {
  const c = load();
  for (const ttl of ['Application Engineer', 'Senior Application Engineer', 'Principal Application Engineer', 'Manager Application Engineer', 'Sr Application Engineer', 'Lead Application Engineer for Business Development']) {
    assert.equal(c.lane(ttl, 'Henkel'), 'semiconductor_applications', ttl);
  }
  assert.equal(c.lane('Commercial Application Engineer', 'Henkel'), null, 'unqualified Commercial is excluded');
  assert.equal(c.lane('Commercial Application Engineer - Printed Electronics', 'Henkel'), 'semiconductor_applications');
  assert.equal(c.lane('Commercial Application Engineer, Semiconductor', 'Henkel'), 'semiconductor_applications');
  assert.equal(c.lane('Application Scientist', 'Henkel'), null);
  assert.equal(c.lane('Application Engineer Intern', 'Henkel'), null);
  assert.equal(c.lane('Application Engineer', 'Edwards Vacuum'), null, 'lane is Henkel-scoped');
});

test('official-domain-search wiring for Edwards and Henkel: bounded, scoped, queries from approved config only', opts, async () => {
  const { cfg } = load();
  const P = await import('../providers/official-domain-search.mjs');
  for (const name of ['Edwards Vacuum', 'Henkel']) {
    const e = cfg.tracked_companies.find((x) => x.name === name);
    const p = P.buildProfile(e.official_domain_search);
    assert.ok(e.official_domain_search.max_unique <= 60 && e.official_domain_search.max_fetch <= 40, `${name} stays bounded`);
    assert.ok(p.jobPathRe && p.reqIdRe, `${name} has a posting-shape regex and requisition-id dedupe`);
  }
  const ed = cfg.tracked_companies.find((x) => x.name === 'Edwards Vacuum').official_domain_search;
  assert.equal(ed.host, 'www.edwardsvacuum.com');
  assert.match('/en-us/join-us/job-overview/job-detail/technical-support-engineer/167113-edwards', P.buildProfile(ed).jobPathRe);
  assert.doesNotMatch('/en-us/careers/jobs/job-overview/job-detail/field-service-engineer/166276', P.buildProfile(ed).jobPathRe, 'Atlas Copco (non-Edwards) posting shape is out of scope');
  const q = P.approvedQueryTerms('Edwards Vacuum', cfg.title_filter_overrides);
  assert.ok(q.includes('"Territory Sales Engineer"') && q.every((s) => !/Field Service|Technician/i.test(s)));
  const hq = P.laneFallbackQueries('Henkel', cfg.title_filter_lanes);
  assert.ok(hq.length >= 4 && hq.length <= 10);
  assert.deepEqual(P.laneFallbackQueries('Edwards Vacuum', cfg.title_filter_lanes), []);
});

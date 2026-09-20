// Regression tests for the Semiconductor title_filter_overrides correction
// (2026-09-19 title-scope audit): plural/singular spellings and title-level
// AND-qualifiers made approved families reject real titles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildTitleFilterOverrides, buildTitleFilterWithOverrides, buildTitleLanes, buildLaneTitleFilter } from '../scan.mjs';

const yaml = createRequire(import.meta.url)('js-yaml');

// Mirrors the corrected approved block (only the families this correction touches,
// plus the qualified Program Manager entries that must keep bare "Program Manager" out).
const TITLE_FILTER = { positive: ['data engineer'], negative: ['word:intern', 'devops', 'account executive'] };
const OVERRIDES = [{
  companies: ['ASML', 'Nova'],
  positive_extra: [
    'Applications Engineer', 'Application Engineer', 'Senior Applications Engineer',
    'Field Applications Engineer', 'Field Application Engineer',
    'Applications Scientist', 'Application Scientist',
    'Technical Program Manager', 'Technical Product Support', 'Technical Account Manager',
    'Program Manager + capital equipment', 'Program Manager + customer', 'Program Manager + install',
    'AI Application Engineer + semiconductor', 'AI Infrastructure Applications Engineer + semiconductor',
  ],
}];

function suite(gate, company) {
  const pass = [
    'Application Engineer', 'Applications Engineer', 'Application Scientist', 'Applications Scientist',
    'Field Application Engineer', 'Field Applications Engineer',
    'Technical Program Manager', 'Technical Program Manager 4', 'Senior Technical Account Manager',
    'Application Engineer III (E3)', 'Senior software application engineer',
  ];
  const reject = [
    'Program Manager', 'Customer Support Engineer', 'Customer Support Engineer (Field Service)',
    'AI Infrastructure Applications Engineer Intern', 'IT DevOps Applications Engineer',
    'Account Manager', 'Sales Account Manager', 'Global Product Support Engineer', 'Automation Engineer',
  ];
  for (const t of pass) assert.equal(gate(t, company), true, `should PASS: ${t}`);
  for (const t of reject) assert.equal(gate(t, company), false, `should be REJECTED: ${t}`);
}

test('corrected override block: singular/plural applications families and bare Technical Program/Account Manager pass; false friends stay out', () => {
  const gate = buildTitleFilterWithOverrides(TITLE_FILTER, buildTitleFilterOverrides(OVERRIDES));
  suite(gate, 'ASML');
  suite(gate, 'nova');
});

test('qualified Program Manager forms still work; bare Program Manager needs a title qualifier', () => {
  const gate = buildTitleFilterWithOverrides(TITLE_FILTER, buildTitleFilterOverrides(OVERRIDES));
  assert.equal(gate('Program Manager, Customer Programs', 'ASML'), true);
  assert.equal(gate('Program Manager', 'ASML'), false);
});

test('overrides stay scoped: a company outside the list gets no widening', () => {
  const gate = buildTitleFilterWithOverrides(TITLE_FILTER, buildTitleFilterOverrides(OVERRIDES));
  assert.equal(gate('Application Engineer', 'Some Other Corp'), false);
});

// The same expectations against the live data-root portals.yml, when this checkout has one.
const dataRoot = process.env.CAREER_OPS_DATA_DIR;
const livePath = dataRoot && join(dataRoot, 'portals.yml');
test('live portals.yml Semiconductor overrides satisfy the same expectations', { skip: !(livePath && existsSync(livePath)) }, () => {
  const cfg = yaml.load(readFileSync(livePath, 'utf8'));
  const gate = buildTitleFilterWithOverrides(cfg.title_filter, buildTitleFilterOverrides(cfg.title_filter_overrides));
  suite(gate, 'ASML');
  suite(gate, 'Nova');
});

// ── Lane B: separate company-scoped title lane ─────────────────────────
const LANE_TITLE_FILTER = { positive: ['data engineer'], negative: ['word:intern', 'Production Supervisor', 'Operations Manager', 'Engineering Manager', 'Software Engineer'] };
const LANES = [{
  name: 'semiconductor_lane_b',
  companies: ['ASML', 'Entegris', 'Nova'],
  positive: ['manufacturing engineer', 'manufacturing operation', 'production supervisor', 'production engineer', 'quality engineer', 'industrial engineer',
    'continuous improvement', 'new product introduction', 'word:npi', 'manufacturing + program manager', 'manufacturing + project manager'],
  global_negative_exceptions: ['production supervisor', 'operations manager', 'engineering manager'],
  negative: ['co-op', 'technician', 'word:tech', 'operator', 'planning', 'materials project', 'npi materials', 'software', 'word:director', 'sourcing'],
}];
const laneOf = buildLaneTitleFilter(LANE_TITLE_FILTER, buildTitleLanes(LANES));
const laneAGate = buildTitleFilterWithOverrides(LANE_TITLE_FILTER, buildTitleFilterOverrides([]));

test('lane B admits manufacturing/quality/CI/NPI titles for listed companies only', () => {
  for (const t of ['Senior Manufacturing Engineer', 'Manager, Manufacturing Operations Management', 'Production Engineer', 'Senior Quality Engineer',
    'Senior Engineer, Quality Engineering', 'Industrial Engineer IV', 'Senior Manager, Continuous Improvement', 'Manager, New Product Introduction', 'NPI Senior Engineer',
    'Manufacturing- Project Manager- Tainan']) {
    assert.equal(laneOf(t, 'ASML'), 'semiconductor_lane_b', `should be admitted: ${t}`);
  }
  assert.equal(laneOf('Senior Manufacturing Engineer', 'Some Other Corp'), null, 'lane is company-scoped');
});

test('lane B: the four known false positives and entry/shop-floor/noise titles are rejected', () => {
  for (const t of ['Manufacturing Engineering Tech 3', 'NPI Materials Project Manager IV - (B4)', 'Manufacturing- Production Planning Project Lead-Tainan',
    'Asia Quality Engineering Director', 'Manufacturing Engineering Co-Op', 'Manufacturing Technician II', 'Manufacturing Operator', 'Senior Software Quality Assurance Engineer',
    'Quality Assurance Engineer', 'Senior Strategic NPI Sourcing Manager', 'Manufacturing Intern', 'Program Manager', 'Process Engineer']) {
    assert.equal(laneOf(t, 'ASML'), null, `should be rejected: ${t}`);
  }
});

test('lane B: global negatives still veto, except the lane-scoped exceptions; the global list is untouched for everyone else', () => {
  assert.equal(laneOf('Manufacturing Intern', 'ASML'), null, 'a global negative (intern) still vetoes lane B');
  for (const t of ['Production Supervisor', 'Manufacturing Operations Manager', 'Manufacturing Engineering Manager']) {
    assert.equal(laneOf(t, 'Entegris'), 'semiconductor_lane_b', `excepted global negative should not veto: ${t}`);
    assert.equal(laneAGate(t, 'Entegris'), false, `the existing gate is unchanged and still rejects: ${t}`);
  }
  assert.equal(laneOf('Manufacturing Software Engineer', 'Entegris'), null, 'other global negatives keep vetoing');
});

test('lane B never re-admits Lane A behavior: titles the existing gate accepts are not lane B titles', () => {
  const overrides = buildTitleFilterOverrides([{ companies: ['ASML'], positive_extra: ['Applications Engineer', 'Application Engineer'] }]);
  const gate = buildTitleFilterWithOverrides(LANE_TITLE_FILTER, overrides);
  assert.equal(gate('Application Engineer', 'ASML'), true);
  assert.equal(laneOf('Application Engineer', 'ASML'), null, 'not a lane B title');
});

test('lane config without positives or companies builds nothing (no accidental global lane)', () => {
  assert.equal(buildTitleLanes([{ name: 'x', companies: ['ASML'], positive: [] }]).length, 0);
  assert.equal(buildTitleLanes([{ name: 'x', positive: ['manufacturing engineer'] }]).length, 0);
  assert.equal(buildTitleLanes(undefined).length, 0);
});

test('live portals.yml lane B: known strong titles admitted, known false positives rejected, Lane A unchanged', { skip: !(livePath && existsSync(livePath)) }, () => {
  const cfg = yaml.load(readFileSync(livePath, 'utf8'));
  const gateA = buildTitleFilterWithOverrides(cfg.title_filter, buildTitleFilterOverrides(cfg.title_filter_overrides));
  const lane = buildLaneTitleFilter(cfg.title_filter, buildTitleLanes(cfg.title_filter_lanes));
  for (const [t, co] of [['Production Supervisor', 'Entegris'], ['Manufacturing Operations Manager', 'Tokyo Electron'], ['Manufacturing Engineering Manager', 'Entegris'],
    ['Manufacturing Quality Engineering Manager', 'ASML'], ['Industrial Engineer IV', 'Applied Materials'], ['Supervisor, Manufacturing Operations', 'Veeco']]) {
    assert.equal(lane(t, co), 'semiconductor_lane_b', `${co}: ${t}`);
  }
  for (const [t, co] of [['Manufacturing Engineering Tech 3', 'MKS Instruments'], ['NPI Materials Project Manager IV - (B4)', 'Applied Materials'],
    ['Manufacturing- Production Planning Project Lead-Tainan', 'ASML'], ['Asia Quality Engineering Director', 'Entegris'], ['Process Engineer', 'Lam Research']]) {
    assert.equal(lane(t, co), null, `${co}: ${t}`);
  }
  assert.equal(gateA('Technical Program Manager 4', 'Lam Research'), true, 'Lane A still accepts');
  assert.equal(gateA('Production Supervisor', 'Entegris'), false, 'Lane A / global negatives unchanged');
});

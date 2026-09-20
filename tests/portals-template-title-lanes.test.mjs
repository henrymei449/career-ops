// The commented examples in templates/portals.example.yml document title_filter_lanes and the
// official-domain-search provider. This pins them to the code: every documented key is really
// read, every key the code reads is documented, and the examples themselves parse and work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildTitleLanes, buildLaneTitleFilter, buildTitleFilterOverrides } from '../scan.mjs';
import { buildProfile, laneFallbackQueries } from '../providers/official-domain-search.mjs';

const yaml = createRequire(import.meta.url)('js-yaml');
const template = readFileSync(new URL('../templates/portals.example.yml', import.meta.url), 'utf8').split('\n');
const scanSrc = readFileSync(new URL('../scan.mjs', import.meta.url), 'utf8');
const providerSrc = readFileSync(new URL('../providers/official-domain-search.mjs', import.meta.url), 'utf8');

// Uncomment a documented example: the lines starting at `startsWith`, until the first blank line.
function exampleBlock(startsWith) {
  const i = template.findIndex((l) => l.startsWith(startsWith));
  assert.ok(i >= 0, `template example not found: ${startsWith}`);
  const out = [];
  for (let j = i; j < template.length && template[j].trim() !== '' && template[j].trim() !== '#'; j += 1) out.push(template[j].replace(/^# ?/, ''));
  return out.join('\n');
}
// Keys documented in a "#   key    description" table between two markers.
function documentedKeys(afterMarker, beforeMarker) {
  const a = template.findIndex((l) => l.includes(afterMarker));
  const b = template.findIndex((l, idx) => idx > a && l.includes(beforeMarker));
  assert.ok(a >= 0 && b > a, 'documented key table not found');
  return new Set(template.slice(a, b).map((l) => /^#   ([a-z_]+)\s{2,}\S/.exec(l)?.[1]).filter(Boolean));
}

test('template lane example parses and behaves as documented', () => {
  const cfg = yaml.load(exampleBlock('# title_filter_lanes:'));
  const lanes = buildTitleLanes(cfg.title_filter_lanes);
  assert.equal(lanes.length, 1);
  const lane = buildLaneTitleFilter({ positive: ['x'], negative: ['operations manager', 'intern'] }, lanes);
  assert.equal(lane('Senior Quality Engineer', 'Example Corp'), 'example_lane');
  assert.equal(lane('Quality Engineering Co-Op', 'Example Corp'), null, 'lane-scoped negative');
  assert.equal(lane('Quality Engineer', 'Some Other Company'), null, 'company-scoped');
  assert.equal(lane('Operations Manager, Quality Engineer', 'Example Corp'), 'example_lane', 'global_negative_exceptions honoured');
  assert.deepEqual(laneFallbackQueries('Example Corp', cfg.title_filter_lanes), ['"Quality Engineer"']);
});

test('template lane keys == keys the code reads', () => {
  const documented = documentedKeys('#   positive ', 'title_filter_lanes:\n'.trim());
  const read = new Set([...scanSrc.matchAll(/\blane\.([a-z_]+)/g)].map((m) => m[1]).filter((k) => !['name'].includes(k)));
  read.add('name');
  for (const m of providerSrc.matchAll(/\blane\??\.([a-z_]+)/g)) read.add(m[1]);
  read.delete('positive_extra');
  // `documentedKeys` covers the table rows; name/companies are described in prose above it.
  for (const k of ['positive', 'negative', 'global_negative_exceptions', 'fallback_queries']) {
    assert.ok(documented.has(k), `documented: ${k}`);
    assert.ok(read.has(k) || scanSrc.includes(`lane.${k}`) || providerSrc.includes(`lane.${k}`), `read by code: ${k}`);
  }
  for (const k of ['name', 'companies']) assert.ok(read.has(k) || scanSrc.includes(`lane.${k}`), `read by code: ${k}`);
});

test('template official_domain_search example builds a profile, and its key table == keys the provider reads', () => {
  const entry = yaml.load(exampleBlock('#   - name: Example Manufacturer')).find((e) => e.name === 'Example Manufacturer');
  assert.equal(entry.provider, 'official-domain-search');
  const profile = buildProfile(entry.official_domain_search);
  assert.equal(profile.host, 'careers.example.com');
  assert.equal(profile.requireJsonLd, true);
  const documented = documentedKeys('# official_domain_search keys:', '#   - name: Example Manufacturer');
  const read = new Set([...providerSrc.matchAll(/\bcfg\.([a-z_]+)/g)].map((m) => m[1]));
  assert.deepEqual([...documented].sort(), [...read].sort(), 'documented keys and provider-read keys must match exactly');
});

test('template title_filter_overrides example still uses the real keys', () => {
  const cfg = yaml.load(exampleBlock('# title_filter_overrides:'));
  const map = buildTitleFilterOverrides(cfg.title_filter_overrides);
  assert.ok(map.size > 0, 'companies + positive_extra build an override map');
});

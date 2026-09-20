// Unit tests for the two fixed-tenant local parsers (offline fixtures; no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLeskerJobs } from '../../scripts/parsers/lesker-jazzhr-jobs.mjs';
import { parseBrewerJobs } from '../../scripts/parsers/brewer-newton-jobs.mjs';

const LESKER = `<table>
<tr class="resumator-table-row-odd"><td class="resumator-job-title-column"><a href="https://lesker.applytojob.com/apply/d7OC0MmJTm/Electrical-Controls-Engineer" class="resumator-job-title-link">Electrical Controls Engineer</a></td><td class="resumator-department-column">Engineering</td><td class="resumator-job-location-column">Rockleigh, NJ</td></tr>
<tr class="resumator-table-row-even"><td class="resumator-job-title-column"><a href="https://lesker.applytojob.com/apply/1NyFdwq8oJ/CNC-Apprentice-Trainer" class="resumator-job-title-link">CNC Apprentice Trainer</a></td><td class="resumator-department-column">Machine Shop</td><td class="resumator-job-location-column">Jefferson Hill&#039;s, PA</td></tr>
<tr class="resumator-table-row-odd"><td class="resumator-job-title-column"><a href="https://othertenant.applytojob.com/apply/ZZZZZZZZZZ/Applications-Engineer" class="resumator-job-title-link">Applications Engineer</a></td><td class="resumator-job-location-column">Elsewhere</td></tr>
<tr class="resumator-table-row-even"><td class="resumator-job-title-column"><a href="https://lesker.applytojob.com/apply/d7OC0MmJTm/Electrical-Controls-Engineer" class="resumator-job-title-link">Electrical Controls Engineer</a></td><td class="resumator-job-location-column">Rockleigh, NJ</td></tr>
</table>`;

test('lesker parser: rows become jobs, entities decoded, duplicate and other-tenant rows dropped', () => {
  const jobs = parseLeskerJobs(LESKER);
  assert.deepEqual(jobs.map((j) => j.title), ['Electrical Controls Engineer', 'CNC Apprentice Trainer']);
  assert.equal(jobs[0].location, 'Rockleigh, NJ');
  assert.equal(jobs[0].department, 'Engineering');
  assert.equal(jobs[1].location, "Jefferson Hill's, PA");
  assert.ok(jobs.every((j) => new URL(j.url).hostname === 'lesker.applytojob.com'), 'no other applytojob tenant leaks in');
  assert.deepEqual(parseLeskerJobs('<html>no jobs</html>'), []);
});

const CID = '8acda110429450380142bb4441fe1efd';
const BREWER = `
<div class="gnewtonCareerGroupHeaderClass"> Dayton, OH </div>
<div class="gnewtonCareerGroupRowClass"><div class="gnewtonCareerGroupJobTitleClass">
<a href="https://recruitingbypaycor.com/career/JobIntroduction.action?clientId=${CID}&amp;id=AAA111&amp;source=&amp;lang=en"> Process Engineer I </a></div>
<div class="gnewtonCareerGroupJobDescriptionClass"> Process Engineering </div></div>
<div class="gnewtonCareerGroupHeaderClass"> Rolla, MO </div>
<div class="gnewtonCareerGroupRowClass"><div class="gnewtonCareerGroupJobTitleClass">
<a href="https://recruitingbypaycor.com/career/JobIntroduction.action?clientId=${CID}&amp;id=BBB222&amp;source=&amp;lang=en">Applications Engineer II, III, IV</a></div>
<div class="gnewtonCareerGroupJobDescriptionClass">Applications</div></div>
<div class="gnewtonCareerGroupRowClass"><div class="gnewtonCareerGroupJobTitleClass">
<a href="https://recruitingbypaycor.com/career/JobIntroduction.action?clientId=OTHERCLIENT&amp;id=CCC333">Process Engineer</a></div></div>
<div class="gnewtonCareerGroupRowClass"><div class="gnewtonCareerGroupJobTitleClass">
<a href="https://recruitingbypaycor.com/career/JobIntroduction.action?clientId=${CID}&amp;id=BBB222&amp;source=&amp;lang=en">Applications Engineer II, III, IV</a></div></div>`;

test('brewer parser: jobs inherit the preceding location header; other clients and duplicates dropped', () => {
  const jobs = parseBrewerJobs(BREWER);
  assert.deepEqual(jobs.map((j) => [j.title, j.location, j.department]), [
    ['Process Engineer I', 'Dayton, OH', 'Process Engineering'],
    ['Applications Engineer II, III, IV', 'Rolla, MO', 'Applications'],
  ]);
  assert.ok(jobs.every((j) => j.url.includes(`clientId=${CID}`) && !j.url.includes('&amp;')));
  assert.deepEqual(parseBrewerJobs('<html></html>'), []);
});

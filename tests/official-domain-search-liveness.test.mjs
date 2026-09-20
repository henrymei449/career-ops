import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessJobPage, extractLocationFromBody } from '../lib/official-domain-search.mjs';

const ONTO = { requireJsonLd: true };
const HORIBA = { bodyLocation: true };

const liveOnto = '<html><script type="application/ld+json">{"@type":"JobPosting","title":"Applications Engineer 3","jobLocation":{"address":{"addressLocality":"Hillsboro-OR","addressCountry":"United States of America"}}}</script></html>';
const emptyShell = '<html><head><title></title></head><body><div id="app"></div></body></html>';

test('Onto: live page (JobPosting payload) is valid with structured location', () => {
  const r = assessJobPage({ status: 200, html: liveOnto }, ONTO);
  assert.equal(r.live, true);
  assert.equal(r.title, 'Applications Engineer 3');
  assert.match(r.location, /Hillsboro-OR/);
  assert.equal(r.method, 'json-ld');
});

test('Onto: stale empty shell (no job payload) is rejected, never a survivor', () => {
  const r = assessJobPage({ status: 200, html: emptyShell }, ONTO);
  assert.equal(r.live, false);
  assert.equal(r.reason, 'no-job-payload');
});

test('Onto: generic careers page with an h1 but no JobPosting payload is rejected', () => {
  const r = assessJobPage({ status: 200, html: '<html><title>Careers at ONTO</title><h1>Careers at ONTO</h1></html>' }, ONTO);
  assert.equal(r.live, false);
});

test('HORIBA: HTTP 404 and 410 are rejected', () => {
  assert.equal(assessJobPage({ status: 404, html: '<h1>Service Engineer I</h1>' }, HORIBA).reason, 'http-404');
  assert.equal(assessJobPage({ status: 410, html: '' }, HORIBA).live, false);
  assert.equal(assessJobPage({ status: 500, html: '' }, HORIBA).live, false);
});

test('HORIBA: 200 response whose title says "Page not found" is rejected', () => {
  const r = assessJobPage({ status: 200, html: '<html><title>Job Specification - HORIBA</title><h1>Page not found</h1></html>' }, HORIBA);
  assert.equal(r.live, false);
  assert.equal(r.reason, 'dead-page-title');
});

test('HORIBA: generic "Job Specification" title alone is not a job', () => {
  const r = assessJobPage({ status: 200, html: '<html><h1>Job Specification</h1></html>' }, HORIBA);
  assert.equal(r.live, false);
  assert.equal(r.reason, 'generic-title');
});

test('HORIBA: live page yields h1 title and a body-text location', () => {
  const html = '<html><h1>Manufacturing Engineer</h1><p>HORIBA is searching for an experienced Manufacturing Engineer in Austin, TX.</p></html>';
  const r = assessJobPage({ status: 200, html }, HORIBA);
  assert.equal(r.live, true);
  assert.equal(r.title, 'Manufacturing Engineer');
  assert.equal(r.location, 'Austin, TX');
  assert.match(r.method, /body-text/);
});

test('location extraction: label, state name, state abbreviation, "the X office" forms', () => {
  assert.deepEqual(extractLocationFromBody('<p>Job Location: Reno, NV</p>'), { location: 'Reno, NV', method: 'label' });
  assert.equal(extractLocationFromBody('<p>Design Engineer for our operation located in Piscataway, New Jersey.</p>').location, 'Piscataway, New Jersey');
  assert.equal(extractLocationFromBody('<p>an Administrative Assistant in the Reno, NV office.</p>').location, 'Reno, NV');
  assert.equal(extractLocationFromBody('<p>support our location in Salt Lake City, UT.</p>').location, 'Salt Lake City, UT');
});

test('location unavailable: no place text, country-only prose, nav/footer geography, locale-path words', () => {
  assert.equal(extractLocationFromBody('<p>Bachelor degree in Engineering; ServiceMax or SAP experience is a plus.</p>').location, 'unavailable');
  assert.equal(extractLocationFromBody('<p>Field Service Engineer for our Goeteburg office in Sweden</p>').location, 'unavailable');
  assert.equal(extractLocationFromBody('<nav>Kyoto, Japan</nav><footer>Head office in Kyoto, Japan</footer><p>No place here.</p>').location, 'unavailable');
  // The URL/locale path is never an input, so it cannot leak into the result.
  const r = assessJobPage({ status: 200, html: '<html><h1>Service Engineer I</h1><p>Provide field support.</p></html>' }, HORIBA);
  assert.equal(r.live, true);
  assert.equal(r.location, 'unavailable');
});

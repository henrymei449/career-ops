#!/usr/bin/env node
// Local parser: Kurt J. Lesker Company careers board (JazzHR / "resumator" list markup).
// Prints jobs-json-v1 ([{title,url,location,department}]) to stdout.
// Deliberately NOT a generic JazzHR provider: the tenant is fixed to lesker.applytojob.com
// and any row whose link points at another host is dropped.
import { pathToFileURL } from 'node:url';

export const BOARD_URL = 'https://lesker.applytojob.com/';
const ALLOWED_HOST = 'lesker.applytojob.com';

const decode = (s) => s.replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const text = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** @param {string} html @returns {Array<{title:string,url:string,location:string,department:string}>} */
export function parseLeskerJobs(html) {
  const jobs = [];
  const seen = new Set();
  for (const row of String(html).matchAll(/<tr[^>]*class="[^"]*resumator-table-row[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const a = /<a[^>]+href="([^"]+)"[^>]*class="[^"]*resumator-job-title-link[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(row[1])
      || /<a[^>]+class="[^"]*resumator-job-title-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(row[1]);
    if (!a) continue;
    let url;
    try { url = new URL(decode(a[1]), BOARD_URL); } catch { continue; }
    if (url.hostname !== ALLOWED_HOST || !/^\/apply\/[A-Za-z0-9]+/.test(url.pathname)) continue; // no other tenant leaks in
    const title = text(a[2]);
    if (!title || seen.has(url.pathname)) continue;
    seen.add(url.pathname);
    const loc = /resumator-job-location-column[^>]*>([\s\S]*?)<\/td>/.exec(row[1]);
    const dep = /resumator-department-column[^>]*>([\s\S]*?)<\/td>/.exec(row[1]);
    jobs.push({ title, url: url.origin + url.pathname, location: loc ? text(loc[1]) : '', department: dep ? text(dep[1]) : '' });
  }
  return jobs;
}

async function main() {
  const res = await fetch(BOARD_URL, { headers: { 'user-agent': 'Mozilla/5.0 (career-ops)' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`lesker board HTTP ${res.status}`);
  const jobs = parseLeskerJobs(await res.text());
  if (jobs.length === 0) throw new Error('lesker board parsed 0 jobs (markup changed?)');
  process.stdout.write(JSON.stringify(jobs));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

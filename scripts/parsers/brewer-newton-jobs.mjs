#!/usr/bin/env node
// Local parser: Brewer Science careers board (Newton / Paycor Recruiting hosted list, static HTML).
// Prints jobs-json-v1 ([{title,url,location,department}]) to stdout.
// The client id is fixed to Brewer Science; job links for any other client are dropped.
import { pathToFileURL } from 'node:url';

const CLIENT_ID = '8acda110429450380142bb4441fe1efd';
export const BOARD_URL = `https://newton.newtonsoftware.com/career/CareerHome.action?clientId=${CLIENT_ID}`;

const decode = (s) => s.replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const text = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * The list is a sequence of location headers (gnewtonCareerGroupHeaderClass) each followed by
 * job rows (title link + department). Walk it in document order so each job inherits the
 * most recent location header.
 * @param {string} html @returns {Array<{title:string,url:string,location:string,department:string}>}
 */
export function parseBrewerJobs(html) {
  const jobs = [];
  const seen = new Set();
  const tokenRe = /<div class="gnewtonCareerGroupHeaderClass">([\s\S]*?)<\/div>|<div class="gnewtonCareerGroupJobTitleClass">\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/div>\s*(?:<div class="gnewtonCareerGroupJobDescriptionClass">([\s\S]*?)<\/div>)?/g;
  let location = '';
  let m;
  while ((m = tokenRe.exec(String(html))) !== null) {
    if (m[1] !== undefined) { location = text(m[1]); continue; }
    let url;
    try { url = new URL(decode(m[2])); } catch { continue; }
    if (url.searchParams.get('clientId') !== CLIENT_ID) continue; // Brewer Science only
    const id = url.searchParams.get('id');
    const title = text(m[3]);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    jobs.push({ title, url: `${url.origin}${url.pathname}?clientId=${CLIENT_ID}&id=${id}`, location, department: m[4] ? text(m[4]) : '' });
  }
  return jobs;
}

async function main() {
  const res = await fetch(BOARD_URL, { headers: { 'user-agent': 'Mozilla/5.0 (career-ops)' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`brewer board HTTP ${res.status}`);
  const jobs = parseBrewerJobs(await res.text());
  if (jobs.length === 0) throw new Error('brewer board parsed 0 jobs (markup changed?)');
  process.stdout.write(JSON.stringify(jobs));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

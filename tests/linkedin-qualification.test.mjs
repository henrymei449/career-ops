import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  cleanLinkedInTitle,
  evaluateExistingTitleGate,
  parseLinkedInPostingHtml,
  parseTriageLine,
  qualifyLinkedInReceipt,
  parseCodexEvents,
} from '../linkedin-qualification.mjs';

test('LinkedIn accessibility-title duplication is cleaned without guessing', () => {
  assert.equal(cleanLinkedInTitle('Solutions Architect (Verified job)Solutions Architect'), 'Solutions Architect');
  assert.equal(cleanLinkedInTitle('Pre Sales ConsultantPre Sales Consultant'), 'Pre Sales Consultant');
  assert.equal(cleanLinkedInTitle('Selected, Senior Solution Consultant (Verified job)Senior Solution Consultant'), 'Senior Solution Consultant');
  assert.equal(cleanLinkedInTitle('EngineerEngineering'), 'EngineerEngineering');
});

test('existing title_filter is the title decision source', () => {
  const config = { title_filter: { positive: ['solution engineer', 'solutions architect'], negative: ['word:Intern'] } };
  assert.equal(evaluateExistingTitleGate({ title: 'Solutions Architect (Verified job)Solutions Architect', company: 'Acme' }, config).decision, 'PASS');
  assert.equal(evaluateExistingTitleGate({ title: 'Technical Account Manager', company: 'Acme' }, config).decision, 'REJECT');
  assert.equal(evaluateExistingTitleGate({ title: 'Technical Account Manager', company: 'Acme' }, config, {proposed:true}).reason, 'title_unknown_requires_jd_evaluation');
  assert.equal(evaluateExistingTitleGate({ title: 'Solutions Architect Intern', company: 'Acme' }, config).decision, 'REJECT');
});

test('LinkedIn public posting parser extracts the actual JD block', () => {
  const html = '<h2 class="top-card-layout__title">Solutions Engineer</h2><a class="topcard__org-name-link">Acme</a><span class="topcard__flavor topcard__flavor--bullet">New York, NY</span><div class="show-more-less-html__markup">Own customer demos.<br>Manufacturing MES '.repeat(30) + '</div>';
  const parsed = parseLinkedInPostingHtml(html, 'https://www.linkedin.com/jobs/view/123456/');
  assert.equal(parsed.title, 'Solutions Engineer');
  assert.equal(parsed.company, 'Acme');
  assert.match(parsed.text, /Manufacturing MES/);
});

test('triage output parser accepts only the existing contract line', () => {
  assert.deepEqual(parseTriageLine('TRIAGE: PASS | Acme | Solutions Engineer | 4.2/5 | Direct manufacturing presales fit'), {
    verdict: 'PASS', company: 'Acme', title: 'Solutions Engineer', score: 4.2,
    reason: 'Direct manufacturing presales fit', raw_output: 'TRIAGE: PASS | Acme | Solutions Engineer | 4.2/5 | Direct manufacturing presales fit',
  });
  assert.throws(() => parseTriageLine('PASS 4.2'));
});

test('qualification sends only CareerOps PASS to Review and queues uncertainty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'careerops-li-qualification-'));
  try {
    const receipt = {
      receipt_id: 'lip-test', batch_id: 'batch-baseline',
      items: [
        { company: 'Applied Co', title: 'Solutions Engineer', location: 'United States', outcome: 'excluded', reason: 'already_applied', detail: 'tracker row #2' },
        { company: 'Recovered Co', title: 'Solutions Architect (Verified job)Solutions Architect', location: 'Atlanta, GA', arrangement: 'Remote', outcome: 'excluded', reason: 'geography' },
        { company: 'Unknown Co', title: 'Solution Engineer', location: 'United States', outcome: 'would_add', reason: 'added_unresolved_url' },
      ],
    };
    let resolves = 0;
    const result = await qualifyLinkedInReceipt(receipt, {
      root, dryRun: true,
      config: { title_filter: { positive: ['solution engineer', 'solutions architect'], negative: [] }, pipeline: { triage_threshold: 3.5 } },
      modeText: 'Return TRIAGE contract.', briefText: 'Manufacturing solutions roles; US remote.',
      resolve: async (c) => { resolves++; return c.company === 'Recovered Co' ? { status: 'resolved', url: 'https://jobs.example/recovered', attempts: [{ via: 'linkedin_search', status: 'resolved' }] } : { status: 'unresolved', attempts: [{ via: 'linkedin_search', status: 'unresolved' }] }; },
      fetchJd: async () => ({ status: 'resolved', verified_url: 'https://jobs.example/recovered', source: 'test', text: 'This is a fully remote United States customer-facing manufacturing MES solutions architecture role. '.repeat(8) }),
      invoke: async () => ({ text: 'TRIAGE: PASS | Recovered Co | Solutions Architect | 4.4/5 | Direct manufacturing solutions fit', cost_usd: 0.01, duration_ms: 4 }),
    });
    assert.equal(resolves, 2, 'confirmed application-history reject does not consume search');
    assert.deepEqual(result.counts, { input: 3, history_lookups: 2, searches: 2, jd_fetches: 1, llm_calls: 1, llm_succeeded: 1, llm_failed: 0, qualified: 1, rejected: 1, retry: 1 });
    assert.equal(result.batch_id, null);
    const recovered = result.rows.find((r) => r.company === 'Recovered Co');
    assert.equal(recovered.status, 'QUALIFIED');
    assert.equal(recovered.audit_classification, 'MATERIAL_FALSE_NEGATIVE');
    assert.equal(result.retry_queue[0].stage, 'identity_url');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex adapter requires completed turn and preserves provider failure', () => {
  const events = [{type:'item.completed',item:{type:'agent_message',text:'TRIAGE: PASS | A | B | 4/5 | Fit'}},{type:'turn.completed',usage:{input_tokens:10,output_tokens:20}}].map(JSON.stringify).join('\n');
  assert.equal(parseCodexEvents(events).usage.output_tokens, 20);
  assert.throws(() => parseCodexEvents('{"type":"turn.failed","error":{"message":"usage limit"}}', 1), /usage limit/);
});

test('configured parenthesized employer alias gets existing negative-only policy', () => {
  const config = {title_filter:{positive:['Solutions Engineer'],negative:['Software Engineer']},title_filter_negative_only:[{companies:['Tulip (Tulip Interfaces)'],negative_extra:['Recruiter']}]};
  assert.equal(evaluateExistingTitleGate({company:'Tulip Interfaces',title:'Technical Account Manager'},config,{proposed:true}).reason,'existing_negative_only_override');
  assert.equal(evaluateExistingTitleGate({company:'Tulip Interfaces',title:'Recruiter'},config).decision,'REJECT');
});

test('confirmed geography reject precedes title and spends no evaluation calls', async () => {
  const result=await qualifyLinkedInReceipt({receipt_id:'geo-first',items:[{company:'A',title:'Technical Account Manager',location:'Boston, MA',reason:'geography',detail:'REJECT: structured-onsite-hybrid-outside-nyc'}]}, {
    root:'unused',dryRun:true,config:{},modeText:'triage',briefText:'brief',
    resolve:async()=>{throw new Error('must not research a confirmed geography reject');},
    invoke:async()=>{throw new Error('must not evaluate a confirmed geography reject');},
  });
  assert.equal(result.rows[0].first_rule.gate,'geography');
  assert.equal(result.rows[0].gate_trace.some(g=>g.gate==='title'),false);
  assert.equal(result.counts.llm_calls,0);
});

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from './helpers.mjs';
import { classifyGeography } from '../location-tier.mjs';
const job = { title: 'MES Functional Analyst (Remote)', location: 'Hartford, CT' };
const nationwide = 'This role can be performed fully remote anywhere in the United States.';
const cases = [
 ['nationwide with a US city', job, nationwide, 'REMOTE_US'],
 ['description-only remote claim cannot override native onsite', {...job,title:'Analyst',workplaceTypes:['On-site']}, nationwide, 'UNKNOWN'],
 ['description-only remote claim cannot override native false', {...job,title:'Analyst',workRemoteAllowed:false}, nationwide, 'UNKNOWN'],
 ['role-specific onsite statement conflicts with nationwide claim', job, nationwide+' This role is onsite in Hartford.', 'UNKNOWN'],
 ['not fully remote conflicts with nationwide claim', job, nationwide+' This role is not fully remote.', 'UNKNOWN'],
 ['role-specific nationwide description does not require Remote in title', {...job,title:'MES Analyst'}, nationwide, 'REMOTE_US'],
 ['negated nationwide wording is not positive proof', job, 'Remote work is not available anywhere in the United States.', 'UNKNOWN'],
 ['remote title and US city without residency proof', job, '', 'UNKNOWN'],
 ['country-only source text preserves existing contract', {title:'Analyst (Remote)',location:'United States'}, '', 'REMOTE_US'],
 ['state restriction excludes New York', job, 'Candidates must reside in Connecticut.', 'REJECT'],
 ['abbreviation state restriction', job, 'Candidates must reside in CT.', 'REJECT'],
 ['eligible list excludes New York', job, 'Eligible states: CT, MA.', 'REJECT'],
 ['eligible list permits New York', job, 'Eligible states: CT, NY.', 'REMOTE_US'],
 ['New York residence explicitly permitted', job, 'Candidates must reside in New York or Connecticut.', 'REMOTE_US'],
 ['unknown residency wording is not guessed', job, nationwide+' Candidates must reside in the Northeast region.', 'UNKNOWN'],
 ['New York explicitly excluded overrides nationwide', job, nationwide+' This position is not available to residents of New York.', 'REJECT'],
 ['nationwide with unspecified restrictions is unresolved', job, nationwide+' This position is restricted to approved states.', 'UNKNOWN'],
 ['hybrid requirement', job, nationwide+' This position follows a hybrid schedule.', 'UNKNOWN'],
 ['weekly office obligation', job, nationwide+' Work in the office two days per week.', 'UNKNOWN'],
 ['conditional office presence', job, 'This role is a U.S.-based role. Your manager will discuss whether there is a degree of onsite presence associated with this role.', 'UNKNOWN'],
 ['commute proximity', job, nationwide+' Candidates must live within 50 miles of Hartford.', 'UNKNOWN'],
 ['conflicting native onsite metadata', {...job,workplaceTypes:['On-site']}, nationwide, 'UNKNOWN'],
 ['explicit false native remote flag', {...job,workRemoteAllowed:false}, nationwide, 'UNKNOWN'],
 ['remote negation', job, 'This role is not remote.', 'UNKNOWN'],
 ['native remote cannot override New York exclusion', {...job,workRemoteAllowed:true}, 'This job is not available in New York.', 'REJECT'],
 ['native remote remains valid absent conflicts', {...job,workRemoteAllowed:true}, '', 'REMOTE_US'],
 ['foreign location precedence', {...job,location:'Toronto, ON, CAN'}, nationwide, 'REJECT'],
 ['occasional travel is not weekly onsite work', job, nationwide+' Up to 10% domestic travel may be required.', 'REMOTE_US'],
 ['interview attendance is separate', job, nationwide+' Candidates may attend an interview in person.', 'REMOTE_US'],
 ['explicit no onsite requirement', job, nationwide+' No onsite attendance is required.', 'REMOTE_US'],
 ['ordinary NYC onsite remains accepted', {title:'Analyst',location:'New York, NY'}, 'This job is onsite.', 'NYC_COMPATIBLE'],
 ['ordinary non-NYC onsite remains rejected', {title:'Analyst',location:'Hartford, CT'}, 'This job is onsite.', 'REJECT'],
 ['search context and derived flag alone do not establish eligibility', {title:'Analyst',location:'United States',isRemote:true,searchContext:'United States'}, '', 'UNKNOWN'],
];
for(const [name, input, description, state] of cases) test(name,()=>assert.equal(classifyGeography(input,description).state,state));
const sandbox=mkdtempSync(join(tmpdir(),'career-ops-geo-evidence-'));
const priorRoot=process.env.CAREER_OPS_ROOT;
process.env.CAREER_OPS_ROOT=sandbox;
const {resolveJobDescriptionText}=await import('../scan.mjs');
after(()=>{if(priorRoot===undefined)delete process.env.CAREER_OPS_ROOT;else process.env.CAREER_OPS_ROOT=priorRoot;rmSync(sandbox,{recursive:true,force:true});});
test('cached Apify description and inline provider description produce the same eligibility verdict',()=>{
 mkdirSync(join(sandbox,'jds'),{recursive:true});
 for(const [i,description,state] of [[0,nationwide,'REMOTE_US'],[1,'Candidates must reside in Connecticut.','REJECT'],[2,'Your manager will discuss onsite presence for this remote role.','UNKNOWN']]){
   const file='jds/job-'+i+'.md';
   writeFileSync(join(sandbox,file),'---\ntitle: fixture\n---\n\n# fixture\n\n'+description);
   const cached={...job,url:'local:'+file};
   assert.equal(classifyGeography(cached,resolveJobDescriptionText(cached)).state,state);
   const inline={...job,description};
   assert.equal(classifyGeography(inline,resolveJobDescriptionText(inline)).state,state);
   assert.equal(cached.description,undefined,'no mutation of other gate inputs');
 }
});

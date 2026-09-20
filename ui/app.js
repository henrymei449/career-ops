// app.js — vanilla JS operator UI. Every button click calls a /api/* route
// that forwards straight to the existing review.mjs/outreach.mjs functions;
// no transition rule lives here. State is re-fetched from the server after
// every mutating action so the page always reflects the durable file, never
// a locally-cached guess.

const state = {
  view: 'followup',
  reviewSelections: {}, // job_key -> 'APPLY' | 'INVESTIGATE' | 'PASS'
  outreachSelections: {}, // job_key -> Set(candidate_id)
  outreachEditing: {}, // job_key -> true while explicitly re-opened for contact re-selection
  selectedBatchId: null, // Review tab's currently selected open batch
  applicationsFilter: 'alive', // Applications tab's currently selected filter
  followupExpanded: null, // job_key of the currently expanded Home row, or null
  homeFilter: null, // one of HOME_TOP_FILTERS' keys, or null for ALL_ACTIVE
  homeAppliedBucket: null, // one of HOME_APPLIED_BUCKETS' keys, or null for all Applied rows
  applicationsHighlightKey: null, // job_key to scroll to/highlight after Open Application
  outreachHighlightKey: null, // job_key to scroll to/highlight after Open Outreach
};

function todayLocalStr() {
  const d = new Date();
  const localMs = d.getTime() - d.getTimezoneOffset() * 60000;
  return new Date(localMs).toISOString().slice(0, 10);
}

/** Scroll a just-navigated-to card into view and highlight it briefly. */
function highlightAndScroll(container, jobKey) {
  if (!jobKey) return;
  const target = container.querySelector(`[data-job-key="${CSS.escape(jobKey)}"]`);
  if (!target) return;
  target.classList.add('highlight');
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(c);
  return node;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
  return data;
}

function showError(container, message) {
  const existing = container.querySelector('.err');
  if (existing) existing.remove();
  container.appendChild(el('div', { class: 'err', text: message }));
}

// ── Navigation ───────────────────────────────────────────────────────────

function setView(view) {
  state.view = view;
  $all('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $all('main section').forEach((s) => s.classList.toggle('active', s.id === `view-${view}`));
  loadView(view);
}

function loadView(view) {
  if (view === 'review') loadReview();
  else if (view === 'ready') loadReady();
  else if (view === 'applications') loadApplications();
  else if (view === 'outreach') loadOutreach();
  else if (view === 'followup') loadFollowup();
}

$all('nav button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

// Bound once — the <select> element itself persists across loadReview()
// calls (only its <option> children are replaced), so this must not be
// re-attached on every load or clicks would fire the handler multiple times.
$('#batch-select').addEventListener('change', (ev) => {
  state.selectedBatchId = ev.target.value || null;
  loadReview();
});

// ── Ad-hoc job intake (#pass3): paste a URL, get a scoped ad_hoc review
//    batch through the exact same POST /api/intake -> adhoc-intake.mjs path
//    every other batch is built through server-side. No CLI, no JSON typed
//    by the operator — the human experience is paste URL -> click Intake ->
//    the Review batch selector jumps to the new batch.
const addJobBtn = $('#add-job-btn');
const addJobUrl = $('#add-job-url');
const addJobSubmit = $('#add-job-submit');
const addJobStatus = $('#add-job-status');

addJobBtn.addEventListener('click', () => {
  const showing = addJobUrl.style.display !== 'none';
  addJobUrl.style.display = showing ? 'none' : '';
  addJobSubmit.style.display = showing ? 'none' : '';
  addJobStatus.textContent = '';
  if (!showing) addJobUrl.focus();
});

async function submitAddJob() {
  const url = addJobUrl.value.trim();
  if (!url) { addJobStatus.textContent = 'Paste a job URL first.'; return; }
  addJobSubmit.disabled = true;
  addJobStatus.textContent = 'Capturing…';
  try {
    const result = await api('POST', '/api/intake', { url });
    if (result.outcome === 'created') {
      addJobStatus.textContent = `Added: ${result.job.company || '(company unknown)'} — ${result.job.title || '(title unknown)'}`;
      addJobUrl.value = '';
      addJobUrl.style.display = 'none';
      addJobSubmit.style.display = 'none';
      state.selectedBatchId = result.batch_id;
      loadReview();
    } else if (result.outcome === 'existing') {
      const where = result.batch_id ? ` (batch ${result.batch_id})` : '';
      addJobStatus.textContent = `Already known — ${result.state}${where}: ${result.summary.company || '?'} — ${result.summary.title || '?'}`;
      if (result.batch_id) { state.selectedBatchId = result.batch_id; loadReview(); }
    } else if (result.outcome === 'unsupported') {
      addJobStatus.textContent = `Could not capture this posting: ${result.reason}`;
    } else {
      addJobStatus.textContent = result.error || 'Intake failed.';
    }
  } catch (e) {
    addJobStatus.textContent = e.message;
  } finally {
    addJobSubmit.disabled = false;
  }
}

addJobSubmit.addEventListener('click', submitAddJob);
addJobUrl.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submitAddJob(); });

// ── Review (batch-aware: exactly one open batch is shown/decided/finalized
//    at a time — see docs/careerops-state-model.md's batch-scoping note) ──

const INVESTIGATE_QUEUE_ID = 'investigate-queue'; // virtual batch: durable INVESTIGATE jobs, not a batch file

function formatBatchLabel(b) {
  if (b.label) return b.label; // virtual entries carry their own label (Investigate / Queue — N jobs)
  const when = b.created_at ? new Date(b.created_at).toLocaleString() : '(unknown time)';
  const src = b.source ? ` — ${b.source}` : '';
  return `${b.batch_id} — ${b.count} job${b.count === 1 ? '' : 's'}${src} — ${when}`;
}

async function loadBatchSelector() {
  const select = $('#batch-select');
  let data;
  try { data = await api('GET', '/api/review/batches'); }
  catch (e) { showError($('#review-list'), e.message); return []; }

  const batches = data.batches; // newest-first, per the server's own sort
  select.innerHTML = '';
  if (batches.length === 0) {
    select.appendChild(el('option', { value: '', text: '(no open batches)' }));
    select.disabled = true;
    return batches;
  }
  select.disabled = false;
  for (const b of batches) {
    select.appendChild(el('option', { value: b.batch_id, text: formatBatchLabel(b) }));
  }
  // Default: newest open batch (batches[0]) — unless the previously selected
  // batch still exists (e.g. a reload after switching), in which case stay
  // on it rather than snapping back to newest under the user.
  const stillOpen = state.selectedBatchId && batches.some((b) => b.batch_id === state.selectedBatchId);
  state.selectedBatchId = stillOpen ? state.selectedBatchId : batches[0].batch_id;
  select.value = state.selectedBatchId;
  return batches;
}

async function loadReview() {
  const listEl = $('#review-list');
  listEl.innerHTML = '<p class="empty">Loading…</p>';
  await loadBatchSelector();

  if (!state.selectedBatchId) {
    listEl.innerHTML = '';
    listEl.appendChild(el('p', { class: 'empty', text: 'No open review batches.' }));
    updateFinalizeButton(null, []);
    return;
  }

  let data;
  try { data = await api('GET', `/api/review?batch_id=${encodeURIComponent(state.selectedBatchId)}`); }
  catch (e) { listEl.innerHTML = ''; showError(listEl, e.message); return; }

  const jobs = data.jobs;
  listEl.innerHTML = '';
  if (jobs.length === 0) { listEl.appendChild(el('p', { class: 'empty', text: 'This batch has no jobs.' })); updateFinalizeButton(data.batch_id, []); return; }

  const isQueue = data.batch_id === INVESTIGATE_QUEUE_ID;
  for (const job of jobs) {
    if (!(job.job_key in state.reviewSelections) && (job.proposed_decision || isQueue)) {
      state.reviewSelections[job.job_key] = job.proposed_decision || job.final_decision;
    }
    listEl.appendChild(renderReviewCard(job));
  }
  if (isQueue) { updateQueueControls(jobs); return; }
  $('#finalize-btn').textContent = 'Finalize Batch';
  updateFinalizeButton(data.batch_id, jobs);
  updateGateControls(data.batch_id, jobs);
}

// Investigate / Queue: each card's APPLY / INVESTIGATE / PASS selection is saved
// in place on the durable record (POST /api/review/investigate/decide) — the
// job then leaves the queue via the normal Ready to Apply / suppressed paths.
function updateQueueControls(jobs) {
  const btn = $('#finalize-btn');
  const hint = $('#finalize-hint');
  btn.textContent = 'Save Queue Decisions';
  const changed = jobs.filter((j) => state.reviewSelections[j.job_key] && state.reviewSelections[j.job_key] !== 'INVESTIGATE');
  btn.disabled = changed.length === 0;
  hint.textContent = changed.length ? `${changed.length} change${changed.length === 1 ? '' : 's'} to save` : 'Choose APPLY or PASS on a card to move it out of the queue';
  for (const id of ['#gate-run-btn', '#gate-force-btn']) { $(id).disabled = true; $(id).onclick = null; }
  $('#gate-hint').textContent = 'Resume Gate results shown are from the original batch';
  btn.onclick = async () => {
    try {
      for (const j of changed) {
        await api('POST', '/api/review/investigate/decide', { job_key: j.job_key, decision: state.reviewSelections[j.job_key] });
        delete state.reviewSelections[j.job_key];
      }
      loadReview();
    } catch (e) { showError($('#review-list'), e.message); }
  };
}

// ── Resume Gate (explicit, per selected batch; never changes decisions) ────

const GATE_POLL_MS = 3000;
const MAX_CARD_GAPS = 3;
const CLIP = { why: 220, gap: 110, effort: 60 }; // fit_warning is deliberately never clipped
const gateOpen = new Set(); // job_keys whose full Resume Gate view is expanded (survives re-render)
let gatePollTimer = null;
let gateResumeChecked = null;

// A labelled field that owns its own wrapped block (label above, prose below).
function gateBlock(label, value) {
  const block = el('div', { class: 'gate-block' });
  block.appendChild(el('div', { class: 'gate-label', text: label }));
  block.appendChild(el('div', { class: 'gate-text', text: value }));
  return block;
}

// Display-only: show just the first duration found ("about 20 minutes" -> "20 min") when the
// stored text contains one; otherwise a clipped copy. The full text stays in Show Full Resume Gate.
function shortEffort(text) {
  const t = String(text ?? '').trim();
  const m = /(\d+(?:\s*[-–]\s*\d+)?\s*\+?)\s*(minutes?|mins?|hours?|hrs?|h)\b/i.exec(t);
  if (!m) return clip(t, CLIP.effort);
  const unit = /^h/i.test(m[2]) ? 'hr' : 'min';
  return `${m[1].replace(/\s+/g, '')} ${unit}`;
}

function joinItems(items, empty) { return items && items.length ? items.join('; ') : empty; }

// Display-only shortening for the collapsed card. The stored gate result is
// never shortened; "Show Full Resume Gate" renders it verbatim.
function clip(text, max) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

// The complete persisted output exactly as the SOP returned it; if a record
// predates raw_output, rebuild it from the stored structured fields instead.
function fullGateText(g) {
  if (g.raw_output) return g.raw_output;
  const list = (a, ordered) => (a || []).map((x, i) => (ordered ? `${i + 1}. ${x}` : `- ${x}`)).join('\n');
  return [
    `RESUME ROUTE:\n${g.resume_route_label || g.resume_route}`, `WHY:\n${g.why}`, `RESUME GATE:\n${g.resume_gate}`, `ROLE FIT:\n${g.role_fit}`,
    `STRONGEST EVIDENCE:\n${list(g.strongest_evidence)}`, `MATERIAL GAPS:\n${list(g.material_gaps)}`, `ATS / TERMINOLOGY:\n${list(g.ats_terminology)}`,
    `PROPOSED EDITS:\n${list(g.proposed_edits, true)}`, `DO NOT CHANGE:\n${list(g.do_not_change)}`, `ESTIMATED EFFORT:\n${g.estimated_effort}`, `FIT WARNING:\n${g.fit_warning}`,
  ].join('\n\n');
}

function renderGateBlock(g, jobKey) {
  const box = el('div', { class: 'gate' });
  if (!g) { box.classList.add('gate-blocked'); box.appendChild(el('div', { text: 'Resume Gate: not run' })); return box; }
  if (g.gate_status === 'BLOCKED_MISSING_JD') {
    box.classList.add('gate-blocked');
    box.appendChild(el('div', { class: 'gate-head', text: 'GATE BLOCKED / MISSING JD' }));
    box.appendChild(el('div', { text: `${g.gate_error || 'No JD could be resolved.'} The job stays in the batch.` }));
    return box;
  }
  if (g.gate_status !== 'OK') {
    box.classList.add('gate-error');
    box.appendChild(el('div', { class: 'gate-head', text: 'GATE ERROR' }));
    box.appendChild(el('div', { text: g.gate_error || 'Resume Gate failed.' }));
    return box;
  }
  if (g.resume_gate === 'MAJOR TAILOR') box.classList.add('gate-warn');
  // Presentation only: every value below is a display-side shortening of the
  // stored gate result, which is never modified (see "Show Full Resume Gate").
  const top = el('div', { class: 'gate-top' });
  top.appendChild(el('span', { class: 'gate-label', text: 'Resume Gate:' }));
  top.appendChild(el('span', { class: 'gate-value', text: ` ${g.resume_gate}` }));
  if (g.stale) top.appendChild(el('span', { class: 'gate-stale', text: `STALE — ${g.stale_reason}` }));
  box.appendChild(top);
  // Reading order: concern -> reason -> gaps -> work. Route / Role Fit are secondary metadata.
  const metaRow = el('div', { class: 'gate-meta' });
  [['Route', g.resume_route], ['Role Fit', g.role_fit]].forEach(([label, value], i) => {
    if (i) metaRow.appendChild(document.createTextNode(' · '));
    const item = el('span', { class: 'gate-meta-item' });
    item.appendChild(el('span', { class: 'gate-meta-label', text: `${label}:` }));
    item.appendChild(document.createTextNode(` ${value}`));
    metaRow.appendChild(item);
  });
  box.appendChild(metaRow);
  // Never shortened: the complete stored warning (including "NONE"), wrapped to card width.
  box.appendChild(gateBlock('FIT WARNING', String(g.fit_warning || 'NONE').trim()));
  box.appendChild(gateBlock('WHY', clip(g.why, CLIP.why)));
  const gaps = g.material_gaps || [];
  const shown = gaps.slice(0, MAX_CARD_GAPS).map((x) => clip(x, CLIP.gap));
  const more = gaps.length - shown.length;
  box.appendChild(gateBlock('MATERIAL GAPS', `${joinItems(shown, 'None listed.')}${more > 0 ? ` (+${more} more)` : ''}`));
  box.appendChild(gateBlock('ESTIMATED EFFORT', shortEffort(g.estimated_effort)));
  if (g.last_attempt) {
    box.appendChild(el('div', { class: 'gate-stale', text: `Latest re-run failed (${g.last_attempt.gate_status}); showing the previous successful result.` }));
  }
  const details = el('details');
  if (jobKey && gateOpen.has(jobKey)) details.open = true;
  details.addEventListener('toggle', () => { if (!jobKey) return; if (details.open) gateOpen.add(jobKey); else gateOpen.delete(jobKey); });
  details.appendChild(el('summary', { text: 'Show Full Resume Gate' }));
  const meta = [`SOP v${g.sop_version}`, g.gated_at ? `gated ${new Date(g.gated_at).toLocaleString()}` : '', g.jd_hash ? `JD ${g.jd_hash.slice(0, 8)}` : ''].filter(Boolean).join(' · ');
  details.appendChild(el('div', { class: 'meta', text: meta }));
  details.appendChild(el('pre', { class: 'gate-full', text: fullGateText(g) }));
  box.appendChild(details);
  return box;
}

function updateGateControls(batchId, jobs) {
  const run = $('#gate-run-btn');
  const force = $('#gate-force-btn');
  const hint = $('#gate-hint');
  const enabled = !!batchId && jobs.length > 0;
  run.disabled = !enabled; force.disabled = !enabled;
  if (!enabled) { hint.textContent = ''; run.onclick = null; force.onclick = null; return; }
  const gated = jobs.filter((j) => j.resume_gate && j.resume_gate.gate_status === 'OK').length;
  if (!gatePollTimer) hint.textContent = `${gated}/${jobs.length} gated in this batch`;
  const start = async (forceRun) => {
    try {
      await api('POST', '/api/review/resume-gate', { batch_id: batchId, force: forceRun });
      pollGateRun(batchId);
    } catch (e) { showError($('#review-list'), e.message); }
  };
  run.onclick = () => start(false);
  force.onclick = () => start(true);
  // Reopened Review mid-run (page reload / batch switch): resume polling once per batch.
  if (gateResumeChecked !== batchId) {
    gateResumeChecked = batchId;
    api('GET', `/api/review/resume-gate/status?batch_id=${encodeURIComponent(batchId)}`)
      .then((r) => { if (r.status === 'running') pollGateRun(batchId); })
      .catch(() => {});
  }
}

function pollGateRun(batchId) {
  clearTimeout(gatePollTimer);
  const hint = $('#gate-hint');
  const tick = async () => {
    gatePollTimer = null;
    if (state.selectedBatchId !== batchId) return; // user switched batch; its own controls take over
    let r;
    try { r = await api('GET', `/api/review/resume-gate/status?batch_id=${encodeURIComponent(batchId)}`); }
    catch (e) { hint.textContent = `Resume Gate status unavailable: ${e.message}`; return; }
    if (r.status === 'running') {
      gatePollTimer = setTimeout(tick, GATE_POLL_MS);
      await loadReview(); // each job's result is persisted as it completes
      hint.textContent = `Running Resume Gate… ${r.completed}/${r.total}`;
      $('#gate-run-btn').disabled = true; $('#gate-force-btn').disabled = true;
      return;
    }
    await loadReview();
    if (r.status === 'done' && r.summary) {
      const s = r.summary;
      hint.textContent = `Resume Gate done: ${s.gated} gated, ${s.cached} cached, ${s.blocked} blocked, ${s.errors} error${s.errors === 1 ? '' : 's'}`;
    } else if (r.status === 'failed') hint.textContent = `Resume Gate failed: ${r.error}`;
  };
  tick();
}

function renderReviewCard(job) {
  const card = el('div', { class: 'card' });
  card.appendChild(el('h3', { text: `${job.company} — ${job.title}` }));
  card.appendChild(el('div', { class: 'meta', text: `${job.location || '(location unknown)'}${job.url ? '' : ''}` }));
  if (job.url) {
    const link = el('div', { class: 'meta' });
    link.appendChild(el('a', { href: job.url, target: '_blank', rel: 'noopener', text: job.url }));
    card.appendChild(link);
  }
  if (job.proposed_decision) {
    card.appendChild(el('div', { class: 'meta', text: `SOP proposed: ${job.proposed_decision}` }));
  }
  if (job.batch_id === INVESTIGATE_QUEUE_ID && job.decided_at) {
    card.appendChild(el('div', { class: 'meta', text: `In Investigate queue since ${new Date(job.decided_at).toLocaleString()}` }));
  }
  if (job.reason) card.appendChild(el('div', { class: 'reason', text: job.reason }));
  card.appendChild(renderGateBlock(job.resume_gate, job.job_key));

  const row = el('div', { class: 'row' });
  for (const decision of ['APPLY', 'INVESTIGATE', 'PASS']) {
    const btn = el('button', {
      class: `action${state.reviewSelections[job.job_key] === decision ? ' selected' : ''}`,
      text: decision,
      onclick: async () => {
        // In an OPEN batch, PASS is immediate: durable PASS now and the job leaves the batch.
        if (decision === 'PASS' && job.batch_id !== INVESTIGATE_QUEUE_ID) {
          try {
            await api('POST', '/api/review/pass', { batch_id: job.batch_id, job_key: job.job_key });
            delete state.reviewSelections[job.job_key];
          } catch (e) { showError($('#review-list'), e.message); return; }
          loadReview();
          return;
        }
        state.reviewSelections[job.job_key] = decision;
        loadReview();
      },
    });
    row.appendChild(btn);
  }
  card.appendChild(row);
  return card;
}

// `jobs` here is ALWAYS the selected batch's own job list (server-side
// /api/review is already scoped to one batch_id) — so decisions/overrides
// built from it can never cross into another batch by construction, even
// though state.reviewSelections is one flat job_key-keyed dict (job_keys are
// globally unique, so no two batches can ever share one anyway).
function updateFinalizeButton(batchId, jobs) {
  const btn = $('#finalize-btn');
  const hint = $('#finalize-hint');
  if (!batchId || jobs.length === 0) { btn.disabled = true; hint.textContent = ''; btn.onclick = null; return; }
  const allDecided = jobs.every((j) => state.reviewSelections[j.job_key]);
  btn.disabled = !allDecided;
  hint.textContent = allDecided ? `Ready — batch ${batchId}` : 'Decide every job in this batch to enable finalize';
  btn.onclick = async () => {
    const overrides = {};
    for (const j of jobs) overrides[j.job_key] = state.reviewSelections[j.job_key];
    try {
      const result = await api('POST', '/api/review/finalize', { batch_id: batchId, overrides });
      for (const j of jobs) delete state.reviewSelections[j.job_key];
      if (!result.ingested) {
        // finalizeAndIngestBatch() finalized the batch but the durable-state
        // ingestion pass did not report it as ingested — surface loudly
        // rather than silently leaving Ready to Apply stale.
        showError($('#review-list'), `Batch finalized but not yet reflected in durable state: ${JSON.stringify(result.ingestion_errors)}`);
      }
      state.selectedBatchId = null; // batch is gone — let loadReview() re-pick the new newest
      loadReview();
    } catch (e) {
      showError($('#review-list'), e.message);
    }
  };
}

// ── Ready to Apply ───────────────────────────────────────────────────────

async function loadReady() {
  const listEl = $('#ready-list');
  listEl.innerHTML = '<p class="empty">Loading…</p>';
  let data;
  try { data = await api('GET', '/api/ready'); }
  catch (e) { listEl.innerHTML = ''; showError(listEl, e.message); return; }

  listEl.innerHTML = '';
  if (data.jobs.length === 0) { listEl.appendChild(el('p', { class: 'empty', text: 'Nothing ready to apply.' })); return; }

  for (const job of data.jobs) {
    const card = el('div', { class: 'card' });
    card.appendChild(el('h3', { text: `${job.company} — ${job.title}` }));
    const row = el('div', { class: 'row' });
    if (job.url && /^https?:\/\//i.test(job.url)) {
      row.appendChild(el('a', { href: job.url, target: '_blank', rel: 'noopener', class: 'action', text: 'Open Application' }));
    } else if (job.url) {
      card.appendChild(el('div', { class: 'meta', text: job.url }));
    }
    // Two-step INLINE confirm, not window.confirm(): a native confirm()
    // dialog gave zero visible feedback on its cancel path (button click ->
    // dialog resolves false -> bare `return` -> nothing in the DOM changes),
    // which is indistinguishable from the button being broken — confirmed as
    // the actual root cause of a report where a real production Mark Applied
    // click appeared to do nothing (durable state showed the backend
    // transition never fired; the click never got past this line). Native
    // confirm() is also unreliable to drive/observe across environments
    // (e.g. auto-dismissed under browser automation) — replacing it removes
    // that whole failure class rather than patching one symptom of it.
    const markBtn = el('button', { class: 'action primary', text: 'Mark Applied' });
    markBtn.addEventListener('click', () => {
      if (markBtn.dataset.confirming === 'true') {
        markBtn.disabled = true;
        markBtn.textContent = 'Marking…';
        api('POST', '/api/ready/applied', { job_key: job.job_key })
          .then(() => loadReady())
          .catch((e) => {
            markBtn.disabled = false;
            markBtn.dataset.confirming = 'false';
            markBtn.textContent = 'Mark Applied';
            cancelBtn.style.display = 'none';
            showError(card, e.message);
          });
        return;
      }
      markBtn.dataset.confirming = 'true';
      markBtn.textContent = `Confirm: mark ${job.company} applied?`;
      cancelBtn.style.display = '';
    });
    const cancelBtn = el('button', {
      class: 'action',
      text: 'Cancel',
      style: 'display:none',
      onclick: () => {
        markBtn.dataset.confirming = 'false';
        markBtn.textContent = 'Mark Applied';
        cancelBtn.style.display = 'none';
      },
    });

    // Same inline two-step confirm pattern as Mark Applied above — never
    // window.confirm() (see the comment on markBtn for why).
    const passBtn = el('button', { class: 'action', text: 'Pass' });
    passBtn.addEventListener('click', () => {
      if (passBtn.dataset.confirming === 'true') {
        passBtn.disabled = true;
        passBtn.textContent = 'Passing…';
        api('POST', '/api/ready/pass', { job_key: job.job_key })
          .then(() => loadReady())
          .catch((e) => {
            passBtn.disabled = false;
            passBtn.dataset.confirming = 'false';
            passBtn.textContent = 'Pass';
            passCancelBtn.style.display = 'none';
            showError(card, e.message);
          });
        return;
      }
      passBtn.dataset.confirming = 'true';
      passBtn.textContent = 'Pass on this job? This removes it from Ready to Apply.';
      passCancelBtn.style.display = '';
    });
    const passCancelBtn = el('button', {
      class: 'action',
      text: 'Cancel',
      style: 'display:none',
      onclick: () => {
        passBtn.dataset.confirming = 'false';
        passBtn.textContent = 'Pass';
        passCancelBtn.style.display = 'none';
      },
    });

    row.appendChild(markBtn);
    row.appendChild(cancelBtn);
    row.appendChild(passBtn);
    row.appendChild(passCancelBtn);
    card.appendChild(row);
    listEl.appendChild(card);
  }
}

// ── Applications ("What Is Alive?" board — read-only) ───────────────────────

$all('[data-app-filter]').forEach((b) => b.addEventListener('click', () => {
  state.applicationsFilter = b.dataset.appFilter;
  $all('[data-app-filter]').forEach((btn) => btn.classList.toggle('selected', btn === b));
  loadApplications();
}));

function formatDate(iso) {
  if (!iso) return '(unknown date)';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso; // e.g. a bare YYYY-MM-DD string parses fine, but be defensive
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

async function loadApplications() {
  const listEl = $('#applications-list');
  listEl.innerHTML = '<p class="empty">Loading…</p>';
  let data;
  try { data = await api('GET', `/api/applications?filter=${encodeURIComponent(state.applicationsFilter)}`); }
  catch (e) { listEl.innerHTML = ''; showError(listEl, e.message); return; }

  listEl.innerHTML = '';
  if (data.applications.length === 0) {
    listEl.appendChild(el('p', { class: 'empty', text: 'No applications in this view.' }));
    return;
  }
  for (const app of data.applications) listEl.appendChild(renderApplicationCard(app));
  highlightAndScroll(listEl, state.applicationsHighlightKey);
}

// UI status choice -> best-guess preselection, given the job's CURRENT
// canonical application_status. CLOSED is ambiguous on its own (it could be
// this UI's ROLE_CLOSED write, or an older historical import), so it
// preselects ROLE_CLOSED as the closest real-world reading; anything else
// with no exact match defaults to ACTIVE, same as the read-only board does.
function guessUiStatus(applicationStatus) {
  if (applicationStatus === 'REJECTED') return 'REJECTED';
  if (applicationStatus === 'WITHDRAWN') return 'WITHDRAWN';
  if (applicationStatus === 'CLOSED') return 'ROLE_CLOSED';
  return 'ACTIVE';
}

const UI_STATUS_LABELS = { ACTIVE: 'ACTIVE', REJECTED: 'REJECTED', ROLE_CLOSED: 'ROLE CLOSED', WITHDRAWN: 'WITHDRAWN' };

function renderApplicationCard(app) {
  const card = el('div', { class: 'card', 'data-job-key': app.job_key });
  const title = el('h3', { text: `${app.company} — ${app.title}` });
  title.appendChild(el('span', { class: `status-pill status-${app.application_status}`, text: app.application_status }));
  card.appendChild(title);
  card.appendChild(el('div', { class: 'meta', text: `Applied: ${formatDate(app.applied_at)} · Stage: ${app.application_stage}` }));
  card.appendChild(el('div', { class: 'meta', text: `Last update: ${app.application_last_update ? formatDate(app.application_last_update) : formatDate(app.applied_at)}` }));
  if (app.outreach) card.appendChild(el('div', { class: 'meta', text: `Outreach: ${app.outreach}` }));
  if (app.url && /^https?:\/\//i.test(app.url)) {
    const link = el('div', { class: 'meta' });
    link.appendChild(el('a', { href: app.url, target: '_blank', rel: 'noopener', text: app.url }));
    card.appendChild(link);
  }

  // ── Update Status (Pass 5) ────────────────────────────────────────────
  const form = el('div', { class: 'status-form', style: 'display:none' });
  const statusSelect = el('select', {}, Object.entries(UI_STATUS_LABELS).map(([value, text]) =>
    el('option', { value, text, ...(value === guessUiStatus(app.application_status) ? { selected: 'selected' } : {}) })));
  const dateInput = el('input', { type: 'date', value: todayLocalStr() });
  const noteInput = el('textarea', { placeholder: 'Note / evidence (optional)', rows: '2' });
  const saveBtn = el('button', { class: 'action primary', text: 'Save' });
  const cancelFormBtn = el('button', { class: 'action', text: 'Cancel', onclick: () => { form.style.display = 'none'; } });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await api('POST', '/api/applications/status', {
        job_key: app.job_key,
        status: statusSelect.value,
        update_date: dateInput.value,
        note: noteInput.value,
      });
      loadApplications();
    } catch (e) {
      saveBtn.disabled = false;
      showError(form, e.message);
    }
  });
  form.appendChild(el('div', { class: 'row' }, [el('label', { text: 'Current status:' }), document.createTextNode(app.application_status)]));
  form.appendChild(el('div', { class: 'row' }, [el('label', { text: 'New status:' }), statusSelect]));
  form.appendChild(el('div', { class: 'row' }, [el('label', { text: 'Update date:' }), dateInput]));
  form.appendChild(el('div', { class: 'row' }, [el('label', { text: 'Note:' }), noteInput]));
  form.appendChild(el('div', { class: 'row' }, [saveBtn, cancelFormBtn]));

  const updateBtn = el('button', {
    class: 'action',
    text: 'Update Status',
    onclick: () => { form.style.display = form.style.display === 'none' ? '' : 'none'; },
  });
  card.appendChild(el('div', { class: 'row', style: 'margin-top:10px' }, [updateBtn]));
  card.appendChild(form);

  return card;
}

// ── Outreach ─────────────────────────────────────────────────────────────

async function loadOutreach() {
  const listEl = $('#outreach-list');
  listEl.innerHTML = '<p class="empty">Loading…</p>';
  let data;
  try { data = await api('GET', '/api/outreach'); }
  catch (e) { listEl.innerHTML = ''; showError(listEl, e.message); return; }

  listEl.innerHTML = '';
  if (data.jobs.length === 0) { listEl.appendChild(el('p', { class: 'empty', text: 'No APPLIED jobs yet.' })); return; }

  for (const job of data.jobs) listEl.appendChild(renderOutreachCard(job));
  highlightAndScroll(listEl, state.outreachHighlightKey);
}

function renderOutreachCard(job) {
  const card = el('div', { class: 'card', 'data-job-key': job.job_key });
  const title = el('h3', { text: `${job.company} — ${job.title}` });
  // Job-level outreach completion patch (Pass 5): the derived completion
  // (COMPLETE/IN_PROGRESS once contacts are selected) shown next to the raw
  // decision/status below, not instead of it — the operator can still see
  // exactly which durable status the record is in.
  if (job.completion) title.appendChild(el('span', { class: `completion-pill completion-${job.completion}`, text: job.completion }));
  card.appendChild(title);
  card.appendChild(el('div', { class: 'meta', text: `decision: ${job.decision} · status: ${job.status}` }));

  if (job.decision === 'PENDING') {
    const row = el('div', { class: 'row' });
    for (const [label, value] of [['Required', 'REQUIRED'], ['Optional', 'OPTIONAL'], ['Waive', 'WAIVED']]) {
      row.appendChild(el('button', {
        class: 'action',
        text: label,
        onclick: async () => {
          try { await api('POST', '/api/outreach/decision', { job_key: job.job_key, decision: value }); loadOutreach(); }
          catch (e) { showError(card, e.message); }
        },
      }));
    }
    card.appendChild(row);
    return card;
  }

  if (job.status === 'NOT_STARTED') {
    card.appendChild(el('button', {
      class: 'action',
      text: 'Start Outreach',
      onclick: async () => {
        try { await api('POST', '/api/outreach/start', { job_key: job.job_key }); loadOutreach(); }
        catch (e) { showError(card, e.message); }
      },
    }));
    return card;
  }

  if (job.status === 'SEARCH_REQUIRED') {
    card.appendChild(el('button', {
      class: 'action primary',
      text: 'Find Contacts',
      onclick: async (ev) => {
        ev.target.disabled = true;
        ev.target.textContent = 'Searching…';
        try { await api('POST', '/api/outreach/discover', { job_key: job.job_key }); loadOutreach(); }
        catch (e) { ev.target.disabled = false; ev.target.textContent = 'Find Contacts'; showError(card, e.message); }
      },
    }));
    return card;
  }

  // Outreach P0 cleanup: once contacts are selected, show the EXECUTION
  // STATE (who was picked, what's next) rather than re-presenting the full
  // candidate pool every time — the operator already made this decision.
  // Editing re-enters discovery mode only on explicit request (state.
  // outreachEditing), never automatically. CANDIDATES_FOUND (nothing chosen
  // yet) always shows the picker — there is no execution state to summarize.
  if (job.status === 'CONTACTS_SELECTED' && !state.outreachEditing[job.job_key]) {
    for (const c of job.selected_contacts || []) {
      const line = el('div', { class: 'row', style: 'margin-bottom:6px;align-items:center' });
      line.appendChild(document.createTextNode(
        `${c.name || '(name unknown)'} — ${c.title || '(title unknown)'}${c.company ? ' @ ' + c.company : ''} · ${c.status || 'CONTACT_SELECTED'}${c.next_action ? ` · next: ${c.next_action}${c.next_action_due ? ` (${c.next_action_due})` : ''}` : ''}`
      ));
      if (c.linkedin_url) line.appendChild(el('a', { href: c.linkedin_url, target: '_blank', rel: 'noopener', text: 'LinkedIn', style: 'margin-left:8px' }));
      card.appendChild(line);
    }
    card.appendChild(el('div', { class: 'meta', text: 'Per-contact follow-up (channel, next action, mark done/skip) is managed from Home.', style: 'margin-top:6px' }));
    card.appendChild(el('div', { class: 'row', style: 'margin-top:10px' }, [
      el('button', {
        class: 'action',
        text: 'Edit Selection',
        onclick: () => { state.outreachEditing[job.job_key] = true; loadOutreach(); },
      }),
    ]));
    return card;
  }

  if (job.status === 'CANDIDATES_FOUND' || job.status === 'CONTACTS_SELECTED') {
    const selected = state.outreachSelections[job.job_key] || new Set((job.selected_contacts || []).map((c) => c.candidate_id));
    state.outreachSelections[job.job_key] = selected;

    const recruiting = job.candidates.filter((c) => c.lane === 'RECRUITING');
    const functional = job.candidates.filter((c) => c.lane === 'FUNCTIONAL');

    for (const [label, lane] of [['Recruiting', recruiting], ['Functional', functional]]) {
      card.appendChild(el('div', { class: 'lane-title', text: label }));
      if (lane.length === 0) { card.appendChild(el('div', { class: 'meta', text: '(none found)' })); continue; }
      for (const c of lane) {
        const cid = `cand-${job.job_key}-${c.candidate_id}`;
        const row = el('div', { class: 'candidate' });
        const checkbox = el('input', { type: 'checkbox', id: cid });
        checkbox.checked = selected.has(c.candidate_id);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selected.add(c.candidate_id); else selected.delete(c.candidate_id);
        });
        row.appendChild(checkbox);
        const label2 = el('label', { for: cid });
        label2.appendChild(document.createTextNode(`${c.name || '(name unknown)'} — ${c.title || '(title unknown)'}${c.company ? ' @ ' + c.company : ''} `));
        label2.appendChild(el('span', { class: 'badge', text: `score ${c.score}` }));
        if (c.linkedin_url) {
          label2.appendChild(document.createTextNode(' '));
          label2.appendChild(el('a', { href: c.linkedin_url, target: '_blank', rel: 'noopener', text: 'LinkedIn' }));
        }
        row.appendChild(label2);
        card.appendChild(row);
      }
    }

    // Save Selected Contacts (P0 fix): the save itself always worked — the
    // defect was that a successful save produced NO visible feedback before
    // loadOutreach() rebuilt this exact card with the same lane/checkbox
    // layout (CANDIDATES_FOUND and CONTACTS_SELECTED render identically
    // apart from a small meta line), so a click looked like it did nothing.
    // Show an explicit "Saved" status (same statusEl pattern as
    // renderOperatingControls' Save Changes) and hold it on screen briefly
    // before the reload, so the state change is visible, not just true.
    const saveBtn = el('button', { class: 'action primary', text: 'Save Selected Contacts' });
    const saveStatusEl = el('span', { class: 'meta', style: 'margin-left:8px' });
    saveBtn.addEventListener('click', async () => {
      const ids = Array.from(selected);
      if (ids.length === 0) { showError(card, 'Select at least one contact first.'); return; }
      saveBtn.disabled = true;
      saveStatusEl.textContent = 'Saving…';
      try {
        await api('POST', '/api/outreach/select', { job_key: job.job_key, candidate_ids: ids });
        saveStatusEl.textContent = `Saved — ${ids.length} contact${ids.length === 1 ? '' : 's'} selected`;
        delete state.outreachEditing[job.job_key]; // saved -> back to the execution-state summary, not left open in discovery mode
        await new Promise((resolve) => setTimeout(resolve, 500));
        loadOutreach();
      } catch (e) {
        saveBtn.disabled = false;
        saveStatusEl.textContent = '';
        showError(card, e.message);
      }
    });
    card.appendChild(el('div', { class: 'row', style: 'margin-top:10px' }, [saveBtn, saveStatusEl]));
  }

  return card;
}

// ── Home (Pass 5: job-level operator board) ─────────────────────────────
//
// Reads GET /api/followup, which now returns both the granular per-contact
// `actions` (Mark Done/Skip still resolve against those action_ids — see
// followup-schema.mjs's buildFollowUpAction) and `home_rows`, the SAME list
// re-grouped one row per job_key (buildHomeRows). Home renders home_rows
// exclusively: a job with 0, 1, or 5 contact actions is exactly one row here,
// never a second source of truth beyond that grouping.

function formatAppliedLabel(row) {
  if (!row.applied_at) return '—';
  return new Date(row.applied_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatFollowUpLabel(row) {
  if (!row.due_at) return '—';
  if (row.bucket === 'TODAY') return 'Today';
  const due = new Date(`${row.due_at}T00:00:00`);
  return due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Generic YYYY-MM-DD -> short label formatter, for Last Touch (no bucket/
// "Today" special-casing the way Follow-up gets — Last Touch is a plain
// historical date, never a due-soon signal).
function formatShortDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Same local-date arithmetic as todayLocalStr() (n=0), generalized for the
// Tomorrow/+3 days/+7 days quick actions below — client-side date math only,
// the server still validates the resulting YYYY-MM-DD string on save.
function addDaysLocalStr(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const localMs = d.getTime() - d.getTimezoneOffset() * 60000;
  return new Date(localMs).toISOString().slice(0, 10);
}

// Inline editing vocab (Pass 6) — deliberately the SAME closed lists the
// backend validates against (followup-schema.mjs's NEXT_ACTIONS,
// application-schema.mjs's HIRING_STAGES), duplicated here only because this
// is a plain script with no shared import into the browser. Keep in sync by
// hand if either list changes.
const NEXT_ACTION_OPTIONS = ['—', 'FOLLOW_UP', 'CHECK_CONNECTION', 'SEND_EMAIL', 'SEND_MESSAGE'];
const HIRING_STAGE_OPTIONS = ['Applied', 'Recruiter Screen', 'Hiring Manager', 'Interview', 'Final', 'Offer'];
// Same closed vocab as followup-schema.mjs's OPERATING_PRIORITIES.
const PRIORITY_OPTIONS = ['—', 'P0', 'P1', 'P2', 'P3'];

// Home top-level filters (one-shot spec section A). Each maps to a
// predicate over the combined home_rows + ready_rows list — see
// homeFilterPredicate(). APPLIED gets its own time-bucket sub-filter
// (HOME_APPLIED_BUCKETS below), never a second top-level chip row.
const HOME_TOP_FILTERS = [
  ['ALL_ACTIVE', 'All Active'],
  ['READY_TO_APPLY', 'Ready to Apply'],
  ['OUTREACH_NEEDED', 'Outreach Needed'],
  ['WAITING', 'Waiting'],
  ['DUE_OVERDUE', 'Due / Overdue'],
  ['APPLIED', 'Applied'],
];
// Applied-date filters (Home UI correction, section 3) — rolling trailing-day
// windows anchored on todayStr, NOT calendar weeks: "Last 7 Days" and "Last
// 14 Days" both include today and therefore overlap each other (and
// "Applied Today"). These are independent filter predicates the operator
// picks one of at a time, not a single mutually-exclusive partition, so a
// row's membership in one doesn't determine its membership in another.
const HOME_APPLIED_BUCKETS = [
  ['TODAY', 'Applied Today'],
  ['LAST_7', 'Last 7 Days'],
  ['LAST_14', 'Last 14 Days'],
  ['OLDER', '> 2 Weeks'],
];

/** Whole calendar days between an applied_at timestamp and todayStr (0 = today); null if unset. */
function daysSinceApplied(appliedAt, todayStr) {
  if (!appliedAt) return null;
  const appliedDateStr = new Date(appliedAt).toISOString().slice(0, 10);
  const days = Math.round((new Date(`${todayStr}T00:00:00`) - new Date(`${appliedDateStr}T00:00:00`)) / 86400000);
  return days;
}

/**
 * Does this applied_at match the given HOME_APPLIED_BUCKETS key, relative to
 * todayStr? Boundary convention: "Last 7 Days"/"Last 14 Days" count today as
 * day 0, so they cover days 0-6 and 0-13 respectively (7 and 14 distinct
 * calendar days); "> 2 Weeks" is exactly their complement (day >= 14) so
 * every dated row lands in exactly one of {OLDER} vs {LAST_14}, with no gap
 * or double-count at the boundary. An unset applied_at never matches any of
 * these — undated jobs don't appear in Applied-date views.
 */
function appliedTimeBucket(bucketKey, appliedAt, todayStr) {
  const days = daysSinceApplied(appliedAt, todayStr);
  if (days === null || days < 0) return false;
  switch (bucketKey) {
    case 'TODAY': return days === 0;
    case 'LAST_7': return days <= 6;
    case 'LAST_14': return days <= 13;
    case 'OLDER': return days >= 14;
    default: return false;
  }
}

/** Short "Applied Nd ago" / "Waiting Nd" / "Overdue Nd" / etc. operator-facing age text — display only, derived from existing fields. */
function rowAgeText(row, todayStr) {
  if (row.home_kind === 'READY_TO_APPLY') return 'Ready to apply';
  const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
  if (row.bucket === 'OVERDUE' && row.due_at) return `Overdue ${daysBetween(row.due_at, todayStr)}d`;
  if (row.bucket === 'TODAY') return 'Follow-up due today';
  if (row.bucket === 'UPCOMING' && row.due_at) return `Due in ${daysBetween(todayStr, row.due_at)}d`;
  if (row.contact_id == null && row.outreach_needed) return 'Outreach not started';
  if (row.applied_at) {
    const appliedDateStr = new Date(row.applied_at).toISOString().slice(0, 10);
    const age = daysBetween(appliedDateStr, todayStr);
    return age <= 0 ? 'Applied today' : `Applied ${age}d ago`;
  }
  return '—';
}

/** Predicate for one HOME_TOP_FILTERS entry over a combined home/ready row. */
function homeFilterPredicate(filterKey, row) {
  switch (filterKey) {
    case 'READY_TO_APPLY': return row.home_kind === 'READY_TO_APPLY';
    case 'OUTREACH_NEEDED': return !!row.outreach_needed;
    case 'WAITING': return row.bucket === 'WAITING';
    case 'DUE_OVERDUE': return row.bucket === 'OVERDUE' || row.bucket === 'TODAY' || row.bucket === 'UPCOMING';
    case 'APPLIED': return row.home_kind === 'APPLIED';
    case 'ALL_ACTIVE':
    default: return true;
  }
}

// Urgency rank for the default ALL ACTIVE sort (spec section C): OVERDUE ->
// TODAY -> READY TO APPLY -> OUTREACH NEEDED -> WAITING/aging -> everything
// else. A row can match more than one tier (e.g. an OVERDUE row that also
// needs outreach) — it sorts by the FIRST tier it qualifies for.
function urgencyRank(row) {
  if (row.bucket === 'OVERDUE') return 0;
  if (row.bucket === 'TODAY') return 1;
  if (row.home_kind === 'READY_TO_APPLY') return 2;
  if (row.outreach_needed) return 3;
  if (row.bucket === 'WAITING') return 4;
  return 5;
}

function sortHomeRowsForDisplay(rows, filterKey) {
  const sorted = [...rows];
  if (filterKey === 'APPLIED') {
    // Applied recent views: newest applied first.
    sorted.sort((a, b) => String(b.applied_at || '').localeCompare(String(a.applied_at || '')) || a.job_key.localeCompare(b.job_key));
    return sorted;
  }
  if (filterKey === 'WAITING') {
    // Within WAITING: oldest waiting (earliest applied_at) first.
    sorted.sort((a, b) => String(a.applied_at || '').localeCompare(String(b.applied_at || '')) || a.job_key.localeCompare(b.job_key));
    return sorted;
  }
  // Default (ALL ACTIVE and every other filter): urgency tier, then due
  // date, then oldest-applied-first as the WAITING tie-break, then job_key.
  sorted.sort((a, b) => {
    const cmp = urgencyRank(a) - urgencyRank(b);
    if (cmp !== 0) return cmp;
    const dueCmp = String(a.due_at || '').localeCompare(String(b.due_at || ''));
    if (dueCmp !== 0) return dueCmp;
    const appliedCmp = String(a.applied_at || '').localeCompare(String(b.applied_at || ''));
    if (appliedCmp !== 0) return appliedCmp;
    return a.job_key.localeCompare(b.job_key);
  });
  return sorted;
}

async function loadFollowup() {
  const countsEl = $('#followup-counts');
  const listEl = $('#followup-list');
  listEl.innerHTML = '<p class="empty">Loading…</p>';
  countsEl.innerHTML = '';
  let data;
  try { data = await api('GET', '/api/followup'); }
  catch (e) { listEl.innerHTML = ''; showError(listEl, e.message); return; }

  const todayStr = todayLocalStr();
  // ALL ACTIVE's own working set: every live job — an applied job (real or
  // fallback row) plus every READY_TO_APPLY job. Both are already suppressed
  // upstream for terminal states (see readOutreach/home-row builders and
  // ui-server.mjs's readyRowsForHome/listReadyToApply), so no further
  // REJECTED/CLOSED/WITHDRAWN/NOT_APPLYING filtering is needed here.
  const allRows = [...(data.home_rows || []), ...(data.ready_rows || [])];

  const filterCounts = {};
  for (const [key] of HOME_TOP_FILTERS) filterCounts[key] = allRows.filter((r) => homeFilterPredicate(key, r)).length;
  const appliedRows = allRows.filter((r) => r.home_kind === 'APPLIED');
  const appliedBucketCounts = {};
  for (const [key] of HOME_APPLIED_BUCKETS) {
    appliedBucketCounts[key] = appliedRows.filter((r) => appliedTimeBucket(key, r.applied_at, todayStr)).length;
  }

  const activeFilter = state.homeFilter || 'ALL_ACTIVE';
  for (const [key, label] of HOME_TOP_FILTERS) {
    countsEl.appendChild(el('button', {
      class: `fu-chip ${key.toLowerCase()}${activeFilter === key ? ' selected' : ''}`,
      onclick: () => { state.homeFilter = key === 'ALL_ACTIVE' ? null : key; state.homeAppliedBucket = null; loadFollowup(); },
    }, [el('span', { text: label }), el('b', { text: String(filterCounts[key]) })]));
  }

  let rows = allRows.filter((r) => homeFilterPredicate(activeFilter, r));

  const appliedBucketRow = el('div', { class: 'row', style: 'margin:8px 0 14px' });
  if (activeFilter === 'APPLIED') {
    for (const [key, label] of HOME_APPLIED_BUCKETS) {
      appliedBucketRow.appendChild(el('button', {
        class: `fu-chip ${key.toLowerCase()}${state.homeAppliedBucket === key ? ' selected' : ''}`,
        onclick: () => { state.homeAppliedBucket = state.homeAppliedBucket === key ? null : key; loadFollowup(); },
      }, [el('span', { text: label }), el('b', { text: String(appliedBucketCounts[key]) })]));
    }
    if (state.homeAppliedBucket) rows = rows.filter((r) => appliedTimeBucket(state.homeAppliedBucket, r.applied_at, todayStr));
  }

  rows = sortHomeRowsForDisplay(rows, activeFilter);

  listEl.innerHTML = '';
  if (activeFilter === 'APPLIED') listEl.appendChild(appliedBucketRow);
  if (allRows.length === 0) {
    listEl.appendChild(el('p', { class: 'empty', text: 'Nothing needs action right now.' }));
    return;
  }
  if (rows.length === 0) {
    listEl.appendChild(el('p', { class: 'empty', text: 'No rows match this filter.' }));
    return;
  }

  const table = el('table', { class: 'fu-table' });
  // Shared grid: this <colgroup> is the one width definition both the header
  // and every collapsed row draw from (native table layout keeps them
  // pixel-aligned) — Applied/Priority/Status/Last Touch/Follow-up stay
  // compact, and the width freed by dropping the Age column (Home UI
  // correction, section 1) goes mostly to Next Action, then Company / Role
  // and Waiting On (spec section 1's original ordering).
  const colgroup = el('colgroup', {}, [
    el('col', { style: 'width:76px' }),   // Applied
    el('col', { style: 'width:70px' }),   // Priority
    el('col', { style: 'width:24%' }),    // Company / Role
    el('col', { style: 'width:92px' }),   // Status
    el('col', { style: 'width:96px' }),   // Last Touch
    el('col', { style: 'width:88px' }),   // Follow-Up
    el('col', { style: 'width:31%' }),    // Next Action
    el('col', { style: 'width:18%' }),    // Waiting On
  ]);
  table.appendChild(colgroup);
  const thead = el('thead', {}, el('tr', {}, [
    el('th', { text: 'Applied' }), el('th', { text: 'Priority' }), el('th', { text: 'Company / Role' }),
    el('th', { text: 'Status' }), el('th', { text: 'Last Touch' }), el('th', { text: 'Follow-up' }),
    el('th', { text: 'Next Action' }), el('th', { text: 'Waiting On' }),
  ]));
  table.appendChild(thead);
  const tbody = el('tbody');
  // Zebra striping is keyed by opportunity index (rows.indexOf-equivalent
  // counter), not DOM child position — an expanded row inserts a second
  // <tr class="fu-detail"> per opportunity, so nth-child striping would
  // drift after the first expansion (section 6).
  rows.forEach((row, i) => {
    for (const r of renderHomeRow(row, todayStr, i)) tbody.appendChild(r);
  });
  table.appendChild(tbody);
  listEl.appendChild(table);
}

// READY_TO_APPLY rows (one-shot Home extension) render a much smaller
// row/detail — they carry none of the applied-job fields (stage, operating,
// contacts) — and reuse the EXACT Ready-to-Apply endpoints
// (/api/ready/applied, /api/ready/pass) rather than inventing a second
// mark-applied/pass code path. Same inline two-step confirm pattern as the
// Ready to Apply tab (never window.confirm() — see loadReady()'s comment).
function renderReadyHomeRow(row, todayStr, stripeIndex) {
  const tr = el('tr', {
    class: `fu-row${stripeIndex % 2 === 0 ? ' fu-stripe' : ''}`,
    'data-job-key': row.job_key,
    onclick: () => {
      state.followupExpanded = state.followupExpanded === row.job_key ? null : row.job_key;
      loadFollowup();
    },
  });
  tr.appendChild(el('td', { text: '—' })); // Applied
  tr.appendChild(el('td', { text: '—' })); // Priority
  tr.appendChild(el('td', { text: `${row.company || '(company unknown)'} — ${row.role || '(role unknown)'}` }));
  tr.appendChild(el('td', { text: 'READY TO APPLY' }));
  tr.appendChild(el('td', { text: '—' })); // Last Touch
  tr.appendChild(el('td', { text: '—' })); // Follow-up
  tr.appendChild(el('td', { text: '—' })); // Next Action
  tr.appendChild(el('td', { text: '—' })); // Waiting On

  const rows = [tr];
  if (state.followupExpanded === row.job_key) {
    const detailCell = el('td', { colspan: '8' });
    if (row.url && /^https?:\/\//i.test(row.url)) {
      detailCell.appendChild(el('div', { class: 'row', style: 'margin-bottom:10px' }, [
        el('a', { href: row.url, target: '_blank', rel: 'noopener', class: 'action', text: 'Open Application' }),
      ]));
    }
    const markBtn = el('button', { class: 'action primary', text: 'Mark Applied' });
    markBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (markBtn.dataset.confirming === 'true') {
        markBtn.disabled = true;
        markBtn.textContent = 'Marking…';
        api('POST', '/api/ready/applied', { job_key: row.job_key }).then(() => loadFollowup())
          .catch((e) => { markBtn.disabled = false; markBtn.dataset.confirming = 'false'; markBtn.textContent = 'Mark Applied'; showError(detailCell, e.message); });
        return;
      }
      markBtn.dataset.confirming = 'true';
      markBtn.textContent = `Confirm: mark ${row.company} applied?`;
    });
    const passBtn = el('button', { class: 'action', text: 'Pass' });
    passBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (passBtn.dataset.confirming === 'true') {
        passBtn.disabled = true;
        passBtn.textContent = 'Passing…';
        api('POST', '/api/ready/pass', { job_key: row.job_key }).then(() => loadFollowup())
          .catch((e) => { passBtn.disabled = false; passBtn.dataset.confirming = 'false'; passBtn.textContent = 'Pass'; showError(detailCell, e.message); });
        return;
      }
      passBtn.dataset.confirming = 'true';
      passBtn.textContent = 'Pass on this job?';
    });
    detailCell.appendChild(el('div', { class: 'row' }, [markBtn, passBtn]));
    rows.push(el('tr', { class: 'fu-detail' }, detailCell));
  }
  return rows;
}

function renderHomeRow(row, todayStr, stripeIndex) {
  if (row.home_kind === 'READY_TO_APPLY') return renderReadyHomeRow(row, todayStr, stripeIndex);

  const tr = el('tr', {
    class: `fu-row${stripeIndex % 2 === 0 ? ' fu-stripe' : ''}`,
    'data-job-key': row.job_key,
    onclick: () => {
      state.followupExpanded = state.followupExpanded === row.job_key ? null : row.job_key;
      loadFollowup();
    },
  });
  tr.appendChild(el('td', { text: formatAppliedLabel(row) }));
  tr.appendChild(el('td', { text: row.priority || '—' }));
  tr.appendChild(el('td', { text: `${row.company || '(company unknown)'} — ${row.role || '(role unknown)'}` }));
  tr.appendChild(el('td', { class: `fu-status-${row.status.replace(/\s+/g, '-')}`, text: row.status }));
  tr.appendChild(el('td', { text: formatShortDate(row.last_touch) }));
  tr.appendChild(el('td', { class: `fu-due-${row.bucket}`, text: formatFollowUpLabel(row) }));
  tr.appendChild(el('td', { text: (row.next_action || '—') + (row.extra_count > 0 ? ` (+${row.extra_count})` : '') }));
  tr.appendChild(el('td', { text: row.waiting_on || '—' }));

  const rows = [tr];
  if (state.followupExpanded === row.job_key) {
    const detailCell = el('td', { colspan: '8' });
    // Card header: identity (already the collapsed row's own text, repeated
    // here since the detail row is visually detached from it) plus the two
    // compact status controls — Stage (saves immediately) and Priority
    // (part of the Operating draft, saved via Save Changes below). Company/
    // Role has no separate label here since it's the title itself, and
    // "Operating:" is gone — the block labels below (NEXT ACTION, etc.)
    // already say what they are.
    const badges = el('div', { class: 'fu-card-badges', onclick: (ev) => ev.stopPropagation() }, [
      el('div', { class: 'fu-card-badge fu-stage-badge' }, [el('span', { text: 'Stage' }), renderStageControl(row, detailCell)]),
    ]);
    const head = el('div', { class: 'fu-card-head' }, [
      el('div', { class: 'fu-card-title', text: `${row.company || '(unknown)'} — ${row.role || '(unknown)'}` }),
      badges,
    ]);
    detailCell.appendChild(head);
    // Status stays derived/read-only (spec section 6) — never a control here.
    detailCell.appendChild(el('div', { class: 'fu-card-status' },
      document.createTextNode(`Status: ${row.status}   ·   Applied: ${formatAppliedLabel(row)}`)));
    detailCell.appendChild(renderOperatingControls(row, detailCell, badges));
    detailCell.appendChild(el('div', { class: 'meta', text: 'Contact-level action (per outreach contact):', style: 'margin-top:14px' }));
    detailCell.appendChild(renderActionControl(row, detailCell));
    const btnRow = el('div', { class: 'row', style: 'margin-top:10px' });
    btnRow.appendChild(el('button', {
      class: 'action',
      text: 'Open Application',
      onclick: (ev) => {
        ev.stopPropagation();
        // 'all' guarantees the target row is visible regardless of its
        // alive/closed status — the operator asked to see THIS job, not
        // whichever filter happened to be selected before.
        state.applicationsFilter = 'all';
        $all('[data-app-filter]').forEach((b) => b.classList.toggle('selected', b.dataset.appFilter === 'all'));
        state.applicationsHighlightKey = row.job_key;
        setView('applications');
      },
    }));
    btnRow.appendChild(el('button', {
      class: 'action',
      text: 'Open Outreach',
      onclick: (ev) => {
        ev.stopPropagation();
        state.outreachHighlightKey = row.job_key;
        setView('outreach');
      },
    }));
    detailCell.appendChild(btnRow);
    detailCell.appendChild(renderHomeContacts(row, detailCell));
    const detailRow = el('tr', { class: 'fu-detail' }, detailCell);
    rows.push(detailRow);
  }
  return rows;
}

// Inline Stage editor (Pass 6): POST /api/home/stage/update — the smallest
// sibling of Applications' Update Status, editing only application_stage.
// Works identically whether the row has a real contact or is the synthetic
// fallback (Salsify-shape) — Stage lives on the job, never on a contact.
// A stage already outside HIRING_STAGE_OPTIONS (e.g. a historical
// "Recruiter Routing") is offered as its own extra option so it displays
// correctly and is never silently overwritten by re-selecting it.
function renderStageControl(row, detailCell) {
  const select = el('select', {
    class: 'fu-field-select',
    onchange: async (ev) => {
      const value = ev.target.value;
      if (value === row.application_stage) return;
      select.disabled = true;
      try { await api('POST', '/api/home/stage/update', { job_key: row.job_key, stage: value }); loadFollowup(); }
      catch (e) { select.disabled = false; select.value = row.application_stage || 'Applied'; showError(detailCell, e.message); }
    },
  });
  const known = HIRING_STAGE_OPTIONS.includes(row.application_stage);
  if (!known && row.application_stage) {
    select.appendChild(el('option', { value: row.application_stage, text: `${row.application_stage} (current)` }));
  }
  for (const stage of HIRING_STAGE_OPTIONS) select.appendChild(el('option', { value: stage, text: stage }));
  select.value = row.application_stage || 'Applied';
  return select;
}

// Home operating-metadata fields — a closed list shared by the draft model
// below and diffOperatingPatch()'s comparison.
const OPERATING_FIELD_NAMES = ['priority', 'last_touch', 'next_action', 'waiting_on', 'follow_up_due', 'notes'];

// null/undefined/'' all mean "unset" for these fields (matches the backend's
// own PATCH semantics — see updateJobOperatingMetadata), so normalize before
// ever comparing draft vs persisted or a stale diff will report a change
// that isn't really one.
function normalizeOperatingValue(v) {
  return v === undefined || v === null || v === '' ? null : v;
}

/** A fresh draft object seeded from row.operating (never from the merged
 * display fields row.next_action/row.due_at — see the prefill note this
 * function replaces). */
function freshOperatingDraft(op) {
  const draft = {};
  for (const field of OPERATING_FIELD_NAMES) draft[field] = normalizeOperatingValue((op || {})[field]);
  return draft;
}

/** Only the fields that actually changed vs persisted — the PATCH body. */
function diffOperatingPatch(persisted, draft) {
  const patch = {};
  for (const field of OPERATING_FIELD_NAMES) {
    if (normalizeOperatingValue(persisted[field]) !== normalizeOperatingValue(draft[field])) {
      patch[field] = normalizeOperatingValue(draft[field]);
    }
  }
  return patch;
}

// Home operating-metadata MVP: Priority/Last Touch/Next Action/Waiting On/
// Follow-Up Due/Notes, one POST /api/home/operating/update per explicit
// Save Changes click (never per-keystroke — see the "Home operating edit UX
// hotfix" note below) — the job-level operator loop that works even on a
// row with zero contacts (row.contact_id == null), unlike renderActionControl
// above.
//
// Every control here writes to an in-memory draft only, seeded once from
// row.operating (the raw, unmerged job-level fields — never the merged
// display values row.next_action/row.due_at, so a contact-derived fallback
// shown in the top-level table is never echoed back into this editor as if
// it had been explicitly set). Nothing calls the backend or loadFollowup()
// until Save Changes: editing used to fire one API call + one full Home
// rerender per field (per blur/change), which tore down and rebuilt this
// exact DOM subtree — collapsing the expanded row and losing the operator's
// place after every single edit, the opposite of "easier than Excel". A
// closure-local draft survives fine across edits because nothing rerenders
// while editing; it's only reset (correctly) by the loadFollowup() call
// Save Changes itself triggers on success, since that's a fresh render off
// the just-saved server state.
function renderOperatingControls(row, detailCell, badgesContainer) {
  const persisted = freshOperatingDraft(row.operating);
  const draft = { ...persisted };

  const prioritySelect = el('select', { class: 'fu-field-select' });
  for (const p of PRIORITY_OPTIONS) prioritySelect.appendChild(el('option', { value: p, text: p }));
  prioritySelect.value = draft.priority || '—';

  const lastTouchInput = el('input', { type: 'date', class: 'fu-field' });
  if (draft.last_touch) lastTouchInput.value = draft.last_touch;

  const nextActionInput = el('input', { type: 'text', class: 'fu-field', placeholder: 'e.g. Follow up on outreach' });
  nextActionInput.value = draft.next_action || '';

  const waitingOnInput = el('input', { type: 'text', class: 'fu-field', placeholder: 'e.g. recruiter response' });
  waitingOnInput.value = draft.waiting_on || '';

  const followUpInput = el('input', { type: 'date', class: 'fu-field' });
  if (draft.follow_up_due) followUpInput.value = draft.follow_up_due;

  const notesInput = el('input', { type: 'text', class: 'fu-field', placeholder: 'notes' });
  notesInput.value = draft.notes || '';

  const unsavedEl = el('span', { class: 'meta fu-unsaved', text: 'Unsaved changes', style: 'display:none;color:#8a6300;margin-left:8px' });
  const statusEl = el('span', { class: 'meta fu-save-status', style: 'margin-left:8px' });
  const saveBtn = el('button', { class: 'action primary', text: 'Save Changes' });
  saveBtn.disabled = true;
  const cancelBtn = el('button', { class: 'action', text: 'Cancel' });

  function refreshDirtyState() {
    const dirty = Object.keys(diffOperatingPatch(persisted, draft)).length > 0;
    saveBtn.disabled = !dirty;
    unsavedEl.style.display = dirty ? '' : 'none';
  }

  // Every control here is draft-only: it updates `draft` and re-derives
  // dirty state, and nothing else. No fetch, no loadFollowup().
  prioritySelect.addEventListener('change', (ev) => { draft.priority = ev.target.value === '—' ? null : ev.target.value; refreshDirtyState(); });
  lastTouchInput.addEventListener('change', (ev) => { draft.last_touch = ev.target.value || null; refreshDirtyState(); });
  nextActionInput.addEventListener('input', (ev) => { draft.next_action = ev.target.value || null; refreshDirtyState(); });
  waitingOnInput.addEventListener('input', (ev) => { draft.waiting_on = ev.target.value || null; refreshDirtyState(); });
  followUpInput.addEventListener('change', (ev) => { draft.follow_up_due = ev.target.value || null; refreshDirtyState(); });
  notesInput.addEventListener('input', (ev) => { draft.notes = ev.target.value || null; refreshDirtyState(); });

  function setFollowUpDraft(value) {
    draft.follow_up_due = value;
    followUpInput.value = value || '';
    refreshDirtyState();
  }

  function quickBtn(label, days) {
    return el('button', {
      class: 'action',
      text: label,
      onclick: (ev) => { ev.stopPropagation(); setFollowUpDraft(addDaysLocalStr(days)); },
    });
  }

  cancelBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    Object.assign(draft, persisted);
    prioritySelect.value = draft.priority || '—';
    lastTouchInput.value = draft.last_touch || '';
    nextActionInput.value = draft.next_action || '';
    waitingOnInput.value = draft.waiting_on || '';
    followUpInput.value = draft.follow_up_due || '';
    notesInput.value = draft.notes || '';
    statusEl.textContent = '';
    refreshDirtyState();
  });

  saveBtn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const patch = diffOperatingPatch(persisted, draft);
    if (Object.keys(patch).length === 0) return;
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    try {
      await api('POST', '/api/home/operating/update', { job_key: row.job_key, ...patch });
      statusEl.textContent = 'Saved';
      // A brief pause so "Saved" is actually visible before the one
      // intentional reload below replaces this DOM subtree — Home rebuilds
      // from the just-saved server state, and since state.followupExpanded
      // is untouched by a save, this same row reopens automatically if
      // it's still in the active filter (spec sections 10-11); if the save
      // moved its bucket out of the current filter, it correctly
      // disappears instead of being forced visible.
      await new Promise((resolve) => setTimeout(resolve, 400));
      loadFollowup();
    } catch (e) {
      // Draft stays intact, row stays expanded — no loadFollowup() call on
      // failure, so nothing here gets torn down.
      cancelBtn.disabled = false;
      statusEl.textContent = '';
      refreshDirtyState();
      showError(detailCell, e.message);
    }
  });

  // Priority is part of this draft (saved via Save Changes below, not
  // immediately like Stage), but visually it belongs next to Stage in the
  // card header badges, not buried in the action block.
  if (badgesContainer) {
    badgesContainer.appendChild(el('div', { class: 'fu-card-badge fu-priority-badge' }, [el('span', { text: 'Priority' }), prioritySelect]));
  }

  const wrap = el('div', { class: 'fu-operating', onclick: (ev) => ev.stopPropagation(), style: 'margin:10px 0' });

  // Primary operating block: Next Action / Follow-Up Due / Waiting On —
  // the three fields an operator actually works from day to day (spec
  // section 2).
  const actionBlock = el('div', { class: 'fu-action-block' });
  actionBlock.appendChild(el('div', { class: 'fu-field-group' }, [
    el('div', { class: 'fu-block-label', text: 'Next Action' }), nextActionInput,
  ]));
  const quickRow = el('div', { class: 'fu-followup-row' }, [
    followUpInput,
    quickBtn('Tomorrow', 1),
    quickBtn('+3 days', 3),
    quickBtn('+7 days', 7),
    el('button', { class: 'action', text: 'Clear', onclick: (ev) => { ev.stopPropagation(); setFollowUpDraft(null); } }),
  ]);
  actionBlock.appendChild(el('div', { class: 'fu-field-group' }, [
    el('div', { class: 'fu-block-label', text: 'Follow-Up Due' }), quickRow,
  ]));
  actionBlock.appendChild(el('div', { class: 'fu-field-group' }, [
    el('div', { class: 'fu-block-label', text: 'Waiting On' }), waitingOnInput,
  ]));
  wrap.appendChild(actionBlock);

  wrap.appendChild(el('div', { class: 'fu-card-divider' }));

  // Secondary context/history block: Last Touch / Notes — no longer left
  // floating on its own (spec section 3).
  const contextBlock = el('div', { class: 'fu-context-block' });
  contextBlock.appendChild(el('div', { class: 'fu-field-group' }, [
    el('div', { class: 'fu-block-label', text: 'Last Touch' }), lastTouchInput,
  ]));
  contextBlock.appendChild(el('div', { class: 'fu-field-group' }, [
    el('div', { class: 'fu-block-label', text: 'Notes' }), notesInput,
  ]));
  wrap.appendChild(contextBlock);

  const saveRow = el('div', { class: 'row', style: 'margin-top:10px;gap:8px;align-items:center' }, [
    saveBtn, cancelBtn, unsavedEl, statusEl,
  ]);
  wrap.appendChild(saveRow);
  return wrap;
}

// Inline Next Action / Follow-up editor (Pass 6): POST /api/home/action/update
// — mutates ONLY row.action_id, the same id Mark Done/Skip already resolve
// against (outreach.mjs's findFollowUpTarget), so this can never touch a
// job's other (folded) contacts. Disabled entirely when the row has no real
// contact (row.contact_id == null, the synthetic APPLICATION_PENDING
// fallback) — per this pass's explicit scope limit, editing a job-level
// action with no contact to own it would require a generalized task model
// this pass does not build; Stage is still editable in that case (see
// renderStageControl above), just not Next Action/Follow-up.
function renderActionControl(row, detailCell) {
  if (row.contact_id == null) {
    return el('div', { class: 'meta', style: 'margin:8px 0' },
      document.createTextNode('No contact action yet — set Stage above, or add a contact from Outreach. (Editing a job-level action with no contact isn’t supported in this pass.)'));
  }

  const actionSelect = el('select', {});
  for (const opt of NEXT_ACTION_OPTIONS) actionSelect.appendChild(el('option', { value: opt === '—' ? '' : opt, text: opt }));
  actionSelect.value = row.contact_next_action || '';

  const dateInput = el('input', { type: 'date' });
  if (row.contact_due_at) dateInput.value = row.contact_due_at;

  async function save(nextAction, nextActionDue) {
    try {
      await api('POST', '/api/home/action/update', { action_id: row.action_id, next_action: nextAction, next_action_due: nextActionDue });
      loadFollowup();
    } catch (e) { showError(detailCell, e.message); }
  }

  actionSelect.addEventListener('change', (ev) => {
    const value = ev.target.value || null;
    save(value, value === null ? null : (dateInput.value || row.contact_due_at || null));
  });
  dateInput.addEventListener('change', (ev) => {
    save(actionSelect.value || row.contact_next_action || 'FOLLOW_UP', ev.target.value || null);
  });

  function quickBtn(label, days) {
    return el('button', {
      class: 'action',
      text: label,
      onclick: (ev) => { ev.stopPropagation(); save(actionSelect.value || row.contact_next_action || 'FOLLOW_UP', addDaysLocalStr(days)); },
    });
  }

  const wrap = el('div', { onclick: (ev) => ev.stopPropagation(), style: 'margin:10px 0' });
  wrap.appendChild(el('div', { class: 'row', style: 'gap:8px;align-items:center' }, [
    el('span', { class: 'meta', text: 'Next action:' }), actionSelect,
    el('span', { class: 'meta', text: 'Follow-up:' }), dateInput,
  ]));
  const quickRow = el('div', { class: 'row', style: 'margin-top:6px;gap:6px' }, [
    quickBtn('Tomorrow', 1),
    quickBtn('+3 days', 3),
    quickBtn('+7 days', 7),
    el('button', { class: 'action', text: 'Clear', onclick: (ev) => { ev.stopPropagation(); save(null, null); } }),
  ]);
  wrap.appendChild(quickRow);
  return wrap;
}

// Person/channel/contact-status live only inside the expanded row — Home's
// top-level table never shows them (spec section 3). `row.actions` is every
// real per-contact action on this job (or the single APPLICATION_PENDING
// fallback when it has none — detected by contact_id === null, not by
// string-matching that label, so it stays correct if the label ever changes).
function renderHomeContacts(row, detailCell) {
  const wrap = el('div', { style: 'margin-top:12px' });
  wrap.appendChild(el('div', { class: 'meta', text: 'Contacts:', style: 'margin-bottom:6px' }));
  const realActions = row.actions.filter((a) => a.contact_id != null);
  if (realActions.length === 0) {
    wrap.appendChild(el('p', { class: 'empty', text: 'No contact action yet — use Update Status on the Applications tab to resolve this row.' }));
    return wrap;
  }
  for (const action of realActions) {
    const line = el('div', { class: 'row', style: 'margin-bottom:8px;align-items:center' });
    line.appendChild(document.createTextNode(
      `${action.contact_name || '(name unknown)'} · ${action.channel || '(channel unknown)'} · ${action.contact_status} · ${action.action || '(no action)'} · ${action.due_at || 'no due date'}`
    ));
    const doneBtn = el('button', {
      class: 'action primary',
      text: 'Mark Done',
      onclick: async (ev) => {
        ev.stopPropagation();
        doneBtn.disabled = true;
        try { await api('POST', '/api/followup/complete', { action_id: action.action_id }); loadFollowup(); }
        catch (e) { doneBtn.disabled = false; showError(detailCell, e.message); }
      },
    });
    const skipBtn = el('button', {
      class: 'action',
      text: 'Skip',
      onclick: async (ev) => {
        ev.stopPropagation();
        skipBtn.disabled = true;
        try { await api('POST', '/api/followup/skip', { action_id: action.action_id }); loadFollowup(); }
        catch (e) { skipBtn.disabled = false; showError(detailCell, e.message); }
      },
    });
    line.appendChild(doneBtn);
    line.appendChild(skipBtn);
    wrap.appendChild(line);
  }
  return wrap;
}

setView('followup');

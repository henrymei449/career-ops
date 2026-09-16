// app.js — vanilla JS operator UI. Every button click calls a /api/* route
// that forwards straight to the existing review.mjs/outreach.mjs functions;
// no transition rule lives here. State is re-fetched from the server after
// every mutating action so the page always reflects the durable file, never
// a locally-cached guess.

const state = {
  view: 'followup',
  reviewSelections: {}, // job_key -> 'APPLY' | 'INVESTIGATE' | 'PASS'
  outreachSelections: {}, // job_key -> Set(candidate_id)
  selectedBatchId: null, // Review tab's currently selected open batch
  applicationsFilter: 'alive', // Applications tab's currently selected filter
  followupExpanded: null, // action_id of the currently expanded Follow-up row, or null
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

function formatBatchLabel(b) {
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

  for (const job of jobs) {
    if (!(job.job_key in state.reviewSelections) && job.proposed_decision) {
      state.reviewSelections[job.job_key] = job.proposed_decision;
    }
    listEl.appendChild(renderReviewCard(job));
  }
  updateFinalizeButton(data.batch_id, jobs);
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
  if (job.reason) card.appendChild(el('div', { class: 'reason', text: job.reason }));

  const row = el('div', { class: 'row' });
  for (const decision of ['APPLY', 'INVESTIGATE', 'PASS']) {
    const btn = el('button', {
      class: `action${state.reviewSelections[job.job_key] === decision ? ' selected' : ''}`,
      text: decision,
      onclick: () => {
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

    card.appendChild(el('div', { class: 'row', style: 'margin-top:10px' }, [
      el('button', {
        class: 'action primary',
        text: 'Save Selected Contacts',
        onclick: async () => {
          const ids = Array.from(selected);
          if (ids.length === 0) { showError(card, 'Select at least one contact first.'); return; }
          try { await api('POST', '/api/outreach/select', { job_key: job.job_key, candidate_ids: ids }); loadOutreach(); }
          catch (e) { showError(card, e.message); }
        },
      }),
    ]));
  }

  return card;
}

// ── Follow-up (Pass 4: operator home / action engine) ───────────────────
//
// Reads GET /api/followup (a derived queue over outreach.selected_contacts
// — see followup-schema.mjs) and posts Mark Done / Skip. Never a second
// source of truth: the row disappears once the server confirms the mutation,
// re-fetched from the same read every other tab uses.

function formatDueLabel(action) {
  if (!action.due_at) return action.bucket === 'WAITING' ? 'Waiting' : '—';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(`${action.due_at}T00:00:00`);
  if (action.bucket === 'TODAY') return 'Today';
  return due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

async function loadFollowup() {
  const countsEl = $('#followup-counts');
  const listEl = $('#followup-list');
  listEl.innerHTML = '<p class="empty">Loading…</p>';
  countsEl.innerHTML = '';
  let data;
  try { data = await api('GET', '/api/followup'); }
  catch (e) { listEl.innerHTML = ''; showError(listEl, e.message); return; }

  const actions = data.actions;
  const counts = { OVERDUE: 0, TODAY: 0, UPCOMING: 0, WAITING: 0 };
  for (const a of actions) counts[a.bucket] = (counts[a.bucket] || 0) + 1;
  for (const [bucket, label] of [['TODAY', 'Today'], ['OVERDUE', 'Overdue'], ['UPCOMING', 'Upcoming'], ['WAITING', 'Waiting']]) {
    countsEl.appendChild(el('div', { class: `fu-chip ${bucket.toLowerCase()}` }, [
      el('span', { text: label }),
      el('b', { text: String(counts[bucket]) }),
    ]));
  }

  listEl.innerHTML = '';
  if (actions.length === 0) {
    listEl.appendChild(el('p', { class: 'empty', text: 'Nothing needs action right now.' }));
    return;
  }

  const table = el('table', { class: 'fu-table' });
  const thead = el('thead', {}, el('tr', {}, [
    el('th', { text: 'Due' }), el('th', { text: 'Company' }), el('th', { text: 'Role' }),
    el('th', { text: 'Action' }), el('th', { text: 'Person' }), el('th', { text: 'Channel' }),
  ]));
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const action of actions) {
    for (const r of renderFollowUpRows(action)) tbody.appendChild(r);
  }
  table.appendChild(tbody);
  listEl.appendChild(table);
}

// Pass 5 amendment: a synthetic Home row (the "no explicit contact action
// yet" fallback — see buildApplicationPendingAction in followup-schema.mjs)
// has no contact to act on. Detected by contact_id === null rather than by
// action === 'APPLICATION_PENDING' string-matching, so it stays correct if
// that label ever changes.
function isApplicationPendingRow(action) {
  return action.contact_id == null;
}

function renderFollowUpRows(action) {
  const isPending = isApplicationPendingRow(action);
  const row = el('tr', { class: 'fu-row', onclick: () => {
    state.followupExpanded = state.followupExpanded === action.action_id ? null : action.action_id;
    loadFollowup();
  } });
  row.appendChild(el('td', { class: `fu-due-${action.bucket}`, text: formatDueLabel(action) }));
  row.appendChild(el('td', { text: action.company || '(company unknown)' }));
  row.appendChild(el('td', { text: action.role || '(role unknown)' }));
  row.appendChild(el('td', { text: action.action || '(none)' }));
  row.appendChild(el('td', { text: isPending ? '—' : (action.contact_name || '(name unknown)') }));
  row.appendChild(el('td', { text: isPending ? '—' : (action.channel || '') }));

  const rows = [row];
  if (state.followupExpanded === action.action_id) {
    const detailCell = el('td', { colspan: '6' });
    const grid = el('div', { class: 'fu-detail-grid' }, [
      el('div', {}, [el('span', { text: 'Company:' }), document.createTextNode(action.company || '(unknown)')]),
      el('div', {}, [el('span', { text: 'Role:' }), document.createTextNode(action.role || '(unknown)')]),
      el('div', {}, [el('span', { text: 'Application status:' }), document.createTextNode(action.application_status)]),
      el('div', {}, [el('span', { text: 'Application stage:' }), document.createTextNode(action.application_stage)]),
      el('div', {}, [el('span', { text: 'Contact:' }), document.createTextNode(isPending ? '—' : (action.contact_name || '(unknown)'))]),
      el('div', {}, [el('span', { text: 'Contact role:' }), document.createTextNode(isPending ? '—' : (action.contact_role || '(unknown)'))]),
      el('div', {}, [el('span', { text: 'Contact status:' }), document.createTextNode(isPending ? '—' : action.contact_status)]),
      el('div', {}, [el('span', { text: 'Channel:' }), document.createTextNode(isPending ? '—' : (action.channel || '(unknown)'))]),
      el('div', {}, [el('span', { text: 'Current action:' }), document.createTextNode(action.action || '(none)')]),
      el('div', {}, [el('span', { text: 'Due date:' }), document.createTextNode(action.due_at || '(none)')]),
    ]);
    const btnRow = el('div', { class: 'row' });
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
        state.applicationsHighlightKey = action.job_key;
        setView('applications');
      },
    }));
    btnRow.appendChild(el('button', {
      class: 'action',
      text: 'Open Outreach',
      onclick: (ev) => {
        ev.stopPropagation();
        state.outreachHighlightKey = action.job_key;
        setView('outreach');
      },
    }));
    // A synthetic APPLICATION_PENDING row has no contact for Mark Done/Skip
    // to resolve — those routes correctly refuse an 'ap-' id (there is no
    // per-contact action_id to find), so the buttons are simply not offered
    // here rather than shown and failing on click. Update Status on the
    // Applications tab is how the operator actually resolves this row.
    if (!isPending) {
      const doneBtn = el('button', {
        class: 'action primary',
        text: 'Mark Done',
        onclick: async (ev) => {
          ev.stopPropagation();
          doneBtn.disabled = true;
          try { await api('POST', '/api/followup/complete', { action_id: action.action_id }); state.followupExpanded = null; loadFollowup(); }
          catch (e) { doneBtn.disabled = false; showError(detailCell, e.message); }
        },
      });
      const skipBtn = el('button', {
        class: 'action',
        text: 'Skip',
        onclick: async (ev) => {
          ev.stopPropagation();
          skipBtn.disabled = true;
          try { await api('POST', '/api/followup/skip', { action_id: action.action_id }); state.followupExpanded = null; loadFollowup(); }
          catch (e) { skipBtn.disabled = false; showError(detailCell, e.message); }
        },
      });
      btnRow.appendChild(doneBtn);
      btnRow.appendChild(skipBtn);
    }
    detailCell.appendChild(grid);
    detailCell.appendChild(btnRow);
    const detailRow = el('tr', { class: 'fu-detail' }, detailCell);
    rows.push(detailRow);
  }
  return rows;
}

setView('followup');

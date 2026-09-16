// app.js — vanilla JS operator UI. Every button click calls a /api/* route
// that forwards straight to the existing review.mjs/outreach.mjs functions;
// no transition rule lives here. State is re-fetched from the server after
// every mutating action so the page always reflects the durable file, never
// a locally-cached guess.

const state = {
  view: 'review',
  reviewSelections: {}, // job_key -> 'APPLY' | 'INVESTIGATE' | 'PASS'
  outreachSelections: {}, // job_key -> Set(candidate_id)
  selectedBatchId: null, // Review tab's currently selected open batch
};

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
    row.appendChild(el('button', {
      class: 'action primary',
      text: 'Mark Applied',
      onclick: async () => {
        if (!confirm(`Mark ${job.company} — ${job.title} as APPLIED? This is a real, human-confirmed action.`)) return;
        try { await api('POST', '/api/ready/applied', { job_key: job.job_key }); loadReady(); }
        catch (e) { showError(card, e.message); }
      },
    }));
    card.appendChild(row);
    listEl.appendChild(card);
  }
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
}

function renderOutreachCard(job) {
  const card = el('div', { class: 'card' });
  card.appendChild(el('h3', { text: `${job.company} — ${job.title}` }));
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

// ── Follow-up (stub) ─────────────────────────────────────────────────────

async function loadFollowup() {
  const listEl = $('#followup-list');
  listEl.innerHTML = '';
  try { await api('GET', '/api/followup'); }
  catch (e) { showError(listEl, e.message); }
}

setView('review');

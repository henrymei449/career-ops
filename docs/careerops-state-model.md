# CareerOps State Model (locked, Pass 3)

Implementation contract for future clients (UI, ChatGPT, Sheets, etc.). Not a design essay — this is what Pass 3 proved and what any consumer must rely on.

## System of record

`{DATA_ROOT}/data/review-state.json`, keyed `jobs[job_key]`.

CareerOps (this repo's `.mjs` modules) owns state. Any UI, integration, or external tool is a **client/view** — it reads and triggers transitions through the existing functions below, never by writing `review-state.json` directly and never by inferring a state from the absence of a field.

`job_key` is computed by `computeJobKey()` in `review-schema.mjs`: the canonical posting-URL key when a URL exists, else a company+role(+location) dedup key. Same identity primitives the tracker/scanner already use.

## Axis 1 — Review decision

```
UNREVIEWED → REVIEWED (proposed_decision set) → finalized (final_decision set)
```

Vocabulary (`FIT_DECISIONS`, `review-schema.mjs`): `APPLY`, `INVESTIGATE`, `PASS`.

- **`proposed_decision`** — set by `applyProposedDecisions()` (`review.mjs`). Non-authoritative. A review provider (human or SOP/LLM pass) proposes it against an `open/` batch; this never touches `review-state.json`.
- **`final_decision`** — set only by `finalizeBatch()` (`review.mjs`), the *sole* place it is ever written. For each job: an explicit override (keyed by `job_key`) if given, else the reviewed `proposed_decision`. A human override wins and is recorded in `reason` as `[human override: was X]`; `proposed_decision` is preserved for audit.
- Durable `fit_decision` in `review-state.json` becomes authoritative only via `ingestFinalizedReviewBatches()` (`review.mjs`), which moves a `finalized/` batch's `final_decision` values into `state.jobs[job_key].fit_decision`. Idempotent (tracked by `batch_id` + content hash); safe to call on every session start (`doctor.mjs`'s opportunistic catch-all) or by hand (`node review.mjs ingest`). The primary trigger is `finalizeAndIngestBatch()` (`review.mjs`), which calls `finalizeBatch()` then this in the same operation — any human-facing finalizer (the operator UI, a future integration) should call it instead of `finalizeBatch()` alone, so durable state updates the moment a human finalizes, not whenever `doctor.mjs` next runs.

| Trigger | Human vs automatic | Authoritative field | Prerequisites | Idempotency |
|---|---|---|---|---|
| SOP/reviewer proposes | Automatic or human | `batch.jobs[].review.proposed_decision` (non-authoritative) | Open batch exists | Re-running overwrites the proposal; no durable-state effect either way |
| Human finalizes | Human (`finalizeBatch()`) | `batch.jobs[].review.final_decision` | Every job has a `proposed_decision` or an explicit override | Re-finalizing an already-finalized batch is not the intended path — finalize is one-shot per batch |
| Ingest into durable state | Automatic (`ingestFinalizedReviewBatches()`) | `state.jobs[job_key].fit_decision` | Batch is in `finalized/` and passes `validateBatch()` | Yes — tracked by `batch_id` + content hash; a re-run is a no-op for state, retries only the `finalized/` → `processed/` file move |

## Axis 2 — Execution status

Vocabulary (`EXECUTION_STATUSES`, `review-schema.mjs`): `NONE`, `READY_TO_APPLY`, `APPLIED`.

```
PASS / INVESTIGATE  → execution_status = NONE   (set at ingestion)
APPLY (ingested)    → execution_status = READY_TO_APPLY
human confirms send  → execution_status = APPLIED   (markApplied(), outreach.mjs)
```

- Ingestion (`ingestFinalizedReviewBatches()`) sets `execution_status: decision === 'APPLY' ? 'READY_TO_APPLY' : 'NONE'` in the same write that sets `fit_decision`.
- `markApplied(jobKey, {reviewer})` (`outreach.mjs`) is the only place `execution_status` moves to `APPLIED`. Requires `fit_decision === 'APPLY'` and `execution_status === 'READY_TO_APPLY'`. Sets `applied_at` (ISO timestamp) and initializes `job.outreach = freshOutreach()` (decision `PENDING`, status `NOT_STARTED`). Idempotent: calling it again on an already-`APPLIED` job returns `{alreadyApplied: true}` rather than throwing.

| Trigger | Human vs automatic | Authoritative field | Prerequisites | Idempotency |
|---|---|---|---|---|
| Batch ingestion | Automatic | `state.jobs[job_key].execution_status` | Finalized `APPLY`/other decision | Same ingestion idempotency as above |
| Mark applied | Human (`markApplied()`) | `state.jobs[job_key].execution_status` | `fit_decision=APPLY`, `execution_status=READY_TO_APPLY` | Yes — repeat call is a safe no-op (`alreadyApplied: true`) |

## Axis 3 — Outreach decision

Only exists after `execution_status === 'APPLIED'` (an `outreach` sub-object is created by `markApplied()`).

Vocabulary (`OUTREACH_DECISIONS`, `outreach-schema.mjs`): `PENDING`, `REQUIRED`, `OPTIONAL`, `WAIVED`.

```
PENDING → REQUIRED | OPTIONAL | WAIVED
```

- `setOutreachDecision(jobKey, decision)` (`outreach.mjs`) resolves `PENDING` into one of the three terminal decisions. `decision` cannot be set back to `PENDING`. Setting the decision also resets `outreach.status` to `DECISION_INITIAL_STATUS[decision]` (see Axis 4) — existing `candidates`/`selected_contacts` are preserved, since a decision change is not a reset of prior discovery work.
- Requires `job.outreach` to already exist (i.e. the job is `APPLIED`).

| Trigger | Human vs automatic | Authoritative field | Prerequisites | Idempotency |
|---|---|---|---|---|
| Resolve decision | Human (`setOutreachDecision()`) | `state.jobs[job_key].outreach.decision` | `outreach` record exists (job is `APPLIED`) | Re-setting the same decision re-applies the initial status for that decision — not a true no-op if status had already advanced (see Axis 4 caveat) |

## Axis 4 — Outreach status

Vocabulary (`OUTREACH_STATUSES`, `outreach-schema.mjs`): `NOT_STARTED`, `SEARCH_REQUIRED`, `CANDIDATES_FOUND`, `CONTACTS_SELECTED`, `COMPLETE`.

`DECISION_INITIAL_STATUS` (`outreach-schema.mjs`):
- `REQUIRED` → `SEARCH_REQUIRED`
- `OPTIONAL` → `NOT_STARTED`
- `WAIVED` → `COMPLETE` (terminal — no further transitions)

```
NOT_STARTED (OPTIONAL only)
  → SEARCH_REQUIRED           via startOutreach()
SEARCH_REQUIRED
  → CANDIDATES_FOUND          via discoverContacts()
CANDIDATES_FOUND
  → CONTACTS_SELECTED         via selectContacts()
```

- **`startOutreach(jobKey)`** — moves an `OPTIONAL` job from `NOT_STARTED` to `SEARCH_REQUIRED`. Never requires flipping the decision to `REQUIRED` first. Throws if `decision` is `WAIVED` or `PENDING`. Idempotent past `NOT_STARTED` (`{alreadyStarted: true}`).
- **`discoverContacts(jobKey, {searchProvider})`** — requires `outreach.status === SEARCH_REQUIRED`. Builds persona-based queries (`classifyRoleFamily`, `buildDiscoveryQueries`, capped to `MAX_QUERIES_PER_LANE = 2` per lane), runs them through the injected `searchProvider(query) -> Promise<rawResult[]>`, normalizes/dedupes/ranks results, and persists up to 3 recruiting + 3 functional candidates into `outreach.candidates`. Sets status to `CANDIDATES_FOUND`. All provider calls happen *before* the single state write — a thrown provider/network error leaves the job at `SEARCH_REQUIRED`, never `CANDIDATES_FOUND` with an empty list (failure must never silently look like "no relevant contacts exist"). Re-checks status hasn't changed between read and write (throws if it has, rather than clobbering a concurrent change).
- **`selectContacts(jobKey, candidateIds)`** — requires status `CANDIDATES_FOUND` or `CONTACTS_SELECTED` (re-selection allowed). Copies the chosen candidates (by `candidate_id`) into `outreach.selected_contacts`, sets status to `CONTACTS_SELECTED`. No minimum/exact count requirement — zero credible candidates in one lane (e.g. functional) is a valid outcome; nothing forces a selection from both lanes.

| Trigger | Human vs automatic | Authoritative field | Prerequisites | Idempotency |
|---|---|---|---|---|
| Start outreach | Human (`startOutreach()`) | `outreach.status` | `decision` is `REQUIRED` or `OPTIONAL`, status `NOT_STARTED` | Yes — repeat call past `NOT_STARTED` is a safe no-op |
| Discover contacts | Automatic once triggered (`discoverContacts()`, backed by the Serper provider as of Pass 2B) | `outreach.status`, `outreach.candidates` | status `SEARCH_REQUIRED` | Re-run overwrites `candidates` and re-sets `CANDIDATES_FOUND`; a provider failure leaves state untouched at `SEARCH_REQUIRED` |
| Select contacts | Human (`selectContacts()`) | `outreach.status`, `outreach.selected_contacts` | status `CANDIDATES_FOUND` or `CONTACTS_SELECTED`, all `candidateIds` present in `outreach.candidates` | Re-selecting overwrites `selected_contacts`; safe to repeat |

`COMPLETE`, messaging, connection-request, interview, and follow-up states are **not implemented** and out of scope for any client to invent — see backlog #4 below for where outreach quality work belongs instead, and note that `COMPLETE` exists today only as the terminal status for a `WAIVED` decision, not as a general "outreach finished" state.

## Never infer state from absence

A client must not treat a missing field (no `outreach` object, no `execution_status`) as meaning "not yet" by convention — it means the job hasn't reached that stage through the functions above. Read `review-state.json` (or call the read helpers: `getJobState()`, `isSuppressed()`, `listOutreach()`) and branch on the actual field values, not on presence/absence heuristics layered on top.

## Known backlog (not fixed in Pass 3, not to be fixed by any client of this contract)

1. ~~Finalized-batch ingestion currently occurs through `doctor.mjs`'s lifecycle~~ — **fixed**: `review.mjs`'s `finalizeAndIngestBatch()` is now the primary lifecycle step (finalize + ingest in one call), used by the operator UI and any other human-facing finalizer. `doctor.mjs` still calls `ingestFinalizedReviewBatches()` on session start, but only as an opportunistic catch-all for a batch finalized outside that primary path (e.g. by hand) or a prior run that crashed between finalize and ingest — it is no longer the thing normal workflow state progression depends on.
2. LinkedIn tracking params can create identity/dedup risk for the same requisition (URL-based `job_key` normalization does not yet strip every tracking-param variant that can alias the same posting).
3. Structured geography classification can under-classify when Remote-US evidence exists only in JD free text rather than structured location fields.
4. Functional-lane contact discovery quality (Serper-backed, Pass 2B) is imperfect and will be improved opportunistically from real failures — not a target for this contract or its clients to fix.

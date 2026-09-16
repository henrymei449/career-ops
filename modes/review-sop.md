# Review SOP — First-Pass Fit Specification

Canonical decision specification for the review-batch lifecycle
(`review.mjs` / `review-schema.mjs`). This is a **procedural** file (system
layer, like `triage.md`) — it defines HOW a fit decision is reached, not WHO
the candidate is. Candidate facts (archetypes, comp floor, geography policy,
proof points) live in `modes/_brief.md` / `modes/_profile.md` /
`config/profile.yml` per the Data Contract, and this SOP reads them rather
than restating them.

This is the same first-pass-fit logic `modes/triage.md` already runs, with
one difference: triage's output vocabulary is `PASS|MARGINAL|FAIL` ("does
this clear the bar for a full evaluation?"); a review batch's output
vocabulary is `APPLY|INVESTIGATE|PASS` ("what should the candidate do about
this job?", where `PASS` here means *pass on it*, not *passes the bar*). Do
not confuse the two — they are the same reasoning, different labels.

## Inputs

For each job record in an open review batch (`review/open/{batch_id}.json`):

- `company`, `title`, `url`, `location`, `posted_date`, `compensation`
- `jd` — the job description (inline text, a `local:jds/...` reference, or
  `none` if not captured)
- `gates.geography` — **already computed**, via `location-tier.mjs`'s
  `classifyGeography()`, the same function `scan.mjs` gates sourcing
  survivors on. `state` is one of `REMOTE_US`, `NYC_COMPATIBLE`, `REJECT`,
  `UNKNOWN`.
- The candidate baseline in `modes/_brief.md` (archetypes, comp strategy,
  location policy, hard DQ criteria, soft red flags) — read this, do not
  duplicate it here.

## Decision order (hard gates first, then judgment)

1. **Geography (hard gate).** If `gates.geography.state` is `REJECT`,
   decide `PASS` immediately — reason: the geography gate result verbatim.
   `UNKNOWN` is NOT a pass-through: treat it as an unresolved fact requiring
   `INVESTIGATE` (what's missing: confirm whether the role is remote-US or
   NYC-compatible), never as license to proceed to step 2 as if resolved.

2. **Actual role shape.** Does the JD's real day-to-day function match a
   target archetype in `_brief.md`, or one of its accepted analog titles? A
   title that *sounds* adjacent but whose JD body describes a different core
   function (e.g. "Solutions Engineer" that is actually production-grade
   software engineering) is scored on the JD, not the title.

3. **Hard technical requirements.** Any Hard DQ Criterion in `_brief.md`
   present in the JD → `PASS` immediately, regardless of how strong steps 2/4
   score. Do not average a hard DQ away.

4. **Seniority.** Does the level match (or is it a defensible stretch, ≤1
   level either direction)? A clear mismatch (entry-level posting vs. a
   senior/lead candidate, or vice versa) is a `PASS`-leaning signal, not
   automatically disqualifying on its own — combine with steps 2/5/6.

5. **Compensation.** Apply `_brief.md`'s Comp Strategy verbatim: missing/
   undisclosed comp is never itself a fail; a disclosed base clearly below
   the stated floor is. A disclosed range straddling the floor is a soft red
   flag, not a hard gate.

6. **Demonstrated fit.** Do `_brief.md`'s proof points map onto the JD's
   actual requirements with specific, checkable overlap (not just adjacent
   buzzwords)?

7. **Application EV.** Given 1–6, is applying worth the candidate's time
   relative to the archetype list — i.e., does this represent a genuine
   opportunity, not just a technically-passing box-check?

## Output

One decision per job: `APPLY`, `INVESTIGATE`, or `PASS`, plus:

- `reason` — 1–3 sentences, citing the specific gate/step that drove the
  decision (never a bare score).
- `reason_codes` — short machine-readable tags when useful (e.g.
  `geography_reject`, `hard_dq_swe_core`, `comp_below_floor`,
  `archetype_direct_hit`). Optional; `reason` is authoritative.

**`INVESTIGATE` requires a concrete unresolved fact** — name exactly what is
missing and how to resolve it (e.g. "JD does not state remote eligibility;
confirm via the ATS location field or a recruiter reply" — not "not sure").
A vague or missing reason is invalid output (`review.mjs`'s
`validateReviewedOutput()` rejects it).

## Rules (do not violate)

- **PASS hard-gate failures immediately.** Geography `REJECT` and any Hard
  DQ Criterion match end the evaluation at that step — do not keep scoring
  to produce a softer-looking justification.
- **PASS multiple substantive mismatches.** Two or more real (not marginal)
  mismatches across steps 2/4/5/6 → `PASS`, even if no single one is a hard
  gate.
- **Do not rationalize marginal fits upward.** A borderline case is
  `INVESTIGATE` with a named unresolved fact, never `APPLY` decided by
  optimism.
- **`APPLY` / `INVESTIGATE` / `PASS` only.** No other values, no numeric
  score in the decision field itself (a score may appear inside `reason`
  prose if useful, matching `_brief.md`'s existing scoring guide).

## Explicitly out of scope for this SOP

The first-pass-fit decision answers ONE question: is this worth the
candidate's next step? It does not do, and a reviewer following this SOP
must not attempt:

- Company diligence (culture, funding, reviews — that's `interview-redflag`
  / `deep` mode territory)
- Resume tailoring
- Outreach drafting
- Interview preparation

Those all happen later, and only for jobs that clear this gate.

## Provider boundary

This SOP is provider-agnostic by design (see `review.mjs`'s module
docstring for the mechanics). A human reading `node review.mjs sop
<batchId>`'s compact rendering, or an LLM given the same rendering as a
prompt, both produce the same structured output shape —
`{job_key, proposed_decision, reason, reason_codes}` — validated by
`validateReviewedOutput()` and merged via `applyProposedDecisions()`. Neither
path may ever write `final_decision`; only a human calling
`finalizeBatch()` does that.

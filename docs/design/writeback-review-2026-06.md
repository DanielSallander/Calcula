# Writeback Feature Review — 2026-06-22

**Scope:** End-to-end review of the writeback ("two-way data collection") feature
— publisher designates writeback regions in a `.calp` report; subscribers type
values that become local drafts then submit to a shared filesystem registry;
publishers approve/reject; `GATHER` formulas aggregate.

**Method:** Multi-agent code review (6 dimensions: business coverage,
correctness, security, aggregation, feedback loop, data-model/tests) with
adversarial verification of every finding against source. 38 findings confirmed,
1 refuted. Plus hands-on smoke tests + a new multi-user simulation (see
[Verification](#verification-this-session)).

> **Update 2026-06-22 (same session):** all five P0 items are **implemented** —
> **#1 (authorize approve/reject)**, **#2 (validate on the authoritative submit
> path)**, **#3 (read-side integrity: schema + deadline at GATHER time, reject
> cross-submitter writes)**, **#4 (cell-aware GATHER)**, and **#5 (close the
> feedback loop)**. See the marked rows in §6 and
> [Verification](#verification-this-session).

---

## 1. Verdict

Writeback today is a **solid one-directional drafting-and-submission pipe with a
real, working aggregation engine behind it, but it is not yet a trustworthy
two-way data-collection workflow**. A subscriber can type into a
publisher-designated region, see a draft tint, submit to a shared filesystem
registry, and have the publisher's `GATHER` formulas consolidate the result —
and the multi-version carry-forward, governance/visibility model, and per-cell
registry storage are genuinely well thought out. The current ceiling is *"a
publisher emails out a template and gets back a single number per subscriber,
which they eyeball in a dashboard."* It supports that narrow case adequately. It
supports the workflows business users actually expect — *budget templates with
line-item columns, approval chains where contributors learn they were rejected,
deadline-driven collection with reminders, completion tracking ("7 of 12
submitted")* — **poorly or not at all**, and several governance guarantees a
finance user would rely on (approval, deadlines, schema bounds, "submit once")
are advisory on the honest client and **bypassable or unauthorized** at the
trust boundary.

## 2. What works well

- **Per-cell registry model.** Submissions are stored keyed by
  `(submitter_id, region_id, row, col)` (`core/calp/src/registry.rs:330`), with
  slot-replace-on-resubmit semantics (supersedence is structural, not a caller
  concern).
- **GATHER governance / visibility is real and test-pinned.**
  `apply_gather_governance` (`app/src-tauri/src/calp_commands.rs:2750`) correctly
  implements `OwnOnly` / `OwnPlusAggregate` anonymization, drops `Empty` so
  cleared cells don't skew `AVERAGE`/`COUNT`, and gates `OnApproval` regions on
  approved state. 8 isolated unit tests; the pre-D8 "every gatherer is a
  subscriber" limitation is openly commented and fail-closed tested.
- **Publisher-sees-all via the right surface.** The publisher inbox is
  `calp_load_region_submissions` → `PublisherDashboardPane`, the unfiltered owner
  view that correctly does *not* rely on GATHER. (The one refuted finding claimed
  this was "silently broken" — it isn't.)
- **Multi-version lenient carry-forward.** Compatible submissions from prior
  package versions merge forward through a schema-compatibility gate
  (`is_compatible_with`).
- **Robust submit ordering.** `submit_region_internal` writes to the registry
  *first*, then advances local drafts (`calp_commands.rs:2428`), so a write
  failure leaves drafts resubmittable rather than silently lost.

## 3. Coverage gaps vs business expectations

- **A. ✅ FIXED — The return leg of the loop (approval feedback).** Was
  one-directional: approve/reject wrote only to the registry, the local layer
  stayed `submitted` forever, and a rejected contributor was never told. **Now
  fixed (2026-06-22):** `calp_reconcile_writeback` adopts each submitted entry's
  current registry state back into the local layer (newest across resolved +
  older versions); the store's `refreshWritebackSnapshot` and the WritebackPane
  call it; the grid paints `approved` green / `submitted` blue / `rejected` red,
  the pane shows pending/approved/rejected counts + a "rejected — re-enter and
  submit" hint, and the publisher's decision emits a `WritebackReviewed` audit
  event. See roadmap #5 and [Verification](#verification-this-session).
- **B. ✅ FIXED — Completion tracking.** The publisher can now declare
  `expected_respondents` per region; `calp_region_response_status` matches them
  against who submitted and the dashboard shows "X of N expected responded /
  waiting on: …", so "7 of 12 submitted" and deadline chasing are possible.
- **C. No notifications or reminders.** Deadlines are passive: past the deadline,
  saves error out. No countdown, no nudge.
- **D. No structured / multi-column row input.** A region is one rectangle under
  exactly one `ValueSchema`. `ListObject` mode is offered in the dialog but is
  **dead** — nothing reads `decl.mode`, so it silently behaves as
  `PerSubscriber`. The canonical tabular workflow (a subscriber fills a *row*) is
  unbuildable.
- **E. No export of collected submissions** to a sheet or CSV.
- **F. No comment / justification per value, and no rejection reason in the model
  at all.** `SubmissionState::Rejected` is a unit variant;
  `calp_set_submission_state` takes only a state string.
- **G. Per-region submit only — no "submit all / I'm done"** across a multi-region
  workbook.
- **H. ✅ FIXED (recovery path) — one-shot regions.** `RequiresUnlock` (a
  dishonest duplicate of `Never`) is removed from the dialog; and a one-shot
  (`Never`) value can be reopened by the publisher **rejecting** it
  (`registry_has_own_submission` only blocks `Submitted`/`Approved`), which the
  one-shot error message now points the contributor to. *(A dedicated
  unlock-without-reject + a deadline reopen — which needs a republish since the
  manifest is signed — remain niceties.)*

## 4. Correctness & security issues

### Critical (exploitable today, independent of the D8 authenticated-identity roadmap)

- **Any subscriber can approve/reject any submission.**
  `calp_set_submission_state` (`calp_commands.rs:2588`) is only
  MAIN-window-guarded and resolves the target registry by "which of my
  subscriptions *declares* this region" — every subscriber satisfies that. **No
  publisher-role or publisher-key check anywhere.** A participant can self-approve
  their own out-of-policy value into an `OnApproval` aggregate, or reject a
  rival's. Fix: gate on proof of publisher ownership (the Ed25519 signing key
  already used for `.calp`).

### High

- **Schema & lifecycle validation are bypassed on the real submit path.**
  `schema.validate()` + `check_lifecycle_policy()` run *only* in
  `calp_save_writeback_draft`. `submit_region_internal` (`calp_commands.rs:2397`)
  — which actually writes to the registry — writes drafts **unvalidated**. A
  scripted client or tampered `.cala` lands out-of-range/wrong-type/required-
  violating values in the registry. Fix: re-validate inside the submit path.
- **✅ FIXED — GATHER aggregated submitted values with no read-side
  re-validation.** `apply_gather_governance` now drops any submission that fails
  the region's `ValueSchema` (`schema.validate(...).is_ok()`), so a hand-written
  out-of-range/wrong-type file can never reach an aggregate. Honest submissions
  already passed this exact check at submit, so none are falsely dropped.
- **✅ FIXED (interim) — Crafted file impersonating another submitter.**
  `submit_region_internal` now refuses to write any draft whose `submitter.id` ≠
  the current installation's identity (the writeback layer is persisted in the
  `.cala`, so a crafted file could seed a victim-attributed draft). *Still open:
  a file dropped directly into the registry bypasses our code — that is the D8
  authenticated-identity boundary; the read-side schema + deadline gates are the
  defense against it.*

### Medium

- **✅ FIXED — Deadline now enforced on read/aggregate too.**
  `apply_gather_governance` drops any submission whose `submitted_at` is at/after
  an `until_deadline` cutoff, so a late or backdated file no longer counts.
  (Best-effort: a record lacking `submitted_at` is kept; still relies on the
  writer's clock for the stamp — the `datetime-local`/UTC offset bug below is a
  separate item.)
- **✅ FIXED — `datetime-local` deadline interpreted as UTC.** The Designate
  dialog now converts it to a UTC `toISOString()` instant at designation time, so
  the cutoff is the same moment on every subscriber's machine.
- **✅ FIXED — Date validation.** The `Date` arm now parses with
  `chrono::NaiveDate` across common formats (and accepts serial numbers):
  `"1/1/26"` is accepted, `"garbagexx"` rejected.
- **✅ FIXED — Text pattern is now a real regex** (`regex` crate; literal-substring
  fallback if the publisher's pattern fails to compile). `^\d{4}$` accepts `2026`
  and rejects `year 2026!`.
- **✅ FIXED — `max_length` now counts chars** (`chars().count()`), so `café` /
  `日本語語` (4 chars) are within a 4-char limit.
- **✅ FIXED — Frontend type-sniffing.** The commit guard now coerces by the
  region's declared `valueType` (threaded onto `WritebackRegionEntry`), so a
  product code `12345` in a **Text** region is sent as text.

### Low

- **✅ FIXED — `required` now rejects whitespace-only text** (not just the
  `Empty` variant).
- **✅ FIXED — Enum compatibility is now case-insensitive** (`eq_ignore_ascii_case`),
  matching `validate()`, so a cosmetic casing change on a version bump no longer
  drops carried-forward answers.
- Forward-compat `extra` flatten lets crafted files smuggle unmodeled fields
  (latent; nothing privileged reads `extra` today — left as-is).

## 5. Aggregation & feedback-loop limitations

- **(CRITICAL) ✅ FIXED — GATHER flattens away cell coordinates.** Storage was
  per-cell, but `build_gather_data` collapsed every submission into a flat
  `(submitter, value)` list, discarding `cell_row`/`cell_col`. **Now fixed
  (2026-06-22):** `GatherSubmission` carries `cell_row/col`; new
  `GATHER.AT(region, row, col)` returns all submitters' values for one input
  cell (so `SUM(GATHER.AT(...))` is a per-line-item total); and
  `GATHER.FROM`/`GATHER.COUNT`/`GATHER.SUBMITTERS` gained optional `(row, col)`
  cell-scoping forms. Coordinates are 1-based absolute (match `ROW()`/`COLUMN()`).
  See roadmap #4 and [Verification](#verification-this-session).
- **`GATHER.SUBMITTERS` unusable under `OwnPlusAggregate`** — every non-own
  submitter is the literal `"(anonymous)"` with `id=""`, so a 10-subscriber
  roster collapses to indistinguishable entries; and GATHER/GATHER.SUBMITTERS
  ordering is only incidentally aligned and not cross-machine stable.
- **2-second GATHER cache TTL creates a misleading "live" feel** — your own edits
  feel live; others' submissions lag until the TTL lapses *and* a recalc fires.
  Intentional tradeoff, but reads as a bug. Suggest a "data as of HH:MM:SS"
  indicator like the BI pivots.
- **Latent `Empty → 0.0` trap** — governance drops `Empty` first, but the dead
  `Empty → Number(0.0)` arm (`calp_commands.rs:2970`) would reintroduce phantom
  zeros if a future path skips governance.

## 6. Prioritized improvement roadmap

| # | Pri | Change | Why it matters to a business user | Effort |
|---|-----|--------|-----------------------------------|--------|
| 1 | **P0 ✅ DONE** | **Authorize approve/reject** — `calp_set_submission_state` now calls `require_publisher`, gating on possession of the Ed25519 key the signed manifest asserts as `publisher_key` (`calp::signing::profile_holds_publisher_key`); refuses otherwise | Today *any* participant can rubber-stamp their own number or veto a colleague's | M |
| 2 | **P0 ✅ DONE** | **Validate on the authoritative submit path** — `submit_region_internal` now re-runs `schema.validate()` + `check_lifecycle_policy()` over the batch against the **signed manifest's** declaration before any write (atomic: one bad value rejects the submit) | Publisher min/max/enum/required/deadline constraints are currently bypassable | M |
| 3 | **P0 ✅ DONE** | **Read-side integrity** — `apply_gather_governance` drops schema-invalid and past-deadline submissions; `submit_region_internal` refuses to write a draft attributed to another identity | Hand-written registry files defeat schema, deadline, and attribution — all independent of D8 | M |
| 4 | **P0 ✅ DONE** | **Cell-aware GATHER** — `GatherSubmission` carries `cell_row/col`; new `GATHER.AT(region,row,col)` + optional `(row,col)` forms of `GATHER.FROM`/`COUNT`/`SUBMITTERS` (1-based absolute coords). *(Region-shaped 2D `GATHER.GRID` deferred.)* | Unblocks per-line-item / per-subscriber consolidation of a budget template | L |
| 5 | **P0 ✅ DONE** | **Close the loop** — new `calp_reconcile_writeback` reads back the registry state into the local layer; cell state widened to `approved`/`rejected` with distinct grid colors; WritebackPane shows pending/approved/rejected + revise hint; `WritebackReviewed` audit event on each decision | A rejected contributor is never told; rejected cells paint the same green as accepted | M |
| 6 | **P1 ✅ DONE** | **Rejection reason** — `review_reason`/`reviewed_by` on the submission; `calp_set_submission_state` takes a `reason`; reject UI prompts for it; reconcile carries it back; shown in the pane + dashboard. *(Per-value subscriber COMMENT deferred — needs a separate comment-entry UI.)* | Binary "rejected" with no reason is operationally useless | M |
| 7 | **P1 ✅ DONE** | **"Submit all"** (`calp_submit_all_regions` + WritebackPane button) + **required-completeness gate** in `submit_region_internal` (a `required` region must have every cell filled) | Contributors submit partial regions / leave whole regions unsent, believing they're done | M |
| 8 | **P1 ✅ DONE** | **Validation correctness** — real `chrono` Date parse; `chars().count()` max length; real `regex` pattern (substring fallback); type-aware commit guard (uses declared `valueType`); `datetime-local` → UTC `toISOString()` at designation | Legitimate dates/codes/non-ASCII rejected, junk accepted; deadlines fire at wrong time | M |
| 9 | **P1 ✅ DONE** | **Hid `RequiresUnlock`** from the dialog (dishonest duplicate of `Never`); and **rejecting a one-shot value already reopens it for revision** (`registry_has_own_submission` only blocks `Submitted`/`Approved`) — the one-shot error message now tells the contributor to ask the publisher to reject it. *(A dedicated unlock-without-reject + deadline reopen — the latter needs a republish since the manifest is signed — remain a nicety.)* | Reopening a slipped budget cycle is routine; today it's irreversible without republishing | M |
| 10 | **P1 ✅ DONE** | **Completion tracking** — `expected_respondents` on the region declaration (carried in the signed manifest); Designate dialog input; new `calp_region_response_status` matches each expected name (case-insensitive, substring fallback on display name or id) against who submitted; dashboard shows "X of N expected responded / waiting on: …" | Deadline chasing / progress impossible when the roster is only who already replied | M |
| 11 | **P1 ▪ PARTIAL** | **Write-path tests** — strengthened Rust coverage (multi-user simulation + read-side governance + ownership-probe + GATHER + `compute_response_status`). *UI-driven Playwright round-trip deferred (large/flaky; needs the full app build + WebView2 CDP harness).* | The two-way path ships with no safety net | M |
| 12 | **P2 ✅ DONE** | **Export submissions** — CSV (`calp_export_region_submissions_csv`) **and Parquet** (`calp_export_region_submissions_parquet`, typed/columnar) buttons on the dashboard; **plus an opt-in auto-materialized `submissions/_rollup.parquet`** per version (publisher toggles it on the dashboard; default off; refreshed on every submit/approve/reject) so a database can just point at the registry folder | Post-collection: pivot/reconcile/archive/audit — directly into a database | S |
| 13 | **P2 ▪ PARTIAL** | **Deadline surfacing** — `deadline` flows onto the region entry; WritebackPane shows a "Due in …/Overdue" chip. *Push/reminder channel deferred (infra).* | "I didn't know it was due" is the failure reminders prevent | M |
| 14 | **P2 ▪ PARTIAL** | **Removed `ListObject`** from the Designate dialog (dead option). *Full structured multi-column regions (per-column schema, row-as-record) deferred — L architectural change.* | Real collection is tabular; `ListObject` is a dead, silently-wrong option | L |
| 15 | **P2 ✅ DONE** | **GATHER polish** — stable distinct anonymized tokens ("Submitter N") + deterministic cross-machine ordering in `apply_gather_governance`; dropped the dead `Empty → 0.0` arm in `build_gather_data`. *(Registry file-watch / "data as of" deferred — infra.)* | Roster labeling / "live" consolidation fragile during a real budgeting session | M |

---

## Verification (this session)

Run via `core/setup-rust-env.ps1` then `cargo test -p <crate>` (ARM64 MSVC env).

| Suite | Result |
|---|---|
| `cargo test -p calp` (full — incl. new date/regex/char-length/enum/required tests) | **204 passed, 0 failed** |
| `cargo test -p calp --test writeback_simulation` | 3 passed |
| `cargo test -p engine gather` (GATHER formula tests, incl. 5 cell-aware) | 13 passed |
| `cargo test -p engine` / `-p parser` (full) | 353 / 94 passed |
| `cargo test -p app --lib calp_commands::` (governance + `compute_response_status` + Parquet encoder) | **19 passed** |
| `tsc --noEmit -p tsconfig.check.json` (frontend, after all UI changes) | clean |

### P0 fixes landed this session

- **#1 Authorize approve/reject.** New `calp::signing::profile_holds_publisher_key`
  (read-only ownership probe — derives the public key from the on-disk secret, so
  a forged `publicKey` field is rejected; never creates a keypair). The app's new
  `require_publisher` helper (`calp_commands.rs`) gates `calp_set_submission_state`
  on it. Tests: `signing::profile_holds_publisher_key_*` (incl. forgery rejection)
  + `writeback_simulation::writeback_only_publisher_is_authorized_to_approve`
  (author authorized; subscriber and a different publisher refused).
- **#2 Validate on submit.** `submit_region_internal` re-validates every draft
  against the **signed manifest's** region schema + lifecycle (deadline/one-shot/
  locked) before any registry write, atomically. Draft-save validation is now
  UX-only; the enforcement boundary is the submit path.
- **#4 Cell-aware GATHER.** `engine::GatherSubmission` now carries `cell_row/col`
  (populated by `build_gather_data`); the parser/engine gained
  `GATHER.AT(region,row,col)` plus optional `(row,col)` cell-scoping forms of
  `GATHER.FROM`/`COUNT`/`SUBMITTERS` (1-based absolute coords → 0-based
  internally). Tests: 5 new `evaluator::test_gather_at_*`/`*_cell_aware` cases +
  a per-line-item consolidation assertion in `writeback_simulation.rs`
  (Q1=305, Q2=320, Q3=340, Q4=360 → 1325).
- **#5 Close the feedback loop.** New `calp_reconcile_writeback` (backend) reads
  each submitted slot's current registry state back into the local layer (newest
  across resolved + older versions; fast-path when nothing is submitted).
  `refreshWritebackSnapshot` + `WritebackPane` call it; `getWritebackCellState`
  widened to `approved`/`rejected` (matched by region+cell); the grid style
  interceptor paints submitted=blue, approved=green, rejected=red; the pane shows
  pending/approved/rejected counts + a revise hint; `calp_set_submission_state`
  emits a `WritebackReviewed` audit event (new `AuditEvent` variant + label).
  Tested by the read-back assertions in `writeback_simulation.rs` (West sees Q1
  rejected; North sees all approved).
- **#3 Read-side integrity.** `apply_gather_governance` gained two gates after
  the approval/empty filters: drop any submission failing the region's
  `ValueSchema`, and drop any whose `submitted_at` is at/after an `until_deadline`
  cutoff — so a hand-written out-of-range/late file can't reach an aggregate.
  `submit_region_internal` refuses to write a draft whose `submitter.id` ≠ the
  installation identity (the layer is persisted in the `.cala`). Tests: 2 new
  `gather_governance_tests` (`schema_drops_out_of_range_and_wrong_type_values`,
  `deadline_drops_late_submissions`) run against the real function (10 total
  pass); the simulation's governance port mirrors both gates.

### P1/P2 work landed this session

- **#6 Rejection reason.** `review_reason`/`reviewed_by` added to
  `WritebackSubmission`; `calp_set_submission_state` takes a `reason` (+ stamps the
  reviewer); the dashboard reject action prompts for it; `calp_reconcile_writeback`
  carries it back into the local layer; the WritebackPane shows the per-cell reason
  in the rejected hint and the dashboard shows it on rejected rows.
- **#7 Submit-all + completeness.** `calp_submit_all_regions` (+ a "Submit all
  N draft(s)" button); `submit_region_internal` blocks submit of a `required`
  region until every cell is filled (lists the missing cells).
- **#8 Validation correctness** (calp `writeback.rs`): `max_length` via
  `chars().count()`; `pattern` via real `regex` (literal-substring fallback on a
  bad pattern); `Date` via `chrono::NaiveDate` across common formats (+ serial
  numbers); the commit guard coerces by declared `valueType`; the Designate
  dialog converts the `datetime-local` deadline to a UTC `toISOString()`. New
  tests: `schema_max_length_counts_chars_not_bytes`, `schema_pattern_is_real_regex`,
  `schema_validates_real_dates`.
- **#12 Export CSV.** `calp_export_region_submissions_csv` (RFC-4180 escaping) +
  an "Export CSV" button (save dialog) on the publisher dashboard.
- **#9/#13/#14 + #15.** One-shot recovery surfaced (reject reopens; clearer error)
  and `RequiresUnlock`/`ListObject` removed from the dialog; deadline
  `Due in …/Overdue` chip in the pane; `apply_gather_governance` now anonymizes to
  stable distinct tokens ("Submitter N") in deterministic cross-machine order, and
  `build_gather_data` drops `Empty` instead of coercing it to `0.0`.
- **#10 Completion tracking.** `expected_respondents` on the declaration (carried
  in the signed manifest — round-trip asserted in the simulation); Designate dialog
  input; `calp_region_response_status` (pure `compute_response_status` matcher,
  unit-tested) → dashboard "X of N expected responded / waiting on: …".
- **Parquet output (post-review addition).** A single typed Arrow→Parquet encoder
  (`encode_submissions_parquet` — separate `value_number`/`value_text`/`value_bool`
  columns + `value_kind`) feeds both an on-demand per-region **Export Parquet**
  button and an **opt-in auto-materialized `{version}/submissions/_rollup.parquet`**
  rollup of all submissions, (re)written on every submit/approve/reject. The
  rollup lives under the integrity-excluded `submissions/` subtree (so it never
  trips pull) and is a non-`.json` file (so it's ignored by submission loading);
  it's best-effort (the JSON slots stay the source of truth; the next write
  self-heals it). **The author opts in per package** via a dashboard checkbox
  (`calp_set_writeback_rollup`, gated to the publisher; flag stored in the
  unsigned package manifest's `extra`, **default off**); the write paths gate on
  `rollup_enabled`. Lets a database read the whole collection by pointing at the
  registry folder. Added `parquet` (already in the lock; `arrow` was already a
  direct dep). Tests (`writeback_export_tests`, **5**): A1 refs; valid PAR1
  framing for mixed/empty; **a real materialize → Parquet read-back + integrity-
  exclusion integration test**; and the rollup toggle default-off → on.

**Deferred (with reason):** the UI-driven Playwright e2e (#11, large/flaky — needs
the full app build + WebView2 CDP harness); and four larger-infra niceties — a
per-value subscriber comment, a dedicated unlock-without-reject (+ deadline reopen,
which needs a republish since the manifest is signed), a notification/reminder
*channel* (the in-app countdown already covers "I didn't know it was due" while the
app is open), full structured multi-column regions (an L-effort region-model
redesign), and a registry file-watch / "data as of" indicator.

**New tests added (toward roadmap #11):**

- `core/calp/tests/writeback_simulation.rs` — a narrative multi-user simulation
  ("Regional Budget Collection"): the author publishes a per-subscriber
  `on_approval` numeric region; North/South/West each pull (TOFU FirstUse) and
  commit four quarterly forecasts; one corrects a cell (supersedence), one clears
  a cell (Empty); the publisher approves two and rejects one; the governed
  aggregate is asserted (count 8, `SUM(GATHER)` = 1325) including
  `own_plus_aggregate` anonymization and `own_only` fail-closed behavior; then a
  compatible v2 carries submissions forward. *Caveat: the GATHER governance is a
  hand-maintained port of `apply_gather_governance` (which lives in the app
  crate, not calp) — keep the two in lock-step; roadmap #11 should test the real
  `build_gather_data`.*
- `core/engine/src/evaluator.rs` (tests) — first unit coverage for the GATHER
  formula family (`GATHER`, `GATHER.COUNT`, `GATHER.FROM`, `GATHER.SUBMITTERS`,
  `SUM(GATHER(...))`, empty/no-fn/arity edge cases).

**Not run:** the existing `gather_governance_tests` in `calp_commands.rs` require
building the full Tauri app crate (heavy; in-Dropbox `target/` lock risk). They
are committed and known-passing. There is still **no UI-driven e2e** for the
round-trip.

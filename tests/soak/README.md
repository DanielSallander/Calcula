# Calcula Soak Testing System

Deep, oracle-driven testing that finds bugs scripted tests can't see. Instead
of asserting narrow expectations, the system performs long random action
sequences and real-user workflows, then verifies **semantic oracles** —
universal correctness properties that must hold after ANY sequence of actions:

| Oracle | Property | Bug class caught |
|---|---|---|
| `undo-round-trip` | Undoing N steps restores the exact prior workbook state; redoing restores the post-state | Missing/wrong undo registration, state corruption |
| `save-reload-round-trip` | Saving to .cala and reopening reproduces the same state | Persistence gaps (features not saved/restored) |
| `recalc-consistency` | A full recalculation changes no value | Dependency-graph bugs in incremental recalc |

State comparison uses a canonical **workbook digest** — a new Tauri command
`get_workbook_state_digest` (app/src-tauri/src/state_digest.rs) capturing
cells, styles, merges, dimensions, sheets, names, tables, slicers, charts,
sparklines, pivots, CF, validation, comments, notes, hyperlinks, filters,
outlines, protection and more, assembled directly from AppState.

## Commands

```bash
yarn soak                  # quick (~15 min): gate -> 1 walk -> triage -> report
yarn soak:overnight        # hours: gate -> scenarios -> many walks -> triage
yarn soak:overnight:fix    # same + Claude auto-fix with validated repro replay
yarn soak:replay <trace>   # replay a recorded trace (repro / fix validation)
yarn soak:corpus           # draft docs/expected-behavior.md entries via Claude
yarn e2e:scenario          # run workflow scenarios only (app auto-launched)
```

All soak flags: see the header of `soak-runner.mjs`.

## Architecture

```
tests/soak/
  soak-runner.mjs    orchestrator: gate -> launch -> scenarios -> walks ->
                     triage -> fix -> corpus -> report
  triage.mjs         Claude classifies each failure (app-bug/test-bug/flake)
                     grounded in docs/expected-behavior.md
  fix-loop.mjs       Claude fixes app code; orchestrator validates by replaying
                     the minimized repro + type-check; reverts on failure
  bug-ledger.mjs     tests/regression/bug-ledger.json (+ generated .md)
  corpus.mjs         expected-behavior.md parser/writer (managed markers)
  report.mjs         soak-summary.md + soak-report.json per run

tests/regression/lib/  shared with regression-runner: exec, app lifecycle
                       (launch/CDP/kill/restart), Claude invocation+guardrails

app/e2e/oracles/     digest client, the three oracles, cheap invariants,
                     known-issue suppression (keyed to ledger ids)
app/e2e/walker/      deterministic parameterized action catalog (~55 actions),
                     seeded generator + trace replay sources, WalkRunner
                     (trace flushed per action), ddmin shrinker
app/e2e/soak/        soak-walk.spec.ts (self-minimizing), replay-trace.spec.ts
app/e2e/scenarios/   defineScenario() DSL + workflow scenarios
                     (*.scenario.ts) with oracle checkpoints per phase
```

## The feedback loop

1. A walk fails an oracle -> the spec writes a failure bundle
   (`app/e2e/results/soak/failures/<id>/`: trace, **minimized trace** via
   delta debugging, digest diff, report).
2. Triage (read-only Claude) classifies it, citing expected-behavior entries.
   Oracle round-trip violations default to app-bug.
3. The bug is ledgered (`tests/regression/bug-ledger.md`) and deduped against
   open bugs; a `[unverified]` behavior entry may be drafted.
4. With `--fix=auto`, Claude fixes the app; the orchestrator rebuilds,
   replays the minimized repro (must pass), type-checks, and reverts
   everything on validation failure. Fixes are left uncommitted for review.
5. Unfixed real bugs get suppression entries in
   `app/e2e/oracles/knownIssues.ts` (keyed by ledger id + digest paths) so
   they don't drown out new findings.

## The behavior corpus

`docs/expected-behavior.md` holds behavior statements with stable IDs and a
verification status. The tooling adds `[unverified]` drafts; **you** flip
good ones to `[verified]` (the tooling never downgrades). Verified entries
are authoritative in triage; uncovered entries are the gap list for new
scenarios.

## Operational notes

- First overnight run should be triage-only (default) to calibrate oracle
  false positives before enabling `--fix=auto`.
- The app is proactively restarted every `--restart-every` walks (default 3)
  and after crash-class failures; traces are flushed to disk after every
  action, so even hard WebView2 crashes leave a replayable artifact.
- `yarn e2e:invariant` still runs the legacy 75-action monkey tests — now
  with oracle checkpoints every 25 actions.
- Quarantined/sampled functional specs are unchanged
  (`yarn regression:auto`); registry-driven coverage expansion is now OFF by
  default (superseded by corpus-driven scenarios).

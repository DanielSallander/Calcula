# Calcula E2E Test Plan

Playwright E2E suite for the Calcula spreadsheet application. Tests run against
the live Tauri app via WebView2 CDP (Chrome DevTools Protocol) — there is no
headless mode and no mock backend; every assertion is against the shipping
binary.

**Current status (re-verified against the tree 2026-08-16):** 94 spec files under
`e2e/tests` (93 in the `functional` project — `state-consistency.spec.ts` is
excluded there and owns the `invariant` project), 2 visual specs (18 tests), 30
journey specs, 3 scenario files (24 tests), 6 soak specs, 72 committed screenshot
baselines (42 functional / 27 visual / 3 scenario).

**All suites are green on HEAD:** functional **551 passed / 0 failed / 4
skipped** · journey **151 / 0 / 1** · scenario **24/24** · visual **18/18 across
three cold runs** · vitest **~107,155 tests / 808 files**.
The 2026-08-08 figure of "495 passed / 34 failed / 11 skipped" that this document
carried is SUPERSEDED — see "The suite reached green (historical record)" below
for what the 34 actually were, because the diagnosis is the reusable part.

**The instrumentation this suite runs on is documented below and is not
optional.** A green number from this suite means something only because four
guards make it mean something: the collection guard (did the run collect the
tests it claims?), the startup barrier (was the app even mounted?), the undo
evidence gate (did the oracle decide anything?), and the golden-corpus census
(were the baselines all recorded on one capture path?). Each exists because its
absence produced a green run that was worth nothing.

---

## Read this first

Most of this document is about the ways a green E2E run can mean nothing. That
is where the value is. The suite has, at various points, shipped:

- a visual comparator so loose that **an entirely erased gridline scored zero
  differing pixels**;
- two screenshot helpers that **returned silently** when their selector matched
  nothing, so every call had been a no-op for months against an empty baseline
  directory;
- a pair of goldens named `...-collapsed` and `...-expanded` that were
  **byte-identical** — the pair asserted that collapsing and expanding a group
  produce the same picture;
- feature goldens photographing a 66-pixel indicator inside a 685,000-pixel
  frame, under a 200-pixel budget.

None of those failed. All of them passed, for years in one case. The rules
below each exist because one of them was found.

---

## Project split

`app/playwright.config.ts` defines six projects. The split is not organisational
tidiness — it is the only thing keeping specs that disturb the whole document
away from specs that share one.

| Project | Dir | What it is |
|---|---|---|
| `functional` | `e2e/tests` | The bulk. One long-lived app, ONE accumulating workbook shared by all 93 specs. `yarn e2e`. `testIgnore` excludes `state-consistency.spec.ts` (it deep-resets the workbook and then applies up to 75 random mutating actions, with ~20 specs running after it alphabetically). |
| `visual` | `e2e/visual` | Whole-frame regression goldens (`core-visual` 12 tests, `workflow-visual` 6). 18 tests, 27 baselines. |
| `journey` | `e2e/journeys` | Specs that deliberately wipe or reopen the document — `new_file`, `open_file`, a frontend reload, a real window close. **30 specs, 151 tests.** 300 s timeout. |
| `scenario` | `e2e/scenarios` | Real-user workflows with oracle checkpoints per phase (`*.scenario.ts`). 3 files, 24 tests, registered through `scenarios/lib/scenario.ts`. |
| `invariant` | `e2e/tests/state-consistency.spec.ts` | Oracle checkpoints: digest + undo/redo round-trip + recalc + periodic save/reload. 300 s timeout. |
| `soak` | `e2e/soak` | Long random action walks with semantic oracles and in-spec trace minimization. 6 specs. Driven by `SOAK_*` env vars. |

**Why `journey` had to exist.** The functional specs share one workbook, so every
screenshot baseline in `e2e/tests/__screenshots__/` encodes the residue of the
specs that ran before it. A spec that replaces the document therefore shifts
unrelated goldens, and a spec that closes the window ends the run. Keeping those
in their own project makes them explicit to invoke and harmless to `yarn e2e`.
The project has grown from 6 specs to 30; it is now where most of the 2026-08
correctness programme's live proofs live (`undo-across-open`,
`document-store-leak`, `formula-roundtrip`, `structural-recalc`, `open-guard`,
`consent-refusal`, `reload-integrity`, `spill-delete`, `orphaned-sheet-state`,
`floating-range`, `macro-model-recording`, …).

**`resetGrid` is stronger than this document used to say, and the reason it had
to become stronger is the sharpest lesson in the file.** It clears the USED range
unioned with an `A1:Z1000` floor, contents AND formatting, via
`clear_range_with_options` (`e2e/helpers/screenshots.ts:291-357`). It passed
`applyTo: "All"` for its whole life — and Rust's `ClearApplyTo` carries
`#[serde(rename_all = "camelCase")]`, so the wire vocabulary is lower-case
`all`. serde answered `unknown variant \`All\``, the invoke rejected, and the
`catch` swallowed it. **The formatting clear this helper documents at length
NEVER RAN** (measured live 2026-08-15 against the running backend): the reset was
Ctrl+A + Delete and nothing else, so every fill, border and number format any
spec applied survived into every later spec's golden — and four `afterAll`
cleanups written specifically to close that residue class were inert for the same
reason. `e2e/__tests__/clearApplyToVocabulary.test.ts` now reads the Rust enum and
fails the build on a capitalised variant. **A capitalised serde variant is a
silent no-op inside a `catch`; that shape is worth grepping for.**

### Running

```bash
cd app
yarn e2e                  # functional (auto-launches the app, tears it down)
yarn e2e:visual           # visual goldens
yarn e2e:journey          # document-replacing journeys
yarn e2e:scenario         # workflow scenarios
yarn e2e:invariant        # oracle checkpoints
yarn e2e:all              # every project
yarn e2e:manual           # connect to an already-running app (E2E_MANUAL=1)
yarn e2e:visual:update    # re-record visual goldens
yarn e2e:report           # HTML report from the last run
```

`yarn e2e:journey:manual`, `e2e:invariant:manual`, `e2e:scenario:manual`,
`e2e:soak:manual` and `e2e:manual:all` are the `E2E_MANUAL=1` variants of the
same projects.

`E2E_MANUAL=1` skips `global-setup`'s `cargo tauri dev` launch and connects to
whatever is on CDP 9222 (`e2e/global-setup.ts:103`). It is the right mode when
you are controlling the app's lifecycle yourself — which, per the operational
rules below, you usually should be.

**If you override `--reporter`, you must re-add the collection guard by hand:**

```bash
npx playwright test --project=journey --reporter=./e2e/collectionGuard.ts,dot,json
```

A CLI `--reporter=` flag REPLACES the config's reporter list, and
`--reporter=dot,json` is exactly how this programme drives the suites (the `list`
reporter rewrites its lines in place, so a redirected log cannot be audited).
`assertCollectionGuardPresent` is called from global-setup with the RESOLVED
config, so a run that lost the guard **refuses to start** and prints this line.
`COLLECTION_GUARD=off` skips it, loudly. See the next section.

---

## The guards that make a green number mean something

Six of them, all added after 2026-08-08 and therefore absent from every earlier
version of this document. Each replaced a specific way a passing run lied — or,
for the last two, a specific way a FAILING run lied about how many things were
wrong.

### 1. `collectionGuard.ts` — did the run collect the tests it claims?

**It is the FIRST reporter in `playwright.config.ts` and must stay in every
reporter list** (`playwright.config.ts:39-51`).

*Why.* A `--project=journey` pass on 2026-08-13 printed "Running 134 tests" while
`--list` said 143 for the same filter, then reported a clean `133 passed /
1 skipped`. **The nine missing tests included the four the run existed to prove.**

*The mechanism, reproduced 2026-08-14.* A spec file that is EMPTY at collection
time is collected as a zero-test file — no error, no mention of the file, exit 0.
Truncating a 3-test spec turned `Total: 152 tests in 30 files` into `Total: 149
tests in 29 files` deterministically, and a writer churning the file with
truncate-then-write saves made **5 of 15** collection passes drop it silently.
That is precisely what an editor, an agent save, or a sync tool produces
mid-write.

*What it does* (`e2e/collectionGuard.ts`):

| Arm | Check |
|---|---|
| Collection comparison | `onBegin` records the run's own collected identities; `onEnd` spawns `--list --reporter=json` for the same filter args and requires the two MULTISETS to be equal. Any `missing` or `phantom` fails the run, grouped by file. |
| Zero-byte floor | Every file matched by a ran project's `testMatch` is stat'd; a 0-byte match fails unconditionally. This catches the PERSISTENT form, which the comparison would wave through because both sides agree on the truncated population. |
| Zero-test files | Every matched file must contribute >= 1 listed test, from an UNFILTERED per-project listing (so a `--grep` run still verifies whole-file presence). Declined for `scenario`, which registers through `lib/scenario.ts` — per-file coverage is genuinely undecidable there and claiming otherwise was a permanent false alarm. |
| Startup arm | Reads the `APP-NEVER-MOUNTED.txt` marker FIRST, ahead of `COLLECTION_GUARD=off` and ahead of the `collected === null` early return, and fails the run with the startup banner. |
| Fail-closed | If the `--list` spawn fails or its output will not parse, the run FAILS. A guard that cannot run is not a guard that passed. |

**Two traps for anyone editing it.** (a) The file component of a test identity is
the FILE-SUITE's title, not `spec.file`: they disagree for a project that
registers through a shared lib, and using `spec.file` made the guard fail every
scenario run as "24 missing + 24 phantom" on identical test sets. (b) Escape
hatches are loud and enumerated — `--shard`, `--repeat-each`, `--last-failed`,
`--only-changed`, `--ui`, `--debug` skip the comparison with a printed notice;
nothing is ever skipped silently.

### 2. `startupBarrier.ts` / `startupGuard.ts` — was the app ever mounted?

*Why.* Measured three times on 2026-08-15: the app was running, CDP was
answering, the page had LOADED from Vite (`frameUrl http://localhost:5173/`,
full index.html DOM, `<title>app</title>`) — and `<div id="root">` had no
children, because `/src/main.tsx` was fetched and never evaluated. Every spec
then failed identically on `waitForSelector("[data-focus-container=
'spreadsheet']")` after 60 s:

```
--project=soak       12 failed / 1 skipped
--project=invariant  the run died at startup
--project=visual     18 failed of 18   <- i.e. "the entire golden corpus"
```

The report held eighteen TimeoutErrors, eighteen blank white screenshots, and
nothing at all saying the application never mounted. **An instrument that lies in
the direction of "your code is broken" is the failure mode this programme has
paid for most often.** The barrier runs in `global-setup`, so a dead launch
reports **ZERO tests** instead of N product failures — there is no number to
misread — and a `--reporter` flag cannot reach it, because it is not a reporter.

*The bound is a QUIET WINDOW, not a mount deadline* (`startupGuard.ts:342-380`).
One cold mount was measured at ~55 s, and turning a single sample into a hard
limit is how a guard becomes a flake generator on a colder machine. So: anything
moves (a resource completes, a navigation, `readyState`, a child under `#root`)
-> keep waiting, however long. **WHICH quiet window applies is decided by
`document.readyState`, and that split is measured, not reasoned:** a cold start
with `app/node_modules/.vite` deleted sat SILENT for **218 seconds** — two
resources at 12 s, the next at 231 s — blocked on one `/src/main.tsx` request
while Vite re-optimised. A stall window over network activity alone would have
failed that healthy launch at 57 s. Throughout the silence `readyState` was
`"interactive"`; in the BUG-0082 state it was `"complete"` with the resource
count frozen and `#root` empty for ten more minutes.

Bounds (`mountBounds`, all env-overridable):

| Bound | Default | Role |
|---|---|---|
| `E2E_MOUNT_STALL_MS` | 45 s | THE DETECTOR. Applies only while `readyState === "complete"`. |
| `E2E_MOUNT_SERVER_SILENT_MS` | 300 s | THE PATIENT ARM, only while the document is still LOADING (~1.4x the worst silence ever seen). |
| `E2E_MOUNT_CAP_MS` | 900 s | Anti-hang backstop. Exceeding it is a NAMED failure, never a retry. |

*Nine named verdicts*, not four — `cdp-unreachable`, `no-page`, `wrong-origin`,
`never-mounted-stalled` (BUG-0082's exact signature), `dev-server-not-answering`,
`never-mounted-cap`, `no-tauri-bridge` (the documented signature of a run
launched without `src-tauri/tauri.e2e.conf.json`), `boot-error` (React rendered
the root error boundary — `#root` is non-empty, so NOT BUG-0082, reported once
with the caught error), and `duplicate-deps` (the page holds two Reacts because
Vite served an incoherent module graph; named separately because the remedy is a
command, not a debugging session).

**It will not retry and will not raise a ceiling on one sample.** A retry deletes
the evidence the next occurrence needs. The MID-RUN half — the app that mounts,
goes away, and comes back empty — is detected by `fixtures.ts` on its own
`waitForSelector` timeout, written to the marker, and turned into the run's
verdict by the collection guard. One reporter, one handshake, one status
override; a guard that needs its own reporting channel is a guard that can be
dropped separately. `startupBarrierWired.test.ts` pins that global-setup still
calls the barrier and still clears the marker.

### 3. The undo round-trip oracle, and its evidence gate

**A run that decides ZERO undo round-trips now FAILS** with `undo-evidence-missing`
(`e2e/oracles/index.ts:263`, raised in `walker/walkRunner.ts:697`).

*Why.* The oracle reports three verdicts — `decided` (the history was wound back
and compared: evidence), `nothing-to-undo` (trivially green), and `undecided`
(the checkpoint is outside the history the stack still holds: **nothing was
tested**). The last two were indistinguishable from the first in every report the
harness had ever produced. A sheet-weighted walk ends the undo history in nearly
every window, so `[OK] Walk passed` covered an oracle that ran zero comparisons.

*The rebase, and the census that corrected the register.* The question "can the
baseline still be wound back to?" was only ever asked AT a checkpoint, i.e. once
every 25 actions — by which time a single action anywhere in the window had
already decided it for all 25. Over the shipped catalog (40 seeds x 75 actions at
cadence 25, the `invariant` project's own shape) only **6 of 120 windows**
contained no history-ender at all. The register attributed that to the five
structural sheet commands; the census says otherwise — of **370 window-killers,
276 (75%) were `fr.create` / `fr.delete` / `fr.rename`**, which landed on
2026-08-13, AFTER the observation the register recorded. Sheet structure was the
minority cause.

Asked after EVERY action (`undoBaselineUnreachableReason`), the answer is
actionable: the walker re-captures the baseline the moment the old one dies.
**The verdict is not relaxed to get there** — the digest compared is the one
captured at the rebase point, and the ids on the stack above it are exactly the
transactions wound back. Result: **from 5 of 28 checkpoints decided to 27 of 30,
546 transactions wound back.**

*The rebase creates one blind spot, and it is closed on purpose.* Once the walker
re-baselines on every unreachable reading it stops caring WHY the history ended —
so a cell edit that clears the undo stack would be silently absorbed and never
reported. `ACTIONS_THAT_MAY_END_UNDO_HISTORY` is the allow-list that asks the
question the rebase no longer has to: `sheet.add|delete|rename|move|copy` (not
undoable in Excel), `fr.rename` / `fr.delete` (an FR's backing store IS a sheet),
`fr.create` (ends nothing, pushes nothing — the object simply survives every
undo) and `undo` itself. `sheet.hide` / `sheet.unhide` / `sheet.tabColor` are
deliberately ABSENT: BUG-0050 made them ordinary undoable transactions, so one of
them ending the history would be a regression, and this list is what reports it.

`requireUndoEvidence: false` exists for trace replays ONLY, where the trace is
whatever the shrinker handed over and may be a single `sheet.add`. Setting it
anywhere a GENERATED walk runs re-creates the exact silence it exists to break.

### 4. `goldenCorpus.ts` — is the corpus still ONE corpus?

`captureEnvironment.ts` states the display every committed golden assumes
(`devicePixelRatio: 2`, sRGB colour profile) and asserts it once per run against
the live app. That guard is correct and stays. **It has one blind spot, and the
blind spot is the thing it was written to prevent: it compares the RUN to a
constant, and nothing compared the CORPUS to that constant.**

Measured 2026-08-11 by decoding all 71 goldens then committed: 44 held the dpr-2
hairline and **27 — the whole `e2e/visual` tree, every one re-recorded that
afternoon — held the dpr-1 hairline.** This machine runs at 200% (GDI
DESKTOPHORZRES 2944 / HORZRES 1472 = 2), so dpr 2 is the truth and the visual
corpus had been re-recorded against an environment that does not exist here. No
test could say so, **because no test had ever looked at a golden.**

*How a golden's capture path is read off its own bytes.* `drawGridLines` is the
only stroke in the renderer at `lineWidth = 1 / deviceScale` — a true one-device-
pixel hairline. A `toHaveScreenshot` capture is taken at CSS scale, so it resolves
to a different flat constant on each side:

```
dpr 1  ->  the hairline fills one CSS pixel        ->  226,226,226
dpr 2  ->  it covers about half of one over white  ->  241,241,241
```

It repeats ~39,400 times in a full-grid capture, so it is the loudest signal in
the image and it is exact — flat fills, not antialiasing noise. Counting the two
constants recovers the dpr a file was recorded at, from the file alone, years
later, with no run involved. A dominance margin of 4x keeps a handful of chrome
pixels from outvoting 39,000 gridline pixels, and files with fewer than 50
hairline pixels (status-bar strips, ribbon bands) are reported as OUTSIDE the
population rather than guessed at. Colour profile is classified the same way off
saturated chrome. `STALE_PRODUCT_STATE_GOLDENS` is the named quarantine and is
**currently EMPTY**.

**A bulk re-record is the single highest-risk operation in a visual suite: it
accepts whatever the app rendered that day as the new truth.** The only thing
that makes it safe is being able to say afterwards WHICH capture path each golden
came from.

### 5. `wedgeGuard.ts` — is the backend still ANSWERING?

*Why.* Guard 2 asks whether the app ever mounted, **once per run** — `assertAppMounted`
has exactly two call sites, both in `global-setup.ts` (`:128`, `:288`). It had no
mid-run counterpart, and on 2026-08-16 that cost a journey run **64 consecutive
tests over 5.4 hours**, every one on timeout. The first failing spec has zero
locators (`grep` over its 839 lines finds none) — every step goes through
`page.evaluate`, either `__TAURI__.core.invoke` or an app module pulled in via
`__calcImport` — so nothing in the DOM explains it: the backend stopped returning.
What DID re-run on each of the 64 worker rebuilds is the worker-scoped `sharedPage`
fixture — `connectWithRetry` plus a 60 s `waitForSelector` on the spreadsheet
container (`fixtures.ts:244`, `:316`) — and it passed all 64 times, because
"CDP connected + a DOM node is visible" stays true of a wedged backend. See
open-items §2.5 and BUG-0098; the mechanism is still unreproduced.

*What it does* (`e2e/wedgeGuard.ts`, called from the `appPage` fixture):

| Aspect | Behaviour |
|---|---|
| The probe | One real `get_cell` invoke, before every test that takes `appPage`/`grid` — all of them except the 7 `gridPersistent` tests in `tests/workflow-dashboard.spec.ts`. The failure is BEHIND the IPC boundary, so every DOM-level signal stays green — only a question the backend must ANSWER can distinguish "busy" from "wedged". |
| Biased to fail OPEN | A refusal counts as answering, and so does a thrown `evaluate` (`:85`, `:91`). This guard answers exactly one question — is the backend ANSWERING — and leaves a dead page to `appDiedMarker`. Worth stating because `get_cell` being mapped to "ok" on rejection means a MISNAMED command would produce a guard that can never fire; it is registered at `lib.rs:4822` with the signature the probe uses. |
| Double race | `page.evaluate` **has no timeout in Playwright's API** (`actionTimeout` governs locators only). An inner race bounds the invoke — separating a wedged *backend* from a wedged *renderer*, which have different owners — and an outer race in Node bounds the evaluate itself, since a wedged renderer would never run the inner one. |
| Two consecutive | One slow answer is not a wedge. A guard that latches on a single probe reds whole runs over machine noise, which is worse than the disease it treats. |
| The counter is ON DISK | **The subtlest part, and the obvious implementation is silently broken.** Playwright rebuilds the worker after every FAILED test, and a rebuilt worker re-imports the module with fresh state. On a wedged app every test fails, so a module-level `let` resets between every pair of probes: the count never reaches two, nothing ever latches, and the guard degrades into a log line while the run still costs 5.4 hours. The latch marker was already a file; the pre-latch count has to be one too (`.wedge-probe-count`, cleared by `global-setup`). An in-process unit test cannot see this — `wedgeGuard.test.ts` re-imports the module between probes to reproduce the restart, and that test is the one the in-memory version fails. |
| Fails, never skips | Per §3bx: a skipped test reports coverage it does not have. Every test after the latch fails immediately with the reason — 5.4 hours becomes minutes. |
| Attribution | Latching writes `results/APP-WEDGED.txt`; `global-teardown` prints a banner stating the later failures are **one fact**, not N defects. `global-teardown` also archives `app-dev.log` per run, because the product truncates it on every app start and four later runs had already destroyed the only evidence of the original event. |
| Escape hatch | `E2E_WEDGE_GUARD=off`, which announces itself on stderr rather than going quiet. Budgets: `E2E_WEDGE_BACKEND_MS` (5 s), `E2E_WEDGE_PROBE_MS` (15 s). |

**A healthy suite can never exercise this guard**, so its decision logic is pinned
by `e2e/__tests__/wedgeGuard.test.ts` against a fake page — eight tests covering
the healthy path, the single-slow-probe path, the latch, the short-circuit, the
off switch, and the three cross-restart properties. Sabotage-checked twice, both
numbers **measured by running them**: latching on the first bad probe reds **5 of
the 8**, and moving the counter back into module memory reds **exactly the restart
test**, which is the only one that re-imports the module between probes.

That test file sets `E2E_WEDGE_STATE_DIR` to a temp directory before importing
the guard. Without it the test writes the REAL marker, which would latch a
concurrently running E2E suite and fail every remaining test in it — a unit test
able to red a live run.

### 6. `zz-persisted-residue.spec.ts` + `volatilePersistedState.ts` — is the app still configured the way the run found it?

*Why.* The functional project's `zz-workbook-residue.spec.ts` had no journey
counterpart. On 2026-08-16 `shapes-hometab.spec.ts` test 8 customised the Home-tab
ribbon, the app wedged mid-test, and its `finally` — which is correctly written —
could not do its work, because `restoreDefaultHomeLayout` needs a **living app**
to reload. The residue survived into the next project, which failed
`ribbon-core-default-ribbon.png` with `deleteColumn` clipped out of the Cells
group: the visual project reporting a red golden for something no visual spec did.

*The structural lesson.* **Cleanup-on-exit cannot be relied on when the failure
mode is "the app died"** — the cases that leave residue are exactly the cases with
no app left to clean up with. Making the teardown more robust cannot fix that. So
the reset runs on the way **IN**, immediately after `assertAppMounted`, the one
moment the app is known-healthy. Both belong: the `finally` keeps a passing run
tidy, the run-start sweep keeps a *crashed* one from spreading.

*Two things it gets right that are easy to get wrong:*

- **It sweeps by PREFIX, not by list** (`calcula.`, `calcula-`, `calcula:`, `ext.`
  — three separators because the convention drifted, and a sweep that knew only
  `calcula.` would miss `calcula-panel-placements`). The `ext.<extensionId>.<key>`
  family cannot be enumerated even in principle.
- **It asks "is the value DEFAULT", not "is the key present".** The guard's first
  draft asserted absence and failed on a clean app: `calcula-task-pane` and
  `calcula-panel-placements` are `zustand/persist` stores that write themselves on
  hydration. A check that reds a clean run is one somebody switches off. For the
  same reason the run-start sweep reports a *leak* only when a cleared value was
  non-default — it clears something on essentially every run, and an alarm that
  always fires is one nobody reads.

**The reload is not optional.** Removing a key is not enough: the owning stores
are alive in the page and write back on change or shutdown. Clearing
`calcula.homeTab.layout` on a running app left the ribbon customised **and** the
key re-saved from memory.

One catalogue in `volatilePersistedState.ts` serves both the sweep and the guard,
each entry citing the default it checks against. They were briefly two lists and
had already disagreed about what `calcula-task-pane` does.

---

## The visual comparator

**ONE definition, in `e2e/helpers/screenshotGates.ts`** — which also records how
the numbers were measured. `playwright.config.ts` imports it as
`expect.toHaveScreenshot`, and `e2e/helpers/screenshots.ts` spreads it as
`DEFAULT_SCREENSHOT_OPTIONS`. Nothing else may declare these numbers.

*(Superseded 2026-08: this document previously said the two consumers "must stay
in sync". They did each carry their own copy, kept in sync by a comment in each
pointing at the other — which is not a mechanism: nothing failed if they drifted,
and the two are NOT interchangeable. The config value governs every
`toHaveScreenshot()` written directly in a spec, i.e. exactly the assertions that
do NOT go through the helper; the helper value governs everything that does. A
drift would have silently loosened one half of the suite while the other stayed
tight, and a reviewer reading either file would have seen the right number.)*

```
maxDiffPixels:      200
maxDiffPixelRatio:  0.0005      # effective budget = min(200, 0.05% of image)
threshold:          0.02
```

**`threshold` is not a per-channel tolerance.** It is pixelmatch's YIQ
colour-distance gate: a pixel is counted as different only when its squared YIQ
distance exceeds `35215 * threshold²`. That makes it the single setting deciding
whether the suite can see the grid at all.

Measured on the default skin (re-measure if the skin changes):

| | |
|---|---|
| Gridline colour | `#f1f1f1` on white — ΔY 14 |
| Faintest hairline | `#f5f5f5` — ΔY 10 |
| pixelmatch stops seeing them above | threshold **0.053** / **0.038** |
| Erased gridline at the old threshold 0.2 | **0 differing pixels** |
| Same defect at 0.02 | 520 px (vertical) / 1193 px (horizontal) / 1042 px (1 px shift) |

So at 0.2 **no grid-geometry change could ever fail**, and a 40 px row-gutter
change passed the entire suite. 0.02 keeps roughly 2x margin on the faintest
line the renderer paints.

**The budget is the other half of the gate, and tightening only the threshold
would not have been enough.** The old `maxDiffPixelRatio: 0.005` allowed 3,425
pixels on a grid capture — six whole gridlines' worth. 200 sits at the geometric
mean of the measured noise ceiling and the smallest single-line defect (520 px).

**The noise floor is what makes the tightening cheap.** Over two cold runs of
all 76 captures the suite takes, **74 were bit-identical at threshold 0**. The
only non-deterministic thing in either suite was the marching-ants copy border in
the paste-special shots, at 77 px. There is no anti-aliasing tax to pay for
here; the old looseness bought nothing.

**That 77 px is now history, and the numbers deliberately did not move.**
`waitForGridStable` puts the app in reduced motion before every capture, so the
dash phase is parked at 0 and that source of noise is gone (2026-08-09).
Tightening `maxDiffPixels` to suit would be re-deriving a MEASURED constant from
an argument: the 77 px was the noise CEILING across 76 captures, and nobody has
re-run those 76 cold to find the new one. If someone does, update
`screenshotGates.ts` — with the new measurement written down, the way that one
is.

**Do not loosen these to make a shot pass.** A shot that cannot hold this gate
is capturing something non-deterministic. Fix the capture — `waitForVisualStability`
exists for transient overlays (the pivot progress indicator is drawn canvas
state with no DOM node to await), and `parkSelectionAwayFrom` exists for
selection chrome.

**Region captures have no separate gate, on purpose.** A
`REGION_SCREENSHOT_OPTIONS` override of `maxDiffPixelRatio: 0.001` was written
when the default was 0.005 (5x tighter, earned its place); against the new
0.0005 default the same override would LOOSEN small clips by 2x — precisely the
captures it existed to sharpen. It was removed rather than re-tuned. The
ratio-plus-cap default already scales: on a whole-grid shot the 200 px cap
binds; on a one-cell clip the ratio binds at 4 px.

---

## How a golden loses its teeth

Three distinct mechanisms, all found live, all of which produce a passing test
that proves nothing. Check for each one before adding a feature golden.

### 1. Scale — the feature is too small to blow the budget

A whole-grid shot is 1232x556 = **685k pixels**, where `maxDiffPixels: 200`
binds. A note-indicator triangle is **66 device pixels** — under a third of the
budget, in the best case where the triangle is the only thing that moved. Its
presence or absence *cannot* fail the assertion at any threshold.

**Fix: `takeGridRegionScreenshot`,** which clips to the cells that own the
chrome. Clipped to one cell the same triangle is 0.82% of the frame against a
4 px budget — a ~16x margin instead of a 0.3x one. Keep `padding` small (default
4 px); padding is dead pixels that dilute the assertion again. Use
`includeHeaders: true` for chrome that paints in the header margin — the
grouping outline bar is drawn at `x < rowHeaderWidth`, so a cell-only clip
frames everything EXCEPT the feature under test.

Rule of thumb: **whole-grid shots prove layout and data; they do not prove
chrome.**

### 2. The feature was never RENDERED

`grouping.spec.ts` had four goldens. Two of them —
`grouping-rows-collapsed.png` and `grouping-rows-expanded.png` — were
byte-identical (sha256 `1c8a474d…`).

The cause was not framing. Those tests drove the Rust commands (`group_rows`,
`collapse_row_group`) **directly via `invoke`**, and a backend-only outline
change has no effect on what is drawn: only the Grouping extension's store
pushes hidden rows/cols into grid state and sizes the outline bar. Measured
against the running app, `group_rows` changed **0 of 42k captured pixels**.

This is the general trap for any spec that reaches past the frontend: a Tauri
command that mutates backend state does not, by itself, tell the frontend
anything. The four goldens were deleted rather than re-recorded.

**What changed since.** The mutation IPC wrappers now announce
(`OUTLINE_CHANGED`, `HYPERLINKS_CHANGED`, `VALIDATIONS_CHANGED`,
`ANNOTATIONS_CHANGED`), so an out-of-band mutator can dispatch
`window.dispatchEvent(new CustomEvent("app:outline-changed"))` — or, better,
drive the seam the extension publishes:

```ts
const gs = await window.__calcImport(
  new URL("/src/api/groupingService.ts", document.baseURI).href);
await gs.requireGroupingController().groupRows(0, 2);
```

which resolves only once the grid, the outline bar and the backend agree, so no
arbitrary wait is needed.

**Corollary: some features correctly paint nothing.** `add_hyperlink` changes
zero pixels of its cell and always did — the blue-underlined look is cell
formatting the dialog applies separately. Its live oracle is the rendered
CURSOR (`pointer` over the linked cell, `cell` over its neighbour). A pixel
assertion there would fail forever against correct code. Establish what the
feature actually paints before writing a golden for it.

### 3. Selection chrome paints over the thing under test

The active-cell highlight covers the cell's top-right corner — exactly where
Review paints its annotation triangles. Probed live on an isolated cell carrying
a note:

```
note cell NOT selected -> 15 indicator px
note cell SELECTED     ->  0 indicator px
```

Every region spec reaches its capture via `navigateTo(topLeftCell)`, which
SELECTS that cell — so every single-cell feature golden was a picture of the
selection border with the feature erased underneath it. That is how goldens
named `...-cell-with-indicator` came to hold one stray pixel of indicator
colour.

`takeGridRegionScreenshot` now parks the selection six rows below the range
before framing (`parkSelectionAwayFrom`); `keepSelection: true` opts out, and is
only correct when the golden's subject genuinely IS the selection rectangle.
Parking happens BEFORE framing, because parking dispatches a navigate that can
scroll.

The renderer side is fixed too: `registerCellDecoration` carries a z-anchor, and
`"over-selection"` decorations (indicator chrome) are replayed after
`drawSelection`. `"under-selection"` (the default) is cell CONTENT — data bars,
sparklines, checkboxes — where the selection tint reading over it is correct.

**One more decoding trap, because it wasted a triage.** Counting exact source
constants is not a valid test for "no indicator". `#FF0000` / `#7B68EE` are the
literals in `Review/rendering/triangleRenderer.ts`, but the renderer paints
through the skin/theme, so the literal constant never appears in a frame — a
frame that plainly shows an indicator will report zero. Count near-matches, or
diff against the same frame with the decoration unregistered (which is what
`gridRenderer/cellDecorationZOrder.test.ts` does).

### What a capture actually captures

`takeGridScreenshot` targets `[data-grid-area]`, the CONTAINER, not
`page.locator("canvas")`. The grid is drawn on a single canvas — verified: the
main window has exactly one `<canvas>` node, so extension chrome really does
land on those pixels and there is nothing to stitch. But DOM layers sit ON TOP
of the canvas inside `[data-grid-area]`, and an element capture of the canvas
drops them: the InlineEditor is a real `<input>`, so every "editing mode" golden
used to be a picture of the grid WITHOUT the editor the shot exists to show.
Also the scrollbars and the corner box.

---

## Assertions that silently pass

**The rule: a helper that cannot fail must be deleted, not left as decoration.**
A helper that silently succeeds is worse than no test — the suite reports
coverage it does not have.

Every capture helper in `e2e/helpers/screenshots.ts` now resolves its target
through `resolveOne`, which throws with the full candidate list and what each
selector matched. What it replaced:

- `takeStatusBarScreenshot` **returned silently** when its selector matched
  nothing, which it always did (`StatusBar.tsx` rendered a bare inline-styled
  `<div>` with neither testid nor class). Every call had been a no-op since May
  and the golden directory was empty. The component now carries
  `data-testid="status-bar"`.
- `takeRibbonScreenshot` **fell back to a fixed 1280x180 page clip**, which
  fired unconditionally (all three of its selectors matched zero nodes) and was
  17 px taller than menu bar + tab strip + band — so every ribbon golden also
  framed part of the formula bar and churned on unrelated cell edits. The
  fallback is gone; primary target is `[data-testid='ribbon']`.
- `takeRegionScreenshot` accepted a clip that was empty or outside the viewport,
  photographing nothing and passing against a baseline recorded from the same
  nothing. It now validates against the live viewport.
- `takeGridRegionScreenshot` fails with the computed rect, canvas size, scroll
  and zoom when a range cannot be framed after scrolling, rather than producing
  a golden of blank grid.
- `takeCheckpoint` with a `target` locator matching 0 nodes used to time out
  with a generic message; it now names what it was asked to photograph.

Two further shapes to watch for when reading an existing spec:

- **Goldens byte-identical across the state change they are named for** — the
  grouping pair above. If two goldens in a spec are supposed to differ, hash
  them.
- **`softly()` does not suppress a missing baseline the way people assume.** It
  swallows only `"snapshot doesn't exist"`. A new visual test still needs a
  committed baseline before it asserts anything.

---

## Operational rules

These are not style preferences. Each was measured.

1. **Restart the app COLD before any run you intend to report.** Kill `app.exe`
   and `cargo.exe`, confirm ports 9222 and 5173 are clear, relaunch via
   `tauri dev`, wait for CDP. The macro debugger specs measured **10 failures
   against a long-lived instance versus 60/60 cold**. `editing.spec.ts` fails
   3/3 in a full ordered run and passes 12/12 cold in isolation.
2. **Never edit `app/src-tauri` while a run is in flight.** The `tauri dev`
   watcher rebuilds and restarts the binary mid-run; the failures that produces
   are indistinguishable from real ones.
3. **The E2E app is OFF the Vite hot-reload channel — and that is newer than it
   sounds.** `vite.config.ts` disables HMR when `CALCULA_E2E` is set, which only
   the two E2E launchers set, so interactive development keeps HMR;
   `e2e/__tests__/hmrDisabledForE2E.test.ts` pins launcher + config + flag
   together, because if a launcher stops setting it, nothing else would say so.
   Measured 2026-08-15 on an isolated app while another agent saved
   `app/src/core/lib/events.ts`: Vite pushed `hmr update` for ~170 modules,
   React fast-refresh remounted the provider tree, GridProvider's `useReducer`
   restarted from `getInitialState()` — selection snapped from W7 back to A1 and
   `scrollX` from 286 to 0, about 2.5 s after the harness had deliberately parked
   them. **There was NO navigation:** `performance.timeOrigin` was unchanged and a
   `window` marker installed before the update survived it, so nothing in the
   page and nothing in Playwright could tell that the app had been reset
   underneath the test. A capture taken across that window is a photograph of the
   editor, not of the product, and is indistinguishable from a product change.
   Cutting the channel made the same state hold still for 10 s and the same
   capture come back byte-identical 8 times out of 8.
   For INTERACTIVE work the old rule still holds: an HMR update to an extension
   file does NOT re-run extension activation, an already-registered menu action
   keeps its OLD closure, so force a full page reload after touching
   `app/extensions/**` before trusting a live check.
4. **Goldens are valid only for the exact ordered cold pass that recorded
   them.** Because the functional workbook accumulates and `resetGrid` clears
   only `A1:Z1000`, a golden recorded from a different order or a warm instance
   encodes different residue.
5. **Re-record one golden at a time from a real ordered pass, not with
   `--update-snapshots`.** `--update-snapshots` rewrites every sibling in the
   run, which silently launders regressions into baselines. Triage each diff
   first: an unattributable diff is a possible regression, and one triage this
   session turned up three goldens that did not need re-recording at all and one
   whose entire diff was dated chrome (the 2026-07-30 ribbon SVG icons, the
   2026-07-20 point-size/row-height geometry, the top-level Model menu, the
   Filters→Controls tab rename) with every cell value identical.
6. **The first test after a cold launch can time out.** Documented, order-
   dependent flake in the 30 s fixture timeout. Re-run before believing a
   first-test failure.
7. **A recapture checked only by the run that wrote it is not checked.** In
   COMPARISON mode `toHaveScreenshot` RETRIES until the image settles, so an
   unsettled frame is invisible there; `--update-snapshots` takes **ONE** frame
   and writes it (`e2e/helpers/screenshots.ts:927-928`). So a golden written by an
   update run has been validated by nothing at all. **Two cold COMPARISON runs
   must agree** before a re-recorded baseline is believed.
8. **Never force-kill `msedgewebview2` wholesale.** Those processes also belong to
   Windows SearchHost, and Calcula itself RENDERS in WebView2 — doing it has
   destroyed a journey run. Use `app/scripts/kill-stale-dev.mjs` (wired as
   `predev`), which kills only processes that are LISTENING on the Vite port or
   are executables inside THIS repo's `src-tauri/target`; an unrelated `app.exe`
   elsewhere on the machine is never touched. It deliberately uses plain
   `netstat -ano` and **not** `netstat -p TCP`: on Windows that filters to IPv4
   only, and Vite binds "localhost" which resolves to `::1` here, so the listener
   that actually blocks a restart shows up as `[::1]:5173` under TCPv6 and a
   `-p TCP` scan never sees it. `CALCULA_SKIP_KILL=1` disables it.
9c. **A THIRD launcher existed, and it was recording goldens through the
   display.** `webview2Args.mjs` names two launch paths and says the drift
   between them "cost the whole golden corpus its meaning twice over" — but
   `e2e/launch-with-cdp.ps1`, the one the manual instructions point at, carried
   its own stale copy setting `--remote-debugging-port` and NOTHING ELSE. Found
   2026-08-18, while about to re-record two baselines through it. Anything
   recorded that way captures through the DISPLAY's colour profile (a hard-coded
   `#217346` lands as rgb(63,112,75), not rgb(33,115,70)) and with an
   ACCELERATED 2D canvas, which decides whether DOM overlay text rasterizes LCD
   or grayscale — ~2,900 differing pixels against a 200-pixel budget, with
   nothing about the product changed. The launcher now sets only the PORT and
   hands off to `e2e/launch-app.mjs`, which imports the shared definition and
   PRINTS the arguments the WebView actually gets; read that line before
   recording. `e2e/__tests__/webview2ArgsSingleSource.test.ts` now fails any file
   under `app/` that spells `--remote-debugging-port=` in code rather than
   calling `webview2BrowserArguments()`, so a fourth launcher cannot drift the
   same way. It also sets the BUILD environment (MSVC via
   `core/setup-rust-env.ps1`, and an out-of-repo `CARGO_TARGET_DIR` when unset),
   because until now which binary a manual run exercised was a function of
   ambient shell state.

9b. **The teardown now PROVES its kill, and the run-start check lives in
   global-setup.** `global-teardown` used to fire one `taskkill /F /T /PID` with
   `stdio: "ignore"` inside a bare `catch {}` and print "[e2e] Tauri stopped."
   unconditionally — refused and clean looked identical. And the recorded pid is
   the `cmd.exe` wrapper, while `taskkill /T` walks LIVE parent links, so once
   yarn/cargo have exited the surviving `app.exe` is unreachable from it.
   `e2e/processResidue.ts` records the app's own pid, kills what this run
   recorded, and polls until the pids are dead and 9222/5173 are free.
   **The inherited-residue report is in `global-setup`, not the teardown**,
   because the teardown returns before its kill under `E2E_MANUAL=1` — which is
   how 11 of the `e2e:*` scripts are driven, so a check there would never run on
   the paths that leak. It REPORTS and never kills anything it did not start: a
   second agent builds from the same `CARGO_TARGET_DIR`, and killing one of those
   is a measured past defect. **It never names `msedgewebview2`** (a source
   assertion pins that), because those processes belong to Windows SearchHost as
   well. Note `scripts/kill-stale-dev.mjs` matches only the IN-REPO
   `src-tauri/target`, so it cannot see an app built into the out-of-repo
   `CARGO_TARGET_DIR` this project mandates.

9. **An isolated second instance needs its OWN `WEBVIEW2_USER_DATA_FOLDER`.**
   Without it WebView2 joins the other instance's browser process and **IGNORES
   the CDP port and the capture pins** — you get a second window driven by the
   first app's flags and no error anywhere. A properly isolated launch (see
   `e2e/results/launch-pin-9223.ps1`) takes a COPY of the built `app.exe` so
   another session's `tauri dev` rebuild cannot restart the binary under the run,
   its own user-data folder, a fake `src-tauri` marker directory as cwd so the
   shared `context_manager/log.log` is not truncated underneath it, and the same
   deterministic capture flags every other launch path uses
   (`--force-color-profile=sRGB --disable-accelerated-2d-canvas`).
   **The log half of that is obsolete as of 2026-08-17:** `init_log_file` now
   ROTATES rather than truncates (`logging.rs`, `rotate_previous_session`), so a
   second instance can no longer destroy a running one's log and the fake marker
   directory is no longer needed for that reason. The `WEBVIEW2_USER_DATA_FOLDER`
   and exe-copy parts of this rule still stand.
10. **Know which binary you are testing.** `global-setup` constructs the MSVC
    environment and says nothing about `CARGO_TARGET_DIR`, which it does not set;
    there is no `.cargo/config.toml` and no persistent machine value, so it is
    whatever the invoking shell exports — two terminals build and run two
    DIFFERENT binaries. Measured 2026-08-16: the in-repo tree failed to link
    `app_lib.dll` with ~40 `LNK2001 unresolved external symbol
    anon.<hash>.llvm.<id>` errors out of `libcalp` while the SAME SOURCE linked
    cleanly in the out-of-repo target, so the first launch of the day read as
    "E2E is broken" rather than "this shell points at a corrupted artifact tree".
    `e2e/buildTarget.ts` makes the answer part of the run's own output.
11. **A native dialog hangs the run and is invisible to everything the harness
    looks at.** It is a separate top-level `#32770` window: no DOM, absent from
    page screenshots, and invisible to the `ui-not-blocked` invariant's
    `elementFromPoint` hit-test. The WebView's JavaScript keeps running, so the
    page looks perfectly healthy — `page.evaluate` returns, the canvas paints,
    nothing throws. What it blocks is **Tauri IPC**: every `invoke` after it opens
    simply never settles. Measured 2026-08-12 (BUG-0039): a soak walk stopped
    printing at `[shrink] replay 22`; fifteen minutes later the app still answered
    `page.evaluate`, the screenshot showed an ordinary spreadsheet, and
    `list-app-windows.ps1` reported **twelve** stacked `#32770` windows reading
    `Failed to rename sheet: Sheet index 2 out of range`. The shrinker replays a
    trace dozens of times and nothing ever answered. Use
    `e2e/helpers/nativeDialogs.ts`.
12. **A single action may not hang.** Playwright's default `actionTimeout` is
    `0` — i.e. NO timeout: `locator.click()` waits for actionability forever and
    the only bound is the test timeout. Measured 2026-08-11: an `invariant` walk
    stopped at `[step 47/75] ribbon.switch-tab` and printed nothing for twelve
    minutes on a live, RESPONDING app (the action probes
    `isVisible({timeout: 500})` then calls a bare `.click()`, so a button that is
    visible but never actionable parks there) — and `state-consistency.spec.ts`
    raises its own ceiling with `test.setTimeout(1_500_000)`, so the hang had
    **25 minutes** to run in, silently. `playwright.config.ts` now sets
    `actionTimeout: 30_000`, well above the slowest legitimate action in these
    suites, which turns an INFINITE action into a reported failure that names the
    locator.
13. **Prove a negative assertion by reinstating the defect.** A sabotage that is a
    NO-OP passes, and that has happened here: one boot-marker test's sabotage ran
    after `@vitejs/plugin-react` had already transformed the module, so it changed
    nothing and the test went green. Watch the assertion go red before believing
    it.

---

## Driving the native file dialog from outside

Tauri defines its IPC surface with `Object.defineProperty(..., { value })` —
`writable: false, configurable: false` — so the file picker **cannot be stubbed
from the page**. That wall stopped `dirty-flag-close.spec.ts` and would have
stopped any test of Insert > Image, which is part of why an ingress with no
validation of any kind shipped and stayed.

The technique that defeats it: answer the dialog from OUTSIDE the app, as a user
would. `journeys/image-ingress.spec.ts` writes its own PowerShell helper which:

1. `EnumWindows` for a visible window whose class is **`#32770`** (the Win32
   common-dialog class) owned by an `app.exe` process;
2. `SetForegroundWindow`, then `EnumChildWindows` for the visible `Edit` child —
   the file-name box;
3. `SendMessageW(edit, WM_SETTEXT /*0x000C*/, 0, path)`;
4. `PostMessageW(dialog, WM_COMMAND /*0x0111*/, IDOK /*1*/, 0)`.
   `IDCANCEL` is `2`, and the helper takes a `-Cancel` switch.

It prints `NODIALOG` when no dialog is open, so the spec can poll rather than
sleep.

**Run a CANCEL case first.** `image-ingress` does, so that every later outcome
is attributable to the file CHOSEN rather than to the menu click having done
anything at all.

The same spec shows the two probes that give a binary-ingress test teeth, both
asserted in both directions: "did the document gain a control?" via
`get_control_metadata` at the anchor, and "did the document gain the BYTES?" via
`resolve_media_ref("media:" + sha256(fixture))` — content-addressed, so it asks
about THAT file and no other. Persisted state is read out of the saved `.cala`
ARCHIVE by a dependency-free ZIP reader inside the spec, not from a value the
app reports about itself.

**Show refusal assertions have teeth by reinstating the defect.** Disabling
`checkShapeSetProperty`'s `src` rule makes test 6 fail with `ACCEPTED`; making
`pickValidatedImage` return a placeholder instead of `null` reproduces the
shipped defect's exact signature (a `200x150` control at the anchor). A refusal
test that could only ever pass is worthless. Build in an attributability guard
too: the byte-cap case first inserts a twin PNG built identically but under the
cap and requires it to be ACCEPTED, so "refused" cannot mean "the whole path is
broken".

---

## The soak and invariant walkers

The `soak` and `invariant` projects generate random action walks and judge them
with semantic oracles rather than goldens. Three mechanisms in that machinery are
worth knowing before you touch it.

**Suppression lists expire with the bugs that justify them.**
`EXCLUDED_UNTIL_FIXED` (`e2e/walker/actionCatalog.ts:2105`) withholds actions from
the generator while a ledgered bug makes them unusable. It is **currently EMPTY**,
and so is `KNOWN_ISSUES` (`e2e/oracles/knownIssues.ts`) and
`STALE_PRODUCT_STATE_GOLDENS`. `e2e/__tests__/walkerExclusions.test.ts` FAILS when
an exclusion names a bug that is not `open` in `tests/regression/bug-ledger.json`,
and separately when it names a bug id that is not in the ledger at all — **because
an exclusion once outlived its bug and went on blinding the walker to a surface
that, once re-enabled, immediately yielded seven bugs.** A third test keeps
excluded actions present in `FULL_ACTION_CATALOG` even while suppressed, so a
recorded repro trace citing one still resolves.

**A suppression is almost never scoped to its defect.** `filterKnownIssues`
suppresses a violation when EVERY digest-diff path is covered by a prefix — so the
prefix `pivots.` swallowed the entire pivot subtree, every field of every pivot
definition, for every cause; and two `colWidths.` prefixes swallowed ALL
column-width divergence on the first two sheets, from any cause. Both were removed
rather than renewed, and re-examining them found live successors the blanket had
been hiding (four pivot commands mutating `pivot_tables` with no undo entry at
all). Two of those are deliberately NOT re-suppressed: a walk that reaches them
should fail loudly and name them.

**The shrinker's `stillFails` was a boolean and the boolean lied.** It was
initialised `true` and only ever assigned by the final confirmation replay — which
is skipped when the replay cap or the time budget is exhausted, i.e. the NORMAL
exit. `undo-evidence-missing` is also deliberately NOT minimized
(`walker/failureBundle.ts:297`): it is a property of the WHOLE WALK, not of any
subset of actions, so ddmin over it burns replays to answer the wrong question.

---

## The suite reached green (historical record)

**Superseded 2026-08-16.** The functional suite is now **551 / 0 / 4**, journey
**151 / 0 / 1**, scenario **24/24**, visual **18/18 over three cold runs**. The
open decision this section used to carry ("drive the functional suite to green,
or formally designate a maintained subset") is CLOSED in favour of green.

The rest of this section is kept because the DIAGNOSIS is reusable and the
headline number was misleading in a specific, repeatable way.

**Functional, full ordered cold pass, 2026-08-08: 495 passed / 34 failed / 11
skipped.** Basic editing and scrolling specs were among the failures. Every
"64/64"-style figure quoted during feature work is a SUBSET — the specs relevant
to the change under test — not whole-suite health. That remains true.

The failures cluster in `worker-extension*` (5), `scrolling` (4), `dimensions`
(4), `editing` (3), `status-bar` (3), `state-consistency` (2), `paste-special`
(2), `protection` (2), `evaluate-formula` (2), plus nine singletons.

**Most of that count is CASCADE, proved rather than assumed:**

- `editing.spec.ts` fails 3/3 in the full run and **passes 12/12 (5 skipped)
  cold in isolation**. Its three failures read `"This column should be wider"` —
  a `dimensions.spec.ts` fixture string — where they expect `"Hello"` / `"123"` /
  `"EditMe"`. Not editing defects; the preceding spec's residue.
- The `dimensions` goldens fail on **a chart painting an error** into the shared
  workbook: `Chart data error — Cannot read properties of undefined (reading
  'title')`, ~11.5k differing pixels. That error frame is itself left by an
  earlier spec — and a chart that renders its own exception is a real symptom
  worth an owner independent of the golden.

So the headline count materially overstated the number of distinct defects.
**The prediction held.** Fixing the few genuine roots collapsed the tail, which is
why the count went to zero without 34 goldens being re-recorded:

- the chart title error is FIXED at its boundary —
  `app/extensions/Charts/lib/chartSpecNormalize.ts` COMPLETES a `ChartSpec` that
  arrived from outside the type system (`chartStore.fromEntry` does
  `JSON.parse(...) as ChartDefinition`, an unchecked cast over a blob that may
  have come from an older build, an `.xlsx` import, a `.calp`, or a sandboxed
  script). It is a REPAIR, not a schema: it fills absent structure only and never
  rewrites a value the spec carries, so a round-trip cannot change a chart that
  was already complete. Completing beats rejecting — dropping the chart loses the
  user's object and its placement over a field with a perfectly good default, and
  refusing to render reads as "the chart disappeared";
- the `dimensions` residue root was `resetGrid`'s silently-rejected
  `applyTo: "All"` (see "Why `journey` had to exist" above), which meant NO
  formatting was ever cleared between specs;
- `macro-live-edit` test 6 now passes in the ordered functional run.

Per-cluster evidence is in `docs/design/open-decisions-2026-08.md` §3a/§3b.

---

## Known limitations

- **Canvas interaction.** The grid is a `<canvas>`, so cells cannot be targeted
  by DOM selector. `GridHelper` computes pixel coordinates — but it reads live
  geometry from `__CALCULA_GRID_STATE__` every time, not from constants.
  Hardcoding geometry was a 32-failure cascade once: `new_file` handed out a
  24x100 grid while launch was 20x64.29, so any spec that created a new file
  re-scaled the grid for the rest of the run and `clickCell("B2")` clicked
  somewhere else entirely. The fallback constants in `helpers/grid.ts` apply
  only when the app has not booted, so a helper call fails as an assertion
  rather than a `TypeError`.
- **`clickCell` selection drift.** It leaves flaky ambient selection in
  screenshots; use `navigateTo` before a capture.
- **Locale.** The app uses the system locale. On sv-SE the decimal separator is
  `,` and the argument separator is `;`, and `keyboard.type()` converts commas
  to dots. Use `setCellValueDirect()` for formulas, or type semicolons.
- **`resetGrid` clears the used range (floor `A1:Z1000`), contents + formatting
  only.** It does not reset sheets, dimensions, charts, controls or the outline.
  Specs that need a true clean slate belong in `journey`. Corrected 2026-08-16:
  this document previously said "only `A1:Z1000`", and for most of the helper's
  life the formatting half did not run at all — see "Why `journey` had to exist".
- **`resetToNewWorkbook` must dispatch three events after `new_file`.** The
  backend also resets default geometry, and the frontend caches it: without
  `dimensions:refresh` + `app:sheet-changed` + `grid:refresh`, a golden captured
  afterwards encodes ghost 100px/24px lines and a phantom "Sheet2" tab — states
  the app can never actually be in. (The product itself does a full page reload
  on File > New.)
- **The sampler runs tests in isolation**, so specs must be self-contained and
  must not rely on prior-test grid state.

---

## Coverage

The per-test tables this document used to carry are gone; they described 186
tests across 23 phases and were three months stale against 540. **Spec files are
the inventory — this table is a map, not a manifest, and the collection guard is
what actually proves nothing went missing.** Grouped by area (functional
project):

| Area | Specs |
|---|---|
| Grid core | `editing`, `formula`, `navigation`, `scrolling`, `mouse-interactions`, `keyboard-workflows`, `grid-rendering`, `dimensions`, `zoom-view`, `freeze-panes`, `edge-cases`, `stress-tests` |
| Formatting | `formatting`, `number-formatting`, `alignment`, `conditional-formatting`, `merge`, `column-row-ops`, `hidden-rows-persistence` |
| Data | `clipboard`, `paste-special`, `fill-handle`, `find-replace`, `sort-filter`, `data-validation`, `go-to-special`, `named-ranges`, `tables`, `grouping` |
| Formulas | `advanced-formulas`, `formula-autocomplete`, `formula-tracing`, `evaluate-formula`, `udf-evaluation` |
| Objects | `charts`, `pivot`, `comments-notes`, `hyperlinks`, `cell-types`, `cell-behaviors`, `button-onclick` |
| Files & state | `file-operations`, `encryption`, `print`, `protection`, `sheets`, `undo-redo`, `state-consistency` |
| Scripting | `scriptable-objects`, `scriptable-shapes`, `undoable-macros`, `macro-*` (6), `table-namedrange-script`, `sandbox-mark-blit`, `worker-realm-*`, `worker-extension*` |
| Security | `consent-flow`, `extension-consent`, `chart-library-consent`, `capability-fetch`, `capability-storage` |
| VBA parity | `vba-idioms-wave1..4`, `vba-wiring-batch` |
| MCP / AI | `mcp-*` (5), `ai-chat-tools` |
| Shell / UI | `ribbon-tabs`, `menu-interactions`, `panel-placement`, `status-bar`, `appearance-skins`, `animation` |
| Workflows | `realistic-workflows`, `workflow-dashboard`, `workflow-gradebook`, `workflow-invoice`, `regression-scenarios`, `flagged-defects` |

**Journeys (30 specs, 151 tests)** — the project has become where the 2026-08
correctness programme's live proofs live, so the list is grouped by what each one
proves rather than left as prose:

| Group | Specs |
|---|---|
| Document lifecycle | `dirty-flag`, `dirty-flag-close`, `open-guard`, `reload-integrity`, `document-store-leak`, `undo-across-open`, `orphaned-sheet-state` |
| Undo / recalc correctness | `undo-enablement`, `structural-recalc`, `pivot-undo-fidelity`, `sheet-tab-state-undo`, `computed-property-restore`, `cascade-announcement-live`, `spill-delete`, `calc-progress-deadlock` |
| Formula + parity | `formula-roundtrip`, `owner-decisions`, `parity-21c`, `live-parity-proofs`, `remaining-correctness`, `correctness-cluster`, `census-followon` |
| Objects / persistence | `floating-range`, `sparkline-persistence`, `shapes-hometab`, `report-store`, `subscription-restore` |
| Security / ingress | `image-ingress` (Insert > Image through the real native dialog), `consent-refusal` |
| Scripting | `macro-model-recording` |

**Soak (6 specs)**: `soak-walk`, `replay-trace`, `shrinker-selftest`,
`walker-action-effects`, `synthetic-click-drag`, `native-dialog-hang`.

**Unit tier for the harness itself (`e2e/__tests__`, 29 files, run under
vitest).** The instrumentation has its own tests, and that is deliberate: a guard
nothing checks is one edit from being decorative. `collectionGuard.test.ts`,
`startupGuard.test.ts`, `startupBarrierWired.test.ts`, `goldenCorpus.test.ts`,
`captureEnvironment.test.ts`, `walkerExclusions.test.ts`,
`undoOracleDecidability.test.ts`, `oracleCadenceReachable.test.ts`,
`oracleCoverage.test.ts`, `hmrDisabledForE2E.test.ts`,
`clearApplyToVocabulary.test.ts`, `bugLedger.test.ts`, `shrinkSkip.test.ts`,
`e2eIsTypeChecked.test.ts` and others.

---

## Bugs Found by E2E Tests

| Date | Bug | Found By | Status |
|------|-----|----------|--------|
| 2026-05-20 | Formula "=" prefix stripped — formula bar shows "A1+B1" instead of "=A1+B1" | `formula.spec.ts` (10 tests) | FIXED — 43 call sites in 15 Rust files |
| 2026-05-20 | Formatting not persisting — ribbon toggles UI but `applyFormatting` sends stale/empty selection | `formatting.spec.ts` | FIXED — `getGridStateSnapshot()` + `lastSelectionRef` |
| 2026-05-20 | Off-screen cells not clickable — `cellCenter()` ignored scroll offset | `formatting.spec.ts` | FIXED — scroll-aware clicking via `__CALCULA_GRID_STATE__` |
| 2026-05-20 | Increase/decrease decimal read format codes; backend returns descriptive names ("Number (1 decimals)") | `number-formatting.spec.ts` | FIXED |
| 2026-05-20 | VLOOKUP returns #NA for valid data — `extract_2d_rows()` returns a flat array for multi-column ranges | `advanced-formulas.spec.ts` | **FIXED** (verified 2026-08-16) — `advanced-formulas.spec.ts:40` asserts `=VLOOKUP(2;G10:H12;2;FALSE)` -> `"Bob"` and passes in the green functional run; the scan path now views tables through the borrowing `table_row_views` (`core/engine/src/evaluator.rs:13572`) and 2-D rects go through the PERF-03 lookup cache |
| 2026-08-07 | Grouping goldens byte-identical across collapse/expand — backend-only mutation never reached the frontend | `grouping.spec.ts` goldens | FIXED (events) — goldens deleted, **re-record still pending as of 2026-08-16**: `e2e/tests/__screenshots__/` has no `grouping.spec.ts/` directory and the spec asserts no screenshots |
| 2026-08-07 | `group_rows` / `add_hyperlink` / backend validations and notes changed 0 pixels until something else forced a refresh | live pixel probe | FIXED — `OUTLINE_CHANGED` / `HYPERLINKS_CHANGED` / `VALIDATIONS_CHANGED` emitted from the IPC wrapper |
| 2026-08-07 | Selecting a commented cell erased its own note indicator (15 px → 0 px) | live probe, then `cellDecorationZOrder.test.ts` | FIXED — `registerCellDecoration` z-anchor |
| 2026-08-07 | Insert > Image was an uncapped, unvalidated binary ingress that travelled into signed `.calp` artifacts | `journeys/image-ingress.spec.ts` (first E2E the feature ever had) | FIXED — `read_media_file` + `inspect_media`, content-addressed `media/{sha256}` |
| 2026-08-07 | `named_ranges.rs:129` multiply overflow **ABORTED the whole application** (`STATUS_STACK_BUFFER_OVERRUN`) on a 7+ letter name like `ABCDEFGHIJKLMNOP1` — a `#[tauri::command]` on a thread that cannot unwind | `--project=journey` run | FIXED — ceiling enforced inside the loop; 2 regression tests |
| 2026-08-07 | `macro-live-edit` test 6: whitespace/EOL normalisation between the Monaco buffer and `save_script` makes an untouched macro report phantom unsaved work | `macro-live-edit.spec.ts` | **FIXED** (verified 2026-08-16) — the spec is unskipped (`macro-live-edit.spec.ts:1191`) and passes in the 551/0/4 functional run; comparison goes through `normalizeSource` (`:410`) |
| 2026-08-07 | Charts paint their own exception into the shared workbook (`Cannot read properties of undefined (reading 'title')`), ~11.5k px | `dimensions.spec.ts` goldens | **FIXED** — `extensions/Charts/lib/chartSpecNormalize.ts` completes a spec that arrived from outside the type system before any painter reads `spec.yAxis.title`; `validateChartSpec` still warns, so a malformed spec is not hidden, merely no longer able to take the paint path down with it |
| 2026-08-13 | A journey run collected **134 of 143** tests and reported a clean pass; the nine missing included the four the run existed to prove. Root cause reproduced: a spec file EMPTY at collection time is collected as a zero-test file with no error and exit 0 | `--project=journey` pass, then a deliberate truncation experiment | FIXED — `e2e/collectionGuard.ts` as first reporter + the `assertCollectionGuardPresent` handshake in global-setup |
| 2026-08-15 | The frontend never mounted (`#root` empty, `/src/main.tsx` fetched and never evaluated) and the harness reported it as **18 of 18 visual failures** — the entire golden corpus — with 18 blank screenshots and nothing naming the real cause | three measured launches (BUG-0082) | FIXED — `startupBarrier.ts` in global-setup reports ZERO tests instead; mid-run half detected by `fixtures.ts` and turned into a verdict by the collection guard |
| 2026-08-15 | `resetGrid` passed `applyTo: "All"`; serde answered `unknown variant \`All\`` and the `catch` swallowed it, so the formatting clear NEVER ran and four `afterAll` cleanups were inert | live probe against the running backend | FIXED — lower-case `all`, pinned by `e2e/__tests__/clearApplyToVocabulary.test.ts` reading the Rust enum |
| 2026-08-11 | **27 of 71 committed goldens had been recorded at dpr 1** on a machine that runs at dpr 2 — the whole `e2e/visual` tree, re-recorded in one afternoon. No test could say so because no test had ever looked at a golden | `goldenCorpus.ts` census | FIXED — per-file provenance census (dpr, colour profile, product state) with a named, currently-empty quarantine |

---

## Adding New Tests

1. Decide the project first. Does the spec wipe, reopen, reload or close the
   document? Then it is a `journey`, not a functional spec.
2. Create the `.spec.ts` under the right dir and
   `import { test, expect } from "../fixtures";`.
3. Make it self-contained. Do not rely on grid state left by an earlier spec —
   the sampler runs tests in isolation and the full suite runs them in an order
   you do not control.
4. Use `grid` for canvas interaction; use `setCellValueDirect()` for formulas
   and locale-sensitive content.
5. **Drive the product, not the backend.** An `invoke("group_rows")` mutates
   Rust and tells the frontend nothing — see "The feature was never RENDERED".
   Prefer the `@api` seam the extension publishes; if you must invoke directly,
   dispatch the corresponding announce event and say so in a comment.
6. For a golden that must prove a specific piece of chrome rendered, use
   `takeGridRegionScreenshot` clipped to the owning cells — never a whole-grid
   shot.
7. Before trusting a new refusal/negative assertion, **reinstate the defect and
   watch it go red.** An assertion never observed failing is decoration — and a
   sabotage that is a NO-OP passes, so check that your sabotage actually took.
8. Record the baseline from an ordered cold pass, and **confirm it with a second
   cold COMPARISON run** (`--update-snapshots` writes one unvalidated frame; see
   operational rule 7). Add the spec to the coverage table above.
9. **A file that matches `testMatch` must contribute at least one test.** An empty
   or tests-stripped spec is collected silently; the collection guard now fails
   the run on it. Helpers belong in `*.ts`, unit tests in `*.test.ts` — not in a
   `*.spec.ts` that happens to define nothing.
10. **If you drive the run with `--reporter=`, re-add the collection guard**
    (`--reporter=./e2e/collectionGuard.ts,dot,json`) or global-setup will refuse
    to start. It carries the startup arm too, so dropping it drops both guards.

# Open items — the live list

**This is the authoritative list of what is currently open.** Verified against the code on
**2026-08-16**; every row cites the file and line that was actually opened and read. If a claim
here disagrees with a design document, this file wins — and if it disagrees with the code, the
code wins and this file is the defect.

**Where the history is.** `docs/design/open-decisions-2026-08.md` (1.33 MB, 39 sections) is the
narrative record of the correctness programme: what was decided, why, what was tried and rejected.
Its reasoning is its value and none of it has been moved or deleted. But it is a sequence of
**point-in-time observations**, and its own §35a measured the consequence: greping it for
"still open" returns a list roughly **one third stale in the already-fixed direction**, because a
pass that fixes a defect writes its own section and does not go back and strike the three earlier
paragraphs that called it open. Read it for the WHY. Read this file for the WHAT.

**Scope of this list.** Product and test-infrastructure items only. Individual defects with a
reproduction live in `tests/regression/bug-ledger.json` (**98 entries, 94 fixed, 4 open** as of
2026-08-17: BUG-0095, BUG-0096, BUG-0097 — filed 2026-08-16 by the documentation audit, all severity
low — plus BUG-0098, the backend wedge in §2.5, which is unreproduced). Nothing in this file
duplicates a ledger entry. **Recount before restating**: the histogram is one line of node
(`{fixed:94, open:4}`), and the previous figure here (97/94/3) was already stale the day after it
was written.

---

## 1. Owner calls — decisions, not work

These needed a product judgement before anyone wrote code. Each was small to implement and
consequential to get wrong, which is why none of them had been decided under cover of another fix.

**ONLY 1.6 IS STILL OPEN**, and the owner's instruction on it was explicit: leave it, analyse it,
recommend. That analysis is in place below and nothing was implemented for it.

**1.1-1.5 were DECIDED AND BUILT on 2026-08-16**, under the standing rule "Excel parity takes
priority always". The as-built record — what each turned out to be, what else it found, and what
was deliberately left — is `docs/design/open-items-1-owner-calls-2026-08-16.md`. The rows are kept
here, struck, for one release: three of the five were **materially different from how they were
filed**, and a reader who only sees them vanish learns nothing from that.

### ~~1.1 Currency negatives: parentheses or a leading minus~~ — **CLOSED 2026-08-16**

Done exactly as Excel does: a negative currency renders with a **leading minus**
(`$#,##0.00` is a single-section code), and Excel's four "Negative numbers:" entries exist as
`NegativeStyle` — reachable from a new list in Format Cells, round-tripped through the display
name, and read and written by the `.xlsx` importer and writer.

**It was a round-trip lie, not a preference.** `xlsx_writer` has always emitted `$#,##0.00`, so a
workbook that showed `($1,234.56)` in Calcula reopened in Excel as `-$1,234.56`. The Format Cells
*preview* already disagreed with the preset for the same reason.

**No visual golden moved.** All 72 were examined; none contains a negative currency. Two adjacent
defects were fixed in the same files: OOXML builtin accounting ids 41-44 imported with the wrong
decimals and an invented `$`, and the new negative-section reader was initially wired to the
POSITIVE section (caught by adversarial verification, not by the author).

### ~~1.2 The 1904 date system as a user setting (D9)~~ — **DECIDED 2026-08-16: add none**

The recommendation was accepted. Import already handles it; the flag carries no user intent
(nobody chooses 1904, they inherit it); and toggling such a setting changes what every date in a
workbook means without moving a stored value, which is the silent-corruption shape this programme
exists to remove. A write-side need would be an **export option**, not a document setting.

Three guards now hold the decision, because prose decays into rumour:
`no_calendar_epoch_setting_exists_outside_the_xlsx_importer` (a source census that assembles its
own needles so it can search its own file, sabotage-checked),
`a_1904_workbook_is_exported_as_1900_with_no_date1904_attribute`, and
`the_date_system_offset_is_the_engine_calendars_1904_epoch`.

### ~~1.3 OS regional settings on the `"system"` locale path~~ — **CLOSED 2026-08-16**

`app/src-tauri/src/os_locale.rs` reads `GetLocaleInfoEx` over a null locale name; the table is the
base it overwrites onto, the per-field fallback, and the whole answer for an explicit override.

**It closed two defects nobody had filed.** `sys_locale` returns
`GetUserPreferredUILanguages` — the *display language*, not the regional format — so an
English-display machine with a Swedish region got `.` decimals and `,` formula separators while
Excel beside it used `,` and `;`. And `set_locale("system")` silently returned en-US, because
`"system".split('-').next()` is `"system"` and even the language fallback could not fire.
"System default" is now a live re-read rather than a replay of what was captured at launch.

Windows pictures need translating in exactly three places (`'text'` → `"text"`, `t`/`tt` →
`AM/PM`, era dropped) — the live Swedish long date `'den 'd MMMM yyyy` renders as
`'15en '15 januari 2024` without it. Named gaps: `LOCALE_SGROUPING`, `LOCALE_INEGCURR`, and
English month names under an unlisted locale.

### ~~1.4 Same-sheet undo does not move the selection~~ — **CLOSED 2026-08-16**

Not the one-line guard widening it was filed as. Excel selects the restored **range**, so the
backend now reports one (`Transaction::restored_range_on`, with `restored_anchor` derived from it
so the two cannot disagree about which cells were touched). The old guard also meant the selection
dispatch *and the scroll beside it* were dead code on the common path.

**One named divergence stays open:** Excel leaves the ACTIVE cell at the range's top-left;
Calcula's selection model pins the active cell to `endRow`/`endCol` and its own
`selection-in-bounds` oracle rejects an inverted selection, so it lands at the bottom-right.
Matching Excel means giving the selection an active cell independent of its corners — a change to
the model, recorded rather than half-built.

`restored_range` is `None` for geometry, whole-sheet snapshots (all insert/delete rows/columns)
and every `CustomRestore` — those transactions record no coordinates, so the cursor stays put
rather than guessing. Closing that needs `GridSnapshot` to carry the affected band; two E2E specs
pass **only while it stays `None`** and are the tripwires. Blast radius, measured: exactly one
hard test failure, the case that existed to pin the old behaviour. The fused app CLI's undo was
routed through `CoreCommands.UNDO` in the same pass — the last caller still bypassing the view.

### ~~1.5 An empty cell reads as the number zero in every context~~ — **CLOSED 2026-08-16**

`EvalResult::Blank` now exists and Excel's three-way rule holds. The item understated the defect
twice over: the named line was one of fourteen zero-injection sites and not the important one
(`eval_range` materialised absent cells as zeros, so `COUNT(A1:A1000)` over two numbers returned
**1000**), and there were **two contradictory blank policies in the same evaluator** — `A1:A3`
injected zeros while `A:A` skipped them, so the same workbook answered differently depending on
how the range was spelled.

The feared "new variant threaded through every arm" was contained by keeping the OPERAND
coercions unchanged (`as_number` → `Some(0.0)`, `as_text` → `""`, `as_boolean` → `Some(false)`,
`to_cell_value` → `Number(0.0)`) so ~250 scalar functions and all six operators needed no edit,
and adding `as_sample_number` for the collectors that build a population. ~40 sites, not 460.

Fixed as consequences: `PRODUCT` returned 0 for any range containing a blank; `COUNTBLANK` never
worked at all; **every D-function with a partially-filled criteria rectangle silently filtered its
whole database out**; `COUNTIF(rng,0)` counted empty cells and `COUNTIF(rng,"")` counted none;
`=A1<"a"` was `#VALUE!`; and the paired statistics (CORREL, SLOPE, COVARIANCE, SUMX2MY2 …)
filtered their two arrays independently and slid one against the other.

**A second, adversarial review found fifteen more defects of the same shape** — a materialiser,
collector or comparator converted in ONE of its branches — and all fifteen are fixed. The worst:
`compare_values` had no blank arm, so a single empty cell in a sorted key column STOPPED an
approximate `VLOOKUP` and it returned the row before the gap; `SUBTOTAL` disagreed with itself
between `(9,B5:B15)` and `(9,B5,B10,B15)`; `OFFSET` and `TEXTJOIN` were each converted in one
branch of two; four D-functions and the `AVERAGEIF`/`MINIFS`/`MAXIFS` family still built the old
population; and a mechanical sweep gave `T.TEST`/`F.TEST` the PAIRED collector, silently
truncating two independent samples to the shorter one and making T.TEST's own length guard
unreachable. The eleven new tests each assert **two spellings of one question against each other**,
which is the shape that catches a half-conversion.

**Deferred, deliberately:** Excel's full reference propagation through `IF`/`CHOOSE`. The
value-versus-reference line IS implemented for the functions that matter (`INDEX`/`OFFSET`/
`INDIRECT` keep a blank; `VLOOKUP` and friends collapse it to 0, which is why
`ISBLANK(VLOOKUP(…))` is FALSE in Excel).

### 1.6 Policy-refused inline payloads still reach the decoder on the `.calp` pull path

BUG-0086 split media refusals into two outcomes (`MediaError::is_decode_hazard`, exhaustive match
so a new variant is a compile error): **hazards** (`TooLarge`, `DimensionOutOfRange`,
`TooManyPixels`) are cleared to `""`, **policy refusals** (`SvgRefused`, `BmpRefused`,
`UnknownFormat`, `MalformedHeader`, `Empty`) are left inline and still render. That split is
deliberate and right — destroying a picture because a later build narrowed the allowlist is the
worse failure.

The residual is that on the **pull** path the policy payload has no size bound at all.
`materialize_saved_controls` (`app/src-tauri/src/controls.rs:175-202`) is a plain
`controls.insert` loop: no length check, no `MAX_CONTROL_PROPERTY_CHARS` — and no media
judgement OF ITS OWN, though one does run on the pull immediately before it (see the 2026-08-16
analysis below, which corrects this sentence). The
64 KiB property bound applies to the two property commands, not to a pull. An `<img>` will not run
an SVG's script, which is why this was judged tolerable rather than closed — but it is a judgement,
so it is flagged rather than silently accepted. §36d.

**ANALYSED 2026-08-16 at the owner's request; still open, nothing implemented.** Full write-up in
`docs/design/open-items-1-owner-calls-2026-08-16.md` §1.6. Four things it changes about the row
above:

1. **The pull DOES run a media judgement** — `admit_distributed_controls` at three `.calp` sites —
   so a decompression bomb is cleared and `onSelect` is stripped. The sentence above is true of
   `materialize_saved_controls` in isolation and misleading about the path. What the pull lacks is
   a **size bound**.
2. **Three unbounded shapes**, not one: a non-base64 `data:image/svg+xml,<svg …>` of any length; a
   `data:image/…` string with no comma at all (which bails out of the decoder AND the byte-cap
   check before either can measure it); and **any non-image property** — `text`, `tooltip`, an
   invented key — which the image judgement never examines.
3. **The axis to weight is persistence, not script.** The script question is structurally closed
   (secure static mode + CSP + no DOM-injection path reaches a control property). But the payload
   is written verbatim into the SUBSCRIBER'S OWN `.cala` on their next save, and the media GC
   prunes the media store — an inline string is not in the store, it *is* the document, so nothing
   ever reclaims it. Durable, silent, inside a correctly-signed artifact.
4. **Recommendation: bound the DISTRIBUTED payload in `migrate_distributed_inline_images`**
   (~40 lines, pulls only, `.cala` open untouched) — not in `materialize_saved_controls`, which
   also runs on the user's own file and would silently delete a legal 90 KiB inline logo on the
   next open, and has no error channel to report anything.

Also done in that pass, because they were **false statements in the codebase**: two doc comments in
`controls.rs` claimed `.calp` materialization arrives through `set_control_metadata` and is
therefore bounded. It does not and is not. The test `a_control_property_over_the_size_cap_is_refused`
already carried the correction while both doc comments asserted the opposite.

---

## 2. Engineering residuals — no owner input needed

Each is scoped, understood, and deliberately not done. They need a slot, not a decision.

### 2.1 Product / engine

| item | verified at |
|---|---|
| **Excel's array literal `{1;2;3}` does not parse.** The lexer has no `;` arm at all — `;` falls through to `Token::Illegal(ch)` (`core/parser/src/lexer.rs:76`), and `parser.rs:526/566` treats `{…}` as a Python-style `ListLiteral`. `{1,2,3}` parses, but as a list, not a 1x3 array. | `lexer.rs:76`, `parser.rs:526,566` |
| **`#NULL!` is never produced.** `rg CellError::Null core` returns exactly three hits, all in `cell.rs`: a doc-comment cross-reference inside `Num`'s docs (`:82`), `as_literal` (`:164`), `from_literal` (`:189`). The declaration itself is `:78`, spelled `Null,`, which the pattern does not match. It round-trips an imported `#NULL!` faithfully and the evaluator never raises one. Its sibling `Num` carries a doc comment saying "the evaluator PRODUCES this now" (`cell.rs:82`) — `Null` has no such line, which is the difference. | `core/engine/src/cell.rs:78,82,164,189` |
| **`set_active_sheet` accepts a hidden sheet index.** Worth stating carefully, because it now *looks* guarded: `activate_sheet` does call `ensure_user_sheet` (`sheets.rs:917`), but that guard tests `is_user_sheet` (`sheets.rs:144-149`), which refuses **only** `OBJECT_SHEET_VISIBILITY` — floating-range backing sheets. A user-hidden sheet (`"hidden"`) passes straight through. Excel's `Activate` errors on a hidden sheet. Not tightened because scripts and E2E specs use it to reach hidden sheets. | `sheets.rs:144-168,917` |
| **`default_row_height` / `default_column_width` announce no undo domain.** Both registered with `domains: NONE` (`undo_commands.rs:1625-1626`) and the registry test pins it (`:4578-4579`), so undoing either notifies nothing that needs to repaint. | `app/src-tauri/src/undo_commands.rs:1625,1626,4578` |

### 2.2 The `Persisted<T>` migration is not finished

`AppState` has **104 fields**: **59** are `Persisted<T>`, **43** are still a bare
`Mutex`/`RwLock`, and 2 are neither — `undo_stack` and `calc_cancel`. (Do not read "neither" as
"unlocked": `undo_stack` is `undo_history::UndoHistory` (`lib.rs:392`), which holds its own
`Mutex<UndoStack>` (`undo_history.rs:125-127`) precisely so every existing `.lock()` site stays
unchanged. Only `calc_cancel` is genuinely lock-free — `CancelToken(Arc<AtomicBool>)`. An earlier
wording said "unlocked", which invites someone to add a Mutex and double-lock it.) Only the
`Persisted<T>` ones force a command to name a `DocumentEffect`, so a command touching only the
remaining 43 can still mutate without deciding — the exact hole `DocumentEffect` was built to close.

**The 43 are not one population, and the previous summary of them was wrong in both directions.**
Classified by opening each: roughly **22 are derived/rebuildable** (the 16 dependency maps
`lib.rs:342-385`, `computed_prop_dependencies`/`dependents`, `spill_hosts`, `spill_blocks`,
`gather_cache`, `writeback_index`, `id_registry`) — about half, not "overwhelmingly". And **11 are
application preferences that must NEVER become `Persisted<T>`**: `calculation_mode`,
`iteration_enabled`, `max_iterations`, `max_change`, `locale`, `reference_style`,
`precision_as_displayed`, `calculate_before_save`, `auto_recover_enabled`,
`auto_recover_interval_ms`, `subscriber_identity`. Those are the USER's, not the document's, and
`document_store_census_tests.rs`'s `SESSION_SCOPED` table records each with its reason. So the row
overstated the backlog (11 of the 43 are permanent exemptions, not work) while understating the one
real risk. Declare any NEW persisted store `Persisted<T>` from the start.

**Two of the 43 are read by the SAVE path, and here they are by name** — "check the field before
assuming it" put the burden on a reader with no list, which is how these stayed invisible:

- **`spill_ranges`** (`lib.rs:488`) — `apply_spill_extents_to_sheet` (`persistence.rs:375-397`) calls
  itself "the only authority for which origin owns which cells" and sets `origin.spill`; it runs from
  the save assembler (`persistence.rs:648`), and `zip_io.rs:197-199` stamps the `.cala` v7
  `spill_extents` feature purely on that field's presence. A store deciding what bytes hit disk,
  ungated. **Promoting this one is the cheapest real fix in this row.**
- **`advanced_filter_hidden_rows`** (`lib.rs:510`) — unioned into `hidden_rows` at save
  (`persistence.rs:902-911`); its writers hand-roll `DocumentEffect::mutates` with a comment saying
  "both arms change what a save writes" (`autofilter.rs:1453-1470`, `:1484-1495`).

Also not derived caches, though not save sources: `protected_regions` (`:426`), `next_cf_rule_id`
(`:452`), `next_computed_prop_id` (`:462`), and `scroll_areas` (`:556`, whose own comment documents a
missing-persistence gap).

**And the guard that looks like it covers this does not** (open-items rule 4, again).
`every_persisted_appstate_store_is_gated_not_a_bare_mutex` (`document_effect.rs:1037-1088`) reads
exactly like the enforcement this row wants, but `must_be_gated` is a **hand-written allow-list of 22
field names** — it asserts those 22 still say `Persisted<` and is structurally blind to anything not
on it. Neither save source appears in it. `document_store_census_tests.rs` covers reset-on-open, not
gating, and both save sources *are* reset (`persistence.rs:4121`, `:3914`), so that census passes
while saying nothing about this. The missing guard is the parse-don't-list one: derive the save
sources by parsing `build_workbook_for_save` for `state.<field>.lock()` and fail if any is not
`Persisted<`. Pin 104/59/43 at the same time — no test anywhere asserts those numbers, which is why
they keep drifting.

**Count the fields, not one grep spelling** — and note the pattern, because this warning previously
named the wrong one. Measured on `app/src-tauri/src/lib.rs`: `document_effect::Persisted<` returns
**59** (it is a substring of the crate-qualified spelling, so it catches everything);
`: document_effect::Persisted<` returns **51**, because after `: ` the other 8 read
`crate::document_effect::Persisted<` — and that spelling alone returns **8**. 51 + 8 = 59, and
59 + 43 + 2 = 104 reconciles; nothing else does. A passage whose whole job is to stop a grep error
was making one, and the pattern it blamed happens to give the right answer.

### 2.3 Import fidelity

**S7 — calamine expands only 1-D shared formulas.** An upstream limitation of the
`calamine = "0.26"` dependency (`core/persistence/Cargo.toml:11`); `core/persistence/src/xlsx_reader.rs`
carries no shared-formula expansion of its own to work around it. Still open, still without a
reproduction fixture — which is the first thing anyone picking it up should build. §3bi, §35c.
(The anchor here read `§7142` until 2026-08-17; that section does not exist — a line number into a
1.33 MB append-only archive was never going to survive, so cite the §.)

**Build that fixture against the code, not against the archive's description of it.** Re-read
2026-08-17 in `calamine-0.26.1/src/xlsx/cells_reader.rs:221-245`: the offset map is built in two
**mutually exclusive** branches — if the `ref` spans rows, it walks rows only at the fixed start
column; else if it spans columns, it walks columns only at the fixed start row. So a 2-D
`ref="B2:D10"` does **not** yield an empty map: the first branch fires and the range's first COLUMN
keeps its formula while every other column loses it. §3bi says "an empty map and every follower gets
no formula", and that half is wrong. A test written to the archive's wording would fail on the first
column and be misread as a fix, so expect **partial** survival.

### 2.4 Test infrastructure

| item | verified at |
|---|---|
| **The soak walker's formula alphabet is six formulas.** `FORMULAS` is exactly `SUM`, `&`, `IF`, `AVERAGE`, `COUNT`, `MAX` (`e2e/walker/actionCatalog.ts:129-136`). Widening it changes what the committed seeds mean, so it belongs to a pass that can re-baseline them. | `actionCatalog.ts:129-136` |
| **Only charts are re-synced after the walker's `new_file`.** `deepResetForWalk` calls `resyncChartStoreToBackend` and nothing equivalent for sparklines, slicers or pane controls, which sit on the same fan-out (`e2e/walker/reset.ts:242,281`). The chart case is the one BUG-0075 photographed; the others are the same shape, unphotographed. | `e2e/walker/reset.ts:242,281` |
| **The two `evaluate-formula` goldens assert residue, not their feature.** `grid-evaluate-formula-init` and `-constant` are whole-grid captures of a spec whose subject is off-screen until its own `navigateTo`, so they photograph whatever the preceding specs left on rows 1-26. Stable now, but they are layout assertions wearing a feature's name. Turning them into region captures of the AI column is a golden change owned by that spec. | `e2e/tests/__screenshots__/evaluate-formula.spec.ts/`, §30f |
| ~~**The journey project has no side-panel residue guard.**~~ **CLOSED 2026-08-16.** `e2e/journeys/zz-persisted-residue.spec.ts` now runs last and asserts the app-owned storage namespaces are at their DEFAULTS. Two corrections came out of building it, both worth keeping: (1) the guard must assert *value is default*, not *key is absent* — its first draft failed on a clean app because `calcula-task-pane` and `calcula-panel-placements` are `zustand/persist` stores that write themselves on hydration, and a check that reds a clean run is one somebody switches off; (2) the 1218 -> 898 px canvas class is **not** this key — `partialize` persists only `{width, dockMode}` and deliberately omits `isOpen`, so an open pane cannot survive a reload at all. The teardown side is necessary but insufficient, so the same catalogue also drives a reset on the way IN (next row). | `e2e/journeys/zz-persisted-residue.spec.ts`, `e2e/volatilePersistedState.ts`, `useTaskPaneStore.ts:219-224` |
| **Cleanup-on-exit cannot run when the app is dead — so the reset moved to run START.** `shapes-hometab.spec.ts` test 8 *does* restore the ribbon in a `finally`; on 2026-08-16 the app wedged mid-test, `restoreDefaultHomeLayout` needed a living app to reload, and it swallowed its own failure. The injected `rowBreak` survived into the next project, which failed `ribbon-core-default-ribbon.png` with `deleteColumn` clipped out — the visual project reporting a red golden for something no visual spec did. `e2e/volatilePersistedState.ts` now sweeps the app storage namespaces by PREFIX immediately after `assertAppMounted`, when the app is known-healthy. It sweeps rather than lists because the `ext.<extensionId>.<key>` family cannot be enumerated even in principle. It reports a leak **only** when a cleared value was non-default; a sweep clears something on essentially every run, and an alarm that always fires is one nobody reads. | `e2e/volatilePersistedState.ts`, `e2e/global-setup.ts` |
| **Completed Playwright runs leave orphaned process trees.** After every project reported exit 0, five node processes plus an `app.exe` were still driving the application minutes later, and the next launch failed on port 5173. Recorded rather than filed because the zero-gap invocation pattern was introduced by the pass that saw it — but the regression runner also drives projects back to back. Now with the file:line rule 2 demands: the teardown fires `taskkill /F /T` and **never verifies the tree is gone** (`global-teardown.ts:100-108`), manual mode returns before reaching any of it (`:89-91`), and the only repair is 5173-only (`global-setup.ts:145-163`). Cheapest mitigations, in order: verify-after-kill (poll the PID and ports 9222/5173 for a bounded window, fail loudly), then a "no `app.exe`, nothing on 9222 or 5173" precondition. Put the precondition in **global-setup**, not the teardown — manual mode is exactly the path that skips the teardown, and it is how these runs are driven. | `global-teardown.ts:89-91,100-108`; `global-setup.ts:145-163`; §39g |

### 2.5 The backend can stop answering mid-run, and nothing could see it (BUG-0098)

**Open, unreproduced, and deliberately not "fixed".** On 2026-08-16 a journey run failed **64
consecutive tests over 5.4 hours**, every one on timeout, none on an assertion. The first failing
spec (`document-store-leak`) contains **zero Playwright locators** — verified, `grep` for
`locator(|getBy|.click(|.fill(|waitForSelector` over its 839 lines returns nothing — so no
actionability wait exists that could burn 300 s. Every step goes through `page.evaluate`, either
`__TAURI__.core.invoke` directly or one of the app's own modules imported via `__calcImport`
(`:79-91`, `:94-115`). The backend simply never returned.

**Why nothing stopped it.** The harness had two liveness notions and neither can see this state.
`assertAppMounted` proves *a DOM node became visible*, but it runs **once per RUN** — exactly two
call sites, both in `global-setup.ts` (`:128`, `:288`), pinned by `startupBarrierWired.test.ts:43-46`.
What re-ran on each of the 64 worker rebuilds is the worker-scoped `sharedPage` fixture:
`connectWithRetry` plus a 60 s `waitForSelector` on the spreadsheet container
(`fixtures.ts:244`, `:316`). Same shape, equally blind — it reported healthy every time. And nothing
sets `maxFailures` or `globalTimeout` anywhere in the harness; Playwright's defaults (0/0, meaning
unlimited failures and no global deadline) apply, so there was no bail-out and every remaining test
paid its **full** 300 s (`playwright.config.ts:120,124`).

**What was ruled out, by running it.** `document-store-leak` alone: 7/7 pass. Specs 7-8 + dsl: 13
pass. Specs 1-6 + dsl: 33 pass. The **full journey project, unmodified: 156 passed in 27.8 minutes.**
Not that spec, not that ordering, not deterministic. The three harness death-modes are excluded on
timing alone — each fails fast (3 s / instantly / 60 s) where these burned 300 s.

**The mechanism is NOT claimed.** A lock-order inversion is the leading candidate on this project's
history, but nothing here proves it, and two decisive pieces of evidence were destroyed by design:
`init_log_file` opened the app log with `.truncate(true)` on **every app start**, so four later runs
overwrote the backend's only account of itself, and `results.json` is overwritten per run
(`playwright.config.ts:50` — a fixed path). Fixing product locks without a reproduction would be
guessing. **The log half of that is fixed as of 2026-08-17 (see below), so the next occurrence keeps
its evidence.**

**What was built instead** — make the next occurrence cheap, attributed, and diagnosable:

| | |
|---|---|
| `e2e/wedgeGuard.ts` | Probes the backend with a real `get_cell` before every test that takes the `appPage` or `grid` fixture — i.e. all of them **except** the 7 `gridPersistent` tests in `tests/workflow-dashboard.spec.ts`, which bypass the fixture. The race is **double** because `page.evaluate` has no timeout in Playwright's API: an inner race bounds the *invoke* (distinguishing a wedged backend from a wedged renderer), an outer one bounds the *evaluate*. Latches after **two consecutive** unanswered probes — one slow answer is not a wedge, and a guard that latches on one is worse than the disease. It **fails**, never skips (§3bx): a skipped test reports coverage it does not have. **It is deliberately biased to fail OPEN**: a rejected invoke (`:85`) and a thrown `evaluate` (`:91`) both count as "ok", so a crashed page reads healthy here and is left to `appDiedMarker`, whose job it is. This guard answers one question only — is the backend ANSWERING. |
| `e2e/wedgeMarker.ts` + `global-teardown.ts` | Same three-stage pattern as `appDiedMarker`: setup clears, the fixture writes, teardown prints a banner saying the failures are **one fact**, not 64 defects. |
| `global-teardown.ts` log archive | Copies `app-dev.log` to `results/app-logs/app-dev-<stamp>.log` (last 10 kept), so the next run no longer destroys this run's evidence. |
| `app/e2e/__tests__/wedgeGuard.test.ts` | 8 tests pinning the decision logic against a fake page, since a healthy suite can never exercise it. Sabotage-checked twice, both **measured** by running them: latching on the first bad probe reds **5 of the 8**, and moving the counter into module memory reds **exactly the restart test** (`:149`, the only one that re-imports the module between probes). It redirects its state to a temp dir via `E2E_WEDGE_STATE_DIR`, because writing the real marker would latch a concurrently running suite. |

**The one subtlety worth carrying forward.** The pre-latch counter is on DISK, and
the obvious implementation is silently broken. Playwright rebuilds the worker after every failed
test, and a rebuilt worker re-imports the module with fresh state — so on a wedged app (where every
test fails) a module-level `let` resets between every pair of probes, the count never reaches two,
and the guard degrades into a log line while the run still costs 5.4 hours. An in-process unit test
cannot see it; `wedgeGuard.test.ts` re-imports the module between probes to reproduce the restart.

**To close it:** a reproduction. The next occurrence leaves `e2e/results/APP-WEDGED.txt` naming the
test it was first seen before, and an archived app log. Start there.

**The product side is now fixed too (2026-08-17).** `init_log_file` no longer truncates: it ROTATES
the previous session's log into `context_manager/history/log-<stamp>.log`, keeping the last 10
(`RETAINED_SESSION_LOGS`), and `log.log` stays the stable live path. Pinned by 5 tests in
`logging.rs`'s own `rotation_tests`; sabotage-checked (disabling rotation reds 3 of them).

Two things that pass required getting right, both counter-intuitive:

- **Append would have been wrong.** `LOG_SEQ` is a per-process `AtomicU64` restarting at 0 each
  launch, and `sort_log_file` reads the whole file and sorts by it — appending would shuffle two
  sessions together beyond reconstruction. Rotation preserves the "one file is one session"
  invariant the sort depends on.
- **A failed rename must never fall back to truncating**, or the fallback becomes the original
  defect. It takes a uniquely-named file instead. Measured while testing: Rust's `File` includes
  `FILE_SHARE_DELETE`, so a second instance starting mid-run *does* rotate successfully, and the
  first instance's handle follows the file into `history/` and loses nothing — the opposite of the
  sharing-violation everyone expects. The fallback still earns its place for Dropbox/Defender locks
  (`os error 32`, which this repo hits often enough to have a retry helper for it).

This also retires the workaround in `e2e-test-plan.md` operational rule 9, where an isolated second
launch needed a fake `src-tauri` marker directory as its cwd purely to stop it truncating the shared
log under a run in progress.

### 2.6 The startup gap that no gate covers

**No gate that blocks a PR proves the app can be linked.** Verified by reading the workflows, and
restated 2026-08-17 because the previous wording was both mis-cited and too strong.
`.github/workflows/ci.yml` runs `npm run check-types` (`:34`), `npm test` (`:49`) and — in the
`rust-core` job, whose `working-directory` is `core` — `cargo test --workspace` (`:65`) and
`cargo check --workspace --benches` (`:72`). `cargo check` does not link; `cargo test --lib` links a
**test executable**, not the `app_lib.dll` the app loads; and `core/Cargo.toml` does not list
`app/src-tauri` among its 11 members, so `cargo test --workspace` there *structurally cannot* link
it. `ci.yml`'s own header (`:9-12`) says the app crate is intentionally not gated yet.

What was wrong before: "no workflow builds the app crate at all" — two do. `release.yml:79`
(`npm run tauri build`, on a `v*` tag or manual dispatch) and **`e2e-nightly.yml`, which launches the
real app via `cargo tauri dev` on a self-hosted Windows runner** and therefore does link it. So the
gap is narrower and more specific than stated: nothing on the **PR path** links the app, and the
nightly that does is self-hosted, so a runner that is offline takes the only routine link check with
it silently. Four tracks changed Rust in the week before this was noticed and the first thing to
exercise the link was the E2E launcher, which failed with ~40 `LNK2001` errors. §39d.

**Related and still true: a pre-React failure shows a blank window with no message.** `app/index.html`
is an empty `<div id="root"></div>` and a module script — no fallback markup, no `window.onerror`.
`RootErrorBoundary` (BUG-0083) catches throws *after* React mounts; a module-resolution failure, a
syntax error, or the Vite dep-optimizer 504 of §37c happens before there is a boundary to catch it.
The E2E startup guard can now *detect* that state and fail the run; the **product** still shows the
user nothing.

---

## 3. How to keep this file honest

1. **Close items here, in place**, when they are fixed — do not rely on a later section of the
   archive to imply it. The archive's failure mode was never false reports; it was stale anchors.
2. **Every row carries a `file:line`.** A row that cannot cite one is a rumour and belongs in the
   ledger with a reproduction, or nowhere.
3. **Both staleness directions are defects.** A row claiming something is broken that now works
   sends the next reader to re-fix working code; that is the direction that cost this project the
   most, not the other one.
4. **Re-verify before restating.** Of the items handed to the 2026-08-16 audit as open, one —
   `set_active_sheet` accepting a hidden index — very nearly read as fixed because a guard with the
   right shape had been added for a different reason. Open the file.

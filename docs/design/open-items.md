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
reproduction live in `tests/regression/bug-ledger.json` (**106 entries, 104 fixed, 2 open** as of
2026-08-19 — recounted from the file, not carried forward; it moved three times in two days). The
two open are **BUG-0098** (the unreproduced backend wedge in §2.5, kept open deliberately — the
guards now make a recurrence diagnosable, and it is explicitly not closeable by a speculative fix)
and **BUG-0104** (sort and filter by conditional-formatting icon). Its ENGINES both work as of
2026-08-19 — the sort keys on the icon that was on screen when it was invoked, the filter resolves
once per pass — and both are reachable over IPC. What is left is the SURFACE: the script validator
has a closed allowlist so a script can say `sortOn:"icon"` but can never name the icon, and neither
the Sort dialog nor the AutoFilter dropdown can express an icon choice yet, so both still refuse.
Nothing lies to a user in the meantime; the remaining refusals are validations naming what is
missing. BUG-0095, BUG-0096 and BUG-0097 were fixed 2026-08-17; BUG-0099,
filed and fixed the same day, is the sibling of BUG-0086 — that fix turned out to be
SPELLING-SPECIFIC, and a capitalised `;BASE64,` tag or a percent-escaped body bypassed it entirely.
Nothing in this file duplicates a ledger entry. **Recount before restating**: the histogram is one line of node, and this figure has
been stale within a day of being written more than once.

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

### ~~1.6 Policy-refused inline payloads still reach the decoder on the `.calp` pull path~~ — **CLOSED 2026-08-17**

Implemented as recommended in `open-items-1-owner-calls-2026-08-16.md` §1.6, plus one gap that
document did not state and two defects an adversarial review found in the implementation itself. Full
as-built record: **`docs/design/open-item-1-6-calp-media-bound-2026-08-17.md`**.

**What shipped**, all in `app/src-tauri/src/media.rs` and `core/calcula-format/src/media.rs`:

1. `exceeds_byte_cap_encoded` **widened** — it answered only for `;base64,` payloads and returned
   `false` for everything else, so a `data:image/svg+xml,<svg …>` or a comma-less data URL was
   unbounded at ANY length. All three shapes now measure against `MAX_MEDIA_BYTES`. A differential
   run over the old and new bodies agreed on every base64 input, so this is a proven pure widening.
2. `clamp_oversized_distributed_values` — a **pull-path-only** ceiling clearing any string over
   `MAX_CONTROL_PROPERTY_CHARS`, or over `MAX_MEDIA_BYTES` for a `data:image/` payload, counted into
   a new `MediaMigration.oversized`. It runs LAST, after admissible images have become ~70-character
   handles, so a legitimate picture cannot be caught by it. The `.cala` load path takes no such
   ceiling, deliberately: a user's own 90 KiB inline SVG logo must not vanish on open.
3. **The unstated gap:** a base64 payload is judged on its DECODED size, so its encoded text could
   reach 4/3 × `MAX_MEDIA_BYTES` ≈ **10.67 MiB — 171× the property cap** — and still be "policy-
   refused, left inline". Measuring the string's own length is what bounds that.
4. **BUG-0086 through two other spellings, found by adversarial review and the most serious thing
   here.** The hazard/policy split is only as good as the agreement between the host's parser and the
   one that actually runs, and the host's was STRICTER. `decode_image_data_url` required a byte-exact
   lowercase `;base64` (and the widened cap repeated that same literal), while the WHATWG processor
   WebView2 implements matches the tag **case-insensitively** and **percent-decodes the body before
   base64-decoding**. So `data:image/png;BASE64,<4 KB 30,000×30,000 PNG>` — and, needing no case
   difference at all, `data:image/png;base64,%69VBORw…` — were classified "refused on format, safe on
   screen", written verbatim into the subscriber's `.cala`, and handed to `img.src`, which has no caps:
   ~3.6 GB of RGBA. Fixed by making the host agree with the browser (one shared
   `ends_with_base64_tag`, plus percent-decoding), and by **inverting the default**: `LeaveInline` now
   requires a payload the host could actually READ. An undecodable string that declares a RASTER
   format is dropped, because "we could not parse it" is not evidence the renderer cannot. SVG keeps
   its tolerance — it is the one declared type this host never decodes by design.

**What is still not caught, and is accepted:** aggregate volume (5,000 controls × 63 KiB is ~315 MB
and every value is legal — that needs a per-pull total budget), and an SVG under the cap that is
expensive to rasterise (uncatchable without an SVG parser, which the media module refuses on
principle, correctly).

**Verification:** 40 media tests, **1,695 app-crate**, **1,411 core workspace**, all passing.
Sabotage-checked in four rounds — reverting the clamp reds 2, narrowing the byte cap reds 2, and
reverting the three bypass fixes reds 4. Two of the review's own findings were about the TESTS rather
than the code and are fixed: one regression guard's fixture was too small to exhibit the failure it
claimed to guard (87 KB against an 8 MiB ceiling), and the clamp's `data:image/` branch had no test
at all.

### ~~1.6 (original statement, kept for the record)~~

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
| **Column-header separators are not device-pixel snapped — the same defect just fixed for cell borders.** `headers.ts:168,330` stroke at a hand-rolled logical `+0.5` instead of snapping into DEVICE space the way `grid.ts:189-191` has always done for the gridline hairline. Column boundaries are `22 + k*64.29`, so at dpr 1 every column-header tick smears across two device pixels at partial alpha rather than landing on one. Row-header ticks are on the integral axis and are fine — the identical top-crisp/side-blurred asymmetry that BUG-0101 turned out to be. **Deliberately excluded from BUG-0101's fix**, which is why this row exists: the file has 18 stroke calls and NO unit tests, and the change moves grid-bearing goldens (BUG-0101's design review estimated 49; a later byte census said 51 — recount before scheduling, and note `headers.ts` is pure CRLF while `grid.ts` and `cellBorders.test.ts` are LF). The fix itself is the parity-snap helper from `cells.ts` applied three times. | `headers.ts:165-168,327-330,442-445`, `grid.ts:189-191`, BUG-0101 |
| **`model-engine-lib` is run by no CI workflow at all.** 2,230 `#[test]`/`#[tokio::test]` functions across 145 files, executed by zero gates. `ci.yml`'s `rust-core` job sets `working-directory: core`, and `core/Cargo.toml` lists 11 members — `model-engine-lib` is not among them; `link-check.yml` builds the app crate (which COMPILES `bi-engine` through the path dependency but runs none of its tests); `release.yml` names the directory only as a cache path. So the entire BI/semantic-model engine — the thing every pivot, CUBE formula and measure evaluates through — has no automated correctness gate on any branch. Worse, **75 of those tests are `#[ignore]`d behind a live AdventureWorks database and they are the whole differential-vs-SQL corpus**, i.e. the engine's only ground truth for DAX semantics, so even a manual `cargo test` there proves less than it appears to. Adding the job is hours; deciding what to do about the DB-gated corpus is the owner's call. | `.github/workflows/ci.yml:58-72`, `core/Cargo.toml`, `model-engine-lib/` |
| **Three E2E `test.fixme`s all disable the SAME assertion, and one would pass vacuously if re-enabled.** `workflow-invoice.spec.ts:144`, `workflow-gradebook.spec.ts:144` and `workflow-dashboard.spec.ts:231` each skip "edit a value, verify the cascade recalculated" — the single behaviour those three journeys exist to prove. Only the invoice one states a reason (cross-test data contamination, at `:142-143`); the other two give none. And gradebook's body sits inside `if (erikRow > 0)`, so simply un-fixme-ing it would pass WITHOUT asserting anything whenever the row is not found — re-enable the assertion and the guard together, or it re-enters the suite as decoration. | `workflow-invoice.spec.ts:144`, `workflow-gradebook.spec.ts:144`, `workflow-dashboard.spec.ts:231` |
| **Four "not yet implemented" comments describe limitations that no longer exist.** Stale in the ALREADY-FIXED direction — the direction this project has measured as costing it most, because a reader trusts them and re-implements something that works, or routes around a path that is fine. `BorderTab.tsx:3-4` says "Border rendering is not yet supported in the Canvas renderer... apply is a no-op" (false — it applies, and BUG-0101 just fixed how it rasterizes); plus `knownIssues.ts:79-84`, `tables.rs:471`, and `api_types.rs:738` with `data.rs:4657`. Minutes to correct, and worth doing as a batch because the pattern is the point: **a limitation recorded only in a code comment is invisible to this file by construction**, and so is its expiry. | `BorderTab.tsx:3-4`, `knownIssues.ts:79-84`, `tables.rs:471`, `api_types.rs:738` |
| **Excel's array literal `{1;2;3}` does not parse — SCOPED 2026-08-17, deliberately NOT started.** The lexer has no `;` arm (`;` falls to `Token::Illegal`) and `{…}` is a Python-style `ListLiteral`. The gap is worse than filed — `={1;2;3}` is stored as a TEXT CELL containing the literal string, with no error at all — and it is **not** "add a `;` arm". Three things make it a project, and the middle one is why a partial fix would be actively harmful:
1. `{}` is a shipped List/Dict literal with different semantics (contained, does not spill, displays `[List(3)]`). Reclaiming it is cheap — `COLLECT()`/`DICT()` already exist as function forms and **nothing in the repo uses the brace form** — but it is an owner call.
2. **`delocalize_formula` is a blind character rewrite** mapping `;`→`,` outside string literals with **no brace awareness**. On the owner's own sv-SE machine a 2-D constant would therefore FLATTEN INTO ONE ROW on any innocent re-entry, silently. Excel avoids the collision by using `\` as the COLUMN separator in `;`-list-separator locales. A lexer-only fix looks green on en-US and corrupts matrices on sv-SE — the exact class this register keeps cataloguing.
3. 39 `ListLiteral` sites across 12 files, and a new variant is **not** fully compiler-caught: `bi/cube.rs` has 18 catch-alls, `formula_eval_plan.rs` 8, `evaluate_formula.rs` 6, `lib.rs:1333` is literally `_ => ast.clone()`.
Good news for whoever takes it: `EvalResult::Array(Vec<EvalResult>)` **already expresses 2-D** as an Array of row-Arrays (`spill_dimensions`, `to_spill_values`, `SEQUENCE`, `RANDARRAY` all rely on it), so no new result variant is needed — but note a FLAT array spills as a COLUMN, so `{1,2,3}` must lower to `Array([Array([1,2,3])])`. Also verify Excel's `\` separator against a real sv-SE Excel first: it is one entry to confirm and the whole design rests on it. **CONFIRMED 2026-08-19 by the owner, in a real Swedish Excel, with screenshots:** `={1\2;3\4}` spills a 2x2 block and `={1;2;3}` spills a 3x1 COLUMN. So in a `;`-list-separator locale, **`\` is the COLUMN separator and `;` is the ROW separator** — the design assumption holds and no separator rework is needed. Recorded here because Microsoft`s own sv-SE array-constants page carries UNTRANSLATED prose saying "kommatecken", i.e. the vendor documentation reads the opposite way, and a casual re-check would flip this back. Do not re-derive it from the docs. | `lexer.rs:76`, `parser.rs:526,566`, `formula_locale.rs:18-46,56-106` |
| ~~**`#NULL!` is never produced.**~~ **CLOSED 2026-08-17, and the item pointed one layer above the defect.** It read as a missing match arm; the truth is that **the SPACE INTERSECTION OPERATOR WAS NOT PARSED AT ALL**. `skip_whitespace` consumed every space and emitted nothing, so `=A1:A5 C1:C5` could not reach an evaluator — the parse failed, the cell stored the formula anyway, and the user saw `#VALUE!` on a cell carrying **no dependency edges**, so it never recalculated either. There was no smaller honest fix: mapping the parse failure to `#NULL!` would be right for a disjoint pair and WRONG for `=A1:B5 B1:C5`, which Excel answers with the overlapping column. Implemented as `BinaryOperator::Intersect` on the existing `BinaryOp` (never a new `Expression` variant), one precedence level tighter than `^`, with `eval_intersect` working on the operand EXPRESSIONS — it cannot live in `eval_binary_op`, which collapses both sides to values and destroys the reference-ness it needs. `u32::MAX` sentinels let `A:A 2:2` be the single cell A2. 7 tests, each `#NULL!` case paired with an overlap control, plus a renderer round-trip (a dropped space would rewrite `A1:A3 A2:C2` into `A1:A3A2:C2`). **One named divergence:** `=A1 2` yields `#NULL!` where Excel rejects it at entry — single-token lookahead cannot tell `2` from `2:2`, and dropping `Number` as an operand start would lose whole-row intersection. | `ast.rs`, `parser.rs`, `lexer.rs`, `evaluator.rs`, `ast_render.rs`, `intersection_tests.rs` |
| ~~**`set_active_sheet` accepts a hidden sheet index.**~~ **CLOSED — verified fixed 2026-08-18, and the stated reason for leaving it open was FALSE.** The row said "not tightened because scripts and E2E specs use it to reach hidden sheets"; nothing depended on it, and `activate_sheet` now makes BOTH checks in a load-bearing order — `ensure_user_sheet` first, so the floating-range message survives for object-backed sheets, then `if !sheet_is_visible(...)` returning an error that names the escape hatch (`sheets.rs:937-942`). Excel parity: `Worksheets("x").Activate` raises run-time error 1004. Every premise the row stated was still true — `is_user_sheet` (`sheets.rs:144-149`) does refuse only `OBJECT_SHEET_VISIBILITY` — but the CONCLUSION had expired, because the guard it was missing had since been added one layer up. **This is the second justification-for-inaction in this file measured false in a single pass** (the other is the calamine row below), which is why every remaining code-fact row now carries a machine-checked predicate. | `sheets.rs:144-149,937-942` |
| ~~**`default_row_height` / `default_column_width` announce no undo domain.**~~ **CLOSED 2026-08-17, and it was a real repaint bug rather than metadata tidiness.** The registry justified `NONE` with a comment saying the frontend re-reads these "through the dimension refresh it already runs" — **it does not**: `refreshDimensionsFromBackend` is gated on `structuralRestore \|\| mergeChanged \|\| hiddenChanged`, and a default-dimension restore sets none of the three. The renderer paints from Redux `config.defaultCellWidth/Height`, which nothing else updates, so undoing a default row height wrote the old value to the backend and left the new one **on screen** — grid and file disagreeing, silently. Fixed by adding `UiDomain::Dimensions` (Rust enum + `ALL` + wire name, TS union, and a `dimensions: ["dimensions:refresh"]` row in the shell fan-out, which is the bare event every FORWARD dimension route already fires). `pivot_col_widths` had the identical `NONE` and is fixed with it. Sabotage-verified through `crossLayerConstantDrift`. | `object_deps.rs`, `undo_commands.rs:1623-1642,4578`, `events.ts`, `bootstrap.ts` |
| ~~**The in-app AI chat cannot hand the user a script to review — only an external MCP client can.**~~ **CLOSED 2026-08-19 (M1).** `draft_object_script` / `list_script_drafts` / `get_script_draft` were registered on the MCP server (**37 tools**) and absent from the in-app chat, whose **21** declarations and **21** dispatcher arms matched each other exactly — a perfectly consistent surface that was simply missing a feature, which is why nothing ever failed. The chat's only route to a script was `run_script`, which **executes immediately**, the inverse of the review-then-mount invariant `drafts.rs` exists to hold. Now 24/24. **Two things came out of a three-arm change.** (1) The tool surface was extracted to `AIChat/lib/chatTools.ts` — an inline `const` inside a `.tsx` cannot be diffed against Rust without parsing the component file, and `__tests__/chatToolSurface.test.ts` now reads `ai_chat.rs` at test time and diffs BOTH directions (sabotage-checked three ways: 7 reds / 3 reds / 1 red; the first Rust sabotage used an uppercase name that slipped the `[a-z0-9_]+` parse and had to be re-run lowercase to exercise the reverse direction at all). (2) The transcript printed `name(JSON.stringify(input))`, which for a draft would have dumped an entire macro JSON-escaped into a chat bubble — a defect M1 would have INTRODUCED; draft calls now render as a one-line summary while the readable copy opens in the editor. Verified: 294 frontend tests, **1737 app-crate tests, 0 failed**. **A third thing came out of it a day later:** the rows written for this item cited six line numbers in `ChatView.tsx`, and M1 shrank that file from 400 lines to 179, so `openItemsCitations.test.ts` went red on the very commit that closed the item — caught only when the FULL suite ran during M2, because M1 ran just the two affected extensions and not `npm test`. Design: `docs/design/local-model-script-authoring.md` §3b, M1. | `ai_chat.rs:236-380` (arms at `:305,317,318`), `AIChat/lib/chatTools.ts`, `AIChat/__tests__/chatToolSurface.test.ts`, `mcp/drafts.rs:238` |
| ~~**The in-app AI chat is hard-locked to one vendor, and offers no model picker at all.**~~ **CLOSED 2026-08-19 (M3).** `ai_chat.rs` is gone; `app/src-tauri/src/ai/` replaces it with a provider registry (**8 providers**), Calcula's own chat shape plus both wire translations, loopback runtime discovery, and per-provider Credential Manager slots. The extension no longer knows any vendor's schema: it speaks `AIChat/lib/aiTypes.ts`, and `input_schema` became `inputSchema` with the provider relocating it. A model picker exists for the first time — before M3 EVERY request in the product was `claude-opus-4-8`, because `ai_chat_complete` took a `model` parameter the caller never passed. **One `openai_compat` impl reaches Ollama, LM Studio, llama-server, vLLM, OpenAI, OpenRouter and any custom endpoint**; only Anthropic needs a native wire, and a test pins that so §7a's claim cannot rot. The selection is an application preference in `ext.calcula.ai-chat.*`, named on every request, so the backend holds no selected-model state and a model id can never reach a `.cala`. **Two things the move turned up:** the object-dependency census caught the `ai_chat_delete_api_key` -> `ai_provider_delete_key` rename, and `backendCommands.ts` had never denylisted the AI key commands at all (now listed, together with `ai_chat_complete` — not a key write, but the path that SPENDS one). Design: `docs/design/local-model-script-authoring.md` §7a, M3. | `ai/wire.rs`, `ai/providers.rs`, `ai/discovery.rs`, `AIChat/lib/aiTypes.ts`, `AIChat/components/ModelPicker.tsx` |

| ~~**The AI script-authoring pipeline is BUILT and UNIT-TESTED but not yet wired into the chat UI.**~~ **CLOSED 2026-08-20.** The last hop is done. `ChatView` now runs the validation ladder in front of `draft_object_script` (`AIChat/lib/draftGate.ts`): a draft that fails L0-L2, or that passes them and then THROWS in the L3 dry run, comes back as the TOOL RESULT so the chat s own agentic loop performs the repair -- no second repair loop, because the chat already had one. `ModelPicker` runs `probeModel` behind a Test this model button and shows the measured verdict, cached per (provider, model) in extension settings. Two deliberate exclusions: `run_script` is NOT gated (it is the execute-now path the user asked for explicitly, and it is undoable), and the gate FAILS OPEN when the dry-run command is unavailable, because a gate that turns its own failure into a refusal gives the user nothing to act on. | `AIChat/lib/draftGate.ts`, `AIChat/lib/probeRunner.ts`, `AIChat/components/ChatView.tsx`, `AIChat/components/ModelPicker.tsx` |

| ~~**The verification ladder stops at static checks, and static checks are blind to the larger half of what goes wrong.**~~ **CLOSED 2026-08-20 (L3).** `ai/dryrun.rs` + `ai_dry_run_script` run a candidate against a CLONE and report the diff; `mcp/tools.rs` split into `run_script_isolated` (runs, applies nothing) and `run_script_with_model` (that + apply). `fixture` seeds the clone before the run and `read_back` reports named cell values after it, so a preview can be made deterministic. The write-invariant is asserted at the layer that implements it (`a_run_never_mutates_the_callers_grids`, `core/script-engine/src/notebook.rs`) as well as end to end. **Wiring it in front of `draft_object_script` was wrong three times over, and none of its own tests could see it because they doubled the backend** — see the two rows below. Measured 2026-08-19 with the M5 corpus against a real local model: of eleven failures, **six were VALID scripts that simply did not do the job** — they parse, invent nothing, declare their capabilities correctly, and call none of what the task needs. The M7 repair loop stopped after one round on each, because the validator honestly reported `ok: true`. **L0-L2 cannot see "correct but useless".** The other five failures were still invalid after exhausting all four rounds, one never parsing at all — more rounds do not rescue a model that cannot hold the API in its head. §5 of the design doc lists **L3, a dry run over cloned grid state with a diff**, and M2 did not build it: the substrate exists (the QuickJS realm already executes over a clone, `ReachClass::Grid`) but there is no NON-APPLYING entry point — `tools::execute_script` is undoable-and-applied, which is not the same thing. Until L3 exists the repair loop can correct syntax and policy but never behaviour, and an eval score flatters a model by exactly the six-in-eleven it cannot see. Measured numbers: one-shot 0/12 at mean 0.550, four repair rounds 1/12 at mean 0.646. Design: `docs/design/local-model-script-authoring.md` §5, M7. | `scriptHost/scriptValidation/index.ts`, `scriptHost/scriptAuthoring/index.ts`, `mcp/tools.rs` |
| ~~**An `async` script body silently did nothing, and reported SUCCESS.**~~ **CLOSED 2026-08-20.** QuickJS parks everything past the first `await` on a job queue and NOTHING in the engine drained it: the body ran to its first `await`, `eval` returned, the grids were read back unchanged, and the run reported `Success` with `cells_modified: 0`. Not AI-specific — it reached every notebook cell, one-off script and MCP `execute_script`; found only because a dry run's "ran fine, changed nothing" is the single most misleading verdict a checker can give. `runtime::drain_jobs` now drains both run paths INSIDE the armed deadline (a chain that never settles is cut by the same budget; no iteration cap, which would cut a long-but-finite one short) and on the error path too (the notebook session is persistent, so a job left queued by cell N would resume against cell N+1's grids). Unhandled rejections now fail the run through a deliberately ASYMMETRIC tracker: a late-handled rejection CLEARS what was recorded, because QuickJS calls the tracker even for an ordinary `try/catch` around an `await`. Six guards, each sabotage-verified to red its own assertion. | `core/script-engine/src/runtime.rs` (`drain_jobs`), `core/script-engine/src/limits.rs` (`Rejections`), `core/script-engine/src/notebook.rs` |
| ~~**`export function setup(context)` — the shape the docs, the typings and the AI prompt all teach — could not MOUNT.**~~ **CLOSED 2026-08-20.** `wrapModuleSource` splices the user body INSIDE a function, where an `export` declaration is a SyntaxError. It stripped `export default` and `import`, never a bare `export`. A script could pass every static check and then fail at mount. It went unnoticed because the production path that works (`MacroRecorder`'s codegen) emits `function setup(context)` with no `export`, while `export function setup` lived in the docs, the generated IntelliSense typings, this feature's prompt and every one of its tests. The keyword is now BLANKED rather than deleted, so line AND column numbers survive for breakpoints and stack traces. | `app/src/api/scriptHost/worker/debugWrapper.ts`, `worker/__tests__/debugWrapper.test.ts` |
| **A dry run cannot faithfully preview an OBJECT script, and now says so instead of guessing.** The Worker realm's `context` exposes **358** `api.*` members; the interpreter realm the preview runs in shares **NINETEEN** of them, and of the 16 chains the prompt always shows, **four**. `ai_dry_run_script` returns `applicable: false` with a reason for any source this realm cannot host, having run nothing, and every consumer branches on it — before that gate, L3 rejected every valid object script with "it FAILS when run against a copy of the workbook", so the model spent its repair rounds fixing correct code. **2026-08-20 addendum (adversarial review):** the decline HEURISTICS are substring/line checks, so they both under-decline (`const setup = (c) => …` with no literal `context.api.` is judged in the wrong realm and its runtime error reported as the draft's) and over-decline (a comment or template-literal line starting `export ` / mentioning `context.expose(` suppresses L3 for a plain script that could have been judged). **Both were then CLOSED for every production caller (2026-08-20): `ai_dry_run_script` takes an explicit `surface` label — draftGate says `object-script` (declined authoritatively, its drafts ARE object scripts by definition) and a labeled `one-off` is judged with no heuristic able to suppress the verdict, since for that realm a syntax error on `export` is CORRECT. The substring heuristics remain only for unlabeled callers.** What remains OPEN is the faithful version: running the draft in the realm it actually runs in (the Worker), which needs a grid backend a preview has no document for. Emulating 5% of a surface and reporting the gaps as defects is not a cheaper version of that. | `app/src-tauri/src/ai/dryrun.rs` (`declined_reason`), `AIChat/lib/draftGate.ts`, `scriptHost/scriptAuthoring/index.ts` |
| ~~**`stripModuleSyntax` is a regex pass over source it cannot actually tokenise — six confirmed edge defects, one of them silent data corruption.**~~ **CLOSED 2026-08-20, the recommended way: the five regexes are gone**, replaced by a single tokenizer-aware pass that tracks string / template (with `${…}` nesting) / comment state character by character. All six defects have pinning tests: template-literal lines are DATA and survive verbatim (the silent-corruption member), a `}` in a comment cannot truncate a specifier list, code trailing an import on the same line survives, `export` split from its declaration by a newline is stripped, mid-line `export` after a statement is stripped — which also made the DEBUG-mount strip-before-instrument ORDER stop mattering (pinned: even the wrong order now compiles) — and property keys / member access / dynamic `import()` are untouched. Unknown or malformed module syntax is left alone: a loud SyntaxError at mount beats a silent partial rewrite. The severe member: a line INSIDE a multi-line template literal that starts with `import ` / `export {` / `export *` is blanked, silently corrupting the string's runtime VALUE (the `import` half of this predates the strip rework; the specifier forms widened it). The loud members: a `}` inside a comment within a multi-line specifier list truncates the strip and leaves a stray `};` that breaks the wrapper; real code after `import …;` on the same line is blanked with it; a line break between `export` and its declaration defeats every pattern (and the validator ACCEPTS that form, so it passes L0-L2 and dies at mount — the exact asymmetry the strip exists to close); mid-line `export` after a statement is untouched for the same reason. The fix is one tokenizer-aware pass (string/template/comment state tracking) replacing all five regexes — a bounded task for its own session; patching regexes individually is how the list got this long. | `app/src/api/scriptHost/worker/debugWrapper.ts` (`stripModuleSyntax`) |
| ~~**The setup-only context binding traded false rejections for false passes, and the trade is not yet closed.**~~ **CLOSED 2026-08-20.** Both gaps fixed, each guard erring toward NOT binding (a false rejection is the worse failure): (1) the literal `context` is now bound UNCONDITIONALLY — the wrapper's parameter is reachable by closure from anywhere in the script — unless anything declares its own `context`, in which case a name-keyed binding set cannot express per-scope shadowing and the whole rule steps aside; (2) call-flow binding: a helper's parameter is bound when EVERY call site passes a context-bound identifier at its position and the name is declared exactly once in the script, to a fixpoint (context handed helper-to-helper is followed). Pinned: invented member inside a context-fed helper flagged, two-hop flow flagged, polymorphic helper NOT bound, shadowed local `context` NOT flagged, stray top-level `context.caps.fetch` beside `setup(c)` flagged. Residue, stated: a helper whose param name is reused elsewhere, or that is also called with non-context arguments, stays unexamined — conservative by design. Two confirmed gaps from the narrowing (which itself fixed drafts being REJECTED for an exported helper's ordinary JS): (1) a helper that RECEIVES the context — `setup(context) { helper(context); }` / `helper(ctx) { ctx.api.setCellValu(…) }` — is invisible to L1/L2, so an invented member or undeclared capability inside it passes static checks, and the dry run declines object scripts so nothing downstream catches it either; (2) the bare-`context`/`ctx` fallback walk only runs when NO binding was found, so when `setup` names its parameter something else, a stray top-level `context.caps.fetch(…)` — which WORKS at runtime, the wrapper's parameter is literally `context` — is unexamined. Proper fix is modest intra-procedural flow (bind parameters of functions that are CALLED with a context-bound argument, and always bind the wrapper's literal `context` at top level, scope-aware to avoid re-introducing false rejections on shadowing). | `app/src/api/scriptHost/scriptValidation/analyze.ts` (`collectContextBindings`) |
| **L3 knows a script RAN and CHANGED something; it does not know the change was RIGHT.** `fixture` + `read_back` are built — the half that has to exist first — but the corpus carries no per-task expectations and the scorer does not read cell values back. Until it does, an eval score still flatters a model by everything a diff cannot distinguish. | `tests/eval/tasks.json`, `tests/eval/run-eval.mjs`, `app/src-tauri/src/ai/dryrun.rs` |
| ~~**Aborting a pending JOB corrupts the QuickJS runtime, and the notebook session is reused afterwards.**~~ **CLOSED 2026-08-20.** Measured: a cell whose continuation spins is cut by the deadline interrupt DURING job execution, and dropping that runtime trips QuickJS's own `p->ref_count > 0` and kills the process with `STATUS_STACK_BUFFER_OVERRUN` — *after* the harness has printed a green result. It became reachable only once `drain_jobs` made queued continuations run at all. **The distinction that shaped the fix is sharp and was measured, not assumed: a cell that merely times out during `eval` — nothing ever queued — drops perfectly safely; it is aborting a JOB that corrupts.** So `NotebookSession::is_poisoned()` is set ONLY when a job faulted, and the executor retires such a session with `std::mem::forget` rather than dropping it — `session = None` there IS the crash. Narrow on purpose: an ordinary error, and an ordinary eval timeout, keep the session, because the user's notebook globals are the whole point of a persistent one and nothing corrupted them. **Residue, stated rather than hidden:** a poisoned runtime is LEAKED (bounded by how often a user's `async` continuation outruns the cell budget — rare and always user-visible), and the underlying unwinding bug is upstream in QuickJS. Guards: both directions of the flag are sabotage-verified, and the executor's leak-don't-drop wiring is pinned by a test that reads it. **Same-day addendum, found by the session's adversarial review of its own fix: the notebook was only HALF the surface.** The ONE-OFF path (`ScriptEngine::run` -> MCP `execute_script`, the chat's `run_script`, calp, and `ai_dry_run_script` itself) still dropped its runtime unconditionally, so a drafted script with a runaway `async` continuation crashed the app during the "safe" preview. Fixed the same narrow way: on a faulted job the `ScriptContext` is recovered via `RefCell::replace` (an `Rc::try_unwrap` can never succeed under a leaked runtime, and the caller still needs its console output), then runtime + context are `mem::forget`-ed; grids were already withheld on every error by design. Guard: `a_job_abort_in_a_one_off_does_not_crash_the_process` (`core/script-engine/src/lib.rs`), red-under-sabotage = the crashed binary itself. | `core/script-engine/src/notebook.rs` (`is_poisoned`), `core/script-engine/src/runtime.rs` (`drain_jobs`), `app/src-tauri/src/scripting/notebook_executor.rs` (`a_poisoned_session_is_leaked_rather_than_dropped`) |
| ~~**An async handler in the EXTENSION worker realm fails completely silently.**~~ **CLOSED 2026-08-20.** `dispatchAppEvent` now collects the handler's thenable and reports its rejection through the same `post({t:"error"})` a synchronous throw uses — the object-script twin's fix (`contextShims.ts` `dispatchEvent`), applied to the twin that never received it — and returns the settle promise so a caller can know when a dispatch is OVER. The realm also gained the `unhandledrejection` backstop it never had, UNCONDITIONAL where the object-script twin's is debug-gated: this realm has no debugger, and handler dispatch never lands there (`invokeHandler` awaits; `dispatchAppEvent` collects), so anything reaching it is a rejection NO code path observes — an extension's own floating promise, or `showToast`'s deliberately discarded `brokerCall`. **An adversarial review of the fix hardened both twins beyond the filed defect:** `.then` can be a throwing GETTER and `Promise.resolve()` reads `constructor` synchronously, so a hostile handler return value threw past dispatch entirely — out of `onmessage`, invisible to the backstop (a sync throw, not a rejection), and in the object-script twin it aborted the remaining handlers in the loop. The thenable probe now sits INSIDE the try in both realms, and the backstop survives a poisoned rejection reason (throwing `message`/`stack` getters get the generic line, never silence). Nine pinning tests (`extensionAppEventDispatch.test.ts`) + two added to the twin's (`hookDispatchCompletion.test.ts`), including the settle-coupling case a decoupled return would pass every same-microtask test on, and a source-reading guard on the backstop — the bootstrap hardens globals at import so no unit test can drive it; the guard pins top-level registration and NO GATE, because "match the twin" is the exact refactor that would silently reopen the hole. Four sabotage rounds, each redding exactly its own assertion. **The residue this row originally stated was CLOSED the same day, all three members:** the deactivate/terminate race (next paragraph of this row), the menu-click swallow (the next row), and the writeback watch acquiring via `import(…).catch(() => null)` — the catch now writes a console line naming the extension, because a silent null left the subscription PERMANENTLY inert (the publisher-inbox poll never starts, so `WRITEBACK_SUBMISSION_RECEIVED` never fires for that subscriber). **The deactivate race, as built:** teardown was ALSO the last silently-swallowed error path in the realm — `handleDeactivate` and `runDeactivate` caught sync throws with `/* best effort */` and saw async rejections not at all, and the only flow that sends "deactivate" called `worker.terminate()` after one awaited backend call, so an async teardown's final broker write (and its failure report) died with the realm. Now: both teardown hooks are awaited with sync throws AND rejections reported as `{t:"error"}` (guarded extraction, hostile-reason-proof), the worker posts a new `{t:"deactivated"}` ack when teardown genuinely finished, and `unmountWorkerExtension` holds `terminate()` for that ack bounded by `EXTENSION_DEACTIVATE_GRACE_MS` (2s) — attached before the post so a synchronous reply cannot be missed, and skipped entirely for a dead worker so a crashed realm does not cost every unmount the full window. The ack-ordering test's first version PASSED under sabotage — "terminated is still false after N microtasks" is also true of an implementation that merely takes N+1 — and was rewritten around the discriminating fact (the unmount PROMISE must not settle before the ack); the wedge path is pinned under fake timers. **A second adversarial round found the ack contract itself refutable through a POISONED reason** — the report closures extracted `message`/`stack` unguarded, so a thrown `{toString(){throw}}` escaped `runDeactivate` synchronously, and an Error whose own `message` held a function passed extraction and made `postMessage` throw DataCloneError from inside the error path — either way the ack was skipped and every unmount paid the full grace window. One shared `describeError` in `workerHardening.ts` (guarded extraction AND string-coerced results) now feeds every report site in BOTH realms, the bootstrap's `runDeactivate` await is try-wrapped anyway (the ack must not depend on "never rejects" staying true), and both poisoned shapes are pinned, sabotage-verified. | `scriptHost/worker/extensionWorkerContext.ts` (`dispatchAppEvent`, `runDeactivate`), `worker/extensionBootstrap.ts` (`handleDeactivate`), `worker/contextShims.ts` (`dispatchEvent`), `extensionWorkerHost.ts` (`unmountWorkerExtension`), `worker/__tests__/extensionAppEventDispatch.test.ts` |
| ~~**A failed extension menu-item click is indistinguishable from a successful no-op.**~~ **CLOSED 2026-08-20.** Both branches of the click `action` — `CommandRegistry.execute` and the direct `invokeWorkerHandler` relay — now `.catch` into one `clickFailed` that writes `console.error("[ext:…] menu item … failed:")` and shows an error toast carrying the SAME host-drawn attribution as the item's label (`"Boom (Test Add-in)" failed: …`), so all three rejection modes surface: handler threw, 5s invoke timeout, unmount mid-flight. The toast's message half is `echoSafe`d — it is worker-supplied text (BrokerError relays it verbatim), and an unsanitized failure notice under host-drawn attribution is a spoofed-chrome canvas, the exact thing `refuseContribution` guards against. Two tests drive the registered item's real `action` through the FakeWorker for each branch; sabotage (`.catch(() => {})`) reds both, and a hostile-message test pins the sanitization. **Same-day adversarial review of the unmount grace window closed two adjacent holes it widened:** a `register` delivered after the regCleanups drain (the `await revokeBackendCapabilities` gap) installed a live menu item/formula on the drained map — cleaned up by nobody, invisible to the transparency panel; `setupRegistration` now refuses anything from an extension no longer in `mounted` (the pinning test's first version passed under sabotage because its register landed BEFORE the drain and was cleaned by ordering luck — rewritten around the post-drain delivery). And a JIT capability consent dialog raised during the grace window could be answered AFTER `revokeScriptGrants`/`revokeBackendCapabilities`, re-creating live grant state for a terminated worker and genuinely executing the guarded operation; `maybeRequestCapabilityGrant` now checks liveness before showing the prompt AND before recording the answer. Residue, stated: the orphaned dialog itself is not force-closed on unmount (it times out at 60s; answering it now grants nothing). | `scriptHost/extensionWorkerHost.ts` (`setupRegistration`, `clickFailed`, `maybeRequestCapabilityGrant`), `__tests__/extensionContributions.test.ts` |
| **Every `// @uses` script is debugged one line off.** The library prelude ends with `\n`, so `link.prelude + definition.source` puts the author's line 1 on blob line 2. `parseStack` (`debugRuntime.ts:210`) then reports every frame one line too high: breakpoints match the previous statement, and the call-stack view and any surfaced error stack point at the wrong line. Nothing compensates — there is no line offset anywhere in the debug path — and the guard test ASSERTS the trailing newline, so the bug is pinned rather than caught. Being one line bounds the damage; it does not remove it. | `scriptLibraries/linker.ts:340`, `scriptHost/worker/debugRuntime.ts:206-211` |
| **`codeInventory` files object-script macros under the wrong realm, understating what they can reach.** It classifies every module-store record as the grid-only Rust-QuickJS `one-off-script` surface. But the Macro Recorder saves object-script macros into that SAME store with a `runtime=objectScript` marker, and `runMacroModule` routes exactly those to the other realm — `runObjectScriptOnce({ … accessLevel: "unlocked" })`, a real hardened Worker mount with a declared-capability ceiling. The transparency panel therefore reports a strictly smaller reach than the code actually has, which is the one direction a transparency surface must never err in. `parseModuleScriptRuntime` already exists and is not consulted. | `api/codeInventory.ts:430`, cf. `MacroRecorder/lib/macroLibrary.ts:361-367` |
| **The shared Monaco lane type-checks both script realms against each other's globals.** Three surfaces register on lane `"javascript"`: the notebook (which loads `calcula.d.ts` — `Calcula`, `model`, `display`), object scripts, and one more. The file names this hazard and then applies the mitigation only to the lane object scripts are NOT edited on, so `Calcula.*` autocompletes and type-checks clean inside an object script (where it does not exist), and the notebook inherits object-script suppressions. Wrong-realm globals look correct in the editor in BOTH directions — the same realm-confusion that made `export function setup` pass every check and fail at mount. | `extensions/_shared/lib/monacoScriptLanes.ts:39`, `authoringLanguage.ts:102-107` |
| **One unparseable module breaks EVERY in-cell button.** The in-cell button preamble concatenates every module in the workbook script store into ONE source string and hands it to the Rust QuickJS realm, with no per-module compile guard. `listWorkbookScripts()` returns object-script modules too — Worker-realm source authored against `context`/`api.*`, which that realm cannot parse — so a single such module makes the whole concatenated preamble fail and every in-cell button stops working, not just the one whose module is bad. The FLOATING-button twin in the same extension has the per-module guard; the in-cell path does not. | `extensions/Controls/Button/interceptors.ts:127` |

### 2.2 The `Persisted<T>` migration — the SAVE SOURCES are done (2026-08-17); the rest is not

`AppState` has **104 fields**: **62** are `Persisted<T>`, **40** are still a bare
`Mutex`/`RwLock`, and 2 are neither — `undo_stack` and `calc_cancel`. **These four numbers are
PINNED by `the_appstate_lock_census_reconciles` (`document_effect.rs:1191-1228`), which parses the
struct body and fails the build when the split moves.** Do not re-derive them by hand and do not
edit them here without running that test — the figures above stood at 59/43 until 2026-08-18 while
the test already said 62/40, which is exactly the drift this file exists to prevent. (Do not read "neither" as
"unlocked": `undo_stack` is `undo_history::UndoHistory` (`lib.rs:392`), which holds its own
`Mutex<UndoStack>` (`undo_history.rs:125-127`) precisely so every existing `.lock()` site stays
unchanged. Only `calc_cancel` is genuinely lock-free — `CancelToken(Arc<AtomicBool>)`. An earlier
wording said "unlocked", which invites someone to add a Mutex and double-lock it.) Only the
`Persisted<T>` ones force a command to name a `DocumentEffect`, so a command touching only the
remaining 40 can still mutate without deciding — the exact hole `DocumentEffect` was built to close.

**The 40 are not one population, and the previous summary of them was wrong in both directions.**
Classified by opening each: roughly **22 are derived/rebuildable** (the 16 dependency maps
`lib.rs:342-385`, `computed_prop_dependencies`/`dependents`, `spill_hosts`, `spill_blocks`,
`gather_cache`, `writeback_index`, `id_registry`) — about half, not "overwhelmingly". And **11 are
application preferences that must NEVER become `Persisted<T>`**: `calculation_mode`,
`iteration_enabled`, `max_iterations`, `max_change`, `locale`, `reference_style`,
`precision_as_displayed`, `calculate_before_save`, `auto_recover_enabled`,
`auto_recover_interval_ms`, `subscriber_identity`. Those are the USER's, not the document's, and
`document_store_census_tests.rs`'s `SESSION_SCOPED` table records each with its reason. So the row
overstated the backlog (11 of the 40 are permanent exemptions, not work) while understating the one
real risk. Declare any NEW persisted store `Persisted<T>` from the start.

**CLOSED for the part that could lose data (2026-08-17).** All three save sources named below were
promoted to `Persisted<T>`, and the class is now guarded by derivation rather than by a list:
`every_store_the_save_path_reads_is_gated_by_a_document_effect`
(`document_store_census_tests.rs`) takes the population the reset census already computes —
`store_accesses(call_closure(&fns, SAVE_ROOTS))` — and requires every `AppState` field in it to be
`Persisted<T>`. A new `collect_*_for_save` reading a bare `Mutex` now fails on the commit that adds
it. Sabotage-verified: bypassing the one exemption makes it report that field by name.

Building the census found **a third offender the audit had missed** — `pending_recalc`, written into
the saved workbook by `attach_pending_recalc_for_save`, whose failure mode is the one the `.cala`
versioning rule names as a LIE rather than a loss: *a stale workbook that comes back looking
calculated.* It also found a **fourth** store, `protected_regions`, which is the single exemption:
it never reaches a `.cala` at all (one hit in `persistence.rs`, the reset) and the extensions that
own it re-register it every session, so `mutates` would be a false statement about it. Two further
assertions stop that exemption outliving its subject or excusing something already gated.

Three incidental fixes fell out, each a guard that had gone quietly blind:
- `ACCESSORS` in `document_store_census_tests.rs` was `["read","write","lock"]` — missing
  `lock_pending`, so **every gate-then-decide site was invisible to both censuses in that file**.
- The spill deadlock census keyed on the literal `spill_ranges.lock(`; once the store became
  `Persisted`, that spelling stopped existing and the census would have passed **vacuously over the
  whole crate**. It now covers all three accessors, and its sample exercises each.
- The 104/62/40/2 split is now pinned by a test (`the_appstate_lock_census_reconciles`), because it
  has been published wrong four times — including once during this very pass, by a counter that split
  the struct by LINES and so mistook `package_connection_restore_skips` (whose type wraps) for a field
  with no lock.

**Still open:** the remaining 40 bare-lock fields, none of which the save path reads.

**Two of the 40 are read by the SAVE path, and here they are by name** — "check the field before
assuming it" put the burden on a reader with no list, which is how these stayed invisible:

- ~~**`spill_ranges`**~~ **PROMOTED.** `apply_spill_extents_to_sheet` calls itself "the only
  authority for which origin owns which cells"; it runs from the save assembler and `zip_io.rs`
  stamps the `.cala` v7 `spill_extents` feature on that field's presence. It looks like a derived
  cache and is not one — `spill_restore.rs`'s header is worth reading before touching it: a spilled
  `2` and a typed `2` are the same bytes, so ownership cannot be recomputed at any price. Its two
  recalculation writers name `CleanReason::RecalcCompanion` (the triggering edit owns the flag) and
  its load-path writers name `LoadingFromDisk`.
- ~~**`advanced_filter_hidden_rows`**~~ **PROMOTED.** Unioned into `hidden_rows` at save. Its three
  writers had hand-rolled `DocumentEffect::mutates` as a discarded `let _effect` — a convention, now
  a compiler-enforced fact. They use `lock_pending()` + `authorize()`, because the effect must be
  built AFTER the gate (a clear that finds nothing must not dirty) and `read`-then-`write` would open
  a TOCTOU window on Tauri's thread pool.
- ~~**`pending_recalc`**~~ **PROMOTED** — found by the census, not the audit. See the banner above.

Also not derived caches, though not save sources: `protected_regions` (`:426`), `next_cf_rule_id`
(`:452`), `next_computed_prop_id` (`:462`), and `scroll_areas` (`:573`, whose own comment documents a
missing-persistence gap).

**The guard that looked like it covered this did not** (open-items rule 4, again) — which is why the
new census derives its population instead.
`every_persisted_appstate_store_is_gated_not_a_bare_mutex` (`document_effect.rs:1037-1088`) reads
exactly like the enforcement this row wants, but `must_be_gated` is a **hand-written allow-list of 22
field names** — it asserts those 22 still say `Persisted<` and is structurally blind to anything not
on it. Neither save source appears in it. `document_store_census_tests.rs` covers reset-on-open, not
gating, and both save sources *are* reset (`persistence.rs:4121`, `:3914`), so that census passes
while saying nothing about this. The missing guard is the parse-don't-list one: derive the save
sources by parsing `build_workbook_for_save` for `state.<field>.lock()` and fail if any is not
`Persisted<`. **DONE for the numbers, 2026-08-18:** `the_appstate_lock_census_reconciles`
(`document_effect.rs:1191-1228`) now parses the struct body and asserts 104/62/40/2, so those
figures cannot drift again without failing the build — which is exactly how the 59/43 above was
caught. The parse-don't-list guard over the SAVE SOURCES is the part still outstanding.

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
carries no shared-formula expansion of its own to work around it. Still open; the reproduction
fixture EXISTS as of 2026-08-17 (see the next paragraph — this sentence said "still without a
reproduction fixture" until 2026-08-18, three lines above the paragraph announcing it). §3bi, §35c.
(The anchor here read `§7142` until 2026-08-17; that section does not exist — a line number into a
1.33 MB append-only archive was never going to survive, so cite the §.)

**STEP 1 DONE 2026-08-17: the fixture exists.** `a_two_dimensional_shared_formula_ref_loses_all_but_the_first_column` (`core/persistence/src/xlsx_writer.rs`) hand-builds a `.xlsx` whose `B2:D4` block is one shared formula with a 2-D `ref`, and pins exactly what is lost: the master survives, followers outside the ref's FIRST COLUMN lose their formula entirely, and the cached `<v>` values stay correct — which is what makes the loss silent, because the sheet looks right until something recalculates. The test says in its own failure message what to change when the loss is fixed.

**STEP 2 IS STILL OPEN, and the archive's "not fixable inside Calcula" is wrong.** Calcula's own XML pass (`xlsx_style_reader::parse_sheet_xml`) already walks every `<c>` inside `<sheetData>` — verified, it reads the `s` attribute at `:1063` — so it could collect `<f t="shared" ref=… si=…>` itself and reconstruct the followers without calamine at all. It also needs relative-reference translation — and **the claim that no reusable helper exists for that was FALSE, measured 2026-08-18.** `shift_formula_internal(formula, row_delta, col_delta)` (`app/src-tauri/src/commands/structure.rs:2658`) is exactly that translator, and it is not coupled to the undo machinery: it takes a formula string and two deltas and returns a string. So step 2 is a collection path plus reader wiring plus a call into an existing shifter — **hours, not a project, and it does not need a reserved slot.** The one authoring call before starting is WHERE the translation runs: app-side after `load_xlsx` (no new dependencies, the records ride out on `Workbook`) versus lowering the pure shifter into `core/persistence`. Prefer the former unless the reader needs it standalone.

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
| ~~**The oracle suppression list had no expiry check.**~~ **CLOSED 2026-08-17.** `KNOWN_ISSUES` (`e2e/oracles/knownIssues.ts`) suppresses oracle violations while a ledgered bug makes them fire, its header said "Remove the entry when the bug is fixed", and nothing compared `ledgerId` to the ledger — a comment is not an enforcement mechanism. `e2e/__tests__/knownIssueExpiry.test.ts` now fails when an entry names a bug that does not exist or is no longer `open`, mirroring `walkerExclusions.test.ts`. It lands green because the list is empty, so the third test runs the SAME predicate against a synthetic stale list — otherwise the two real cases would pass even with a broken predicate. This list is where the failure mode was first seen: a stale entry kept swallowing violations, and because the filter suppresses when EVERY digest-diff path is covered, one stale prefix hides that subtree from ANY cause. | `e2e/__tests__/knownIssueExpiry.test.ts`, `e2e/oracles/knownIssues.ts` |
| ~~**The soak walker's formula alphabet is six formulas.**~~ **CLOSED 2026-08-17 — and the reason it had stayed at six was FALSE in both halves.** "Widening it changes what the committed seeds mean" assumed committed seeds; there are none (seeds default to `Date.now()`, every walk artefact under `e2e/results/` is gitignored, and the committed replayables are inline `ActionTrace` literals with EXPLICIT recorded params that replay never re-picks). And `pick` consumes exactly ONE rng draw whatever the list length, so for a fixed seed the action sequence is byte-identical — only the formula text in G10:G12 moves. Now 16 entries, exported, with `walkerFormulaAlphabet.test.ts` enforcing the FOUR constraints that actually matter (sv-SE `;` separators; no volatile function, read from the oracle's own exported regex; nothing that spills into the 2x3 write block; no literal "Test", which `replace.all` rewrites mid-walk) plus a fifth on the ranges `structure.*` mutates. All five sabotage-checked independently. | `actionCatalog.ts`, `e2e/__tests__/walkerFormulaAlphabet.test.ts` |
| ~~**Only charts are re-synced after the walker's `new_file`.**~~ **CLOSED 2026-08-17, and the case was understated.** The reset's OWN table teardown announces `objects` / `slicer` / `ribbonFilter` a few hundred ms BEFORE `new_file`, and the Shell fans `objects` to `sparklines:refresh` and `slicer` to BOTH `slicers:refresh` and `timelineslicers:refresh` — so FOUR more stores are actively repopulated from the outgoing document and then stranded. Sparklines are the worst: `stateSnapshot` reads their groups from the STORE (charts and slicers come from the backend), so a stale store satisfies `sparkline.delete`/`select-into` and `saveToBackend` then writes the PREVIOUS document's groups into the new one — corruption authored by the harness and reported as a product finding. Pane controls were a LEAK not a race: nothing reached them at all. | `e2e/walker/reset.ts` |
| ~~**The two `evaluate-formula` goldens assert residue, not their feature.**~~ **CLOSED 2026-08-17; baselines re-recorded 2026-08-18.** Both are now region captures of the cells the spec itself writes (`AI1:AI3` and `AI9`) instead of whole-grid shots in which 26 of 27 framed columns belonged to other specs — the visible content and even the percent format on AI2 were `edge-cases.spec.ts`'s residue. `takeGridRegionScreenshot` frames the range and parks the selection away from it, so the `navigateTo` that was part of the problem is gone.

**The re-record could not be done at dpr 2, so the whole corpus moved to dpr 1.** This row
used to say "on a 200% display this is one command". That instruction was unfollowable on this
hardware, and the measurement is worth keeping so nobody tries again:

```
scaling  dpr  logical desktop  viewport    grid canvas layer
100%      1   2560x1440        1280x800    1218x542   <- SIZE ok, DPR wrong
200%      2   1280x720         1280x700    1218x442   <- DPR ok, SIZE wrong
```

The corpus needs an 800-tall viewport, and 200% scaling caps the logical desktop at 720. The width
is exactly 1280 in BOTH modes, so this is the panel, not a setting — no configuration recovers dpr 2
at the size the corpus requires. All 70 goldens were therefore re-recorded at dpr 1 and
`captureEnvironment.ts` now states 1. Verified afterwards by reading the committed BYTES, which is
what `goldenCorpus.ts` exists for: **72 files, 58 classifiable, all dpr-1, 0 dpr-2, 0 ambiguous.**

The command that did it:

```powershell
cd app
npm run e2e:manual -- e2e/tests/evaluate-formula.spec.ts --update-snapshots
```

**Write it exactly like that.** The obvious bash spelling breaks in two ways on this project's
shell, and the second failure is strange enough to cost an hour:

- `\` is NOT a line continuation in PowerShell (a backtick is), so a wrapped command runs its
  second line as a SEPARATE command. PowerShell then shell-executes the bare path
  `e2e/tests/evaluate-formula.spec.ts` — and on Windows **`.ts` is registered to MPEG transport
  stream**, so the MEDIA PLAYER opens. Nothing in that outcome points at Playwright.
- `E2E_MANUAL=1 npx ...` is POSIX prefix syntax and sets nothing in PowerShell. That is why every
  `e2e:*` script in `package.json` goes through `cross-env` — use the script rather than
  re-spelling the variable at the prompt.

Do NOT pass `--reporter=...` on that run: it replaces the reporter list and the collection guard
fails the run by design. `softly()` does not suppress a MISSING snapshot, which is deliberate — it
forces the re-record to be a decision rather than a silent pass. | `e2e/tests/evaluate-formula.spec.ts`, `e2e/captureEnvironment.ts` |
| ~~**The journey project has no side-panel residue guard.**~~ **CLOSED 2026-08-16.** `e2e/journeys/zz-persisted-residue.spec.ts` now runs last and asserts the app-owned storage namespaces are at their DEFAULTS. Two corrections came out of building it, both worth keeping: (1) the guard must assert *value is default*, not *key is absent* — its first draft failed on a clean app because `calcula-task-pane` and `calcula-panel-placements` are `zustand/persist` stores that write themselves on hydration, and a check that reds a clean run is one somebody switches off; (2) the 1218 -> 898 px canvas class is **not** this key — `partialize` persists only `{width, dockMode}` and deliberately omits `isOpen`, so an open pane cannot survive a reload at all. The teardown side is necessary but insufficient, so the same catalogue also drives a reset on the way IN (next row). | `e2e/journeys/zz-persisted-residue.spec.ts`, `e2e/volatilePersistedState.ts`, `useTaskPaneStore.ts:219-224` |
| **Cleanup-on-exit cannot run when the app is dead — so the reset moved to run START.** `shapes-hometab.spec.ts` test 8 *does* restore the ribbon in a `finally`; on 2026-08-16 the app wedged mid-test, `restoreDefaultHomeLayout` needed a living app to reload, and it swallowed its own failure. The injected `rowBreak` survived into the next project, which failed `ribbon-core-default-ribbon.png` with `deleteColumn` clipped out — the visual project reporting a red golden for something no visual spec did. `e2e/volatilePersistedState.ts` now sweeps the app storage namespaces by PREFIX immediately after `assertAppMounted`, when the app is known-healthy. It sweeps rather than lists because the `ext.<extensionId>.<key>` family cannot be enumerated even in principle. It reports a leak **only** when a cleared value was non-default; a sweep clears something on essentially every run, and an alarm that always fires is one nobody reads. | `e2e/volatilePersistedState.ts`, `e2e/global-setup.ts` |
| ~~**Completed Playwright runs leave orphaned process trees.**~~ **CLOSED 2026-08-17.** The teardown fired ONE `taskkill /F /T /PID` with `stdio: "ignore"` inside a bare `catch {}` and then printed "[e2e] Tauri stopped." **unconditionally** — a refused kill and a clean exit produced the same sentence. Worse, the recorded pid is the `cmd.exe` wrapper `spawn({shell:true})` made, and `taskkill /T` walks LIVE parent links, so once yarn/cargo exit (which is what a journey spec closing the window causes) the surviving `app.exe` is unreachable from it — a check that polled only the recorded pid would have passed on every run that actually orphaned something. `e2e/processResidue.ts` now records the app's OWN pid, kills what this run recorded, and POLLS until the pids are dead and 9222/5173 are free before claiming success. The run-start report lives in **global-setup**, because the teardown returns before its kill under `E2E_MANUAL=1` and that is how 11 of the `e2e:*` scripts are driven. It REPORTS and never kills unattributed processes: another agent builds from the same `CARGO_TARGET_DIR`, and killing one of those is a measured past defect. It also never names `msedgewebview2` — pinned by a source assertion, because those processes belong to Windows SearchHost too. Incidental find: `scripts/kill-stale-dev.mjs` matches the **in-repo** `src-tauri/target` only, so it cannot recognise an app built into the `CARGO_TARGET_DIR` this project mandates; `processResidue` asks `resolveBuildTarget` instead. | `e2e/processResidue.ts`, `e2e/__tests__/processResidue.test.ts`, `global-teardown.ts`, `global-setup.ts` |
| ~~**The corpus census counted hairline PIXELS, so UI chrome read as a capture-path split.**~~ **CLOSED 2026-08-18.** Immediately after the dpr-1 re-record, `goldenCorpus.test.ts` reported "THE GOLDEN CORPUS HAS SPLIT ACROSS TWO CAPTURE PATHS" and named two files. Both were false alarms: `ribbon-ribbon-tab-insert.png` (172 px) and `autocomplete-dropdown-visible.png` (916 px) contain **no grid at all** — `#F1F1F1` is the app's chrome grey as well as the dpr-2 hairline, so a ribbon band and a dropdown crop cleared the 50-pixel floor. Raising the floor could not fix it, and that is the useful half: a genuine small crop, `grid-comments-cell-with-indicator.png`, holds **108** hairline pixels — FEWER than the 172-pixel false positive. The populations do not separate by count in either direction. They separate completely by STRUCTURE, because a gridline is a LINE: measured over all 60 goldens holding either constant, the smaller of (rows containing it, columns containing it) is **0.2% and 2.4%** for the two chrome blobs and **65.1%–96.1%** for every real grid capture — a 27x gap with nothing in it. `readHairline` now requires that span and reports it. A guard that reds a clean corpus is one somebody switches off. | `e2e/goldenCorpus.ts`, `e2e/__tests__/goldenCorpus.test.ts` |
| ~~**`validate-baselines.mjs` reported a FAIL on every clean run, by parsing its own summary table.**~~ **CLOSED 2026-08-18.** The verdict tally accepted any line containing `**fail**` or `**concern**`, which matched the review's closing table (`| **FAIL** | 0 |`) — so a review whose own table said "FAIL 0" was counted as "1 FAIL", and `failCount` is what decides whether the script says baselines "need attention". Measured on the real 2026-08-18 report: tallied **27 PASS / 2 CONCERN / 1 FAIL** against an actual **26 / 1 / 0**. A second defect sat in the same loop: `includes("pass")` was tested FIRST against the whole line, so a CONCERN or FAIL whose notes contained the word "passes" was counted a PASS — the direction that loses information silently. Parsing is now anchored on the `Verdict:` prefix and reads the token after it. The keyword-counting FALLBACK was deleted rather than fixed: it counted the words anywhere in the prose (the review's own instructions contain "needs to be fixed"), and its comment conceded it was "approximate but better than reporting 0/0/0" — it was not, because these counts decide the run. Unparseable output now exits 1 saying the result is UNKNOWN. | `tests/regression/validate-baselines.mjs` |
| ~~**Two functional tests fail on a CLEAN app, and neither is attributed.**~~ **CLOSED 2026-08-18 — both were PRODUCT defects, and both earlier attributions were wrong.** **(1) `macro-live-edit.spec.ts` (the linked-button macro) = BUG-0100.** The app announces "Button created at P63" and that announcement then eats the click on the button it just announced: `ToastContainer` sets `pointerEvents:'none'` on the container and explains why in its own comment, but each toast re-enabled `'auto'` on its whole 380x58 box, so the fix covered the container and not the toast. Any on-grid control in the bottom-right is dead for the 5 s a toast lives — a real user defect, not a test artefact. Two investigations reconstructed the geometry from source and reached opposite conclusions (one computed the toast's top border at y=705.6 against a click at y=705.0 and concluded it missed by 0.6 px); Blink's point hit test lands in the toast anyway. What settled it was asking the PRODUCT: `hitTestOverlays` returns HIT for the click point while `document.elementFromPoint` returns a `<div>` inside `[data-toast]`. Controlled A/B, only `Toast.tsx` differing: before, dismissal-off 1 failed / 4 passed and dismissal-on 5 passed; after, dismissal-off 5 passed. **(2) `vba-idioms-wave3.spec.ts:468` (borderOutline) = BUG-0101.** Cell borders painted at HALF weight (the border pass ran inside the per-cell TEXT clip, which discarded the outer half of every stroke) and were never device-pixel snapped, so on the fractional column axis they smeared across two pixels at ~58%/42% while the integral row axis stayed crisp — exactly the top-passes/right-fails asymmetry. **The dpr 2 -> 1 move WAS the trigger after all**, and this row's earlier "ruled out" was wrong: `samplePatch` being dpr-aware covers the SAMPLING scale, not sub-pixel raster coverage against an `isRed` predicate needing >=64.7%. At dpr 2 the surviving half-stroke is 2 device pixels so one is always fully covered — the defect was LATENT, not a regression. **Method note worth keeping:** the empty cell in (1) cost a day because the test observed only an END STATE, which cannot distinguish "the click never arrived" from "the run path broke" from "it ran and wrote nothing". That spec now asserts DELIVERY separately from OUTCOME and attaches a diagnosis on failure. | `Toast.tsx`, `cells.ts`, `cellBorders.test.ts`, `toastClickThrough.test.tsx`, BUG-0100, BUG-0101 |

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
gap was narrower and more specific than stated: nothing on the **PR path** linked the app, and the
nightly that does is self-hosted, so a runner that is offline took the only routine link check with
it silently. Four tracks changed Rust in the week before this was noticed and the first thing to
exercise the link was the E2E launcher, which failed with ~40 `LNK2001` errors. §39d.

**CLOSED for the PR path 2026-08-17: `.github/workflows/link-check.yml`.** A `windows-latest` job on
the same `push: [main]` + `pull_request` triggers running `cargo build --lib --bins` inside
`app/src-tauri` — the minimum that actually invokes `link.exe` — and then VERIFYING `app_lib.dll` is
on disk afterwards, because a fully-cached `cargo build` can report success having produced nothing.
Three constraints it obeys, each of which would otherwise be a defect:

- **Windows is not a preference.** `app/src-tauri` imports
  `windows::Win32::Security::Credentials` with **no cfg gate** (`ai_chat.rs:22`,
  `file_keychain.rs:16`, `bi/credential_cache.rs`), so the crate cannot compile on Linux at all and
  this can never fold into `ci.yml`'s ubuntu jobs.
- **No `paths:` filter.** GitHub reports a path-skipped job as **pending**, not success, so the day
  this becomes a required check every docs-only PR would block forever. If cost forces filtering, the
  correct shape is an always-running companion job that reports success.
- **`CARGO_TARGET_DIR` is deliberately unset.** The rule to point it outside the repo exists because
  the dev box keeps the repo in Dropbox; a CI checkout has no such problem, and setting it would
  silently defeat the cache key.

**The app crate's unit tests are gated too, as of the same day.** The same job now runs them, and the
three-step shape is load-bearing: a plain `cargo test --lib` cannot work on Windows, because cargo TEST
executables do not get tauri-build's embedded manifest, a manifest-less exe binds comctl32 v5, and the
app's link graph imports v6-only exports — so the binary fails to LOAD with `STATUS_ENTRYPOINT_NOT_FOUND`
(0xc0000139) before running a single test. `fix-test-manifest.ps1` patches an ALREADY-LINKED exe, so any
later link throws the patch away: build with `--no-run`, patch, then run the exe directly.

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

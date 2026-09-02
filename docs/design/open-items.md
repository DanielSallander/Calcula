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
| **The APPROXIMATE (sorted) lookup comparators rank values differently from the exact ones, so `=MATCH(1,A1:A4,1)` answers the wrong row.** MEASURED 2026-08-24 during the Excel-symbol programme, on a column holding `{1, "1", TRUE, "apple"}`: `=MATCH(1,A1:A4,1)` answers **3** where Excel answers **1**. The exact family was unified in that programme (`=`, `MATCH` type 0, VLOOKUP/HLOOKUP FALSE, XLOOKUP and the pass cache now share one predicate and agree); the APPROXIMATE family was deliberately left, and it is the last surface that disagrees with the ladder. `compare_values` ranks Number vs Text on its own rules rather than Excel's `number < text < FALSE < TRUE`. **WHY IT WAS NOT DONE WITH THE REST, and why it needs its own slot rather than a batch:** this is not a predicate swap. `SortedKeys::build` (`core/engine/src/lookup_cache.rs`) only permits binary search over HOMOGENEOUS, verified-sorted key vectors under one comparator class, so changing the ordering changes that precondition — and a binary search over a vector that is no longer sorted under its own comparator does not error, it returns THE WRONG ROW, silently, on the exact code path built to make lookups fast. It is the one remaining formula-engine change that can break lookups across the board without reddening anything. Wants a dedicated pass with a differential harness over both paths (scan vs cache) before the ordering moves at all — `lookup_cache::tests::exact_index_answers_exactly_what_the_scan_path_would`, added by that programme, is the shape to copy for the approximate path. | `core/engine/src/evaluator.rs` (`compare_values`), `core/engine/src/lookup_cache.rs` (`SortedKeys::build`), surface-vs-answer table in `memory/project_excel_symbol_alignment.md` |
| **Column-header separators are not device-pixel snapped — the same defect just fixed for cell borders.** `headers.ts:168,330` stroke at a hand-rolled logical `+0.5` instead of snapping into DEVICE space the way `grid.ts:189-191` has always done for the gridline hairline. Column boundaries are `22 + k*64.29`, so at dpr 1 every column-header tick smears across two device pixels at partial alpha rather than landing on one. Row-header ticks are on the integral axis and are fine — the identical top-crisp/side-blurred asymmetry that BUG-0101 turned out to be. **Deliberately excluded from BUG-0101's fix**, which is why this row exists: the file has 18 stroke calls and NO unit tests, and the change moves grid-bearing goldens (BUG-0101's design review estimated 49; a later byte census said 51 — recount before scheduling, and note `headers.ts` is pure CRLF while `grid.ts` and `cellBorders.test.ts` are LF). The fix itself is the parity-snap helper from `cells.ts` applied three times. | `headers.ts:165-168,327-330,442-445`, `grid.ts:189-191`, BUG-0101 |
| **`model-engine-lib` is run by no CI workflow at all.** 2,230 `#[test]`/`#[tokio::test]` functions across 145 files, executed by zero gates. `ci.yml`'s `rust-core` job sets `working-directory: core`, and `core/Cargo.toml` lists 11 members — `model-engine-lib` is not among them; `link-check.yml` builds the app crate (which COMPILES `bi-engine` through the path dependency but runs none of its tests); `release.yml` names the directory only as a cache path. So the entire BI/semantic-model engine — the thing every pivot, CUBE formula and measure evaluates through — has no automated correctness gate on any branch. Worse, **75 of those tests are `#[ignore]`d behind a live AdventureWorks database and they are the whole differential-vs-SQL corpus**, i.e. the engine's only ground truth for DAX semantics, so even a manual `cargo test` there proves less than it appears to. Adding the job is hours; deciding what to do about the DB-gated corpus is the owner's call. | `.github/workflows/ci.yml:58-72`, `core/Cargo.toml`, `model-engine-lib/` |
| **Table transformations ship without the ROW-MULTIPLYING multi-table steps — `mergeTable` (join) and `appendTable` (union).** **Narrowed 2026-08-28: the half that was "the actual work" is DONE.** `lookupColumn` shipped (model v28) and with it every piece this row said was missing — refresh **ordering** (`pipeline_refresh_order`, Kahn, driving both `refresh_all_in_memory` phase 2 and `refresh_stale`), **cycle rejection at model build** naming the members, the data-provider seam (`TableSchemas` for columns / `StepInputs` for rows, so schema derivation stays offline and row access stays in the facade), transitive cache invalidation (`drop_table_cache_and_dependents`), and dependency-aware cache identity on disk (`cache_identity`, a post-order fold). All four are step-agnostic: a merge adds an arm to `step_dependencies` and inherits them. What remains is only what a lookup structurally CANNOT do — **multiply rows** — which is a different downstream contract (`keepRows`/`removeDuplicates`/`fillDown` mean something else once the row count can change) and must be its own step tag, never an option on `lookupColumn`. Until then a user who needs a true join does it in a SQL-source import (`source_query`) or a calculated table. | `docs/design/table-transformations.md` §"Looking across tables", `engine-core/src/transform/mod.rs` (`pipeline_refresh_order`, `cache_identity`), `engine-core/src/transform/catalog.rs` |
| **One engine mutex per BI connection serializes every query on it, held ACROSS the network round-trip.** Not new and not specific to transformations — `bi_execute_sql` has always held `engine_arc.lock().await` while awaiting `connector.execute_query`, and every sibling path does the same. What made it worth a row is that the REST connector and the transform PREVIEW extend how long a single holder can keep it: a preview fetches through the connector under the guard, so a slow or hanging endpoint blocks unrelated pivots and measures on that connection for up to the source's `timeout_secs`. Mitigated today by a 500-row preview cap and a cancellable `queryId`, neither of which helps the OTHER queries waiting behind it. The fix is to take the connector `Arc` out from under the guard and drop the guard before awaiting — the same "clone the Arc out, then await" move `close_document_bi_connections` already documents one level up — which is mechanical per call site but touches ~13 of them. | `bi/model_editor.rs:6165`, `bi/commands.rs:2723-2732`, `bi/commands.rs:981-988` |
| **No query folding: a transformation pipeline always runs locally, over every fetched row.** A leading prefix could fold into the existing `FetchRequest` — `selectColumns` → `columns`, an AND-of-comparisons `filterRows` → `filters` (the `fold_refresh_filter_now` machinery already folds exactly that shape), `keepRows FirstN` → `limit`, `sort` → `order_by`, and for a SQL source an arbitrary prefix → a generated `source_query`. The cost of not having it is bandwidth and memory on a large source, never a wrong answer. The seam is `fold_prefix(steps, capabilities)` gated on a new `ConnectorCapabilities` flag (`#[non_exhaustive]`, false defaults, so adding one is non-breaking) failing **soft** to local evaluation. Nothing in the shipped design blocks it — steps are declarative, evaluated front-to-back, and the evaluator already takes an arbitrary sub-range. | `engine-connectors/src/traits.rs` (`FetchRequest`, `ConnectorCapabilities`), `engine-core/src/compute/incremental.rs` |
| **Three E2E `test.fixme`s all disable the SAME assertion, and one would pass vacuously if re-enabled.** `workflow-invoice.spec.ts:144`, `workflow-gradebook.spec.ts:144` and `workflow-dashboard.spec.ts:231` each skip "edit a value, verify the cascade recalculated" — the single behaviour those three journeys exist to prove. Only the invoice one states a reason (cross-test data contamination, at `:142-143`); the other two give none. And gradebook's body sits inside `if (erikRow > 0)`, so simply un-fixme-ing it would pass WITHOUT asserting anything whenever the row is not found — re-enable the assertion and the guard together, or it re-enters the suite as decoration. | `workflow-invoice.spec.ts:144`, `workflow-gradebook.spec.ts:144`, `workflow-dashboard.spec.ts:231` |
| **Four "not yet implemented" comments describe limitations that no longer exist.** Stale in the ALREADY-FIXED direction — the direction this project has measured as costing it most, because a reader trusts them and re-implements something that works, or routes around a path that is fine. `BorderTab.tsx:3-4` says "Border rendering is not yet supported in the Canvas renderer... apply is a no-op" (false — it applies, and BUG-0101 just fixed how it rasterizes); plus `knownIssues.ts:79-84`, `tables.rs:471`, and `api_types.rs:738` with `data.rs:4657`. Minutes to correct, and worth doing as a batch because the pattern is the point: **a limitation recorded only in a code comment is invisible to this file by construction**, and so is its expiry. | `BorderTab.tsx:3-4`, `knownIssues.ts:79-84`, `tables.rs:471`, `api_types.rs:738` |
| ~~**Excel's array literal `{1;2;3}` does not parse.**~~ **CLOSED 2026-08-23, and all three complications were real.** `{…}` is now Excel's ARRAY CONSTANT: a new `Expression::ArrayLiteral { rows: Vec<Vec<Expression>> }`, a `Token::Semicolon`, and a parser that reads `,` as the COLUMN break and `;` as the ROW break, refusing a ragged constant at entry as Excel does. `={1,2,3}` is one row, `={1;2;3}` is three, `={1,2;3,4}` is a 2x2 block, and each spills the shape its separators describe.
1. **The brace was reclaimed and the dict survived it.** A colon after the first element still means DICT — the same signal the parser already used — so Calcula's key-value literal is untouched. `COLLECT(…)` is the List's remaining spelling, and `ast_render` now emits that instead of braces: rendering a List as `{…}` would have round-tripped a CONTAINED value into a SPILLING one.
2. **The sv-SE collision was handled, and it was the one that would have corrupted data.** `delocalize_formula` / `localize_formula` are brace-aware in both directions now: inside a constant `\` maps to the invariant column separator and `;` is LEFT ALONE, so `={1\2;3\4}` no longer flattens into one row on the owner's own machine. A dict group is told from an array group by the colon-before-any-separator rule, so its entries keep the ordinary list separator. Six locale tests pin it, including a both-directions round trip.
3. **The 39 sites were done, and the catch-alls did hide some.** 22 `ArrayLiteral` arms across the 8 app-crate files, each mirroring the `ListLiteral` arm beside it. Two of those matches turned out to be EXHAUSTIVE (`control_values.rs`, `evaluate_formula.rs`) so the compiler caught them; the rest were the silent kind this row predicted.
**What came with it, because one missing shape caused all of it:** operators and scalar functions now LIFT over arrays (`core/engine/src/array_lift.rs`), closing the exceljet terms "array operation", "lifting", "pairwise lifting", "broadcasting", "CSE" and "double unary" at the same time — and fixing three answers that were WRONG NUMBERS rather than errors: `=SUMPRODUCT(A1:A3*B1:B3)` returned **0**, `=A1:A3&"x"` returned `"1x"`, and `=A1:A3=1` returned a bare **FALSE**. Found and fixed alongside: a single-ROW range came back FLAT, which every shape reader in the engine takes to mean a column, so `=D1:F1` spilled DOWN the sheet instead of across it. | `array_lift.rs`, `array_semantics_tests.rs`, `parser.rs`, `lexer.rs`, `token.rs`, `ast.rs`, `ast_render.rs`, `formula_locale.rs` |
| ~~**Calcula diverges from Excel on the formula SYMBOLS themselves.**~~ **CLOSED 2026-08-24 — 77 fixes across two rounds, and the audit that produced them was MEASURED, not read.** Every symbol documented at excelx.com/formula/symbols was probed against the real engine (323 probes); 67 divergences survived adversarial verification, of which **34 were plausible WRONG ANSWERS with no error on the cell**. Four root causes produced half of them, and the pattern is worth keeping: **the syntax was in good shape and the TYPE SYSTEM was not.** Precedence, `^` associativity, unary-minus binding, `$`-on-copy-vs-insert, wildcards and `~`, `@`, `{}` with sv-SE `\` columns and 3-D `Sheet1:Sheet3!` all measured ALIGNED; what was wrong was every rule about what a value IS.
1. **No type-rank ladder in the comparison operators.** `="1"=1` answered TRUE, `="1">2` answered FALSE, `=1<2<3` answered TRUE — Excel says FALSE, TRUE, FALSE. Seven findings collapsed into one shared ladder (`number < text < FALSE < TRUE`, case-insensitive within text, arithmetic still coercing). The idiom users reach for to DETECT a number stored as text was inverted.
2. **One collector could not tell a DIRECT argument from an ARRAY ELEMENT.** Excel coerces `=SUM(1,"2",TRUE)` to 4 and ignores the same values inside a range — which is the entire reason the `SUMPRODUCT(--(…))` idiom exists. Calcula coerced both, so `=SUM(A1:A3&"")` answered **6**: the standard proof that a column has silently become text reported the opposite of the truth.
3. **Text→number coercion was Rust's bare `f64::from_str`.** It refused `="5%"+0`, refused `="1,5"+0` in the SHIPPING sv-SE locale while accepting `="1.5"+0`, and accepted `"inf"` — putting a non-finite number in the grid that `ISNUMBER` called TRUE. Replaced by one Excel-shaped parser (`core/engine/src/number_text.rs`) with per-caller policies, now used by arithmetic, `VALUE`, `NUMBERVALUE`, the criteria family and typed entry.
4. **Three rewriters treated an apostrophe-quoted SHEET NAME as ordinary text.** Filling `='FY2024 Data'!A5` down produced `='FY2025 Data'!A6` — and `'Q1 2024'`→`'Q2 2024'` is exactly the case where the other sheet EXISTS, so the cell showed a real number from the wrong quarter with no error anywhere. Fixed at `rewrite_outside_strings`, the one choke point every shifter passes through, and in both directions of the sv-SE translator.
**THREE DEFECTS NOBODY HAD FILED turned up while sweeping for the ones that were**, all worse than their briefs: `FIND`/`SEARCH` returned BYTE offsets while `MID`/`LEFT` count characters, so the standard split-a-string idiom produced a mangled STRING; `=FIND("ö","åäö",2)` PANICKED the evaluator, a crash reachable from the formula bar of a Swedish-default product; and General format rendered `1e100` as `1.00000e1` — 99 orders of magnitude wrong, surviving because it only fired when the exponent ended in a zero. **Two owner decisions:** `=ROWS(A:A)` answers the USED-RANGE height (pinned as deliberate, not fixed), and a structured reference now SHIFTS SIDEWAYS on a copy (`Table1[Qty]`→`Table1[Price]`) while still never shifting DOWN and never shifting the locked `[[Qty]:[Qty]]` spelling — which needed an optional column resolver threaded in from the copy/fill commands, since the text shifter has no table registry. **Round 1's own verification found two regressions round 1 introduced** (the new parser leaked into `COUNTIF` so text `"5%"` matched numeric `0.05`; a single-cell intersection lost its reference-ness) — which is the argument for the adversarial pass, not against it. Suites: engine 729→**860**, parser 119→**131**, app 1900→**1920**, frontend 108,306 unchanged. | `number_text.rs`, `comparison_ranking_tests.rs`, `direct_coercion_tests.rs`, `text_character_semantics_tests.rs`, `number_text_tests.rs`, `omitted_argument_tests.rs`, `evaluator.rs`, `number_format.rs`, `formula_locale.rs`, `commands/structure.rs`, `lib.rs` |
| ~~**Excel's `TRIMRANGE` and the `.` trim-reference operator do not exist.**~~ **CLOSED 2026-08-24 — the last of the exceljet glossary gaps, and it uncovered a live defect one layer down.** `=SUM(A:A)` is the spelling a user reaches for when the data will grow, and it is the spelling that then drags every blank row on the sheet into whatever it feeds; `TRIMRANGE(range, [trim_rows], [trim_cols])` cuts the blank EDGES off (0 none / 1 leading / 2 trailing / 3 both, per axis, interior holes kept because the hole is part of the data's shape). **The dot is SUGAR, and that is the design's load-bearing claim:** `parse_primary` lowers `A1:.A8` straight to `TRIMRANGE(A1:A8,2,2)`, so `Expression::Range` grew no trim fields, nothing downstream learned a second spelling, and `the_dot_operator_is_exactly_the_function` asserts the two ASTs are identical rather than merely agreeing numerically.
1. **The dots are lexed as a FLAG, not a token** — `Lexer::trim_flags`, sitting beside `had_leading_ws` and justified the same way, only more so: the parser makes **21** `== Token::Colon` comparisons with a range-builder behind each, so a token variant is 21 chances to miss one and a formula that stops parsing. The lexer swallows the dots; the parser reads the flag at ONE place and saves/restores it per atom, so a dotted range inside an argument cannot trim its parent. `read_identifier` had to stop taking a TRAILING `.` as a name character (`A1.` was lexing as a single identifier) while `Q1.Sales` still does.
2. **The renderer collapses it back**, or `=A1:.A8` became `=TRIMRANGE(A1:A8,2,2)` in the formula bar the next time the cell was opened — a formula that rewrites itself on being looked at. The argument must BE a reference: `rfind(':')` on its own rendered `TRIMRANGE(SORT(A1:A8),3,3)` as `SORT(A1.:.A8)`, which is not what the AST said.
3. **THE REAL DEFECT, measured against an undotted control before any fix.** Every shifter in `commands/structure.rs` is an A1 regex whose leading class `[^A-Za-z0-9_.]` excludes `.` deliberately, so that `Q1.Sales` is not read as a reference — and the operator puts a dot in exactly that position. A dotted range therefore **silently stopped tracking its data**: `=SUM(A1:.A8)` stayed `=SUM(A1:.A8)` across a row insert (end frozen) and became `=SUM(A2:.A8)` on a copy down; `=SUM(A1.:A8)` copied down became `=SUM(A1.:A9)` (start frozen); `=SUM(A1.:.A8)` never moved at all — a wrong NUMBER with no error on the cell. Fixed by LIFTING the dots out inside `rewrite_outside_strings`, the one choke point every shifter passes through, and restoring them by COLON ORDINAL — not by teaching the four regexes and two guard edges about `.`, which is six chances to reintroduce the `Q1.Sales` defect they exist to prevent. The tests assert a dotted range shifts **identically to the same range undotted**, so they cannot be satisfied by freezing both. 21 engine tests + 3 app-crate tests, all sabotage-verified. | `evaluator.rs` (`fn_trimrange`), `trim_range_tests.rs`, `lexer.rs`, `token.rs`, `parser.rs`, `ast.rs`, `ast_render.rs`, `commands/structure.rs` (`shift_with_trim_dots_lifted`) |
| ~~**`#NULL!` is never produced.**~~ **CLOSED 2026-08-17, and the item pointed one layer above the defect.** It read as a missing match arm; the truth is that **the SPACE INTERSECTION OPERATOR WAS NOT PARSED AT ALL**. `skip_whitespace` consumed every space and emitted nothing, so `=A1:A5 C1:C5` could not reach an evaluator — the parse failed, the cell stored the formula anyway, and the user saw `#VALUE!` on a cell carrying **no dependency edges**, so it never recalculated either. There was no smaller honest fix: mapping the parse failure to `#NULL!` would be right for a disjoint pair and WRONG for `=A1:B5 B1:C5`, which Excel answers with the overlapping column. Implemented as `BinaryOperator::Intersect` on the existing `BinaryOp` (never a new `Expression` variant), one precedence level tighter than `^`, with `eval_intersect` working on the operand EXPRESSIONS — it cannot live in `eval_binary_op`, which collapses both sides to values and destroys the reference-ness it needs. `u32::MAX` sentinels let `A:A 2:2` be the single cell A2. 7 tests, each `#NULL!` case paired with an overlap control, plus a renderer round-trip (a dropped space would rewrite `A1:A3 A2:C2` into `A1:A3A2:C2`). **One named divergence:** `=A1 2` yields `#NULL!` where Excel rejects it at entry — single-token lookahead cannot tell `2` from `2:2`, and dropping `Number` as an operand start would lose whole-row intersection. | `ast.rs`, `parser.rs`, `lexer.rs`, `evaluator.rs`, `ast_render.rs`, `intersection_tests.rs` |
| ~~**`set_active_sheet` accepts a hidden sheet index.**~~ **CLOSED — verified fixed 2026-08-18, and the stated reason for leaving it open was FALSE.** The row said "not tightened because scripts and E2E specs use it to reach hidden sheets"; nothing depended on it, and `activate_sheet` now makes BOTH checks in a load-bearing order — `ensure_user_sheet` first, so the floating-range message survives for object-backed sheets, then `if !sheet_is_visible(...)` returning an error that names the escape hatch (`sheets.rs:937-942`). Excel parity: `Worksheets("x").Activate` raises run-time error 1004. Every premise the row stated was still true — `is_user_sheet` (`sheets.rs:144-149`) does refuse only `OBJECT_SHEET_VISIBILITY` — but the CONCLUSION had expired, because the guard it was missing had since been added one layer up. **This is the second justification-for-inaction in this file measured false in a single pass** (the other is the calamine row below), which is why every remaining code-fact row now carries a machine-checked predicate. | `sheets.rs:144-149,937-942` |
| ~~**`default_row_height` / `default_column_width` announce no undo domain.**~~ **CLOSED 2026-08-17, and it was a real repaint bug rather than metadata tidiness.** The registry justified `NONE` with a comment saying the frontend re-reads these "through the dimension refresh it already runs" — **it does not**: `refreshDimensionsFromBackend` is gated on `structuralRestore \|\| mergeChanged \|\| hiddenChanged`, and a default-dimension restore sets none of the three. The renderer paints from Redux `config.defaultCellWidth/Height`, which nothing else updates, so undoing a default row height wrote the old value to the backend and left the new one **on screen** — grid and file disagreeing, silently. Fixed by adding `UiDomain::Dimensions` (Rust enum + `ALL` + wire name, TS union, and a `dimensions: ["dimensions:refresh"]` row in the shell fan-out, which is the bare event every FORWARD dimension route already fires). `pivot_col_widths` had the identical `NONE` and is fixed with it. Sabotage-verified through `crossLayerConstantDrift`. | `object_deps.rs`, `undo_commands.rs:1623-1642,4578`, `events.ts`, `bootstrap.ts` |
| ~~**The in-app AI chat cannot hand the user a script to review — only an external MCP client can.**~~ **CLOSED 2026-08-19 (M1).** `draft_object_script` / `list_script_drafts` / `get_script_draft` were registered on the MCP server (**37 tools**) and absent from the in-app chat, whose **21** declarations and **21** dispatcher arms matched each other exactly — a perfectly consistent surface that was simply missing a feature, which is why nothing ever failed. The chat's only route to a script was `run_script`, which **executes immediately**, the inverse of the review-then-mount invariant `drafts.rs` exists to hold. Now 24/24. **Two things came out of a three-arm change.** (1) The tool surface was extracted to `AIChat/lib/chatTools.ts` — an inline `const` inside a `.tsx` cannot be diffed against Rust without parsing the component file, and `__tests__/chatToolSurface.test.ts` now reads `ai_chat.rs` at test time and diffs BOTH directions (sabotage-checked three ways: 7 reds / 3 reds / 1 red; the first Rust sabotage used an uppercase name that slipped the `[a-z0-9_]+` parse and had to be re-run lowercase to exercise the reverse direction at all). (2) The transcript printed `name(JSON.stringify(input))`, which for a draft would have dumped an entire macro JSON-escaped into a chat bubble — a defect M1 would have INTRODUCED; draft calls now render as a one-line summary while the readable copy opens in the editor. Verified: 294 frontend tests, **1737 app-crate tests, 0 failed**. **A third thing came out of it a day later:** the rows written for this item cited six line numbers in `ChatView.tsx`, and M1 shrank that file from 400 lines to 179, so `openItemsCitations.test.ts` went red on the very commit that closed the item — caught only when the FULL suite ran during M2, because M1 ran just the two affected extensions and not `npm test`. Design: `docs/design/local-model-script-authoring.md` §3b, M1. | `ai_chat.rs:236-380` (arms at `:305,317,318`), `AIChat/lib/chatTools.ts`, `AIChat/__tests__/chatToolSurface.test.ts`, `mcp/drafts.rs:238` |
| ~~**The in-app AI chat is hard-locked to one vendor, and offers no model picker at all.**~~ **CLOSED 2026-08-19 (M3).** `ai_chat.rs` is gone; `app/src-tauri/src/ai/` replaces it with a provider registry (**8 providers**), Calcula's own chat shape plus both wire translations, loopback runtime discovery, and per-provider Credential Manager slots. The extension no longer knows any vendor's schema: it speaks `AIChat/lib/aiTypes.ts`, and `input_schema` became `inputSchema` with the provider relocating it. A model picker exists for the first time — before M3 EVERY request in the product was `claude-opus-4-8`, because `ai_chat_complete` took a `model` parameter the caller never passed. **One `openai_compat` impl reaches Ollama, LM Studio, llama-server, vLLM, OpenAI, OpenRouter and any custom endpoint**; only Anthropic needs a native wire, and a test pins that so §7a's claim cannot rot. The selection is an application preference in `ext.calcula.ai-chat.*`, named on every request, so the backend holds no selected-model state and a model id can never reach a `.cala`. **Two things the move turned up:** the object-dependency census caught the `ai_chat_delete_api_key` -> `ai_provider_delete_key` rename, and `backendCommands.ts` had never denylisted the AI key commands at all (now listed, together with `ai_chat_complete` — not a key write, but the path that SPENDS one). Design: `docs/design/local-model-script-authoring.md` §7a, M3. | `ai/wire.rs`, `ai/providers.rs`, `ai/discovery.rs`, `AIChat/lib/aiTypes.ts`, `AIChat/components/ModelPicker.tsx` |

| ~~**The AI script-authoring pipeline is BUILT and UNIT-TESTED but not yet wired into the chat UI.**~~ **CLOSED 2026-08-20.** The last hop is done. `ChatView` now runs the validation ladder in front of `draft_object_script` (`AIChat/lib/draftGate.ts`): a draft that fails L0-L2, or that passes them and then THROWS in the L3 dry run, comes back as the TOOL RESULT so the chat s own agentic loop performs the repair -- no second repair loop, because the chat already had one. `ModelPicker` runs `probeModel` behind a Test this model button and shows the measured verdict, cached per (provider, model) in extension settings. Two deliberate exclusions: `run_script` is NOT gated (it is the execute-now path the user asked for explicitly, and it is undoable), and the gate FAILS OPEN when the dry-run command is unavailable, because a gate that turns its own failure into a refusal gives the user nothing to act on. | `AIChat/lib/draftGate.ts`, `AIChat/lib/probeRunner.ts`, `AIChat/components/ChatView.tsx`, `AIChat/components/ModelPicker.tsx` |

| ~~**The verification ladder stops at static checks, and static checks are blind to the larger half of what goes wrong.**~~ **CLOSED 2026-08-20 (L3).** `ai/dryrun.rs` + `ai_dry_run_script` run a candidate against a CLONE and report the diff; `mcp/tools.rs` split into `run_script_isolated` (runs, applies nothing) and `run_script_with_model` (that + apply). `fixture` seeds the clone before the run and `read_back` reports named cell values after it, so a preview can be made deterministic. The write-invariant is asserted at the layer that implements it (`a_run_never_mutates_the_callers_grids`, `core/script-engine/src/notebook.rs`) as well as end to end. **Wiring it in front of `draft_object_script` was wrong three times over, and none of its own tests could see it because they doubled the backend** — see the two rows below. Measured 2026-08-19 with the M5 corpus against a real local model: of eleven failures, **six were VALID scripts that simply did not do the job** — they parse, invent nothing, declare their capabilities correctly, and call none of what the task needs. The M7 repair loop stopped after one round on each, because the validator honestly reported `ok: true`. **L0-L2 cannot see "correct but useless".** The other five failures were still invalid after exhausting all four rounds, one never parsing at all — more rounds do not rescue a model that cannot hold the API in its head. §5 of the design doc lists **L3, a dry run over cloned grid state with a diff**, and M2 did not build it: the substrate exists (the QuickJS realm already executes over a clone, `ReachClass::Grid`) but there is no NON-APPLYING entry point — `tools::execute_script` is undoable-and-applied, which is not the same thing. Until L3 exists the repair loop can correct syntax and policy but never behaviour, and an eval score flatters a model by exactly the six-in-eleven it cannot see. Measured numbers: one-shot 0/12 at mean 0.550, four repair rounds 1/12 at mean 0.646. Design: `docs/design/local-model-script-authoring.md` §5, M7. | `scriptHost/scriptValidation/index.ts`, `scriptHost/scriptAuthoring/index.ts`, `mcp/tools.rs` |
| ~~**An `async` script body silently did nothing, and reported SUCCESS.**~~ **CLOSED 2026-08-20.** QuickJS parks everything past the first `await` on a job queue and NOTHING in the engine drained it: the body ran to its first `await`, `eval` returned, the grids were read back unchanged, and the run reported `Success` with `cells_modified: 0`. Not AI-specific — it reached every notebook cell, one-off script and MCP `execute_script`; found only because a dry run's "ran fine, changed nothing" is the single most misleading verdict a checker can give. `runtime::drain_jobs` now drains both run paths INSIDE the armed deadline (a chain that never settles is cut by the same budget; no iteration cap, which would cut a long-but-finite one short) and on the error path too (the notebook session is persistent, so a job left queued by cell N would resume against cell N+1's grids). Unhandled rejections now fail the run through a deliberately ASYMMETRIC tracker: a late-handled rejection CLEARS what was recorded, because QuickJS calls the tracker even for an ordinary `try/catch` around an `await`. Six guards, each sabotage-verified to red its own assertion. | `core/script-engine/src/runtime.rs` (`drain_jobs`), `core/script-engine/src/limits.rs` (`Rejections`), `core/script-engine/src/notebook.rs` |
| ~~**`export function setup(context)` — the shape the docs, the typings and the AI prompt all teach — could not MOUNT.**~~ **CLOSED 2026-08-20.** `wrapModuleSource` splices the user body INSIDE a function, where an `export` declaration is a SyntaxError. It stripped `export default` and `import`, never a bare `export`. A script could pass every static check and then fail at mount. It went unnoticed because the production path that works (`MacroRecorder`'s codegen) emits `function setup(context)` with no `export`, while `export function setup` lived in the docs, the generated IntelliSense typings, this feature's prompt and every one of its tests. The keyword is now BLANKED rather than deleted, so line AND column numbers survive for breakpoints and stack traces. | `app/src/api/scriptHost/worker/debugWrapper.ts`, `worker/__tests__/debugWrapper.test.ts` |
| ~~**A dry run cannot faithfully preview an OBJECT script, and now says so instead of guessing.**~~ The Worker realm's `context` exposes **358** `api.*` members; the interpreter realm the preview runs in shares **NINETEEN** of them, and of the 16 chains the prompt always shows, **four**. `ai_dry_run_script` returns `applicable: false` with a reason for any source this realm cannot host, having run nothing, and every consumer branches on it — before that gate, L3 rejected every valid object script with "it FAILS when run against a copy of the workbook", so the model spent its repair rounds fixing correct code. **2026-08-20 addendum (adversarial review):** the decline HEURISTICS are substring/line checks, so they both under-decline (`const setup = (c) => …` with no literal `context.api.` is judged in the wrong realm and its runtime error reported as the draft's) and over-decline (a comment or template-literal line starting `export ` / mentioning `context.expose(` suppresses L3 for a plain script that could have been judged). **Both were then CLOSED for every production caller (2026-08-20): `ai_dry_run_script` takes an explicit `surface` label — draftGate says `object-script` (declined authoritatively, its drafts ARE object scripts by definition) and a labeled `one-off` is judged with no heuristic able to suppress the verdict, since for that realm a syntax error on `export` is CORRECT. The substring heuristics remain only for unlabeled callers.** **The faithful version is BUILT — CLOSED 2026-08-21, and the "grid backend a preview has no document for" turned out to be the smallest part of it.** `previewObjectScript` (`scriptHost/scriptPreview/`) runs a draft in a REAL hardened Worker: `hostPreviewScript` spawns the realm, `wrapModuleSource` performs the production mount, `buildWorkerContext` builds the whole surface, and admission is the real `brokerCall` — ALLOWLIST lookup, argument validators, tier, R19 ceiling. Only the BACKEND behind the broker is substituted, which is irreducible: a preview must not write to the document it previews. So the "emulating 5%" objection is answered rather than dodged — it was about the SURFACE, and nothing here emulates the surface. **The document was the easy half:** a preview does not need one of its own, it needs a COPY, and `snapshotActiveSheet` takes one with read-class calls (capped at 20,000 cells, clamped by whole ROWS, and a capped copy SAYS SO). Each cell carries the input string AND the display, because `api.getCellValue` returns the FORMATTED display in the product and deriving the input from it would make the diff report changes nothing made. **Safety is proved by ABSENCE:** the function never calls `assertMountAllowed` (no consent modal, no persistent workbook-trust record), `buildHandleFromDefinition` (no live grant set, so a previously "Always"-granted source cannot inherit reach), `restoreAndSyncGrants` (nothing reaches the Rust capability store), `registerMountedHandle`, `mounted.set` or `executeImpl` — the `DocumentEffect` discipline run in reverse, since four conditionals inside `mountWorker` would have been four fail-OPEN branches in the most security-sensitive function in the host. `ScriptHandle.preview` changes exactly ONE thing, audit RECORDING, and the subtle half is why: `persistCapabilityAudit` persists broker-policy DENIALS, so the empty ceiling that keeps a preview harmless would otherwise write permanent rows into the user's workbook about a script they never ran. **One backend, two drivers:** the grid, the 39-method backend and `decidePolicy` moved out of `scriptEval/harness.ts` so the corpus and the app share them — a corpus grading against different semantics than the app previews with certifies the wrong thing — and the extraction deleted the harness's hand-rolled policy copy, which had never checked the tier. **Three defects were found by the E2E tier and by nothing else** (jsdom has no `Worker`, so no unit test had ever run a script in this realm), all in the async plumbing and all producing the same lie — *"it ran and changed nothing"* — about CORRECT scripts: the host drained before `postMessage` delivered the event (fixed with a `ping`/`pong` round trip, sound because the realm handles messages in order); one drain was not enough, because a refused call settles host-side while the worker has yet to process the `callResult` and throw; and a refusal the script never awaited was invisible, neither throwing nor changing a cell. Capabilities DECLINE rather than stub in-app — L2 already checked the declarations, so a capability call reaching the preview is a correctly declared one and the honest answer is that a preview cannot perform it; a canned `{}` parsed as an exchange rate would have made the preview report its own stub as the draft's runtime error. `ai_dry_run_script` is UNCHANGED and remains the one-off realm's rung, decline and all — its refusal was always a true statement about the interpreter. Design: `local-model-script-authoring.md` §5c. **Three follow-ons landed 2026-08-21 (§5c.1).** (1) **The gap rate was measured** against the right denominator — what the model is TAUGHT, not the 233-row ALLOWLIST — and the answer drove work rather than sitting in a comment: prompt core **19/19** and every corpus reference served (both asserted), broad exposure **46.8%** at the runner's 8k default. The tail split into "cannot" and "not yet" once `UNPREVIEWABLE` named the structural cases with a reason each (cross-script calls, other sheets, real objects, print; capability methods derived from the ALLOWLIST so that half cannot drift), and six methods were then served faithfully — `getRangeFormat`, `clearRangeFormat`, `copyRange`/`pasteRange`, named ranges — taking addressable coverage to **55.2%**. `pasteRange` GAPS on a formula, because the product SHIFTS relative references and pasting one unshifted would present a formula the product would never write as the script's. The assertion is a **ratchet, named as one**: chasing a high number means approximate implementations, and an approximation is strictly worse than a gap — a gap declines, an approximation grades a WRONG script as right. (2) **The gate previewed EVERY draft as a button**, though `object_type` is a required field of `draft_object_script` — so a shape or sheet script was mounted against the wrong context and its own handlers never fired. It now reads it, and `objectHooksFor` DERIVES the hook list from the generated surface; the gate names no event, so the draft's own registrations decide what runs. Its guard immediately caught two wrong entries in the author's list of types-without-a-context. (3) **Formula VALUES now exist**: `ai/preview_eval.rs` + `preview_evaluate_formulas`, pure over the cells handed to it, iterating `evaluate_formula_multi_sheet` to a fixed point (a chain needs a pass per link; a cycle stops at the budget and reports `converged: false` rather than presenting a half-iterated number). **The one thing TypeScript could not supply at any price** — the formula language is Rust's, and a second evaluator would be one that confidently disagrees with the workbook. It runs at settle points, not per read, and states that difference. Guards: 7 unit files + 7 Rust tests + `e2e/journeys/script-preview.spec.ts` (10 cases), seven sabotage rounds each redding its own assertion — including one that had to be re-run after the first attempt patched `hostValidateScript` instead and passed as a no-op. **A six-lens adversarial review of the whole preview (2026-08-21, 28 raw → 12 verified findings) then found that EACH of the three follow-ons shipped with a false-verdict defect the unit tier could not see, ALL FIXED same day (design §5c.2):** non-click hooks fired with `undefined` payloads where the product delivers rich shapes, so correct destructuring handlers were rejected "FAILS when run" for every type except button — now the payload table declines what it cannot synthesize (skip+note / inapplicable / harness-gap); the generated surface's chain-dedup omitted `iface`, so `objectHooksFor` returned NOTHING for slicer/table/timeline/row and the row guard had ENSHRINED the defect — dedup key now carries the interface (894 rows) and `OBJECT_TYPE_CONTEXTS` is emitted so runtime stops guessing interface names (the convention was wrong for `textbox`); the recalc OVERWROTE workbook-correct displays with `#REF!` from a one-sheet evaluator and its flat 8-pass budget called ordinary running-total columns "circular" — now store-only-on-convergence (budget formulas+1), spills refuse via the raw eval API, errors never clobber existing displays, TRUE/FALSE seed as Booleans; a hook error landing during `onSettle`'s IPC await was blamed on the NEXT hook or dropped (`ran:true` for a throwing script) — the latch is checked after every phase; quiescence-by-calls lost a sleeping handler's tail write — **and the first fix for THAT was itself wrong twice: pong-timer-zero quiescence wedged every dev preview, because Vite's HMR client holds a permanent retry timer in dev workers and timer counts cannot tell script sleeps from plumbing** — the mechanism is the realm's own `{t:"eventDone"}` ack, with the timer count kept only to choose the expiry message against a baseline; empty mirror seeds fabricated `sheetCount: 0` with no broker call to gap — previews now mount STRICT (unseeded mirror reads decline, known facts seeded); and the coverage map's duplicate-chain clobber is a multimap (55.3% @8k). The safety invariant survived all six lenses: zero confirmed escapes. 107,746 unit / 11 Rust / **14 E2E** (four new discriminators), three more sabotage rounds each resurrecting the original defect verbatim. **The review's four unverified findings were then verified and closed the same day (§5c.2 tail):** the 20k evaluation cap travelled as `Err` into the deliberately-silent catch, so a deliberate refusal was indistinguishable from a missing backend (now structured `refused` in the result → a note in the report); the eval command was a SYNC fn — Tauri runs those on the MAIN thread, so every settle point froze the UI (now async + `spawn_blocking` + a total-work clamp `min(n+1, 512, 2M/n)`; the per-formula `eval_budget` already existed — narrower than filed); preview memory gained a best-effort watchdog (256 MB poll on intrinsic-captured timers, breach → error + realm close) with the residuals STATED — a tight sync allocation loop never yields to any poll, and the true fix is out-of-process isolation, an owner call; and `PARTIAL_SERVES` declares every argument-level gap inside served coverage cases, guard-enforced in both directions. 107,753 unit / 13 Rust / 14 E2E / two more sabotage rounds. | `scriptHost/scriptPreview/`, `scriptHost/host.ts` (`hostPreviewScript`), `scriptHost/brokerPolicy.ts`, `ai/preview_eval.rs`, `generateObjectContexts.ts`, `worker/workerHardening.ts` (`armMemoryWatchdog`), `AIChat/lib/draftGate.ts` |
| ~~**`stripModuleSyntax` is a regex pass over source it cannot actually tokenise — six confirmed edge defects, one of them silent data corruption.**~~ **CLOSED 2026-08-20, the recommended way: the five regexes are gone**, replaced by a single tokenizer-aware pass that tracks string / template (with `${…}` nesting) / comment state character by character. All six defects have pinning tests: template-literal lines are DATA and survive verbatim (the silent-corruption member), a `}` in a comment cannot truncate a specifier list, code trailing an import on the same line survives, `export` split from its declaration by a newline is stripped, mid-line `export` after a statement is stripped — which also made the DEBUG-mount strip-before-instrument ORDER stop mattering (pinned: even the wrong order now compiles) — and property keys / member access / dynamic `import()` are untouched. Unknown or malformed module syntax is left alone: a loud SyntaxError at mount beats a silent partial rewrite. The severe member: a line INSIDE a multi-line template literal that starts with `import ` / `export {` / `export *` is blanked, silently corrupting the string's runtime VALUE (the `import` half of this predates the strip rework; the specifier forms widened it). The loud members: a `}` inside a comment within a multi-line specifier list truncates the strip and leaves a stray `};` that breaks the wrapper; real code after `import …;` on the same line is blanked with it; a line break between `export` and its declaration defeats every pattern (and the validator ACCEPTS that form, so it passes L0-L2 and dies at mount — the exact asymmetry the strip exists to close); mid-line `export` after a statement is untouched for the same reason. The fix is one tokenizer-aware pass (string/template/comment state tracking) replacing all five regexes — a bounded task for its own session; patching regexes individually is how the list got this long. | `app/src/api/scriptHost/worker/debugWrapper.ts` (`stripModuleSyntax`) |
| ~~**The setup-only context binding traded false rejections for false passes, and the trade is not yet closed.**~~ **CLOSED 2026-08-20.** Both gaps fixed, each guard erring toward NOT binding (a false rejection is the worse failure): (1) the literal `context` is now bound UNCONDITIONALLY — the wrapper's parameter is reachable by closure from anywhere in the script — unless anything declares its own `context`, in which case a name-keyed binding set cannot express per-scope shadowing and the whole rule steps aside; (2) call-flow binding: a helper's parameter is bound when EVERY call site passes a context-bound identifier at its position and the name is declared exactly once in the script, to a fixpoint (context handed helper-to-helper is followed). Pinned: invented member inside a context-fed helper flagged, two-hop flow flagged, polymorphic helper NOT bound, shadowed local `context` NOT flagged, stray top-level `context.caps.fetch` beside `setup(c)` flagged. Residue, stated: a helper whose param name is reused elsewhere, or that is also called with non-context arguments, stays unexamined — conservative by design. Two confirmed gaps from the narrowing (which itself fixed drafts being REJECTED for an exported helper's ordinary JS): (1) a helper that RECEIVES the context — `setup(context) { helper(context); }` / `helper(ctx) { ctx.api.setCellValu(…) }` — is invisible to L1/L2, so an invented member or undeclared capability inside it passes static checks, and the dry run declines object scripts so nothing downstream catches it either; (2) the bare-`context`/`ctx` fallback walk only runs when NO binding was found, so when `setup` names its parameter something else, a stray top-level `context.caps.fetch(…)` — which WORKS at runtime, the wrapper's parameter is literally `context` — is unexamined. Proper fix is modest intra-procedural flow (bind parameters of functions that are CALLED with a context-bound argument, and always bind the wrapper's literal `context` at top level, scope-aware to avoid re-introducing false rejections on shadowing). | `app/src/api/scriptHost/scriptValidation/analyze.ts` (`collectContextBindings`) |
| ~~**L3 knows a script RAN and CHANGED something; it does not know the change was RIGHT.**~~ **CLOSED 2026-08-20 — expected-diff grading is built, and building it found the worst teaching defect of the whole programme.** Corpus v2: 21 of 36 tasks (10 of 12 canaries) carry an `outcome` block — fixture seeds, the hook to fire, expected cell INPUT STRINGS (or a `match` regex) and output substrings. The executor (`scriptEval/harness.ts`) is NOT the emulation the dry run declines to be: the mount transform, the `context`, the hook dispatcher, the `ALLOWLIST` argument validators and the declared-capability ceiling are all the production code, and only the backend behind the broker is an in-memory grid — a real member it does not serve marks the run UNGRADABLE, never wrong. Layer A pins every reference at grade 1.0 (the honesty anchor); `scoreCandidate` folds a grade in at half weight and refuses `passed` below 1.0; `run-eval.mjs` executes candidates in a sandboxed subprocess (scrubbed env — the provider key never reaches it — Node `--permission`, hard 10s kill; verified live: a hostile fs write was DENIED, a sync spin was killed) and hands the harness to the repair loop as its offline L3 hook. **What actually running the corpus found:** (1) every button reference, the authoring prompt and the assisted template taught `context.expose('onClick', …)` — a shape that MOUNTS CLEANLY AND NEVER FIRES, because a click reaches only the `onClick` HOOK (`Controls/index.ts` run-mode click + `wireHookForwarder`; the click path even diagnoses it "never registered a click handler") — so every AI-drafted button did nothing when clicked; all 31 references, both prompts and the repair message now teach `context.onClick(handler)`, and the harness fires the hook exactly as the product does, so the dead shape grades 0 with a repair instruction naming the fix. (2) The sort reference's `{ column: 0 }` passes static validation and is REFUSED at run time by `vSortRange` (`{ key }` is the field) — the corpus's own answer failed when run, caught by the first gate that runs references. (3) At a 4k budget the surface prompt omitted `onClick` for five canary tasks; the ranker now always includes the object type's OWN members. The in-app `canaryScore` stays static, deliberately: grading means executing model output, and the renderer must never do that. **A 60-agent adversarial review of the finished change-set confirmed 37 findings (18 refuted) and ALL are fixed**, the worst four: the harness snapshotted the grid ONE MICROTASK before a non-returned `.then` chain's tail write landed (the product has no early observation point at all, so the callback idiom is CORRECT there — graded wrong here; fixed by draining broker traffic to two quiet macrotask turns, pinned by a `.then`-chain test); numeric spellings were stored verbatim so a correct `total.toFixed(2)` graded as the wrong value (now canonicalized the way the backend types input); seven fixtures let a WRONG script grade 1.0 (unguarded clear under `confirm:true`, sort key correlated with the expected order, one-click counter, uninjectable error branch, digit-collision counts, unpinned source cells, untested empty-guard — all redesigned, with `eventCount`/`matchOutput`/`stubs.failWrite` added to the outcome vocabulary and discrimination tests for each); and `PROMPT_CORE_CHAINS` was still hint-floodable — at the runner's own 8k default, `grid-sum-in-script`'s prompt held every `api.set*` sibling EXCEPT `setCellValue` — so the floor (context group + core + capability index) now ranks ahead of hint pressure and a new Layer A guard requires every REFERENCE-CALLED chain to survive both working budgets for every graded task. Runner hardening from the same review: grade-child mutes console BEFORE the bundle import and exits explicitly after flushing (a candidate's stray `setInterval` no longer converts a finished observation into a fabricated 10s timeout — verified live at 106 ms), the parent caps child output (a stderr flood could exceed V8's string limit inside the parent), tries to parse a completed observation before fabricating a timeout verdict, sweeps stale bundle dirs, and reports harness-gap fallbacks loudly in both console and JSON. | `tests/eval/tasks.json`, `tests/eval/run-eval.mjs`, `tests/eval/grade-child.mjs`, `app/src/api/scriptHost/scriptEval/harness.ts`, `scriptEval/__tests__/corpus.test.ts`, `scriptPrompt/index.ts` |
| ~~**Aborting a pending JOB corrupts the QuickJS runtime, and the notebook session is reused afterwards.**~~ **CLOSED 2026-08-20.** Measured: a cell whose continuation spins is cut by the deadline interrupt DURING job execution, and dropping that runtime trips QuickJS's own `p->ref_count > 0` and kills the process with `STATUS_STACK_BUFFER_OVERRUN` — *after* the harness has printed a green result. It became reachable only once `drain_jobs` made queued continuations run at all. **The distinction that shaped the fix is sharp and was measured, not assumed: a cell that merely times out during `eval` — nothing ever queued — drops perfectly safely; it is aborting a JOB that corrupts.** So `NotebookSession::is_poisoned()` is set ONLY when a job faulted, and the executor retires such a session with `std::mem::forget` rather than dropping it — `session = None` there IS the crash. Narrow on purpose: an ordinary error, and an ordinary eval timeout, keep the session, because the user's notebook globals are the whole point of a persistent one and nothing corrupted them. **Residue, stated rather than hidden:** a poisoned runtime is LEAKED (bounded by how often a user's `async` continuation outruns the cell budget — rare and always user-visible), and the underlying unwinding bug is upstream in QuickJS. Guards: both directions of the flag are sabotage-verified, and the executor's leak-don't-drop wiring is pinned by a test that reads it. **Same-day addendum, found by the session's adversarial review of its own fix: the notebook was only HALF the surface.** The ONE-OFF path (`ScriptEngine::run` -> MCP `execute_script`, the chat's `run_script`, calp, and `ai_dry_run_script` itself) still dropped its runtime unconditionally, so a drafted script with a runaway `async` continuation crashed the app during the "safe" preview. Fixed the same narrow way: on a faulted job the `ScriptContext` is recovered via `RefCell::replace` (an `Rc::try_unwrap` can never succeed under a leaked runtime, and the caller still needs its console output), then runtime + context are `mem::forget`-ed; grids were already withheld on every error by design. Guard: `a_job_abort_in_a_one_off_does_not_crash_the_process` (`core/script-engine/src/lib.rs`), red-under-sabotage = the crashed binary itself. | `core/script-engine/src/notebook.rs` (`is_poisoned`), `core/script-engine/src/runtime.rs` (`drain_jobs`), `app/src-tauri/src/scripting/notebook_executor.rs` (`a_poisoned_session_is_leaked_rather_than_dropped`) |
| ~~**An async handler in the EXTENSION worker realm fails completely silently.**~~ **CLOSED 2026-08-20.** `dispatchAppEvent` now collects the handler's thenable and reports its rejection through the same `post({t:"error"})` a synchronous throw uses — the object-script twin's fix (`contextShims.ts` `dispatchEvent`), applied to the twin that never received it — and returns the settle promise so a caller can know when a dispatch is OVER. The realm also gained the `unhandledrejection` backstop it never had, UNCONDITIONAL where the object-script twin's is debug-gated: this realm has no debugger, and handler dispatch never lands there (`invokeHandler` awaits; `dispatchAppEvent` collects), so anything reaching it is a rejection NO code path observes — an extension's own floating promise, or `showToast`'s deliberately discarded `brokerCall`. **An adversarial review of the fix hardened both twins beyond the filed defect:** `.then` can be a throwing GETTER and `Promise.resolve()` reads `constructor` synchronously, so a hostile handler return value threw past dispatch entirely — out of `onmessage`, invisible to the backstop (a sync throw, not a rejection), and in the object-script twin it aborted the remaining handlers in the loop. The thenable probe now sits INSIDE the try in both realms, and the backstop survives a poisoned rejection reason (throwing `message`/`stack` getters get the generic line, never silence). Nine pinning tests (`extensionAppEventDispatch.test.ts`) + two added to the twin's (`hookDispatchCompletion.test.ts`), including the settle-coupling case a decoupled return would pass every same-microtask test on, and a source-reading guard on the backstop — the bootstrap hardens globals at import so no unit test can drive it; the guard pins top-level registration and NO GATE, because "match the twin" is the exact refactor that would silently reopen the hole. Four sabotage rounds, each redding exactly its own assertion. **The residue this row originally stated was CLOSED the same day, all three members:** the deactivate/terminate race (next paragraph of this row), the menu-click swallow (the next row), and the writeback watch acquiring via `import(…).catch(() => null)` — the catch now writes a console line naming the extension, because a silent null left the subscription PERMANENTLY inert (the publisher-inbox poll never starts, so `WRITEBACK_SUBMISSION_RECEIVED` never fires for that subscriber). **The deactivate race, as built:** teardown was ALSO the last silently-swallowed error path in the realm — `handleDeactivate` and `runDeactivate` caught sync throws with `/* best effort */` and saw async rejections not at all, and the only flow that sends "deactivate" called `worker.terminate()` after one awaited backend call, so an async teardown's final broker write (and its failure report) died with the realm. Now: both teardown hooks are awaited with sync throws AND rejections reported as `{t:"error"}` (guarded extraction, hostile-reason-proof), the worker posts a new `{t:"deactivated"}` ack when teardown genuinely finished, and `unmountWorkerExtension` holds `terminate()` for that ack bounded by `EXTENSION_DEACTIVATE_GRACE_MS` (2s) — attached before the post so a synchronous reply cannot be missed, and skipped entirely for a dead worker so a crashed realm does not cost every unmount the full window. The ack-ordering test's first version PASSED under sabotage — "terminated is still false after N microtasks" is also true of an implementation that merely takes N+1 — and was rewritten around the discriminating fact (the unmount PROMISE must not settle before the ack); the wedge path is pinned under fake timers. **A second adversarial round found the ack contract itself refutable through a POISONED reason** — the report closures extracted `message`/`stack` unguarded, so a thrown `{toString(){throw}}` escaped `runDeactivate` synchronously, and an Error whose own `message` held a function passed extraction and made `postMessage` throw DataCloneError from inside the error path — either way the ack was skipped and every unmount paid the full grace window. One shared `describeError` in `workerHardening.ts` (guarded extraction AND string-coerced results) now feeds every report site in BOTH realms, the bootstrap's `runDeactivate` await is try-wrapped anyway (the ack must not depend on "never rejects" staying true), and both poisoned shapes are pinned, sabotage-verified. | `scriptHost/worker/extensionWorkerContext.ts` (`dispatchAppEvent`, `runDeactivate`), `worker/extensionBootstrap.ts` (`handleDeactivate`), `worker/contextShims.ts` (`dispatchEvent`), `extensionWorkerHost.ts` (`unmountWorkerExtension`), `worker/__tests__/extensionAppEventDispatch.test.ts` |
| ~~**A failed extension menu-item click is indistinguishable from a successful no-op.**~~ **CLOSED 2026-08-20.** Both branches of the click `action` — `CommandRegistry.execute` and the direct `invokeWorkerHandler` relay — now `.catch` into one `clickFailed` that writes `console.error("[ext:…] menu item … failed:")` and shows an error toast carrying the SAME host-drawn attribution as the item's label (`"Boom (Test Add-in)" failed: …`), so all three rejection modes surface: handler threw, 5s invoke timeout, unmount mid-flight. The toast's message half is `echoSafe`d — it is worker-supplied text (BrokerError relays it verbatim), and an unsanitized failure notice under host-drawn attribution is a spoofed-chrome canvas, the exact thing `refuseContribution` guards against. Two tests drive the registered item's real `action` through the FakeWorker for each branch; sabotage (`.catch(() => {})`) reds both, and a hostile-message test pins the sanitization. **Same-day adversarial review of the unmount grace window closed two adjacent holes it widened:** a `register` delivered after the regCleanups drain (the `await revokeBackendCapabilities` gap) installed a live menu item/formula on the drained map — cleaned up by nobody, invisible to the transparency panel; `setupRegistration` now refuses anything from an extension no longer in `mounted` (the pinning test's first version passed under sabotage because its register landed BEFORE the drain and was cleaned by ordering luck — rewritten around the post-drain delivery). And a JIT capability consent dialog raised during the grace window could be answered AFTER `revokeScriptGrants`/`revokeBackendCapabilities`, re-creating live grant state for a terminated worker and genuinely executing the guarded operation; `maybeRequestCapabilityGrant` now checks liveness before showing the prompt AND before recording the answer. Residue, stated: the orphaned dialog itself is not force-closed on unmount (it times out at 60s; answering it now grants nothing). | `scriptHost/extensionWorkerHost.ts` (`setupRegistration`, `clickFailed`, `maybeRequestCapabilityGrant`), `__tests__/extensionContributions.test.ts` |
| **Every `// @uses` script is debugged one line off.** The library prelude ends with `\n`, so `link.prelude + definition.source` puts the author's line 1 on blob line 2. `parseStack` (`debugRuntime.ts:210`) then reports every frame one line too high: breakpoints match the previous statement, and the call-stack view and any surfaced error stack point at the wrong line. Nothing compensates — there is no line offset anywhere in the debug path — and the guard test ASSERTS the trailing newline, so the bug is pinned rather than caught. Being one line bounds the damage; it does not remove it. | `scriptLibraries/linker.ts:340`, `scriptHost/worker/debugRuntime.ts:206-211` |
| **`codeInventory` files object-script macros under the wrong realm, understating what they can reach.** It classifies every module-store record as the grid-only Rust-QuickJS `one-off-script` surface. But the Macro Recorder saves object-script macros into that SAME store with a `runtime=objectScript` marker, and `runMacroModule` routes exactly those to the other realm — `runObjectScriptOnce({ … accessLevel: "unlocked" })`, a real hardened Worker mount with a declared-capability ceiling. The transparency panel therefore reports a strictly smaller reach than the code actually has, which is the one direction a transparency surface must never err in. `parseModuleScriptRuntime` already exists and is not consulted. | `api/codeInventory.ts:430`, cf. `MacroRecorder/lib/macroLibrary.ts:361-367` |
| **The shared Monaco lane type-checks both script realms against each other's globals.** Three surfaces register on lane `"javascript"`: the notebook (which loads `calcula.d.ts` — `Calcula`, `model`, `display`), object scripts, and one more. The file names this hazard and then applies the mitigation only to the lane object scripts are NOT edited on, so `Calcula.*` autocompletes and type-checks clean inside an object script (where it does not exist), and the notebook inherits object-script suppressions. Wrong-realm globals look correct in the editor in BOTH directions — the same realm-confusion that made `export function setup` pass every check and fail at mount. | `extensions/_shared/lib/monacoScriptLanes.ts:39`, `authoringLanguage.ts:102-107` |
| **One unparseable module breaks EVERY in-cell button.** The in-cell button preamble concatenates every module in the workbook script store into ONE source string and hands it to the Rust QuickJS realm, with no per-module compile guard. `listWorkbookScripts()` returns object-script modules too — Worker-realm source authored against `context`/`api.*`, which that realm cannot parse — so a single such module makes the whole concatenated preamble fail and every in-cell button stops working, not just the one whose module is bad. The FLOATING-button twin in the same extension has the per-module guard; the in-cell path does not. | `extensions/Controls/Button/interceptors.ts:127` |
| **The Object Script Editor's own SAVE path never runs the L1 linter, so a HUMAN learns nothing until the script throws at mount. FILED 2026-08-25, and the undecided half is what a finding should DO to a person's save.** `gateObjectScriptSave` does exactly two things — compile TypeScript to JavaScript, then hand the result to the scratch-worker parse (`hostValidateScript`, which never executes it) — and neither knows what `context` offers. So a person who types `context.onSheetChange(…)` into a BUTTON script saves it, mounts it, and finds out when the handler never fires; the identical source from a MODEL is rejected in front of `draft_object_script` as `wrong-object-type` and costs one free local repair round, because `draftGate` calls `validateScriptSource(source, objectType)` and the editor calls nothing. The one validator call the editor does make is the AI-draft banner's, which reads only `declared-not-observed` and is deliberately unnarrowed. **Wiring it is an afternoon; deciding the verdict is not.** An ERROR blocks a save the author may have good reason to be making mid-edit (a helper not written yet, a hook name pasted from the other object's script); a WARNING is one more line beside a console that already carries compile errors; and the compile+parse gate above it already refuses to store anything that cannot run, so the store is never left holding dead text either way. That is a product call, which is why this is filed rather than guessed at. | `authoringLanguage.ts:146-179`, `ObjectScriptEditorApp.tsx:1285-1306`, `CodeEditorDialog.tsx:579`, `draftGate.ts:196` |
| **The validator has no TIER axis, so `context.api.…` in a RESTRICTED draft validates clean and is `null` at run time. FILED 2026-08-25 — the same insight as the object-type narrowing, one axis over.** `context.api` is declared `UnlockedAPI | null` and the Worker binds it only at the unlocked tier (`api: spec.tier === "unlocked" ? buildUnlockedShim(rt) : null`), while `draftToScriptDefinition` mounts EVERY AI draft `"restricted"` — deliberately, so a model can never arrive pre-escalated. L1/L2 cannot see the difference: the whole of `scriptValidation/` contains the string `tier` **zero times**, so the reach check happily accepts `api.setCellValue` for a script that will find `api` null. Not silent today, but narrowly so: `draftGate` runs L3 at `"restricted"`, re-runs at `"unlocked"` when that fails, and ALLOWS the draft with a note naming the tier — a deduction, not a regex. That catch needs a preview realm to exist, and the human save path above has none, so the same source typed by a person reaches mount unremarked. **The data is already emitted**: `scriptSurfacePolicy.ts` carries a `tier` column per row (`restricted` / `unlocked`), the same artifact the reach check already walks. Scope is a second optional argument, one finding code, and the judgement of what a tier finding is worth — a restricted script CAN be raised by the reviewer, so it is at most a notice, never a block. | `contextShims.ts:890`, `scriptDrafts.ts:95-104`, `scriptSurfacePolicy.ts:47`, `draftGate.ts:224-246` |
| **`scriptPreview`'s `summarize()` has no production caller — a second summariser of the same report, kept alive only by its own tests. FILED 2026-08-25.** It is exported from the preview's public index and imported by nothing outside `snapshotAndReport.test.ts`; every surface that tells a user or a model what a dry run did goes through `describeDryRun` in `draftGate.ts` instead. The two agree today only because the unexercised-hook caveat added on 2026-08-25 was written into BOTH by hand — which is the hazard stated exactly: one of the two is read by nobody, so the next wording change has even odds of landing where no user can see it is wrong, and its test will still be green. Either delete it, or make `describeDryRun` call it and keep one sentence in one place. Do not leave two. | `report.ts:139`, `scriptPreview/index.ts:327`, `snapshotAndReport.test.ts:158-262`, `draftGate.ts:296` |
| **An authoring run is a SECOND provenance surface, and nobody decided whether it belongs in the audit trail. FILED 2026-08-27 with the AI script transcript.** The per-workbook audit trail already spans script activity and renders as "Scripts" / "Capabilities" (`AuditLogPane.tsx:68-69`), fed authoritatively from Rust (`commands.rs:180`, `record_script_grid_mutation`). The transcript does not go there: it appends to its own store, keyed by script id, written when a human accepts, rejects or saves an edit (`ObjectScriptEditorApp.tsx:1384,1608`) and once per AI-created draft at delivery under its `draft-*` id (`authorRunner.ts:501`, `authoring_log.rs:262`) — a session-only bucket the save path filters out of the archive until Save adopts it onto the saved script's id. So *"this script was written by qwen2.5:7b in four attempts on 2026-08-26 and the author rejected the first two"* is now a fact the workbook holds in a place the audit viewer does not read, and a reader asking "where did this script come from" has two surfaces to know about instead of one. **The question is not where the TEXT lives** — the full prompts, replies and reasoning belong in the editor, nobody wants them in an audit row — **it is whether a one-line row per decided run belongs in the trail**, or whether the trail stays strictly about what code DID rather than where it came from. Cheap to decide now; expensive once a second reader is written against either surface, which is the only reason it is filed rather than left to whoever notices. | `AuditLogPane.tsx:68-69`, `scripting/commands.rs:180`, `scripting/authoring_log.rs:247,262` |
| **The `script_authoring` manifest feature id is declared and read by NOBODY. FILED 2026-08-27.** `zip_io.rs:152-153` pushes the id whenever the workbook carries `script_authoring.json`, so `read_calcula_manifest` (`zip_io.rs:587`) can answer *"does this file carry the prompts its author typed?"* without materializing the workbook — which is a privacy question someone should be able to answer before emailing a `.cala`. Nothing asks it. That is precisely the state `media` is in, and the consistency was deliberate (`zip_io.rs:136`), but consistency is not the argument: **if the point of the id is privacy, some surface has to SHOW it** — the Application Inspector (`calp_inspector.rs:623`) or a pre-send check — or the id is only ever a grep target and the honest thing is to say so. What is NOT missing is the guarantee: the `.calp` firewall is real and has teeth (`publish.rs:1317` publishes a workbook whose transcript holds a distinctive sentence and walks every artifact the registry wrote to prove the bytes appear in none of them). The gap is the READER, not the containment. | `core/calcula-format/src/zip_io.rs:136,152-153,587`, `core/calp/src/publish.rs:1317`, `app/src-tauri/src/calp_inspector.rs:623` |
| **A non-English request preamble is not stripped from an AI script's name — ENGLISH WRAPPERS ONLY, by decision. FILED 2026-08-27.** `scriptNameFromIntent` de-preambles English request wrappers (`scriptName.ts:35`), so `"skapa ett skript som formaterar…"` matches nothing and the name becomes the first ~45 characters of the Swedish sentence: readable, and strictly better than the six-words-verbatim rule it replaced (which named every AI script after its own request preamble), but not de-preambled. **Guessing `skapa \| gör \| skriv \| bygg` + `skript \| makro` was REJECTED rather than deferred**, and the reason is in the guards themselves: the wrapper must capture a non-empty lead AND a mandatory script noun (`scriptName.ts:35,39`) because a wrong alternation EATS A REAL VERB — "add a guard so it does nothing" losing its "Add", "function keys should be ignored" losing its subject. Those guards only protect the language they were written against. What unblocks this is the phrasings the owner actually types, not more regex; until then the fallback is honest and visible. | `app/extensions/AIChat/lib/scriptName.ts:35,39` |
| **The 17 hand-written object scaffolds still teach a script with NO RUN TARGET. FILED 2026-08-27, deliberately deferred out of the AI-authoring landing.** `getScaffoldTemplate` (`scriptableObjectScaffolds.ts:9`, one 17-branch switch at `:12`) returns hand-written strings — each `function setup(<type>) {` with commented-out handlers and no top-level work function. That is the exact shape the same landing taught the MODEL to stop producing (`scriptTemplate.ts:71`, `buildRunnableSkeleton`) and that the validator now reports as `no-run-target`. So the inversion is live and visible: **press New Script and you get a template you cannot start with Run (F5); ask the AI and you get one you can.** Rewriting the 17 through `buildRunnableSkeleton` is mechanical, and what makes it its own slot rather than a drive-by is that each branch carries per-type teaching prose (which hooks that object has, what its payload looks like) that must survive the rewrite — a blanket replacement would trade one teaching defect for a bigger one. **The IntelliSense half is already done and does not have to be remembered:** `annotateScaffold` matches the exported form (`monacoTypings.ts:213`), so a rewritten scaffold emitting `export function setup(context)` keeps its `@param {ObjectScriptContext}` line instead of silently losing completions. | `app/src/api/scriptableObjectScaffolds.ts:9,12`, `app/src/api/scriptHost/scriptTemplate.ts:71`, `monacoTypings.ts:213` |
| **The first Run (F5) on a DIRECT-branch skeleton executes the work TWICE, and Stop makes it a THIRD time. FILED 2026-08-27 — which behaviour one F5 should MEAN on a runs-at-mount script is a product call for the owner, so it is filed rather than guessed at.** The four types whose template wires no hook (`workbook`/`sheet`/`textbox`/`chartMark` — the `null` rows of `PREFERRED_HOOK_BY_TYPE`) get a `setup` that ends `return run()` (`scriptTemplate.ts:100`), so MOUNTING the script runs it. `runAtCursor` on a script with no open session starts one (`debugger.ts:707-709`); `hostStartDebugSession` sets `autoInvokeSetup` true for every mount the debugger does not own itself (`host.ts:2218`), the instrumented remount invokes `setup` (`worker/bootstrap.ts:320`), and the direct branch executes the work — then `runAtCursor` fires `method:run` (`debugger.ts:734`). The `notReady` guard above the fire (`debugger.ts:722-732`) does not stop it, correctly by its own lights: `run` IS a registered run-target on a non-inert mount (`buildRunTargetRegistrations` excludes only `setup`, `debugWrapper.ts:317-333`; trigger ids at `host.ts:1933`). Nor does the cursor position matter: `resolveRunTarget`'s single-non-setup-function fallback (`debugger.ts:598-599`) resolves the skeleton to `run` from ANY cursor line, inside `setup` included — so EVERY first F5 on such a script double-executes side-effecting work (an `addRow` body appends two rows); second and later F5s fire once, because the session is already open. And closing the session runs the work a THIRD time: `hostStopDebugSession` remounts the production definition (`host.ts:2495`), and that plain mount runs `setup` → `run()` again. **Constraints on any mechanical fix, recorded so the next session does not rediscover them:** it must cover BOTH mount-side executions (session open AND stop), and an inert mount is only safe for the RUN GESTURE on a script whose `setup` registers no hooks — a hook-wired script mounted inert registers nothing and the object goes DEAD for the whole session (`host.ts:2208-2210` states exactly this rationale). The alternative — when the gesture itself just created a non-inert session, REPORT "the script ran at mount" instead of firing — avoids both hazards for the direct branch, but needs the editor to know which branch the script is. The severity is not speculative: `host.ts:2296-2306` records fixing this same double-execution-per-gesture shape for module macros, and that fix (`autoInvokeSetup: false` on a `transientDebugMounts` entry) is confined to mounts the debugger owns — it cannot reach a standing object-script mount, which is why the direct-branch skeleton reopened the shape one door over. | `scriptTemplate.ts:100`, `debugger.ts:598-599,707-709,722-732,734`, `host.ts:1933,2208-2210,2218,2296-2306,2495`, `worker/bootstrap.ts:320`, `debugWrapper.ts:317-333` |

### 2.2 The `Persisted<T>` migration — the SAVE SOURCES are done (2026-08-17); the rest is not

`AppState` has **105 fields**: **63** are `Persisted<T>`, **40** are still a bare
`Mutex`/`RwLock`, and 2 are neither — `undo_stack` and `calc_cancel`. **These four numbers are
PINNED by `the_appstate_lock_census_reconciles` (`document_effect.rs:1191-1228`), which parses the
struct body and fails the build when the split moves.** Do not re-derive them by hand and do not
edit them here without running that test — the figures above stood at 59/43 until 2026-08-18 while
the test already said 62/40, which is exactly the drift this file exists to prevent. (104/62 until
2026-08-27, when `script_authoring` was declared `Persisted<T>` from the start and the test moved
first, as it is supposed to.) (Do not read "neither" as
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

### 2.x On-grid CONTROLS have no reachable right-click menu — **OPEN, found 2026-08-28**

`app/extensions/Controls/lib/controlContextMenu.ts:402` registers the control's z-order / flip /
delete items into `gridExtensions`. That registry is rendered only by `GridContextMenuHost`
(`app/src/shell/Overlays/GridContextMenuHost.tsx:74`), which opens only on
`AppEvents.CONTEXT_MENU_REQUEST` — and Core deliberately does **not** emit that event for a
right-click that lands on a floating object (`app/src/core/components/Spreadsheet/Spreadsheet.tsx:1009`,
"Cell options on an object right-click are always wrong"). Controls' regions carry a `floating`
rect (`app/extensions/Controls/lib/floatingStore.ts:633`), so every right-click on a control takes
that early return. The items are registered, ordered, gated — and unreachable by right-clicking the
object they belong to.

**This is the same defect the Floating Range had**, fixed 2026-08-28 by giving the FR its own
capture-phase `contextmenu` listener and object menu (the Charts / Slicer / TimelineSlicer
precedent the Spreadsheet.tsx comment already assumes). Controls was the extension the FR copied
its registration from, so the precedent it followed had itself never been verified end to end.

Not fixed here because it is a second extension with its own menu semantics and its own
design-mode question, and nothing in the reported work touched it. The FR fix is the worked
example to copy: `app/extensions/FloatingRange/index.ts` (listener + overlay registration) and
`app/extensions/FloatingRange/lib/frContextMenu.ts` (the item model, kept separate from the
renderer). Note the accidental path that hides it in casual testing: right-clicking a grid cell
that is *already inside the current selection* leaves the object selection intact
(`app/src/core/hooks/useMouseSelection/selection/cellSelectionHandlers.ts:107`), so the object's
items can appear on a cell far from the object — which looks like the menu working.

### 2.z Refresh never re-materializes a subscribed application's PIVOTS (2026-09-01)

`calp_refresh_apply` (`app/src-tauri/src/calp_commands.rs`) never reads
`pull_result.pivot_definitions` and never writes `pivot_state.pivot_tables`. It deliberately
carries the OLD pivot ledger entries forward — the filter at the ledger merge keeps
`o.kind == "pivot" || o.kind == "dataSource" || o.kind == "extensionData"` from the previous
version — with a comment stating that a refresh "does not touch" those kinds.

Two consequences, one now mitigated and one still open:

- **Blank pivot regions — MITIGATED 2026-09-01.** Publish strips pivot OUTPUT cells (subscribers
  recalculate them); refresh replaces the whole grid with that stripped artifact. The frontend
  now re-renders every pivot cache through `announceSubscribedContentReplaced`
  (`app/extensions/Distribution/lib/refreshAftermath.ts`), which is the fan-out
  `calp_reset_subscription`'s caller has always done and the refresh dialog never did. The
  cells come back.
- **STILL OPEN: a publisher's pivot CHANGES never reach a subscriber.** Adding, deleting or
  re-laying-out a pivot in v2 ships in the artifact and is then discarded by the ledger merge,
  so the subscriber keeps v1's definitions forever. Nothing in the preview or the result
  reports this. `calp_reset_subscription` restores published definitions correctly and is the
  worked example to copy; the pull path does it via `restore_pulled_pivots`.

Not a data-loss bug — the subscriber's own layout survives, which is arguably the friendlier
default — but it is undeclared, and "the publisher changed the report and you did not get it"
is the kind of silence this program exists to remove. Decide whether refresh should adopt v2's
definitions (matching reset) or keep the subscriber's (matching today), then SAY which in the
preview.

### ~~2.aa Per-cell selection on the PUSH side needs a state-agnostic evaluator~~ — **CLOSED 2026-09-02**

**Shipped by the third route, the one this row called the fallback: a real undoable revert,
publish, then a programmatic undo.** The evaluator refactor was not needed and was not done.

The row's own condition on that route — *"any failure path has to guarantee the un-revert"* — is
what took the work. A bare `undo()` cannot: it is a blind `pop_undo()`, the dialog is
deliberately non-modal, and a publish takes seconds during which the author can edit and an MCP
tool can write (`mcp/tools.rs:336`, genuinely concurrent — sync Tauri commands share the main
thread, MCP does not). So `calp_hold_back_cells` now OWNS its undo transaction and
`commit_transaction()` returns the id it stamps, and `undo` takes an `expected_seq` it checks in
the same critical section as the pop. An intervening write makes the un-revert refuse with a
sentence rather than reverse somebody else's work.

*A first cut read the top of the stack before and after the write and took the difference. That
is a second critical section and therefore the same defect one layer down — an entry landing in
the gap is adopted as the caller's own, and the un-revert then reverses a stranger's write
confidently. The id is claimed, not observed.*

**And the "also required" clause was real, was missing, and is now enforced.** This row said
cells that cannot be re-derived locally — CUBE, UDF and GATHER — must REFUSE when one lies in the
dependency closure of an unticked cell. The feature shipped without it, and the consequence was
worse than an error: on a non-active sheet `preserved_cube_value` reads the cube cell's OLD value
straight back out of the grid and re-writes it, so the published artifact carried the base
version's input beside a number derived from the author's held-back one — a pair that was never
simultaneously true, silent because nothing on the receiving side recalculates and the push diff
hides formula cells whose formula did not change. (On the active sheet the same absent prefetch
gives `#N/A`/`#NAME?` instead; GATHER collapses to `0`, which looks legitimate.) The code comment
claiming these were "PRESERVED, which is the right answer for them anyway" was true only of the
one branch and false whenever a cell reference is an ARGUMENT — which all three families accept.

`app/src-tauri/src/non_derivable.rs` walks the workbook dependency closure from the held-back
cells (edges from `stored_ast_references`, the same primitive `build_workbook_plan` and
`SheetDependencyIndex` are built from) and refuses by name. Cross-sheet edges are matched
case-insensitively, whole-column/row reads are followed, and an unrelated cube cell elsewhere in
the workbook does not block the push.

### 2.aa (original statement, kept for the record)

**Owner decision taken 2026-09-01:** unticking a change in the push diff should mean *publish
without it, keep it locally* — the git-index model. Not *discard it from my workbook*.

That is sound only if the published artifact is RECALCULATED without those cells, because
nothing on the receiving side ever will be: `materialize_pull_result` (pull and checkout)
evaluates no cell, and `open_file` rebuilds dependency edges without evaluating.

**Why it is not a contained change.** The intended shape — clone the grids, revert the unticked
cells in the clone, recalculate the clone, publish the clone — needs an evaluation pass that can
run against caller-supplied grids. Half of that already exists: `build_workbook_plan`
(`app/src-tauri/src/calculation.rs`) takes `grids: &[engine::Grid]` by slice and builds the whole
workbook dependency graph, so the ORDER is computable off-state. The evaluation itself is not:
`run_calculation_pass` and `recalculate_sheet_values` take `state.grid.write()`,
`state.grids.write()` and a dozen further `State<T>` handles directly. Making either
state-agnostic is a refactor of the most consequential code in the product.

**The mechanisms that do NOT work, and why — so nobody re-derives them:**

- *Substitute base values at serialization time.* One injection point exists (the `Cow` in
  `core/calp/src/publish.rs` that feeds both `data.json` and `cell_styles.json`), and it
  publishes an internally inconsistent artifact. This is the option the whole question is about
  rejecting.
- *Transient write* (`DocumentEffect::transient`): revert, publish, restore. Technically legal,
  and wrong here. The restore registry is in memory, so a crash during the publish — which is
  network I/O to a share — leaves the document reverted with the author's edits gone, because a
  transient write is not in the undo stack. `scenario_show` accepts that window because a
  scenario is cheap to re-apply; a developer's uncommitted work is not.
- *Real undoable revert, publish, then programmatic undo.* Safe (a crash leaves the edits in the
  undo stack and the document dirty for AutoRecover) and it does deliver the chosen semantics —
  but the author watches their own sheet hold reverted values for the duration of a network
  publish, and any failure path has to guarantee the un-revert. This is the fallback if the
  evaluator refactor is judged too large.

**Also required whichever route is taken:** cells that cannot be re-derived locally — CUBE, UDF
and GATHER — must REFUSE rather than ship, when one lies in the dependency closure of an
unticked cell. `build_workbook_plan` supplies that closure.

The RESET side of the same request shipped 2026-09-01 and is unaffected; it is sound because the
artifact produced is the subscriber's own live workbook and the command now recalculates the
sheets it mixed.

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

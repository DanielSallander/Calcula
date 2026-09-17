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
reproduction live in `tests/regression/bug-ledger.json` (**113 entries, 111 fixed, 2 open** as of
2026-09-13 — recounted from the file, not carried forward; it moved three times in two days, and
the figure this sentence carried before today said 106/104/2, which was 7 entries and 2 open bugs
behind). The two open are **BUG-0098** (the unreproduced backend wedge in §2.5, kept open
deliberately — the guards now make a recurrence diagnosable, and it is explicitly not closeable by
a speculative fix) and **BUG-0108** (percent-of-visible-total measures are wrong in a
slicer-filtered BI pivot — level-1 slicers still use the host-side mask, so the engine's
denominator includes rows the host hides afterwards). **BUG-0108's documented workaround was
itself broken and is FIXED 2026-09-13**, which is a separate defect from the entry: the
engine-evaluated totals plan built every grain query with `filters: vec![]` and no
`scoped_in_filters`, so a PINNED (level-2) slicer produced engine-filtered leaf rows and
engine-UNFILTERED totals. Worse than wrong subtotals — a pin CLEARS the host masks (which is what
opens the totals gate and passes `apply_total_overrides`' all-visible check) and an out-of-zone
pinned field leaves a zero-mask `SlicerFilter` so it stays in GROUP BY, which makes `include_leaf`
true; since `apply_total_overrides` REPLACES an accumulator, the unfiltered full-depth grain
overwrote the pin-filtered LEAF cells. Pinning a slicer made the pivot ignore that slicer
entirely. `BiTotalsPlan` now carries the pivot's own `scoped_in_filters` and every grain sends
them (`app/src-tauri/src/pivot/totals.rs`, `grain_request`; populated at
`app/src-tauri/src/pivot/commands.rs`). THE ENTRY STAYS OPEN: this repairs the mitigation, it does
not close the bug — an ordinary level-1 slicer click still never re-queries the engine.

**The fix for the entry itself was BUILT, MEASURED AGAINST ITS OWN CONSEQUENCES, AND WITHDRAWN on
2026-09-13.** Owner decision that day: route ordinary (level-1) slicers into the engine for pivots
whose measures are filter-context sensitive, fail closed when undecidable. The detector was built
and is correct — `app/src-tauri/src/pivot/mask_safety.rs`, expands measure refs first (a bare
`[Share Pct]` looks additive until inlined) and routes on context ops / window / time-intelligence
/ `ISFILTERED` — the routing was implemented through the existing pin path, and an adversarial
pass over four lenses then found NINE defects it introduces. The module is KEPT and tested; the
call site is ABSENT rather than flagged off, because a flag is a second untested configuration of
a path already known to be wrong. `apply_pivot_filter` carries a note where the call would go, and
`this_detector_is_still_unwired_and_says_so_where_it_would_be_wired` fails if that note is removed
without a real wiring guard replacing it.

The blockers, in the order they must be dealt with:

1. **A compound `RESET`/`ALL` measure plus a request filter is a TYPED REFUSAL in the engine** —
   `reset_with_slicer_on_cleared_table_fails_closed`
   (`model-engine-lib/crates/engine/src/clear_reset_tests.rs`), refused in
   `engine-query/src/executor/pipeline/local_aggregation.rs`. A
   `% of grand total = DIVIDE(SUM(x), SUM(x, RESET()))` pivot MASKS CORRECTLY TODAY; routing turns
   it into a hard query error on an ordinary click. This one alone disqualifies the change: it
   converts right answers into failures. Either narrow the detector to exclude what the engine
   will refuse, or extend per-measure filter removal to compound sub-expression contexts.
2. **The slicer's own value domain collapses.** A routed query rebuilds the cache from the
   filtered result, so the column holds only the SELECTED members. The escape hatch for exactly
   this exists — `slicer/commands.rs` fetches the full domain from the model instead of cache
   uniques, and its comment says "the slicer could never re-expand" — but it is gated on
   `slicer.filter_level >= 2`, and a routed slicer stays at level 1. Siblings collapse too; in
   exclusive mode the user cannot move between members without clearing first; and multi-select's
   "all selected ⇒ clear" test (frontend AND `set_slicer_item_selected`) then compares against a
   one-element list.
3. **The pivot's own header dropdown reports a filtered pivot as unfiltered.** `get_pivot_field_info`
   derives `is_filtered` / visible items / manual filter solely from `hidden_items`, which routing
   deliberately clears, and `get_pivot_field_unique_values` reads cache uniques. That command
   already carries a precedent escape hatch for calculation groups; routing needs the equivalent.
4. **Bare cache column names are attributed to the first model table owning that name.** A star
   schema with `dim_date[Year]` and `dim_budget[Year]` sends the filter to the wrong table with no
   error. Pre-existing for pins; routing makes it reachable from an ordinary click, where the old
   host mask was keyed by `source_index` and could not be mis-attributed.
5. **Time-intelligence truncation.** `YTD(SUM(x))` over months sliced Mar–Jun accumulates only
   Mar–Jun. Replacing one wrong number with a different wrong number — arguably `has_window` and
   `contains_time_intelligence` should NOT route at all.
6. **Boolean and Float dimension values are spelled differently by host and engine**, so a routed
   IN-list matches zero rows and the pivot comes back empty (`pivot/utils.rs`).
7. **A refused routed query leaves the engine filter persisted**, so the pivot stays broken across
   refresh and reopen until the user finds Clear Filter.
8. **Above `MAX_TOTAL_GRAINS` (24) the leaf override is silently discarded** (`pivot/totals.rs`),
   so a wide routed pivot displays BUG-0108's exact symptom again — now with a slower click.
9. **Undo does not undo a routed filter**: the repaint uses the pre-click cache so it LOOKS undone
   while `definition.engine_filters` keeps the filter, which then persists on save.

Items 4, 6, 7 and 9 are REAL TODAY for explicit pins — routing did not create them, it would only
widen their reach — and so is 8 now that the totals plan depends on that override. They are worth
fixing whether or not routing is ever enabled. Also noted: `.calp` publish validates every pivot
field name against the published model EXCEPT `engine_filters` (`app/src-tauri/src/calp_commands.rs`),
and non-additive aggregates (AVERAGE/DISTINCTCOUNT declared as measures without a context op) are
classified mask-safe, so their totals stay wrong under any slicer.
**BUG-0113 closed 2026-09-13**, MEASURED against a real `tauri build` rather than argued.
**BUG-0104 closed 2026-09-13.** Its engines had both worked since 2026-08-19; the last dead half
was the Sort dialog, which offered "Conditional Formatting Icon" and then showed "A to Z" for the
order, so it never named an icon and the backend refused every such sort with a correct message
about a choice the UI never offered. The dialog now lists the icons the column actually shows.
WHAT REMAINS IS A MISSING FEATURE, NOT A LIE, and is filed in §2.1 rather than in the ledger: the
AutoFilter dropdown still cannot express an icon choice, and a script can say `sortOn:"icon"` but
cannot name the icon. Nothing reports success while doing something else — the icon filter fails
CLOSED and its door validator refuses — which is the property that entry existed to restore.
BUG-0095, BUG-0096 and BUG-0097 were fixed 2026-08-17; BUG-0099,
filed and fixed the same day, is the sibling of BUG-0086 — that fix turned out to be
SPELLING-SPECIFIC, and a capitalised `;BASE64,` tag or a percent-escaped body bypassed it entirely.
Nothing in this file duplicates a ledger entry. **Recount before restating**: the histogram is one line of node, and this figure has
been stale within a day of being written more than once.

---

## 1. Owner calls — decisions, not work

These needed a product judgement before anyone wrote code. Each was small to implement and
consequential to get wrong, which is why none of them had been decided under cover of another fix.

**SECTION 1 IS FULLY CLOSED.** 1.1-1.5 were decided and built on 2026-08-16; 1.6 was analysed at
the owner's request, then fixed on 2026-08-17 — its original statement is kept below, struck, for
the record.

This header said "ONLY 1.6 IS STILL OPEN" for three weeks after 1.6 closed, which is the staleness
direction rule 3 of §3 names as the costlier one: a row claiming something is broken that now works
sends the next reader to re-fix working code. Corrected 2026-09-09.

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
| **Filtering by conditional-formatting ICON works in the engine and cannot be reached from the UI. FILED 2026-09-13, when BUG-0104's other half closed.** `FilterOn::Icon` is fully implemented — `resolve_filter_icons` computes one `RangeStats` per rule per pass (asking per row would re-walk every rule's range for every row and make the pass quadratic), `icon_criteria_keeps` decides, and `validate_icon_criteria` refuses at the door the three shapes that cannot be honoured. It also FAILS CLOSED: a criteria naming nothing HIDES the row rather than showing every one, deliberately, because the whole `auto_filters` map is written into `.cala` and restored verbatim, so a malformed criteria re-enters state on LOAD without passing the door — and showing every row there would report a filter as applied while filtering nothing, which is exactly the lie BUG-0104 was. **So nothing here is wrong; it is unreachable.** Three pieces are missing and they are independent: (1) the AutoFilter dropdown has no "Filter by Icon" submenu, and unlike sort there is no filter-by-COLOUR submenu to copy, so it is genuinely new UI — it also needs Excel's "No Cell Icon" entry, which the backend already models as `icon.noIcon`; (2) `AutoFilterColumnCriteria` (`app/src/api/autoFilterService.ts`) has no `icon` kind, so the seam cannot carry one; (3) the `vSortRange` key allowlist (`app/src/api/scriptHost/validators.ts`) still omits `icon`, so a script can say `sortOn:"icon"` and never name one — and whoever adds that key MUST land its shape check in the same commit (`iconSet` in the existing `CF_ICON_SET_TYPES`, `iconIndex` a non-negative integer), because a new key in that allowlist defaults to UNVALIDATED, which is the hazard CLAUDE.md names by example. A script also cannot read back an icon it set (`ScriptAutoFilterColumn`). The Sort dialog's picker is the worked example to copy: it calls `getRangeIcons`, which wraps `resolve_icons` — the SAME cascade the sort and filter key on — rather than scanning `evaluate_conditional_formats`, because that command returns one result per MATCHING RULE in STORAGE order while `resolve_icons` sorts by PRIORITY and takes the first, so a picker built on it can offer an icon no cell shows. | `app/src-tauri/src/autofilter.rs` (`FilterOn::Icon`, `icon_criteria_keeps`, `validate_icon_criteria`), `app/src-tauri/src/conditional_formatting.rs` (`get_range_icons`), `app/extensions/AutoFilter/components/FilterDropdownOverlay.tsx`, `app/src/api/autoFilterService.ts`, `app/src/api/scriptHost/validators.ts` |
| **The APPROXIMATE (sorted) lookup comparators rank values differently from the exact ones, so `=MATCH(1,A1:A4,1)` answers the wrong row.** MEASURED 2026-08-24 during the Excel-symbol programme, on a column holding `{1, "1", TRUE, "apple"}`: `=MATCH(1,A1:A4,1)` answers **3** where Excel answers **1**. The exact family was unified in that programme (`=`, `MATCH` type 0, VLOOKUP/HLOOKUP FALSE, XLOOKUP and the pass cache now share one predicate and agree); the APPROXIMATE family was deliberately left, and it is the last surface that disagrees with the ladder. `compare_values` ranks Number vs Text on its own rules rather than Excel's `number < text < FALSE < TRUE`. **WHY IT WAS NOT DONE WITH THE REST, and why it needs its own slot rather than a batch:** this is not a predicate swap. `SortedKeys::build` (`core/engine/src/lookup_cache.rs`) only permits binary search over HOMOGENEOUS, verified-sorted key vectors under one comparator class, so changing the ordering changes that precondition — and a binary search over a vector that is no longer sorted under its own comparator does not error, it returns THE WRONG ROW, silently, on the exact code path built to make lookups fast. It is the one remaining formula-engine change that can break lookups across the board without reddening anything. Wants a dedicated pass with a differential harness over both paths (scan vs cache) before the ordering moves at all — `lookup_cache::tests::exact_index_answers_exactly_what_the_scan_path_would`, added by that programme, is the shape to copy for the approximate path. | `core/engine/src/evaluator.rs` (`compare_values`), `core/engine/src/lookup_cache.rs` (`SortedKeys::build`), surface-vs-answer table in `memory/project_excel_symbol_alignment.md` |
| **Column-header separators are not device-pixel snapped — the same defect just fixed for cell borders.** `headers.ts:168,330` stroke at a hand-rolled logical `+0.5` instead of snapping into DEVICE space the way `grid.ts:189-191` has always done for the gridline hairline. Column boundaries are `22 + k*64.29`, so at dpr 1 every column-header tick smears across two device pixels at partial alpha rather than landing on one. Row-header ticks are on the integral axis and are fine — the identical top-crisp/side-blurred asymmetry that BUG-0101 turned out to be. **Deliberately excluded from BUG-0101's fix**, which is why this row exists: the file has 18 stroke calls and NO unit tests, and the change moves grid-bearing goldens (BUG-0101's design review estimated 49; a later byte census said 51 — recount before scheduling, and note `headers.ts` is pure CRLF while `grid.ts` and `cellBorders.test.ts` are LF). The fix itself is the parity-snap helper from `cells.ts` applied three times. | `headers.ts:165-168,327-330,442-445`, `grid.ts:189-191`, BUG-0101 |
| ~~**`model-engine-lib` is run by no CI workflow at all.**~~ **CLOSED 2026-09-12 — `ci.yml` now carries a `rust-model-engine` job.** Same shape as `rust-core`: `ubuntu-latest`, `working-directory: model-engine-lib`, `Swatinem/rust-cache` keyed on that workspace, `cargo test --workspace`. Linux is safe for THIS workspace unlike the app crate — the only `#[cfg(windows)]` in it is SQL Server integrated auth, which carries an explicit `#[cfg(not(windows))]` refusal arm (`engine-connectors/src/sqlserver.rs:184`), so the two Windows-only tests simply do not run there. Measured on the dev box before the job was added: **2,660 passing test cases, 0 assertion failures, 75 ignored**. The only reds were three `engine-core` DOCTESTS failing `LNK1102: out of memory` under parallel linking on this ARM64 host; they pass at `--test-threads=1`, so it is a dev-box hazard of exactly the class `ci.yml`'s header says Linux sidesteps, not a defect. **The DB-gated half is UNCHANGED and remains the owner call this row always said it was:** those 75 `#[ignore]`d tests are the whole differential-vs-SQL corpus — the engine's only ground truth for DAX semantics — and `cargo test` prints "75 ignored" and passes anyway, so the job's comment says that out loud rather than letting a green be read as more than it is. Two figure corrections while closing: the "2,230 tests across 145 files" came from a `#[test]` grep and cargo's own count supersedes it; the **75 was right** and a grep saying 76 is counting a doc comment in `rest_connector/tests.rs:4` that literally reads "no `#[ignore]`". | `.github/workflows/ci.yml` (`rust-model-engine` job), `model-engine-lib/`, measured 2026-09-12 |
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
| **The 17 hand-written object scaffolds still teach a script with NO RUN TARGET. FILED 2026-08-27, deliberately deferred out of the AI-authoring landing.** (2026-09-02: an 18th branch, `form`, was added WITH a top-level `run()`; the 17 older ones are unchanged.) `getScaffoldTemplate` (`scriptableObjectScaffolds.ts:9`, one 17-branch switch at `:12`) returns hand-written strings — each `function setup(<type>) {` with commented-out handlers and no top-level work function. That is the exact shape the same landing taught the MODEL to stop producing (`scriptTemplate.ts:71`, `buildRunnableSkeleton`) and that the validator now reports as `no-run-target`. So the inversion is live and visible: **press New Script and you get a template you cannot start with Run (F5); ask the AI and you get one you can.** Rewriting the 17 through `buildRunnableSkeleton` is mechanical, and what makes it its own slot rather than a drive-by is that each branch carries per-type teaching prose (which hooks that object has, what its payload looks like) that must survive the rewrite — a blanket replacement would trade one teaching defect for a bigger one. **The IntelliSense half is already done and does not have to be remembered:** `annotateScaffold` matches the exported form (`monacoTypings.ts:213`), so a rewritten scaffold emitting `export function setup(context)` keeps its `@param {ObjectScriptContext}` line instead of silently losing completions. | `app/src/api/scriptableObjectScaffolds.ts:9,12`, `app/src/api/scriptHost/scriptTemplate.ts:71`, `monacoTypings.ts:213` |
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
(`fixtures.ts:244`, `:316`). Same shape, equally blind — it reported healthy every time. As for
blast radius: **`globalTimeout` is now 2 h** (`playwright.config.ts:39`) — this paragraph said
nothing set it, which was true when written and is not now — but **`maxFailures` is still unset**,
so Playwright's default of unlimited failures applies and nothing bails out on a run that has
clearly gone wrong. The latch in `checkForWedge` is what actually bounds the cost today: two bad
probes and every later test fails in ~0 ms instead of paying its full 300 s
(`playwright.config.ts:120,124`).

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

**Two holes in the guard closed 2026-09-12, both found by asking what the 16 existing tests do NOT
assert.** Neither changes the bug's status — it is still unreproduced and still not closeable by a
speculative fix — but both were ways the guard could have been absent without anything saying so.

- **The wiring was unpinned.** All of the guard's value rides on one line, the `checkForWedge` call
  in the `appPage` fixture (`fixtures.ts:388`), and neither `wedgeGuard.test.ts` (8 cases) nor
  `wedgeInstrumentation.test.ts` (8 cases) reads `fixtures.ts` at all — they exercise the module
  against a fake page. **Measured: replacing that call with `const wedged = null` leaves all 16
  green** while the guard never runs on a single test. `wedgeGuardWired.test.ts` now pins it, on the
  model of `startupBarrierWired.test.ts` and for the reason that file's own header gives — a guard
  that is correct and unwired is decorative, and its absence is silent. It asserts the import, that
  both call sites exist, that both THROW the verdict rather than computing and dropping it, and
  that the probe precedes the fixture's page operations. Position is asserted rather than assumed
  because it is the whole economy of the thing: those operations are what hang on a wedged backend,
  so a probe moved after them waits out their timeouts first and the run costs hours anyway — which
  is the failure this bug IS.
- **`gridPersistent` had no probe.** It deliberately does not depend on `appPage` (its purpose is
  skipping that fixture's per-test reset), so it inherited nothing, and
  `workflow-dashboard.spec.ts` — **7 tests, its only caller** — was the one journey file a wedged
  backend could still burn in full. It now probes `sharedPage` directly before handing over the
  helper.

Still open on the harness side, deliberately: **`maxFailures` is unset**, so nothing bails out on a
run that has plainly gone wrong for some reason the wedge latch does not recognise.


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

### 2.7 Engine performance audit — what was never built, and was tracked nowhere (filed 2026-09-12)

`docs/design/engine-performance-audit.md` is a 33-agent audit from 2026-07-12: 22 findings, every
one adversarially verified, criterion benches run live, 0 refuted. Waves 0 and 1 shipped
2026-07-13. **The rest was tracked by nothing.** Until this section existed, no row in this file
mentioned any PERF-nn finding, and — worse — **nothing in the repo cited that document at all**, so
not even the doc-to-doc trail that would let a reader find it existed. It survived in one
out-of-repo memory file. That is the failure mode this file exists to prevent, so the status below
was re-derived by opening the code on 2026-09-12 rather than by reading either the audit's §0 or
its §5b.

**Re-verified tally: 8 findings are genuinely unbuilt, not 10.** Two of the audit's own "NOT BUILT"
rows are stale in the already-fixed direction, which §3.3 calls the costlier one:

- **PERF-19 (volatile tracking) is BUILT** and should be read as closed. `core/engine/src/volatility.rs`
  (`contains_volatile_call`, `:91`) plus `volatile_cells_on_active_sheet`
  (`app/src-tauri/src/commands/data.rs:314-352`) and `splice_volatile_cascade_roots` (`:382-405`),
  wired at five cascade sites and pinned by a census test at `:8741`; its own doc comment names
  PERF-19 by id. **Residual, narrower than the original:** active sheet only (`data.rs:311-313`),
  and LAMBDA bodies are not walked (`volatility.rs:47-49`).
- **PERF-18 (per-column ordered index) is MOSTLY obsolete but NOT closeable.** The scan-and-sort it
  targeted is gone from the main path: `eval_column_ref` (`evaluator.rs:1980-1997`) and
  `eval_row_ref` (`:2010-2022`) both delegate to `materialize_axis_rect` (`:2032-2081`), which walks
  a bounded rect with per-coordinate probes — no map iteration, no sort — and the proposed
  `BTreeSet` index could not serve the new contract anyway, which is DENSE over the used range by
  deliberate design (`:1948-1979`, and the reason is a correctness one: compacted output made SUMIF
  pair two columns from different rows). **But one arm was missed and still scans:** the `ColumnRef`
  branch of the SUBTOTAL/AGGREGATE collector does `for (&(r, c), cell) in &grid.cells`
  (`evaluator.rs:4478`) for a whole-column reference and charges fuel for `grid.cells.len()` up
  front (`:4467-4473`). Close PERF-18 as specified; keep that arm as its own small row.

**The eight that are unbuilt**, each with the file that decides it:

| finding | what | where it stands |
|---|---|---|
| PERF-02 | recalc drivers stop re-parsing the world | `calculation.rs:159` still `parser::parse(formula)` per cell; `:176-177` still clones both dimension maps per cell; both drivers render every AST back to a string first (`:1174`, `:1866`) |
| PERF-07 | rect nodes for range dependencies | finite rects still expand per cell — nested `for r … for c … refs.cells.insert()` at `lib.rs:1511-1523` |
| PERF-08 | `Arc` AST + in-place write-back + retire the grid mirror | `pub ast: Option<Box<Expression>>` (`cell.rs:296`), `Cell::clone` deep-copies the tree (`:307-316`); no `Grid::set_value`; the BUG-0016 mirror is intact and still whole-grid-cloned (`calculation.rs:1107`, `:2311`, `:2392`) |
| PERF-10 | number-format parse cache | `parse_custom_format` (`custom_format.rs:220`) has no memo; both entry points call it unconditionally (`:1911`, `:1923`) |
| PERF-13 | box the `Lambda` payload | all three fields inline at `evaluator.rs:576-580`. **The audit's "80 → 32 bytes, 2.5x less traffic" is NOT a verified figure** — it was inherited from the 2026-07-12 verifier, never re-measured, and no `size_of::<EvalResult>()` assertion exists anywhere in `core/engine/src`. Measure before scheduling |
| PERF-15 | conditional-formatting tick | the frontend debounce exists (`cfStore.ts:37`, `:146-166`) and a viewport is tracked; the BACKEND is unchanged — `collect_range_stats` runs for every enabled stats rule regardless of viewport (`conditional_formatting.rs:1037-1046`) and probes every coordinate of every rule range (`:1228-1248`) holding `state.grids.read()` |
| PERF-17 | DataValidation refresh | HALF solved, differently: the N+1 round-trips went via `@api/coalescedRefresh`, not the proposed debounce. The other half stands — `get_invalid_cells` (`data_validation.rs:827`) probes every coordinate of every range, and the per-range invariants are still recomputed per CELL (`:416-429`) |
| PERF-04(c) | full `RangeView<'g>` yielding `&CellValue` | no `RangeView` symbol anywhere in the repo. (a) and (b) shipped |

**Deferred residue inside findings that DID ship**, none of it tracked either:

- **PERF-03**: XMATCH is entirely uncached and linear in every mode (`evaluator.rs:14424-14512`);
  multi-column `ColumnRef` bypasses the cache (`:15501-15512`).
- **PERF-14**: SUMIFS, COUNTIFS, AVERAGEIF, AVERAGEIFS, MINIFS and MAXIFS still full-scan, building
  a `Vec<EvalResult>` per criteria range per call.
- **PERF-11**: compiled wildcard patterns not built — `xlookup_wildcard_match` allocates a
  `Vec<char>` for pattern AND text on every call (`:5948-5952`) and `matches_criteria` additionally
  allocates `to_uppercase()` per cell; `as_text_into(&mut String)` does not exist.
- **PERF-22**: the two benches the audit called *the gate* are still missing — there is no app-crate
  end-to-end recalc bench (no `app/src-tauri/benches`, no `[[bench]]` in its manifest) and no
  parse/extract throughput bench (no `core/parser/benches`).

**Three traps for whoever picks any of this up**, all measured:

1. **A comment in the engine says PERF-02 is already done.** `core/engine/src/cell.rs:7-8` states as
   a performance header: "The AST is the canonical formula storage - it is parsed once and never
   re-parsed on recalculation." That is true of the cascade path and FALSE of both full-recalc
   drivers. Fix the comment whether or not the work is scheduled.
2. **A bulk grid assignment inside a live lookup pass bypasses cache invalidation.**
   `calculation.rs:2392` does `grids[active_sheet] = grid.clone()` through no `Grid` mutator, so
   none of the four `notify_write`/`notify_write_rect` hooks fires. Harmless today; **PERF-10(a) is
   precisely the change that would make it serve wrong answers.**
3. **`fn_vlookup`/`fn_hlookup` over 1-D rects deliberately bypass the fast path** (it requires
   `rows>1 && cols>1`, because `table_row_views` treats a flat vector as ONE row). Do not "fix" that
   by including them — the audit records it as a trap and it still is one.

Also stale and worth correcting in passing: **four** comments in `evaluator.rs` (`:15459-15461`,
`:15472-15474`, the `cache_vector` doc at `:15544`, and `literal_vector_desc`'s own) still describe
whole-column refs as using "the populated-only compacted ordering", which `materialize_axis_rect`
replaced with a dense one.


### 2.8 The lock-order census was blind to 28% of its biggest file — CLOSED 2026-09-13

**A crate-wide, exemption-free guard that passed by not looking.** `state_digest_lock_order_tests.rs`
blanks `#[cfg(test)]` items before scanning, and its stripper counted `{` and `}` per line to find
each module's end. Real test code defeats that: format strings (`"{}"`), JSON fixtures and embedded
JS carry unbalanced braces INSIDE STRING LITERALS. Measured on `calp_commands.rs` — **195 lines in
one test module carry such a brace, the running count ended at +3 rather than 0, and the skip ran to
EOF.** The census scanned 11,044 of 19,308 lines; **5,363 lines of PRODUCTION code were silently
exempt**.

It hid exactly one real violation, and it was the worst possible one: `restore_pulled_pivots`
(`calp_commands.rs`) took `pivot_state.pivot_tables.write()` and then `state.grids.write()` — **the
precise shape this census plants as its own positive control** (`state_digest_lock_order_tests.rs`,
"a non-AppState state object counts too"). The recalculation pass takes `grid` then `grids` and runs
on a background thread, so that inversion closes a cycle: no panic, no crash, nothing in the log,
just a window that stops answering. It is the 2026-08-11 wedge one lock pair over, sitting in the
`.calp` reset path.

**Fixed both halves.** The stripper now ends a module at the first line that is EXACTLY `}` —
column-zero, which inside a top-level `mod` can only be that module's own close, and which no string
literal can forge. That is the shape `document_store_census_tests.rs::strip_test_modules` already
used in this crate, so the fix adopts a proven local idiom rather than inventing one. And
`restore_pulled_pivots` now takes `grids` before `pivot_tables`. The census went from "passes,
scanning 57%" to "fires on one violation, scanning 100%" to "passes, scanning 100%" — and 2,583
app-lib tests pass.

**This is the SECOND time this helper family has had exactly this defect.** Its own doc comment
records §3bu: a brace-less `#[cfg(test)] mod x;` declaration ran the skip to EOF, in one of the other
three near-copies. The self-test written then, `the_censuss_stripper_handles_both_module_shapes`,
pinned both MODULE SHAPES — and said nothing about module CONTENT, which is where the next instance
came from. `the_censuss_stripper_survives_braces_inside_string_literals` now pins that, with the four
literal shapes that actually defeated it; sabotage-verified (restoring the brace counter reds it with
"the census would report no violations because it never looked, not because there are none").

**Still open, deliberately narrow:** the three near-copies named in that doc comment
(`spill_map_tests`, `bulk_rewrite_recalc_tests`, `document_store_census_tests`) were checked.
`document_store_census_tests` uses the column-zero rule already and is safe. The other two do not
appear as separate files in the crate today, so there was nothing to fix — but any FIFTH copy should
start from the column-zero rule, and the standing argument in that doc comment ("the property that
matters is not one copy but each copy self-tested against that exact input") now has a second
worked example.

**And the harness lied while this was being fixed, which is worth more than the fix.**
`fix-test-manifest.ps1` rewrites the test .exe to embed its manifest, bumping the exe's mtime past
every source file; the next `cargo test --no-run` then reports `Finished in 0.60s`, rebuilds nothing,
and runs the PREVIOUS binary while looking like a fresh run. A restored source file kept producing
the sabotaged binary's results, and three reported failures — two of them naming real files —
**did not exist**. Any harness that builds, patches and runs must force the build (touch the crate
root) and confirm the log says `Compiling app`. The sibling failure mode, a later `cargo test`
throwing the manifest away, is loud (`0xC0000139`); this one is silent and hands back fictional
results.


### 2.x On-grid CONTROLS have no reachable right-click menu — **CLOSED 2026-09-04 as M3a**

**CLOSED.** Controls now owns a capture-phase `contextmenu` listener of its own
(`app/extensions/Controls/lib/controlObjectMenu.ts`) hit-testing through the SAME predicate Core's
overlay registration uses (`lib/controlHitTest.ts` — one rule, two callers, so the menu and the mouse
cannot disagree), painting `components/ControlContextMenu.tsx`. Two things the fix had to get right
that the description below does not anticipate: the menu OMITS what does not apply rather than
greying it (a button gets no Flip, no Edit Script), and it selects the clicked control by calling
`selectFloatingControl` directly rather than dispatching `floatingObject:selected` — whose handler
RUNS a button's script in run mode, so a right-click would have fired a macro. The `gridExtensions`
registration is reduced to the one item genuinely reachable there, "Paste", whose context is a cell.
The description that follows is the ORIGINAL finding, kept because its trace is what made the fix
obvious. Its first line number has rotted (the file is shorter now); the symbol is
`registerControlContextMenuItems`.

`app/extensions/Controls/lib/controlContextMenu.ts` registers the control's z-order / flip /
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

### ~~2.z Refresh never re-materializes a subscribed application's PIVOTS (2026-09-01)~~ — **CLOSED 2026-09-13**

**CLOSED 2026-09-13 — refresh ADOPTS the publisher's pivots.** `apply_refreshed_pivots`
(`app/src-tauri/src/calp_commands.rs`) is called from `calp_refresh_apply` for every payload, and
the ledger merge no longer carries `"pivot"` forward — the fresh entries are the full truth, like
tables and charts, so a surviving pivot is not duplicated and a deleted one is not resurrected.
Add, delete and re-layout all land. Five behaviour tests plus three wiring tests in
`calp_refresh_pivot_tests.rs`; 2,591 app-lib tests pass.

**Six things the implementation does that the obvious one does not**, each a defect the review
found before it shipped and each verified against the code:

1. **The sheet rename map is captured BEFORE the collision pass.** `resolve_sheet_name_collisions`
   rewrites `ps.name` IN PLACE and `PulledSheet` has one name field, so the publisher's spelling is
   gone the moment it runs. The pull path has always captured the originals first; refresh never
   had to until now. Reusing the post-collision names would have made the remap a no-op and sent a
   v2-ADDED sheet's pivot to the SUBSCRIBER's own same-named sheet — writing over it.
2. **The write goes through `update_pivot_in_grid`, not `restore_pulled_pivots`' path.** That path
   passes `None` for the active-grid dual-write, which is safe on a PULL (the destination is always
   a freshly appended sheet) and wrong on a REFRESH, where the destination can be the ACTIVE sheet:
   `run_calculation_pass` opens by overwriting `grids[active]` from `state.grid`, so output written
   only into `grids` is destroyed by the `calculateNow()` the dialog itself runs.
   `update_pivot_in_grid` dual-writes and repairs `state.merged_regions` too.
3. **It holds NO locks while it writes.** `update_pivot_in_grid` takes `grid` -> `grids` ->
   `style_registry` -> `merged_regions` itself, so holding any of them across the call deadlocks,
   and holding `pivot_tables` across it is the inverted shape §2.8's census plants as its own
   positive control. The function is therefore the project's standing two-phase shape: compute
   under short-lived guards, drop everything, then write.
4. **BI pivots route through the FULL data-source map.** `embedded_connection_ids` holds only
   sources ADDED in this version and is empty for every application that already had one, so every
   BI pivot would have landed on `ConnectionId::default()` and queried nothing. It reuses the
   `ds_to_conn` map the ribbon-filter/slicer re-bind already builds from the live connections.
5. **The source sheet resolves BY NAME.** `source_sheet_index` indexes the PUBLISHER's sheet list;
   the pull path can add `sheet_offset` because it appends contiguously and refresh cannot, because
   it updates in place. A miss degrades to an empty cache rather than reading whatever sheet sits
   at that ordinal, and the destination keeps `restore_pulled_pivots`' case-insensitive
   resolve-or-SKIP (an `.unwrap_or(0)` there once wrote a pivot over the subscriber's first sheet).
6. **A withdrawn pivot's CELLS are cleared before it is forgotten**, or the subscriber keeps a
   rectangle of the deleted report's last numbers with nothing behind it. Withdrawal is scoped to
   `previously_provided` — this subscription's own pivot ledger — so the subscriber's own pivots
   and other applications' survive a v2 that ships none. That scoping has its own test, because
   getting it wrong destroys the user's work rather than merely failing to update it.

**The recalculation is inherited, and the claim is checked rather than assumed.**
`apply_refreshed_pivots` writes cells and does not recalculate, which the crate's
`every_cell_writing_function_either_recalculates_or_is_exempt_with_a_reason` census caught
immediately. It is EXEMPT with a stated reason: `calp_refresh_apply` runs `recalculate_sheet_values`
over every refreshed sheet index before returning, and an adopted pivot writes to its application's
own destination sheet while a withdrawn one's cleared region sits on the sheet it was written to —
both, by construction, in that set. A pivot naming a destination this workbook lacks is SKIPPED
before any write, so it cannot escape it.

**Declared, not silent.** The refresh dialog now says pivots are updated to the publisher's version
"including ones you have re-arranged", and that the subscriber's own are untouched. That sentence is
the half of this row that was never about code: refresh preserved silently and
`calp_reset_subscription` discarded silently, and the two surfaces disagreeing without saying so is
what the row objected to.

**Left open deliberately:** the preview does not yet enumerate WHICH pivots change. The owner chose
plain adopt over the flag-each-one variant, so the standing sentence is the disclosure; a per-pivot
delta would need `compute_preview` to diff two manifests, and that manifest is NOT
signature-verified (`core/calp/src/workspace.rs` reads and deserializes it), so any delta shown
there is a hint for the dialog rather than an authority. The authority is the signed manifest on the
apply path.

**Also corrected while here:** the same `o.kind` filter carried `dataSource` and `extensionData`,
and the comment above it said refresh "does not touch" them. Data sources ARE re-materialized —
only their LEDGER entry was carried — so the comment was wrong about its own code.


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

**OWNER DECISION 2026-09-12: ADOPT.** A refresh takes the publisher's v2 pivot definitions,
matching `calp_reset_subscription` and the pull path. Add and delete land under this too — they
always had to, since a pivot ADDED in v2 has no local counterpart to keep and one DELETED has no
publisher version to adopt; only "changed" was ever the choice.

**What decided it.** Not "the subscriber's layout is worth less" — it is real, it persists, and it
is genuinely theirs: no pivot mutation command carries a subscription or protection gate (the only
`check_sheet_action` in `pivot/commands.rs` is on `create_pivot_table:354`; `move_pivot_field`,
`set_pivot_aggregation`, `update_pivot_layout`, `sort_pivot_field`, `set_pivot_item_visibility` and
`delete_pivot_table` have none), and `pivot_tables` is `Persisted` and round-trips through save.
What decided it is that **KEEPING is not neutral, it is a correctness risk.** `PivotField.source_index`
is a source COLUMN ORDINAL and `source_start`/`source_end` are stored coordinates
(`definition.rs:52-54`, `:634-638`). A v2 that inserts a source column or widens the table leaves
the v1 definition aimed at the old ordinal and the old rectangle, and `build_cache_from_grid`
(`pivot/commands.rs:2052`) re-renders it confidently against the new data. "You keep your layout"
quietly becomes "you keep a wrong number". Two supporting facts: a pivot re-layout is invisible to
every subscriber-facing surface (`record_subscription_override_edits` is reached only from
cell-edit paths, so it is never in the Overrides pane, never counted as a conflict, never revertible
cell-by-cell), and reset ALREADY discards it wholesale under a confirm that lists "Every cell,
format, size and merge" and never mentions pivot layouts. Refresh preserved it silently, reset
discarded it silently, and neither surface said which — that asymmetry had to close whichever way
the decision went.

**The first fix design was REFUTED, and is recorded here so nobody builds it.** Adversarial review
on 2026-09-12 found five independent defects in it, each traced. Anyone implementing this must
start from these, not from the obvious reading:

1. **The sheet-name remap is backwards, destructively.** Keying `pkg_name_to_local` on
   `pulled.name` is wrong because `resolve_sheet_name_collisions` MUTATES the name in place
   (`core/calp/src/pull.rs:241`) and `PulledSheet` has only one name field. A v2-ADDED sheet that
   collided would write the publisher's pivot output over the subscriber's own same-named sheet.
   The pull path captures `original_names` BEFORE the collision pass (`calp_commands.rs:3824-3838`);
   refresh captures none (`:7117-7134`). Capture them and union with the already-tracked mapping.
2. **The output would be written and then destroyed.** `restore_pulled_pivots` passes `None` for
   the active-grid dual-write (`:16538-16544`), which is safe on a PULL (destination is always an
   appended sheet) and not on a REFRESH, where the destination can be the ACTIVE sheet — whose read
   path is `state.grid`, and `run_calculation_pass` overwrites `grids[active]` from the mirror
   (`calculation.rs:1105-1107`) on the `calculateNow()` the dialog runs. Use `update_pivot_in_grid`
   (`pivot/operations.rs:950-1029`), which dual-writes AND repairs `state.merged_regions`.
3. **It would red an enforced lock-order test.** See §2.8 — copying `restore_pulled_pivots`' order
   (`pivot_tables` then `grids`) into `calp_refresh_apply` plants exactly the shape the census
   asserts against. Take `grid` -> `grids` -> `style_registry` first and `pivot_tables` after, per
   `pivot/operations.rs:961-965`.
4. **Every BI pivot would lose its connection.** The `data_source_id` -> `ConnectionId` routing
   resolves through `embedded_connection_ids`, and `refresh_embedded_data_sources` returns only
   NEWLY created ones (`:16079`, `:16183`) — empty for every data source that already existed.
5. **The preview manifest is NOT signature-verified.** `compute_preview` calls
   `registry.get_version_manifest` (`core/calp/src/refresh.rs:404`), which for the local transport
   is read-file-and-deserialize with no signature check (`core/calp/src/workspace.rs:319-334`). A
   delta computed there is a hint for the dialog, not an authority; the authority is the signed
   manifest on the apply path.

Also: the same `o.kind` filter carries `dataSource` and `extensionData`, so those two were frozen
at v1 by the same line — data sources ARE re-materialized (`:7999-8012`), so only their LEDGER
entry is stale, and the comment at `:8201-8218` claiming refresh "does not touch" them is wrong and
should be corrected while this is open.


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

### 2.ac Environments (Dev → Test → Prod), release one — what shipped 2026-09-05 left open

Environments shipped as named pointers on one development line:
`docs/design/calp-workspace-collaboration.md` §2.5 is the as-built record.

**An adversarial review on 2026-09-06 raised 116 findings, confirmed 96 through
three independent refuters each, and every confirmed finding is fixed** — see the
"Adversarial review and its fixes" block in §10 of that document. One row below
is CLOSED by it; the rest are limits the design states out loud rather than
defects, and a follow-on the owner deferred.

| item | verified at |
|---|---|
| **CLOSED 2026-09-06 — the anchor was the WORKSPACE, which a share-writer authors.** The row below claimed fabrication was already impossible. It was not: `publishers::root_key_of` derives an application's root from the lowest entry of the UNSIGNED manifest listing and that version's manifest read with no signature check, so anyone with write access could plant a `0.0.1` naming their own key, sign their own `publishers.json` and `promotions.json` under it, and retarget `prod` at will — TOFU never caught it, because TOFU checks the version finally pulled, not the pointer that chose it. Resolution now takes an explicit `environments::PromotionTrust`, and every path deciding what a subscriber receives passes `Pinned { scope, profile_dir }`, building the authorised set from this machine's pin plus the delegates that pinned root vouches for. The first subscribe still falls back to the workspace, which is TOFU's own first-use window one level up. | `core/calp/src/environments.rs` (`PromotionTrust`, `authorized_keys_via`), `core/calp/src/signing.rs` (`pinned_publisher_key`), `pull.rs:423`, `refresh.rs` |
| **A replayed promotion log is still undetectable to a client.** A share-writer cannot fabricate a promotion — the fold now verifies against the PINNED root and fails closed — but they can restore an older signed log, rolling `prod` back to a version that was legitimately promoted at some point. This is the same limit `publishers.json` already documents for delegate removal, and the same fix applies: a monotonic revision plus a CLIENT-SIDE high-water mark makes it detectable rather than silent. Not built, because the mark has to live somewhere a share-writer cannot reach, and where that is depends on whether the subscriber's TOFU store is the right home. | `core/calp/src/environments.rs` (`load_verified_log`), §2.5 "Threat model" |
| **Per-environment promotion permissions do not exist.** Any authorised publisher may promote to any environment — the owner's call, and the right default for a small team, since every promotion is signed and attributed either way. "Only Alice may promote to prod" needs a second, separately-signed list and a UI for it, and would want to answer what happens when the only person on that list leaves. | `core/calp/src/environments.rs` (`require_authorized`), §7 |
| **A "draft" push, off the line, does not exist.** Every push lands at the head, so a developer who wants to share work-in-progress with one colleague has no way that does not move the line. Deferred deliberately: promotion has to be a pointer move, which needs linear history, and an off-line branch needs a headless version-to-version merge — the state-agnostic evaluator that §2.aa closed as too large. | §2.5 "One shared development line" |

### 2.ab TypeScript Forms, release one — what shipped 2026-09-02 left open (filed 2026-09-03)

Modal forms shipped as a new `form` object type: `docs/design/typescript-forms.md` is the as-built
record and every row below is also its §13/§14. The plan's later milestones are listed here with
the defects that must close FIRST, plus two things the plan promised for release one that were not
delivered, and one doc-drift row found on the way. Every row was verified against the code on
2026-09-03.

| item | verified at |
|---|---|
| **BUG-0113 — the `ui.html` bridge is inert under the built CSP. BUILT 2026-09-12; NOT YET MEASURED against a bundled build, so the ledger entry stays open until it is.** Diagnosis re-verified, and one load-bearing sentence in the ledger entry CORRECTED: it is not that a `srcdoc` child "has no origin". TWO rules compose. (1) `determine navigation params policy container` returns a CLONE OF THE INITIATOR's when the response URL is `about:srcdoc`, so the app's `script-src 'self' blob:` lands inside the frame verbatim. (2) `initialize a Document's CSP list` sets each policy's self-origin to the new document's origin, and `sandbox="allow-scripts"` without `allow-same-origin` makes that origin OPAQUE — so the inherited `'self'` matches nothing. That second half kills the two obvious fixes: an external `<script src>` served from `'self'` is refused for the same reason the inline one is. **THE FIX.** `script_frame.rs` serves a CONSTANT loader over a `calcula-frame` URI scheme with its own `Content-Security-Policy` RESPONSE HEADER, so that document gets its OWN policy container; `frame-src` gained the origin in BOTH `csp` and `devCsp` (the parent's policy is consulted first, so a missing entry refuses the frame before its own policy is read); both hosts set `src={scriptFrameLoaderUrl(id)}` and PUSH the script's HTML once the loader announces itself. The isolation is unchanged — the opaque origin comes from the sandbox, not the scheme — and the app's own `script-src` is untouched and pinned as such. **FIVE DEFECTS THE DESIGN AND THE ADVERSARIAL REVIEW CAUGHT BEFORE THEY SHIPPED, every one of which would have been worse than the bug being fixed:** (a) installing pushed content with `document.open()/write()` erases every listener on the Window, so the loader would lose its own `message` handler on the FIRST push — the shipped interactive templates re-render on interaction, so a counter would paint "0", take the click, and never move: BUG-0113's own symptom reproduced by its fix. Content arrives as a BODY SWAP. (b) `setShapeHtmlContent` called `forgetOverlayDocument`, which released the frame's READINESS. Under srcdoc that was right (a content change reloaded the document); under the loader a content change reloads nothing, so every push after the first was held forever and the shape froze at its first render — on the main interactive path, for every template. The two lifetimes are now separate functions, `invalidateOverlayContent` (content changed) and `forgetOverlayDocument` (document gone). (c) The pane card tied readiness to the COMPONENT, not the ELEMENT: React replaces that iframe while the card stays mounted (a budget refusal lifting, File > Open re-declaring the runtime, a card re-order), and stale readiness meant the push landed in the new frame's loading gap, was reported delivered, and the card stayed blank. Release now happens in the ref callback — the on-grid host's rule, expressed where this host learns the element changed — and `markScriptFrameReady` re-sends the last content when nothing is pending, as belt to that braces. (d) An id re-key left the element loading under the DEAD id, so its loader announced an id the router resolves to nothing; and a re-key onto an OCCUPIED id kept the displaced shape's content hash, so two tiles built from one template left the arriving frame unfed. (e) `frame-ancestors http://tauri.localhost` would have blanked every frame in `tauri dev` and the whole functional E2E suite — the one configuration where this defect is invisible and the fix gets developed. **ONE SECURITY HOLE, found by review and closed:** the loader checked `target` and `instanceId` but not `e.source`, so a sandboxed sibling — indexed child WindowProxies stay cross-origin-accessible, and instance ids are anchor-derived and guessable — could post `calcula.setContent` at ANOTHER script's frame and have its markup installed by the body swap: HTML that passed neither that script's `ui.html` grant nor `vHtml`, painted inside a control the user trusts, and able to call the victim frame's own `sendMessage`, which posts under the VICTIM's id from the VICTIM's window so the host's source check passes. The loader now mirrors the host's check (`if (e.source !== parent) return;`). This also closes the same gap in the old srcdoc bridge, which never had a source check either — that half could only spoof a message; only `setContent` could replace a DOM. **A guard that went blind and was restored:** `htmlInputConsentHonesty.test.ts` discovers html hosts by searching for `srcDoc=`/`srcdoc =`, so moving both hosts to `src=` left it finding ONE — the bridge-less Properties preview — and silently no longer checking the two that take user input. It knows the loader route now, sabotage-verified. **Tests:** `scriptFrameLoader.test.ts` (33) pins the wire contract ACROSS the language boundary plus the ready-gated delivery; `scriptFrame.test.ts` boots the RUST LOADER's bridge — not the retired builder's — against the real router, including a foreign-window refusal; 3 Rust unit tests; 3 on-grid regressions. The cross-language pin exists because the drift it catches happened during the fix: the loader was first authored with an invented tag and the Rust test asserted that same invented spelling, self-consistently and wrongly. **STILL TO DO:** measure against a real bundled build (`tauri dev` enforces no CSP, so no dev or functional-E2E run can answer this), and re-point `csp-srcdoc-bridge.spec.ts`'s srcdoc half at the loader. `buildScriptFrameDocument` is kept until that measurement exists — the only harness that can show the before/after — and is marked in-source as having no production caller. **One risk that cannot be settled by reading:** wry 0.53.5 registers the resource filter with `AddWebResourceRequestedFilterWithRequestSourceKinds(..., SOURCE_KINDS_ALL)` only when it can cast to `ICoreWebView2_22`, falling back to an API whose own comment says it does NOT cover iframes (`wry/src/webview2/mod.rs:929-942`). Evergreen runtimes since ~121 are fine; an older fixed-version deployment gets a blank frame. Needs a measured floor. | `app/src-tauri/src/script_frame.rs`, `app/src-tauri/src/lib.rs`, `app/src-tauri/tauri.conf.json`, `app/extensions/_shared/scriptFrame/`, `app/extensions/Controls/Shape/shapeRenderer.ts`, `app/extensions/ControlsPane/components/CustomControlHost.tsx` |
| **CLOSED 2026-09-03: the editor preview now seeds range-fed content and control bindings too.** The rung resolves `options: { range }` and a table's `rows: { range }` against the SAME grid copy the run used and returns them on `WorkerPreviewReport.formSources` — they cannot be resolved by the caller, because the copy never leaves the rung and a caller re-reading those ranges would be seeding widgets from the LIVE workbook. A `{ control }` value is live app state, so it is read in the trusted caller and seeded read-only. An image still resolves to nothing in a preview and says so rather than inventing a URL. The procedure is shared: `previewFormLayout`. | `app/src/api/scriptFormPreview.ts`, `app/src/api/scriptHost/scriptPreview/formSources.ts`, `scriptPreview/report.ts` (`WorkerPreviewReport.formSources`) |
| **CLOSED 2026-09-03: the form journeys RUN and pass against the live app.** 26 journey tests green: `script-form.spec.ts` 9/9 (Insert > Form mints a UUID instanceId; the band names script and sheet; a required field blocks Submit; Enter writes TYPED values in ONE undo step with a second-edit positive control; Escape writes nothing; an `onSubmit` verdict keeps the form open; a cell changed by another script updates the widget; a second script's `caps.dialog.alert` is refused while the form is up; and a button script's `caps.forms.show` survives 33 s past the 30 s relay deadline and receives the answers), `script-form-distributed.spec.ts` 2/2 (decline then approve a published `.calp`), and `script-preview.spec.ts` 15/15 including the editor's Preview form. ONE spec defect was found by running them: the consent prompt was asserted with `capabilities.ts`'s sentence while that surface renders the ScriptableObjects one — three phrase tables exist per surface, all pinned by `formConsentHonesty.test.ts`. | `app/e2e/journeys/script-form.spec.ts`, `app/e2e/journeys/script-form-distributed.spec.ts`, `app/e2e/journeys/script-preview.spec.ts` |
| **CLOSED 2026-09-03: the `writeOn: "change"` stale-marker echo was real, and is fixed.** The post-write refresh now passes `{ echo: false }`, so the form is not told its own write was an outside edit, and `refreshScriptFormSeeds` applies the RENDERER's untouched rule before it adopts a value — a widget the user is editing keeps what is on screen and `form.values` agrees with it. Pinned by two cases in `scriptForms.test.ts`. | `scriptForms.ts` (refreshScriptFormSeeds), `host.ts` (writeFormBindings), `src/api/scriptHost/__tests__/scriptForms.test.ts` |
| **CLOSED 2026-09-03: the package inspector can PAINT a distributed form before anyone trusts it.** A `form` script in a `.calp` now carries a Preview layout action beside its source: it runs the packaged source through the preview rung (strict snapshot, EMPTY ceiling, nothing mounted) and opens the trusted renderer in preview mode, with the identity band naming the PACKAGE rather than this workbook. It passes `readControls: false` — somebody else's package must not read this workbook's live control values while it is being inspected. | `app/extensions/Distribution/components/inspector/ScriptsSection.tsx` (`FormPreviewAction`), `app/src/api/scriptFormPreview.ts` |
| **M2 — modeless floating window and task pane needs a NEW capability id.** `ui.dialog`'s four user-facing sentences promise "a dialog you must answer or close before continuing"; a modeless surface makes that false, so it is `ui.pane` (or similar) with the full lockstep: `ALL_CAPABILITY_IDS`, `CAP_DESCRIPTION`, both phrase tables, the audit classification map, the `scriptSurfaces.ts` rows, and Rust `KNOWN_CAPABILITY_IDS` (currently `[&str; 16]`). Three prerequisites the code shows: sessions must become script-visible instances (the shim already keys waiters by `showId`); event backpressure — **CLOSED 2026-09-04 as M2 S1, see the row below** (it had been `EVENT_QUEUE_HIGH_WATER` declared and read nowhere); and no panel host exists — `ExtensionPanelHost` from the add-in design was never built, and the plan (`C:\Users\Salle\.claude\plans\m2-modeless-pane.md`) makes it unnecessary by rendering through `registerPanel` inside ScriptableObjects. **CLOSED 2026-09-04 as M2 S2+S3 — the id, the rows, the wire and the headless registry.** S2 put `ui.pane` LAST in `ALL_CAPABILITY_IDS` and in Rust `KNOWN_CAPABILITY_IDS` (annotation bumped to 17), in all nine `Record<CapabilityId>` maps, asserted NON-grantable in `capability_store.rs`, pinned by `paneConsentHonesty.test.ts`. It could not ship alone: `scriptSurfaces.test.ts` ("consent theatre") refuses a capability no gate reads, so S3 landed in the same change. **Five ALLOWLIST rows** — `pane.dock` / `pane.update` / `pane.setBadge` / `pane.reveal` / `pane.close`, all `ui.pane`; dock and reveal are class "ui" with `UI_DIALOG_DEADLINE_MS` in `METHOD_DEADLINES_MS` because their FIRST call awaits the consent prompt and the 30 s default would abandon it mid-read (the judges' correction to the plan) — five `BROKER_AUDITED_CAPABILITY_METHODS` entries, and `ui.pane` on the four author-declared surface rows in `scriptSurfaces.ts` (NOT the sandboxed-extension row, whose door `EXTENSION_BROKER_METHODS` has no `pane.*` method; the derived test decides). **One validator body, two surfaces:** `checkFormSpec` / `checkFormPatch` extracted out of `vFormDefine` / `vFormUpdate` (behaviour unchanged, the form spec tests untouched) and called by `vPaneDock` / `vPaneUpdate`; `scriptPaneSpec.test.ts` runs 19 spec cases and 10 patch cases through BOTH doors and asserts identical verdicts. **The registry** `scriptPanes.ts`: `dockScriptPane` / `updateScriptPane` / `revealScriptPane` / `setScriptPaneBadge` / `closeScriptPane` / `refreshScriptPaneSeeds` / `listScriptPanes` / `revokeScriptPanes` (in `hostUnmountScript`) / `resetScriptPanes` (in `hostResetAll`), with NONE of the modal's slot / dismissal-mute / deadline-hold / idle-clock machinery (the test docks a pane, then TAKES the modal slot for a dialog, then advances 24 h with nothing closing); a per-script cap of 3 (`MAX_PANES_PER_SCRIPT`, pending docks counted), a 10/min dock bucket, the per-pane 30/s update bucket, host-minted ids with OWNERSHIP on every later call (a foreign id and an unknown id get the same sentence, so nothing leaks), and an HONEST `reveal` that answers `{ revealed: false, reason }` for a ribbon placement — where `openPanel` is a no-op — learned from the renderer's own `docked` / `placement` inputs, never guessed. `definitions` in `scriptForms.ts` is now per script per LAYOUT KIND (`defineScriptLayout` / `getScriptLayoutSpec` / `forgetScriptLayout`), so a form and a pane coexist and each registry forgets only its own; `getActiveScriptForm` now DOCUMENTS that it means the MODAL session only — panes are a LIST, `listScriptPanes()`. **The shim:** `form.pane` in `contextShims.ts` (define / dock / update / reveal / setBadge / close / control() / paneId / values / isOpen / onChange / onClick / onClose on separate `onPane*` hook names so a form's handlers never hear the pane's, plus the `__pane_closed` relay); typings regenerated (`ScriptPaneApi`, `PaneControlHandle` — a facet, named like `ScriptFormsApi`, because the narrowing's tripwire treats every `*Context` interface as an object type). **The wire:** `SCRIPT_PANE_REQUEST/PATCH/INPUT/CLOSE_EVENT` in `scriptPaneSpec.ts`. The renderer (S4) and the bindings with the visibility-gated watch (S5) are CLOSED in the two rows below — `pane.dock` DOES resolve bound cells and its desc promises the writes. Still open: hardening (S6), inventory (S7). | `capabilityIds.ts:216`, `capabilities.ts:411`, `SubscribeDialog.tsx:63`, `inspector/ScriptsSection.tsx:46`, `broker.ts:295`, `core/persistence/src/lib.rs:1705`, `app/src/api/scriptHost/scriptPanes.ts`, `app/src/api/scriptHost/scriptPaneSpec.ts`, `app/src/api/scriptHost/validators.ts` (`checkFormSpec`, `checkFormPatch`, `vPaneDock`), `app/src/api/scriptHost/allowlist.ts` (the `pane.*` rows), `app/src/api/scriptHost/scriptForms.ts` (`defineScriptLayout`), `app/src/api/scriptHost/worker/contextShims.ts` (`paneFacet`), `app/src/api/scriptHost/host.ts` (`paneSessionDeps`), `app/src/api/scriptHost/__tests__/scriptPanes.test.ts`, `app/src/api/scriptHost/__tests__/scriptPaneSpec.test.ts`, `docs/design/third-party-addin-authoring.md:361` |
| **M3 — on-grid embedding is blocked by three standing defects.** The `ui.html` shape frame is unconditionally `pointer-events: none`; on-grid controls have no reachable right-click menu (§2.x above); and anchor-derived control ids lose their script on copy — the reason a form's identity is a minted UUID. Embedding a form on the grid means declared hit rectangles, the cell-behaviors identity model (UUID + separately shifted geometry + orphan flag), and a menu that can actually be opened. | `extensions/Controls/Shape/shapeRenderer.ts:228`, §2.x, `extensions/ScriptableObjects/lib/createForm.ts:5-10` |
| **M4 — a third-party `form` contribution kind has no cell door.** `EXTENSION_CONTRIBUTION_KINDS` would gain `form` with a required capability and a `CONTRIBUTION_REACH_NOTE`, but the extension realm's `grid` namespace offers ONLY `cellStyles.register` and answers `unsupported(...)` for everything else — there is no cell read or write for a bound widget. Bound reads need `grid.read` (the host-push capability) and bound writes need a new gated door, or extension forms are read-only; `EXTENSION_BROKER_METHODS` / `extensionReachableCapabilities` must then be updated honestly or the consent enumeration understates reach. | `src/api/scriptHost/extensionProtocol.ts:50`, `src/api/scriptHost/worker/extensionWorkerContext.ts:609-660`, `src/shell/registries/extensionTrust.ts:58,81` |
| **M5 — the drag-and-drop designer must rewrite ONE code region and nothing else.** The scaffold emits the layout inside `#region Form layout (designer-owned …)` … `#endregion`; a designer needs a TypeScript-AST reader/writer for that block only (the transpiler already loads `typescript`), round-trip tests proving every byte outside the block — the `// @capability` pragmas above all — is unchanged, `LiveModulePersister` integration so the editor buffer and the designer agree, and `_shared/components/useDragDrop.ts` for the gesture. ONE ARTIFACT holds: the designer emits code, never a second stored layout. | `src/api/scriptableObjectScaffolds.ts:662-679`, `src/api/scriptTranspile.ts:15-25,121-126`, `extensions/ScriptableObjects/lib/liveModuleBuffer.ts:152`, `extensions/_shared/components/useDragDrop.ts` |
| **M6 — isolated HTML/CSS apps: the srcdoc bridge is unproven and duplicated.** `{ type: "html" }` is reserved and refused by name today. Before it is legal: prove the srcdoc bridge's inline script executes under the Tauri CSP (or serve app documents from a Rust custom URI scheme with their own origin and CSP); extract the bridge that is duplicated between the shape renderer and the pane control host into one module with a per-frame `MessageChannel`; e2e coverage of a user gesture reaching the bridge; theme-token injection and size negotiation; a DISTINCT consent id ("inside its shape" does not say "and take keystrokes"); a production memory watchdog and an iframe cap; and asset residence beyond `source` under the "reference media, never introduce bytes" rule (BUG-0086). | `scriptFormSpec.ts:83-84`, `validators.ts:4202`, `extensions/Controls/Shape/shapeRenderer.ts:165-230`, `extensions/ControlsPane/components/CustomControlHost.tsx:17-24,413-417` |
| **CLOSED 2026-09-03: a refused show no longer reads the sheet first.** `showScriptForm` takes a `resolve` thunk instead of finished seeds and awaits it only after the layout check, the 20-per-minute show bucket, the dismissal mute and the app-wide modal slot have all passed — so a muted script looping on `show()` performs no reads and writes no audit rows. A thunk that throws gives the slot back and leaves no session behind. | `app/src/api/scriptHost/scriptForms.ts` (`showScriptForm`), `host.ts` (`case "form.show"`, `case "cap.formsShow"`) |
| **CLOSED 2026-09-04: the `CLAUDE.md` format-version paragraph now says 8 and why.** Version 8 is `PINNED_FILTER_MIN_FORMAT_VERSION` — pinned filter levels (`filterLevel > 1`) on a slicer/ribbon filter and the `engine_filters` a pin writes into a BI pivot definition — stamped only when something is actually pinned (`zip_io.rs:243`). It links the version rather than a feature id because it is a *lie* case: an older reader drops both fields and the pivot comes back UNFILTERED with no error. The paragraph now lists it beside 4–7 and says so. | `CLAUDE.md` ("`.cala` Format Versioning"), `core/calcula-format/src/manifest.rs:156`, `core/calcula-format/src/zip_io.rs:229-243` |

---

### 2.ad Consent for distributed code at the MOUNT boundary (filed 2026-09-03)

The forms work added an unforgeable `MountAdmission` so no new mount route can skip the
distributed-consent gate. Auditing what that gate actually ASKED turned up a class of defect wider
than forms: the question was keyed on the realm's source bytes, and almost every route composes its
source. Seven mount routes were enumerated (one of them invisible to `rg`, because
`writebackValidators.ts` carries deliberate NUL bytes in template literals and ripgrep skips it as
binary — a text-search census of this area reports five and is wrong).

| item | verified at |
|---|---|
| **CLOSED 2026-09-03: the mount gate asks about the APPLICATION, not the bytes.** `check_distributed_module_consent` resolves ownership by exact source equality against stored module records and returns "allow" when nothing matches — correct for the module-runtime route it was written for, and vacuous for a composed realm. Six of the seven mount routes compose their source (chart marks, chart transforms, the UDF library realm, a shared library realm, standing object scripts, writeback validators), so the gate was CALLED and answered ALLOW every time. The new `check_distributed_mount_consent` runs the old module question verbatim AND asks whether this workbook has approved that application's code, over the same consent file. The object-script route additionally names its artifact (id + pre-prelude source hash), so it is held to its own record entry, not merely to "some code from this application was approved". | `app/src-tauri/src/scripting/commands.rs` (`check_distributed_mount_consent`, `distributed_mount_refusal`), `app/src-tauri/src/calp_commands.rs` (`consent_record_exists_in`), `app/src/api/scriptHost/host.ts` (`requireDistributedMountConsent`, `admitMount`), `app/src/api/scriptHost/__tests__/distributedMountApplicationConsent.test.ts` |
| **CLOSED 2026-09-03: consent is now recorded BEFORE the mount it authorizes.** Making the gate real broke the consented path in two places, because both grant handlers mounted first and persisted afterwards — so they asked the backend about an approval they had not written yet. Approving an application's object scripts mounted NOTHING and still toasted "enabled" (the per-script refusals were swallowed as console errors, and the scripts only came alive on the next open). For a chart-mark or chart-transform library it was worse: the refusal propagated, so `recordConsent` was never reached at all and the same prompt returned forever. Both now persist first; the object-script toast counts failed mounts instead of announcing a success it did not deliver, and a failed chart-library mount raises a toast rather than a console line. | `app/extensions/ScriptableObjects/index.ts` (`consent-granted` handler), `app/extensions/Charts/lib/distributedLibraryGate.ts` (`grantLibraryConsent`), `app/extensions/Charts/index.ts` (`charts:library-consent-granted`), `extensions/ScriptableObjects/__tests__/packageMacroConsent.test.ts`, `extensions/Charts/lib/__tests__/distributedLibraryGate.test.ts` |
| **CLOSED 2026-09-03: a published application's MACROS can now be approved at all.** A `.calp` may ship module scripts; pull stamps them with `source_package` and the subscribe review lists them as "Module scripts (N) — executable code", so the user is shown them and accepts. But the grant recorder wrote only the package's OBJECT scripts into the consent record, and the Rust module gate looks for the macro in that very record by id + source hash. It was never there, and the other three consent writers all key on a namespaced key (`custom-functions:`, `lib:`, `chart-marks:`) that this lookup cannot see — so every distributed macro was refused forever, by a message naming an approval no surface in the app could give. One grant now covers both kinds. The capability union stays computed over the object scripts alone, deliberately: a macro takes its ceiling from its own source at run time, and folding its pragmas into the record would both widen the object-script realms and make the union's equality check unsatisfiable, re-prompting the application on every open. | `app/extensions/ScriptableObjects/lib/packageConsentSet.ts`, `app/src/api/distributedConsent.ts` (`areScriptsConsented`), `app/extensions/ScriptableObjects/components/ScriptConsentDialog.tsx`, `core/calp/src/pull.rs:803` |
| **CLOSED 2026-09-03: the detached editor no longer reports a run that never started — and it took three passes, which is the interesting part.** On the remote transport `startDebugSession` is one-way, so a refused mount left no session; the trigger guard deliberately does not refuse on an empty mirror ("not caught up" is not evidence), and Run fired into nothing and returned `{status:"ran"}`. Pass 1 recorded the refusal per script — defeated by two starts in flight. Pass 2 added an attempt token — defeated by the host, which publishes `{status:"starting"}` and emits it BEFORE awaiting `mountWorker`, so the progress state retired the attempt and the real refusal was dropped; and by the bridge catch, which answers EVERY relayed command with `{session, error}`, so a `fire` rejecting after its session ended was byte-identical to a refused mount and turned a successful Run into "never mounted". Pass 3 fixed it at the source: the broadcast now names the command it answers (the field the catch had in hand and dropped), only `start` answers pair with start attempts, and an unstamped progress state is progress. A stamped `start` rejection is an ANSWER whatever session it carries — judging it by the settled test dropped it and desynced the queue permanently. Each pass was caught by review, not by the suite: the 47 pre-existing tests stayed green through a full revert of pass 2. | `app/extensions/ScriptableObjects/lib/debugger.ts` (`observeDebugBroadcast`, `installObjectScriptDebugBridge`), `app/src/api/scriptHost/host.ts:2615` |
| **CLOSED 2026-09-03: a macro-only application can be approved at all.** Everything the macro-consent work added still sat inside `if (distributedScripts.length > 0)`, and the per-package loop was built from distributed OBJECT scripts, so a `.calp` shipping macros and nothing else emitted no prompt — the dead end above, still open for that shape. The pass is now driven by the UNION of both stores. | `app/extensions/ScriptableObjects/index.ts` (the load pass), `app/extensions/ScriptableObjects/__tests__/packageConsentLoadPath.test.ts` |
| **CLOSED 2026-09-03: what is granted is what was displayed.** The prompt listed the workbook once; the `consent-granted` handler received only `{packageName}` and re-derived both sets from a second listing, so anything landing between the screen appearing and Allow (a Distribution ▸ Update, a gateway pull) made the grant record a set the screen never showed. The prompt now stamps a `promptId` and holds the exact artifact set it enumerated; a grant that cannot be tied to a standing screen, or whose live artifacts no longer fingerprint-match, is refused and re-asked. Two follow-on defects from that gate are fixed too: a module-listing FAILURE is not a change and must not re-prompt into itself (that loop had no press that could satisfy it), and both the grant check and the re-ask read `loadAllObjectScripts()` rather than the session-cumulative `ObjectScriptManager`, which still holds scripts an update removed and was offering to approve and re-mount them. | `app/extensions/ScriptableObjects/index.ts` (`emitPackageConsentPrompt`, `repromptPackage`, the `consent-granted` handler) |
| **CLOSED 2026-09-03: three more ways the prompt lied or looped.** An object-script/macro id collision made a package permanently unapprovable — the recorder DROPPED the colliding macro while the freshness check still demanded its hash, so Allow could never satisfy the screen; one `packageConsentPlan` now decides both, and the uncoverable artifact is named on the prompt instead. Allow after a revoking update re-recorded but never re-mounted, because the mount loop skipped anything already mounted — so the user approved new code and the old realm kept running; it now unmounts and remounts. And a macro-only screen ended with the OBJECT-SCRIPT realm's "restricted mode / the sheet currently shown" sentence; the reach paragraph is now a function of what the grant covers, with the macro clause derived from the `one-off-script` profile in `manifest.rs`. | `app/extensions/ScriptableObjects/lib/packageConsentSet.ts` (`packageConsentPlan`), `app/extensions/ScriptableObjects/components/ScriptConsentDialog.tsx`, `app/extensions/ScriptableObjects/__tests__/macroSurfaceReachHonesty.test.tsx` |
| **CLOSED 2026-09-03: the distributed-notebook refusal no longer names an approval nothing can give.** `notebook_consent_script_id` has no writer anywhere, so "you have not approved that application's code" pointed at a screen that does not exist. Words only — a notebook from an application is delivered to be read, not run, and the message now says that and points at "copy the cells into a notebook of your own". No consent path was added; the read-only design is deliberate and test-pinned. | `app/src-tauri/src/scripting/notebook_commands.rs`, `app/extensions/ScriptNotebook/__tests__/distributedNotebookRefusalHonesty.test.ts` |
| **CLOSED 2026-09-03: the Rust floor is judged under ONE key — the mount's own surface.** `consent_keys_for_application` expanded one application name into the bare key plus every namespaced one and admitted the mount when ANY held a record, so approving a REPORT application called `acme.stats` satisfied the floor for a LIBRARY called `acme.stats` — the collision `consentKey.ts` names as the one its namespace exists to prevent. Every mount now names its surface (`consentSurface`, a closed union in `mountConsentSurface.ts`) and Rust narrows to that surface's key through the `CONSENT_SURFACES` table; the bare key belongs to `object-script` alone. A mount that names no surface, or one Rust does not know, is REFUSED outright — it does not fall back to the coarse floor, and the surface is matched before the consent file is even read. Stated at its true strength in the code: the surface is a renderer claim, so under a compromised renderer this is exactly as strong as the old floor, and under an honest one the separation is real. The Rust table is pinned three ways against TypeScript (each key-former's spelling, the union's members, and each mount route's claim); the Rust unit test walks every surface against every other. | `app/src-tauri/src/scripting/commands.rs` (`CONSENT_SURFACES`, `distributed_mount_refusal`, `an_approval_under_another_surfaces_key_does_not_admit_this_surface`), `app/src/api/scriptHost/mountConsentSurface.ts`, `app/src/api/scriptHost/host.ts` (`requireDistributedMountConsent`), `app/src/api/__tests__/mountConsentKeyDrift.test.ts`, `app/src/api/scriptLibraries/consentKey.ts` |
| **CLOSED 2026-09-03: `consent-flow.spec.ts` now pins the refusal, because its old technique became impossible.** It reached a distributed prompt by EMITTING `consent-needed` itself — the only way without a real `.calp`, since `save_object_script` refuses renderer-minted distributed provenance — then clicked Allow and asserted the mount. A grant now has to name a screen the extension issued, so that press is refused, and `repromptPackage` correctly finds nothing to re-ask (it reads the store; the script existed only in the session registry). The spec asserts the refusal instead: the dialog still renders, and Allow grants nothing, mounts nothing, and the declared capability does not work. Its header names where each piece of the old coverage went — the real grant→mount→capability path to `script-form-distributed.spec.ts` (which passes in ONE click because the extension issued the screen), the source-change re-prompt to the unit suites over the real consent store, the storage round-trip to `capability-storage.spec.ts`. | `app/e2e/tests/consent-flow.spec.ts`, `app/e2e/journeys/script-form-distributed.spec.ts` |
| **CLOSED 2026-09-03: the debug bridge pairs a start with its answer by ID, not by arrival order.** Every `BridgeCommand` now carries a monotonic `id` (one window-wide sequence; for a `start` it is the attempt token `startDebugSession` returns), and the main-window bridge echoes it as `commandId` on both broadcasts it builds: its catch (the rejection) and a new stamped, error-free SUCCESS answer sent for a `start` when the host's start promise resolves. The host's own `emitDebugState` cannot carry the id — its settled state comes from the worker's `mounted` message, keyed by mount, not by whichever start asked — so the attribution is made at the bridge, the one place that awaited that exact start; `hostStartDebugSession` resolves from the same `mounted` message AFTER `noteDebugMountSettled` has broadcast, so the success answer follows the host's states on the wire. The consumer retires exactly the attempt an answer names and records a refusal under that id when the attempt is outstanding OR a Run is waiting on that id; arrival-order pairing survives ONLY as the fallback for an unstamped host settled state, and it can only retire, never record a word. A stamp with no usable id answers nothing (it cannot come from this bridge), and the bridge drops a command with no id rather than relay something it could not answer. The reordering the skeptics could not reach is what the new probes deliver: two outstanding Runs answered in the opposite order each read their own gate's words; a Run's refusal arriving before an earlier Debug press's answer reaches the Run instead of being stamped onto the Debug press (under arrival order it waited out the 20-second backstop and fired into nothing); a success answer for the second of two same-tick starts leaves the first to its refusal. Five sabotages, each red on the named assertion with the wrong value shown; the first harness that ran them reported five reds that were all a suite-load failure, which is why the runs were repeated from the shell. | `app/extensions/ScriptableObjects/lib/debugger.ts` (`BridgeEnvelope`, `DebugStateBroadcast.commandId`, `decodeBridgeAnswer`, `observeDebugBroadcast`, `installObjectScriptDebugBridge`), `app/extensions/ScriptableObjects/lib/__tests__/debugger.test.ts` ("AN ANSWER NAMES ITS START", "the main-window debug bridge") |
| **CLOSED 2026-09-03: the consent residue, plus two items its fixers flagged.** (a) `consentedPackages` was write-only once the freshness check ran on every pass — a cache of a security decision with no reader is a cache waiting for one — and is deleted; the persisted record is the only memory of an approval. (b) `customfunctions:consent-granted` now toasts a failed grant the way the Charts caller does; the wording covers both halves honestly, because the extension cannot see whether `recordConsent` or the install threw. (c) The refusal path (a grant answered on a screen that is gone, or whose workbook moved on) re-asks at most `MAX_REFUSAL_REPROMPTS_PER_SESSION` (3) times per application per workbook session, with "re-ask N of 3" in the toast, then stops and says so; the load pass on the next open/update still asks, and a grant that goes through resets the count. (d) The consent load path fetched every module's source through `listWorkbookScriptRecords` — one `get_script` per module, the user's own recorded macros included, on every open and update — to hash the distributed ones and discard the rest; `listDistributedWorkbookScriptRecords` decides "distributed" from the summary row (which already carries `sourcePackage`) and fetches those alone, so N local + M distributed costs M fetches (pinned by counting). The CLI's `listMacros` needed only provenance and now lists in ONE round trip through `listWorkbookScripts()`. (e) `packageOrigin` used `name \|\| placeholder`, keeping a whitespace-only name, while `scriptOriginForStoredRecord` trimmed and read the same stamp as LOCAL — so a module stamped `"   "` ran UNLOCKED through `runObjectScriptOnce` while Rust's `distributed_module_refusal` held the same record to be distributed (it reads `Option<String>`: any `Some(..)` is a publisher's). Both derivations now share one rule: an absent stamp is local, a present one is a package, a blank name is the placeholder, and a non-blank name is kept verbatim (both Rust gates compare the raw string). Three tests that had pinned "blank stamp = local" were inverted — one of them (`objectScriptRunner.test.ts`) was titled "names the publisher as a package even when the stamp is blank" and asserted `unlocked`/`local`. Residue of (e): the display-only derivations in `codeInventory.ts:435/536`, `NotebookToolbar.tsx:39`, `macroLibrary.ts:184` and `customFunctions.ts:342/567` still read a blank stamp as local; every GATE agrees with Rust now, so the mismatch is a chip saying "local" for a module the gates treat as distributed — fail-closed, hand-edit-reachable only, and `consentPackageKey` deliberately excludes such a module from the grant rather than promise a run Rust still refuses (the module gate keys on the raw `"   "`). | `app/extensions/ScriptableObjects/index.ts` (`refuseGrantAndReprompt`, `MAX_REFUSAL_REPROMPTS_PER_SESSION`), `app/extensions/CustomFunctions/index.ts`, `app/src/api/workbookScripts.ts` (`listDistributedWorkbookScriptRecords`), `app/extensions/CommandLine/cli/appGateway.ts`, `app/src/api/scriptHost/scriptOrigin.ts` (`packageNameOrPlaceholder`), `app/src/api/customFunctions.ts:355`; tests `packageConsentLoadPath.test.ts` (4b), `CustomFunctions/__tests__/consentGrantFailureToast.test.ts`, `workbookScriptInventory.test.ts`, `CommandLine/__tests__/gatewayMacroListing.test.ts`, `scriptOriginForgery.test.ts` |
| **CLOSED 2026-09-03: every mount route now hands Rust the artifacts its own surface recorded, and Rust requires all of them.** Nothing was synthesized at the boundary — that reasoning stood. Each OWNING SURFACE passes what it already holds: chart marks `{CHART_MARKS_SCRIPT_ID, markLibraryConsentSource(lib)}` (the former lives in that module), chart transforms the same with `transformLibraryConsentSource`, the UDF realm `{CUSTOM_FUNCTIONS_SCRIPT_ID, consentSource}` where the plan now carries the gate's own string (one `functionsByPackage` grouping feeds both, blank bodies included, because the record was written over that grouping), a shared-library realm one entry PER MODULE it merged (`consentArtifacts` is a list), a writeback validator `{writebackValidatorScriptId(name), body}`, and the one-off runner / module debug session the stored module under the bare key — with the source ABOUT TO RUN, so an edited publisher macro is refused at the hash rather than admitted on the floor (the module gate cannot catch that case: an edited body matches no stored module and it answers "allow"). Rust holds every named artifact to `consent_granted_in` under the surface's key; an empty list is refused, not floored. No route was left unable to name its artifact. | `app/src-tauri/src/scripting/commands.rs` (`every_named_artifact_must_be_granted_not_just_one`, `an_artifact_granted_under_another_surfaces_key_does_not_count`), `app/src/api/chartMarkScripts.ts`, `app/src/api/chartTransformScripts.ts`, `app/src/api/customFunctions.ts` (`functionsByPackage`, `CustomFunctionRealm.consentSource`), `app/src/api/scriptLibraries/linker.ts`, `app/src/api/writebackValidators.ts`, `app/src/api/objectScriptRunner.ts` (`ResolvedArtifact`), `app/src/api/scriptHost/__tests__/distributedMountApplicationConsent.test.ts` |
| **CLOSED 2026-09-03: same fix as the arrival-order row above.** This row was already half-stale when filed: the "neighbouring command's words" half (a failing `stop`/`breakpoints` contributing its wording) had been closed by the `command` stamp in the pass-3 row, and the remaining half — which START a refusal belongs to — is the per-command id that row describes. Both halves are now matched by id. | `app/extensions/ScriptableObjects/lib/debugger.ts` (`BridgeCommand`, `observeDebugBroadcast`) |
| **CLOSED 2026-09-04: a local notebook never pays for the consent file.** The notebook gate runs once per CELL on every path (run / run-all / rewind / run-from all funnel through `run_cell_internal`), and it read and parsed the whole consent file BEFORE the pure decision looked at the stamp — so a Run All over N of the user's own cells was N parses of a file that could not change the answer (an in-memory `serde_json::from_slice` under a `Mutex`, so small in absolute terms, and still N times nothing). The blank-stamp rule is now ONE predicate, `is_stamped_package`, shared by the stateful early return and the pure decision so they cannot drift; a distributed notebook is refused on its first cell anyway, so per-cell cost there is moot. The ordering is pinned from TypeScript (`distributedNotebookRefusalHonesty.test.ts` reads the `.rs` as text) because the crate has no tauri mock app to drive the stateful half — sabotage-verified: swapping the two lines reds exactly that assertion. | `app/src-tauri/src/scripting/notebook_commands.rs` (`is_stamped_package`, `require_distributed_notebook_consent`), `app/extensions/ScriptNotebook/__tests__/distributedNotebookRefusalHonesty.test.ts` |
| **CLOSED 2026-09-04: the mount gate judges under the name the renderer RECORDED, verbatim.** It trimmed the application name before forming its key while every recorder and both other Rust gates compare it raw — so a name with edge whitespace was recorded under `" Sales"` and judged under `"Sales"`, refused after a genuine approval. Trimming now decides only whether there is a name at all. | `app/src-tauri/src/scripting/commands.rs` (`distributed_mount_refusal`, `a_name_with_edge_whitespace_is_judged_under_the_key_the_renderer_recorded`) |
| **CLOSED 2026-09-04: `list_scripts` sorts by (name, id).** `workbook_scripts` is a HashMap, so two same-named modules (two applications each shipping a `Report`) kept RandomState order under a name-only stable sort — a different order on two launches, visible in every picker and the transparency panel. The button planner refuses that tie outright; the listing is now at least the same list twice. | `app/src-tauri/src/scripting/commands.rs` (`list_scripts`) |
| **CLOSED 2026-09-04: a superseded mount cleans up only what it started — and hears about it at once.** A second mount of the same id terminates the first's worker, which then never answers; the first mount's ten-second deadline fired and unmounted BY ID, tearing down the LIVE successor the user was debugging, and `startDebugSessionOn`'s catch deleted the successor's session the same way. Three things now: the catch unmounts only if `mounted.get(id)` is still this worker; the session is deleted only if it is still the one this call created; and `hostUnmountScript` rejects a still-pending predecessor immediately (`rejectMount`), with the promise executor also checking `mw.terminated` because `mounted` is published before the backend round-trips that precede the handshake. Probes: `debugSession.test.ts` "a superseded mount cleans up only what it started" — under sabotage the successor is torn down (`expected true to be false`). | `app/src/api/scriptHost/host.ts` (`mountWorker`, `hostUnmountScript`, `startDebugSessionOn`), `app/src/api/scriptHost/__tests__/debugSession.test.ts` |
| **CLOSED 2026-09-04: MacroRecorder's provenance derivations use the shared origin rule.** `isDistributedMacro` trimmed and read a blank stamp as LOCAL, and three gates hung off it: the run tier (**unlocked**), the edit disposition (in place, not fork) and the refusal text. Routed through `scriptOriginForStoredRecord`; the chip shows the placeholder for a blank stamp; every MacroRecorder suite that mocked `@api` now imports the REAL origin rule via `importActual` instead of a hand-rolled copy of the old one (two of them claimed to be "the real implementations" and were not). | `app/extensions/MacroRecorder/lib/macroLibrary.ts`, `app/extensions/MacroRecorder/__tests__/*.test.ts` |
| **CLOSED 2026-09-04: chart mark/transform libraries decide by origin, not truthiness.** `if (!sourcePackage)` in both loaders and `sourcePackage ? "distributed" : undefined` in both mounts read an exactly-empty stamp as the user's own library — installed with no consent gate, mounted LOCAL. All four sites now go through `scriptOriginForStoredRecord` / `mountProvenanceForOrigin`; the consent descriptor's display name is the origin's placeholder for a blank stamp. | `app/extensions/Charts/index.ts` (both loaders), `app/src/api/chartMarkScripts.ts`, `app/src/api/chartTransformScripts.ts`, `app/src/api/__tests__/chartMarkScripts.test.ts` |
| **CLOSED 2026-09-04: the UDF consent prompt says when the code runs, and `onOpen` is delivered.** "Runs whenever a cell uses it" was false in the adversarial case: the body is spliced inside an arrow function but nothing refuses a body whose `}` closes it early, and what follows runs at every load. The sentence now names both triggers. And "handlers that run when this workbook opens" was promised but never delivered — this realm never passed `mountCause`, so the host's one-shot `onOpen` replay (`openReplayPending`) was never armed for it; the open-driven install now threads `cause: "open"` all the way to `hostMountScript`. The honesty test's `sheet.*` clause is now one explicit case per row, not a prefix rule that would let a new sheet row with different reach pass under an old sentence. | `app/extensions/CustomFunctions/components/DistributedFunctionsConsentDialog.tsx`, `app/src/api/customFunctions.ts` (`mountCause: opts.cause`), `app/extensions/CustomFunctions/index.ts`, `app/extensions/CustomFunctions/__tests__/distributedFunctionsConsentHonesty.test.tsx` |
| **CLOSED 2026-09-04: the button planner's notices and shadows tell the truth.** A local module that merely *existed* shadowed a distributed namesake even when empty or unreadable — `Name()` then ran with nothing defined and no word why; the shadow set is now built from the modules that will actually be wrapped. And composed code naming a name two applications answer to got one notice per module, each telling the user to "set the action to exactly Name()" — the one thing the planner then refuses as ambiguous; it is now one notice per name carrying the refusal's own remedy. | `app/extensions/_shared/lib/buttonScriptRun.ts` (`planInlineButtonRun`), `app/extensions/_shared/lib/__tests__/buttonScriptRun.test.ts` |
| **CLOSED 2026-09-04: every module picker shows provenance, and the autocomplete offers only calls that do what its rows say.** The OnSelect autocomplete offered a distributed row whose inserted `Name()` ran the user's LOCAL module of the same name (local-wins), and two identical `Report()` rows for two applications, each claiming its own — a call the planner refuses. A shadowed distributed row is no longer offered, and a tie collapses into one row that says the name is claimed by several applications. The two view-bookmark overlays declared a private `ScriptSummary { id; name }` that dropped `sourcePackage` and rendered bare names; both now label through `scriptPickerLabel` and say through `describeDistributedScriptChoice` when the chosen module is a publisher's. Its test pinned the defect ("the run planner decides by provenance, not spelling" — it decides by name) and was rewritten. | `app/extensions/Controls/PropertiesPane/CodePropertyInput.tsx` (`buildScriptSuggestions`), `app/extensions/BuiltIn/CellBookmarks/components/ViewBookmark{Create,Edit}Overlay.tsx`, `app/extensions/Controls/__tests__/scriptPickerProvenance.test.tsx`, `app/extensions/BuiltIn/CellBookmarks/__tests__/viewBookmarkScriptPicker.test.ts` |
| ~~**OPEN — a custom-function body whose `}` closes its wrapper early runs at LOAD, inside the same sandbox.**~~ **CLOSED 2026-09-12 — refused at generation, by a real parser.** `validateFunctionBody` (`app/src/api/customFunctions.ts`) wraps the body the way `generateLibrarySource` does — `(async (<params>) => {\n<body>\n})` — parses that probe with **acorn**, and requires the result to be exactly one `ArrowFunctionExpression`. An escaping body cannot survive it: parentheses admit one expression, so the escape is a SyntaxError rather than a well-formed program. `generateLibrarySource` calls it beside the existing name/param checks and throws, and `planCustomFunctionRealms` already ran BEFORE any teardown, so a refusal leaves the previously-installed library standing. **The row's own objections both held and both are answered.** A brace count would indeed have been defeated by strings, template literals, regex literals and comments — so the guard is tested against all four plus nested blocks, an inner arrow, and `try`/`catch`, because wrongly REJECTING a legitimate body is the worse failure here (the author has no way to satisfy it). And `new Function` as the parser would indeed have been the button planner's mistake repeated: the shipped CSP has no `unsafe-eval`, so it works in `tauri dev`, which enforces no CSP, and throws in a built app. Acorn needed no new dependency — it is already in `dependencies` and already parses object scripts one directory over (`scriptHost/scriptValidation/analyze.ts:23`). One behaviour worth knowing, pre-existing rather than introduced: one bad definition refuses the whole plan, so a publisher's malformed body disables the subscriber's own functions until the package is fixed — an invalid NAME has always done that, and refusing is the safe direction. Both sabotages verified: neutering the validator reds the 7 refusal tests while all 8 acceptance tests stay green, and removing only its call site reds exactly the one wiring test. | `app/src/api/customFunctions.ts` (`validateFunctionBody`, called from `generateLibrarySource`), `app/src/api/index.ts`, `app/src/api/__tests__/customFunctions.test.ts` (34 tests) |
| **OPEN — a module stamped with a BLANK application name fails closed on both sides and can never be approved.** Reachable only by hand-editing a `.cala` (pull always stamps a real name). TypeScript now reads a blank stamp as "distributed, placeholder name" and deliberately leaves such a module OFF the consent prompt rather than promise a run; Rust's module gate keys `consent_granted_in` on the raw `"   "`, which no record will ever carry. Consistent, fail-closed, and a dead end. Closing it means Rust normalising the stamp to the same placeholder TypeScript uses AND the prompt admitting the module under that key — not worth a Rust change for a hand-edit corner, but it must not be mistaken for "blank means local", which is the direction that would be a hole. | `app/src-tauri/src/scripting/commands.rs` (`distributed_module_refusal`), `app/extensions/ScriptableObjects/lib/packageConsentSet.ts` (`consentPackageKey`), `app/src/api/scriptHost/scriptOrigin.ts` |
| **OPEN — two DISPLAY-only provenance chips still read a blank stamp as local while every gate reads it as distributed.** `app/src/api/codeInventory.ts:435` and `:536`, and `app/extensions/ScriptNotebook/components/NotebookToolbar.tsx:39`. (MacroRecorder and the chart loaders were in this list and are closed above — the MacroRecorder one turned out not to be display-only at all: three gates hung off it.) Same hand-edit-only corner as the row above; the consequence is a chip saying "local" for a module the gates refuse as distributed — wrong in the safe direction, but wrong. Route both through `scriptOriginForStoredRecord`. | the two sites above, `app/src/api/scriptHost/scriptOrigin.ts` (`scriptOriginForStoredRecord`) |
| **CLOSED 2026-09-04 (M2 S1): the host now applies event backpressure — hold at 256, release below 64, and a stall is a crash.** `EVENT_QUEUE_HIGH_WATER` had been declared and read nowhere; the realm has always acknowledged every dispatch with `{t:"eventDone"}`, and the production message loop ignored it (only the preview runner counted acks), so a hook that stopped returning let the host post for as long as the workbook stayed open. `postEvent` counts outstanding dispatches; past high water the host posts nothing — discrete hooks queue in order in `heldEvents` (hard cap 4× high water, oldest dropped and counted), coalesced hooks keep merging; `onEventDone` releases only once the realm has drained below `EVENT_QUEUE_LOW_WATER` (hysteresis — one threshold flaps on every ack); and a held realm that acknowledges nothing for `EVENT_STALL_MS` (30 s) goes through `crashWorker` exactly as a crash does (one respawn, then fault). The watchdog arms only while held, so an ordinary backlog is never a stall. The crash handler was factored out of `onerror` into `crashWorker` for that reuse — three source pins that sliced the old inline body were re-pointed. `refreshScriptFormSeeds` caps the per-refresh `onChange` fan-out at 32 (`MAX_FORM_CHANGE_FANOUT`; the mirror is still updated in full). Sabotage-verified both ways: neutering the hold reds exactly the five hold-dependent probes; disabling the watchdog callback reds exactly "the wedged realm was left running". | `app/src/api/scriptHost/host.ts` (`postEvent`, `onEventDone`, `releaseHeldEvents`, `armStallWatchdog`, `crashWorker`, `forwardEvent`), `app/src/api/scriptHost/protocol.ts` (`EVENT_QUEUE_LOW_WATER`, `EVENT_STALL_MS`), `app/src/api/scriptHost/scriptForms.ts`, `app/src/api/scriptHost/__tests__/eventBackpressure.test.ts` |
| **CLOSED 2026-09-04 as M2 S4 — the renderer and the panel wiring.** The task pane paints through the SAME widget tree the modal form paints: `FormWidgetTree` is one module (pinned by `scriptPaneSharedTree.test.ts` — exactly one definition, one `renderWidget` switch, both surfaces import it), and the pieces a second host needed were extracted FIRST with zero behaviour change — `landFormPatch` (`lib/scriptFormState.ts`, the one body both surfaces land a patch through) and `hostChrome.tsx` (`scriptGlyph`, `originPhrase`, `findFormWidgetFocusable`) — proven by the ten pre-existing form/pane test files staying green unedited. The pane is a TRUSTED section component inside ScriptableObjects (`components/scriptPane/ScriptPaneSection.tsx`) over a per-pane store held outside React (`lib/scriptPaneStore.ts`: the section mounts only while painted), registered through the `registerPanel` seam by `lib/scriptPaneHost.ts` — one `PanelDefinition` per pane (`scriptable-objects.pane.<scriptId>.<paneId>`, so one script's placement preference can never bleed onto another's), REQUEST → register + open + a "docked" ack carrying the EFFECTIVE placement read back from the panel system, PATCH → store/badge/reveal, `panel:placementChanged` → "placement", CLOSE → unregister. The identity band is host chrome; a pane takes no focus on open and a script `focus` moves focus only while focus is already inside the pane (a slice of S6, done now because shipping the pane without it would have shipped a focus-stealing route). A USER-OWNED close tells the registry first. Not exercised in a browser this round: the ribbon-launcher placement and the real SidePanel hide path — unit-pinned against mocks. | `app/extensions/ScriptableObjects/components/scriptPane/ScriptPaneSection.tsx`, `app/extensions/ScriptableObjects/lib/scriptPaneStore.ts`, `app/extensions/ScriptableObjects/lib/scriptPaneHost.ts`, `app/extensions/ScriptableObjects/lib/scriptFormState.ts` (`landFormPatch`), `app/extensions/ScriptableObjects/components/scriptForm/hostChrome.tsx` |
| **CLOSED 2026-09-04 as M2 S5 — bindings and the visibility-gated watch.** A pane's bound widgets take the FORM's pipeline, not a second one: `pane.dock` hands `dockScriptPane` the same `resolveFormBindings` thunk `form.show` hands `showScriptForm` (after the registry's guards, so a refused dock reads nothing); a restricted pane is pinned to the sheet on screen at dock and a binding naming another sheet is refused by the tier clamp and shown disabled with the clamp reason. A pane has no Submit, so EVERY writable cell binding is `writeOn: "change"`; each committed change goes through `writeBoundCells` — the one writer both surfaces now share (`writeFormBindings` / `writePaneBindings` are wrappers) — with the same pin check, the same `sheetIdentityRefusal`, `withScriptUndoBatch("Pane: <name>")`, the audited `sheet.setCellValue` row and the own-write refresh; a refused write is a `message` patch and the pane stays open. The live watch is `installBoundLiveWatch`, factored out of `installFormLiveWatch`, installed on the renderer's `visible` input, torn down on `hidden` and on close, with every bound cell and control RE-READ on each reveal (`onlyChanged: true`), so a pane hidden for an hour delivers one event per widget whose value differs and never a read while hidden. The panel registry had no reliable visibility signal; the renderer's section component now reports `visible`/`hidden`, and `visible` also counts as the dock. | `app/src/api/scriptHost/host.ts` (`writeBoundCells`, `installBoundLiveWatch`, `paneSessionDeps`), `app/src/api/scriptHost/scriptPanes.ts` (`refreshScriptPaneSeeds`), `app/src/api/scriptHost/scriptFormBindings.ts` |
| **CLOSED 2026-09-04 as M2 S6 — the hostile-script hardening pass.** Closes the skeptic-confirmed HIGH "pane.reveal is unbounded": `revealScriptPane` had three STATE guards (owned / docked / placement) and no rate or provenance check, so `for (;;) await pane.reveal()` re-opened the sidebar onto the pane for the script's lifetime, and a sidebar close only hid a pane (input "hidden") without ending it. Now a reveal is admitted only within `PANE_REVEAL_GESTURE_WINDOW_MS` (5 s) of a USER gesture attributable to the script — `noteScriptGesture(scriptId)` in `scriptPanes.ts`, stamped by the registry for the pane's own change/click inputs and at dock ack, and by `host.ts` ONLY at user entries: `hostStartDebugSession` / the module-session mount / `hostDebugFireTrigger` (Run, F5, Fire in the editor), the `cap.shortcutBind` runner (the app's one keydown listener; NOT `hostCallExposed`, which scheduled jobs and cross-script calls share), the `button:clicked` / `shape:clicked` / `panel:clicked` forwarders, and `formSessionDeps.forward` for onClick / user-sourced onChange / submit-or-cancel onClose (`isFormUserGesture`) — never onShow, a cell-sourced change, a timer or a hook. Outside the window the answer is `{ revealed: false, reason: "no-gesture" }`; inside it a per-script bucket `PANE_REVEALS_PER_MINUTE` (6) answers `"throttled"`; both are audited under the script (`PaneSessionDeps.audit` -> `auditPaneRefusal` in host.ts, an `ok:false` `appendAudit` row with `NoGesture` / `RateLimited`, silent for a dry run like the broker's `audit`), because the broker's own row for a reveal or an "emit" update says `ok` whatever the registry did. **Throttle ladder** (headless, per pane, fake-timer tested): refused update / setBadge / reveal calls counted over a sliding minute; at `PANE_THROTTLE_BANNER_AT` (30) a HOST-owned banner ("...faster than Calcula allows; it is being slowed down") in a slot the script's `message` patch can neither clear nor overwrite (`PaneHostBanner`, `ScriptPanePatchPayload.hostBanner`, `store.setHostBanner`, `data-script-pane-host-banner` above the script's title); at `PANE_THROTTLE_COOLDOWN_AT` (120) a `PANE_THROTTLE_COOLDOWN_MS` (30 s) cooldown in which EVERY script call is swallowed uncounted and the banner counts the seconds down (`until`); the third cooldown within `PANE_THROTTLE_CLOSE_WINDOW_MS` (10 min) ends the session with the NEW `PaneCloseReason` `"throttled"` — the script's onPaneClose, a warning toast from the wiring naming the script — and each step is one audit row (`pane.throttle.banner` / `.cooldown` / `.close`), never one per dropped call. `pane.reveal`'s ALLOWLIST row now declares `limits.perMinute` and says "only for a few seconds after you used it or ran the script". Focus containment VERIFIED and pinned: `control(name).focus()` is the same `focus` patch (contextShims), `openPanel` only sets the activity-bar store, no `.focus(` in the shell's panel files; new tests for a focus request while focus is in an element OUTSIDE the pane and for a reveal through the wiring taking no focus. The honest ribbon answer is unchanged and its tests stayed green unedited; state answers (closed / not opened / ribbon) come BEFORE the window and are not refusals. Sabotage-verified in 17 rounds, each red exactly on its own test (infinite window -> the five gesture tests; skipped third-cooldown close -> that one test; etc.). Not pinned by a unit test: the debugger and shortcut stamp sites (verified by reading). | `app/src/api/scriptHost/scriptPaneSpec.ts` (`PANE_REVEAL_GESTURE_WINDOW_MS`, `PANE_THROTTLE_*`, `PaneRevealRefusalReason`, `PaneHostBanner`, `PaneCloseReason`), `app/src/api/scriptHost/scriptPanes.ts` (`noteScriptGesture`, `revealScriptPane`, `noteRefusal`, `enterCooldown`, `PaneSessionDeps.audit`), `app/src/api/scriptHost/host.ts` (`auditPaneRefusal`, `isFormUserGesture`, the eight `noteScriptGesture` sites), `app/src/api/scriptHost/allowlist.ts` (the `pane.reveal` row), `app/extensions/ScriptableObjects/lib/scriptPaneStore.ts` (`setHostBanner`), `app/extensions/ScriptableObjects/lib/scriptPaneHost.ts`, `app/extensions/ScriptableObjects/components/scriptPane/ScriptPaneSection.tsx` (`HostBannerView`), `app/scripts/scriptTypings/objectContexts.template.d.ts`, `app/src/api/scriptHost/__tests__/scriptPanes.test.ts`, `app/src/api/scriptHost/__tests__/scriptPaneGestures.test.ts`, `app/extensions/ScriptableObjects/__tests__/scriptPaneStore.test.ts`, `app/extensions/ScriptableObjects/__tests__/scriptPaneSection.test.tsx`, `app/extensions/ScriptableObjects/__tests__/scriptPaneHost.test.ts` |
| **CLOSED 2026-09-04 as M2 S5 follow-up — the close-path flush and the off-sheet reveal.** Two skeptic-confirmed defects. (1) A text-like widget's change rode `s.changeTimers` and `endSession` cleared the timer after setting `closed`, so the last keystrokes in a bound textbox were dropped on the band's X, `pane.close()` and unmount while `onPaneClose` still carried the typed text — against `pane.dock`'s promise that "closing the pane does not undo that". `changeTimers` now holds `{ timer, deliver }` and `flushPendingChanges` runs first in `endSession`, delivering the latest value through the SAME path a timer expiry takes (`onPaneChange`, then `writePaneBindings` -> `writeBoundCells`: pin check, `sheetIdentityRefusal`, undo batch, audited `sheet.setCellValue`, own-write refresh). `hostUnmountScript` terminates the worker before `revokeScriptPanes`; the write is host-executed and lands, and `paneSessionDeps.forward` skips a terminated realm. A refused flush is a toast (the band is gone) naming the widget, the reason and the fix, and `writeBoundCells` now audits its pin/identity refusals (ok=false) which previously left no row. (2) At restricted tier `paneSessionDeps.visible` re-read every bound seed without comparing the active sheet to `bound.pinnedSheet`; hide -> switch sheet -> reveal refused each read under the tier clamp, charged the script a denial per cell for the USER's gesture, adopted `null` and announced `{ value: null, source: "cell" }` per untouched widget, disabled under the wrong sentence. Now `settleOnSheet` asks `lib.getActiveSheet()` (the writer's own authority) first: off-sheet it reads and announces nothing, disables the bound widgets with their last value under `pinnedSheetReturnSentence(bound, "pane", "see and save")` plus a warning banner, and listens for SHEET_CHANGED; the return clears the banner, installs the live watch and re-reads with `onlyChanged`; `hidden`/`closed` drop the listener; the watch never installs off-sheet; unlocked panes are unaffected. Eleven tests, each sabotaged to exactly its assertion. | `app/src/api/scriptHost/scriptPanes.ts` (`flushPendingChanges`, `endSession`, the "change" case), `app/src/api/scriptHost/host.ts` (`paneSessionDeps` `settleOnSheet`/`arm`, `pinnedSheetReturnSentence`, `writeBoundCells` `refuse`), `app/src/api/scriptHost/__tests__/scriptPanes.test.ts` ("a close inside the text debounce flushes the pending change first"), `app/src/api/scriptHost/__tests__/scriptPaneBindings.test.ts` (sections 6 and 7) |
| **CLOSED 2026-09-04 as M2 S4 follow-up — a stable pane key for the placement preference.** The Shell persists the user's "put it on the ribbon" by panel id (`usePanelPlacementStore`, localStorage), and `scriptPanePanelId` built that id from `paneId` = `pane-${++paneSeq}` — one global counter, never reset or reused — so a re-dock came back in the sidebar every time and each move left a dead entry. Every session now carries a STABLE `paneKey` beside the opaque host-minted `paneId` (ownership checks unchanged): `pane.dock({ key })` (1..`MAX_PANE_KEY_CHARS`=32 of `PANE_KEY_PATTERN`, judged by `checkPaneKey` in `vPaneDock` and stripped before the shared `checkFormShowOptions` so `form.show` never learns it), defaulting to the lowest free slot "0".."2" (`lowestFreeSlot` over `liveKeys`, which DERIVES liveness from `sessionsByScript` + `pendingDocks` through `keyOf`, so a close frees the slot through `endSession`'s own bookkeeping and a pending dock holds its key). A duplicate live key is refused by name (`a pane with key "X" is already docked; close it first`), before the bucket like the cap. `paneKey` rides `ScriptPaneRequestPayload`; `scriptPanePanelId(scriptId, paneKey)` yields `scriptable-objects.pane.<scriptId>.<paneKey>`, and the wiring refuses a request with no key or whose panel id is already live (`registerPanel` upserts silently). `revokeScriptPanes`/`resetScriptPanes` drop `keyOf` with `ownerOf`. Pinned: slot reuse after close, slots 0/1 then 0 again, duplicate refusal, pending hold, failed docks free, revoke/reset; validator cases (empty, 33, space, slash, dot); the panel id from `paneKey` across close+re-dock, against the real registry too. Four sabotages (id from paneId; never free a slot; duplicate check off; pattern off) each red their case. | `app/src/api/scriptHost/scriptPanes.ts` (`keyOf`, `liveKeys`, `lowestFreeSlot`, `dockScriptPane`), `app/src/api/scriptHost/scriptPaneSpec.ts` (`MAX_PANE_KEY_CHARS`, `PANE_KEY_PATTERN`, `PaneDockOptions.key`, `ScriptPaneRequestPayload.paneKey`), `app/src/api/scriptHost/validators.ts` (`checkPaneKey`, `vPaneDock`), `app/src/api/scriptHost/host.ts` (`pane.dock`), `app/src/api/scriptHost/worker/contextShims.ts` (`paneFacet.dock`), `app/extensions/ScriptableObjects/lib/scriptPaneHost.ts` (`scriptPanePanelId`), `app/scripts/scriptTypings/objectContexts.template.d.ts` (`ScriptPaneApi.dock`), `app/src/api/scriptHost/__tests__/scriptPanes.test.ts`, `app/src/api/scriptHost/__tests__/scriptPaneSpec.test.ts`, `app/extensions/ScriptableObjects/__tests__/scriptPaneHost.test.ts` |
| **CLOSED 2026-09-04 as M2 S7 — transparency: panes and open forms in the code inventory's held state.** A docked task pane was visible only through its own identity band, and the modal form appeared nowhere in the inventory; `getScriptHeldState` now returns `panes` (one `ScriptPaneHeldEntry` per open pane: owner joined by `joinOwner` — code unit, then mounted handle, then the registry's host-recorded name — `visible`, `placement`, `boundCells`, `updatesLastMinute` over `PANE_UPDATE_WINDOW_MS`, `badge`) and `forms` (the `getActiveScriptForm()` row), and `summarizeScriptHeldState` counts both. The numbers are READ, never re-derived: `listScriptPanes()` reports `boundCells` off the session's `writeOnChange` record (for a pane every resolved cell binding is `writeOn: "change"`, so the set IS the binding record — no audited re-read under the script's handle for a transparency panel) and `updatesLastMinute` from a per-pane stamp list of ADMITTED `pane.update` / `pane.setBadge` calls, pruned on every record and read so a refused update and a closed pane never count. `ScriptPaneSummary` moved to the leaf `scriptPaneSpec.ts`. The panel paints one plain-text row per pane and one for the form (Blocking) with header chips; a script-chosen name that looks like markup renders as characters (pinned). Sabotage-verified: neutering the prune window reds exactly the sliding-minute test; counting before the bucket reds exactly the refusal test; a stale pane snapshot in the inventory reds exactly the close-removal tests; `dangerouslySetInnerHTML` on the owner reds exactly the plain-text test. One sabotage was a NO-OP (a second, redundant window filter) and the code was simplified so the guard has one place to bite. | `app/src/api/codeInventory.ts` (`ScriptPaneHeldEntry`, `ScriptFormHeldEntry`, `getScriptHeldState`, `summarizeScriptHeldState`), `app/src/api/scriptHost/scriptPanes.ts` (`listScriptPanes`, `noteAdmittedUpdate`, `pruneAdmittedUpdates`), `app/src/api/scriptHost/scriptPaneSpec.ts` (`ScriptPaneSummary`, `PANE_UPDATE_WINDOW_MS`), `app/extensions/ScriptableObjects/components/CodeInThisFilePanel.tsx` (`HeldByScriptsSection`), `app/src/api/codeInventory.scriptPanes.test.ts`, `app/extensions/ScriptableObjects/__tests__/CodeInThisFilePanel.heldPanes.test.tsx`, `app/src/api/scriptHost/__tests__/scriptPanes.test.ts` |
| **CLOSED 2026-09-04 — M2 review round 2: five defects the S3–S7 slices left behind, each confirmed by two skeptics before it was touched.** (1) **The close-path flush wrote into the WRONG WORKBOOK.** S5's flush ran for every close reason, and a document swap reaches panes as an ordinary `"unmount"` (`hostResetAll` → `hostUnmountScript` → `revokeScriptPanes`) — from `AFTER_OPEN`/`AFTER_NEW`, i.e. *after* the document has been replaced — so text typed into the old workbook inside the 150 ms debounce landed in the NEW workbook's cell of the same address. The swap now has its own `PaneCloseReason "reset"`, the flush decision is an exhaustive `Record<PaneCloseReason, boolean>` (a new reason cannot compile until it decides), the held change is DROPPED with a toast naming the widgets that were not saved, and `hostResetAll` sweeps panes BEFORE its unmount loop so the per-script sweep cannot claim them under the flushing reason. (2) **One slot, two owners:** the host's off-sheet pin notice travelled in the SCRIPT's `message` slot, so a script's own `pane.update({message})` replaced the host's sentence while the host kept its widgets disabled, and the clear on return deleted whatever the script had put there. It now has `hostBindingNotice`, a sibling of S6's `hostBanner` (not a reuse — both can be up at once, and sharing would have let the throttle banner erase the sheet notice), retracted UNCONDITIONALLY on every reveal back on the pinned sheet. (3) **The throttle ladder only went up.** `noteRefusal` was the sole writer of `throttleStage` and the only `setHostBanner(s, null)` sat inside `endCooldown`, so the HEAVIER stage self-cleared after 30 s while the lighter one never did: one ordinary burst left "it is being slowed down" on the pane for its whole life while every call was being admitted. The banner now has its own exit on its own clock with high/low-water hysteresis (`PANE_THROTTLE_BANNER_CLEAR_AT` 10 against the 30 that raises it). (4) The in-editor `pane.*` API list had gone stale within the same day (a `placement` the dock never resolves, four close reasons out of six, no `key`), now derived from the shim by `scriptPaneEditorDoc.test.ts` instead of restated. (5) A reveal after a hide-while-off-sheet came back under a stale pin sentence — fixed by (2), and the half nobody asserted (the widgets coming back ENABLED with current values) is now pinned with exact seed objects. Two findings were REFUTED by both skeptics and left alone (the per-session throttle state; a dock-loop bound that is calibration, not a hole) — recorded here because "reviewed and deliberately not changed" is a different state from "not looked at". | `app/src/api/scriptHost/scriptPanes.ts` (`CLOSE_FLUSHES_PENDING_CHANGES`, `dropPendingChanges`, `armBannerDecay`, `reviewBanner`), `app/src/api/scriptHost/scriptPaneSpec.ts` (`PaneCloseReason "reset"`, `hostBindingNotice`, `PANE_THROTTLE_BANNER_CLEAR_AT`), `app/src/api/scriptHost/host.ts` (`hostResetAll` order, `settleOnSheet`), `app/src/api/scriptableObjectScaffolds.ts`, `app/src/api/__tests__/scriptPaneEditorDoc.test.ts`, `app/src/api/scriptHost/__tests__/scriptPanes.test.ts`, `app/src/api/scriptHost/__tests__/scriptPaneBindings.test.ts` |
| **CLOSED 2026-09-04 — M2 review round 3: the dock was the cheap route to the screen, the banner named the wrong offence, and the pane's pin was an INDEX.** (1) **The dock took the screen with no gesture at all.** The wiring called `panels.register(...)` then `panels.open(panelId)` unconditionally, which forces the sidebar open AND switches the active view away from the user's work; `dockScriptPane` gated only on the per-script cap, key uniqueness and 10/minute, and it STAMPED a gesture at the ack while CONSULTING none — so a script closing and re-docking its own pane seized the sidebar ten times a minute for as long as it stayed mounted, and the user's only escape (move the pane to the ribbon) was defeated by docking under a fresh `key`, which got a new panel id with no override and fell back to "sidebar". Registering is now separate from taking the screen: an ungestured dock produces a real, listed, badge-carrying pane that does not open, `pane.dock` resolves `{ paneId, opened, placement }` and its consent sentence says so, `markDocked` stamps only when the dock actually took the screen (or the dock's own ack would hand the same screen back through `reveal` one call later), and the wiring remembers the last placement the user chose for ANY pane of that script as the panel's `defaultPlacement`, so a key rotation cannot launder the choice away. Two skeptics split on this one — both agreed on every FACT and disagreed only on whether a documented 10/minute bound is a defect; the deciding point, which the refuting skeptic did not reach, is that the user's escape is defeatable, so there is no way to keep the sidebar. (2) **The banner named the wrong offence.** Three refusals climb one ladder (`pane.update`, `pane.setBadge`, `pane.reveal`) and every host notice said "this script is updating its pane faster than Calcula allows" — so a script that had never called `update` once, looping `reveal()`, was accused of the wrong thing in the one channel a script cannot forge. The window now remembers WHICH KIND each refusal was and the sentence follows the mix (any of both reads as mixed, because a majority rule states something false about the rest and the minority kind is exactly where a second hammer would hide); the arithmetic is untouched. (3) **The pane's pinned sheet was compared by INDEX on every path except the write.** Deleting or dragging a sheet tab — ordinary mouse gestures, with a pane docked — made another sheet inherit the pinned index: the reveal then read THAT sheet's cells at the pinned coordinates and announced them to the script as its own bound values (disclosure, one audited read per cell charged against a sheet it never bound), and the off-sheet notice was raised against the wrong sheet, telling a user standing on Sheet1 to switch back to Sheet1. A `latchSheetIdentity` latch now answers reveal, live watch and write from `sheetIdentityRefusal`'s NAME comparison — the 2026-09-03 forms rule the pane had inherited only half of — latched rather than re-derived because a name can come back on a different sheet. (4) The review then found that the JIT `ui.pane` consent dialog ATE the gesture window: the prompt is awaited before the executor runs, so a user who took longer than five seconds to answer got a pane that docked without showing and a `reveal` that answered `no-gesture` for the rest of the session; the answered dialog is now itself the gesture, scoped to `ui.pane` alone so no other grant hands the pane window to code on its own clock. (5) And one spelling: the pin's own NAME was captured by array POSITION (`sheets[activeIndex]`) while every re-check resolves by `.index` — the class of defect commit 7fce7348 fixed eight times over — now `nameOfSheet(sheets, activeIndex)`, pinned by a source-reading guard. | `app/src/api/scriptHost/scriptPanes.ts` (`dockMayOpen`, `dockAckGestureAt`, `markDocked`, `refusalMix`), `app/src/api/scriptHost/scriptPaneSpec.ts` (`PaneRefusalKind`, `ScriptPaneRequestPayload.open`), `app/src/api/scriptHost/host.ts` (`latchSheetIdentity`, `noteCapabilityGrantGesture`, `mountWorker`, `resolveFormBindings`), `app/src/api/scriptHost/allowlist.ts` (the `pane.dock` desc), `app/extensions/ScriptableObjects/lib/scriptPaneHost.ts` (`lastPlacementByScript`), `app/src/api/scriptHost/__tests__/scriptPaneGestures.test.ts`, `app/src/api/scriptHost/__tests__/scriptPaneBindings.test.ts` (§8), `app/src/api/scriptHost/__tests__/sheetRefResolution.test.ts` (§5) |
| **CLOSED 2026-09-04 — M2 rounds 4 and 5: the pane now sees the user LEAVE its sheet, and one defect FAMILY was closed rather than one defect.** The off-sheet rule was produced only by the renderer's `visible` input, so hide → switch → reveal announced the pin while switching sheets with the pane IN FRONT OF THE USER did nothing at all: fully enabled widgets over the previous sheet's values, the truth arriving afterwards as a refused write — the one surface in this family that told the user AFTER they typed instead of before. `sheetWatch` is now held for the whole VISIBILITY of a pinned pane, before the active-sheet comparison, so standing on the pinned sheet is itself a watched state; one `settleOnSheet` body answers reveal, departure and return; a `settleTick` guard drops a stale `getSheets` answer that had been raising "switch back to Sheet1" at a user already on Sheet1. The MODAL form needs none of it — its backdrop covers the sheet tabs and a click there cancels the form — and was left alone. **Then two skeptics found the same shape three more times, each reproduced on the real host path**, and the fixes are what the rounds are really worth recording: `installBoundLiveWatch` returned the BARE unsubscribe for a layout with no Controls-pane binding — the ORDINARY pane — so the `disposed` flag the other exit had was unreachable and its 16 ms coalescer ran on after teardown, clobbering the departure's own settlement with `onPaneChange {value: null}`, the WRONG (clamp) sentence, and a `PermissionDenied` read charged to the script for the USER's gesture; the Controls-pane `.then` published into a HIDDEN pane (deferred once as "untestable" — that was false, and the disproof was thirty lines of the file's own harness); and `rereadBoundSeeds` awaited one read per cell with no check between them, spending audited reads on a surface that was gone and clobbering the seeds so the next reveal painted `null` where the last good value was due. All three now pass through ONE helper per path (`stillArmed` / `stillOurs`) that answers a sentinel after every await, so a read added later cannot reach a publish without deciding what the sentinel means. Two §9 tests were found to have NO TEETH for the property they named — both stayed green with the teardown deleted, because an epoch bump silenced the leak independently — and now count the listener's own removal; and the file was order-dependent (`activeSheetIndexForEvents` is module state no `beforeEach` reset, so a helper that omitted `sheetIndex` was silently swallowed after any test that moved the sheet). The final verifier reproduced every defect with the guards removed, confirmed each positive control still publishes, and swept every remaining await in the pane's host paths. | `app/src/api/scriptHost/host.ts` (`paneSessionDeps` `sheetWatch`/`offSheet`/`disarm`/`settleTick`, `installBoundLiveWatch` `cleanup`/`stillArmed`/`LIVE_WATCH_DISPOSED`, `rereadBoundSeeds` `stillOurs`), `app/src/api/scriptHost/__tests__/scriptPaneBindings.test.ts` (§9–§12) |
| **PROVEN LIVE 2026-09-04 — the task pane runs**: `app/e2e/journeys/script-pane.spec.ts`, 7/7 against the running app. A real key press starts a run that docks a pane beside the grid (`{ opened: true, placement: "sidebar" }`) under a host-drawn band naming the script, its origin and its pinned sheet; bound widgets read their cells at dock and write the TYPED value on each change with a currency cell staying numeric, follow another script's write, and still flush the last keystrokes when the pane is closed inside the text debounce; `pane.reveal()` on the script's own clock answers `{ revealed: false, reason: "no-gesture" }`, takes no screen and is audited, while the same call one keypress later is granted; a hammered `pane.update` raises a HOST banner naming UPDATES that the script's own message can neither clear nor overwrite; the docked pane appears in `getScriptHeldState()` with its owner, bound-cell count and badge, and leaves when it closes; and off the pinned sheet the widgets go read-only under the host's binding notice with NOT ONE cell read while the user is away. Writing the journey found one product gap (the visible-sheet-switch, closed in the row above) and one harness trap worth keeping: `add_sheet` through the backend does not refresh the tab strip — the event is `sheets:refresh`, not `grid:refresh` — so the strip kept rendering ONE tab while the backend held two and a tab click landed on a tab the frontend already believed was active, failing three assertions later under a message that named the click. Not proven live and unit-pinned instead: the throttle cooldown and forced close, the ribbon placement, the dock bucket, and `paneKey` persistence across a re-dock. | `app/e2e/journeys/script-pane.spec.ts` |
| **CLOSED 2026-09-04 as M3 M3a — on-grid controls had a right-click menu nobody could open.** `controlContextMenu.ts` registered fifteen items through `gridExtensions.registerContextMenuItems`, which only `GridContextMenuHost` renders, and that host opens solely on `AppEvents.CONTEXT_MENU_REQUEST` — which Core deliberately does NOT emit for a right-click on a floating object ("Cell options on an object right-click are always wrong", `Spreadsheet.tsx`). Right-clicking a button, shape or picture produced nothing at all. Controls now owns a capture-phase `contextmenu` listener (`installControlObjectMenu`) that hit-tests through the SAME predicate Core's overlay registration uses — `hitTestFloatingControl` moved to `lib/controlHitTest.ts`, joined by `floatingControlRegionAtClientPoint` so there is one rule for two callers — `preventDefault`s on a hit (which is what Core's `defaultPrevented` check reads), selects the clicked control (Delete acts on the SELECTION, and selection is done directly rather than by dispatching `floatingObject:selected`, whose handler RUNS a button's script in run mode), and shows `ControlContextMenu`. `buildControlObjectMenu` omits what does not apply rather than greying it, and the handlers now take the clicked control's id instead of the selection primary, which with two controls selected acted on a shape the user had not right-clicked. The grid registration is reduced to the one item that was genuinely reachable there — "Paste", whose context is a cell. | `app/extensions/Controls/lib/controlObjectMenu.ts`, `app/extensions/Controls/lib/controlHitTest.ts`, `app/extensions/Controls/lib/controlContextMenu.ts`, `app/extensions/Controls/components/ControlContextMenu.tsx`, `app/extensions/Controls/index.ts`, `app/extensions/Controls/__tests__/controlObjectContextMenu.test.tsx` |
| **CLOSED 2026-09-04 as M3b declared hit rectangles — the `ui.html` frame can finally be clicked.** `updateHtmlOverlay` set every shape iframe to `pointer-events: none` UNCONDITIONALLY ("allows click-through"), so the whole `ui.html` surface was decorative — the blocking defect for an interactive surface on the grid. A shape script now DECLARES the rectangles of its own frame that take pointer input, through a broker row of its own: `render.setHitRegions` (restricted / `ui.html` / mutate / `vHitRegions`), broker-audited beside `render.setHtml` because no Rust gate sees a claim on pointer input. Not an `object.setState` aspect, on purpose — `vSetState` ends in `return true`, so an aspect nobody wrote an arm for is unvalidated at restricted tier, which is how a multi-megabyte `data:` URI once reached a signed `.calp`. Coordinates are FRAME-LOCAL CSS pixels (origin at the frame's own top-left); a script never names grid pixels and cannot learn them from the call. The iframe stays `pointer-events: none` forever — an interactive frame would swallow every event in the shape's box, including select/move/resize, and `clip-path` clips the paint as well as the hit test — so the host places one transparent shim per declared rectangle above the frame and forwards the pointer in over the existing postMessage bridge as the reserved type `calcula:pointer`. Undeclared pixels have no shim and reach the grid exactly as before (pinned). Two escapes so a claim can never trap the user: DESIGN MODE suspends every claim at once and outlines each declared rectangle in dashed blue, and right-click is never claimed, so the shape's own menu stays reachable on a fully claimed frame. Bounds: 16 rectangles, ids 1-64 chars of `[A-Za-z0-9_.:-]` and unique, coordinates finite and 0..20000, minimum edge 1 — refused ALL-OR-NOTHING at the broker AND re-checked at the boundary where a claim becomes a DOM element, with the previous claim left standing and every refusal naming the way out (`[]` releases the frame). The claim dies with the code: `hostUnmountScript` emits the same empty declaration a script sends itself, so unmount and release take one code path, and `removeShapeHtmlOverlay`, the hidden-frame branch, the renderer's off-screen early-outs, extension deactivate and the structural-edit re-key all drop it too. 45 tests, ten sabotages — two of which were NO-OPS and are recorded as such: raising `MAX_SHAPE_HIT_REGIONS` changed nothing until the test stopped deriving its own case counts from the constant, and reversing shim creation order changed nothing because the positioning loop reassigns by index. | `app/src/api/scriptHost/shapeHitRegionSpec.ts`, `app/src/api/scriptHost/validators.ts` (`vHitRegions`), `app/src/api/scriptHost/allowlist.ts` (`render.setHitRegions`), `app/src/api/scriptHost/broker.ts` (`BROKER_AUDITED_CAPABILITY_METHODS`), `app/src/api/scriptHost/host.ts` (`executeImpl` case + the `hostUnmountScript` release), `app/src/api/scriptHost/worker/contextShims.ts`, `app/extensions/Controls/Shape/shapeHitRegions.ts`, `app/extensions/Controls/Shape/shapeRenderer.ts` (`updateHtmlOverlay`), `app/extensions/Controls/index.ts`, `app/scripts/scriptTypings/objectContexts.template.d.ts`, `app/src/api/scriptHost/__tests__/shapeHitRegions.test.ts`, `app/extensions/Controls/__tests__/shapeHitRegions.test.ts` |
| **CLOSED 2026-09-04 as M3 M3c — the identity model for embedded objects, and the embedded form itself.** Anchor-derived ids (`makeFloatingControlId`, `control-{sheet}-{row}-{col}`) lose a script on copy, RENAME an object on every structural edit, and DELETE it silently when its row goes. `embeddedFormPlacements.ts` adopts the cell-behaviour model instead — a minted UUID, geometry shifted by `structuralAnchorShift` and nothing else, and `orphaned` in place of a drop — so a copy is a second instance of the SAME `scriptId` with its own id, an insert moves the anchor and no consumer re-keys, and a deleted anchor leaves a red-edged surface saying what happened. The form itself is a pane SESSION with `placement: "embedded"`, not a fourth registry: every guard on a session fits (ownership, the update bucket, the throttle ladder, `resolveFormBindings` with its restricted-tier pin, the visibility-gated live watch, one set of audited rows), and the guards that do not — the per-script cap, the dock bucket, `dockMayOpen`, the slot key — all guard a SCRIPT taking shared screen and are unreachable here, because only `openEmbeddedScriptForm` (a host entry naming a placement id no script has seen) opens one. It paints the ONE `FormWidgetTree` over the ONE `ScriptPaneStore`, `HostNoticeBanner` was lifted into `hostChrome.tsx` so the two modeless surfaces cannot drift, `pane.close` is REFUSED for it ("a script cannot remove a surface the user placed"), `pane.reveal` answers honestly, and the row appears in the transparency panel as `placement: "embedded"` with its `placementId`. Rides `ui.pane` on the `cap.fileImportMedia` precedent — same agreement, strictly less reach — with one new row, `pane.list`, filtered to the caller in the host. | `app/src/api/scriptHost/embeddedFormPlacements.ts`, `app/src/api/scriptHost/scriptPanes.ts`, `app/src/api/scriptHost/scriptPaneSpec.ts`, `app/src/api/scriptHost/host.ts` (`openEmbeddedScriptForm`), `app/src/api/scriptHost/allowlist.ts` (`pane.list`), `app/src/api/codeInventory.ts`, `app/extensions/ScriptableObjects/components/scriptEmbed/ScriptEmbeddedFormSurface.tsx`, `app/extensions/ScriptableObjects/lib/scriptEmbedHost.ts`, `app/extensions/ScriptableObjects/lib/embeddedFormLayer.ts`, `app/extensions/ScriptableObjects/lib/embeddedFormUx.ts` |
| **CLOSED 2026-09-04 — M3 review: 17 skeptic-confirmed repairs, and the shape of what they found.** Three lenses over the three M3 slices produced findings that two independent skeptics each had to fail to refute; what survived clustered into four families worth naming, because each is a rule the next on-grid surface will have to obey. (1) **A surface that stops being PAINTED is not a surface that was torn down.** `GridRegion` carries no sheet dimension and Core hands every overlay the whole region list, so an embedded form placed on Sheet1 kept its opaque, click-eating host `<div>` over the same cells on every OTHER sheet; a shape's pointer-claiming shims outlived the shape whenever a control merely lost its overlay region (a sheet switch, an undone create, a failed reload) because every release ran from inside the render pass; and the visibility signal that arms the bound-cell live watch was the React component's MOUNT effect, while the thing that actually hides an embedded surface is a `display: none` that unmounts nothing — so a form scrolled off screen kept reading cells forever. The paint edge, not the React tree, is now what says a surface is on screen. (2) **A placement belongs to the DOCUMENT.** `resetEmbeddedFormPlacements()` had no production caller, so File ▸ Open left workbook A's placements in the module map — and the sweep that ended their sessions did NOT remove them, so the new workbook inherited surfaces. The sweep is deliberately NOT in `hostResetAll`, because that also runs from BEFORE_CLOSE, which is broadcast BEFORE the cancellable "save changes?" prompt — clearing there would delete a user's forms when they cancelled the close. (3) **Every sentence must name a gesture that exists.** All three orphan messages told the user to "drag it onto a cell to put it back" and NO DRAG WAS EVER WIRED; they now read one `EMBEDDED_FORM_ORPHAN_REMEDY` naming the two context-menu items that do exist, and a later repair pinned that the right-click itself still reaches them. Design Mode's dashed outline was `strokeRect` onto the grid canvas underneath an opaque frame — ink nobody could see. (4) **A refusal the caller does not hear is a desync.** The pane facet's `close()` was fire-and-forget and cleared its id unconditionally, so when the host REFUSED to close a surface the USER had placed, the surface stayed and the shim forgot its id — every later `pane.update` went out naming `""`. And one binding defect worth its own line: `openEmbeddedScriptForm` resolved bindings with no sheet, so an embedded form bound to whatever tab happened to be in front rather than the sheet it was placed on. Three repairs found their defect ALREADY closed by an earlier repair in the same round and said so instead of re-fixing it — the honest answer, and the reason the count is 17 findings rather than 17 changes. | `app/extensions/ScriptableObjects/lib/embeddedFormLayer.ts`, `app/extensions/ScriptableObjects/lib/scriptEmbedHost.ts`, `app/extensions/ScriptableObjects/lib/embeddedFormUx.ts`, `app/extensions/ScriptableObjects/components/scriptEmbed/ScriptEmbeddedFormSurface.tsx`, `app/extensions/Controls/Shape/shapeHitRegions.ts`, `app/extensions/Controls/lib/regionPublication.ts`, `app/src/api/scriptHost/embeddedFormPlacements.ts`, `app/src/api/scriptHost/host.ts` (`openEmbeddedScriptForm`), `app/src/api/scriptHost/worker/contextShims.ts` (`paneFacet.close`), `app/src/api/scriptableObjects.ts` (`resetObjectScriptManager`) |
| **M4 — third-party `form` contribution kind. SHIPPED.** An add-in declares its forms by name in the signed sidecar (`contributes.forms`), registers each as a DATA widget tree validated once at registration, and shows one through `ext.formShow` — the same modal slot, show bucket, dismissal mute, deadlines and trusted `FormWidgetTree` an object script's form uses, so `getActiveScriptForm()` reports it and `codeInventory` needed no add-in case. The kind requires **`ui.dialog`** (the screen it takes), NOT a new id: `cap.dialogForm` already gives an add-in that slot, so M4 adds **zero capability ids and zero Rust**. Bound READS ride the existing **`grid.read`**, asked at DELIVERY against ceiling AND live grants (a revoke bites the next show), performed host-side as an audited `sheet.getCellData` under `extension:<id>` — the worker names no cell and `EXTENSION_BROKER_METHODS` gains no read row. Bound WRITES are **refused structurally**, not by prose: no `writeBindings` dep, every bound seed `readOnly` with its own sentence, `writeOn` refused at the wire, no `sheet.*`/`api.*`/`base.*` reachable. Also refused by name at registration, each with its reason: `{name}`, `{control}`, `{sheet}`, a sheet-qualified A1, `options:{range}`, `rows:{range}`, a workbook `media:` image — all still legal for an object script, so the narrowing belongs to the SURFACE. **All four shipped `grid.read` sentences ENUMERATE their paths and all four were stale by omission**; each now names three, and the honesty test asserts the COUNT, not keywords. The write door was designed and deliberately NOT built — the read-only promise is one absolute clause provable by an absent code path, the write promise is five conditional clauses whose truth depends on an address chip continuing to render (see open-items). Sixteen sabotages; three exposed weak assertions (a regex matching "formula" as "form", a loose refusal message satisfied by a different guard, a test that did not isolate `revokeScriptForms`) and one exposed a real defect — unregistering one form closed a DIFFERENT form the user had open mid-answer. | `extensionProtocol.ts` (`EXTENSION_CONTRIBUTION_KINDS`, `CONTRIBUTION_REQUIRED_CAPABILITY`, `CONTRIBUTION_REACH_NOTE`, `EXTENSION_BROKER_METHODS`, `EXTENSION_PUSHED_DATA_CAPABILITIES`), new `extensionFormBindings.ts`, `extensionWorkerHost.ts` (`setupFormRegistration` / `extensionFormDeps` / the three `ext.form*` arms), `worker/extensionWorkerContext.ts` (`ui.forms`; the stale `ui.taskPanes`/`ui.panels` "instead" strings rewritten), `allowlist.ts`, `validators.ts` (`FormValidationSurface`), `protocol.ts`, `broker.ts`, `capabilityIds.ts`, `capabilities.ts`, `scriptSurfaces.ts`, `SubscribeDialog.tsx`, `inspector/ScriptsSection.tsx`, `ScriptableObjects/index.ts`, `InstallAddInDialog.tsx`, `generateObjectContexts.ts`, `docs/examples/addin-tax-tools/*`, new `__tests__/extensionForms.test.ts` |
| **CLOSED 2026-09-04 as M3 pointer ownership — three defects, ONE root cause: Core's pointer entry is an ANCESTOR of every on-grid surface.** `handleMouseDown` is bound to `S.GridArea` (`Spreadsheet.tsx`, `onMouseDown={wrappedMouseDown}`), which is an ancestor of everything the surfaces append into `canvas.parentElement` — so an element stacked over the canvas that stopped `pointerdown`/`click` had claimed NOTHING, and the native `mousedown` bubbled straight past it into the grid. Three coats on one defect: (1) `handleMouseDown` had no `event.button` filter anywhere, so a RIGHT-press reached `handleOverlayMoveMouseDown`, which dispatched `floatingObject:selected` unconditionally, which Controls turns into `button:clicked` — **a right-click RAN the user's macro**; (2) M3b's declared hit rectangle was decorative — the click inside it still selected the shape and opened the properties pane, because `checkOverlayBody` is pure geometry and its target guard spares only INPUT/TEXTAREA/SELECT; (3) a click on an M3c embedded form's widget never focused it — the region publishes no `floating` box, so the press fell to `handleCellMouseDown`, which calls `event.preventDefault()` before its first await (cancelling the browser's focus) and moved the cell selection to the cell UNDER the card; the write landed in the journey only because `locator.fill()` focuses programmatically. Fixed ONCE, as a generic rule in Core (`core/lib/pointerClaims.ts`): **a press whose TARGET has an ancestor carrying `data-pointer-claim` is not the grid's press.** An attribute rather than a registered predicate, for three reasons — its lifetime is the ELEMENT's (Design Mode destroys the shape shims and the claim goes with them; no unregister to leak or fire early), a predicate is asked with COORDINATES which is precisely how `checkOverlayBody` gets this wrong (geometry cannot tell "over the shape's box" from "on the element the script put there", while the browser's hit test already answered it), and this tree already has the cautionary tale — the embedded form layer once registered a `hitTest` Core never asks for, "a claim nothing can honour". Core reads presence only, never the value, which is the claimant's own label. The guard is at the OUTERMOST door, not in `useMouseSelection`: the chain is `wrappedMouseDown` -> `useSpreadsheetSelection.handleMouseDown` (fill handle, cell click interceptors) -> `useMouseSelection.handleMouseDown`, and two of those three `preventDefault()` on paths of their own, so a guard lower down still loses the focus and still fires interceptors. `wrappedMouseDown`'s body moved to `gridPointerEntry.ts` so the shipped door is testable without mounting the grid, and it returns WITHOUT `preventDefault()` — that is the point, not an omission. RIGHT-CLICK IS NEVER CLAIMED, inside the rule: the shape's own menu must open over a fully claimed frame and `EMBEDDED_FORM_ORPHAN_REMEDY` asks the user to right-click the anchor cell the card sits on. Defect 1's filter is at the DISPATCH (`handleOverlayMoveMouseDown` returns `true` on button 2, consuming the press so the cell cursor does not jump, dispatching nothing) because that is the ONLY place a native mousedown becomes `floatingObject:selected` — one dispatch, six listeners; a filter in Controls fixes Controls and is inherited by nobody, and every object with a menu already selects itself from its own capture-phase `contextmenu` listener, since a menu opened with the Menu key has no mousedown at all. BOTH surfaces make the claim and neither is special-cased in Core: `createShim` calls `claimPointer`, and the embedded host's `applyPointerRule` writes `pointer-events` and the claim in ONE call from both `ensureHost` and the paint, so Design Mode suspends both halves together and a host born in Design Mode cannot claim. 34 tests, nine sabotages — including two that pin the halves separately (a filter that stops the macro but stops CONSUMING the press reds only "the cell cursor does not jump"; a guard that `preventDefault`s on its way out reds only the focus assertion), and one that measured the blind spot: removing the shim's claim left **41 of 42** M3b tests green. | `app/src/core/lib/pointerClaims.ts`, `app/src/core/lib/pointerClaims.test.ts`, `app/src/api/pointerClaims.ts`, `app/src/api/index.ts`, `app/src/core/components/Spreadsheet/gridPointerEntry.ts`, `app/src/core/components/Spreadsheet/gridPointerEntry.test.ts`, `app/src/core/components/Spreadsheet/Spreadsheet.tsx`, `app/src/core/hooks/useMouseSelection/layout/overlayMoveHandlers.ts`, `app/src/core/hooks/useMouseSelection/layout/overlayMoveRightPress.test.ts`, `app/extensions/Controls/Shape/shapeHitRegions.ts`, `app/extensions/Controls/__tests__/shapeHitRegions.test.ts`, `app/extensions/ScriptableObjects/lib/embeddedFormLayer.ts`, `app/extensions/ScriptableObjects/__tests__/embeddedFormLayer.test.ts` |
| §2.ab — The keyboard dispatcher ignored pointer claims, so an on-grid form was a data-loss surface. `handleGlobalKeyDown` (`app/src/api/keybindings.ts`) is a CAPTURE-phase `window` keydown — the outermost position there is — so it pre-empted all three of Core's claim-honouring doors and then `preventDefault()`+`stopPropagation()`'d the result, making its answer final. Measured against the real dispatcher and the real `DEFAULT_KEYBINDINGS`, with a card carrying `data-pointer-claim` inside `[data-focus-container="spreadsheet"]`: Delete with a `<select>` or a `<button>` focused executed `core.edit.clearContents` over the user's selected CELLS; **Ctrl+V inside a claimed plain `<input>` executed `core.clipboard.paste` AND cancelled the native paste into the field**, so even the widget type Core's own tag list certifies as working was broken; Ctrl+Z ran `core.edit.undo`. Both questions it asks were wrong — `isGridFocused()` reads an attribute that sits on the container EVERY on-grid card lives inside, and `isEditing()` is the same tag list whose incompleteness caused the Core defect. FIXED by folding the claim into those two questions rather than adding a third gate in front of them, so a binding is classified by its OWN declared metadata: a claim makes a keystroke not-grid-focused (GRID_SCOPED_COMMANDS refused — and refused BEFORE `matches` is populated, which is why no `preventDefault` runs and the native paste into the field survives) and editing-EQUIVALENT (`context: "not-editing"` refused, so the claimant owns its own undo), while a truly global binding (`context "always"` and not grid-scoped) still fires — Ctrl+S saves from inside a form, the positive control that stops an over-broad guard. CENSUS: all 194 `window`/`document` key/pointer listener sites across core, api, shell and extensions are now enumerated in `app/src/core/lib/globalInputListeners.ts`, beside the rule — 15 claim-guarded, 10 app-global, 5 right-press-exempt, 157 session-scoped, 7 observers — and twelve previously unguarded extension handlers that act on the grid or the document were guarded (Charts and Controls delete, Controls Ctrl+C/V/D/G, FloatingRange, Grouping keys AND its client-point outline-bar press, AutoFilter, FlashFill, CellBookmarks, DataValidation, Hyperlinks, Review, SelectVisibleCells, Slicer/TimelineSlicer wheel). `globalInputListeners.test.ts` re-derives the list from the source tree and fails on drift in EITHER direction, and fails when a claim-guarded file stops referencing a claim predicate — so a new global listener must add a row, and a silently removed guard cannot ship. 23 new tests, seven sabotages (each redding the assertion it was aimed at, and only that one); check-types, lint:boundaries and check:line-endings clean. | see the row text |
| **PROVEN LIVE 2026-09-04 — M3 and M4 on the running app**: `app/e2e/journeys/on-grid-forms.spec.ts` 4/4, and 22/22 across the whole forms family (modal, distributed `.calp`, task pane, on-grid). Writing that journey is what FOUND the pointer-ownership defects: its author traced two, its reviewer traced a third, and all three shipped as deliberately-RED assertions that the fix then turned green — which is the strongest form this project has for "the fix is real". Two lessons worth keeping. **A live proof finds what a unit test structurally cannot**: every one of those defects was a disagreement between a DOM stacking order and a handler's binding point, and nothing below a browser has either. **And the same race keeps being written**: an on-grid surface PAINTS on the request event but only enters the registry when the renderer acknowledges it, so a bare read of `listScriptPanes` right after `toBeVisible` passes alone and fails in a full run — test 3 polled for it, test 4 did not, and test 4 is the one that went red at 2.4 s in the combined journey run. Poll the registry, never read it once. | `app/e2e/journeys/on-grid-forms.spec.ts`, `app/e2e/journeys/script-pane.spec.ts`, `app/e2e/journeys/script-form.spec.ts`, `app/e2e/journeys/script-form-distributed.spec.ts` |
| **M5a SHIPPED 2026-09-04 — the designer's AST reader/writer, the whole risk of M5 in one module.** `app/src/api/formDesigner/` reads the scaffold's `// #region Form layout …` block into a `FormSpec` and writes an edited one back, under ONE ARTIFACT: no layout JSON, no designer state the code does not determine. **The locator is a parse, not a search** — every comment RANGE is walked off the AST and a marker counts only when the compiler agrees it is a single-line comment whose body STARTS with the label, so `const HELP = "// #region Form layout"` and `/* // #region Form layout */` are both ignored; nesting is depth-counted, so the block ends at the `#endregion` that returns depth to zero. **The region must hold exactly one statement**, the `form.define(...)` call, and nodes inside it must be in STATEMENT position — because the writer re-emits the whole block, so opening one it could not put back is how a designer deletes a user's code; a marker dropped inside an expression is `region-cuts-code`, not a guess. **Exact or nothing** in the literal: string / number / boolean / null / array / object, plus parens, a signed numeric literal, a no-substitution template and `undefined` (which IS absence, and is what `form.define` already receives); a spread, a computed key, a variable reference, a call, a template with substitutions, a function, an `as const` or a duplicate key is an `unrepresentable` refusal that NAMES the construct in the user's vocabulary, quotes their code and gives the line — the caller opens the code editor, so the refusal is the whole user experience. The parsed value then goes through the real `checkFormSpec`, and a second `form.define` OUTSIDE the region is counted (`definesOutsideRegion`), not refused. **The writer has four rules, each a refusal rather than a convention:** (1) it will not write what it could not read; (2) NO EDIT, NO BYTES — a spec structurally equal to the one in the file returns the source unchanged, which is what makes the scaffold round-trip byte-for-byte without the emitter having to reproduce the author's hand-alignment; (3) comments between the markers are LOST on a re-emit, so the write is REFUSED until the caller passes `acknowledgeCommentLoss` (`describeCommentLoss` supplies the sentence and the line numbers) — a FormSpec carries no provenance back to the nodes it was read from, so preserving them is not achievable in this slice and saying so is structural instead of a doc note; (4) it re-reads its own output and must get a deep-equal spec with prefix and suffix bytes identical, or the ORIGINAL source is returned untouched. The replaced span is the two marker comments and everything between them, so the `// @capability` pragmas, the trailing newline, the callee spelling and both marker labels survive verbatim; EOL (CRLF stays CRLF) and indent step (tabs or the smallest positive width gap) are measured from the file. **One compiler, one chunk:** `loadCompiler` in `scriptTranspile.ts` is exported as `loadScriptTypeScript` and a source-reading test proves no file under `formDesigner/` adds a second `import("typescript")`. 46 tests fixtured on the REAL `getScaffoldTemplate("form", …)`; 15 sabotages, each redding the assertion it was aimed at and only that one. One of them exposed a HARNESS lie worth keeping: vitest's `-t` is a regex and exits 0 selecting nothing, so a test named `adds no second import("typescript")` reported "no teeth" while never having run — the name is now metacharacter-free and the harness asserts one test executed. check-types, lint:boundaries, check:line-endings and eslint clean. STILL OPEN for M5b: `LiveModulePersister` integration, `useDragDrop`, the UI, and surfacing `definesOutsideRegion` as a warning. | `app/src/api/formDesigner/formRegion.ts` (`locateFormRegion`, `collectCommentRanges`, `detectEol`, `detectIndentUnit`), `formLiteral.ts` (`readObjectLiteral`, `describeKind`), `readFormRegion.ts` (`readFormRegion`, `nodesInside`), `writeFormRegion.ts` (`writeFormRegion`, `describeCommentLoss`, `sameFormSpec`), `formEmit.ts` (`emitDefineStatement`), `types.ts` (`FormDesignerRefusalCode`), `app/src/api/scriptTranspile.ts` (`loadScriptTypeScript`), `app/src/api/formDesigner/__tests__/formDesignerAst.test.ts` |
| **CLOSED 2026-09-04: M5b — the visual designer itself, on the M5a AST reader/writer.** A palette, a canvas and a property panel under `components/formDesigner/`, entered from a **Design form** toolbar action. ONE ARTIFACT is mechanical, not a promise: the panel holds NO layout — its whole state is a SELECTION path, an OPEN-CONTAINER path and one acknowledgement boolean. Every edit builds a new `FormSpec` from the spec the reader just returned, hands it to `writeFormRegion`, and puts the resulting SOURCE into the editor buffer; the hook then RE-READS that buffer and draws what came back, so a hand edit in the code tab is picked up the instant the designer looks and a designer edit is visible in the code tab because it IS the code tab's text. It costs one parse per edit and buys the only property the milestone rests on. **Monaco stays MOUNTED behind `display:none`** rather than being swapped out: unmounting disposes the model, the undo stack and the breakpoints, and keeping it lets the write go through `executeEdits` — so a drag lands on the code editor's undo stack and Ctrl+Z takes back a drop. There is no save call anywhere under `formDesigner/` and a source-reading test asserts there never is. **The canvas paints through the SHARED `FormWidgetTree`** (still one definition, `scriptPaneSharedTree.test.ts` unchanged), one container at a time with a breadcrumb and a tabs page strip, controls `locked` and `pointer-events: none` — a designer whose click lands in the text box instead of selecting the widget cannot be used at all. Per-container selection was chosen over overlaying invisible hit shims on the painted tree, which has to guess geometry the layout owns and is wrong the first time a widget wraps. **The drag is the shared gesture**: `_shared/components/useDragDrop.ts` gained an ADDITIVE generic channel (`useDragPayload`/`useDropTarget`/`useDragPayloadState`) sharing the same drag state, the same floating preview and the SAME two document listeners — no new row in `globalInputListeners.ts`, the pivot's four-zone `DragField` channel untouched, because putting a widget kind into `sourceIndex`/`isNumeric` would be a lie in a shared type. **The property panel is driven by the spec's own key table**: `FORM_WIDGET_KEYS` and `FORM_SPEC_KEYS` moved out of `validators.ts` into the `scriptFormSpec.ts` leaf (behaviour-neutral; the validator imports them), so the panel can never offer a key `checkFormSpec` would refuse and a key added to the spec cannot be silently unreachable — `editorFor` answers `null` for a key it has no editor for and a test asserts that never happens for any type. A value the panel cannot round-trip (`bind: { cell, sheet }`, `options: { range }`) is shown DISABLED with the sentence, never flattened to the nearest string the control can hold. Clearing an optional field REMOVES the key; text rows commit on blur/Enter, never per keystroke. **Three things stop an edit and each says so**: an UNREPRESENTABLE read draws no canvas at all — the reader's sentence, the offending code quoted, one offer (the code editor); COMMENTS in the region block every edit until the user accepts that a re-emit deletes them (M5a's hand-off requirement, now satisfied); a read-only script is drawn and never written. A second `define(...)` outside the region — reported by M5a and consumed by nobody — is now a non-blocking warning that the layout being edited may not be the one the form shows. **Keyboard parity throughout**: every palette entry is a real focusable `<button>` that adds its widget, the canvas is a `role="listbox"` with roving tabindex and `aria-selected`, arrows select, Ctrl+arrows reorder, Enter descends, Escape ascends, Delete removes. 41 tests in two files against a REAL `LiveModulePersister` (a `vi.fn()` would prove a call was made; `storedSource` proves the bytes a Run would execute), 19 sabotages each redding the assertion it was aimed at — two of them one step upstream, recorded as such. Still open for M5: comments are warned about but not preserved, and there is no live journey — jsdom has no layout, so the two drop tests stub the card geometry and the browser's own hit testing during a drag is untested. | `app/extensions/ScriptableObjects/components/formDesigner/` (FormDesignerPanel.tsx, DesignerCanvas.tsx, DesignerPalette.tsx, DesignerProperties.tsx, useFormDesignerDocument.ts, designerModel.ts, widgetPalette.ts, propertyFields.ts, designerDrag.ts, designerStyles.ts), `app/extensions/ScriptableObjects/components/ObjectScriptEditorApp.tsx` (`designing`, `handleDesignerSource`, the Design form action), `app/extensions/_shared/components/useDragDrop.ts` (`useDragPayload`, `useDropTarget`, `useDragPayloadState`), `app/src/api/scriptHost/scriptFormSpec.ts` (`FORM_WIDGET_KEYS`, `FORM_SPEC_KEYS`), `app/src/api/scriptHost/validators.ts` (`checkFormWidget`, `checkFormSpec`), `app/extensions/ScriptableObjects/__tests__/formDesignerModel.test.ts`, `app/extensions/ScriptableObjects/__tests__/formDesignerPanel.test.tsx` |
| **CLOSED 2026-09-04 — M5 review: ten skeptic-confirmed repairs, and every one was the designer touching the user's own bytes.** The milestone's whole risk is that a visual editor rewrites a file a person wrote, so it is worth naming what the review actually caught. **Three were the AST reader mis-reading trivia.** `collectCommentRanges` enumerated `getLeadingCommentRanges` alone — and TypeScript's leading scan starts with `collecting = false` until it passes a line break, so an END-OF-LINE comment is trailing trivia of the token before it and was INVISIBLE to the comment-loss gate: the one guard whose entire job is "tell the user before their comments are destroyed" could not see the commonest kind of comment. `detectIndentUnit` measured every line's leading-whitespace width including the ` * ` continuation lines of a JSDoc block, whose width is 1 — so a documented script had its whole layout block reprinted at one space per level. And `propertyKey` handed back `__proto__` as an ordinary key, which is a prototype write rather than a property. **Four were the property panel lying about a value.** A progress bar's `max` was routed to the date-shaped text editor (one folded `min`/`max` case splitting on `type === "number"` alone), so an existing numeric `max` rendered as uneditable and a typed one was refused with a banner blaming the user; a draft the designer ITSELF refused was reverted in SILENCE — the one class of edit where it knows exactly which limit was exceeded was the one class that said nothing; and a draft typed for one widget was committed to whichever widget was selected when the field was left, because the rows were keyed by field name with no widget identity. **Two were gestures that could not be made:** an existing widget could never be moved INTO a container (one drop target existed, keyed to the open container, so source and destination were the same list by construction), and the roving-focus effect guarded on the inner wrapper while the focusable element is its parent, so `Node.contains` answered false and keyboard focus never landed. | `app/src/api/formDesigner/formRegion.ts` (`collectCommentRanges`, `detectIndentUnit`), `app/src/api/formDesigner/formLiteral.ts` (`propertyKey`), `app/extensions/ScriptableObjects/components/formDesigner/propertyFields.ts` (`editorFor`), `DesignerProperties.tsx` (`CommittedInput`, `ParseResult`), `DesignerCanvas.tsx` (the container drop target, the focus effect) |
| **M6b SHIPPED 2026-09-05: the bridge is ONE module, the input half of `ui.html` is its own consent id, and the frame now has a budget — but `{ type: "html" }` STAYS REFUSED, because M6a's verdict is binding.** The srcdoc bridge, the postMessage protocol, the `e.source` identity check and the reserved-type handling were duplicated byte-for-byte in `shapeRenderer.ts` and `CustomControlHost.tsx` (declared in the latter's header, pinned only by a byte comparison); they are now `extensions/_shared/scriptFrame/`, and neither host builds a document any more. `srcdocBridgeCsp.test.ts` was REWIRED rather than deleted, as its own note asked: it reads the bridge from the one module and the byte-identity assertion is replaced by "neither host builds a `<script>` block of its own". **`render.setHitRegions` moved off `ui.html` onto a new `ui.htmlInput`.** `ui.html` promises "render sandboxed HTML inside the object's shape" in four user-facing sentences and not one says the frame can TAKE anything — yet a claimed rectangle is pointer input removed from the grid, where the user's click stops selecting a cell and reaches a distributed author's page. Same split, same reasoning, as `ui.pane` out of `ui.dialog`. Full lockstep: last in `ALL_CAPABILITY_IDS`, `CAP_DESCRIPTION`, all eight `Record<CapabilityId,string>` maps, the four author-declared surface rows + `chart-mark` + `BROKER_AUTO_LOCAL_CAPABILITIES`, the broker's local auto-grant AND auto-declare (so the split makes the DISTRIBUTED consent honest without re-asking the user about their own code), Rust `KNOWN_CAPABILITY_IDS` 17 -> 18, asserted NON-grantable in `capability_store.rs` (the shims are host DOM; Rust never sees a pointer event). The frame also gained a curated 8-name `--calcula-*` theme contract (sanitized AT THE BUILDER, because a skin is contributable and `red; } * { } </style><script>` is a token value), size negotiation over a reserved `calcula.` namespace the router consumes and never forwards to the script, a live-frame cap of 24 and a 16 MB aggregate document watchdog shared across both hosts (claims idempotent per instanceId so they are safe from a render loop, released on removal/dispose/unmount, and MIGRATED on a structural re-key — otherwise the old charge leaks while the new id goes uncounted, both at once), and the media rule in `vHtml`: a `data:` URI is refused with a sentence naming the rule, keyed on the SCHEME and never on the word "base64" (the BUG-0099 bypass), because a script's HTML lives in its SOURCE and its source ships inside a signed `.calp`. Seven sabotages, one per assertion group, each reverted and re-verified — including one that produced a syntax error instead of a behaviour change and was discarded. | `app/extensions/_shared/scriptFrame/frameDocument.ts`, `frameBridge.ts`, `app/extensions/Controls/Shape/shapeRenderer.ts:42-58,246-256,284-311`, `app/extensions/ControlsPane/components/CustomControlHost.tsx:1-27,374-392,424-437,845-880`, `app/src/api/scriptHost/capabilityIds.ts:46-86,251-259`, `app/src/api/scriptHost/allowlist.ts:125-140`, `app/src/api/scriptHost/broker.ts:132-160`, `app/src/api/scriptHost/validators.ts:226-286`, `app/src/api/scriptSurfaces.ts:83-90`, `core/persistence/src/lib.rs:1705,1738-1749`, `app/src-tauri/src/scripting/capability_store.rs:454-461`, `app/extensions/_shared/scriptFrame/__tests__/scriptFrame.test.ts`, `app/src/api/scriptHost/__tests__/htmlInputConsentHonesty.test.ts`, `app/extensions/Controls/__tests__/srcdocBridgeCsp.test.ts` | | **OPEN — `{ type: "html" }` is still refused, and stays refused until the frame can be delivered from somewhere with its own CSP.** M6a measured the collision and M6b built everything that does not depend on the bridge EXECUTING, deliberately stopping at the line the milestone exists to defend. What remains is M6a's own sequence, in order: (1) run `app/e2e/tests/csp-srcdoc-bridge.spec.ts` — now re-pointed at the shared builder — against a BUNDLED build and record the matrix; (2) close the dev-CSP blind spot, which is independent of M6 and larger than it (the obvious fix is a `transformIndexHtml` at order `post` that sha256-hashes whatever Vite and `@vitejs/plugin-react` injected and head-prepends a `<meta>` carrying the policy READ from `tauri.conf.json`, never retyped — it is risky precisely because the react-refresh preamble is an inline module script, so it needs someone who can launch the app); (3) then the Rust custom URI scheme, whose `frame-src` widening and window-guard interaction still need their own check. Also still open from M6b itself: `media:{sha256}` RESOLUTION (only the refusal half shipped, so a script cannot yet SHOW a document image in its frame — the builder is synchronous and the media read is an async backend call); the per-frame `MessageChannel` (a port must be transferred INTO the frame and picked up by the frame's own script, i.e. the half that cannot run — the `e.source` check is kept and is now tested in both directions); the product-path e2e (a real shape, a real shim, a real click reaching `onMessage`), deliberately not written blind because its failures could not be told apart from a CSP verdict; and theme tokens being build-time only, so a skin change does not repaint a live frame until its content next changes. | `app/src/api/scriptHost/scriptFormSpec.ts` `FORM_WIDGET_TYPES`, `app/src/api/scriptHost/validators.ts` `checkFormWidget`, `app/e2e/tests/csp-srcdoc-bridge.spec.ts`, `app/src-tauri/tauri.conf.json:26-27`, `app/vite.config.ts`, `app/index.html`, `app/extensions/_shared/scriptFrame/frameDocument.ts` (header), `app/extensions/_shared/scriptFrame/frameBridge.ts` (header) |
| **M6a, 2026-09-05 — the measurement that changed the milestone: `tauri dev` on Windows desktop enforces NO CSP AT ALL, so the entire E2E suite has always run unprotected.** M6's first phase was told to build nothing and settle one question with evidence: does the inline `<script>` bridge injected into the `ui.html` srcdoc frame actually execute? Read from the pinned tauri 2.9.5 source on this machine rather than from memory: the ONLY code that attaches a `Content-Security-Policy` header is the `tauri://` asset protocol, which serves the main document only when the webview points at it — and in dev the webview points straight at `devUrl`, because the dev-server proxy is compiled out on desktop (`PROXY_DEV_SERVER = cfg!(all(dev, mobile))`). Vite sends no CSP header and `index.html` carries no CSP `<meta>`. **So `devCsp` is dead text on this platform**, and every E2E run this project has ever done ran with inline script allowed. The conclusion that follows is that the shipped bridge almost certainly does NOT run in a bundled build (`script-src 'self' blob:` has no `'unsafe-inline'`, no nonce, no hash, and a srcdoc child inherits its embedder's policy container) — and there is no nonce-shaped fix, because the shipped "Interactive Counter" template and the default custom-pane scaffold drive the bridge from inline `onclick=` ATTRIBUTES, which a nonce cannot rescue even in principle. Three independent reasons nobody noticed: dev has no CSP, four of the five shipped templates are display-only so a blocked script still PAINTS perfectly, and a dead bridge is completely silent (an inbound message has no audit row, no counter and no error path). **Because the verdict is binding, `{ type: "html" }` STAYS REFUSED** — the milestone shipped the foundation and refused the feature, which is the honest order. The measurement itself is `e2e/tests/csp-srcdoc-bridge.spec.ts` in a new `platform` project, `testIgnore`d out of the functional suite: it must not sit in a sweep that launches `tauri dev`, both because it would be permanently red for a cause nobody can act on, and because a permanent red is how a suite acquires a known-failures list — after which the day somebody adds `'unsafe-inline'` and it turns green for the WRONG reason goes unnoticed. It keys its skip on WHERE the document is served from, never on whether a policy was observed, because a gate that skipped when no policy was seen would silence exactly the regression its first assertion exists to catch. | `app/e2e/tests/csp-srcdoc-bridge.spec.ts`, `app/e2e/helpers/buildFlavor.ts`, `app/playwright.config.ts` (the `platform` project), `app/extensions/Controls/__tests__/srcdocBridgeCsp.test.ts`, `app/src-tauri/tauri.conf.json` |
| **CLOSED 2026-09-05 — M6 review: 13 skeptic-confirmed repairs, clustering into three lessons.** **(1) A refusal that paints nothing is worse than the thing it refused.** A frame-budget refusal returned `void`, so an on-grid `ui.html` shape painted NOTHING and said nothing — an invisible but still selectable hole in the grid — and the budget itself charged for parked frames, never reset per document, and had no pane-side document listener at all, so opening a second workbook could exhaust it permanently. **(2) A validator that reads the raw argument is not reading what the parser will.** `vHtml`'s `data:` refusal was tested against the string the script passed, while the frame's parsers entity-decode, CSS-unescape and strip tabs and newlines FIRST — seven spellings (`&#100;ata:`, `&#x64;ata:`, `data&colon;`, …) were admitted by the validator and every one resolved to a real `data:` URI through `img.src`. That is BUG-0099's shape exactly, one layer down: the fix is to key on what the CONSUMER will see, never on a spelling. The same scan, unanchored, also refused a KPI tile whose own label read "Social media: 42%". **(3) A protocol spelled four times against a constant whose docstring claims it is spelled once is not one protocol** — and an id migration that moves a map entry without moving its CHARGE poisons the total under a key that no longer names it, unrecoverably. One finding could not be adjudicated: a skeptic agent hit an API safeguard error mid-verification, so that finding stands at one vote and was NOT actioned — recorded here because "not confirmed" and "not looked at" are different states. | `app/extensions/_shared/scriptFrame/frameBridge.ts`, `frameDocument.ts`, `app/extensions/Controls/Shape/shapeRenderer.ts`, `app/extensions/ControlsPane/components/CustomControlHost.tsx`, `app/src/api/scriptHost/validators.ts` (`vHtml`, `MEDIA_REFERENCE_RE`) |
| **MEASURED 2026-09-05, against a real bundled build — M6a is now FACT, not inference, and it names a live product defect.** The proof phase reasoned that the `ui.html` bridge could not run under the shipped CSP; the spec it wrote was then run the only way that can settle it: `npx tauri build --no-bundle` (release, 20m46s — which also proves the app LINKS, something CI never does), rebuilt with `src-tauri/tauri.e2e.conf.json` (that overlay changes ONLY `withGlobalTauri`, so the policy under test is the shipped one), launched with remote debugging, and driven with `E2E_MANUAL=1 playwright test --project=platform`. The document really was served from `http://tauri.localhost/` — so the spec ran rather than skipping, which is its precondition — and the result was: **`violations: ["script-src-elem blocked inline"]`, `window.calcula` never exists, and a real click inside the frame reached the host through nothing.** Two consequences to act on. First, `{ type: "html" }` staying refused is now justified by a measurement instead of an argument. Second — and this is a defect that predates the milestone — **every shipped `ui.html` template that calls `calcula.sendMessage` is INERT in production today**: the "Interactive Counter" template and the default custom-pane scaffold both drive the bridge from inline `onclick=` attributes, which paint perfectly and do nothing, in a build no developer sees because `tauri dev` enforces no CSP. Worth noting how close this came to never being found: the first attempt launched a plain release build and the harness's startup barrier refused the run — correctly, naming `withGlobalTauri` as the cause rather than reporting N product failures. A harness that had guessed would have produced a page of red and hidden the one real answer. | `app/e2e/tests/csp-srcdoc-bridge.spec.ts`, `app/extensions/Controls/Shape/shapeTemplateCatalog.ts` (the Interactive Counter), `app/extensions/ControlsPane/components/CustomControlHost.tsx` (the default scaffold), `app/src-tauri/tauri.conf.json` |

---

### 2.AI — the AI programme, opened 2026-09-07

Built this session: the offline formula grader and its 97-task corpus, the formula assistant
(`app/extensions/FormulaAssist/`), the strategy layer
(`app/src-tauri/src/insights/strategy/`), the insights engine (`core/insights/` plus
`app/src-tauri/src/insights/`), the Insights pane, the Strategy tab, and the two MCP analysis
tools. Design records: `docs/design/formula-assist.md`, `docs/design/insights-strategy-layer.md`.

**2.AI.1 — The formula assistant does not meet its own exit criterion, and the gap is the model.**
The target was ≥ 90 % verified-correct at ≤ 3 s. Measured on `qwen2.5-coder:1.5b` over 97 tasks:
**37 % at a 7 s median**. Nothing here is unsafe — the engine verifies every proposal before it is
shown, so a wrong formula is never badged as correct — but the feature is often unhelpful. The
levers the measurement points at, in order: grammar-constrained decoding (the llama.cpp server has
it, Ollama's OpenAI endpoint does not), a larger local model, or a cloud provider. More prompt
engineering is NOT one of them: retrieval already earns its tokens (`p = 0.0005`), context does
not (`p = 0.375`), a repair round does not (`p = 1.0`, and it returned a byte-identical formula 30
times in 38), and bounding the schema fields bought all of the latency and none of the accuracy.
Re-run with `node tests/eval/run-formula-eval.mjs --provider ollama --model <m>` before deciding.

**2.AI.2 — Multi-hop decomposition is refused, and the strategy layer reports it rather than
hiding it.** `ModelFacts::directly_related_tables` bounds an analysis dimension to a table one
relationship from the measure's fact table, because the query executor refuses longer paths
(`engine-query/src/executor/pipeline/local_aggregation.rs:1923`, `detail.rs:565`,
`pushdown/security.rs:205`). A snowflaked attribute produces an `unreachable-in-v1` warning from
the validator and a note in the bundle. Making the executor traverse is an engine project with a
fan-out guard at every hop; it is not scheduled.

**2.AI.3 — Column statistics do not exist, so role inference uses declared metadata only.** The BI
engine stores no cardinality, and learning that `Customer[Email]` has a million distinct values
means one grouped query per column — which inference must not do, since it runs on every model
open. Roles come from relationship participation, data type, `is_hidden`, `sort_by_column` and
name patterns, every entry is written `reviewed: false`, and a person confirms them in the
Strategy tab where the data is visible. Host-side Arrow statistics over the cached batch are the
planned fix and are not built.

**2.AI.4 — Engine gaps the formula corpus surfaced, unfiled.** The library half of the corpus
disagrees with `functions/*.md` on: `TEXTBEFORE` returning `#N/A` where the doc expects a string,
`XLOOKUP` with a 2-D lookup array, `TBILLPRICE` returning `#VALUE!`, and `ODDFPRICE`/`ODDFYIELD`/
`ODDLPRICE`/`ODDLYIELD` returning `#NUM!`. Each needs a reproduction against the documented
example before it is a ledger entry rather than a corpus expectation; none has one yet.

**2.AI.6 — What the 2026-09-08 Strategy-editor review found, and what is left.** The review raised
eight points about the authoring surface. Six were UI defects and are fixed; two were questions
whose answers changed the design.

CLOSED: the `inferred` badge on a row with no values (it now reads "not set" with Confirm
disabled, and a row the user typed reads "set by you"); the blank form (the tab drafts from the
BACKEND inferrer on first open); undifferentiated column rows (ordered by role, `ignore` behind a
disclosure that names the count); `aggregation` as a flat enum (a per-dimension editor, and the
silent destruction of `byDimension` on every dropdown change is gone); `neverSliceBy` absent from
the tab (present everywhere else, so the CLI was the only way to set it); and the two draft
generators that disagreed — the weak TypeScript one is DELETED and both the tab and the CLI now
call the Rust op.

STILL OPEN, and each needs a decision rather than work:
* **PER-COLUMN DISTINCT COUNTS ARE THE BINDING CONSTRAINT, and the whole layer's usefulness is
  coupled to them.** This was filed below as one gap among several; it is not. Reviewed
  2026-09-08:
  - `INFER_ANALYSIS_DIMENSIONS` (`strategy/infer.rs`) is `false`, and its recorded flip-back
    condition is verbatim *"FLIP IT BACK TO `true` WHEN PER-COLUMN DISTINCT COUNTS EXIST."* So
    while there are none, **every measure of every model needs its decomposition hand-authored** —
    and authoring effort was always the binding constraint on this layer. The cost analysis that
    recommended deferring statistics did not surface that coupling; it should have.
  - The stand-in is a NAME LEXICON, and a name lexicon generalises exactly as far as its naming
    conventions do. Two heuristics share one defect: `words()` cannot split an all-lowercase
    concatenated token, so on an imported schema spelled `emailaddress` / `fullname` neither
    `is_one_per_row_shaped` nor `label_score` fires — the address is offered as a breakdown axis
    and the table gets no label column at all. It is also English-plus-Swedish only.
  - A `Decimal` column that is really an axis on `dim_product` still infers as `ignore` for the
    same missing signal. A person can set the role by hand, which is the honest fallback.
  Cardinality is the one signal that is convention-independent and language-independent. Treat
  this as the item that unblocks the others, not as a peer of them.

  **THE LEXICON AND CARDINALITY FAIL IN OPPOSITE DIRECTIONS, AND NEITHER IS A STOPGAP FOR THE
  OTHER.** This is the strongest argument for the item and it is not in the original A2 analysis.
  Established 2026-09-08 from the two halves of the label-classifier fix:
  - **Only the lexicon can demote `firstname`.** Cardinality cannot: roughly 500 distinct first
    names across 10,000 customers is a textbook axis to a distinct count, and it would be
    dictionary-encoded too. The signal that says "this is a fragment of a person's name" is in the
    WORD, nowhere else.
  - **Only cardinality can rescue `CategoryName`.** The lexicon cannot: it is name-like by
    construction, so ANY name classifier demotes it. That demotion is the measured price of the
    fix (`a_denormalised_name_that_really_is_an_axis_is_demoted_too_and_the_harness_says_so`,
    `strategy/calibration_tests.rs`).
  So the two signals are not redundant and not ranked — each is REQUIRED for a case the other gets
  wrong, and only the combination gets both right. Anything that treats the lexicon as a temporary
  stand-in "until statistics arrive" has the relationship wrong: statistics do not retire the
  lexicon, and the lexicon never covered what statistics do.
  **And the false-demote is the common case, not the exotic one.** A denormalised `<Thing> Name`
  column beside its key is exactly what a flat CSV or a wide SQL view produces, and those are
  ordinary import paths here (the CSV/Parquet/InMemory connectors are named two paragraphs below).
  A star schema hand-built in the Model Editor is the case the lexicon was tested against; an
  imported wide table is the case it will actually meet.

  **HOW TO BUILD IT, and a reversal.** An earlier costing here concluded distinct-count was
  unaffordable on DirectQuery. That was an artefact of the entry point measured, not of the layer.
  `distinct_members` (`bi/cube.rs`) builds a `QueryRequest`, which REQUIRES a measure, so on a
  dimension column it joins to the fact table — fact-scale, and twelve columns is twelve
  serialised round trips. The connector layer has a measure-free path:
  `Connector::fetch_data(&FetchRequest)`, with `AggregateFunction::CountDistinct` rendering as
  `COUNT(DISTINCT "c") AS "n"`. Twelve columns become **one statement, one round trip, one lock
  acquisition, dimension-scale**. The target resolves through `SourceRegistry::binding_for` with no
  fact table involved. There is no host command for it yet — this is roughly forty new lines, not a
  reuse.
  - Guard it on connector capability. CSV/Parquet/InMemory connectors IGNORE aggregates and return
    the whole table, so column 0 would be read as a count — a silently wrong number. Those tables
    are resident anyway and the count comes from `engine.cache()` with no query at all.
  - **Do NOT lean on Arrow dictionary encoding as a cardinality proxy, in either direction.** It
    looked like a free signal and is not: the uniqueness ratio is computed over a PREFIX of at most
    `string_sample_size` = 8192 rows, so for any larger table "50% unique" degenerates into "more
    than 4096 distinct values in the first 8192 rows" — an effective threshold of 0.04% on a
    10M-row table. A 5,000-store `store_code` column is left un-encoded despite being a textbook
    axis, and a join-key-correlated column can be encoded while being globally high-cardinality.
    Two further holes: `disk_cache.rs` restores an IPC file without re-optimising, and
    `dictionary_encode_strings: false` is settable at runtime through the public
    `Engine::set_optimizer_config`. Encoded means "low-cardinality in the first 8192 rows", which
    is not the question being asked.
* **`date_role` is not authorable from Calcula.** No host command, no CLI option, no column-form
  field, so the "read what the author declared" arm only ever fires for a model imported from
  elsewhere. Exposing it is a small host-only change and is not done.
* **The CLI cannot set `aggregation` at all.** `modelOptions.ts` has `analysisdims` and
  `neverslice` but no `aggregation` key, so the field that decides whether the engine may claim a
  share of a total is settable only from the tab and the inferrer.
* **Audience overlays** are designed (`docs/design/insights-strategy-layer.md` §11) and
  deliberately not built. Perspectives supply the name list; the mechanism is a sibling of `Scope`,
  not a member of it, because a `Scope` key is a validated `QualifiedColumn` and `audience` cannot
  be spelled as one. Three preconditions block it, the sharpest being that perspectives FAIL OPEN —
  an unknown name filters nothing, which is right for hiding fields and wrong for judging
  favourability.

**2.AI.7 — What the fourth Strategy review closed, and the three things it exposed.** The review
raised four items — a `targetBand` direction settable with no band, irreversible confirmation, the
label score used as a classifier, and a Model panel with no provenance. All four are fixed
(2026-09-08). What is worth recording is what the *general rule* it asked for turned up.

The rule adopted: **any enum value that requires a companion field must be either unsettable
without it or invalid with it, never quietly accepted.** A sweep of every enum-valued field in the
strategy document found nine cases genuinely accepted in silence; eight are now errors
(`target-band-without-band` at both the measure entry AND a rule's `set.direction`, `empty-band`,
`unresolvable-target-kpi`, `unknown-fact-kind`, `semi-additive-without-dimension`,
`test-needs-value`, `test-needs-baseline`, plus `unknown-measure` unified across its two sites).
Three findings outlive it:

* **Five strategy attributes were authored, inferred, validated, resolved — and READ BY NOTHING,
  and ONE of them was not harmless.** Verified 2026-09-08 by grepping the consumers, not the
  writers. The split matters and the first filing here did not make it:
  - **`TableStrategy.kind` was the high-consequence one, and is FIXED (see below).** It gates the
    whole time-series cascade — calendar detection, `defaultTimeAxis`, the calendar arm of the role
    ladder — and renders as an editable dropdown on EVERY table row. `classify_table`
    (`strategy/facts.rs:291`) derived kind from the model's `date_table` plus relationship sides,
    and `infer_table` (`strategy/infer.rs:624`) read `facts.tables[..].kind`; the document's own
    field had no reader. So the `calendar` shown against a date table was a DISPLAY of a decision
    made elsewhere, and a user who saw detection get it wrong and corrected it changed nothing,
    silently. That is a different class from a field that merely does nothing: it is a control that
    invites a correction and discards it.
    **And the round trip was completely convincing**, which is what made it invisible.
    `infer_table` stamps the DETECTED kind into the drafted document, and the tab's cell renders
    `entry.kind` from that document (`strategy/TablesGrid.tsx:358-364`, a `selectOf<TableKind>` on
    every table row — the cell moved out of `StrategySection.tsx` when that 4,681-line file was
    split into `sections/strategy/`; the CLAIM is unchanged and still describes a fixed defect).
    So the dropdown showed a plausible value, accepted a change, saved it, and
    read it back changed — while every consumer went on using `facts.tables[..].kind`, derived
    afresh from the model. A control that resets would have reported itself in one click.
  - **The remaining four were inert, and each was then wired, labelled or DELETED.**
    `model.reporting_currency` is **gone** — no consumer and none coming, and typing it had only
    made it a *stricter* inert field; deleting is the cheaper reversal, since re-adding a field once
    a formatter exists costs less than carrying one nobody uses. `ResolvedMeasure.unit` and
    `ResolvedMeasure.cadence` are **kept and labelled**, because unlike the currency both have a
    designed reader written down: `unit` the moment narration formats a value ("rose by 12" vs
    "12%" vs "12,000 SEK" are different sentences), `cadence` for period bucketing and seasonality
    lag selection (plan §6.4/§6.5). They now carry the not-yet-consulted mark on the measures
    grid's COLUMN HEADER — once, rather than one sentence repeated per row — beside
    `fiscal_year_start`'s existing note in the model panel. **When one acquires a reader, delete its
    note: a stale "nothing reads this" is the same lie pointed the other way.**

  The standing rule this produced is now a design rule, not a note:
  `docs/design/insights-strategy-layer.md` §2, *nothing becomes authorable until it has a reader*.
  The cost is not dead code — **authoring effort has been the binding constraint on this layer from
  the start**, and an unread field spends that budget while looking exactly like a field that
  works. The gap to watch is that the layer was growing faster than the engine consuming it.
* **A band target still emits no `Variance` fact.** `Observation.target_value` is `Option<f64>`
  (`insights/model.rs:196`) and `model_commands.rs:414-424` maps `Target::Band` to `None` — a band
  is two numbers and does not fit. The band is no longer inert: `favourability_at`
  (`insights/model.rs:575`) now decides a Change fact's favourability from where the value LANDED,
  using each bound's inclusivity, at both fact sites (`model.rs:1434,1481`). But the variance ROW a
  band deserves ("inside 90k–140k" / "above it by 12k") needs a band-shaped fact in `core/insights`
  plus narration, which is a feature, not a fix. **Per-side band severity is blocked behind this**
  and was deliberately not added, because a severity that reorders nothing is another inert field.
* **`ScopeValue::DateRange` on a non-date column is mitigated, not closed.** `resolve.rs:456-459`
  compares bounds to members as raw strings, so a date-range rule silently matches text members and
  overrides facts it does not describe. The new `date-range-on-non-date-column` check reads the
  column's declared MEMBERS, and `facts_from_model` deliberately leaves `TableFacts::members` empty
  (members are data, not schema — populating them means a grouped query per column on every
  validation), so in production the check is dormant. Closing it needs column TYPES in `ModelFacts`.

The label-score fix has a stated price, asserted rather than hidden: a denormalised `Category Name`
on a product dimension reads as name-like and is demoted to `label`, so its breakdown is not
offered (`a_denormalised_name_that_really_is_an_axis_is_demoted_too_and_the_harness_says_so`,
`strategy/calibration_tests.rs`). The trade is a withheld breakdown against a meaningless one, paid
in a dropdown, on a row that ships `reviewed: false`.

**2.AI.8 — The fifth Strategy review: what closed, and the two things worth keeping.** Five items
were raised; all five are done (`TableStrategy.kind` wired, the warning→error sweep run, `suppress`
made an enum, the vacuous-test family closed structurally, the cardinality argument recorded in
§2.AI.6). Two results are worth more than the items that produced them.

* **A DEFECT ESCAPED FOUR SUCCESSIVE FIXES BY CHANGING AXIS.** The inline-test harness — the one
  mechanism giving a strategy document teeth, and the artifact a consultant is asked to trust —
  could report a green tick for an assertion the run does not deliver. Fixed four times:
  a `targetBand` direction with no band fell to `Neutral`; then an IMMATERIAL delta returned
  `Neutral` regardless of the band, because materiality was tested first; then an `Immaterial`
  verdict was added on the premise "below the floor the run emits nothing", which is FALSE —
  only the **Change** fact is materiality-gated (`insights/model.rs`), the **Variance** fact is
  built outside it and carries its own favourability, so a flat period against a literal target
  answered "immaterial" while the report said "worse"; then the new consistency gate's own float
  tolerance let a relative floor move under the point. **Every fix was verified, and every
  verification found the next spelling.** The transferable lesson: a single-shot fix to a family
  defect closes the instance; only an adversarial pass that tries to BUILD a fresh reproduction
  finds the family. The reason 295 tests could not see any of it is that every fixture exercising
  the path was built with no target — and one test's NAME generalised past what its fixture proved
  (`a_movement_below_the_floor_is_immaterial_here_because_the_run_emits_no_fact_there` hand-built
  its observation with `..default()`, so `target_value` was `None`).
  The semantics that finally held: **materiality is a property of a MOVEMENT; a variance against
  target is a comparison of LEVELS**, so a tiny movement can still sit far from target and gating
  the Variance fact on movement-materiality would have been the wrong fix.
* **THE WARNING→ERROR SWEEP CAME BACK NEGATIVE — AS A SNAPSHOT, NOT AS A CLOSED CLASS.**
  **Do not read "sweep negative" as "this cannot happen again."** The sweep establishes that the 15
  sites are correctly classified *given each finding's current definition*. It says nothing about
  findings that do not exist yet — and the one real defect this pass found in that area,
  `contradictory-analysis-dimension`, was exactly that: a withheld fact with **no finding at all**,
  which no sweep of existing severities could have surfaced.
  **The durable artifact is the rule now written at the top of `strategy/validate.rs`**, applied to
  every finding as it is written. The sweep is a dated observation about a tree that has since
  changed. All 15 warning sites are
  correctly classified under the rule now written at the top of `strategy/validate.rs`: *a document
  that, saved as-is, would make a fact WRONG or SILENTLY WITHHELD is an error; one that would only
  make a fact LESS GOOD is a warning.* Eight are provably inert downstream, one is unreachable, one
  over-refuses safely, two never gate a write, and the two that do change output announce
  themselves. It found one genuine withheld fact with no finding at all — a measure listing a
  column in both `analysisDimensions` and `neverSliceBy`, where the prohibition wins and the
  breakdown is simply absent — now `contradictory-analysis-dimension`, an error.
  It also corrected the justification usually given for the `unreviewed` warning: the resolver has
  no `reviewed` gate, so an unreviewed inferred direction is applied at FULL STRENGTH. The warning
  is right, but because **an inferred draft must stay savable**, not because it produces correct
  facts. Cite the workflow reason.

`TableStrategy.kind` is wired, and **the control now offers exactly what the seam consumes.** An
authored `calendar` moves the axis, the roles and the narration (`CalendarSource::Authored` joins
Declared/Inferred); an authored `dimension` refuses against topology and demotes a guessed calendar.
`fact`, `bridge` and `other` reach nothing on the run path, so they are **disabled in the dropdown
and refused by the CLI**, with the reason on the option — documenting an inert control in a header
the user never reads is weaker than not offering it. They are disabled rather than dropped because
every inferred draft stores one. An authored kind that relationship topology DISPROVES is a
validation error: a human statement beats a heuristic, but not topology.

**The DEMOTION direction was the uncovered one, and it is the expensive one.** Promotion
(`Dimension → Calendar`) only adds an axis; demoting the calendar takes one away and with it every
trend, change-point and seasonality fact at once. Against an INFERRED calendar the demotion now
wins and the run says so; against the model's own `mark_date_table` it is refused with a warning,
because a declaration is a human statement too. A first attempt filtered the calendar SEARCH by
every non-calendar kind and a test caught it: confirming what the tab already showed you could
break a two-candidate tie and *invent* a time axis. **Agreeing with a displayed value must change
nothing** — so only a demotion of the table the guess actually named takes effect.

**Confirmation is advisory, and the report now says so.** `resolve.rs` has no `reviewed` gate, so an
inferred direction applies at full strength whether or not anyone looked at it. That is the right
design — an inferred draft must stay savable — but the tab's Confirm workflow reads as though
confirming changes output, and it does not. A run whose measures carry unconfirmed inference now
carries a note naming them.

**2.AI.9 — The extension seams: steps 1-5 SHIPPED 2026-09-09, C and B remain.**
Design in `docs/design/insights-strategy-layer.md` §13; what each step cost is in §13.6a.

**Closed:** the shared `extension_namespace_refusal` predicate (casing hole fixed, cap message now
says *bytes* because the check always counted bytes); **Tier A** (`x` bag, `ExtKey`, the
`extensions` declaration block, prefix-anchored findings, TypeScript mirror, drift guard extended to
`ExtValueType`); the `finish_facts` hoist; **Tier D**'s engine seam (`apply_fact_policy`, guarded by
a subset check on the ANSWER rather than trust in the policy); and readers for **`unit`** and
**`cadence`** — both narrower than the plan assumed, see §13.6a.

Still open, in order:

* **Tier D has an engine seam and no authoring surface.** `apply_fact_policy` is guarded and unused.
  That is the right order — the guard exists before anything can reach it — but the seam is inert
  until something points at it, which is the same shape this layer keeps having to correct. Wire it
  or say plainly that it waits for a policy worth writing.
* **`tests:` still has no authoring surface**, and §13.3 makes that a prerequisite for the
  extension-grading claim: no Tests grid, no `add test` verb, `infer` emits none by design. Then the
  golden-observation harness, **applied to built-ins first**.
* **Tier C** (producer surface, structured sink, `AttrSource::Plugin`, the §2 amendment) waits on
  the fact catalogue being consumed end to end. **Tier B** waits on Tier C's unknown-value
  discipline; `with_pct`'s `_` arm (`insights/model.rs`) is the plug point already written for it.
* **`ResolvedMeasure.context` is the last unread field, and it is the prose one.** Written at
  `strategy/resolve.rs`, read by nothing. Its consumer is M6's narrator. The consequence for §2 is
  recorded there: the prose boundary is currently *vacuous rather than fragile*, and the source-scan
  guard the section used to claim exists does not. Write the guard when M6 gives prose a reader.
* **Two Strategy-tab finding paths anchor nowhere**: `tests[i]` and `periods[i]` have no grid, and
  `version` has no `data-strategy-path` row despite a comment in `strategy/types.rs` claiming it is
  pinned to one. They land in the findings strip and highlight nothing. Related: **there is no
  authoring surface for inline tests at all** — no Tests grid, no `add test` verb, and `infer`
  emits none by design. §13.3 makes that a prerequisite for the extension-grading claim rather than
  a cosmetic gap.

**CLOSED 2026-09-09 — `calp_publish_model` bypassed the strategy publish gate.**
`validate_published_strategies` had exactly one call site, inside `assemble_publish_workbook`, and a
model-only push captures its data sources directly and never assembles a workbook. So the ONE
package kind whose entire content is a model was the one kind that could publish a strategy document
which fails validation, carries an unresolved rule overlap, or fails its own inline tests — to a
subscriber who cannot repair it, because `editable_base` refuses model writes on a
package-subscribed connection. That is verbatim the case the gate's own header says it exists to
prevent. The guard that should have caught it asserted the call appeared `>= 1` times **anywhere in
the file**, which proves existence rather than coverage and stayed green throughout; it now
enumerates the publish entry points and asks per path, with a positive control proving the scan can
tell a reached path from an unreached one. Sabotage-verified: removing the new call reds the
coverage test naming `calp_publish_model`, where the old count would still have passed.

**2.AI.5 — M2 BUILT 2026-09-10 (Step 3 of 2.AI.10); M4 BUILT 2026-09-16 (Step 5); M6 designed,
M5 dropped, M7 open.** The
bundled runtime exists: `app/scripts/fetch-llama-server.mjs` (pinned build, sha256 per
architecture), `ai/runtime.rs` (job object, free port, health wait, idle unload, six
`ai_builtin_*` commands), `ai/builtin_model.rs` (consented, resumable, hash-verified download), the
`calcula-builtin` provider, the `tauri.runtime-<arch>` / `tauri.offline-<arch>` overlays and the
release step. Design: `local-model-script-authoring.md` §14; measurements: 2.AI.10. M4 (intent
router) SHIPPED 2026-09-16 — `AIChat/lib/intentRouter.ts`, the build record under 2.AI.12 and
`ai-intent-router.md` §6. M6 (Tier-1 narration, Swedish) keeps its design and its seams —
`factsJson` carries fact ids precisely so a later narrator can be checked for coverage. **M4's
design is `ai-intent-router.md`, and it only became a file on 2026-09-11.** This sentence had claimed it
"keeps its design" while citing nothing, because the design was in a plan snapshot under a user
profile, outside the repository — a reader following the docs alone concluded none existed. That is
the citation rot this document warns about, happening to this document. M5 (the fine-tune
flywheel) is dropped. M7 (usage aggregates back to an application's author) needs a new manifest
declaration, a new submission kind and a consent sentence, and is the one telemetry-shaped feature
in a product that is otherwise local by construction.

**2.AI.10 — AI consumers of the strategy, and the on-board runtime: decided 2026-09-10, Step 1
SHIPPED.** Design: `docs/design/insights-strategy-layer.md` §14. The tier vocabulary, restated
because the request that opened this item used it the other way round: **Tier 0 is no model at
all** (the deterministic engine); **Tier 1 is the bundled on-board model** (M2 + M6); Tier 2 is a
larger optional model, which the picker already covers; Tier 3 is a bring-your-own key. Three owner
decisions: **D5** build order — strategy into the chat, then "Describe it in words" for design
queries, then the runtime, then narration, then the router, each measured before the next; **D6**
bundle `llama-server` (CPU build) in the installer and download the model on first use behind one
consent sentence naming size, licence and source, with an offline-installer variant bundling both
(amends D2's bundle-both); **D7** CPU build only, Vulkan after measurement.

*Step 1 shipped 2026-09-10.* Until then the in-app chat had no analysis tool — its 24 tools
carried no `analyze_*` and only the external MCP server did — and `describe_bi_model` printed no
strategy attribute, so a chat model composing a `run_bi_query` had no idea which measures mattered
or which way was good. Now `analyze_range` / `analyze_model` are chat tools
(`AIChat/lib/chatTools.ts`, arms in `ai/tools.rs`, both directions diffed by
`chatToolSurface.test.ts`, read-only and auto-run); `describe_bi_model` appends the block
`insights/describe.rs` renders — structured attributes only, `context` prose excluded and pinned by
the fixture's own two sentences, measures in `choose_measures`' order, capped at forty with the cap
stated; and the chat computes Tier-0 facts BEFORE the model sees an "analyse" message
(the `analyze` route of `AIChat/lib/intentRouter.ts` + `lib/tierZero.ts` — the original
`analysisIntent.ts` detector was absorbed into the router and deleted 2026-09-16 — wording from
`@api/insightsService::describeBundleForModel`, which the Insights pane's "Send to chat" now shares).
The two tools are NOT in `CORE_TOOL_NAMES`: that set was measured, and a change to it is a
measurement. Seven sabotages, each redding the test that names it.

*Step 2 shipped 2026-09-10 — "Describe the report in words".* Design: `insights-strategy-layer.md`
§14.3. A row above the shared design-query editor (Report from Design Query, the edit-report dialog,
the chart data tab) and on the model pivot's Design tab drafts a query from a sentence: pure pieces in
`app/src/api/designQueryAssist/` (candidates, prompt, bounded schema, per-request GBNF grammar,
extraction), the loop in `_shared/dsl/pivotLayout/draft.ts` with `compileDesignQuery` as the verifier,
one stall-checked repair, and the host's headless `run_design_query` as a dry run. The strategy is
the consumer here: `DesignStrategySummary` (`insights/describe.rs`, on `BiPivotModelInfo`) decides
which names the model is shown and how they rank; `context` prose is not in it. The seam gained
`grammar` + `honorsGrammar()`, forwarded only to llama.cpp. Two language facts the tests caught
before a user did: `SORT` orders labels only (ranking by a measure is `TOP N BY`), and the `ignore`
role means "not an axis", not "never aggregate". Corpus `tests/eval/design-queries.json` (40 tasks,
10 Swedish, each with a distractor) with Layer A (`designQueryCorpus.test.ts`: compiles, distractor
differs, every reference name is among the candidates for its intent) and Layer B
(`run-design-query-eval.mjs`, canonical-form grading). Six sabotages, each redding the test that
names it. **The first measurement changed the language rather than the model**: of a 1.5B's 33
failures, 24 did not compile and most were shapes a person types too, so the DSL parser now reads a
single-quoted value and a bare number as values and accepts a redundant direction after TOP/BOTTOM
(refusing a contradictory one by name; `dsl-lenient-values.test.ts`), and grading compares the
layout as drawn with defaults dropped (`canonical.test.ts`). **Found, not fixed:** the DSL's
`subtotals-top` / `subtotals-bottom` / `subtotals-off` directives and the `(no-subtotals)` field
option are lexed, parsed, validated and autocompleted — and `_shared/dsl/pivotLayout/compiler.ts`
has no case for any of them, so a typed or drafted `LAYOUT: subtotals-off` compiles to nothing
and the report keeps its subtotals in silence (`LayoutConfig` in `_shared/components/types.ts` has
no subtotals field; the script surface maps them in `scriptHost/pivotLayoutVocabulary.ts:190-196`,
the DSL does not). **Measured 2026-09-10** on this CPU (`node tests/eval/run-design-query-eval.mjs
--provider ollama --model qwen2.5-coder:1.5b|3b`, schema on, examples on, no repair), four rounds
because the first three measured the pipeline rather than the model: (1) first prompt 7/40 and
20/40; (2) after the parser leniency and the fairer grading, compile rates rose (16→23, 25→33 of 40)
and pass rates did not, because the prompt's own examples taught a `SORT: [Measure]` the compiler
refuses and a `TOP 10` nobody asked for, and both models copied them; (3) examples fixed and guarded
by a test: 18/40 and 21/40; (4) four general rules (no unasked LAYOUT, a share label only when a
share is asked, a filtered column not repeated as COLUMNS, a measure never aggregated) plus an
aggregation example and alternatives for genuinely ambiguous requests: **1.5B 21/40 (52.5 %),
36/40 compile, 5.5 s median; 3B 27/40 (67.5 %), 38/40 compile, 11.5 s median; 1,138 prompt
tokens.** Levers measured on the way: one repair round +1 task on the 1.5B and +0 on the 3B (the
formula assistant's finding again); the shaped examples +0 on the 3B for 247 tokens. What remains
is judgement — a filtered column repeated as COLUMNS, an unasked layout, a share label on a Swedish
ranking — plus SQL habits (`LAG()`, `!=`, `count([Measure])`) the grammar would forbid, and Swedish
vocabulary on the 1.5B. The 3B clears the 95 % compile bar; neither clears the 80 % exactness bar;
the grammar lever is unmeasured until Step 3 ships a runtime that honours one.

*Step 3 shipped 2026-09-10 — M2, the on-board runtime (D6/D7).* Design and the §2 reversal:
`local-model-script-authoring.md` §14. What exists: `app/scripts/fetch-llama-server.mjs`
(llama.cpp b10897 pinned by build number and a sha256 per architecture, a pure-Node zip reader in
`scripts/lib/artifact.mjs`, the folder Dropbox-ignored the moment it exists),
`fetch-builtin-model.mjs` (the same pin as Rust; `builtinRuntimePins.test.ts` diffs the two and the
overlays and the workflow), `ai/runtime.rs` (a free loopback port, a Windows job object with
KILL_ON_JOB_CLOSE proved by dropping the job on a `ping`, a `/health` wait that carries the child's
last forty lines, a fifteen-minute idle unload with a visible reason, six `ai_builtin_*` commands
denylisted under a new `localRuntime` capability), `ai/builtin_model.rs` (a resumable `Range`
download that starts over when a server ignores the range, refuses a different `Content-Length`,
deletes a hash mismatch and lands in `%LOCALAPPDATA%\com.calcula.app\models` — not the roaming
folder a gigabyte would sync from), the `calcula-builtin` provider first in the registry with a
port-0 placeholder that `ai::base_for` replaces on the first completion, and the picker's section
with the one consent sentence (size, licence, source, hash, folder) behind `confirmAsync`, doubled in
the Tauri shape by its test. **Not a Tauri `externalBin`**: a sidecar must exist at every
`cargo build` and carries only the executable, while the server needs its DLLs beside it — so the
runtime is a resource folder mapped by `tauri.runtime-<arch>.conf.json` at release time (a
resource glob that matches nothing FAILS the build, tauri-utils `GlobPathNotFound`), and a debug
build reads the source tree. The probe gained a fifth pre-flight (`root ::= "OK"` against a
question the grammar forbids answering) and the profile a `honorsGrammar` verdict; the seam forwards
a grammar on a measured true or, unmeasured, on llama.cpp identity, and a measured false overrides
identity. A formula grammar (`@api/formulaAssist/grammar.ts`: the JSON envelope, the formula held to
syntax, a call as a suffix, every repetition bounded) rides the ladder where the verdict is true.

**Measured 2026-09-10 on the built-in runtime** (llama.cpp b10897, Qwen2.5-Coder-1.5B Q4_K_M, this
arm64 CPU — loads in 1.6 s, ~400 tok/s prompt, ~47 tok/s decode — on port 8080 with the app's own
flags; `tests/eval/README.md` has the commands):

| corpus | path | passed | compiled / usable | median | p90 |
|---|---|---:|---:|---:|---:|
| design queries (40) | schema | 15/40 | 34/40 compiled | 2.1 s | 3.1 s |
| design queries (40) | grammar, bare prompt | 17/40 | 40/40 compiled | 1.0 s | 1.4 s |
| formulas (97) | schema | 35/97 | 0 truncated | 3.0 s | 4.3 s |
| formulas (97) | grammar, bounded | 37/97 | 7 truncated, declined | 1.9 s | 6.1 s |

McNemar on the paired outcomes: p = 0.77 (design queries), 0.69 (formulas). **The grammar does not
change correctness on this model; it changes what a failure looks like and how long it takes.**
Design queries: every reply compiles and the median halves; what is left is judgement alone — an
unasked share label (6), an unasked TOP (6), an extra name (6), a filtered column repeated (2).
Formulas: a third off the median; the seven truncations are a 1.5B looping on nested calls inside a
grammar that bounds every repetition but cannot bound nesting, and the ladder reports them as
declined, never as a formula. Three levers measured on the way, each a paired run: the free-order
design-query grammar let one reply write VALUES twice, the canonical-order grammar fixed that and
moved no task (17/40 both, p = 1.0); the first formula grammar was unbounded (12 truncations, p90
11.6 s, one of them a quoted "sheet name" that swallowed `|)`) and the bounded one is the row above;
and a prompt that asked for JSON under a grammar that forbids it opened every reply with an unasked
LAYOUT line, three of three, so the grammar path now asks for the bare query. Neither bar (80 %
exact design queries, 90 % verified formulas at 3 s) is met, and the gap is the model: the Ollama
build of the same 1.5B scored 21/40 on the schema path earlier the same day, so runtime and
quantisation are worth about three tasks of noise. The clean wins are structural: everything
compiles, half the wait, and a runtime the app owns end to end.

**2.AI.12 — The on-board-model programme: Phase 0 and Phase 1 SHIPPED 2026-09-15, and the
restraint lens is MEASURED DEAD.** The owner asked whether small on-board models can be made
smarter about Calcula. Five lenses were researched against this repo's own measurements and
produced one reframe worth keeping: **the apparatus could not detect an improvement.** Not one
headline number in 2.AI.1 or 2.AI.10 had a retained per-task artifact — `out/` is git-ignored —
while McNemar, the instrument this programme chose, needs per-task outcomes. The drift was
already visible: 17/40 at :1658 and 16/40 at :1783 for the same arm.

*Phase 0 — the measurement survives being taken.* Every runner now writes a `knobs` block, one
key per CLI flag, spelled the same as the flag and typed the same across runners (`schema` was a
BOOLEAN in the design runner and a STRING in the formula one, and `--schema lean` recorded the
same value as the default, so two runs that really did differ were byte-identical in their own
artifacts). `compare-runs.mjs` labels by DIFFING those blocks instead of four hardcoded keys —
`grammar` was not among them, so the two most important design-query arms printed identical
headers — and says out loud when two runs were configured identically, which is the one case
nobody can see by eye. `tests/eval/runs/` is now un-ignored and holds the baselines.
`tests/eval/lib/evalKnobs.test.mjs` fails the build when a runner accepts a flag it does not
record; it found two on its first run (`--tag` and `--limit` on the formula runner, both of which
select WHICH tasks execute). The eval harness is now in vitest's include list — it had no unit
tier at all, which is how the `lean` defect survived. Also fixed: `--provider anthropic` was
documented in two places with no endpoint, so the documented command exits "No endpoint known".

*Phase 1 — the restraint lens, measured and closed.* The premise was the strongest in the
programme: 20 of 23 remaining design-query failures were OVER-PRODUCTION, so the model looked
like it knew Calcula and merely lacked restraint. Two measurements, in the order that kills the
expensive one cheaply:

  1. `classify-design-failures.mjs` (new, offline, no model) joins a saved run to the corpus and
     reports defects per TASK rather than per defect. The recorded 6+6+6+2 counted DEFECTS; the
     number that decides the lens is how many failing tasks have a gateable defect as their SOLE
     difference from the reference, and that is **4**. McNemar on 40 tasks needs b=6, c=0 for
     p<0.05, so even a perfect gate could not be certified on this corpus. It positive-controls
     itself by injecting a known `TOP` into every reference and requiring that damage to be named
     and nothing else.
  2. The ceiling was then measured directly. `buildDesignQueryGrammar` gained an `allowed`
     parameter and the runner a `--clause-gate oracle` that derives the allowance from each
     task's OWN TAGS — i.e. from the answer, so the gate is perfect by construction and can never
     ship. Result: **17/40 -> 18/40, one task fixed, none broken, McNemar p = 1.0.**

**So the lens is dead, and the DPO/fine-tune case that shares its taxonomy dies with it.** The
generalisable lesson is written into `grammar.ts` so it is not re-proposed: *constraining what a
model may not say does not tell it what to say.* A grammar buys structural guarantees —
everything compiles, no invented name, half the latency — and no judgement whatsoever. That
matches the earlier paired runs (p = 0.77 design queries, p = 0.69 formulas) rather than
contradicting them; this is the same finding reached from the other direction, and it cost two
runs and an afternoon instead of the weeks a clause detector would have.

*Also Phase 1: the surface tax.* `apiSurfaceSection` built ~6,000 tokens of scripting reference on
EVERY chat message including a pure "analyse this" — roughly 15 s of prompt processing at the
built-in runtime's measured ~400 tok/s, for a reply that will never call a script tool. It is now
skipped when a message is confidently analysis and shows no sign of wanting a script. **The gate
is the NEGATIVE one and the asymmetry is the whole care in it**: gating on `detectScriptIntent`
was the obvious move and is wrong, because that detector is measured to MISS 23 of 35 script
requests, so building the surface only when it fires would starve two thirds of them. A new
`mightWantScript` is its deliberately over-broad sibling — the two questions now have opposite
failure modes, and this one is wrong when it stays SILENT. The first version of the gate used the
precise detector and its own test caught the hole ("analysera och skriv ett makro" was starved,
because "makro" is not in the precise list).

*Phase 3 — the Tier-0 harvest: `sv.rs` SHIPPED.* `narrator_for` returned `EnNarrator` for BOTH
locales, which `mod.rs` documented as deliberate and temporary. It had a consequence nobody
noticed: **the narration eval's "0 of 5 Swedish bundles" was read as a MODEL failure when the
deterministic side it was measured against was not Swedish either.** `core/insights/src/narrate/`
`sv.rs` now carries a Swedish template for all 21 fact kinds, the match exhaustive and
wildcard-free so a new `FactKind` cannot compile until someone has written what it says. Two
Swedish specifics the English file has no need of: grammatical gender decides plurals (`en rad` ->
`rader` but `ett värde` -> `värden`, and `ett fel` -> `fel`), so each noun carries its own forms
rather than being assembled from a rule; and `R²` stays as the symbol rather than becoming a
back-translation of an English name. Verified the way that matters: `run-narration-eval.mjs`
narrates all five bundles DETERMINISTICALLY through the real citation check before it measures
any model and exits 3 if any is rejected — it did not, so all 41 Swedish facts pass the same
fabrication check English does. A test also fails if a Swedish template still contains English
fragments, because an exhaustive match does not stop a template being copied and left.

*Corrected while doing it, and worth recording because the research got it wrong:* `explainFormula`
was reported as a built capability with zero consumers. The SEAM member has none, but
`explainCell` is called directly by `FormulaAssistPopover`, so the capability is reachable —
what is unused is the `formulaAssistService` member. Exposing it to the chat is a bigger job than
reported, because every chat tool dispatches through `ai_chat_run_tool` in Rust and this one is a
frontend orchestration over two backend calls.

*Phase 4 began with the measurement that had to come first: THE SECOND SCHEMA, and it VALIDATES
every design-query number taken so far.* Every one of them was measured against one fixture
(sales_star.json, hardcoded in the runner), so 17/40 could have been a fact about the DSL or a fact
about having seen these column names, and nothing distinguished the two. renamed_star is a
CONTROLLED rename generated by tests/fixtures/model/gen-renamed-star.mjs: the same star, the same
rows, the same 40 questions, only the vocabulary differs (Sales->Ledger, Product->Item,
Category->Family, Revenue->NetValue, ...), so exactly one variable moves. Measured on the built-in
1.5B with the grammar path: **17/40 -> 14/40 overall, p = 0.55 — and 13/30 -> 12/30 on the ENGLISH
half.** Seven tasks broke and FOUR were fixed by the rename, which is the scatter of noise rather
than the signature of memorisation. **So the design-query numbers are about the DSL, and the
bake-off comparison is valid.** The Swedish half fell 4/10 -> 2/10 and carries a documented
confound: `segment` is spelled identically in both languages and `skikt` is not, so
the Swedish tasks lost an identical-cognate hint and are slightly harder. The English half is the
clean comparison, which is why the generator records that and the two are reported separately.
The calendar columns are deliberately NOT renamed (chooseCandidates finds time groupings partly by
name, so renaming them would move a second variable), the generator is reproducible under --check
like its sibling, and it refuses to write a fixture in which any original identifier survives — a
partial rename would silently measure a MIXTURE of the two vocabularies.
*Phase 2 — THE BAKE-OFF RAN, AND THE ANSWER IS DO NOT PIN.* Two first-party IBM GGUFs under
Apache-2.0, both verified byte-for-byte against their model cards before use, served on the
product's own flags (`-c 8192 -np 1 --jinja --no-webui`). The incumbent was RE-BASELINED first,
because the standing 17/40 was taken on the pre-Swedish-drop corpus and ten tasks had changed.
Artifacts for all four runs are retained in `tests/eval/runs/` with their knob blocks.

| model | download | design queries | formulas | FX median | 3 s FX gate |
|---|---|---|---|---|---|
| incumbent qwen2.5-coder-1.5B | 1.12 GB | 16/40 | 38/97 | 2342 ms | PASS |
| granite-4.0-1b | 1.02 GB | 16/40 (p=1.00) | **49/97** (p=0.0614) | **2057 ms** | PASS |
| granite-4.0-micro 3B | 2.10 GB | **24/40** (p=0.0574) | 40/97 (p=0.83) | 4226 ms | **FAIL** |

Against the pre-registered rule (+6 net with zero regressions, OR p<0.05 on formulas; abandon only
if both corpora move under 3 tasks) **neither candidate clears and neither is abandonable.** The
two are COMPLEMENTARY, not ranked: granite-1b is the formula model, granite-micro the design-query
model, and micro cannot serve formulas at all at 4226 ms.

**What settles it is not the p-values — it is the FOURTH surface.** The bake-off had measured two
of the six eval runners, so granite-1b was carried through the rest:

| surface | incumbent | granite-1b | |
|---|---|---|---|
| formulas | 38/97, 2342 ms | 49/97, 2057 ms | granite-1b, +11 |
| design queries | 16/40, 1004 ms | 16/40, 1416 ms | tie |
| next-edit (`run-next-edit-eval`) | 0/77, 676 ms, gate FAIL | 0/77, 766 ms, gate FAIL | tie AT ZERO |
| narration (`run-narration-eval`) | 1/5 clean, **5 inventions**, 31.7 s | 0/5 clean, **13 inventions**, 48.5 s | **incumbent** |

granite-1b invents 2.6x more numbers in narration and is 50% slower there. For a feature whose
failure mode is a FLUENT SENTENCE CARRYING A FABRICATED FIGURE, that is the worst axis to lose on,
and it converts "smaller, faster, better at formulas — just take it" into a trade. **Recorded as a
programme conclusion: narration is not shippable on ANY 1-3B on-board model.** Both models miss
the 8 s gate by 4-6x and both invent; this is Tier 2/3 work, not Tier 1. `run-intent-eval` needs no
model (it scores deterministic detectors), so five of six surfaces are now accounted for.

*The failure diagnosis: 38 adversarial agents, five lenses, and ZERO surviving claims.* Every
hypothesis about why the formula corpus fails was refuted by a verifier who re-derived the
arithmetic independently. Three of them were mine. What the refutations VERIFIED is worth more than
the claims were:

  - **The formula result is CLEAN.** Real harness defects exist — 16 of 97 fixtures have their
    header row refused by `hasHeaderRow` (`context.ts:159-163` requires a non-text cell in row 2);
    all 37 `lib:*` "Request" lines are function documentation rather than a question about the
    data, and 4 need a literal that appears nowhere in the prompt. Their maximum combined swing was
    measured by replaying each model's own formula with the missing piece supplied: **+4/+3/+3,
    against an 11-point lead.** No harness defect explains granite-1b's formula win.
  - **The library half is EASIER than the hand half, not broken**: lib 19-21/37 (51-57%) vs hand
    19-28/60 (32-47%) in every run.
  - **My own sample-row hypothesis is dead.** `MAX_SAMPLE_ROWS = 3` shows the model three data rows
    of a longer table; it explains 1 failure of 48 for granite-1b, 1 of 59 for the incumbent, 0 for
    granite-micro. The models read the extent from the prose and reach past the window fine.
  - **`finishReason` is computed (`run-formula-eval.mjs:468`) and never persisted** in the per-task
    rows (:505-516), so no artifact can say WHICH task was truncated. A live measurement blind spot.

*The models have OPPOSITE pathologies, which is why no single swap is simply better.* Per-clause
recall over the design-query corpus: the incumbent writes **COLUMNS 0/6** — it never emits the
clause when one is needed — and spuriously adds TOP ten times. Both Granites write COLUMNS 6/6 and
5/6 and then spuriously add it ELEVEN times each. An over-producer looks fixable and mostly is not:
stripping the unrequested COLUMNS line and re-comparing with `sameDesignQuery` rescues **3 of 11**
for micro and 4 of 11 for granite-1b, because the query underneath is usually missing a FILTERS, a
LAYOUT or a SORT as well. That CONFIRMS the restraint lesson rather than refuting it, on a model
family with the opposite failure mode from the one it was measured on — see `grammar.ts`.

**Phase 4 WAS the binding constraint, and it is now DONE.** McNemar needs six clean flips whatever
the corpus size, and that applies to every SUBSET too, so a capability sampled by three tasks could
never be measured no matter how much compute was spent. Every formula family held exactly **5**
tasks — not one of the twelve could ever reach p<0.05 alone — and the design-query corpus carried
SORT=2, BOTTOM=2, LAYOUT=3, TOP=4. The corpora could answer "is this model better overall" and
never "better at WHAT", which is precisely what a pin decision between two COMPLEMENTARY candidates
needs.

*Grown and balanced 2026-09-15.* **Design queries 40 -> 122**; every clause now ROWS 122, VALUES 122,
FILTERS 28, COLUMNS 21, TOP 15, SORT 13, LAYOUT 13, BOTTOM 12. **Formula hand tasks 60 -> 144,
twelve per family exactly** (181 measured, with the 37 held-out `lib:*`). Each task was authored
against the real compiler or the real grader and then adversarially reviewed by a second reader who
re-derived the arithmetic rather than trusting the `handCheck`.

**Three shipped design-query tasks were REMOVED rather than repaired: they filtered on members the
fixture does not contain.** There is no "Europe" region (Nordics, DACH, Benelux, UK and Ireland) and
no "Consumer" segment. The compiler checks NAMES, not VALUES, so all three compiled and passed every
gate for as long as they existed, while the query they describe is unanswerable — and a model that
picked a real region was marked wrong for being more sensible than the reference. All three were in
the "no model passes" set. Same-shape replacements over real members took their place.

*Four gates are now permanent, two per side, each sabotaged and seen to fail on the right
assertion:*
- `designQueryCorpus.test.ts` — a clause floor (>=12 each, sabotage: SORT cut to 3 -> names `SORT=3`)
  and a filter-literal check against the fixture's real members (sabotage: a task filtering on
  "Europe" -> named, while that task's own compile and candidate tests stayed green).
- `corpus_tests.rs` — `MIN_TASKS` 50 -> 140 and a new `MIN_PER_FAMILY = 12`
  (sabotage: condagg cut to 5 -> names `condagg=5`, reference and distractor tests unaffected).

*The growth immediately found five defects, which is the argument for having done it:*
- **Three engine defects in the criteria parser, all filed** — BUG-0115 a date literal inside a
  criteria string matches nothing (and `"<>2025-01-15"` KEEPS the row it was told to drop),
  BUG-0116 four of the five comparison operators do not compare text at all (`<>` does, which is
  why the family looks complete on a spot check), BUG-0117 an error in the criteria argument is
  swallowed and becomes a confident zero. All three are the "lie" class: a plausible number with
  nothing on screen to say it is wrong. Each was re-verified independently against the grader
  binary, paired against a form that works, with controls (`=ISNUMBER(A2)` TRUE proves dates are
  stored as numbers; `=SUM(Nowhere)` correctly errors, so the engine discards that knowledge at the
  criteria boundary).
- **Two next-edit rule defects**, fixed here. The coarser-time rule fired on three tasks grouping by
  `Date.Month` — whose values are `"2024-01"`, already year-qualified — while stating "adds the same
  period across every year", which is simply false about it. `timeGrain` alone cannot tell: `Month`
  and `MonthName` are both grain 2. A new `isCyclicalPeriod` is the discriminator, deliberately
  narrow and asymmetric (a bare `Month` answers "absolute", because saying "cyclical" wrongly makes
  a correction fight a correct query while the reverse merely withholds a suggestion). The rule also
  no longer fires when the query RANKS: `TOP/BOTTOM N BY` ranks the rows as grouped, so inserting a
  coarser level changes what is ranked — the four quietest months of the year become the four
  quietest year-months. A correction may refine a query; it may never replace the question.

*One measurement note for whoever re-runs the bake-off:* a task combining `TOP N BY` with `SORT`
must be written SORT-first. Both orders compile and are canonically identical, but the grammar's
root is `… (nl sort)? (nl topn)? …`, so a model on the grammar path can only emit one of them.
Also, `gen-renamed-star.mjs` regenerates `design-queries-renamed.json` from the corpus and has a
`--check` mode — regenerate after any corpus edit or CI reds.

**THE BAKE-OFF WAS RE-RUN ON THE GROWN CORPORA, AND THE GROWTH CHANGED THE ANSWER.** This is the
payoff of Phase 4 and it is worth stating first: **the near-miss was noise.**

| | old corpus | GROWN corpus |
|---|---|---|
| design queries | 16/40 vs 16/40, b=5 c=5, p=1.00 | **24/122 vs 28/122**, b=12 c=8, **p=0.50** |
| formulas | 38/97 vs 49/97, b=20 c=9, **p=0.061** | **61/181 vs 72/181**, b=29 c=18, **p=0.14** |

The formula result moved AWAY from significance, not toward it. The discordant ratio went 20:9
(2.2:1) to 29:18 (1.6:1) — with 84 more tasks granite-1b broke proportionally MORE than the small
corpus suggested. Had the corpus not been grown, the obvious next move would have been "add a few
tasks and it will cross 0.05", and that would have been wrong. **A p of 0.06 on an underpowered
corpus is not a result that is nearly there; it is a result that is not there yet measured.**

*So the verdict stands and is now firmly held: DO NOT PIN.* Against the pre-registered rule (+6 net
with zero regressions, OR p<0.05 on formulas) design queries give +4 with 8 regressions and formulas
give p=0.14. Neither is abandonable either — both corpora moved far more than 3 tasks.

*Where granite-1b IS ahead, now visible for the first time:* `date` 1→5 (b=4 c=0), `statfin` 2→6
(b=4 c=0), `dynarray` 1→4 (b=4 c=1), and design-query `COLUMNS` 1→5 (b=5 c=1). Clean directions with
no or one regression. It is dead level on the 37 held-out `lib:*` tasks (19→18, b=3 c=4), which is
the half derived from Microsoft's own documentation. Per-family flip counts are still mostly under
six, so none of these is individually significant — twelve tasks makes a family MEASURABLE, not
automatically conclusive.

*Two measurement cautions for the next reader.* **Latency in this session is not comparable to the
earlier one**: the design-query incumbent run agreed with the old run on all 37 shared tasks
(p=1.00, byte-identical config) while its median went 1004 ms -> 4249 ms. Same config, same answers,
four times the latency — machine state, not model or configuration. Within the session the ordering
is valid: granite-1b is faster on formulas (4256 vs 6943 ms) and slower on design queries (5210 vs
4249). And **the incumbent arm was re-graded with the post-BUG-0118 binary** before any comparison
was drawn — 172 recorded formulas replayed, zero verdicts changed — because two arms graded by
different binaries are not a paired comparison however small the change looks.

*The run also found BUG-0118, a PANIC.* granite-1b wrote a one-argument `=FILTER(A2:A9)`, the
evaluator indexed `args[1]` past a guard that only rejected zero arguments, and the grader process
died taking 25 minutes of completed inference with it. Fixed, regression-tested, and the test
sabotaged — on the second attempt, because the first sabotage was a blind string replace that hit a
DIFFERENT function's identical guard text and left the test passing. It was the only one of 42
variadic functions probed that crashed rather than answering #VALUE!.

**AND THEN THE GROWN CORPUS PAID FOR ITSELF A SECOND TIME: THE FIRST PROMPT-SIDE LEVER IN THE
PROGRAMME THAT WORKS.** With 122 tasks it became possible to ask which capabilities NEITHER model
can do at all, and the answer was stark — nesting two fields on ROWS **0 of 21**, an alias **0 of
8**, filters 7%, layout 8%, bottom 10%. Cross-referencing against `buildExamples` showed the prompt
demonstrated COLUMNS, TOP, show-as and aggregation (which scored 29-85%) and demonstrated **none**
of the capabilities at zero. Nesting a second dimension is barely harder than nesting one, so
difficulty does not explain a flat zero.

Six examples were added, one per missing clause, each showing exactly one thing. Measured paired,
same corpus, same knobs, one variable:

| | before | after | flips | McNemar |
|---|---|---|---|---|
| incumbent 1.5B | 24/122 | **35/122** | b=15 c=4 | **p = 0.0192** |
| granite-4.0-1b | 28/122 | **44/122** | b=19 c=3 | **p = 0.0009** |

**The mechanism is confirmed, not assumed:** tasks whose capability gained an example went 5->15 and
4->20, while tasks whose capability did not went 19->20 and 24->24. The entire gain sits where the
examples are. Run-to-run variance is ~zero here (two identically configured runs agreed on all 37
shared tasks, p=1.0), so a paired difference of this size is an effect.

This is the other half of the lesson in `grammar.ts`. *Constraining what a model may not say does not
tell it what to say* — **showing it what to say does.** Every other prompt-side lever tried in this
programme (restraint, clause gating, repair rounds, quantisation, a model swap) was measured dead or
noise; this one is worth +11 and +16 tasks.

*What it cost, recorded because it is not free.* Prompt ~1034 -> ~1245 tokens and median latency rose
(4249 -> 6674 ms on the 1.5B, 5210 -> 11099 on granite) — more than the prompt alone explains, since
the models also emit more clauses. Note the session-wide latency inflation above: the same numbers on
the earlier session's machine state would be roughly a quarter of these. The copying hazard the file
warns about fired PARTIALLY on granite — spurious FILTERS 12 -> 21, spurious LAYOUT 9 -> 18 — and was
more than repaid by what went away: spurious COLUMNS 44 -> 18 on granite, spurious TOP 33 -> 4 on the
1.5B. The FILTERS example's literal "2024" does appear in replies that never asked for a year;
trimming that one example is the obvious first bisect if the block is revisited.

*And the same method applied to the FORMULA surface found the opposite: a proxy that does not
predict the model.* The formula prompt has no fixed examples; it RETRIEVES three library patterns
per task. Measured offline over 174 tasks, only 18% of tasks ever received a pattern calling a
function their reference calls — a lookup request was served `T, T, MINIFS`, a text split
`SECOND, SECOND, GET.COLUMN.WIDTH`. The breakdown was exact: pattern intents are terse dictionary
definitions that rarely contain "is", "not", "it", so those words carry HIGH IDF and a request that
uses them three times hands 25 points to whichever pattern happens to contain them; query-side
repetition multiplied ("count" three times = 33 points to COUNT); and the synonym hint for SUM was
worth nothing because SUM is called in a hundred library formulas. Four fixes in `retrieval.ts` —
an expanded stopword list, query-term de-duplication, one-per-function slates, and the synonym hint
paid as a flat per-function boost instead of an IDF-weighted term — took hit@3 from **18% to 38%**
(48% on hand tasks, from 23%). **Then the 1.5B was run on all 181 tasks: 61/181 -> 61/181, nine
fixed, nine broken, p = 1.0.** Doubling example relevance moved the model not at all. The likeliest
reason is the one the diagnosis already found — these models choose the right FUNCTION and the
wrong CELLS, and an example from a Microsoft-doc fixture cannot teach which column is which in the
user's sheet. Retrieval on-vs-off still measures p = 0.0005; WHICH examples, at this size, does not.
The changes stay (neutral, and `T, T, MINIFS` was indefensible) with the null written into the file
so nobody tunes the synonym table expecting a score. **Do not build an embedding retriever on this
evidence** — the seam is there, but the thing it would improve is measured not to matter.

**THE FOUR ENGINE DEFECTS THE CORPUS GROWTH FOUND ARE FIXED (2026-09-16), and re-grading the
bake-off artifacts with the fixed engine pays both models +2 for free.** BUG-0114 (an omitted
optional argument answered #VALUE! in SORT, SEQUENCE, SUBSTITUTE and WEEKDAY), BUG-0115 (a date
literal in a criteria string matched nothing, and `"<>2025-01-15"` KEPT the row it was told to
drop), BUG-0116 (`<`, `<=`, `>`, `>=` never compared text) and BUG-0117 (an error in the criteria
argument became a confident zero) — each with a regression test on both the scan and pass-cache
paths, each sabotaged and seen to fail on its own assertion while the other three stayed green, and
each probe sweep that filed it now at zero disagreements with Excel (15/15, 18/18). The incumbent's
recorded formulas re-grade 61/181 -> 63/181 and granite-4.0-1b's 72/181 -> 74/181: every gained
task is correct Excel the engine had marked wrong. The gap is unchanged, so DO NOT PIN stands, but
both scores now measure the model rather than the engine.

*Two things learned fixing them that will bite again.* First, **a syntactic check on an argument
is invisible to any function routed through the lifter.** `eval_lifted_function` rebinds every
argument to a `NamedRef` slot before the scalar body runs, so `is_omitted` — which matches the
parser's `Literal(Value::Blank)` — fixed SORT and SEQUENCE (not lifted) and silently did nothing
for WEEKDAY and SUBSTITUTE (lifted). The only reason it was caught is that the regression test
covered a TRAILING slot as well as a middle one; a test written from the probe alone would have
passed. `call_with_values_masked` now carries omission through the binding. Second, **the criteria
symmetry rule — "a criteria and a cell must be read the same way" — is right for percent and
currency and inverts for dates**, because a typed date cell stores a NUMBER while a typed `5%`
cell stores text. The fix splits the literal side (`CRITERIA_LITERAL`, ISO dates accepted) from the
cell side (`CRITERIA`, unchanged), so a text cell that merely looks like a date still does not
match, which is also Excel's answer. `parse_criteria` returning a `Result` is what makes BUG-0117
stay fixed: all nine call sites had to write the `Err` arm or stop compiling.

**STEP 5, THE INTENT ROUTER (M4), SHIPPED 2026-09-16 — corpus first, as the design demanded.**
`AIChat/lib/intentRouter.ts` routes every chat message ONCE, before any model turn, to one of nine
intents by deterministic rules: every strong signal is collected, documented precedence pairs
settle the confusions the corpus is dense on, exactly one survivor is decisive, two survivors are a
clarify notice (ask, never guess), and a lean is never decisive and keeps every tool. `script` is
decided from durability signals — an event, a schedule with an automation verb, persistence, a
run-time dialog, an entry point, a network/JSON capability — because the old twelve-word trigger
list missed 23 of 35 script requests. `bi-query` is decided from the loaded model's own field
names through a new seam, `app/src/api/biModelFields.ts` (cached per connection, warmed at
activation and on `bi:model-changed`, read synchronously in `send()`), which is the seam §4b of
the design said did not exist. `AIChat/lib/specialists.ts` hands a decided route ≤ 8 tools and a
one-paragraph addendum; only `script` carries the ~6,000-token API surface, and the gate is the
NEGATIVE one (`skipSurface = decisive && intent !== "script" && !mightWantScript`), pinned against
inversion by `surfaceTax.test.ts`. Measured on `tests/eval/intents.json` (214 rows, 122 of them
`bi-query`, so the headline is a macro average) by `run-intent-eval.mjs`: all — macro 98.9 %,
213/214, decisive precision 100 % (0 wrong of 201 decided), 0 false scripts, 2 clarified;
**held-out 96 — macro 97.8 %, 95/96**, where held-out means "id hashes odd AND never inspected
while the rules were written" (`run-intent-eval-split.mjs` pins the nineteen inspected ids to the
tune half by name, and the CI gate imports that same module). The detectors it replaced scored
24/214 on the same corpus with three of nine intents reachable. `intentRouter.corpus.test.ts`
asserts 100 % decisive precision over EVERY row (sabotaged: flipping the chart/bi-query precedence
redded that assertion naming `ch-1` and `ch-4` with the sabotage's own reason string, plus three
companions), zero false scripts, held-out macro ≥ 0.90, every `rg-*` regression, every intent
reachable, and ≤ 2 asks on rows the corpus marks decisive. `analysisIntent.ts` is deleted: the
router reproduces all twelve English cases it fired on and all nine it stayed quiet on (carried
into `intentRouter.test.ts`), and its "defer to the formula assistant" veto, which had no
destination, now IS the `formula` route.

*Found during integration by the salvage harness, not by design:* the reactive narrowing — "the
model invented a tool name, retry with the core set" — WIDENED a decided route. A format request
that started with four tools was retried with the ten-tool core set under a notice saying
"smaller". `narrowedSurface` (`specialists.ts`) now returns the smaller of the two, by identity, so
the notice says which of the two things happened; the remembered narrowing caps later lean
messages at the core set without replacing a later decided route's shorter list (three harness
cases). *Not built, with reasons, in `ai-intent-router.md` §6.3:* the schema-constrained model
call for non-decisive messages (rules alone clear both targets on the held-out half, and every
model-backed classifier-adjacent feature measured here was dead), clarify BUTTONS (a notice; the
person rephrases), and `formula`/`analyze` as direct `formulaAssistService`/`insightsService`
calls (the §5 blockers stand: `registerChatPromptSink` still has no caller and the design-query
assistant still has no headless seam).

**THE TWO MEASUREMENT-HYGIENE ITEMS — `npm run eval:all` and per-task `finishReason` — CLOSED
2026-09-17, and the first suite-produced baseline is on record.** `tests/eval/suite.mjs` is the
suite as DATA: every runner, every knob it reads, pinned to the 2026-09-15 bake-off arm —
explicitly, even where equal to the runner's default, so a default that changes in a runner cannot
change what `eval:all` measures — and `lib/evalSuite.test.mjs` holds the pins to the runners'
`arg("…")` lists in both directions. `run-suite.mjs` resolves and hashes the GGUF, starts the
product's own `llama-server` on the product's flags (`serverArgs` is diffed against
`ai/runtime.rs engine_args` by the test) on a FREE port, runs the runners one after another, stops
it, and writes `runs/<date>--all--<model>.json` naming the machine, the binary build, the model's
sha256, the server's `/props`, every argv and every summary. *What it closed that the item never
named:* the server behind every on-board number so far had been started BY HAND with a GGUF picked
by hand, and no artifact recorded which one answered — the bake-off arms were labelled by what the
runner was TOLD (`--model calcula-builtin`), not by what served. An override
(`npm run eval:formulas -- --retrieval 0`) REPLACES its pin — the runners read the FIRST occurrence
of a flag, so an appended override is a silent no-op — and demotes the run to `out/` unless
`--keep`, because a pinned run is evidence and an overridden one is an experiment.
`evalKnobs.test.mjs` now covers all seven runners (two before), and `max-tokens` is a knob: it
decides truncation, and truncation is graded as failure. Every artifact carries `finishReason` per
task (`truncated` on infill), and `compare-runs.mjs` marks a discordant pair whose loser was cut
off with `*` and a caution instead of counting it as evidence about the model. *Found on the way:*
the narration runner read `CARGO_TARGET_DIR` from ambient shell state and reported its helper
missing from an npm shell while it sat built in `%LOCALAPPDATA%` — `lib/grader.mjs
resolveExample` now resolves every Rust helper the way the grader is resolved — and the formula
artifact now records the grader's build, since the re-grade that paid +2 made it a variable of the
score. Five sabotages (a dropped pin, a changed server flag, a renamed npm script, a dropped
per-task field, an appended override), each redding its own assertion.

*First baseline from the suite, 2026-09-17, the incumbent 1.5B, 41 min wall clock on a Snapdragon
X Elite (12 cores):* intents macro 98.9 % (213/214, decisive precision 100 %); formulas 64/181
(35.4 %, median 2.5 s, 4 cut off and now NAMED — `textsplit-country-after-last-comma`,
`date-edate-contract-renewal-term`, `date-yearfrac-actual-365-loan`,
`rank-average-rank-four-way-tie`, all four failures); design queries 38/122 (31.1 %, 122/122
compiled, median 1.8 s); scripts 3/37 single-shot (mean score 0.495, 2 cut off) — the first
number for that surface on the on-board model; narration 1/5 clean, 10 invented, median 11.7 s
(gate FAIL); next-edit exact 0/292, rules 61/292, median 351 ms (gate PASS); macro-fim 26/141
(18.4 %), median 348 ms (gate PASS). Every figure agrees with its recorded predecessor within noise
(formulas 63 re-graded → 64, design queries 35 → 38), which is the point: the pins reproduce the
arms.

*Next, in order — the fine-tune milestones decided 2026-09-17 (base: a Tier-1 candidate, chosen
by measurement; Tier 0 has no model):* **FT1**, the demonstration curve — 6 → ~20 compiling
examples on the design-query prompt, paired on the incumbent and granite-4.0-1b — as the go/no-go
(rising: headroom; flat: a caution, not a verdict, since small models use long contexts poorly);
**FT0**, the synthetic generator with a contamination guard against the eval corpora; **FT2**,
base selection by training one recipe on two Apache-2.0 candidates on the owner's GPU box (the
origin question recorded there as an owner decision); **FT3**, the third bake-off arm on all six
surfaces under the pre-registered rule; **FT4**, ship with the recipe published and a drift guard
in CI.

**A THIRD SCHEMA is no longer the open question it was.** The second one settled it: `renamed_star`
is a controlled rename of the same star — same rows, same questions, different vocabulary — and
English scored 13/30 vs 12/30 with four tasks FIXED by the rename, the scatter of noise rather than
the signature of memorisation. The design-query numbers are about the DSL. `gen-renamed-star.mjs`
regenerates it from the corpus, so it grew to 122 alongside; a third schema would buy breadth, not
validity, and is no longer on the critical path.

**2.AI.11 — Next-edit suggestions: A, B and C SHIPPED 2026-09-11; D measured, not built.**
A is Tier 0 and on, B is the model's chip (measured and OFF), C puts A in the text and at another
line, D is the macro fill-in-the-middle measurement. Design: `insights-strategy-layer.md`
§14.5, §14.6 and §14.7. The owner asked whether Calcula's AI would
behave like GitHub Copilot's Next Edit Suggestions for the design query language and for macros.
It did not: every AI surface built so far is request-shaped (type a sentence, press Draft, wait one
to three seconds, get a whole artifact), while NES is edit-triggered, predicts an edit at another
location, and answers in a few hundred milliseconds. Measured on the built-in runtime 2026-09-11
with the prompt prefix cached, an infill completion of one clause takes 100–360 ms and a
grammar-constrained chat completion 33–150 ms, so SPEED was never the obstacle for this language;
the raw model inventing keywords was. Three owner decisions: **D8** the design query first and
macros as a separate later milestone; **D9** suggestions everywhere the DSL is edited, starting as
a row of accept-able chips BELOW the editor (in-editor ghost text and edits at another location are
a later iteration, and the owner has further ideas for a richer strategy — the rule engine is a
list so each is one more entry); **D10** no in-app 7B download, because almost nobody can run one
today and a 7B belongs with the user's own runtime (Ollama and the like) between the small local
models and the cloud.

*Milestone A is Tier 0 — rules over the strategy, no model at all.* `@api/designQueryAssist/nextEdit.ts`
holds seven pure rules over a neutral `QueryFacts` shape (`@api` may not import the DSL parser);
`_shared/dsl/pivotLayout/nextEditFacts.ts` parses the text into those facts and applies the chosen
edit to the TEXT, never by re-serialising the person's query; `NextEditRow.tsx` renders at most three
chips, each with the sentence naming the strategy field it read. It mounts under the shared editor
(Report from Design Query, the edit-report dialog, the chart data tab) and on the model pivot's
Design tab. **Measured, Layer A over the same 40-task corpus:** zero suggestions on any of the 44
complete correct references and alternatives (the gate), and a prefix recall of **21 of 86 (24.4 %),
every hit from the one rule that supplies a missing VALUES**. That number is the argument for
Milestone B: rules can supply the measure the strategy ranks first and can never guess which
dimension the person wanted.

**2026-09-14 — the row was measured SILENT on a finished query, and that is now fixed.** The owner
reported the chips appearing only rarely and asked whether the strategy was too thin. Measured, not
argued: over the corpus only three of the seven rules ever fire (`add-values` 63, `add-coarser-time`
10, `key-to-label` 1), **0 of 52 complete correct queries produced a chip**, and stripping `strategy`
to `null` changed the chip-bearing prefix count NOT AT ALL (67 of 86 either way; only `key-to-label`
moved, 1 -> 0). The strategy was not the cause. Every rule was CORRECTIVE by construction — each
fires only because the query is incomplete or contradicts the strategy — and the corpus gate
actively FORBADE a chip on a correct query, which is why an earlier "also analyse by" rule was
deleted by name for firing on 44 of 44 references.

So a second family was added: **explorations** (`NextEditRole`), seven rules that fire on a query
that is already right — a second breakdown on COLUMNS, a time axis the model has and the query
ignores, a ranking, the strategy's next-ranked companion measure, share-of-total, a hierarchy level
to drill into, and a sort. **Measured: 221 offered across 55 correct queries, all seven kinds**,
against 0 before. They are held to a DIFFERENT standard than corrections, and the gate is now two
tiers: a correction on a correct query is still zero-tolerance, while an exploration must only ADD
(never remove what the person wrote) and must TERMINATE — a walk that keeps accepting the top
exploration has to run out of ideas, which a sabotage removing one rule's stop condition reds on 47
queries. Three policies keep them from nagging: they are never offered while a correction is
outstanding, they are capped below every correction's priority, and they never reach the ghost text
(owner decision: a chip can be ignored, text at the cursor cannot). One consequence recorded rather
than discovered: the row asks the model only when the rules left a free slot, so with explorations
filling a finished query the Milestone B chip no longer appears there — acceptable, since it is off
by default on a measurement of 0 of 80.

Also fixed while measuring: `tests/eval/lib/modelFixture.mjs` hardcoded `hierarchies: []` while
`sales_star.json` declares a real one, so every drill-down path was silently untestable and the
eval runner was blind the same way.

*What the adversarial review changed, and it was most of the value.* Six reviewers over six
dimensions produced 39 findings; 18 survived three independent refutation attempts each. Five were
defects a user would have suffered: an apostrophe in a bracketed field name (`[Customer.Owner's Key]`)
put the field splitter into a quote state the closing bracket never ended, so ONE accepted edit
deleted every later field in that clause; a `#` comment line was treated as a continuation of the
clause above it, so removing that clause's last field deleted the comment; the time rule looked for
the year on ROWS only, so it called the most ordinary shape in the language — months down, years
across — wrong and its edit put the year on BOTH axes; the same rule claimed to fix years on a
calendar whose columns are named `MonthNumberOfYear`/`WeekNumberOfYear`, where no year column is in
the list at all; and the chip's compile veto used an absolute bar, so every query using the Reports
`@Name` parameter binding failed it and the whole row vanished. Four more were contradictions
between rules (key-to-label proposing the very column never-slice-by would then demand you remove;
remove-filtered-axis and add-rows walking the person in a circle; two rules rendering one edit as
two identical chips) and three were spellings the pivot's own serializer writes (`LOOKUP Table.Column`,
a quoted name, a schema-qualified `BI.dim_product.Name` split at the first dot rather than with
`splitBiFieldKey`) against which every edit silently did nothing. All are fixed, each with a test,
and fifteen sabotages each redded its own named test. Two further defects fell out of the work
itself: `@api/pivotTypes.ts` and `_shared/components/types.ts` both mirror the Rust
`BiPivotModelInfo` and `strategy` had reached only the second, so the facade's own type could not
see a field the wire was already sending (`biPivotModelInfoMirrors.test.ts` now diffs the two field
lists); and the pivot's Design tab briefly had its own `get_connection_bi_model` fetch, which was a
second full-model round trip per pivot open, never refreshed on `bi:model-changed`, and could hand
one connection's strategy to another connection's pivot — `PivotEditor`'s existing `liveModelMeta`
fetch now carries the strategy instead and the Design tab is passed `fieldListModel`.

*Milestone B is BUILT, MEASURED and OFF (2026-09-11).* Design: `insights-strategy-layer.md` §14.6.
The model's chip goes through the existing completion seam — no new command — with
`buildNextClauseRequest` assembling prompt, names and grammar in one place and
`nextClauseSuggestion` reading the reply in one place, so `tests/eval/run-next-edit-eval.mjs`
drives the product's pipeline rather than a copy. `rulesChips` moved out of `NextEditRow.tsx` into
`nextEditFacts.ts` for the same reason: the row, the corpus gate and the runner now run ONE chip
loop. **Measured on the built-in runtime over every prefix of the 52 correct corpus queries:
exact next clause 0 of 80 — with a CEILING of 79, since one task's correct answer is refused by the
row's own veto (below) — against 19 of 80 for the rules alone, so the model added nothing; quiet on
a finished query 0 of 52, it proposed a clause every single time; median 686 ms, p90 848 ms against
the milestone's 400 ms gate.** So `MODEL_CHIP_DEFAULT` is `false`: built, wired, off, and the runner
decides when a better model earns it (D10 puts that between the small local models and the cloud).
The runner refuses to run unless it can score its own oracle — each reference's own next line
through the same scorer — and exits 3 if it cannot, because a broken scorer reports a flawless
zero. Two defects surfaced on the way: the prompt told the model it could reply with nothing while
the grammar's root demanded a clause, so the no-clause rate was zero by construction (the root is
now `root ::= nextclause?` and a probe confirms the runtime returns the empty string with finish
reason `stop`); and every clause repetition was an unbounded `*`, which the 1.5B filled with every
measure it had been shown, so all are now `{0,3}` — the widest clause in the corpus lists two, and
a paired drafting run either side of the bound (16/40 passed, 40/40 compiled both ways) says the
shared grammar lost nothing. The corpus gate had also re-implemented the row's veto with a stricter
absolute bar, which hid an `ALSO_CORRECT` fixture naming a column the model does not have
(`Date.Quarter`); both fixed.

*A defect the Layer B harness surfaced, filed not fixed.* **The DSL teaches three layout directives
its own compiler warns about.** `DSL_LAYOUT_DIRECTIVES` lists `subtotals-top`, `subtotals-bottom`
and `subtotals-off`; the next-clause prompt's cheat sheet names `subtotals-off` explicitly; the
grammar therefore lets a model emit it; a corpus reference (`cost-by-category-subtotals-off`) uses
it as the RIGHT answer; and `canonical.ts` deliberately carries `subtotals-*` through as
"unrepresented" directives. But `compileLayout` (`_shared/dsl/pivotLayout/compiler.ts:340`) has no
case for any of the three, so all three fall to `default` and emit `Unknown layout directive`. The
consequence for the next-edit row is concrete: its veto refuses a chip that adds a new warning, so
the one corpus task whose correct next clause is `LAYOUT: subtotals-off` is unreachable for ANY
model — the runner now prints that as a ceiling of 79 rather than 80 instead of scoring it as a
miss. Not fixed here because it is not a one-liner: `LayoutConfig` (`@api/pivotTypes.ts:184`) has no
subtotals field at all — `showSubtotals` and `SubtotalLocationType` are per-FIELD — so honouring the
directive means applying it across the row and column field configs, which is a pivot change rather
than a DSL one.

*Milestone C SHIPPED 2026-09-11 — in the text, and at another line.* Design:
`insights-strategy-layer.md` §14.7. The suggestions now appear as ghost text on the line being
typed, and where the strategy wants a change elsewhere, as a hint at the cursor that jumps to it —
which is the Next Edit Suggestion behaviour the owner asked about. Still Tier 0: §14.6 measured the
model at 0 of 80, so nothing here asks it. Monaco 0.55 implements the shape natively
(`isInlineEdit`, `hint.jumpToEdit`, Tab bound to `editor.action.inlineSuggest.jump`), so no
decorations or widgets were needed; what was needed was obeying its narrow range contract, which
`nextEditInline.ts` does by expressing every suggestion as a replacement of ONE whole line — an
insertion anchored to the line above so the old text is a prefix, a rewrite declared an inline edit,
and a line-DELETING suggestion reported rather than shown (it is a two-line range however it is
sliced) so it keeps the chip row. **A latent bug blocked it and is now fixed:** a Monaco provider is
registered per LANGUAGE, and the DSL language module kept its completion context in module-level
"current" fields written by whichever editor rendered last — so a Reports dialog open over a pivot's
Design tab made one of them autocomplete against the other's schema. `dslModelContexts.ts` keys a
context per model URI and both hosts register their own. `pivotDslLanguage.ts` had no test file at
all; the registry and the suggestion decision now live in monaco-free modules under 35 tests, and
six sabotages each redded their own named test.

*Milestone D MEASURED, NOT BUILT 2026-09-11 — the number decides the milestone.* The plan called for
a fill-in-the-middle corpus before any code, and that is what exists:
`tests/eval/run-macro-fim-eval.mjs` holes out each eligible line of the 37 script references in
`tasks.json` (141 tasks, from the second line on — an empty prefix asks a model to invent a file,
not fill a gap) and asks llama-server's `/infill` for it. It refuses to run unless prefix + the right
answer + suffix rebuilds the original byte for byte, because otherwise every task is graded against
a file the corpus never held. **Measured on the built-in runtime, with the number that matters being
what the API surface buys:**

| surface budget | reachable | exact | median | p vs 600 |
|---|---|---|---|---|
| off | — | 8 of 141 (5.7 %) | 712 ms | 0.0001 |
| 300 tok | 38/103 | 13 (9.2 %) | 924 ms | 0.0018 |
| **600 tok** | 42/103 | **25 (17.7 %)** | **1033 ms** | — |
| 1500 tok | 60/103 | 20 (14.2 %) | 1360 ms | 0.1797 |
| 2500 tok | **98/103** | 26 (18.4 %) | 1558 ms | **1.0000** |

"Reachable" is how many of the 103 answers naming a `context.<chain>` had every chain they name in
the surface actually sent — a ceiling the runner now prints, because scoring an answer whose
vocabulary was withheld is scoring the harness. **The obvious story is wrong, and the 2500 row is
what refutes it.** `rankSurface` puts the capability chains ahead of every grid member, so no budget
below 1500 carries a single `api.*` method and `getCellValue`/`setCellValue` first appear at 2500 —
yet covering 98 of 103 answers instead of 42 moved the score by ONE task (p = 1.0000). Vocabulary
coverage is not the binding constraint. What the first ~600 tokens buy is the capability names and
the `onClick` idiom, and the flipped tasks say so exactly: `cap-fetch-rate`, `cap-schedule-refresh`,
`cap-dialog-*`, `cap-two-capabilities`, `cap-form-*`, plus `trap-office-js-idiom`,
`trap-browser-fetch`, `trap-window-alert`. Past that the model cannot infer the line however much of
the API it holds — so there is no point investing in better retrieval for this at this model size,
and the obvious nudge confirms it: hints re-ranked from the open buffer measured WORSE (18 of 141,
p = 0.0391). The naive "repeat the line above" floor is 0 of 141, but structurally so: the
eligibility filter removes every repeated line, which are all closers, so it licenses nothing.
**Fill-in-the-middle cannot go through the existing seam:** `/infill` is at the ROOT while the
runtime's base URL hardcodes `/v1`, `ChatRequest` has no prefix/suffix fields and its URL is a closed
two-armed match, and `--jinja` wraps a chat request in Qwen's template, which destroys the FIM
conditioning outright (measured: the same bytes came back as a conversational fenced block through
chat and as a cursor continuation through `/infill`). **And the runtime shape rules out automatic
ghost text** more than the score does: `-np 1` means one slot, an infill fired during a chat
generation measured 3238 ms, and `ai_chat_cancel_stream` reaches only the streaming path — so a
superseded keystroke holds the slot to completion. An ON-DEMAND completion is the shape the
measurement supports; a new `ai_infill_complete` command is the minimum surface, and it is not
written until that is the call. FIM is also not portable: Ollama serves it only on its native
`/api/generate` with a `suffix` field, and the cloud providers have none.

*Still open here:* Milestone D's product surface, on the decision above; and NES-grade next-edit
prediction for TypeScript, which needs an edit-sequence-trained model, is 7B class, and stays with
the user's own runtime by D10. Also unresolved and worth a look before quoting a latency: this
machine now measures the DRAFTING eval at a ~4 s median where §14.3 recorded 1.0 s, on the same
pinned runtime and model and with the bound proved innocent by a paired run — so one of the two
numbers was taken under conditions nobody wrote down.

**Step 4's GUARD landed 2026-09-11; its narrator did not.** Design: `insights-strategy-layer.md`
§15. The rule this programme has stated from the start — "every sentence tagged with the fact ids it
covers, and a sentence citing a number that is not in its cited facts is dropped" — is now
executable in `core/insights/src/narrate/cite.rs`. It lives in Rust beside the facts, not in the
renderer, because the number formatting is there (a checker that disagreed with `number.rs` by a
decimal place would delete the engine's own correct sentences) and because it is a safety check on
model output, which the renderer must not be able to bypass. It never parses a number back out of a
sentence; it RENDERS every number a fact holds through the narrator's own `num`/`count`/`pct`/
`signed_pct`/`ratio` and compares strings, so the allowed set cannot drift from the formatter.
**The oracle is the deterministic narrator**: all 20 fact kinds, both locales, not one sentence
rejected. Two allowances exist only because that test demanded them (`|v|` for Trend's
`num(slope.abs())`, `v + 1` for Duplicates and Leader), and a sabotage exposed that the shared
all-kinds fixture carries a POSITIVE slope, so the `abs` allowance could be deleted with everything
still green — hence a dedicated falling-trend test. Five guards, each sabotaged, each redding its own
named test. **A defect in the way is fixed:** the model path's `facts_json`, whose doc comment reads
"what a Tier-1 narrator is given to work from", emitted a bare array of kinds with NO IDS, against
2.AI.5's explicit promise — so the model half could never have been narrated safely, and nothing
said so because the field has no consumer yet.

**And then Step 4 was MEASURED, and the narrator does not ship (2026-09-11).** `narrate/prompt.rs`
asks for `{sentences:[{text,factIds}]}` under a JSON schema, stating the two rules the checker
enforces so a model is not punished by a rule nobody told it;
`tests/eval/run-narration-eval.mjs` drives it over five real bundles (41 facts, 12 kinds, the real
engine over synthetic datasets) and pushes every reply back through the real check via the
`narration` example — no JavaScript port of a check that has to agree with `number.rs` about
rounding and the sv-SE non-breaking space. On the built-in 1.5B:

| | en-US | sv-SE |
|---|---|---|
| bundles with a showable sentence and nothing invented | 1 of 5 | 0 of 5 |
| sentences surviving the check | 3 of 9 (33 %) | 6 of 23 (26 %) |
| **numbers the cited facts could not account for** | **5 of 9 (56 %)** | **17 of 23 (74 %)** |
| coverage of the ranked facts | 27 % | 17 % |
| median latency (gate: 8 s) | 30.4 s | 34.4 s |

**The bigger finding is about the guard, not the model.** Across the two runs the check deleted
**22 fabricated numbers**. A narration feature built on this model without it would have shown a
reader invented figures in more than half its sentences, in the product's own voice, beside the
cells they supposedly came from. Every run also proves the harness first — the deterministic
narration of all five bundles goes through the same check and the run exits 3 if any of it is
rejected, because a narrator that only prints numbers its fact contains is the definition of what
must pass. All 41 survive.

*Still open here:* a surface that shows narrated sentences, and a model worth pointing it at.
`MeasureStrategy.context` STILL has no reader: the checker does not read prose, the narrator that
would is not shipping, and that is still the commit which must add the source-scan guard §2
describes.
Recorded but not changed: `describeBundleForModel` (`app/src/api/insightsService.ts`) is the only
live path handing a bundle to a model and it builds from `bundle.markdown` — the already-narrated
sentences — so the chat paraphrases our prose instead of reading the numbers, which is what
`facts_json` exists to prevent. Changing it changes what the chat says, so it wants a measurement.

Still open, in order: the rest of **Step 4** above. **Step 5 (M4, the router) SHIPPED 2026-09-16**
— the record is under 2.AI.12 and `ai-intent-router.md` §6; the corpus came first
(`tests/eval/intents.json`, 214 rows), the five defects the design listed are closed (§6.4), and
what it left is §6.3: no model call for non-decisive messages by decision, a clarify notice
rather than buttons, and `formula`/`analyze` through the tool loop rather than direct seams
because `registerChatPromptSink` still has no caller and the design-query assistant still has no
headless seam. Also: Vulkan (D7 says after measurement; the CPU numbers above are the ones to
beat); an offline-installer build (`tauri.offline-<arch>.conf.json` exists, no workflow leg builds
it); `builtin-runtime.spec.ts` in E2E (passed 2026-09-10 against a real debug build: the app
starts its runtime on the first completion, answers a grammar exactly, stops it) needs the fetched
runtime and model on the machine that runs it and skips, saying so, without them — the nightly
runner has neither yet; a pivot's cached metadata carries no strategy summary (the
cache holds no model), so the pivot Design tab's row drafts without the strategy's ranking; and an
inclusion filter (`= ("x")`) compiles to no filter when the compiler has no member list, which is
the existing report behaviour and is why grading uses the parsed form.

**2.AI.13 — Insight overlays: points of interest drawn on charts, pivots and sheets. BUILT
2026-09-17, IO-0 through IO-5, in one session; CLOSED here, with what is still owed listed.**
Design and record: `docs/design/insight-overlays.md` (§5a–§5d are the per-milestone records;
§4.8a the owner's interaction model). **Tier 0 throughout**, as designed: the finding is a fact
`core/insights` computes, the colour is the strategy's declared direction (or neutral when it is
withheld or absent — red is never inferred), the position is the chart's own hit geometry or the
sheet row the facts document names, and the callout is the narrator's sentence. What was built:
every fact index now counts the GAPS of the series as supplied (a latent one-row-early defect in
change points and outliers, fixed); the chart route takes a strategy context for design-query
charts (`series_strategy.rs`); the cue rules are data (`@api/insightCues`, harmful-cue gate,
Rust-pinned fixture); the overlay is a transient lens (`@api/chartCues`, `@api/cellCues`) painted
at composite time, stepped one point at a time with a deterministic description, hit-testable,
with comments as overlay objects that FOLLOW THE DATA by fact id (the three outcomes of §4.8a);
*Keep in chart* writes a `marker` or `text` layer; *Snapshot* copies chart + overlay to the
clipboard while *Export* stays clean (D-IO-8); the sheet and pivot targets share one over-selection
cell decoration (no pivot seam was needed); `show_points_of_interest` is the chat's first
client-side tool; the overlay's style is a document setting the publisher owns, published with
the application (D-IO-11). PROVED LIVE by `app/e2e/journeys/insight-overlays.spec.ts` with two
stored baselines. The member-based pivot route (IO-6, §5e) followed the same day: a BI-backed
pivot takes the MODEL's facts with the strategy's polarity, matched to its cells by the labels
its headers show (`@api/pivotCues`), PROVED LIVE by `insight-overlays-pivot.spec.ts` on the
sales-star fixture through a CSV source (Gadgets × 2025-12 marked bad, the cue follows a filter).
That proof found and fixed two defects: `run_model_insights` lost EVERY measure when one series
query was refused (now a note, like the slices), and a pivot filter through the API announced
nothing (`PivotEvents.PIVOT_VIEW_UPDATED` now fires from `cachePivotView`). **Still owed**: a
value-axis `rule` through the rule painter, Pareto member positions; and, for `model-engine-lib`,
a derived measure with no home table (`Margin = [Revenue] - [Cost]`) resolves to an EMPTY table in
the planner's `measure_tables` and is refused with `Table '' has no registered source` — the
sales-star fixture's own measures hit it. D-IO-10 (a comment follows the FACT, not the label) is
built as proposed and confirmed by the owner in passing ("proceed").

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

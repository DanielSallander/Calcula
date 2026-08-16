# Open-items §1 — the six owner calls, decided and built (2026-08-16)

**What this is.** The as-built record of the six items that stood in
`docs/design/open-items.md` §1 ("Owner calls — decisions, not work") on
2026-08-16. Five were decided and built; the sixth was analysed and left open by
the owner's explicit instruction. `open-items.md` is the live list and this file
is the reasoning behind the rows it now closes.

**The standing rule, unchanged since D1-D7.** *"Excel parity takes priority
always when there are such questions."* Four of the five decisions are direct
applications of it; the fifth (1.2) is the one case where parity argues for
**not** adding the feature.

**Evidence discipline.** Every behaviour claim below is either a passing test
named in the text or a measurement stated as one. Where a claim is asserted from
documented Excel behaviour rather than measured against a live Excel, it says so.

---

## 1.1 Currency negatives — a leading minus, and Excel's four entries

### The decision

Do it exactly as Excel does. `format_currency` wrapped **every** negative in
parentheses, with no test of the format at all
(`core/engine/src/number_format.rs`, the old body was
`format!("({})", with_symbol)`). Excel's Format Cells > Currency category
DEFAULTS to the **single-section** code `$#,##0.00`, and a single-section code
renders a negative with a leading minus.

Stated precisely, because the obvious over-claim is false: Excel does have
parenthesising currency presets — `Ctrl+Shift+# Open-items §1 — the six owner calls, decided and built (2026-08-16)

**What this is.** The as-built record of the six items that stood in
`docs/design/open-items.md` §1 ("Owner calls — decisions, not work") on
2026-08-16. Five were decided and built; the sixth was analysed and left open by
the owner's explicit instruction. `open-items.md` is the live list and this file
is the reasoning behind the rows it now closes.

**The standing rule, unchanged since D1-D7.** *"Excel parity takes priority
always when there are such questions."* Four of the five decisions are direct
applications of it; the fifth (1.2) is the one case where parity argues for
**not** adding the feature.

**Evidence discipline.** Every behaviour claim below is either a passing test
named in the text or a measurement stated as one. Where a claim is asserted from
documented Excel behaviour rather than measured against a live Excel, it says so.

---

## 1.1 Currency negatives — a leading minus, and Excel's four entries

### The decision

Do it exactly as Excel does. `format_currency` wrapped **every** negative in
parentheses, with no test of the format at all
(`core/engine/src/number_format.rs`, the old body was
 applies one, and OOXML builtin
numFmtIds 5-8 are the parenthesised codes this same pass teaches the importer to
read. What no Excel preset does is what Calcula did: parenthesise a
SINGLE-SECTION code. (Excel behaviour here is asserted from Microsoft's
documentation and the OOXML builtin table, not measured against a live Excel.)

### It was also a round-trip lie, which is what makes it a defect rather than a preference

`xlsx_writer` has always emitted `$#,##0.00` for a `NumberFormat::Currency`. So a
workbook that showed `($1,234.56)` in Calcula reopened in Excel as
`-$1,234.56` — the file and the screen disagreed, and nothing said so.

The same disagreement existed **inside the dialog**: `preview_number_format`
routes a typed code through the custom-format engine, which prepends `-` for a
single-section format, so the Format Cells preview already showed `-$1,234.56`
for the very code the preset applied as `($1,234.56)`.

### What was built

`NegativeStyle` (`core/engine/src/style.rs`) — Excel's four "Negative numbers:"
entries as a named enum, with `NumberFormat::Currency` gaining a
`#[serde(default)] negative_style` field:

| variant | Excel's format code | renders `-1234.5` as |
|---|---|---|
| `Minus` (default) | `$#,##0.00` | `-$1,234.50` |
| `Red` | `$#,##0.00;[Red]$#,##0.00` | `$1,234.50` in red |
| `Parentheses` | `$#,##0.00;($#,##0.00)` | `($1,234.50)` |
| `RedParentheses` | `$#,##0.00;[Red]($#,##0.00)` | `($1,234.50)` in red |

`Red` deliberately carries **no sign** — that is Excel's behaviour, not an
omission: the negative section supplies the whole rendering.

**Why a structured field and not a `Custom` format code.** Expressing the three
non-default entries as `NumberFormat::Custom` was tempting and is wrong for three
concrete reasons: (i) the Currency category would stop recognising its own
formats and reopen them as "Custom" with a raw code in a text box — the
"a surface cannot report its own result" defect that BUG-0065 and BUG-0069 each
were; (ii) currency symbol letters are format tokens (`EUR`'s `E` is scientific
notation before `+`/`-`; `d`/`m`/`h`/`s`/`y` are date tokens), so only a *quoted*
symbol is safe and the locale hands through raw symbols including `" kr"`;
(iii) `Accounting` needs the split `AccountingParts` rendering, which the custom
engine cannot produce.

**Red rides the colour channel** that already existed for `[Red]` in custom
formats (`format_number_with_color` → `FormatResult.color`), so the two red
entries are honest on screen rather than silently identical to their black
siblings.

### Everything it touched

| surface | change |
|---|---|
| `core/engine/src/style.rs` | `NegativeStyle` + the 4th field on `Currency` |
| `core/engine/src/number_format.rs` | `format_currency` branches; a red-negative arm in `format_number_with_color` |
| `core/persistence/src/xlsx_style_reader.rs` | builtin numFmtIds 5-8 import as parenthesised (odd = plain, even = red); `negative_style_of_code` reads a custom code's NEGATIVE SECTION |
| `core/persistence/src/xlsx_writer.rs` | emits all four codes |
| `app/src-tauri/src/api_types.rs` | the display name carries the entry |
| `app/src-tauri/src/commands/styles.rs` | preset suffixes (`_neg_red`, `_neg_paren`, `_neg_red_paren`); a two-section currency code parses back to `Currency` instead of degrading to `Custom` |
| `app/extensions/BuiltIn/FormatCellsDialog` | a "Negative numbers:" list beside the symbol list, exactly as Excel lays it out |

**Accounting was deliberately not touched.** Excel's accounting code
`_($* #,##0.00_);_($* (#,##0.00);…` carries a parenthesised negative section and
offers no choice. Pinned by `accounting_negatives_stay_parenthesised`.

### A rounding subtlety worth naming

`format_currency` formats `value.abs()`, so a value that ROUNDS to zero
(`-0.001` at 2 decimals) has already lost its sign in the digits. Testing
`value < 0.0` alone would hand it a minus or a pair of brackets back, and paint
it red. Excel prints `$0.00`. Pinned by
`a_negative_that_rounds_to_zero_is_not_signed_bracketed_or_reddened`.

### Two adjacent defects found and fixed in the same files

1. **OOXML builtin accounting ids 41-44 imported with the wrong decimals and an
   invented symbol.** Both axes were read off `% 2`, which is right for the
   symbol and wrong for the decimals — the spec varies decimals in PAIRS
   (41/42 = 0, 43/44 = 2) and the symbol alternately. So 42 arrived with two
   decimals, 43 with none, and 41/43 were given a `$` their code does not
   contain. Pinned by
   `builtin_accounting_ids_41_to_44_carry_the_right_decimals_and_symbol`.
2. **`negative_style_of_code` was wired to the POSITIVE section**, so it always
   answered `Minus`. Caught by the adversarial verification pass, not by the
   author — the function was correct in isolation and dead as wired, which is
   the failure mode a unit test on the helper alone would have missed. Now
   pinned by `a_parenthesised_currency_code_imports_as_a_parenthesised_currency`,
   which asserts through the CALLER — the unit test on the helper alone
   (`a_currency_codes_negative_section_decides_its_negative_style`) stays green
   when the wiring is reverted, which is the whole point of the finding.

### The visual goldens — checked, and none moved

All **72** committed baselines were examined (42 in `e2e/tests`, 27 in
`e2e/visual`, 3 in `e2e/scenarios`). **No golden contains a negative currency.**
The only number-format golden, `grid-fmt-number-formats`, uses `number_sep`,
`percentage`, `date_iso` and `number_sep`; its one negative row is `-500` under
`number_sep`, which this change does not touch. Nothing needed re-baselining.

That is also a finding rather than a relief: a whole-grid golden is
1218×542 px against a flat `maxDiffPixels: 200` cap, so a glyph-level change in
one cell sits right at the edge of the budget and **cannot be relied on** to
catch a currency-rendering change either way. The teeth for this item are the
Rust unit tests and the new E2E journey, not a screenshot.

---

## 1.2 The 1904 date system — add no setting (D9 closed)

### The decision

**Add none**, as recommended. The item is closed as a decision, not as work.

Three arguments, in the order they matter:

1. **The 1904 system exists to paper over a bug Calcula deliberately keeps.**
   Its purpose in 1985 was to let the Macintosh avoid Lotus 1-2-3's fictitious
   1900-02-29. Calcula *reproduces* that fiction on purpose, for Excel serial
   parity (`is_leap_year_excel`, `core/engine/src/date_serial.rs`), so it has no
   motive to offer the escape hatch.
2. **It is the classic silent-corruption switch.** Toggling it changes what
   every date in a workbook means without moving a single stored value, and
   1462 days off is still a perfectly valid date. A setting whose failure mode
   is "all your dates are now wrong and nothing said so" is exactly what the
   correctness programme spends its time removing.
3. **Round-trip fidelity does not need it.** A 1904 file is read correctly and
   written back as 1900 with the attribute omitted. The only thing lost is the
   FLAG, and the flag carries no user intent — nobody chooses 1904, they inherit
   it.

**What would change the answer:** a user who must hand a file back to a
Mac-authored process that asserts on `date1904="1"`. That is a WRITE-side
concern — an export option — not a document setting.

### The work: turning three prose claims into checks

A decision recorded only in prose decays into a rumour. Three guards:

| guard | file | what it pins |
|---|---|---|
| `no_calendar_epoch_setting_exists_outside_the_xlsx_importer` | `app/src-tauri/src/document_effect.rs` | the app crate contains no date-system flag, in code (comments stay legal) |
| `a_1904_workbook_is_exported_as_1900_with_no_date1904_attribute` | `core/persistence/src/xlsx_writer.rs` | D9's argument 3: the export omits the flag AND the date was normalised exactly once |
| `the_date_system_offset_is_the_engine_calendars_1904_epoch` | `core/persistence/src/xlsx_writer.rs` | `DATE_SYSTEM_OFFSET` equals `date_to_serial(1904,1,1)` — the persistence constant and the engine calendar that produces it |

**The census assembles its needles rather than writing them out.** A census that
names what it forbids matches *itself*, and the obvious repair — exempting the
file it lives in — would blind it to a setting genuinely added to that module.
Building `"date1904"` as `format!("date{}", 1904)` keeps the census total: every
file in the crate is searched, including its own.

**Sabotage-checked.** Inserting `pub const SABOTAGE_date1904: bool = false;` into
`locale_commands.rs` made the census fail naming that exact file and line; the
line was then reverted. A census that has not been made to fail is a census
nobody knows the state of.

**The read side needed nothing** — `the_1904_date_system_is_honoured_on_import`
and its two siblings already pin the epoch, a real date, a plain number that
must NOT move, a bare time, an elapsed duration and all four boolean spellings.

---

## 1.3 The `"system"` locale reads Windows' regional settings

### The decision

Read the OS on the `"system"` path; keep the fixed per-locale-id table as the
base to overwrite onto, as the per-field fallback, and as the whole answer for an
**explicit** override (`set_locale("de-DE")` still means Germany, not
Germany-as-configured-here).

### Two live defects this closed, both found by the survey rather than assumed

1. **Calcula was reading the wrong Windows setting entirely.**
   `sys_locale::get_locale()` is `GetUserPreferredUILanguages` — the language
   Windows draws its own menus in. Separators, date patterns and the currency
   symbol come from the **regional format**, a different setting. An
   English-display machine with a Swedish region — a common configuration — got
   `en-US`: `.` decimals and `,` formula separators, while Excel beside it used
   `,` and `;`.
2. **`set_locale("system")` silently returned en-US.** `from_locale_id("system")`
   matched no arm, and `"system".split('-').next()` is `"system"` again, so even
   the language-fallback recursion could not fire. Only `locale.ts` avoided ever
   sending the string.

And a third, user-visible: **"System default" was not a re-read.** It re-reported
whatever had been captured at launch, so a user who changed Windows Region and
came back saw a stale value with no way to refresh short of restarting the app.

### Where it lives, and why

`app/src-tauri/src/os_locale.rs`. `core/engine` is a pure library — its manifest
is `serde`, `rustc-hash`, `parser`, `identity` — and it is linked by the
`.cala`/`.calp` format crates, which have no business knowing what machine they
are on. `app/src-tauri` is the Windows-native layer that already owns three
Credential Manager modules, and it is the only crate that both links `windows`
and depends on `engine`. Cost: one feature flag
(`Win32_Globalization`), no new crate. `sys-locale` was removed — it had exactly
one call site and keeping it would leave two disagreeing notions of "the system
locale" in the same file.

`LOCALE_NAME_USER_DEFAULT` is `NULL` in `winnls.h` and therefore not exported by
windows-rs at all, so one null `lpLocaleName` serves all ten reads and there is
no second notion of "which locale" to keep in step.

`LOCALE_NOUSEROVERRIDE` is **deliberately not set**: it returns the system
default for the locale and discards the user's own customisations, which are
precisely what this item exists to honour. Setting it would be a table with extra
steps.

### The translator, which is the part that is not optional

Windows date pictures and Excel format codes agree on almost everything — both
descend from the same grammar, and Calcula's lexer counts token runs
case-insensitively, so `dd-MMM-yy` and `d.M.yyyy` pass through **unchanged**.
Three things do not:

| Windows | why it breaks | translation |
|---|---|---|
| `'text'` | `'` is in Calcula's literal pass-through set, so the text INSIDE the quotes is lexed as date tokens | `"text"` |
| `t` / `tt` | not a Calcula token: prints a literal `t`, AND leaves `has_ampm` false so hours render 24-hour | `AM/PM` |
| `g` / `gg` (era) | no token exists; prints a literal `g` | dropped |

The counter-example is live on the development machine: Swedish
`LOCALE_SLONGDATE` is `'den 'd MMMM yyyy`, which passed through untranslated
renders serial 45306 as `'15en '15 januari 2024` instead of
`den 15 januari 2024`.

**The interaction the obvious table misses.** Windows decides 12-versus-24-hour
by the CASE of the hour letter and treats the designator as decoration; Calcula
decides it SOLELY by the presence of an AM/PM token and discards the case. So a
user who sets a custom `H:mm tt` in Region ▸ Additional settings means 24-hour
with a designator, and a blind `tt` → `AM/PM` rewrite would render it 12-hour —
the opposite of what they asked Windows for. The designator is therefore
suppressed when the hour run is uppercase `H`. Pinned by
`an_uppercase_hour_suppresses_the_designator_rather_than_flipping_to_12_hour`.

Anything outside Calcula's date/time alphabet is backslash-escaped: `;` splits
sections, `_` and `*` consume the next character, `[` opens a bracket token. None
occur in an ordinary Windows picture, which is exactly why an unguarded
translator would ship and then break once on somebody's unusual custom short
date.

**The table is the translator's oracle.** For every locale Calcula already
carries a hand-written pattern for, feeding the real Windows picture through the
translator reproduces that pattern's meaning
(`translating_the_real_windows_pictures_reproduces_the_hand_written_table`). The
translator is a pure `&str -> String`, so all of this runs on any machine.

### A defect this change would otherwise have introduced

`try_parse_display_name` reconstructed a currency's symbol POSITION from the
symbol text — `symbol.trim() == "kr"` meant suffix — and its own doc comment
justified that by observing that `kr` was the only suffix currency the app could
emit. Reading the user's regional settings ends that premise: `zł`, `Ft` and `Kč`
with `LOCALE_ICURRENCY = 3` are suffix currencies too, and under the old rule the
symbol jumped to the wrong side of the number the first time the user pressed OK
on a dialog they had not touched. The position is now spelled out in the display
name (`, symbol after`) and read back rather than guessed.

### Named gaps, not silently accepted

* **`LOCALE_SGROUPING`** (the `3;0` vs `3;2` digit-grouping rule) is ignored,
  because `add_thousands_separator` hard-codes groups of three. Indian locales
  are equally wrong before and after; reading `STHOUSAND` alone is a strict
  improvement.
* **`LOCALE_INEGCURR`** is ignored, because the negative-currency choice is
  modelled per FORMAT (`NegativeStyle`, §1.1), not per locale.
* **Calendar names for an unlisted locale.** `CalendarNames` covers 16
  languages. Before this change an unlisted locale like `hu-HU` collapsed to
  en-US entirely, so pattern and names agreed; now it carries the Hungarian
  pattern with English month names. **Accepted for v1 and named here.** The
  follow-on that deletes the problem is reading `LOCALE_SMONTHNAME1..12` and
  friends from the OS and retiring the table — correct, but `calendar()` returns
  `&'static CalendarNames`, so it forces an owned type through
  `format_datetime_section`.

### Why E2E could not be destabilised

The suite forces no locale — a grep of `app/e2e` for locale symbols returns
exactly one hit, and it *reads*. The real risk was `list_separator`: ~11 spec
files hard-code `;` as the formula argument separator, and
`formula_locale.rs`'s translation gate short-circuits when the separator is `,`
with a `.` decimal, so a flip would turn every `SUM(A1;B1)` in the suite into a
parse error in one commit. Measured on the development machine before landing:
display language and regional format both report `sv-SE`, and `LOCALE_SLIST` is
`;` — identical to the table. No E2E-visible value moves. The pre-landing check
is three PowerShell lines and belongs in any commit that touches this path:

```powershell
[System.Globalization.CultureInfo]::CurrentCulture.Name    # regional format
[System.Globalization.CultureInfo]::CurrentUICulture.Name  # display language
(Get-Culture).TextInfo.ListSeparator                       # LOCALE_SLIST
```

---

## 1.4 A same-sheet undo selects what it restored

### The decision

Do it as Excel does, on every restore rather than only on the ones that cross a
sheet boundary. Excel re-selects the restored range because **re-selection is
how the user sees what came back**.

### The finding that changed the shape of the fix

The item described a "one-line widening of the `switched &&` guard". That would
have selected a single CELL. Excel selects the **range**: undo a four-cell paste
and all four come back selected, with the active cell at their top-left.

Worse, the guard meant that on the common path — a same-sheet Ctrl+Z — both the
selection dispatch **and the scroll beside it** were dead code.

### What was built

* `Transaction::restored_range_on(sheet)` (`core/engine/src/undo.rs`), the
  bounding box of the `SetCell` changes on that sheet, per-axis `min`/`max`.
  `restored_anchor_on` is now DERIVED from it, so the anchor and the range
  cannot drift into disagreeing and put the active cell outside its own
  selection.
* `UndoResult.restored_range` beside `restored_anchor`, a named-edge struct
  rather than a tuple (serde renders a tuple as a bare JSON array, and
  `[6,4,9,7]` is one transposition from being read wrong).
* ONE NAMED DIVERGENCE: Excel leaves the ACTIVE cell at the restored range's
  top-left. Calcula's selection model pins the active cell to `endRow`/`endCol`
  and its own `selection-in-bounds` oracle rejects an inverted selection, so a
  well-formed dispatch leaves it at the BOTTOM-RIGHT — the formula bar shows
  that cell and the next keystroke lands there. Matching Excel means giving the
  selection an active cell independent of its corners, which is a change to the
  MODEL rather than to this restore. Recorded rather than half-built.
* `applyRestoreToTheView` dispatches the range unconditionally; the deferred
  `scrollToCell(anchor, center: false)` is now reachable and is Excel's minimal
  scroll — it no-ops when the target is already visible, which is why the
  overwhelmingly common case (undoing the cell you are sitting on) costs one
  reducer pass and zero visible movement.

### The silence that makes it safe

`restored_range` is `None` for a geometry change, a whole-sheet snapshot (every
insert/delete rows/columns) and every opaque `CustomRestore` payload, because
those transactions record no cell coordinates. Excel would select the affected
rows for a structural undo; **Calcula cannot, because the transaction never
recorded which they were.** A `None` therefore leaves the cursor exactly where it
was — the behaviour every restore had before this change — and never selects the
wrong thing. Closing that gap needs `GridSnapshot` to carry the affected band,
which is a second, larger piece of work and is not attempted here.

Two E2E specs (`cell-types.spec.ts`, `cell-behaviors.spec.ts`) click A1 and then
undo an `insert_rows`; they pass **only while structural restores report no
range**, so they are the tripwires for that follow-on.

### The last divergent undo, closed in the same pass

The fused app CLI's `undo`/`redo` called the raw `@api/lib` functions — the IPC
leg alone — rather than `CoreCommands.UNDO`. That is the same defect class §18a
closed for TestRunner's `ctx.undo()`: a second caller that skips the command
handler is a second implementation of undo that drifts from the first. Today the
divergence was "the CLI's undo doesn't follow a sheet switch"; after this change
it would also have been "the CLI's undo doesn't move the cursor". Routed through
`CommandRegistry`, with `handleUndo`/`handleRedo` now RETURNING their result so
the CLI can tell success from failure — a `void` return is what let its `undo`
verb print "Undone." after a refusal.

### Blast radius, measured over the UNIT suites

No Playwright project was run in this pass (see Verification), so the E2E
statements below are read from the specs rather than observed. One hard test
failure across the unit suites: the case in
`undoSheetActivation.test.tsx` that existed to pin §13f, deliberately built with
a non-null anchor on the same sheet. It was split in two — the "fires no sheet
switch" half is unchanged and still true; the selection half is inverted and now
names what it replaced. Everything else survives, because the E2E specs that
undo either invoke the backend directly (never entering the view path) or
re-select before asserting.

**The soak walker is unaffected** and needs no re-baselining: the undo oracle
invokes the backend directly and compares a digest with no selection in it, and
every selection-dependent walker action re-establishes its own selection first.
The `selection-in-bounds` cheap invariant now fires on every walker undo, which
is a free regression net — a range built with per-axis `min`/`max` passes it by
construction.

---

## 1.5 A blank cell is not the number zero

### The decision

Full scope. Excel's rule is three-way — a blank is `0` in arithmetic, `""` in
concatenation, and **not in the population at all** for the counting and
statistical functions — and the third meaning is the one no stand-in value can
express, because ignoring a value is not the same as contributing one: it
changes the denominator.

### The item understated the defect in two ways

1. **The named line was not the important one.** `cell_value_to_result`'s
   `CellValue::Empty => Number(0.0)` is one of fourteen zero-injection sites. The
   important one is `eval_range`, which materialised **absent** cells as zeros:
   `=COUNT(A1:A1000)` over a column holding two numbers returned **1000**,
   measured.
2. **There were two contradictory blank policies in the same evaluator.**
   Rectangular ranges (`A1:A3`) injected zeros; whole-column references (`A:A`)
   skipped absent cells. Measured on identical data:

   | | `A1:A3` | `A:A` | Excel |
   |---|---|---|---|
   | `COUNT` | 3 | 2 | 2 |
   | `AVERAGE` | 1.333 | 2 | 2 |
   | `COUNTA` | 3 | 2 | 2 |

   The same workbook gave two different answers for the same function depending
   on how the user spelled the range. That is worse than a consistent wrong
   rule, and it means "fix the single-cell path" would not have closed the item.

There is also a **second representation of blank**: a cell PRESENT in the grid
holding `CellValue::Empty`, produced in quantity by `Cell::new()`, un-evaluated
formula cells, spill vacating, styled-empty cells from `.xlsx` import and `.calp`
overrides. `ISBLANK` answered FALSE for those. Both representations now map to
`EvalResult::Blank`.

### How the scope was contained

The item's stated fear — "a new variant threaded through every arm of the
evaluator" — is real: `evaluator.rs` carries ~2,900 `EvalResult::` mentions and
**~194 catch-all arms**, so a naively-added variant would be *silently swallowed*
by most of them rather than caught by the compiler. That was avoidable, because
the **operand path was already correct and the collector path was not**:

| method | answer for `Blank` | consequence |
|---|---|---|
| `as_number()` | `Some(0.0)` | all six arithmetic operators and ~250 scalar math/date/financial/engineering functions keep working **untouched** |
| `as_text()` | `""` | the entire text group — `&`, CONCATENATE, LEN, UPPER, TRIM, LEFT, TEXT… — fixed by **one line** |
| `as_boolean()` | `Some(false)` | `IF`/`AND`/`OR`/`NOT` keep working untouched |
| `to_cell_value()` | `Number(0.0)` | `=A1` over a blank still DISPLAYS 0, and a blank can never be stored or spilled |

The price is that a collector building a POPULATION cannot use `as_number()` to
decide membership. `as_sample_number()` exists for exactly that and is named to
be told apart at a glance — using the wrong one is silent, because the function
keeps compiling and keeps returning a plausible, wrong number.

That reduced the change to roughly forty edit sites: six materialisers, the
collectors, the six comparison operators, the information functions, the criteria
layer, and the lookup equality helpers.

### The reference/value line, which is Excel's own

A blank survives the functions that return a **reference** — `INDEX`, `OFFSET`,
`INDIRECT`, an implicit intersection — which is why `=COUNT(INDEX(A1:A12,6))` is
0 in Excel and `=ISBLANK(INDEX(…))` is TRUE. It collapses at the functions that
return a **value**: `VLOOKUP` landing on an empty cell returns the NUMBER 0,
which is why `=ISBLANK(VLOOKUP(…))` is FALSE and why users write
`IF(VLOOKUP(…)="","",…)`.

Calcula stops there. It does **not** implement full reference propagation through
`IF`/`CHOOSE`. That is recorded as deferred rather than half-built.

### Defects fixed as a consequence, not as separate work

* **`PRODUCT` returned 0** for any range containing an empty cell. It looks
  arithmetic-shaped, so a blank read as zero annihilated it. Excel ignores
  blanks; `PRODUCT({1,blank,3})` is 3.
* **`COUNTBLANK` never worked at all** — it answered 0 where Excel answers the
  count. Its own comment claimed absent cells "return empty text and the above
  check handles it"; they arrived as the number 0.
* **Every D-function with a partially-filled criteria rectangle silently
  filtered its whole database out.** An empty criteria cell means "no
  condition"; it arrived as `Number(0.0)`, so the gate's `is_blank` was false and
  it was applied as the live criterion `= 0`, which matches nothing. This is the
  single most concrete user-visible payoff of the change.
* **`COUNTIF(rng,0)` counted every empty cell**, and `COUNTIF(rng,"")` counted
  none of them. `""`, `"="` and `"<>"` are now three distinct criteria.
* **`=A1<"a"` was `#VALUE!`** — the ordering operators fall back to a
  text-vs-text branch a number cannot enter.
* **The paired statistics slid one side against the other.** CORREL, SLOPE,
  INTERCEPT, RSQ, STEYX, COVARIANCE, FORECAST, PROB and the SUMX2*/SUMXMY2 family
  filtered each array INDEPENDENTLY, so a non-numeric cell on one side shortened
  it and every later value was matched against the wrong partner. Excel drops the
  PAIR. The defect predates blank-awareness (it fired on text and error cells)
  but blank-awareness is what makes it common, so fixing it here is not scope
  creep — shipping without it would have turned a rare misalignment into an
  ordinary one.

### The cache invariant, which is where the risk actually was

`CriteriaIndex` buckets a vector by value and has no notion of a blank, so it
initially counted blanks as zeros and the cached `COUNTIF(rng,"<=1")` answered
one more than the scan. Two changes keep cached and scanned results
bit-identical, which is the invariant the whole pass cache rests on:

* blanks are counted but bucketed nowhere, and `count_text_not_equal` — a
  complement of `len` — subtracts them back out;
* the three blank criteria (`""`, `"="`, `"<>"`) are **refused** by
  `criteria_count_cached` and served by the scan, for the same reason wildcards
  already were.

Pinned by the existing `cached_results_equal_scan_results` battery and by
`the_countif_cache_agrees_with_the_scan_over_blanks`.

### Tests

`core/engine/src/blank_semantics_tests.rs` — 21 tests in its own file rather than
inside the 20,000-line evaluator, because the rule is a property of the whole
evaluator (materialisers, collectors, comparisons, criteria, the storage
boundary) and burying it is how the `A1:A3` / `A:A` contradiction survived
unnoticed. Every case is paired with a control chosen so the right answer and the
old wrong answer differ.

Two existing tests were updated deliberately rather than silently, and both had
asked to be: `test_empty_cell_ref` now asserts BOTH halves of the collapse rule
(`Blank` at the evaluator, `Number(0.0)` after `to_cell_value`), and
`clearing_a_cell_recalculates_the_whole_chain` in the app crate carried a comment
saying the `"0!"` it asserted was a filed parity gap "pinned here so that fixing
it has to come past this test rather than silently changing what this one
proves". It did.

---

## 1.6 Policy-refused inline payloads on the `.calp` pull path — ANALYSED, still open

The owner asked for an explanation and a recommendation, not an implementation.
**No behaviour was changed.**

### What the item is about, in plain language

A control (button, checkbox, picture) is stored as a bag of name → string
properties. A picture's bytes historically lived in one of those strings as a
`data:image/png;base64,…` URL — the whole picture, inlined as text.

BUG-0086 established what to do when the host inspects such an inline picture and
refuses it:

* **Hazard refusals** — too many bytes, too many pixels, too wide. Handing these
  to a decoder is *itself* the attack (a 30,000×30,000 one-colour PNG is 5 KB of
  text and 3.6 GB of RAM once decoded). **Wiped to `""`.**
* **Policy refusals** — an SVG, a BMP, an unrecognised format, a broken header.
  The host will not file these in its media store, but they are *safe to look
  at*. **Left exactly as they are**, so a picture the user can see today does not
  vanish because a later build narrowed the allowlist.

That split is right and should not change.

### The residual, stated accurately

The residual is **not** a missing media judgement — the pull *does* run one
(`admit_distributed_controls` → `migrate_distributed_inline_images` →
`sanitize_distributed_controls` + `rewrite_inline_images`), so a decompression
bomb IS cleared and `onSelect` IS stripped. The accurate statement is narrower:

> On the pull path there is **no per-property size bound of any kind**, and the
> inline-image judgement — the only thing that bounds anything — recognises only
> strings matching `data:image/*;base64,`. Values outside that shape are copied
> through at unlimited length.

Three unbounded shapes:

1. a **non-base64** data URL — `data:image/svg+xml,<svg …>` — of any length;
2. a `data:image/…` string with **no comma at all**, which bails out of both the
   decoder and the byte-cap check before either can measure it;
3. **any other property** (`text`, `tooltip`, `fill`, an invented key) of any
   length, which the image judgement never examines.

### What the risk is, and what it is not

| axis | assessment |
|---|---|
| Code execution / sandbox escape | **None.** An SVG delivered through `<img>` is rendered in secure static mode — scripting disabled, external references not fetched — as a property of the *loading mode*, not of the CSP. The CSP would refuse it anyway (`script-src` has no `data:` and no `'unsafe-inline'`; `object-src 'none'`). No DOM-injection path reaches a control property: the render path is `new Image()` + `drawImage`, and the two `dangerouslySetInnerHTML` sites both render the built-in shape-template catalogue. |
| Data exfiltration | **None.** `default-src 'self'` plus no external refs in image mode. |
| Consent-model bypass | **None.** `onSelect` is stripped on every distributed path. |
| Memory / renderer DoS | **Real, low-to-medium.** Requires subscribing to a hostile publisher; recoverable by restart. Worth naming: a `text` property of tens of millions of characters goes to `ctx.fillText` on the render thread every frame, and needs no `data:` URL at all. |
| **Persistence integrity** | **Real, and the axis to weight highest.** On the subscriber's next save the payload is written verbatim into their own `.cala`. The media GC prunes the media store; an inline string is not in the media store — it *is* the document — so nothing ever reclaims it. A durable, silent bloating of the victim's document, delivered inside a correctly-signed artifact. |

The prior "tolerable" judgement was made about the SVG/script question, and on
that question it is correct. It undersells the persistence axis.

### Recommendation

**Bound the DISTRIBUTED payload in `migrate_distributed_inline_images`** — not in
`materialize_saved_controls`. After sanitisation (`onSelect` gone) and inline
image migration (admissible images are now 70-character `media:` handles), the
only value on a pull that can legitimately exceed 64 KiB is a policy-refused
inline picture, which makes a clean two-tier rule available on the distributed
path that is simply not available on the local one:

1. widen `exceeds_byte_cap_encoded` to judge `data:image/…` URLs that are **not**
   base64 (and those with no comma at all) by raw character length against
   `MAX_MEDIA_BYTES`;
2. walk the admitted JSON once more and clear — to `""`, matching the established
   `Drop` treatment, so geometry and identity survive and the control paints
   "No Image" — any string over `MAX_CONTROL_PROPERTY_CHARS` that is not a
   `data:image/` URL, and any `data:image/` URL over `MAX_MEDIA_BYTES`. Count it
   into the existing `MediaMigration` log line.

~40 lines of implementation. Blast radius: distributed pulls only; `.cala` open
untouched. It is already the pure, lock-free, directly-testable seam that both
the pull and the refresh route through.

**Explicitly rejected:** applying the cap inside `materialize_saved_controls` (it
would also fire on `.cala` open, so a user whose own workbook holds a 90 KiB
inline SVG logo — legal, created by the shipped picker, rendering fine today —
loses their picture on the next open, silently; and the function returns `usize`,
so it has no error channel). Routing the pull through `check_property_value` is
architecturally the right instinct but that function is designed to refuse
**loudly**, and on a pull "loudly" means either aborting a whole subscription
over one oversized property or contradicting the function's stated contract.

**What no option catches:** aggregate volume (5,000 controls × 63 KiB is ~315 MB
and every value is legal — that needs a per-pull total budget, a larger change),
and an SVG under the cap that is still expensive to rasterise (no cap can catch
that without an SVG parser, which the media module refuses on principle, and
correctly).

### Done in this pass, because they were false statements in the codebase

Two doc comments in `controls.rs` asserted that `.calp` materialization arrives
through `set_control_metadata` and is therefore bounded. It does not and is not —
a pull calls `materialize_saved_controls` directly. The test
`a_control_property_over_the_size_cap_is_refused` already carried the correction
in its comment while both doc comments went on asserting the opposite. A doc
comment that lies about where a bound applies is how this became invisible the
first time.

---

## The second round — what an adversarial review found afterwards

Everything above was written with all suites green. A seven-agent adversarial
review was then run against the finished change, and it found **defects in every
item**. They are recorded here rather than quietly fixed, because their shape is
the finding:

**Almost every one was a HALF-CONVERSION** — a materialiser, a collector or a
comparator changed in one of its two branches. A suite built from "does this
function give Excel's answer?" cannot see them, because the branch that WAS
converted answers correctly and the branch that was not is reached by a
different spelling of the same question.

The worst four, all in 1.5, all silent wrong values:

1. **`compare_values` had no blank arm**, so a blank sorted above every number
   and a single empty cell in a sorted key column STOPPED an approximate
   `VLOOKUP`/`HLOOKUP`/`LOOKUP` dead — it returned the row before the gap, while
   `MATCH` (which orders through a different helper) still returned the right
   one. Two functions, one grid, different rows.
2. **`T.TEST` and `F.TEST` were given the PAIRED collector** by the mechanical
   sweep that fixed the genuinely paired statistics. It truncated two
   INDEPENDENT samples to the shorter one, discarding observations — and made
   T.TEST's own "paired arrays must be the same length" guard unreachable, so
   the error it exists to raise could no longer be raised.
3. **`SUBTOTAL` disagreed with itself** between `(9, B5:B15)` and
   `(9, B5, B10, B15)`: the bare-cell-reference branch of `collect_visible_values`
   still injected zeros, and that branch is the one the grand-total idiom takes.
4. **`OFFSET` and `TEXTJOIN` were each converted in one branch of two**, so the
   answer depended on whether the argument was a range or an array.

Also fixed in the same round: four D-functions and the
`AVERAGEIF`/`AVERAGEIFS`/`MINIFS`/`MAXIFS` family still built the old
population, so one criteria filter produced two different answers; `AGGREGATE`
code 3 kept the backwards COUNTA filter that `fn_counta` had just been corrected
for; `SORT` gave blanks their own ordering class, so the zero it spills jumped
from one end of the result to the other when the direction flipped; `UNIQUE`
keyed on the internal variant, so a blank and a real zero were two keys and one
output value — duplicates from the de-duplicator; `XLOOKUP`'s scan path and
`LOOKUP` never collapsed a blank result while the cached path did; and
`eval_result_to_typed` reported `type: "text"` beside `value: 0`.

And in the other items: the Format Cells negative list composed its suffix onto
whatever preset the cell already carried, so clicking `($1,234.00)` on a General
cell wrote `general_neg_paren` and silently discarded the choice; a red negative
section that KEEPS its minus (`…;[Red]-$#,##0.00`) was classified as Excel's
signless `Red` entry, which would have rendered -1234.5 as `$1,234.50` and
deleted the user's minus from the exported file; the `H`-detector for the
24-hour rule scanned quoted literal text, so a Spanish `'Hora 'h:mm tt` lost its
AM/PM designator; the red-colour guard tested the finished string rather than
the digits, so a currency symbol containing a digit painted `$0.00` red; and the
CLI's `undo` printed "Undone." on an empty stack, because a refusal RETURNS
`{ success: false }` rather than rejecting and the new guard only caught
exceptions.

**Two claims in this document were also wrong** and are corrected above: the
core test count, and "no Excel currency preset parenthesises by default"
(`Ctrl+Shift+$` does, and OOXML builtins 5-8 are parenthesised codes — the true
claim is narrower: no Excel preset parenthesises a SINGLE-SECTION code).

**One divergence was accepted rather than fixed**, and is named in 1.4 above:
the active cell after an undo lands at the restored range's bottom-right, not
its top-left, because this app's selection model pins the active cell to
`endRow`/`endCol` and its own `selection-in-bounds` invariant rejects an
inverted selection.

The eleven regression tests added afterwards follow a different rule from the
first twenty-one: each asserts **two spellings of one question against each
other** — `SUBTOTAL` over a range versus over a cell list, `OFFSET` versus the
range it describes, `AGGREGATE` versus `SUBTOTAL` versus the plain function,
cached versus scanned — rather than asserting one spelling against Excel's
value. A half-conversion fails that shape by construction, which is exactly what
the first suite could not do.

---

## Verification

| suite | result |
|---|---|
| `cargo test --workspace` (core) | **1,425 passed, 0 failed** |
| app crate (`app_lib` unit tests) | **1,674 passed, 0 failed, 5 ignored** |
| `npx vitest run` | **107,167 passed, 0 failed** (809 files) |
| `npx tsc --noEmit` (app + e2e projects) | clean |
| `npm run lint:boundaries` | clean |

New live coverage: `app/e2e/journeys/open-items-owner-calls.spec.ts` — five
tests proving 1.1, 1.3, 1.4 (both the selection and the deliberate silence) and
1.5 against the running application. **Not executed in this pass** (the E2E
launcher needs a full app build and the working tree was mid-change); it is
written to the journey conventions and type-checks under `tsconfig.e2e.json`.

Visual goldens: all 72 examined, none contains a negative currency, none needed
re-baselining. See §1.1 for why a whole-grid golden could not be relied on to
catch this change in either direction.

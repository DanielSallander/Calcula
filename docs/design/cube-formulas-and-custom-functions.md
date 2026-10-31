# Calcula — CUBE Formulas & Custom Functions

**Status:** Complete (2026-06-24). Builds on Wave 3
(`docs/design/wave3-scripting-security.md` — the `formula.udf` UDF bridge, the
`bi.query` capability, per-script Worker realms, the broker/consent/audit model)
and on the BI engine integration (`memory/project_bi_engine_adoption_gap.md`).

This document is the canonical record of three related features delivered on top
of the BI model engine, all of which let a worksheet pull **live model data**
into ordinary cells and formulas:

1. **CUBE formulas** — the seven Excel-style `CUBE*` worksheet functions over a
   Calcula BI model.
2. **`cube.*` script API + workbook calculated measures** — the same model reach
   for sandboxed scripts (Layer 1) and user-defined measures stored in the
   workbook (Layer 2).
3. **Custom Functions (JS UDFs)** — user-authored JavaScript formula functions
   that run sandboxed and may call `cube.*`. This is the realization of the
   "worker-script-defined UDF" path that Wave 3 anticipated as future work.

The user-facing reference for each CUBE function lives in `functions/CUBE*.md`.

---

## 1. The core architectural constraint (shared by all three)

The formula evaluator (`core/engine/src/evaluator.rs`) and the `update_cell`
command (`app/src-tauri/src/commands/data.rs`) are **100% synchronous**, but BI
model queries are **async** (`Connection.engine: Arc<TokioMutex<bi_engine::Engine>>`),
and custom-function bodies run **off-thread** in a Worker realm. The codebase
already solved this for `GETPIVOTDATA` and the Wave 3 UDF bridge with a
**pre-fetch pattern**, and CUBE formulas + Custom Functions reuse it:

1. **Async pre-pass** resolves every external value the cells about to recalc
   will need, producing a serializable bundle.
2. **The bundle is forwarded into `update_cell`** as a parameter (`cube_results`
   for cubes, `udf_results` for UDFs), mirrored on the frontend by a resolve hook.
3. **The synchronous evaluator serves the bundle** — no I/O, no `.await`, never
   calling JS back into the lock-held recalc.

A shared, deterministic **key** (`cube_call_key` / `udf_key`) is computed
identically by the pre-pass and the evaluator so their lookups always agree.

---

## 2. CUBE formulas

### 2.1 The seven functions

| Function | Returns |
|---|---|
| `CUBEVALUE(connection, [member]...)` | An aggregated measure value for a slice. |
| `CUBEMEMBER(connection, member, [caption])` | A member/tuple object (displays a caption, carries the object). |
| `CUBESET(connection, set, [caption], [sort_order], [sort_by])` | A calculated, optionally-sorted set. |
| `CUBESETCOUNT(set)` | The number of items in a set. |
| `CUBERANKEDMEMBER(connection, set, rank, [caption])` | The nth member of a set. |
| `CUBEMEMBERPROPERTY(connection, member, property)` | Another column's value for a member. |
| `CUBEKPIMEMBER(connection, kpi, property, [caption])` | A KPI value(1)/goal(2)/status(3). |

The functions are registered as `BuiltinFunction` variants in
`core/parser/src/ast.rs` with `FunctionMeta` catalog entries, so autocomplete and
function help come for free.

### 2.2 Member-expression grammar (Calcula-native, not MDX)

Each member expression is a **string** argument that reuses existing Calcula
conventions rather than introducing an MDX `[Dim].[Level].[Member]` layer:

| Form | Meaning |
|---|---|
| `[Measure Name]` | A model measure (what to aggregate). |
| `Table[Column]=Value` | A dimension member filter (value may be `'single-quoted'`). |
| `Table[Column]` | A level — all members of a column. |
| `m1, m2` (within one argument) | A tuple — members AND-ed together. |
| `{m1, m2, ...}` | An explicit set (CUBESET). |

The **connection** (first argument) is a Calcula `Connection.name`, resolved by
name against `BiState`; an unknown name → `#NAME?`.

`CUBEKPIMEMBER` property ints: `1` Value, `2` Goal, `3` Status; `4/5/6`
(Trend/Weight/CurrentTimeMember) → `#N/A` (not modeled). `CUBESET` `sort_order`
ints: `0` none, `1` asc by measure, `2` desc by measure, `3` alpha asc, `4` alpha
desc (measure ordering applies to level sets; explicit `{...}` lists support the
alphabetical modes).

### 2.3 The cube-object cell duality

`CUBEMEMBER` / `CUBESET` / `CUBERANKEDMEMBER` cells **display a caption** but
**carry an underlying member/set object** that other cube formulas reference by
cell (e.g. `B2 =CUBEMEMBER(...)`, then `C1 =CUBEVALUE("Sales","[Revenue]",B2)`).
So the pre-fetch produces, in dependency order, both a per-cell **binding** map
and a pre-fetched **results** table:

- `engine::CubeBinding` / `engine::CubePrefetch { bindings, results }` (in
  `core/engine/src/cube.rs`) are the serializable, `camelCase` types.
- `app/src-tauri/src/bi/cube.rs` is the async brain: `parse_member_expr`,
  per-function resolvers, and `build_cube_prefetch`, which seeds bindings for
  **all** cube-member/set cells on the sheet (cheap metadata) and then resolves
  the value cells in dependency order, batching BI queries. Exposed via the
  `cube_prefetch` Tauri command.

Every WRITE DOOR that can put a CUBE formula down pre-fetches for exactly that
write and hands the result to the write command as `cube_results` (BUG-0476):
the grid editor's `update_cell` (`cube_prefetch` with `row`/`col`/`value`), the
batch door `update_cells_batch` -- a paste, a fill, a script's or an extension's
`CellRange.setValue(s)` -- and the background door `update_cell_on_sheets` (both
`cube_prefetch` with `edits`; the background door one pre-fetch per target sheet,
built from that sheet's cells with `sheet_index`, aligned with `sheet_indices`).
WHEN: the grid editor and the batch door pre-fetch for a write that carries a
CUBE formula, which latches the session, and for EVERY write once the session
has latched -- any edit, paste or fill may feed a cube cell (a new member name
in a cube argument cell). A workbook with no CUBE formula never latches, so its
writes stay one call. The background door pre-fetches only for a CUBE formula
it writes: it serves cube data only to that cell (see 2.5).

WHAT: each write's values are parsed exactly as the write stores them (the
format the entry lands in, an explicit `styleIndex`, the invariant ladder; the
cells the batch skips for a writeback claim are not read), and the pre-fetch
resolves exactly the cube cells the write evaluates:
- every written CUBE formula, keyed AT ITS TURN -- with the writes before it in
  place and the ones after it not yet made, because the batch evaluates each
  written formula inside its loop (under manual calculation too);
- on the active sheet under AUTOMATIC calculation, every cell of the write's
  cascade, computed by `commands::data::active_sheet_write_cascade` -- the very
  function `update_cell` and `update_cells_batch` build their cascade with
  (dependents, whole-column/row readers, volatile UDF cells, the volatile
  built-ins and their dependents, unblocked arrays), so the two cannot drift;
- under MANUAL calculation nothing else, so what the user left stale stays stale.

The pre-fetch carries a `scope` naming those cells (`CubePrefetchScope`): the
evaluator treats a cube cell OUTSIDE it -- a cube cell on another sheet that a
write's recalculation reaches, for one -- exactly as if nothing had been
fetched (2.4: each call is answered from the results cache for its exact
arguments, else `#N/A`). A cell inside it
whose key is missing answers `#N/A`: that means the pre-fetch could not see what
the argument now holds, and keeping the previous member's number would show a
stale answer as current.

The full refresh is `calculate_now` with `cube_prefetch_all` (Calculate Now once
the session has seen a CUBE formula, or `recalcWithCube`); it covers EVERY
sheet's cube cells: the active sheet's pre-fetch carries one more per other
sheet that has cube cells, in `CubePrefetch::other_sheets` keyed by the sheet's
name uppercased (a sheet's object bindings are keyed by cell, so two sheets
cannot share one), and the evaluator picks the one built for the formula's sheet
(`CubePrefetch::for_sheet`). Two sheet names that uppercase alike are refused at
entry (`sheet_names::ensure_sheet_name_is_free`, round 8, rev6A#8): the check
was ASCII-only, so `Ärende` beside `ärende` let one sheet's pre-fetch replace
the other's here -- and every engine lookup by name conflate them. Excel refuses
that pair too. Until 2026-10-29 it was built from the active sheet
alone and F9 never refreshed another sheet's cube cells
(NEW-f9-other-sheet-cube-na). Still without a pre-fetch: a floating grid's cells (the
`target` route of `update_cells_batch`, `update_floating_range_cell`) and the
Rust-side writers (the QuickJS script surfaces, which the MCP / AI
`set_cell_range` tool writes through too), which are synchronous and cannot
await the model.

COST. Once the session has latched, every write pre-fetches, so the pre-fetch
reads the workbook in ONE synchronous step (`snapshot_prefetch_sheet`) that
copies only what its async half needs: the formulas of the cube-bearing cells
(screened by reference with `engine::cube::contains_cube_call`, which neither
clones nor allocates) and the text of the cells their arguments name. Until
2026-10-29 it cloned the whole sheet and then every formula's AST a second time
on every write (rev4A#4).

`CubePrefetch` is **derived state** — recomputed every recalc from the formula
text — so there are **no `.cala` persistence changes**: cube formulas persist as
ordinary formula text, and their last computed value caches in the cell like any
formula.

### 2.4 No cube data: the RESULTS CACHE, answered only for the exact arguments

A recalc that did not pre-fetch cube data for a cell must not clobber it to
`#N/A`: a cross-sheet cascade, a background sheet's recalculation, F9 before the
session has seen a CUBE formula, Calculate Sheet (Shift+F9), a fill, a
Rust-side writer. (A paste or an
ordinary edit on the active sheet is no longer on this list once the session
has latched: it pre-fetches, see 2.3.) But it must not show a stale number as
current either, and it must never feed a cell's own value back into its
formula. Both happened until rev3A#3: the evaluator answered such a call with
the cell's WHOLE stored value, so `=CUBEVALUE(...)/1000` divided itself again at
every recalculation (1234.5 -> 1.2345 -> 0.0012), and a member that had just
changed kept the previous member's number.

THE RULE (2026-10-29, round 6 -- the coordinator's answer to the owner question
round 5 raised). Each sheet's `Grid` carries a derived results cache,
`engine::cube::CallMemo`. **Every call served with data records its answer**
under the call's exact argument FINGERPRINT -- wherever the call sits: a bare
`=CUBEVALUE(...)`, `=CUBEVALUE(...)/1000`, `=IF(..., CUBEVALUE(...))` alike. When
no prefetch is present OR the prefetch's `scope` does not cover the cell,
`eval_cube` (`preserved_cube_value`) **answers the call with the answer recorded
for exactly the arguments it has now**, and `#N/A` only when none is recorded.

- The fingerprint is the call key spelled without any pre-fetched binding (a
  cube-object argument cell is spelled by that cell's own call and the value it
  shows), so it is computed identically with and without data. A member name
  that changed by ANY route -- the cross-sheet walk, a fill, a background write,
  F9 on another sheet -- gives a different fingerprint: never the previous
  member's number, `#N/A` unless that member was itself answered before.
- The cell's stored value is never read. A composite formula computes from its
  CALL's answer, the same one at every recalculation, so it keeps its correct
  value and can never compound.
- An argument that goes back to what it was finds its answer again (round 5
  kept only a value the cell still held, so a refused cell stayed `#N/A`).
- **One answer per fingerprint, the newest.** Serving a call again replaces its
  answer. A model REFRESH (new data, a changed calculated measure, a connection
  or "view as" switch -- `recalcWithCube`, and every F9 once the session has a
  CUBE formula: Calculate Now with cube data, whose full refresh covers every
  sheet, 2.3) first FORGETS every cube answer (`CallMemo::forget_cube_answers`)
  and then re-serves every cube call a cell makes now. Until round 8 it only
  replaced the answers it re-served, so an argument no cell held at that moment
  kept the old model's answer, and when it came back through a route without
  data (the cross-sheet walk, a fill, a background write) it was served that
  number as current with no error (rev6A#1). Such an argument is now `#N/A`
  until the next refresh. Custom-function answers survive a refresh: they are
  facts about their arguments, not about the model -- but not a change of the
  function's own CODE (rev8A). When a Custom Functions library changes -- the
  dialog's Save (`scripting::save_script`), an application's subscribe or update
  merging its functions (`calp_commands`, after `materialize_distributed_scripts`
  and before the installed sheets are seeded) -- every function whose definition
  changed forgets its answers on every sheet (`CallKey` carries a tag of the
  function's name, `CallMemo::forget_custom_function_answers`), and a function
  the libraries no longer define is forgotten altogether, so a call of it is
  Excel's ordinary `#NAME?` again and `=IFERROR(GONEFN(A1),0)` is 0
  (`CallMemo::forget_custom_function`; it used to stay the sticky refusal until a
  reopen). Driven by `bi::cube::forget_redefined_custom_functions`, which
  compares the definitions before and after the write. Before it, an argument no
  cell held when the new code was installed kept the old code's answer, and the
  cross-sheet walk, F9 or the save served it as current.
  On the application doors the page still runs the OLD code until it hears
  `custom-functions:refresh` and re-installs, so every changed function is also
  HELD (`bi::cube::hold_custom_functions_until_reinstalled`,
  `CallMemo::hold_custom_function`) under a fresh library generation, which the
  event carries: an answer served while held answers its edit but is not filed,
  until the page reports that generation installed
  (`loadAndInstallCustomFunctions({ libraryGeneration })` ->
  `note_custom_function_registry`; a failed install reports nothing). The
  authoring Save needs no hold: the dialog installs first and saves after.
- **Bounded:** a call is filed under a fixed-size KEY, never its arguments'
  spelling (`CallKey`: the kind, the spelling's length and 128 bits of SipHash
  under a per-process secret key -- a custom function handed a 5,000-row range
  used to file ~40 KB per answer, so a sheet's bound held a few hundred and one
  fill-down evicted its own answers, rev6A#2). Two generations per sheet, each
  of at most 65,536 calls and about 16 MiB of answers (`CALL_MEMO_GENERATION`,
  `CALL_MEMO_GENERATION_BYTES`), and every sheet's memo together at most about
  64 MiB (`CALL_MEMO_WORKBOOK_BYTES`, one ledger per process, which is per
  workbook; a dropped sheet gives its bytes back). The full generation becomes
  the previous one and the old previous one is dropped. When the WORKBOOK's
  budget is full, the sheet holding the most gives back its oldest generation
  (`CallMemoLedger` keeps a weak handle to every memo; rev8A) -- it used to be
  the sheet filing the answer, so once two big sheets filled the budget a third
  rolled its own generation on every answer and kept two. Forgetting only turns
  an answer into a refusal.

The cache is keyed by fingerprint rather than by cell, so sorting or moving
cells cannot misfile it and two cells making the same call share one answer,
and a `Grid` clone SHARES it (the active sheet is held twice, `AppState::grid`
and `grids[active]`). It is never saved. **After a file open** it is seeded from
the saved values (`bi::cube::remember_loaded_call_results`, called by
`open_file` once the document is installed): a ROOT call's saved value (`=CUBEVALUE
(...)`, `=MYFN(A1)`) was calculated for the arguments saved beside it, because
every recalculation that could not compute a call with changed arguments writes
`#N/A` instead of a number. That premise fails for an argument that reads
something beyond its references -- `=DAYSLEFT(TODAY(),A1)` evaluates TODAY() at
OPEN time, so a value saved on Monday would be filed under Tuesday's argument --
so a call whose arguments read a volatile built-in, OFFSET / INDIRECT, a pivot,
a control's value or the like (`engine::cube::reads_beyond_its_references`) is
not seeded (rev6A#3). A call inside a larger formula has no saved value of
its own -- the cell holds the quotient, the product -- so it is NOT seeded: it
refuses on a recalculation without data until one with data serves it, unless a
root call on the same sheet makes the same call and seeded its answer. Cells are
seeded row-major, so two root cells that saved different values for one call
(one left stale under manual calculation) seed the later one, the same way on
every open. Seeded any later it would vouch for a value whose argument may have
changed since. Cells a cancelled recalculation left pending are not seeded. A
dynamic-array ORIGIN (a custom function that spilled) is seeded with the whole
array its spilled footprint holds -- the origin cell stores only the first
element, and seeding that scalar made the save's recalculation collapse the
spill (rev5B#2); an incomplete footprint seeds nothing.

**Sheets an application install brings** are seeded the same way
(`bi::cube::remember_installed_call_results`, round 7, rev5B#1): a subscribe and
a checkout (`materialize_pull_result`, before pulled pivots re-render), an update
(`apply_refresh_payloads`, before the subscriber's overrides and writeback values
are painted back on), a dev subscribe and a dev refresh. One condition more than
an open: a pulled value was computed against the PUBLISHER's workbook, so a cell
whose formula reads anything the install did not bring -- a sheet outside it, a
defined name the workbook resolves differently (the subscriber kept their own on
a collision), a table not on an installed sheet, a 3D range -- is FOREIGN: it is
not seeded, and its sheet is marked as holding values that may be stale (below).
An undo that rebuilds a sheet from its snapshot (a grouped structural edit, a
subscription reset) KEEPS the sheet's cache (`Grid::new_sharing_call_memo`): it
is keyed by arguments, never by cell. A blank sheet starts empty.

**A full recalculation without data keeps an unchanged cell** (round 7). Calculate
Now, Calculate Sheet and the save's own Calculate Now (`calculate_before_save`,
on by default, `persistence::save_file`) evaluate EVERY formula; none of them runs
a custom function, and a cube call has data only once the session has seen a CUBE
formula. A call the cache cannot answer there used to be refused -- and the save
wrote the refusal into the file for every composite formula right after an open,
every cube and custom-function cell after a checkout or subscribe, and a collapsed
spill. Now such a cell KEEPS its stored result whole (its value and its spilled
footprint, never fed to an operator, so nothing compounds) when nothing it reads
has changed -- Excel's own F9, which recalculates a cell only when something it
reads has changed. The soundness argument is the invariant rounds 5 and 6
established: every route that changes a precedent re-evaluates its dependents
with data or writes the refusal, so in automatic calculation a stored value is its
formula's current answer or an error. What can still leave a stale value, each
checked by the pass (`calculation::run_calculation_pass`, `KeepWithoutData`):

- **manual calculation** -- an edit recalculates no dependent, and nothing
  records which. Under manual a cell is kept only while the document is UNEDITED
  since it was opened or saved (`FileState::is_dirty`, which the `calculate_now`
  / `calculate_sheet` commands and the save hand in), and none is kept on a sheet
  whose cache says its stored values may be stale (`CallMemo::values_may_be_stale`):
  LEAVING manual marks every sheet (a script's `setCalculationMode("automatic")`
  recalculates nothing), so does saving an edited manual document without
  recalculating it (`calculate_before_save` off), and so does a foreign install
  (above). A completed Calculate Now that planned every formula vouches for them
  again. The mark OUTLIVES THE FILE (BUG-0615#2): a save while any sheet is marked
  writes `calc_state.json` (`Workbook::calculation_incomplete`, `.cala` v12,
  `CALCULATION_INCOMPLETE_MIN_FORMAT_VERSION`) -- Excel's `calcCompleted="0"`,
  which Excel writes for a manual workbook saved without recalculating and
  reopens with the stale values and `CalculationState` = xlPending until F9
  [LIVE, Excel 16] -- and the open marks every sheet again BEFORE the results
  cache is seeded, which then files no saved value of a marked sheet as an
  answer. Consequence, on purpose: under manual calculation, once anything was
  edited -- and on the first Calculate Now after leaving manual -- every call the
  cache cannot answer is refused, as round 6 did everywhere; Excel's F9 would
  recompute only the cells the edit dirtied, a record Calcula does not keep.
- **a cancelled recalculation's remainder** (`pending_recalc`) -- refused.
- **the pass itself** -- a volatile input, the cell's own position, state outside
  the grid (`engine::cube::reads_beyond_its_references`: RAND/NOW/TODAY, OFFSET,
  INDIRECT, CELL, ROW/COLUMN, the GET.* and GATHER families, FILE*, SUBTOTAL,
  GETPIVOTDATA), or a referenced cell this pass has already changed (footprints
  included) -- refused.

A cell that may not be kept is refused WHOLE: a formula's own answer around a
refused call is no answer (`=IFERROR(MYFN(A1),0)` would say 0). Since round 8
the ENGINE answers that way on every route (NEW-iferror-masks-a-refusal):
`Evaluator::evaluate`'s top frame turns a formula during whose evaluation a call
was refused for lack of data into that refusal, the way the work budget's
`#LIMIT!` overrides whatever IFERROR made of a runaway formula -- so the
cascade, the cross-sheet walk, a fill and a background write no longer write
IFERROR's / IFNA's 0 or ISNA's FALSE as if computed. A call answered from data or
from the cache is never affected, nor is a custom-function NAME the workbook is
not known to define (no resolver ever served it, no library defines it and the
page does not register it, `CallMemo::knows_custom_function`): that may be a typo, Excel's `#NAME?`,
which IFERROR handles. Its refusal is still reported to the full pass, which
keeps the cell when it may and otherwise writes the ENGINE's answer -- so
`=IFERROR(UNKNOWNFN(RAND()),0)` is 0 on F9, as in Excel [LIVE] (BUG-0615#1; the
pass used to overwrite every such answer with `#NAME?`). Before each Calculate
Now / Calculate Sheet, and at every open, the commands tell every sheet's cache
which names are the workbook's custom functions: the ones its Custom Functions
libraries define AND the ones the page registers -- an add-in's
`formulas.registerFunction` is in no library (`bi::cube::note_library_custom_functions`,
reading `ScriptState::registered_custom_functions`). The page reports its
registry on every change (`note_custom_function_registry`, from
`@api/formulaUdf`'s `installUdfEvaluation`), and a name it stops registering
that no library defines is no longer known (its add-in was unloaded: Excel's
`#NAME?`, which IFERROR handles). So a function used only inside composite
formulas right after an open is KNOWN, and its refusal stays whole -- before
(rev10 rev9A) `=IFERROR(FXRATE("USD",TODAY()),0)` around an add-in's function
saved a plausible 0. Seeding a saved ROOT call files its answer but vouches for
no name: a saved value proves the function existed when it was computed, not
that anything defines it now (rev10).

A recalculation that runs because something CHANGED -- an edit's cascade, the
cross-sheet walk, a fill, a background-sheet write -- never keeps: there, a call
the cache cannot answer has changed arguments, or is a composite nothing has
served yet. An application UPDATE is the exception (round 8,
NEW-update-refuses-composite-formulas): its sheets arrive with the publisher's
values, so its recalculation of them (`calculation::recalculate_installed_sheet_values`)
applies the full pass's rule, with the cells the update itself wrote afterwards
-- the subscriber's overrides, the writeback values, re-rendered pivot output --
counted as changed, and a sheet not yet recalculated counted as changing. It
used to refuse every composite there, and the next save kept the refusal. The
sheets are visited after the installed sheets their formulas name
(`calculation::installed_sheet_order`, rev8A): in index order, an earlier
`Report!B4 =MYFN(Data!A2)*2` counted every reference into the later Data as
changed -- a literal no recalculation can change included -- and an update
that changed nothing it read refused it. Only sheets that read each other (a
cycle) still meet an unsettled sheet, conservatively. The
same rule governs custom functions -- see §4.4.

### 2.5 Known limitations (v1)

- The pre-pass walks the **raw** parsed AST while `update_cell` walks a
  name/table/spill-**resolved** AST, so a cube argument that is a **named range**,
  **structured table reference**, or **spill ref** can diverge → `#N/A`. Use a
  literal or a direct cell reference.
- A cube argument referencing **another formula cell recomputed in the same edit**
  reads the pre-edit snapshot; reference CUBEMEMBER cells or stable inputs.
- A **sheet-qualified** cube argument (`=CUBEVALUE("Sales","[Revenue]",Inputs!B2)`)
  reads the sheet it names -- both the pre-fetch and the evaluator apply
  `engine::cube::qualified_cell_arg` -- and a sheet that does not exist is
  `#REF!`. But a cube OBJECT on another sheet (`Inputs!B2` holding
  `=CUBEMEMBER(...)` or `=CUBESET(...)`) is refused with **`#VALUE!`**: objects
  are resolved only for cells on the sheet a pre-fetch is built for, and keying
  the call on the visible caption would serve some other member's number with no
  error. Put the member expression (or a CUBEMEMBER of its own) on the formula's
  sheet. Until 2026-10-29 a qualified argument read the FORMULA's own sheet at
  the same coordinates, on both sides alike, so the wrong member was served
  silently.
- A cube cell whose argument is changed **from another sheet** (an edit on
  `Inputs` feeding `Sheet1`'s CUBEVALUE through a cross-sheet reference), by a
  **background-sheet write** (`update_cell_on_sheets`, a script writing a sheet
  that is not active), or by a **fill**, is not refreshed: those recalculations
  carry no cube data. Each of its calls is answered from the results cache for
  its exact arguments (2.4) -- never the previous member's number, and `#N/A`
  for a member no recalculation with data has answered. It refreshes at the
  next Calculate Now once the session has seen a CUBE formula, whose full
  refresh covers every sheet (2.3). Calculate Sheet (Shift+F9) pre-fetches
  nothing and answers from the cache.
- A cube call inside a larger formula (`=CUBEVALUE(...)/1000`) that has never
  been served -- a workbook just opened, where only a bare call's saved value
  seeds the cache (2.4) -- keeps its value through a FULL recalculation without
  data (Calculate Now before the latch, every save, an application update's
  recalculation of its sheets) while nothing it reads has changed, but is
  `#N/A` when a recalculation that runs because something changed reaches it
  (an edit's cascade, the cross-sheet walk) until one with data serves it
  (Calculate Now, 2.3). Once served it keeps its correct value on every route
  until the next model refresh, which re-serves it (2.4).
- `CUBEVALUE` member filters are **column-name-only** (the engine `FilterCondition`
  carries no table) — keep member column names unique across tables.

Out of scope (follow-ups): pivot→CUBE conversion; MDX syntax; member-value
existence validation in CUBEMEMBER; full MDX set algebra; a `#GETTING_DATA`
async placeholder.

### 2.x Authoring: the builder lives inside `fx`, not in a menu

A guided builder exists — `CubeFormulaBuilderPanel` in the `CubeFormulas`
extension — and it is reached exactly where every other function is reached:
the **fx** button on the formula bar, Insert Function, pick a `CUBE*` function,
Insert. That is Excel's two-step "Insert Function → Function Arguments", and the
second step is the panel. The panel reads the live model (`biGetModelInfo`,
`biGetColumnValues`) so measures, columns, values and KPIs are PICKED rather
than typed, which matters because a mistyped member expression is a silent
`#N/A` rather than an error.

It used to hang off its own **Formulas ▸ "Insert CUBE Formula..."** item. That
item is **gone**. It made CUBE the only function in the product with a private
front door — invisible from `fx`, where a user actually goes looking for a
function, and discoverable only by someone who already knew it was there.

The shell may not import an extension, so the panel crosses the boundary through
a seam: **`app/src/api/functionBuilders.ts`**. An extension registers a React
component against a set of catalog function names; the fx dialog looks the
selected function up and renders the panel in place of the signature box. Any
other function whose arguments only its owning extension can spell can use the
same seam. Two rules it enforces:

- **The builder does not insert.** It reports the assembled formula through
  `onFormulaChange`; the host owns the Insert button and commits through
  `commitEdit`, so the commit guards, the R1C1 rewrite and the grouped-sheet
  replication all still run. The old standalone dialog called `updateCell`
  itself and skipped all three.
- **No builder is not an error.** `findFunctionBuilder` returns null for almost
  every function, and for a `CUBE*` function when the extension is disabled. The
  dialog then falls back to the ordinary template path — a disabled extension
  costs the user the guided panel, never the ability to type `=CUBEVALUE(`.

---

## 3. `cube.*` script API (Layer 1) and calculated measures (Layer 2)

### 3.1 `cube.*` script API — `bi.query`

Sandboxed scripts reach the same model data through three broker capabilities
under `bi.query` (capability shims in
`app/src/api/scriptHost/worker/{contextShims,extensionWorkerContext}.ts`, served
by `cube_udf_value/kpi/members` in `app/src-tauri/src/bi/cube.rs`):

```js
await cube.value(connection, ...members)   // -> number | null   (cap.cubeValue)
await cube.kpi(connection, kpi, property)   // -> number | null   (cap.cubeKpi)
await cube.members(connection, level)       // -> string[]        (cap.cubeMembers)
```

Member arguments use the same Calcula-native grammar as the worksheet functions.
This is the API that Custom Functions (§4) consume.

### 3.2 Workbook calculated measures (Layer 2)

Users can define **calculated measures** that live in the workbook and overlay
the model (`app/src-tauri/src/bi/measures.rs`):
`bi_get_calculated_measures` / `bi_set_calculated_measures` apply an overlay onto
the model (`model.with_overlay_measures()` + `engine.set_model()`); cube cells
auto-refresh when a measure changes.

Design rules learned from an adversarial review:
- Measures are **model-owned** and synced across all connections sharing the same
  `model_key` (so a shared engine doesn't lose them); siblings are seeded at create.
- A measure's fact table is inferred from its **column** references. A **pure
  measure-reference** expression (e.g. `[Profit]/[Revenue]`) infers an empty
  table → query fails, so those are **rejected** with guidance toward the column
  form (`SUM(Sales[profit])/SUM(Sales[revenue])`).
- **Package-subscribed** (`.calp`) connections reconstruct from the package, so
  calculated measures on them are rejected in v1.

---

## 4. Custom Functions (JS UDFs)

### 4.1 What it is

Users author JavaScript formula functions (`=ADDTAX(price, rate)`) via **Formulas
▸ Custom Functions…**. Each body runs in the **sandboxed script Worker realm**
(broker capabilities + audit), NOT the main thread, and may call `cube.*` when
"BI model access" (`bi.query`) is granted. It is the user-facing realization of
the worker-script-defined UDF path Wave 3 anticipated.

The feature is **all frontend** — it reuses the existing object-script host and
the Wave 3 UDF pre-fetch path, adding **no new Rust** beyond a reserved-id guard
in the script store (§4.5). Implementation: `app/src/api/customFunctions.ts` +
extension `app/extensions/CustomFunctions/`.

### 4.2 How a UDF runs

- `generateLibrarySource(defs)` emits one "function library" script that calls
  `context.expose(NAME, async (params) => { body }, { public: false })` per
  function, binding `cube` from `context.caps`.
- `installCustomFunctions(lib)` mounts the library via `hostMountScript`
  (objectType `workbook`, reserved instanceId `__custom_functions__`, accessLevel
  `restricted`, `declaredCapabilities`), then `registerFunction` per function with
  `implementation: (...args) => callExposedMethod(...)`. A formula `=NAME(args)`
  thus resolves by running the body in the worker; the **existing UDF pre-fetch**
  serves the result to the synchronous evaluator.
- Persistence: the library JSON is stored under the reserved id
  `__calcula_custom_functions__` via `save_script`/`get_script` (it is data, never
  executed as code — we parse + install it ourselves), and reloaded on workbook
  open.

### 4.3 Security model (sound-by-construction)

A custom-function body can only run **within** the hardened Worker realm under its
capability ceiling — there is no escalation path, so body "injection" into the
generated source is a robustness, not a security, concern. Specific properties:

- UDFs are exposed `{ public: false }`: only **trusted host code**
  (`callExposedMethod`, which bypasses the public policy) invokes them. A peer
  sandboxed script cannot reach them via `context.callMethod` and borrow the
  library's `bi.query` grant.
- Function names and parameters are validated (`validateFunctionName` /
  `validateParam`): identifiers only; parameters may not be `cube`/`caps`/
  `context`/`setup` (which would shadow the injected sandbox bindings); built-in
  formula names are rejected (the parser resolves built-ins first, so a colliding
  UDF would silently never run).
- No `fetch` binding is generated (the UI only grants `bi.query`).

### 4.4 Lifecycle correctness — the results cache when no resolver is wired

The Wave 3 UDF resolver is wired only into the **edit** path (`update_cell` /
`update_cells_batch`). A **full recalc** (`calculate_now` — F9, "Calculate
Workbook", a cube refresh) wires no resolver, nor do the cross-sheet walk, a
fill, a background-sheet write or a Rust-side writer. To keep those from
clobbering every custom-function cell to `#NAME?`, the engine's `Custom(name)`
arm answers the call from the sheet's results cache (`preserved_udf_value`)
when no resolver is wired -- exactly the cube rule of §2.4: its arguments are
evaluated, and the answer recorded for exactly those values
(`engine::cube::udf_call_fingerprint`) is served, wherever the call sits
(`=MYFN(A1)`, `=MYFN(A1)*2`, `=IF(..., MYFN(A1))`). Every call a resolver serves
records its answer, root or nested; on open a ROOT call's saved value seeds it
(§2.4). An argument that is itself a refusal for lack of data
(`=MYFN(CUBEVALUE(...))` with no cube data and no recorded cube answer) leaves
no exact fingerprint and refuses too, and a call served with such an argument
is not recorded. `#NAME?` otherwise -- also when a resolver **is** wired but
does not know the name (a genuine unknown / typo; the cache is not consulted
then). The Custom Functions dialog therefore does **not** force a recalc on
save. Before rev3A#3 any stored value was kept, so a changed argument showed the
old argument's answer and `=MYFN(A1)*2` doubled itself at every such
recalculation; round 5 refused `=MYFN(A1)*2` with `#NAME?` on every one of them,
including every F9.

Two consequences, decided on purpose:

- **F9 does not run custom functions.** It serves each call's recorded answer
  for its exact arguments -- what Excel's F9 does for a non-volatile UDF whose
  arguments did not change (it is not dirty, so it is not called). A call with
  no recorded answer -- a composite formula right after an open, where only a
  bare call's saved value seeds the cache -- keeps its cell's stored result
  through F9 and through the save's own recalculation while nothing the cell
  reads has changed (§2.4, round 7; round 6 refused it with `#NAME?` and the
  save wrote that into the file). It is `#NAME?` when something it reads changed
  -- in that pass, while calculation is manual, or by a cascade -- until an edit
  or a batch with a resolver re-evaluates it; wrapped in IFERROR / ISERROR it is
  `#NAME?` too, never the wrapper's fallback, once the workbook is known to
  define the function (§2.4, round 8). Wiring a UDF pass into Calculate
  Now would remove the rest; it is a frontend feature (a full-sheet discovery
  round before `calculate_now`), not built.
- **A VOLATILE custom function** (Excel's `Application.Volatile`) is re-run by
  every edit's UDF pass, which lists its cells (`volatile_cells`). On a route
  with no resolver -- F9 included -- it is served its LAST answer for the same
  arguments rather than re-run; Excel would re-evaluate it. Acceptable and
  documented: the value is the function's own most recent answer, never one
  for other arguments.

The discovery pass (`collect_udf_calls`) resolves calls for exactly the cells
the apply cascade evaluates with the resolver, computed by the same
`commands::data::active_sheet_write_cascade` (dependents, whole-column/row
readers, the volatile built-ins and their dependents, unblocked arrays). It
used to leave the volatile splice out, so a custom-function cell downstream of
a `TODAY()` cell answered `#NAME?` on an unrelated edit.

### 4.5 Transparency & store hygiene

- The reserved-id prefix `__calcula_` is recognized by the Rust script store
  (`is_reserved_script_id`): such records are **filtered out of `list_scripts`**
  (never shown in the Script Editor / code inventory as runnable code) and are
  **rejected by `delete_script` / `rename_script`** (the user cannot wipe or
  rename the store out from under the feature).
- The code inventory ("Code in This File") gains a `formula-udf` population: each
  custom function is shown as a readable function with its `declaredCapabilities`
  ceiling (e.g. `bi.query`) and live mount/grant state — so the sandboxed UDF code
  and its reach are visible, never hidden, per the transparency pillar.

### 4.6 Relay deadline

A relayed exposed-method call (`METHOD_CALL_TIMEOUT_MS`) must be at least as long
as the worker's own broker-call deadline (`CALL_TIMEOUT_MS`, 30s): a BI-backed UDF
body `await`s a `cube.*` capability call, and a shorter relay deadline would
abandon it before the in-worker work could finish. The two are kept equal so the
worker's deadline governs.

### 4.7 LAMBDA alternative

A LAMBDA-based "Define Function…" (DefinedNames) also exists — sandboxed-by-
construction formula functions, cube-aware via `=CUBEVALUE(...)`. Custom Functions
is the **JS** path, for procedural logic and capability calls.

---

## 5. Adversarial review (2026-06-24)

The Custom Functions feature went through a multi-agent adversarial review;
**14 confirmed findings** were fixed (1 HIGH, 9 MEDIUM, 4 LOW). The HIGH finding
was the full-recalc clobber resolved by §4.4. The MEDIUM/LOW findings drove the
security, store-hygiene, transparency, and deadline behavior documented in
§4.3–§4.6. Verification: engine custom/UDF tests (incl. two preserve tests),
`customFunctions` + `codeInventory` unit tests, a reserved-id Rust test, frontend
typecheck, and `cargo check` on the engine + app crates.

---

## 6. Source map

| Concern | Location |
|---|---|
| CUBE parser variants + catalog | `core/parser/src/ast.rs` |
| Cube prefetch types + key | `core/engine/src/cube.rs` |
| Cube/UDF evaluation + answers without data | `core/engine/src/evaluator.rs` (`eval_cube`, `Custom` arm, `preserved_cube_value`, `preserved_udf_value`, `CubeFingerprintResolver`) |
| Results cache (what a call without data is answered from) | `core/engine/src/cube.rs` (`CallMemo`, `udf_call_fingerprint`, `contains_memo_call`), held per sheet by `core/engine/src/grid.rs` |
| Cache seeding on open | `app/src-tauri/src/bi/cube.rs` (`remember_loaded_call_results`), called by `persistence.rs` `open_file` |
| Async cube resolution + `cube_prefetch` | `app/src-tauri/src/bi/cube.rs` |
| Calculated measures | `app/src-tauri/src/bi/measures.rs` |
| `cube.*` capability shims | `app/src/api/scriptHost/worker/{contextShims,extensionWorkerContext}.ts` |
| Custom Functions runtime | `app/src/api/customFunctions.ts` |
| Custom Functions UI | `app/extensions/CustomFunctions/` |
| Reserved-id store guard | `app/src-tauri/src/scripting/commands.rs` |
| Code inventory (formula-udf) | `app/src/api/codeInventory.ts` |
| User-facing function reference | `functions/CUBE*.md` |

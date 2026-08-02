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

`CubePrefetch` is **derived state** — recomputed every recalc from the formula
text — so there are **no `.cala` persistence changes**: cube formulas persist as
ordinary formula text, and their last computed value caches in the cell like any
formula.

### 2.4 Preserve-on-no-prefetch

A recalc that did not pre-fetch cube data (an unrelated edit, a full recalc / F9,
a paste) must not clobber a cube cell to `#N/A`. The evaluator's `eval_cube`
returns the cell's **last computed value** (`preserved_cube_value`) when no
prefetch is present, falling back to `#N/A` only when there is nothing to keep.
(The same preserve idea is mirrored for UDFs — see §4.4.)

### 2.5 Known limitations (v1)

- The pre-pass walks the **raw** parsed AST while `update_cell` walks a
  name/table/spill-**resolved** AST, so a cube argument that is a **named range**,
  **structured table reference**, or **spill ref** can diverge → `#N/A`. Use a
  literal or a direct cell reference.
- A cube argument referencing **another formula cell recomputed in the same edit**
  reads the pre-edit snapshot; reference CUBEMEMBER cells or stable inputs.
- `CUBEVALUE` member filters are **column-name-only** (the engine `FilterCondition`
  carries no table) — keep member column names unique across tables.
- Whole-column/row **dependents** may show a stale value on an unrelated edit;
  they refresh on a direct edit.

Out of scope (follow-ups): a member browser / Insert-CUBE-formula dialog /
pivot→CUBE conversion; MDX syntax; member-value existence validation in
CUBEMEMBER; full MDX set algebra; a `#GETTING_DATA` async placeholder.

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

### 4.4 Lifecycle correctness — preserve-on-no-resolver

The Wave 3 UDF resolver is wired only into the **edit** path (`update_cell` /
`update_cells_batch`). A **full recalc** (`calculate_now` — F9, "Calculate
Workbook", a cube refresh) wires no resolver. To keep a full recalc from
clobbering every custom-function cell to `#NAME?`, the engine's `Custom(name)`
arm now PRESERVES the cell's last value (`preserved_udf_value`) when no resolver
is wired — mirroring the cube preserve in §2.4. `#NAME?` is returned only when a
resolver **is** wired but does not know the name (a genuine unknown / typo), or
when there is nothing to preserve. The Custom Functions dialog therefore does
**not** force a recalc on save.

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
| Cube/UDF evaluation + preserve | `core/engine/src/evaluator.rs` (`eval_cube`, `Custom` arm) |
| Async cube resolution + `cube_prefetch` | `app/src-tauri/src/bi/cube.rs` |
| Calculated measures | `app/src-tauri/src/bi/measures.rs` |
| `cube.*` capability shims | `app/src/api/scriptHost/worker/{contextShims,extensionWorkerContext}.ts` |
| Custom Functions runtime | `app/src/api/customFunctions.ts` |
| Custom Functions UI | `app/extensions/CustomFunctions/` |
| Reserved-id store guard | `app/src-tauri/src/scripting/commands.rs` |
| Code inventory (formula-udf) | `app/src/api/codeInventory.ts` |
| User-facing function reference | `functions/CUBE*.md` |

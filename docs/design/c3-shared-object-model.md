# C3 — One shared object model across the three script runtimes

## The problem

Calcula has **three** places user code runs, and today each has its *own* object
model — "three products with rewrite cliffs":

| Runtime | Where it runs | Object model today |
|---|---|---|
| **Extensions** | main thread, direct `@api` | `CellRange` (`api/range.ts`) + free functions; no Workbook/Sheet |
| **Object scripts** | per-script Worker realm, async RPC | typed per-object contexts (`CellContext`, `SheetContext`, `SlicerContext`, … in `api/scriptableObjects.ts`) |
| **Notebooks / module scripts** | Rust QuickJS over cloned grid | a flat `Calcula.*` op surface (`_shared/lib/calcula.d.ts`) |

The same concept (a cell, a range, a sheet) is modeled three different ways, with
three IntelliSense surfaces and three sets of habits. An author who learns one
surface cannot carry it to another; a feature added to one is absent from the
others.

## The target: one model, additively layered

A single canonical model — **`Workbook → Sheet → Range → Cell`** — bound into all
three runtimes, **specced in one shared `.d.ts`** every Monaco editor loads. The
runtimes then differ only by **additive capability**, not by a different model:

```
            Workbook → Sheet → Range → Cell          (the shared core)
extensions:  + UI registration (ribbon, panels, decorations)
object scripts: + lifecycle hooks (onClick, onChange, onDataChange, …)
notebooks:   + persistence + rewind (GridCheckpoint), cell-by-cell execution
```

Learning `range.setValues(...)` once works everywhere; a new core method appears
on all three surfaces from one definition.

### Canonical interfaces (the spec)

```ts
interface Workbook {
  sheets(): Sheet[] | Promise<Sheet[]>;
  activeSheet(): Sheet | Promise<Sheet>;
  sheet(nameOrIndex: string | number): Sheet | null | Promise<Sheet | null>;
}
interface Sheet {
  readonly index: number;
  readonly name: string;
  readonly visibility: "visible" | "hidden" | "veryHidden";
  range(address: string): Range;          // "A1", "A1:B5"
  cell(row: number, col: number): Cell;   // 0-based
  activate(): void | Promise<void>;
}
interface Range {                          // CellRange already implements most of this
  readonly address: string;
  readonly rowCount: number; readonly colCount: number;
  getValues(): /* sync or async per runtime */;
  setValues(values: string[][]): /* … */;
  offset(dr: number, dc: number): Range; resize(r: number, c: number): Range;
  // … navigation + set-ops already on CellRange
}
type Cell = Range;                         // a single-cell range
```

The async-ness is the **only** per-runtime variation: extensions/object-scripts
return Promises (they cross the Rust boundary); the notebook QuickJS runtime is
synchronous over its cloned grid, so the same shape is sync there.

## Per-runtime binding plan

1. **Extensions (main thread) — DONE.** `CellRange` (`api/range.ts`) is already
   the `Range`, and the `Workbook`/`Sheet` levels sit on top of `getSheets()` /
   `setActiveSheet()` (`api/objectModel.ts`, exported from `@api`).
2. **Sheet-aware `Range` data ops — DONE (step 2).** `CellRange` now carries an
   optional `sheetIndex` (`undefined` = active sheet = unchanged pre-C3 behavior).
   `Sheet.range()` / `Sheet.cell()` bind it, and the data ops
   (`getValue`/`getValues`/`setValue`/`setValues`) route the SAME way the
   object-script host does (`scriptHost/host.ts`): active sheet → `getCell` /
   `updateCellsBatch`; bound non-active sheet → `getWatchCells` (batched read) /
   `updateCellOnSheets` (the existing grouped-sheet write). Navigation
   (`offset`/`resize`/`getCell`/…) preserves the binding. No new backend commands.
   (Formatting/border ops still target the active sheet — a follow-up.)
3. **Object scripts (workers) — DONE (core).** Re-express the typed contexts as
   facets of the canonical model. **Done:** (a) the `sheet` context has
   `range(address)` / `cell(row, col)` returning a canonical `ScriptRange`
   (`scriptHost/worker/canonicalModel.ts`) — a worker-realm Range with the same
   navigation + data ops as the extension `CellRange`, backed by the EXISTING
   restricted `sheet.getCellValue`/`setCellValue` aspects; and (b) unlocked scripts
   get the full cross-object navigation `api.workbook` (`ScriptWorkbook` ->
   `ScriptSheet` -> `ScriptRange`): `sheets()` / `activeSheet()` / `sheet(x)`, each
   sheet's `range()`/`cell()` backed by `sheet.getCellValue`/`setCellValue` WITH a
   `sheetIndex` (cross-sheet reach the host already permits for unlocked tier — no
   new aspect, no allowlist/tier change). Specced in both `scriptableObjects.ts`
   and `objectContexts.d.ts`. **Remaining (polish):** fold the `cell`/`table`/
   `namedRange` contexts onto the same `ScriptRange` shape (they keep bespoke
   shapes today; `namedRange` already has `getValues`/`setValues`).
4. **One shared model spec — DONE (for the bound surfaces).** The canonical
   member set is single-sourced in `api/canonicalModelSpec.ts`
   (`CANONICAL_RANGE_MEMBERS` / `_SHEET_` / `_WORKBOOK_`), and
   `canonicalModelCoverage.test.ts` asserts every surface that binds the model —
   the extension classes (`CellRange`, `Sheet`, `Workbook`), the object-script
   `@api` interfaces (`ScriptRange`/`ScriptSheet`/`ScriptWorkbook`), the worker
   implementation (`canonicalModel.ts`), and the Monaco IntelliSense
   `objectContexts.d.ts` — declares the full set, with a mirror check that the
   `.d.ts` doesn't drift from the `@api` interfaces. So a method added to the
   model in one place but not the others fails the build (same idea as
   `calculaDtsCoverage.test.ts`). The notebook `calcula.d.ts` joins this guard
   once step 5 binds the model there (today it exposes the flat `Calcula.*` ops).
   The one sanctioned per-runtime difference is the value shape (extension
   `getValues` → `CellData`; object-script → display strings); the MEMBER set is
   unified.
5. **Notebooks / module scripts (Rust QuickJS) — DONE.** The model is bound as
   real `rquickjs` objects reached via `Calcula.workbook`
   (`core/script-engine/src/ops/canonical_model.rs`): a `Workbook`/`Sheet`/`Range`
   object graph backed by the cloned `ScriptContext` grids — **synchronous** (it
   owns the cloned grid; methods return values directly, the one sanctioned
   per-runtime difference). Object-creating methods take `Ctx<'js>` as their first
   param and return `Object<'js>`, capturing only `Copy` geometry + `Rc` clones so
   navigation recurses cleanly. Reads/writes go through the same grid path as the
   flat `Calcula.*` ops, which are kept untouched for back-compat. Wired at both
   QuickJS entry points (one-off `runtime.rs` + notebook `notebook.rs`). The
   notebook `calcula.d.ts` (`NotebookRange`/`NotebookSheet`/`NotebookWorkbook`) is
   now under the step-4 drift guard, so all three runtimes are held to one spec.

## Rollout (incremental, low-risk)

Each runtime adopts the canonical model independently behind the same interface,
so there is no big-bang cutover:

1. **(this PR)** Extensions get `Workbook`/`Sheet` (navigation) on the `CellRange`
   seed. Active-sheet range ops; documented.
2. Sheet-aware `Range` (thread `sheetIndex` through the cell ops).
3. Object-script contexts re-expressed as canonical-model facets (transport reused).
4. Single-source the three `.d.ts` surfaces from the canonical model.
5. Rust QuickJS object binding for notebooks (largest), flat ops kept as a shim.

## Status

- **Bounded C3 (done earlier):** the QuickJS `calcula.d.ts` now documents the full
  flat op surface, with a Rust-op→d.ts coverage test.
- **Done:** `Workbook`/`Sheet` object model for extensions (`api/objectModel.ts`),
  the navigation levels above the `CellRange` Range seed — **and** sheet-aware
  `Range` data ops (step 2): a `Sheet.range()`/`cell()` reads/writes THAT sheet,
  active or not, via the `sheetIndex` thread-through on `CellRange`. Covered by
  `range.test.ts` (routing + nav preservation) and `objectModel.test.ts`.
- **Done (step 3, core):** object scripts bind the canonical model — the `sheet`
  context's `range()`/`cell()` and the unlocked `api.workbook` cross-object
  navigation (`ScriptWorkbook`/`ScriptSheet`/`ScriptRange` in
  `scriptHost/worker/canonicalModel.ts`, tested in `canonicalModel.test.ts`),
  all over existing broker aspects.
- **Done (step 4):** the canonical member set is single-sourced
  (`canonicalModelSpec.ts`) and a drift guard (`canonicalModelCoverage.test.ts`)
  holds the extension, object-script, worker, and `.d.ts` surfaces to it.
- **Done (step 5):** the Rust-QuickJS object binding (`Calcula.workbook` →
  `Sheet` → `Range`, `core/script-engine/src/ops/canonical_model.rs`), with the
  notebook `.d.ts` now under the step-4 guard.
- **C3 is complete (steps 1–5):** one `Workbook → Sheet → Range → Cell` model
  across all three runtimes — extensions, object scripts, and notebooks — held to
  a single member spec by the drift guard. The only sanctioned per-runtime
  difference is value shape / async-ness.
- **Polish — done for `table`:** the object-script `table` context now exposes the
  canonical `range()`/`cell()` (`ScriptRange`, in TABLE-RELATIVE coordinates),
  backed by its existing own-object `table.getCellValue`/`setCellValue` aspects —
  no new privileged surface. `cell` (event-only, no single-cell binding or
  own-object read/write aspect) and `namedRange` (whole-range aspects only, no
  per-cell access) keep their bespoke shapes: backing a full `ScriptRange` there
  would require new broker aspects, which the rest of C3 deliberately avoided.

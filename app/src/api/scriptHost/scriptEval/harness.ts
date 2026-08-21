//! FILENAME: app/src/api/scriptHost/scriptEval/harness.ts
// PURPOSE: Execute one eval candidate against a task's fixture and observe what
//          it actually DID — the executor half of expected-diff grading.
// CONTEXT: docs/design/local-model-script-authoring.md §5 (L3). The grading
//          itself (`gradeOutcome`) is pure and lives in index.ts; this file is
//          the only place a corpus script RUNS.
//
//          WHY THIS IS NOT THE EMULATION THE DRY RUN REFUSES TO BE.
//          `ai_dry_run_script` declines object scripts because rebuilding the
//          Worker realm's 358-member surface in another realm reports the
//          emulator's gaps as the script's defects. This harness does the
//          opposite: the SURFACE IS THE REAL ONE — `buildWorkerContext` builds
//          the production context, `wrapModuleSource` performs the production
//          mount transform, hook dispatch is the production `dispatchEvent`,
//          and every broker call runs the production `ALLOWLIST` validator and
//          capability ceiling. Only the BACKEND behind the broker is fake: an
//          in-memory grid serving the handful of methods the corpus exercises.
//          A real-but-unserved method is reported as a HARNESS GAP and the task
//          becomes ungradable for that candidate — never a model failure. Two
//          things keep the fake backend honest: Layer A requires every
//          reference solution to grade 1.0 through it, and the gap mechanism
//          refuses to guess about anything it does not implement.
//
//          KNOWN, ACCEPTED LIMITS (documented, not hidden):
//           - No formula evaluation. A formula cell reads back with an empty
//             display; grading pins the formula TEXT instead (`match`).
//           - Sorting does not shift relative refs in moved formulas (the
//             backend does); no graded fixture seeds formulas into a sort.
//           - FORMATS are unobservable in grading: readBack carries input
//             strings only, so a formatting sub-goal is graded by call
//             presence (mustCall), never by effect. Format-centric tasks
//             (grid-bold-header-row, shape-format-number-columns) carry no
//             outcome at all for this reason.
//           - cap.fetch answers the stubbed body for ANY url/method — the
//             graded tasks pin the VALUE that lands in the grid, not the
//             endpoint that produced it.
//           - The context is not frozen and ambient globals are hardened only
//             by parameter shadowing (explicit `globalThis.` reaches Node) —
//             the SUBPROCESS is the sandbox for untrusted candidates
//             (grade-child.mjs: scrubbed env, permission model, hard kill).

import { buildWorkerContext, dispatchEvent } from "../worker/contextShims";
import { wrapModuleSource } from "../worker/debugWrapper";
import { ALLOWLIST } from "../allowlist";
import { validateScriptSource } from "../scriptValidation";
import type { MountSpec, W2H } from "../protocol";
import type { EvalTask, OutcomeObservation, TaskOutcome } from "./index";

/** A member the real surface has but this harness does not serve. */
class HarnessGapError extends Error {
  constructor(public readonly member: string) {
    super(`the eval harness does not implement ${member}`);
    this.name = "HarnessGapError";
  }
}

const SETUP_TIMEOUT_MS = 2_000;
const EVENT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// The in-memory grid, speaking the cell-input-string vocabulary
// ---------------------------------------------------------------------------

/**
 * One cell, stored as its INPUT STRING — the same canonical form
 * `cell_input_string` (Rust) renders: formulas "=...", integers without ".0",
 * text verbatim, TRUE/FALSE, "" for empty. Type is derived from the input the
 * way user entry derives it, so a `setCellValue(r, c, 42)` and a fixture seed
 * "42" are indistinguishable — which is exactly what grading needs.
 */
interface HarnessCell {
  input: string;
  format: Record<string, unknown>;
}

type CellShape = {
  value: string | number | boolean | null;
  display: string;
  type: "number" | "text" | "boolean" | "empty" | "error";
  formula?: string;
};

class HarnessGrid {
  cells = new Map<string, HarnessCell>();

  private key(row: number, col: number): string {
    return `${row},${col}`;
  }

  input(row: number, col: number): string {
    return this.cells.get(this.key(row, col))?.input ?? "";
  }

  setInput(row: number, col: number, raw: string): void {
    // Canonicalize numeric spellings the way the backend does: the product
    // parses "36.00" into the NUMBER 36, whose cell_input_string is "36"
    // (integers without ".0"). Storing the author's spelling verbatim made
    // `sum.toFixed(2)` grade as the wrong value while the product would have
    // read it back canonical — a correct script graded wrong.
    let input = raw;
    if (input !== "" && !input.startsWith("=") && input !== "TRUE" && input !== "FALSE") {
      const n = Number(input);
      if (input.trim() !== "" && Number.isFinite(n)) input = String(n);
    }
    const k = this.key(row, col);
    const existing = this.cells.get(k);
    if (input === "") {
      if (existing) existing.input = "";
      return;
    }
    if (existing) existing.input = input;
    else this.cells.set(k, { input, format: {} });
  }

  mergeFormat(row: number, col: number, fmt: Record<string, unknown>): void {
    const k = this.key(row, col);
    const existing = this.cells.get(k);
    if (existing) Object.assign(existing.format, fmt);
    else this.cells.set(k, { input: "", format: { ...fmt } });
  }

  format(row: number, col: number): Record<string, unknown> {
    return this.cells.get(this.key(row, col))?.format ?? {};
  }

  entries(): Array<{ row: number; col: number; cell: HarnessCell }> {
    return [...this.cells.entries()]
      .map(([k, cell]) => {
        const [row, col] = k.split(",").map(Number);
        return { row, col, cell };
      })
      .sort((a, b) => a.row - b.row || a.col - b.col);
  }
}

/** Derive the typed shape a `ScriptCell` reports from an input string. */
function shapeOf(input: string): CellShape {
  if (input === "") return { value: null, display: "", type: "empty" };
  if (input.startsWith("=")) {
    // No evaluator here. The formula text is truthful; the computed value is
    // reported as empty rather than guessed — see the header.
    return { value: null, display: "", type: "text", formula: input };
  }
  if (input === "TRUE" || input === "FALSE") {
    return { value: input === "TRUE", display: input, type: "boolean" };
  }
  const n = Number(input);
  if (input.trim() !== "" && Number.isFinite(n)) {
    return { value: n, display: input, type: "number" };
  }
  return { value: input, display: input, type: "text" };
}

/** `setCellValue` semantics: typed exactly as if the user entered it. */
function inputFromWrite(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value); // stored as text
    return String(value);
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// The fake backend: broker method -> answer over the grid
// ---------------------------------------------------------------------------

interface BackendState {
  grid: HarnessGrid;
  output: string[];
  stubs: NonNullable<TaskOutcome["stubs"]>;
  exposedNames: () => string[];
  sheetNames: string[];
  nextJobId: number;
  /** stubs.failWrite fires ONCE; this remembers whether it already has. */
  failWriteSpent: boolean;
  /**
   * Set once `api.addSheet` succeeds. In the product a new sheet becomes
   * ACTIVE, so every later unqualified grid call lands THERE — a state this
   * one-grid harness cannot model. Serving those calls against the fixture
   * grid would silently answer the wrong question, so they gap instead.
   */
  activeSheetMoved: boolean;
}

/**
 * Gap on any explicit sheet argument that names anything but the fixture
 * sheet, and on every unqualified call after `addSheet` moved the active
 * sheet. The validators accept these arguments, so silently dropping them
 * served the WRONG sheet's answer as though it were the right one.
 */
function assertFixtureSheet(state: BackendState, method: string, sheet: unknown): void {
  if (state.activeSheetMoved) {
    throw new HarnessGapError(`${method} after addSheet moved the active sheet`);
  }
  if (sheet === undefined || sheet === null || sheet === 0 || sheet === "Sheet1") return;
  throw new HarnessGapError(`${method} with a sheet argument (${JSON.stringify(sheet)})`);
}

function formatLogArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function cellsInRange(
  grid: HarnessGrid,
  r1: number,
  c1: number,
  r2: number,
  c2: number,
): Array<{ row: number; col: number; input: string }> {
  return grid
    .entries()
    .filter(({ row, col }) => row >= r1 && row <= r2 && col >= c1 && col <= c2)
    .map(({ row, col, cell }) => ({ row, col, input: cell.input }));
}

/**
 * Row comparison, mirroring `compare_rows_by_fields` (data.rs): type order
 * Numbers < Text < Booleans < Errors < Empty, numeric compare within numbers,
 * case-insensitive text unless matchCase, and `descending` REVERSES the whole
 * ordering — which places empties FIRST descending, exactly like the backend.
 */
function compareCellInputs(a: string, b: string, matchCase: boolean): number {
  const sa = shapeOf(a);
  const sb = shapeOf(b);
  const rank = (s: CellShape): number =>
    s.type === "number" ? 0 : s.type === "text" ? 1 : s.type === "boolean" ? 2 : s.type === "error" ? 3 : 4;
  const ra = rank(sa);
  const rb = rank(sb);
  if (ra !== rb) return ra - rb;
  if (sa.type === "number" && sb.type === "number") {
    return (sa.value as number) - (sb.value as number);
  }
  if (sa.type === "boolean" && sb.type === "boolean") {
    return Number(sa.value) - Number(sb.value);
  }
  const ta = matchCase ? String(sa.display) : String(sa.display).toLowerCase();
  const tb = matchCase ? String(sb.display) : String(sb.display).toLowerCase();
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

/**
 * Answer one broker call. Throws `HarnessGapError` for anything real that this
 * backend does not serve. Method names are the broker's own — the same keys
 * `ALLOWLIST` uses — so a renamed method fails loudly here rather than
 * answering the wrong question.
 */
function respond(state: BackendState, method: string, args: unknown[]): unknown {
  const { grid, output, stubs } = state;
  switch (method) {
    // ---- base ----
    case "base.log": {
      output.push(formatLogArgs(args));
      return undefined;
    }
    case "base.notify": {
      output.push(String(args[0]));
      return undefined;
    }
    case "base.expose":
    case "base.unexpose":
      // The worker-side runtime already tracks the registration; the host-side
      // relay has no meaning without a live broker registry.
      return undefined;

    // ---- grid: single cells ----
    case "api.getCellValue": {
      const [row, col, sheet] = args as [number, number, unknown];
      assertFixtureSheet(state, method, sheet);
      return shapeOf(grid.input(row, col)).display;
    }
    case "api.setCellValue": {
      const [row, col, value, sheet] = args as [number, number, unknown, unknown];
      assertFixtureSheet(state, method, sheet);
      failWriteIfStubbed(state, row, col);
      grid.setInput(row, col, inputFromWrite(value));
      return undefined;
    }
    case "api.setCellFormula": {
      const [row, col, formula, opts] = args as [number, number, string | null, { sheetIndex?: unknown } | undefined];
      assertFixtureSheet(state, method, opts?.sheetIndex);
      const trimmed = typeof formula === "string" ? formula.trim() : "";
      if (formula === null || trimmed === "") {
        grid.setInput(row, col, "");
      } else {
        grid.setInput(row, col, trimmed.startsWith("=") ? trimmed : `=${trimmed}`);
      }
      return undefined;
    }
    case "api.getCellFormula": {
      const [row, col, opts] = args as [number, number, { sheetIndex?: unknown } | undefined];
      assertFixtureSheet(state, method, opts?.sheetIndex);
      const input = grid.input(row, col);
      return input.startsWith("=") ? input : null;
    }

    // ---- grid: ranges ----
    case "api.getRangeValues": {
      const [r1, c1, r2, c2, sheet] = args as [number, number, number, number, unknown];
      assertFixtureSheet(state, method, sheet);
      const rows: CellShape[][] = [];
      for (let r = r1; r <= r2; r++) {
        const rowCells: CellShape[] = [];
        for (let c = c1; c <= c2; c++) rowCells.push(shapeOf(grid.input(r, c)));
        rows.push(rowCells);
      }
      return rows;
    }
    case "api.clearRange": {
      const [r1, c1, r2, c2, opts, sheet] = args as [
        number,
        number,
        number,
        number,
        { applyTo?: string } | undefined,
        unknown,
      ];
      assertFixtureSheet(state, method, sheet);
      const applyTo = opts?.applyTo ?? "all";
      let count = 0;
      for (const { row, col, input } of cellsInRange(grid, r1, c1, r2, c2)) {
        if (input === "") continue;
        count++;
        if (applyTo !== "formats") grid.setInput(row, col, "");
      }
      return { count };
    }
    case "api.getUsedRange": {
      const [sheet] = args as [unknown];
      assertFixtureSheet(state, method, sheet);
      // EVERY stored entry bounds the used range — format-only cells and
      // cleared husks included — because the engine's used_range spans every
      // key in the cell map, not just the ones with content.
      const used = grid.entries();
      if (used.length === 0) return { startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true };
      return {
        startRow: Math.min(...used.map((u) => u.row)),
        startCol: Math.min(...used.map((u) => u.col)),
        endRow: Math.max(...used.map((u) => u.row)),
        endCol: Math.max(...used.map((u) => u.col)),
        empty: false,
      };
    }

    // ---- find / replace ----
    case "api.findAll": {
      const [query, opts] = args as [
        string,
        {
          caseSensitive?: boolean;
          matchEntireCell?: boolean;
          searchFormulas?: boolean;
          range?: unknown;
          sheetIndex?: unknown;
        } | undefined,
      ];
      // Validated-but-unserved options must GAP, not silently answer the
      // whole-sheet question as though it were the ranged one.
      if (opts?.searchFormulas) throw new HarnessGapError("api.findAll options.searchFormulas");
      if (opts?.range !== undefined) throw new HarnessGapError("api.findAll options.range");
      assertFixtureSheet(state, method, opts?.sheetIndex);
      const caseSensitive = opts?.caseSensitive ?? false;
      const entire = opts?.matchEntireCell ?? false;
      const norm = (s: string) => (caseSensitive ? s : s.toLowerCase());
      const q = norm(query);
      const matches = grid
        .entries()
        .filter(({ cell }) => {
          if (cell.input === "") return false;
          const text = norm(shapeOf(cell.input).display);
          return entire ? text === q : text.includes(q);
        })
        .map(({ row, col }) => ({ row, col }));
      return { matches, totalCount: matches.length };
    }
    case "api.replaceAll": {
      const [search, replacement, opts] = args as [
        string,
        string,
        {
          caseSensitive?: boolean;
          matchEntireCell?: boolean;
          searchFormulas?: boolean;
          range?: unknown;
          sheetIndex?: unknown;
        } | undefined,
      ];
      if (opts?.searchFormulas) throw new HarnessGapError("api.replaceAll options.searchFormulas");
      if (opts?.range !== undefined) throw new HarnessGapError("api.replaceAll options.range");
      assertFixtureSheet(state, method, opts?.sheetIndex);
      const caseSensitive = opts?.caseSensitive ?? false;
      const entire = opts?.matchEntireCell ?? false;
      let replacementCount = 0;
      for (const { row, col, cell } of grid.entries()) {
        if (cell.input === "" || cell.input.startsWith("=")) continue; // formulas never rewritten
        const shape = shapeOf(cell.input);
        if (shape.type === "boolean") continue;
        const text = shape.display;
        const replaced = caseSensitive
          ? text.split(search).join(replacement)
          : replaceCaseInsensitive(text, search, replacement);
        if (replaced === text) continue;
        if (entire && replaced !== replacement) continue; // only whole-cell matches
        grid.setInput(row, col, replaced);
        replacementCount++;
      }
      return { replacementCount };
    }

    // ---- sort ----
    case "api.sortRange": {
      const [r1, c1, r2, , fields, opts] = args as [
        number,
        number,
        number,
        number,
        Array<{ key: number; ascending?: boolean }>,
        { matchCase?: boolean; hasHeaders?: boolean; orientation?: string } | undefined,
      ];
      if (opts?.orientation === "columns") throw new HarnessGapError("api.sortRange orientation:columns");
      assertFixtureSheet(state, method, args[6]);
      const matchCase = opts?.matchCase ?? false;
      const dataStart = opts?.hasHeaders ? r1 + 1 : r1;
      const c2 = args[3] as number;
      // Materialize the data rows (cells move whole, formats included).
      const rows: Array<{ index: number; cells: Array<HarnessCell | undefined> }> = [];
      for (let r = dataStart; r <= (r2 as number); r++) {
        const rowCells: Array<HarnessCell | undefined> = [];
        for (let c = c1; c <= c2; c++) {
          const found = grid.cells.get(`${r},${c}`);
          rowCells.push(found ? { input: found.input, format: { ...found.format } } : undefined);
        }
        rows.push({ index: r - dataStart, cells: rowCells });
      }
      const sorted = [...rows].sort((a, b) => {
        for (const f of fields) {
          const ia = a.cells[f.key]?.input ?? "";
          const ib = b.cells[f.key]?.input ?? "";
          let cmp = compareCellInputs(ia, ib, matchCase);
          // Descending reverses the WHOLE ordering, empties-first included —
          // the backend applies ordering.reverse(), and so does this.
          if (f.ascending === false) cmp = -cmp;
          if (cmp !== 0) return cmp;
        }
        return a.index - b.index; // stable
      });
      sorted.forEach((rowData, i) => {
        const target = dataStart + i;
        for (let c = c1; c <= c2; c++) {
          const cell = rowData.cells[c - c1];
          if (cell) grid.cells.set(`${target},${c}`, cell);
          else grid.cells.delete(`${target},${c}`);
        }
      });
      // The backend reports the size of the sorted block (rows.len()), not
      // how many rows changed position.
      return sorted.length;
    }

    // ---- formats ----
    case "api.setRangeFormat": {
      const [r1, c1, r2, c2, fmt, sheet] = args as [
        number,
        number,
        number,
        number,
        Record<string, unknown>,
        unknown,
      ];
      assertFixtureSheet(state, method, sheet);
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) grid.mergeFormat(r, c, fmt);
      }
      return undefined;
    }
    case "api.getCellFormat": {
      const [row, col, sheet] = args as [number, number, unknown];
      assertFixtureSheet(state, method, sheet);
      // The product's readback is FULLY populated (every ScriptCellFormat key,
      // borders as {style,color}, resolved-color twins). A partial default
      // shape here would hand a candidate `undefined` where the product hands
      // a value, and its guard logic would branch differently.
      const noBorder = { style: "none", color: "#000000" };
      return {
        bold: false,
        italic: false,
        underline: "none",
        strikethrough: false,
        fontSize: 11,
        fontFamily: "Calibri",
        textColor: "#000000",
        textColorResolved: "#000000",
        backgroundColor: "#ffffff",
        backgroundColorResolved: "#ffffff",
        textAlign: "general",
        verticalAlign: "bottom",
        numberFormat: "General",
        wrapText: false,
        textRotation: "none",
        indent: 0,
        shrinkToFit: false,
        locked: true,
        formulaHidden: false,
        borderTop: { ...noBorder },
        borderRight: { ...noBorder },
        borderBottom: { ...noBorder },
        borderLeft: { ...noBorder },
        borderDiagonalDown: { ...noBorder },
        borderDiagonalUp: { ...noBorder },
        ...grid.format(row, col),
      };
    }

    // ---- workbook-level odds and ends ----
    case "api.getSheetNames":
      return [...state.sheetNames];
    case "api.getActiveSheet":
      return 0;
    case "api.getSelection":
      return null; // nothing selected in a headless run
    case "api.recalculate":
      return { cellsUpdated: 0 }; // no evaluator; a no-op is the honest answer
    case "api.addSheet": {
      const [name] = args as [string | undefined];
      const sheetName = name ?? `Sheet${state.sheetNames.length + 1}`;
      if (state.sheetNames.includes(sheetName)) throw new Error(`A sheet named "${sheetName}" already exists`);
      state.sheetNames.push(sheetName);
      // The product ACTIVATES the new sheet; later unqualified grid calls gap
      // rather than silently landing on the fixture grid. See BackendState.
      state.activeSheetMoved = true;
      return { index: state.sheetNames.length - 1, name: sheetName };
    }
    case "api.createTable": {
      const [, , , , opts] = args as [number, number, number, number, { name?: string } | undefined];
      return { kind: "table", id: "tbl-eval-1", name: opts?.name || "Table1", sheetIndex: 0 };
    }
    case "api.listObjects":
      return [];

    // ---- cosmetic no-ops a candidate plausibly adds ----
    // Served rather than gapped so one flourish call cannot make a WRONG
    // script ungradable and escape the outcome check on static marks alone.
    // Each is a pure UI effect with no observable grid consequence.
    case "api.select":
    case "api.scrollTo":
    case "api.setStatusBar":
    case "api.autoFitColumns":
    case "api.autoFitRows":
      return undefined;

    // ---- range-object routes (api.range(...).setValue and friends) ----
    case "sheet.getCellValue": {
      const [row, col, sheet] = args as [number, number, unknown];
      assertFixtureSheet(state, method, sheet);
      return shapeOf(grid.input(row, col)).display;
    }
    case "sheet.setCellValue": {
      const [row, col, value, sheet] = args as [number, number, unknown, unknown];
      assertFixtureSheet(state, method, sheet);
      failWriteIfStubbed(state, row, col);
      grid.setInput(row, col, inputFromWrite(value));
      return undefined;
    }
    case "sheet.setRangeValues": {
      const [r1, c1, values, sheet] = args as [number, number, unknown[][], unknown];
      assertFixtureSheet(state, method, sheet);
      values.forEach((rowVals, dr) =>
        rowVals.forEach((v, dc) => grid.setInput(r1 + dr, c1 + dc, inputFromWrite(v))),
      );
      return undefined;
    }

    // ---- capabilities ----
    case "cap.storageGet": {
      const [key] = args as [string];
      return storageOf(state).get(key) ?? null;
    }
    case "cap.storageSet": {
      const [key, value] = args as [string, string];
      storageOf(state).set(key, String(value));
      return undefined;
    }
    case "cap.fetch": {
      const body = stubs.fetchJson !== undefined ? JSON.stringify(stubs.fetchJson) : "{}";
      return { status: 200, headers: {}, body };
    }
    case "cap.dialogAlert":
      return undefined;
    case "cap.dialogConfirm":
      // Default false: dismissal is the canned answer unless the task says yes,
      // matching the product where Cancel/Escape/close all resolve false.
      return stubs.confirm ?? false;
    case "cap.dialogPrompt":
      return stubs.promptText ?? null;
    case "cap.scheduleEvery": {
      const [intervalSecs, handlerName] = args as [number, string];
      if (!state.exposedNames().includes(handlerName)) {
        throw new Error(`handler must be the name of a method this script exposed with context.expose(...)`);
      }
      return { id: `job-${state.nextJobId++}`, kind: "every", intervalSecs, handler: handlerName };
    }
    case "cap.scheduleList":
      return [];

    default:
      throw new HarnessGapError(method);
  }
}

/**
 * Fire the injected write failure exactly once, when the write targets the
 * stubbed cell. This is how an error-HANDLING task gets an error to handle:
 * a candidate with try/catch surfaces it, a candidate without one crashes the
 * run, and a candidate that never writes never trips it.
 */
function failWriteIfStubbed(state: BackendState, row: number, col: number): void {
  const target = state.stubs.failWrite;
  if (!target || state.failWriteSpent) return;
  if (target.row === row && target.col === col) {
    state.failWriteSpent = true;
    throw new Error("Injected write failure (eval stub): the workbook refused this write");
  }
}

const storageStore = new WeakMap<BackendState, Map<string, string>>();
function storageOf(state: BackendState): Map<string, string> {
  let store = storageStore.get(state);
  if (!store) {
    store = new Map();
    storageStore.set(state, store);
  }
  return store;
}

function replaceCaseInsensitive(text: string, search: string, replacement: string): string {
  if (search === "") return text;
  const lower = text.toLowerCase();
  const q = search.toLowerCase();
  let out = "";
  let i = 0;
  for (;;) {
    const at = lower.indexOf(q, i);
    if (at === -1) {
      out += text.slice(i);
      return out;
    }
    out += text.slice(i, at) + replacement;
    i = at + search.length;
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} did not settle within ${ms / 1000}s`)),
      ms,
    );
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * The payload the product's forwarder sends with each hook — mirrored from the
 * `button:clicked` emitter (`{ instanceId, x, y }` thinned to `{ x, y }`).
 */
function hookPayload(event: string): unknown {
  return event === "onClick" || event === "onDoubleClick" ? { x: 0, y: 0 } : undefined;
}

/**
 * Run one candidate against a task's outcome spec and report what happened.
 *
 * The mount is the production transform verbatim: `wrapModuleSource`'s own
 * text, evaluated as the function it wraps. `event` names the HOOK the product
 * fires — for a button, `button:clicked` reaches ONLY handlers registered via
 * `context.onClick(handler)`; a script that merely `expose`s a method named
 * "onClick" never hears a click, and this harness reports that exactly as the
 * product behaves (the click-path diagnosis calls it "never registered a click
 * handler"). That fidelity is load-bearing: the corpus shipped teaching the
 * exposed form, and only an executor faithful to the hook path could tell.
 */
export async function runTaskOutcome(task: EvalTask, source: string): Promise<OutcomeObservation> {
  const outcome = task.outcome;
  if (!outcome) throw new Error(`task ${task.id} carries no outcome spec`);

  const grid = new HarnessGrid();
  for (const seed of outcome.fixture ?? []) grid.setInput(seed.row, seed.col, seed.value);
  const seededInputs = new Map(grid.entries().map(({ row, col, cell }) => [`${row},${col}`, cell.input]));

  const output: string[] = [];
  let harnessGap: string | undefined;
  let hookError: string | undefined;

  const declared = new Set<string>(validateScriptSource(source).declared);

  const state: BackendState = {
    grid,
    output,
    stubs: outcome.stubs ?? {},
    exposedNames: () => [],
    sheetNames: ["Sheet1"],
    nextJobId: 1,
    failWriteSpent: false,
    activeSheetMoved: false,
  };

  const spec: MountSpec = {
    protocolVersion: 1,
    scriptId: `eval-${task.id}`,
    objectType: task.objectType,
    instanceId: "eval-instance",
    tier: "unlocked",
    capabilities: [...declared] as MountSpec["capabilities"],
    apiVersion: "1.0",
    source: "",
    scriptName: task.id,
    snapshot: {},
  };

  let settle: (callId: number, ok: boolean, value?: unknown, error?: { code: string; message: string }) => void =
    () => {};
  const post = (msg: W2H): void => {
    if (msg.t === "error") {
      // dispatchEvent reports a throwing/rejecting handler here and RETURNS
      // NORMALLY — reading only the dispatch result would call that a clean
      // run, which is the async-silent-failure shape this project keeps
      // finding. First error wins; later ones add no verdict.
      hookError ??= msg.message;
      return;
    }
    if (msg.t !== "call") return;
    const { callId, method, args } = msg;
    queueMicrotask(() => {
      const policy = ALLOWLIST[method];
      if (!policy) {
        settle(callId, false, undefined, { code: "UnknownMethod", message: `Unknown method: ${method}` });
        return;
      }
      const verdict = policy.validate(args);
      if (verdict !== true) {
        settle(callId, false, undefined, { code: "ValidationError", message: `${method}: ${verdict}` });
        return;
      }
      if (policy.capability && !declared.has(policy.capability)) {
        // The broker denies outside the declared ceiling BEFORE any grant
        // check (§5b) — an undeclared capability dies here at run time.
        settle(callId, false, undefined, {
          code: "PermissionDenied",
          message: `${method} requires the "${policy.capability}" capability, which this script does not declare`,
        });
        return;
      }
      try {
        settle(callId, true, respond(state, method, args), undefined);
      } catch (e) {
        if (e instanceof HarnessGapError) harnessGap ??= e.member;
        settle(callId, false, undefined, {
          code: "HostError",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    });
  };

  const { context, rt } = buildWorkerContext(spec, post);
  settle = (callId, ok, value, error) => rt.settleCall(callId, ok, value, error);
  state.exposedNames = () => [...rt.exposed.keys()];

  const finish = (ran: boolean, error?: string): OutcomeObservation => {
    let totalChanges = 0;
    const seen = new Set<string>();
    for (const { row, col, cell } of grid.entries()) {
      const k = `${row},${col}`;
      seen.add(k);
      if ((seededInputs.get(k) ?? "") !== cell.input) totalChanges++;
    }
    for (const [k, input] of seededInputs) {
      if (!seen.has(k) && input !== "") totalChanges++;
    }
    const readBack = (outcome.expect ?? []).map((e) => ({
      row: e.row,
      col: e.col,
      value: grid.input(e.row, e.col),
    }));
    return { ran, error, harnessGap, readBack, output: [...output], totalChanges };
  };

  // The production mount transform, verbatim. The blob-import step is replaced
  // by compiling the same wrapper text as a function expression; the prefix
  // check makes a wrapper-shape change a loud failure instead of a drifted one.
  const wrapped = wrapModuleSource(source);
  const PREFIX = "export default ";
  if (!wrapped.startsWith(PREFIX)) {
    throw new Error("wrapModuleSource no longer emits the expected wrapper; update harness.ts with it");
  }
  // Realm parity for the ambient globals. The worker realm NEUTERS its network
  // and storage globals (`workerHardening.ts` NEUTERED_GLOBALS) and has no
  // `process`/`require` at all; Node has all of them, and a candidate calling
  // bare `fetch()` here would otherwise make a REAL network request from
  // untrusted code — while in the product that same script throws. Shadowing
  // via an outer function's parameters covers every bare reference in the
  // candidate body; reaching them through an explicit `globalThis.` is not
  // covered, which is one of the two reasons untrusted candidates run inside
  // the sandboxed subprocess rather than here.
  const NEUTERED = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "indexedDB", "caches", "importScripts"];
  const ABSENT = ["process", "require", "module", "exports", "Buffer", "__dirname", "__filename"];
  const neuteredStub = (name: string) => () => {
    throw new Error(`${name} is not available (sandboxed worker realm)`);
  };
  let entry: (ctx: unknown) => unknown;
  try {
    const factory = new Function(
      ...NEUTERED,
      ...ABSENT,
      `"use strict"; return (${wrapped.slice(PREFIX.length)});`,
    ) as (...shadows: unknown[]) => (ctx: unknown) => unknown;
    entry = factory(...NEUTERED.map(neuteredStub), ...ABSENT.map(() => undefined));
  } catch (e) {
    return finish(false, `the script failed to compile: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    await withTimeout(Promise.resolve(entry(context)), SETUP_TIMEOUT_MS, "setup(context)");
  } catch (e) {
    return finish(false, `setup(context) threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!rt.hooks.has(outcome.event)) {
    const exposedInstead = rt.exposed.has(outcome.event);
    return finish(
      false,
      exposedInstead
        ? `the script exposes a method named "${outcome.event}", but the product fires the ` +
            `"${outcome.event}" HOOK — context.expose(...) never receives it. Register it with ` +
            `context.${outcome.event}(handler).`
        : `the script never registers the "${outcome.event}" hook (for a button, the click handler is ` +
            `context.onClick(handler))`,
    );
  }

  /**
   * Wait until no broker call is in flight, across two consecutive macrotask
   * turns, before the grid is observed.
   *
   * `dispatchEvent` awaits only the thenables a handler RETURNS. A handler
   * written `() => { api.getCellValue(...).then(v => api.setCellValue(...)) }`
   * settles the dispatch while its tail write's respond() microtask is still
   * queued — and in the product there is no early observation point at all
   * (the host executes each call as its message arrives), so that candidate
   * performs the task correctly. Snapshotting before quiescence graded the
   * .then idiom as wrong-valued and fed the repair loop a false diagnosis —
   * the high-severity finding of this file's adversarial review. Two quiet
   * turns, not one: pending can read 0 in the gap between a settle and the
   * continuation that issues the NEXT call.
   */
  const drainBrokerTraffic = async (): Promise<string | undefined> => {
    const startedAt = Date.now();
    let quiet = 0;
    while (quiet < 2) {
      if (Date.now() - startedAt > EVENT_TIMEOUT_MS) {
        return `broker calls were still in flight ${EVENT_TIMEOUT_MS / 1000}s after the handler returned`;
      }
      quiet = rt.pending.size > 0 ? 0 : quiet + 1;
      await new Promise((r) => setTimeout(r, 0));
    }
    return undefined;
  };

  // Sequential fires: a persistence task ("count clicks across sessions")
  // cannot be separated from a reset by a single click — both write "1".
  const fires = Math.max(1, outcome.eventCount ?? 1);
  for (let i = 0; i < fires; i++) {
    try {
      await withTimeout(
        Promise.resolve(dispatchEvent(rt, outcome.event, hookPayload(outcome.event), post)),
        EVENT_TIMEOUT_MS,
        `the "${outcome.event}" handler`,
      );
    } catch (e) {
      return finish(false, `the "${outcome.event}" handler failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const stuck = await drainBrokerTraffic();
    if (stuck !== undefined) return finish(false, stuck);
    if (hookError !== undefined) {
      return finish(false, `the "${outcome.event}" handler threw: ${hookError}`);
    }
  }
  return finish(true);
}

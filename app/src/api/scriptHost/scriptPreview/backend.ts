//! FILENAME: app/src/api/scriptHost/scriptPreview/backend.ts
// PURPOSE: Answer a broker call against a preview grid instead of the workbook —
//          the substituted BACKEND that makes a dry run possible without a
//          document to write to.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.
//
//          WHAT IS REAL AND WHAT IS NOT — the distinction the whole rung rests
//          on. The SURFACE is the product's: `buildWorkerContext` builds all of
//          it, `wrapModuleSource` performs the mount transform, hook dispatch is
//          the product's dispatcher, and every call is admitted or refused by
//          the real `ALLOWLIST` policy through the real `brokerCall`. Only what
//          sits BEHIND the broker is substituted: this file, an in-memory grid.
//
//          That is why this is not the emulation `ai_dry_run_script` declines to
//          be. That rung declines because its REALM shares 19 of the Worker
//          realm's context members and rejects `export` outright, so its verdict
//          describes the emulator. Here the realm is the real one and the
//          question is only ever "can this backend answer this call" — which has
//          an honest answer for every method: serve it, or GAP.
//
//          THE GAP DISCIPLINE. A real member this backend does not implement
//          throws `PreviewGapError`, the run becomes INAPPLICABLE, and no
//          conclusion is drawn about the script. Never a defect, never a guess.
//          Two things keep the served methods honest: every corpus reference
//          solution must grade 1.0 through this backend (Layer A,
//          scriptEval/__tests__/corpus.test.ts), and anything not implemented
//          refuses to answer rather than approximating.
//
//          KNOWN, ACCEPTED LIMITS (documented, not hidden):
//           - No formula evaluation. A formula the SCRIPT writes reads back with
//             an empty display; grading pins the formula TEXT instead (`match`).
//             A formula the SNAPSHOT supplied keeps the value the workbook
//             already computed. Neither is derived here — see grid.ts.
//           - Nothing recalculates. A write that a real dependent would react to
//             leaves that dependent holding its snapshot value, exactly as the
//             Rust dry-run path does.
//           - Sorting does not shift relative refs in moved formulas (the
//             backend does).
//           - FORMATS are unobservable in a diff: a preview reports input
//             strings, so a formatting sub-goal is visible only as call
//             presence, never as effect.
//           - cap.fetch answers the stubbed body for ANY url/method.

import {
  PreviewGrid,
  cellShape,
  cellsInRange,
  compareCellInputs,
  inputFromWrite,
  replaceCaseInsensitive,
  shapeOf,
  type CellShape,
  type PreviewCell,
} from "./grid";

/** A member the real surface has but this backend does not serve. */
export class PreviewGapError extends Error {
  constructor(public readonly member: string) {
    super(`the preview backend does not implement ${member}`);
    this.name = "PreviewGapError";
  }
}

/** Canned answers for the capability calls a preview must never really make. */
export interface PreviewStubs {
  /** What `caps.fetch(...)` responds with, as the parsed JSON body. */
  fetchJson?: unknown;
  /** What `caps.dialog.confirm(...)` answers. */
  confirm?: boolean;
  /** What `caps.dialog.prompt(...)` answers (`null` = user cancelled). */
  promptText?: string | null;
  /**
   * Inject ONE write failure: the first `setCellValue` targeting this cell
   * throws a host error. This is how a task about error HANDLING gets an error
   * to handle — without it the "tell the user if something goes wrong" branch
   * is unexercisable and an unconditional success-notify would grade 1.0.
   */
  failWrite?: { row: number; col: number };
}

export interface PreviewBackendState {
  grid: PreviewGrid;
  output: string[];
  stubs: PreviewStubs;
  /** Names the script registered with `context.expose(...)`, live. */
  exposedNames: () => string[];
  sheetNames: string[];
  /** Which sheet the preview grid stands for. */
  activeSheet: number;
  nextJobId: number;
  /** stubs.failWrite fires ONCE; this remembers whether it already has. */
  failWriteSpent: boolean;
  /**
   * Set once `api.addSheet` succeeds. In the product a new sheet becomes
   * ACTIVE, so every later unqualified grid call lands THERE — a state this
   * one-grid backend cannot model. Serving those calls against the preview
   * grid would silently answer the wrong question, so they gap instead.
   */
  activeSheetMoved: boolean;
  /**
   * The FIRST member this run asked for and could not get. Recorded here rather
   * than thrown to the caller, because the throw also has to reach the script
   * as an ordinary host error (that is what the product would do for a failing
   * call) while the RUN as a whole has to be marked inapplicable.
   */
  gap?: string;
  /** Per-run storage, so `cap.storageSet` never touches the workbook's. */
  storage: Map<string, string>;
}

/** Build the state a backend closure operates over. */
export function createPreviewState(opts: {
  grid: PreviewGrid;
  sheetNames?: string[];
  activeSheet?: number;
  stubs?: PreviewStubs;
}): PreviewBackendState {
  return {
    grid: opts.grid,
    output: [],
    stubs: opts.stubs ?? {},
    exposedNames: () => [],
    sheetNames: opts.sheetNames?.length ? [...opts.sheetNames] : ["Sheet1"],
    activeSheet: opts.activeSheet ?? 0,
    nextJobId: 1,
    failWriteSpent: false,
    activeSheetMoved: false,
    storage: new Map(),
  };
}

/**
 * The call signature every preview backend satisfies. Throws `PreviewGapError`
 * for a real member it cannot serve; throws an ordinary Error for a failure the
 * PRODUCT would also have produced.
 */
export type PreviewBackend = (method: string, args: unknown[]) => unknown;

/**
 * Bind a state to the backend function, recording the first gap as it goes.
 *
 * The gap is recorded here — at the only place that can tell a gap from an
 * ordinary failure — and the error is then rethrown so the SCRIPT sees the same
 * rejected call the product would give it for a failing host call. A backend
 * that swallowed the throw would let a script's `catch` branch run against a
 * fiction; one that only threw would lose the "this run proves nothing" fact.
 */
export function createPreviewBackend(state: PreviewBackendState): PreviewBackend {
  return (method, args) => {
    try {
      return respond(state, method, args);
    } catch (e) {
      if (e instanceof PreviewGapError) state.gap ??= e.member;
      throw e;
    }
  };
}

/**
 * Gap on any explicit sheet argument that names anything but the preview's own
 * sheet, and on every unqualified call after `addSheet` moved the active sheet.
 * The validators accept these arguments, so silently dropping them served the
 * WRONG sheet's answer as though it were the right one.
 */
function assertPreviewSheet(state: PreviewBackendState, method: string, sheet: unknown): void {
  if (state.activeSheetMoved) {
    throw new PreviewGapError(`${method} after addSheet moved the active sheet`);
  }
  if (sheet === undefined || sheet === null) return;
  if (sheet === state.activeSheet) return;
  if (sheet === state.sheetNames[state.activeSheet]) return;
  throw new PreviewGapError(`${method} with a sheet argument (${JSON.stringify(sheet)})`);
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

/**
 * Fire the injected write failure exactly once, when the write targets the
 * stubbed cell. This is how an error-HANDLING task gets an error to handle:
 * a candidate with try/catch surfaces it, a candidate without one crashes the
 * run, and a candidate that never writes never trips it.
 */
function failWriteIfStubbed(state: PreviewBackendState, row: number, col: number): void {
  const target = state.stubs.failWrite;
  if (!target || state.failWriteSpent) return;
  if (target.row === row && target.col === col) {
    state.failWriteSpent = true;
    throw new Error("Injected write failure (preview stub): the workbook refused this write");
  }
}

/**
 * Answer one broker call. Throws `PreviewGapError` for anything real that this
 * backend does not serve. Method names are the broker's own — the same keys
 * `ALLOWLIST` uses — so a renamed method fails loudly here rather than
 * answering the wrong question.
 */
export function respond(state: PreviewBackendState, method: string, args: unknown[]): unknown {
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
      assertPreviewSheet(state, method, sheet);
      return cellShape(grid, row, col).display;
    }
    case "api.setCellValue": {
      const [row, col, value, sheet] = args as [number, number, unknown, unknown];
      assertPreviewSheet(state, method, sheet);
      failWriteIfStubbed(state, row, col);
      grid.setInput(row, col, inputFromWrite(value));
      return undefined;
    }
    case "api.setCellFormula": {
      const [row, col, formula, opts] = args as [number, number, string | null, { sheetIndex?: unknown } | undefined];
      assertPreviewSheet(state, method, opts?.sheetIndex);
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
      assertPreviewSheet(state, method, opts?.sheetIndex);
      const input = grid.input(row, col);
      return input.startsWith("=") ? input : null;
    }

    // ---- grid: ranges ----
    case "api.getRangeValues": {
      const [r1, c1, r2, c2, sheet] = args as [number, number, number, number, unknown];
      assertPreviewSheet(state, method, sheet);
      const rows: CellShape[][] = [];
      for (let r = r1; r <= r2; r++) {
        const rowCells: CellShape[] = [];
        for (let c = c1; c <= c2; c++) rowCells.push(cellShape(grid, r, c));
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
      assertPreviewSheet(state, method, sheet);
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
      assertPreviewSheet(state, method, sheet);
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
      if (opts?.searchFormulas) throw new PreviewGapError("api.findAll options.searchFormulas");
      if (opts?.range !== undefined) throw new PreviewGapError("api.findAll options.range");
      assertPreviewSheet(state, method, opts?.sheetIndex);
      const caseSensitive = opts?.caseSensitive ?? false;
      const entire = opts?.matchEntireCell ?? false;
      const norm = (s: string) => (caseSensitive ? s : s.toLowerCase());
      const q = norm(query);
      const matches = grid
        .entries()
        .filter(({ row, col, cell }) => {
          if (cell.input === "") return false;
          const text = norm(cellShape(grid, row, col).display);
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
      if (opts?.searchFormulas) throw new PreviewGapError("api.replaceAll options.searchFormulas");
      if (opts?.range !== undefined) throw new PreviewGapError("api.replaceAll options.range");
      assertPreviewSheet(state, method, opts?.sheetIndex);
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
      if (opts?.orientation === "columns") throw new PreviewGapError("api.sortRange orientation:columns");
      assertPreviewSheet(state, method, args[6]);
      const matchCase = opts?.matchCase ?? false;
      const dataStart = opts?.hasHeaders ? r1 + 1 : r1;
      const c2 = args[3] as number;
      // Materialize the data rows (cells move whole, formats included).
      const rows: Array<{ index: number; cells: Array<PreviewCell | undefined> }> = [];
      for (let r = dataStart; r <= (r2 as number); r++) {
        const rowCells: Array<PreviewCell | undefined> = [];
        for (let c = c1; c <= c2; c++) {
          const found = grid.cells.get(`${r},${c}`);
          rowCells.push(
            found
              ? { input: found.input, format: { ...found.format }, cachedDisplay: found.cachedDisplay }
              : undefined,
          );
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
      assertPreviewSheet(state, method, sheet);
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) grid.mergeFormat(r, c, fmt);
      }
      return undefined;
    }
    case "api.getCellFormat": {
      const [row, col, sheet] = args as [number, number, unknown];
      assertPreviewSheet(state, method, sheet);
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
      return state.activeSheet;
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
      // rather than silently landing on the preview grid. See the state field.
      state.activeSheetMoved = true;
      return { index: state.sheetNames.length - 1, name: sheetName };
    }
    case "api.createTable": {
      const [, , , , opts] = args as [number, number, number, number, { name?: string } | undefined];
      return { kind: "table", id: "tbl-preview-1", name: opts?.name || "Table1", sheetIndex: state.activeSheet };
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
      assertPreviewSheet(state, method, sheet);
      return cellShape(grid, row, col).display;
    }
    case "sheet.setCellValue": {
      const [row, col, value, sheet] = args as [number, number, unknown, unknown];
      assertPreviewSheet(state, method, sheet);
      failWriteIfStubbed(state, row, col);
      grid.setInput(row, col, inputFromWrite(value));
      return undefined;
    }
    case "sheet.setRangeValues": {
      const [r1, c1, values, sheet] = args as [number, number, unknown[][], unknown];
      assertPreviewSheet(state, method, sheet);
      values.forEach((rowVals, dr) =>
        rowVals.forEach((v, dc) => grid.setInput(r1 + dr, c1 + dc, inputFromWrite(v))),
      );
      return undefined;
    }

    // ---- capabilities ----
    case "cap.storageGet": {
      const [key] = args as [string];
      return state.storage.get(key) ?? null;
    }
    case "cap.storageSet": {
      const [key, value] = args as [string, string];
      state.storage.set(key, String(value));
      return undefined;
    }
    case "cap.fetch": {
      const body = stubs.fetchJson !== undefined ? JSON.stringify(stubs.fetchJson) : "{}";
      return { status: 200, headers: {}, body };
    }
    case "cap.dialogAlert":
      return undefined;
    case "cap.dialogConfirm":
      // Default false: dismissal is the canned answer unless the caller says
      // yes, matching the product where Cancel/Escape/close all resolve false.
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
      throw new PreviewGapError(method);
  }
}

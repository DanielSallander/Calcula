//! FILENAME: app/extensions/Charts/handlers/__tests__/chartKeyboardFormatBinding.test.ts
// PURPOSE: Ctrl+1 — Excel's universal "format this" — reaching the chart's
//          Format pane while a chart is selected, and the cells the rest of the
//          time. Exercised through the REAL keybinding dispatcher.
// CONTEXT: Charts cannot win this key from its own listener. The keybinding
//          registry's listener is capture-phase on `window` — the outermost
//          position in the document — and the shell installs it in
//          `initKeybindings()` long before any extension activates. It matches
//          Ctrl+1 to `core.format.cells` and calls preventDefault() +
//          stopPropagation(), so the extension's document-level door never runs.
//          Registration order settles every tie, and the built-ins are always
//          first, so ordering alone can never express "this key is mine only
//          while my subject is selected".
//
//          `registerKeybinding(binding, when)` is that missing sentence: VS
//          Code's when-clause, held in a PRIVATE map (a callable on the binding
//          object would leak through `getAllKeybindings()` into the settings UI,
//          which is the same reason the script runners live in their own map).
//          Two rules, both tested here: a guarded binding that says no is
//          skipped BEFORE `matches` is populated, so it can neither shadow the
//          binding underneath it nor swallow the keystroke; and a guarded
//          binding that says yes beats an unguarded one, because it is the more
//          specific claim.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerKeybinding,
  handleGlobalKeyDown,
  getAllKeybindings,
  isGridFocused,
} from "@api/keybindings";
import { CommandRegistry } from "@api/commands";

const CELLS_COMMAND = "core.format.cells";
const CHART_COMMAND = "chart.format.selection";

let cleanups: Array<() => void> = [];
let ranCells: number;
let ranChart: number;
/** Held by name, so a test can take the built-in's claim away deliberately. */
let unregisterBuiltIn: () => void;

/** Focus something inside the grid, so the grid-scoped binding is eligible. */
function focusGrid(): void {
  const container = document.createElement("div");
  container.setAttribute("data-focus-container", "spreadsheet");
  const surface = document.createElement("div");
  surface.setAttribute("tabindex", "0");
  container.appendChild(surface);
  document.body.appendChild(container);
  surface.focus();
}

function ctrl1(): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true, cancelable: true });
}

beforeEach(() => {
  document.body.innerHTML = "";
  cleanups = [];
  ranCells = 0;
  ranChart = 0;

  CommandRegistry.register(CELLS_COMMAND, () => { ranCells += 1; });
  CommandRegistry.register(CHART_COMMAND, () => { ranChart += 1; });
  cleanups.push(() => CommandRegistry.unregister(CELLS_COMMAND));
  cleanups.push(() => CommandRegistry.unregister(CHART_COMMAND));

  // The built-in, registered FIRST, exactly as the shell does at startup.
  unregisterBuiltIn = registerKeybinding({
    id: "test.core.formatCells",
    combo: "Ctrl+1",
    commandId: CELLS_COMMAND,
    label: "Format Cells",
    category: "Formatting",
    source: "built-in",
  });
  cleanups.push(() => unregisterBuiltIn());

  focusGrid();
});

afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** The Charts registration, as index.ts makes it. */
function registerChartBinding(chartSelected: () => boolean): void {
  cleanups.push(
    registerKeybinding(
      {
        id: "test.ext.charts.formatSelection",
        combo: "Ctrl+1",
        commandId: CHART_COMMAND,
        label: "Format Chart Selection",
        category: "Formatting",
        context: "not-editing",
        source: "extension",
        extensionId: "calcula.charts",
      },
      chartSelected,
    ),
  );
}

describe("Ctrl+1 while a chart is selected", () => {
  it("the grid really is focused, so the grid-scoped binding is eligible", () => {
    // Isolates the cause: if this were false the built-in would be skipped for
    // an unrelated reason and the test below would pass for the wrong one.
    expect(isGridFocused()).toBe(true);
  });

  it("formats the CELLS when no chart is selected", () => {
    registerChartBinding(() => false);
    expect(handleGlobalKeyDown(ctrl1())).toBe(true);
    expect(ranCells).toBe(1);
    expect(ranChart).toBe(0);
  });

  it("formats the CHART when one is selected, although it registered second", () => {
    registerChartBinding(() => true);
    expect(handleGlobalKeyDown(ctrl1())).toBe(true);
    expect(ranChart).toBe(1);
    expect(ranCells).toBe(0);
  });

  it("follows the selection as it changes, without re-registering anything", () => {
    let selected = false;
    registerChartBinding(() => selected);

    handleGlobalKeyDown(ctrl1());
    expect([ranCells, ranChart]).toEqual([1, 0]);

    selected = true;
    handleGlobalKeyDown(ctrl1());
    expect([ranCells, ranChart]).toEqual([1, 1]);

    selected = false;
    handleGlobalKeyDown(ctrl1());
    expect([ranCells, ranChart]).toEqual([2, 1]);
  });

  it("a refusing guard does not SWALLOW the keystroke", () => {
    // The gate is asked before `matches` is populated. If it were asked after,
    // the chart binding would win the tie and then decline, and Ctrl+1 would do
    // nothing at all while the user had no chart selected.
    registerChartBinding(() => false);
    const event = ctrl1();
    handleGlobalKeyDown(event);
    expect(ranCells).toBe(1);
    expect(event.defaultPrevented).toBe(true); // prevented BY THE BUILT-IN, which ran
  });

  it("a guard that THROWS is treated as 'does not apply', never as a veto", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    registerChartBinding(() => { throw new Error("boom"); });
    expect(handleGlobalKeyDown(ctrl1())).toBe(true);
    expect(ranCells).toBe(1);
    expect(ranChart).toBe(0);
    expect(err).toHaveBeenCalled();
  });

  it("with NO other binding on the combo, a refusing guard leaves the key free", () => {
    // No match at all -> the dispatcher returns false and does not
    // preventDefault, so the keystroke reaches whatever is below it.
    unregisterBuiltIn(); // nothing else claims Ctrl+1 now
    registerChartBinding(() => false);
    const event = ctrl1();
    expect(handleGlobalKeyDown(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(ranChart).toBe(0);
  });

  it("never puts the predicate on the binding object", () => {
    // A callable on a KeyBinding would leak through getAll() into the settings
    // UI and into anything that serialises a binding.
    registerChartBinding(() => true);
    const binding = getAllKeybindings().find((b) => b.id === "test.ext.charts.formatSelection")!;
    expect(binding).toBeDefined();
    for (const value of Object.values(binding)) {
      expect(typeof value).not.toBe("function");
    }
    expect(JSON.stringify(binding)).toContain("Format Chart Selection");
  });

  it("gives the key back when the extension deactivates", () => {
    const unregister = registerKeybinding(
      {
        id: "test.ext.charts.temp",
        combo: "Ctrl+1",
        commandId: CHART_COMMAND,
        label: "Format Chart Selection",
        category: "Formatting",
        source: "extension",
      },
      () => true,
    );
    handleGlobalKeyDown(ctrl1());
    expect(ranChart).toBe(1);

    unregister();
    handleGlobalKeyDown(ctrl1());
    expect(ranChart).toBe(1);
    expect(ranCells).toBe(1);

  });

  it("re-registering the same id WITHOUT a guard drops the old predicate", () => {
    // An overwrite, not an unregister — `registerKeybinding` allows it (it warns)
    // and it is how a reload or a re-activation replaces a binding in place. The
    // private map is keyed by id, so a stale predicate left behind would keep
    // vetoing a binding whose author has stopped declaring one.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(
      registerKeybinding(
        {
          id: "test.ext.charts.overwritten",
          combo: "Ctrl+1",
          commandId: CHART_COMMAND,
          label: "Format Chart Selection",
          category: "Formatting",
          source: "extension",
        },
        () => false,
      ),
    );
    handleGlobalKeyDown(ctrl1());
    expect([ranCells, ranChart]).toEqual([1, 0]);

    cleanups.push(
      registerKeybinding({
        id: "test.ext.charts.overwritten",
        combo: "Ctrl+1",
        commandId: CHART_COMMAND,
        label: "Format Chart Selection",
        category: "Formatting",
        source: "extension",
      }),
    );
    handleGlobalKeyDown(ctrl1());
    // Now unguarded, and it lost the specificity that used to beat the built-in
    // — but it must at least no longer be REFUSED by a predicate nobody set.
    expect(ranCells).toBe(2);
    expect(warn).toHaveBeenCalled();

    // Prove it directly: give the built-in's combo away and the re-registered
    // binding is the only claim left, so it must now run.
    unregisterBuiltIn();
    handleGlobalKeyDown(ctrl1());
    expect(ranChart).toBe(1);
  });
});

describe("app-global shortcuts still pass through", () => {
  it("Ctrl+S is unaffected by a chart's guarded binding on another key", () => {
    let saved = 0;
    CommandRegistry.register("test.core.save", () => { saved += 1; });
    cleanups.push(() => CommandRegistry.unregister("test.core.save"));
    cleanups.push(
      registerKeybinding({
        id: "test.core.save",
        combo: "Ctrl+S",
        commandId: "test.core.save",
        label: "Save",
        category: "File",
        source: "built-in",
      }),
    );
    registerChartBinding(() => true);

    const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true });
    expect(handleGlobalKeyDown(event)).toBe(true);
    expect(saved).toBe(1);
  });
});

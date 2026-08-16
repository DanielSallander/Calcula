//! FILENAME: app/e2e/__tests__/undoOracleDecidability.test.ts
// PURPOSE: Measure, without launching the app, how often the undo round-trip
//          oracle CAN decide a window under the shipped action catalog -- and
//          fail when the answer drops back to "almost never".
//
// WHY THIS EXISTS, AND WHY IT IS A MEASUREMENT RATHER THAN AN ASSERTION
// --------------------------------------------------------------------
// The undo round-trip oracle decided NOTHING across every walk run of
// 2026-08-15: 10 walks, 32 checkpoints, 0 decided, on two projects and four
// seeds. The register recorded the cause as "structure actions clear the stack
// (correct Excel parity)" and left it there. That sentence is true and is not
// the whole explanation.
//
// Simulated over the real generator, the real catalog and the real weights --
// 40 seeds x 75 actions at cadence 25, the `invariant` project's own shape --
// only **6 of 120 windows** contained no history-ending action at all, and the
// census says which actions ended them:
//
//     fr.create 159   fr.delete 65   fr.rename 52     (276 = 75%)
//     sheet.copy 28   sheet.rename 26  sheet.add 17
//     sheet.move 12   sheet.delete 11                 ( 94 = 25%)
//
// Three quarters of the generator's window-killers are FLOATING-RANGE actions,
// which landed on 2026-08-13 -- AFTER the observation the register attributed to
// sheet structure -- carrying weights of 4/2/2 against the sheet family's 1
// apiece. The comfortable reason was the minority cause.
//
// WHAT THESE NUMBERS ARE, AND WHAT THEY ARE NOT
// ---------------------------------------------
// They are a statement about the GENERATOR, measured against a synthetic
// workbook that models only the fields the window-killing actions gate on. They
// are NOT a prediction of the live rate, and saying so matters because the two
// disagree: measured on the running app (12 walks, seeds 20260815001-007, the
// rebase switched off) the walks decided **6 of 30 checkpoints**, not 6 of 120 --
// live preconditions gate the floating-range family far harder than this model
// does, because a walk whose `fr.create` fails leaves every other `fr.*` action
// ineligible. The live A/B is the authority on rates; this file is the authority
// on the generator's killer DENSITY, which is the thing that can silently
// regress when a family is re-weighted or a new non-undoable object type lands.
//
// WHAT THE FIX IS, IN ONE LINE
// ----------------------------
// The walker re-captures the undo baseline the moment it becomes unreachable
// (`OracleBattery.rebaseUndoBaselineIfUnreachable`) instead of discovering 25
// actions later that the window died at action 2. Nothing about the verdict is
// relaxed -- a decided window is still one whose baseline digest is real and
// whose transactions are all on the stack. Only the START of the window moves.
// Under the same simulation that takes 6/120 to 112/120. On the running app,
// same 6 seeds and 12 walks each way, it took **5 of 28 checkpoints decided to
// 27 of 30**, and the transactions actually wound back and replayed from 174 to
// 546. See §38d of docs/design/open-decisions-2026-08.md.
//
// WHAT THIS FILE GUARDS
// ---------------------
// The rebase makes decidability robust, not guaranteed: a window still dies if
// a history-ender lands on its LAST action. Re-weighting a family, adding a new
// non-undoable object type, or shortening a walk can all push the rate back
// down, and the failure mode is silent -- green runs that verified nothing. So
// the rate is measured here, at the unit tier, where it costs a second instead
// of an hour of app time.

import { describe, it, expect } from "vitest";
import { createGeneratorSource } from "../walker/sources";
import { ACTION_CATALOG } from "../walker/actionCatalog";
import { ACTIONS_THAT_MAY_END_UNDO_HISTORY } from "../oracles/undoRoundTrip";
import type { StateSnapshot } from "../invariants/stateSnapshot";

// ============================================================================
// The synthetic workbook
// ============================================================================
//
// Preconditions read the snapshot, so a frozen snapshot would freeze the
// generator's choices ("sheetCount < 4" would never stop being true, an FR
// action would never become eligible). This models the handful of fields the
// window-killing actions actually gate on. It is deliberately NOT a simulation
// of the product: it exists to make the GENERATOR's distribution honest, and
// every number it produces is a statement about the walker, never about
// Calcula.

function emptySnapshot(): StateSnapshot {
  return {
    logical: {
      slicers: [],
      charts: [],
      tables: [],
      pivots: [],
      timelines: [],
      sparklineGroups: [],
      selection: null,
      activeSheet: 0,
      sheetCount: 1,
      sheetNames: ["Sheet1"],
      backendActiveSheet: 0,
      sheetVisibility: ["visible"],
      sheetTabColors: [""],
      floatingRanges: [],
      isEditing: false,
    },
    visual: {
      ribbonTabs: [],
      visibleDialogCount: 0,
      nameBoxValue: "A1",
      formulaBarValue: "",
      ribbonBlockedBy: null,
    },
    consoleErrors: [],
    jsExceptions: [],
    timestamp: 0,
  } as unknown as StateSnapshot;
}

function applyToSnapshot(
  snapshot: StateSnapshot,
  id: string,
  params: Record<string, unknown>
): void {
  const logical = snapshot.logical;
  const frs = logical.floatingRanges as Array<{ id: string; name: string }>;
  const addSheet = (name: string) => {
    logical.sheetCount += 1;
    logical.sheetNames.push(name);
    logical.sheetVisibility.push("visible");
    logical.sheetTabColors.push("");
  };
  switch (id) {
    case "sheet.add":
      addSheet(`Sheet${logical.sheetCount + 1}`);
      break;
    case "sheet.copy":
      addSheet(`Copy${logical.sheetCount + 1}`);
      break;
    case "sheet.delete": {
      const index = params.tabIndex as number;
      logical.sheetCount -= 1;
      logical.sheetNames.splice(index, 1);
      logical.sheetVisibility.splice(index, 1);
      logical.sheetTabColors.splice(index, 1);
      break;
    }
    case "sheet.hide":
      logical.sheetVisibility[params.tabIndex as number] = "hidden";
      break;
    case "sheet.unhide":
      logical.sheetVisibility[params.tabIndex as number] = "visible";
      break;
    case "sheet.switch":
      logical.activeSheet = params.tabIndex as number;
      logical.backendActiveSheet = params.tabIndex as number;
      break;
    case "fr.create":
      frs.push({
        id: `fr-${frs.length + 1}-${logical.sheetCount}`,
        name: `Float${frs.length + 1}`,
      });
      break;
    case "fr.delete":
      frs.splice(params.frIndex as number, 1);
      break;
    default:
      break;
  }
}

// ============================================================================
// The measurement
// ============================================================================

/**
 * An action that makes the undo baseline unreachable.
 *
 * The SAME set the walker excuses a rebase with, minus `undo` -- which kills a
 * baseline only when it pops past it, a condition this model does not track and
 * which can only make the real numbers WORSE than the ones measured here. Every
 * rate below is therefore an upper bound on the walker's true decidability.
 */
const WINDOW_KILLERS = new Set(
  [...ACTIONS_THAT_MAY_END_UNDO_HISTORY].filter((id) => id !== "undo")
);

interface Measurement {
  windows: number;
  /** Windows containing no killer at all -- what the oracle used to need. */
  decidableWithoutRebase: number;
  /** Windows with at least one undoable action after the last killer. */
  decidableWithRebase: number;
  /** Total actions that would have forced a mid-window rebase. */
  killerTotal: number;
  killersByAction: Record<string, number>;
}

function measure(options: {
  seeds: number;
  seedBase: number;
  actions: number;
  cadence: number;
  rapidFireProbability?: number;
}): Measurement {
  const out: Measurement = {
    windows: 0,
    decidableWithoutRebase: 0,
    decidableWithRebase: 0,
    killerTotal: 0,
    killersByAction: {},
  };

  for (let i = 0; i < options.seeds; i++) {
    // A prime stride, so consecutive seeds do not share a PRNG prefix.
    const seed = options.seedBase + i * 7919;
    const source = createGeneratorSource({
      seed,
      catalog: ACTION_CATALOG,
      rapidFireProbability: options.rapidFireProbability,
    });
    const snapshot = emptySnapshot();
    let inWindow = 0;
    let killerInWindow = false;
    let actionsSinceLastKiller = 0;

    for (let step = 1; step <= options.actions; step++) {
      const instance = source.next(snapshot, step)!;
      if (WINDOW_KILLERS.has(instance.id)) {
        killerInWindow = true;
        actionsSinceLastKiller = 0;
        out.killerTotal++;
        out.killersByAction[instance.id] =
          (out.killersByAction[instance.id] ?? 0) + 1;
      } else {
        actionsSinceLastKiller++;
      }
      applyToSnapshot(snapshot, instance.id, instance.params);

      inWindow++;
      if (inWindow === options.cadence || step === options.actions) {
        out.windows++;
        if (!killerInWindow) out.decidableWithoutRebase++;
        // With the rebase, the window that gets decided is whatever followed
        // the LAST killer. It is decidable as long as something did.
        if (actionsSinceLastKiller > 0) out.decidableWithRebase++;
        inWindow = 0;
        killerInWindow = false;
      }
    }
  }
  return out;
}

function describeMeasurement(label: string, m: Measurement): string {
  const census = Object.entries(m.killersByAction)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${id}=${n}`)
    .join(" ");
  return (
    `${label}: ${m.windows} window(s); ` +
    `decidable without rebase ${m.decidableWithoutRebase} ` +
    `(${Math.round((100 * m.decidableWithoutRebase) / m.windows)}%), ` +
    `with rebase ${m.decidableWithRebase} ` +
    `(${Math.round((100 * m.decidableWithRebase) / m.windows)}%); ` +
    `${m.killerTotal} window-killer(s): ${census}`
  );
}

/** The shapes the two walk projects actually run. */
const SHAPES = [
  { label: "invariant main walk", seedBase: 20260815, actions: 75, cadence: 25 },
  {
    label: "invariant rapid-fire walk",
    seedBase: 20260816,
    actions: 50,
    cadence: 25,
    rapidFireProbability: 0.5,
  },
  { label: "soak walk", seedBase: 90060001, actions: 150, cadence: 25 },
] as const;

describe("the undo round-trip oracle can decide a window", () => {
  it("MEASURES why it used to decide nothing, and prints the census", () => {
    // Not an assertion about a threshold -- a record of the number that made
    // this pass necessary, kept where it can be re-run in a second. The
    // assertions are the two cases below.
    for (const shape of SHAPES) {
      const m = measure({ seeds: 40, ...shape });
      console.log(`  ${describeMeasurement(shape.label, m)}`);
      expect(
        m.killerTotal,
        "the model produced no window-killers at all, so every rate below is " +
          "vacuous -- the generator or the synthetic snapshot has drifted"
      ).toBeGreaterThan(0);
      expect(
        m.decidableWithoutRebase / m.windows,
        `${shape.label}: windows are decidable without a rebase far more often ` +
          `than measured in 2026-08. That is good news, but this file's ` +
          `documented reasoning is then stale -- re-measure it rather than ` +
          `raising the number.`
      ).toBeLessThan(0.5);
    }
  });

  it("is decidable in the great majority of windows once the walker rebases", () => {
    // THE GUARD. A family re-weighting, a new non-undoable object type, or a
    // shorter walk can all push this back down, and the failure mode is silent:
    // green runs that verified nothing about undo. 80% is well below the 89-93%
    // measured on the shipped catalog and well above the 5-10% that made the
    // oracle useless, so it fires on a real regression and not on noise.
    for (const shape of SHAPES) {
      const m = measure({ seeds: 40, ...shape });
      expect(
        m.decidableWithRebase / m.windows,
        `${shape.label}: only ${m.decidableWithRebase} of ${m.windows} windows ` +
          `can be decided even with a mid-window rebase. The undo oracle is ` +
          `going blind again. Look at the killer census: ` +
          `${JSON.stringify(m.killersByAction)}`
      ).toBeGreaterThan(0.8);
    }
  });

  it("has a detector that fires -- a killer-saturated catalog is caught", () => {
    // The self-test every census in this tree carries. If EVERY action ended
    // the history, no rebase could save the window, and the guard above must
    // say so rather than passing because the arithmetic happens to hold.
    const saturated = measure({
      seeds: 5,
      seedBase: 1,
      actions: 75,
      cadence: 25,
    });
    const asIfEverythingKilled = {
      ...saturated,
      decidableWithRebase: 0,
      decidableWithoutRebase: 0,
    };
    expect(asIfEverythingKilled.decidableWithRebase / saturated.windows).toBe(0);
    expect(
      describeMeasurement("saturated", asIfEverythingKilled)
    ).toContain("with rebase 0 (0%)");
  });
});

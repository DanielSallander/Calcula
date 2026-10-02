//! FILENAME: app/src/api/explicitMacroRun.ts
// PURPOSE: The one-time PASS a person's door hands a macro run, so the script
//          host can tell "you ran this" from "a script ran this".
// CONTEXT: Owner decision B (2026-09-30): "An APPROVED application macro that
//          the user runs EXPLICITLY -- a button click, Developer > Macros > Run,
//          the command line -- gets the same CELL access in either runtime (the
//          module runtime, Calcula.setCellValue, already has it after
//          approval). Standing object scripts, and any run a script starts on
//          its own, stay restricted."
//
//          The object-script route runs a macro in a worker realm, and every
//          realm an application's code gets is RESTRICTED: `context.api` is null
//          there, so a recorded macro (which writes cells through
//          `context.api.setCellValue`) could not change a single cell for the
//          people the application was shared with, while the same macro written
//          for the module runtime could. The owner's rule removes that
//          difference -- for the runs a PERSON starts, and for nothing else.
//
// WHAT A PASS PROVES, AND WHAT IT DOES NOT.
//   * It proves that a person used one of the three doors, for this one macro,
//     just now. That is all.
//   * It is NOT a tier, NOT consent and NOT a capability. It asks for nothing.
//     The script host (`admitMount`, scriptHost/host.ts) decides, after every
//     gate has already said yes -- the Rust consent gate on the exact approved
//     bytes, Script Security, and the Rust gate again -- whether the run it
//     belongs to may have cell access. A pass on a run that no gate admitted
//     is worth nothing.
//
// WHY A WeakMap OF LIVE OBJECTS. A pass is recognised by IDENTITY: the object
// this module minted, looked up in a private WeakMap. Everything a script can
// produce reaches the host as a COPY -- a worker's postMessage is a structured
// clone, an event detail is data, JSON is text, a Tauri event is serialised --
// and a copy is never the object that was minted, so it is never a member. No
// realm can make a pass, forward one, or replay one it saw. The fields on the
// object are informative only; `claimExplicitMacroRun` reads the door and the
// macro id from the WeakMap's record, never from the object it was handed.
//
// WHY SINGLE USE, AND WHY TIED TO ONE MACRO. A pass is spent by the first
// claim, whether or not the run it was claimed for is then admitted -- so a
// refused run cannot be retried with it, and a crash respawn or a debug remount
// of the same run cannot use it again. It names one macro id, and the host
// grants nothing unless the ONE artifact the consent gate verified carries that
// id.
//
// WHO MAY MINT ONE. Only the code behind a door a person operates. Main-realm
// code could call `mintExplicitMacroRun` anywhere -- but main-realm code is the
// application itself (it can invoke Tauri directly), not a sandboxed script, so
// the question is not whether it CAN but whether it DOES. A census test
// (`__tests__/explicitMacroRun.test.ts`) pins the files that mint one: the
// Macros dialog, the three pointer GESTURE handlers of a button click (the
// floating button's release in Controls/index.ts, the in-cell button's click in
// Controls/Button/interceptors.ts, the button cell's click in
// CellTypes/types/button.ts) -- and, for those, that the mint sits inside the
// gesture handler and that only Core's pointer handlers reach it -- and the
// command line's typed `run` line (CommandLine/cli/appWriters.ts `runMacro`,
// ownerB follow-up F2: minted after the line resolved its macro, never in the
// gateway other callers can reach). The list is extended deliberately and
// never loosened. A button click hands its mint DOWN as a `ButtonGesturePass`
// because the macro it runs is known only once the button door has answered;
// the routes below it call that once and never mint themselves. The code that
// serves a script's `api.runMacro` (host.ts `executeRunMacro`), the macro-run
// seam and the Macro Recorder's provider forward a pass they were handed and
// never create one.
//
// WHO CLAIMS ONE. The two places a run is admitted: a worker realm (host.ts
// `admitMount`, where a claimed pass may become cell access) and the module
// runtime (workbookScripts.ts `runWorkbookScript`, which tells Rust a PERSON
// started the run -- without that, Rust refuses an application's module
// macro, because that runtime cannot run it with less than its full reach;
// follow-up F10).
//
// PURE: this module imports nothing, so any layer can hold a pass without
// pulling in the script host.

/** The doors a PERSON operates. A closed set; a script is not one of them. */
export type ExplicitMacroRunDoor = "macrosDialog" | "button" | "commandLine";

const DOORS: ReadonlySet<string> = new Set<ExplicitMacroRunDoor>([
  "macrosDialog",
  "button",
  "commandLine",
]);

/** Type-level brand only: a structural literal never type-checks as a pass. */
declare const EXPLICIT_MACRO_RUN_BRAND: unique symbol;

/**
 * An opaque, single-use pass for one explicit run of one macro. Hold it, hand
 * it on, never build one: only `mintExplicitMacroRun` makes a real one, and a
 * look-alike is refused at `claimExplicitMacroRun`.
 */
export interface ExplicitMacroRun {
  readonly door: ExplicitMacroRunDoor;
  readonly macroId: string;
  readonly [EXPLICIT_MACRO_RUN_BRAND]: true;
}

/** What a successful claim tells the host. Read from the private record. */
export interface ClaimedExplicitMacroRun {
  readonly door: ExplicitMacroRunDoor;
  readonly macroId: string;
}

interface PassRecord {
  readonly door: ExplicitMacroRunDoor;
  readonly macroId: string;
  spent: boolean;
}

/** Every pass this module minted, keyed by the object itself. */
const passes = new WeakMap<object, PassRecord>();

/**
 * Mint a pass for one run a person just started through `door`.
 *
 * Throws on a door outside the closed set or an empty macro id: a caller that
 * cannot say which door or which macro has nothing to prove.
 */
export function mintExplicitMacroRun(door: ExplicitMacroRunDoor, macroId: string): ExplicitMacroRun {
  if (typeof door !== "string" || !DOORS.has(door)) {
    throw new Error(`"${String(door)}" is not a door a person runs a macro from.`);
  }
  if (typeof macroId !== "string" || macroId.trim() === "") {
    throw new Error("An explicit macro run must name the macro it is for.");
  }
  const pass = Object.freeze({ door, macroId }) as unknown as ExplicitMacroRun;
  passes.set(pass, { door, macroId, spent: false });
  return pass;
}

/**
 * Spend a pass and say what it was minted for -- or null when `pass` is not a
 * live pass: not an object, a copy or look-alike of one, or already spent.
 *
 * The door and the macro id come from the private record, never from the
 * object handed in. Spending happens on the FIRST claim, whatever the caller
 * then decides.
 */
export function claimExplicitMacroRun(pass: unknown): ClaimedExplicitMacroRun | null {
  if (typeof pass !== "object" || pass === null) return null;
  const record = passes.get(pass);
  if (!record || record.spent) return null;
  record.spent = true;
  return { door: record.door, macroId: record.macroId };
}

/**
 * Spend a pass WITHOUT using it -- for a run that was refused before it could
 * be admitted, or that takes a route with no tiers at all. A no-op for anything
 * that is not a live pass.
 */
export function voidExplicitMacroRun(pass: unknown): void {
  if (typeof pass !== "object" || pass === null) return;
  const record = passes.get(pass);
  if (record) record.spent = true;
}

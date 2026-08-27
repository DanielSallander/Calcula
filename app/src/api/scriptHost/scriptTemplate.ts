//! FILENAME: app/src/api/scriptHost/scriptTemplate.ts
// PURPOSE: ONE definition of the shape a runnable object script has.
// CONTEXT: 2026-08-26, reported: "again I could not run it due to it lacking
//          some sort of entry point function."  Nothing in BASE_SYSTEM,
//          assistedSystemFor or scriptPrompt taught that a script needs a RUN
//          TARGET; the assisted template put the whole body inside a hook
//          handler, and `setup` is excluded from run-at-cursor because the
//          mount already ran it. So every draft mounted correctly and Run (F5)
//          had nothing to start.
//
//          ZERO IMPORTS, and it is a requirement rather than a preference: this
//          is reached from the eager `api/index.ts` barrel, and
//          ObjectScriptEditorApp deliberately lazy-loads the ~94 KB generated
//          surface (the `import("@api/scriptHost/scriptValidation")` in its
//          unobserved-caps effect). A template leaf must not pull it forward.
//
//          THE TABLE IS A PREFERENCE, NEVER AN AUTHORITY. `objectHooksFor` is
//          the live generated list and wins: a hook this table names that the
//          object no longer has degrades to the object's FIRST hook, never to
//          the direct branch. A renamed hook must never silently turn a
//          button's template into "runs at mount".

/** The name of the top-level work function every template emits. */
export const RUNNABLE_WORK_FN = "run";

/**
 * The hook a template wires by default, per object type.
 *
 * `null` means "this type has no default reaction": setup calls run() directly.
 * Every one of the 17 types in OBJECT_TYPE_CONTEXTS has an entry, and a test
 * pins that both directions.
 */
export const PREFERRED_HOOK_BY_TYPE: Readonly<Record<string, string | null>> = {
  button: "onClick",
  shape: "onClick",
  panel: "onClick",
  range: "onClick",
  slicer: "onSelectionChange",
  cell: "onEdit",
  row: "onInsert",
  column: "onInsert",
  chart: "onDataChange",
  table: "onDataChange",
  namedRange: "onChange",
  timeline: "onChange",
  pivot: "onRefresh",
  workbook: null,
  sheet: null,
  textbox: null,
  chartMark: null,
};

export function preferredHookFor(objectType: string): string | null {
  // `hasOwnProperty.call`, not `in`: an object type spelled "constructor" would
  // otherwise read an inherited function off the prototype — the same guard
  // `rankSurface` documents at scriptPrompt/index.ts:245.
  return Object.prototype.hasOwnProperty.call(PREFERRED_HOOK_BY_TYPE, objectType)
    ? PREFERRED_HOOK_BY_TYPE[objectType]
    : null;
}

export interface SkeletonRequest {
  objectType: string;
  /** The hook to wire, or null for the direct branch. */
  primaryHook: string | null;
  /** Goes inside run(), indented two spaces. */
  body?: string;
  /** Appended inside setup(), after the wiring. */
  setupExtra?: string;
}

export function buildRunnableSkeleton(req: SkeletonRequest): string {
  const body = (req.body ?? "// your code here")
    .split("\n")
    .map((l) => (l.length ? `  ${l}` : l))
    .join("\n");
  const head = [
    "// The work this script does. TOP-LEVEL and ZERO-ARGUMENT on purpose: that is",
    "// what makes it a run target, so Run (F5) in the editor can start it. `context`",
    "// is in scope for every top-level function in this file, so nothing is passed in.",
    `async function ${RUNNABLE_WORK_FN}() {`,
    body,
    "}",
    "",
    "// setup() runs once when the script is mounted and is NOT a run target -- the",
    "// mount has already called it. Keep the work in run() above.",
    "export function setup(context) {",
  ];
  const wiring = req.primaryHook
    ? [
        "  // The hook's details arrive as the callback's first argument if you need them.",
        `  context.${req.primaryHook}(async () => {`,
        `    await ${RUNNABLE_WORK_FN}();`,
        "  });",
      ]
    : [
        // Adapted (macro -> script) from MacroRecorder/lib/actionCodegen.ts:1108-1110,
        // so the generated and the hand-written forms read as one family.
        "  // Returned, not fired-and-forgotten: the mount resolves only after this",
        "  // promise settles, so \"the script finished\" is something the caller knows.",
        `  return ${RUNNABLE_WORK_FN}();`,
      ];
  const extra = req.setupExtra ? req.setupExtra.split("\n").map((l) => (l.length ? `  ${l}` : l)) : [];
  return [...head, ...wiring, ...extra, "}", ""].join("\n");
}

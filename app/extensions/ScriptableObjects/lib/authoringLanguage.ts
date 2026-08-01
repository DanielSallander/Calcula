//! FILENAME: app/extensions/ScriptableObjects/lib/authoringLanguage.ts
// PURPOSE: The rules the two object-script editors share for authoring in
//          TypeScript: which Monaco lane a script is edited on, what its model
//          is called, and the SAVE GATE that turns authored text into the one
//          artifact that gets stored.
// CONTEXT: CodeEditorDialog (in-window dialog) and ObjectScriptEditorApp
//          (stand-alone editor window) are near-identical twins. Anything that
//          decides what gets STORED has to be identical in both or the same
//          script would be persisted differently depending on which window the
//          author used — so the gate lives here, once.
//
//          THE STORAGE CONTRACT (see app/src/api/scriptTranspile.ts for the
//          full reasoning): a script's `source` is always the JavaScript that
//          runs. It is what the worker imports, what scriptSecurity.ts hashes
//          for the capability-grant binding, what the transparency panel shows,
//          and what .cala/.calp carry. TypeScript is an authoring mode, not a
//          storage format: saving compiles, and the editor then shows the
//          compiled JavaScript, so what the author sees is always what will run
//          and what a reviewer will read.

import type { MonacoTypescriptNamespace, SuppressedDiagnostic } from "../../_shared/lib/monacoScriptLanes";
import { registerScriptSurface } from "../../_shared/lib/monacoScriptLanes";
import {
  OBJECT_CONTEXTS_LIB,
  ACTIVE_CONTEXT_LIB,
  buildActiveContextLib,
  readContextTypeMap,
} from "./monacoTypings";
import { transpileScriptToJavaScript, formatScriptSyntaxErrors } from "@api/scriptTranspile";

/** Which Monaco language an object script is being edited in. */
export type ScriptAuthoringLanguage = "javascript" | "typescript";

/** The surface id both editors register under (they are the same surface). */
export const OBJECT_SCRIPT_SURFACE = "objectScripts";

/**
 * Diagnostic codes the object-script surface suppresses, with the reason.
 *
 * These are inherited from OBJECT_SCRIPT_DIAGNOSTICS in monacoTypings.ts so the
 * merged lane configuration cannot silently re-enable something that surface
 * deliberately turned off. Keep the two in step: a code here that is not there
 * (or the reverse) means an author sees different diagnostics depending on
 * which module last configured Monaco — the exact failure this whole mechanism
 * exists to prevent.
 */
export const OBJECT_SCRIPT_LANE_SUPPRESSIONS: readonly SuppressedDiagnostic[] = [
  { code: 2304, reason: "Cannot find name — host-injected globals are not in the generated .d.ts" },
  { code: 7044, reason: "Parameter implicitly has an 'any' type, but a better type may be inferred" },
];

/**
 * The Monaco model path for a script.
 *
 * The EXTENSION is load-bearing, not cosmetic: Monaco's TypeScript worker picks
 * a script kind from the file name (tsWorker.getScriptKind), and with
 * `allowJs: true` an extension-less model is parsed as JavaScript no matter
 * what language the editor claims. A `.ts` model is what makes `function
 * setup(context: SheetContext)` parse instead of erroring.
 *
 * The script id is in the path so two open scripts never share a model — and so
 * the diagnostics an author sees belong to the script in front of them.
 */
export function objectScriptModelPath(scriptId: string | null, language: ScriptAuthoringLanguage): string {
  const id = scriptId ?? "unsaved";
  return `objectScript/${id}.${language === "typescript" ? "ts" : "js"}`;
}

/**
 * Point the TypeScript lane at the open script's context type.
 *
 * The JavaScript lane is handled by `setActiveContextType` (monacoTypings.ts),
 * which publishes the same alias for JSDoc authoring. The TypeScript lane needs
 * its own copy because Monaco keeps the two language services' extra libs
 * completely separate — without this, `function setup(context:
 * ObjectScriptContext)` in TypeScript mode would resolve to nothing.
 */
export function registerTypescriptLane(
  monacoTs: MonacoTypescriptNamespace,
  objectType: string,
  objectContextsDts: string,
): void {
  registerScriptSurface(monacoTs, {
    lane: "typescript",
    surface: OBJECT_SCRIPT_SURFACE,
    libs: [
      { path: OBJECT_CONTEXTS_LIB, content: objectContextsDts },
      {
        path: ACTIVE_CONTEXT_LIB,
        content: buildActiveContextLib(objectType, readContextTypeMap(objectContextsDts)),
      },
    ],
    ignoreDiagnosticCodes: OBJECT_SCRIPT_LANE_SUPPRESSIONS,
  });
}

/** Register the JavaScript lane contribution (libs + suppressions). */
export function registerJavascriptLane(
  monacoTs: MonacoTypescriptNamespace,
  objectContextsDts: string,
): void {
  registerScriptSurface(monacoTs, {
    lane: "javascript",
    surface: OBJECT_SCRIPT_SURFACE,
    libs: [{ path: OBJECT_CONTEXTS_LIB, content: objectContextsDts }],
    ignoreDiagnosticCodes: OBJECT_SCRIPT_LANE_SUPPRESSIONS,
  });
}

/** The outcome of the save gate. */
export type ObjectScriptSaveGate =
  | {
      ok: true;
      /** The text to store, mount, hash and show. Always JavaScript. */
      javascript: string;
      /** True when the author's text was TypeScript and had to be compiled. */
      transformed: boolean;
    }
  | {
      ok: false;
      /** Multi-line detail for the editor console. */
      detail: string;
      /** One line for a toast. */
      message: string;
    };

/**
 * Everything that must be true before a script may be stored.
 *
 * 1. It COMPILES. A TypeScript source becomes JavaScript here; a source that is
 *    already JavaScript is passed through byte for byte (so re-saving an
 *    unchanged script cannot churn its source hash and lapse its capability
 *    grant).
 * 2. The resulting JavaScript is accepted by the same scratch-worker parse the
 *    runtime will do at mount (`hostValidateScript`, which wraps it as a blob
 *    ES module and never executes it). Note that check fails OPEN — it resolves
 *    `{ valid: true }` when there is no Worker realm — which is precisely why
 *    step 1 is the authoritative gate: the compiler is always there.
 *
 * If either fails, NOTHING is stored. That is a deliberate change from the old
 * behaviour, which saved the text anyway "so the user doesn't lose edits": the
 * store is what a reviewer reads, what the consent hash covers and what a .calp
 * distributes, so it must never hold text that cannot run. The author's edit is
 * not lost — it stays in the editor, with the error positioned in the console.
 */
export async function gateObjectScriptSave(
  source: string,
  scriptName: string,
  /**
   * The sandbox parse. Passed in rather than imported so the gate stays
   * unit-testable without a Worker realm — and so it is obvious at every call
   * site that the real `hostValidateScript` is what runs in the app.
   */
  validate: (javascript: string) => Promise<{ valid: boolean; error?: string }>,
): Promise<ObjectScriptSaveGate> {
  const compiled = await transpileScriptToJavaScript(source, { fileLabel: scriptName });
  if (!compiled.ok) {
    return {
      ok: false,
      detail:
        `Not saved — the script does not compile:\n${formatScriptSyntaxErrors(compiled.errors)}` +
        "\nYour edit is still in the editor.",
      message: compiled.message,
    };
  }

  const validation = await validate(compiled.javascript);
  if (!validation.valid) {
    return {
      ok: false,
      detail:
        `Not saved — the compiled JavaScript was rejected by the script sandbox:\n${validation.error ?? "unknown error"}` +
        "\nYour edit is still in the editor.",
      message: `Script not saved: ${validation.error ?? "the sandbox rejected it"}`,
    };
  }

  return { ok: true, javascript: compiled.javascript, transformed: compiled.transformed };
}

//! FILENAME: app/extensions/MacroRecorder/lib/buttonScript.ts
// PURPOSE: "Save as button script" — turn a recording into a clickable button.
// CONTEXT: This is the step that makes a recording AUTOMATION rather than a
//          transcript. Three things have to line up:
//
//            1. a button control exists at a cell,
//            2. an object script is stored for objectType "button" with the
//               instanceId that cell derives,
//            3. the script is mounted so the very next click runs it.
//
//          The instanceId is anchor-derived (`control-<sheet>-<row>-<col>`), so
//          creating the control and saving the script are two independent
//          writes that agree only because they compute the same id here.

import { ObjectScriptManager, saveObjectScript } from "@api";
import type { ExtensionContext } from "@api/contract";
import type { ObjectScriptDefinition } from "@api";

type BackendInvoke = ExtensionContext["invokeBackend"];

let invokeBackend: BackendInvoke | null = null;

/** Bound in activate() — the capability-scoped backend door for this extension. */
export function bindBackend(fn: BackendInvoke): void {
  invokeBackend = fn;
}

/** Test/teardown seam. */
export function unbindBackend(): void {
  invokeBackend = null;
}

/** The anchor-derived object-script instance id for a cell-anchored control. */
export function controlInstanceId(
  sheetIndex: number,
  row: number,
  col: number,
): string {
  return `control-${sheetIndex}-${row}-${col}`;
}

export interface SaveAsButtonOptions {
  /** Macro name — becomes the button label and the script name. */
  name: string;
  /** Generated source; must be the "buttonScript" wrapper (it defines setup()). */
  source: string;
  sheetIndex: number;
  row: number;
  col: number;
}

export interface SaveAsButtonResult {
  instanceId: string;
  scriptId: string;
  /** False when the script was stored but could not be mounted right now
   *  (it will mount on the next workbook load). */
  mounted: boolean;
}

/**
 * Create the button and bind the recorded macro to its click.
 *
 * Throws if the backend door is unbound (the extension was not activated) or if
 * either write fails — a half-made button with no script is worse than an
 * error, so the control is removed again when the script cannot be stored.
 */
export async function saveAsButtonScript(
  options: SaveAsButtonOptions,
): Promise<SaveAsButtonResult> {
  if (!invokeBackend) {
    throw new Error("MacroRecorder is not activated (no backend door bound).");
  }
  const { name, source, sheetIndex, row, col } = options;
  const instanceId = controlInstanceId(sheetIndex, row, col);
  const scriptId = `macro-${instanceId}`;

  await invokeBackend<void>("set_control_metadata", {
    sheetIndex,
    row,
    col,
    metadata: {
      controlType: "button",
      properties: { label: { valueType: "static", value: name } },
    },
  });

  const definition: ObjectScriptDefinition = {
    id: scriptId,
    name,
    objectType: "button",
    instanceId,
    source,
    // The generated body drives the grid through context.api, which is null in
    // the restricted tier — an unlocked script is the only tier that can run it.
    accessLevel: "unlocked",
    description: `Recorded macro "${name}"`,
  };

  try {
    await saveObjectScript(definition);
  } catch (e) {
    // Roll the control back so the user is not left with a dead button.
    try {
      await invokeBackend<void>("remove_control_metadata", { sheetIndex, row, col });
    } catch {
      /* best effort — the save error below is the one that matters */
    }
    throw e;
  }

  let mounted = false;
  try {
    ObjectScriptManager.registerScript(definition);
    await ObjectScriptManager.mountScript(scriptId);
    mounted = ObjectScriptManager.isScriptMounted(scriptId);
  } catch (e) {
    console.warn("[MacroRecorder] button script stored but not mounted:", e);
  }

  return { instanceId, scriptId, mounted };
}

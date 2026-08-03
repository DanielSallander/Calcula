//! FILENAME: app/extensions/MacroRecorder/lib/buttonScript.ts
// PURPOSE: "Save as button script" — turn a recording into a clickable button.
// CONTEXT: This is the step that makes a recording AUTOMATION rather than a
//          transcript. Three things have to line up:
//
//            1. a real, VISIBLE button control exists at a cell,
//            2. an object script is stored for objectType "button" with the
//               instanceId that control carries,
//            3. the script is mounted so the very next click runs it.
//
//          THE RECORDER DOES NOT BUILD THE BUTTON ITSELF. It used to: it called
//          `set_control_metadata` with `{ label }` and nothing appeared on the
//          grid, because the caption property is `text`, because a button also
//          needs geometry/fill/border/pin defaults, and because nothing renders
//          until the control is in the Controls extension's floating store. That
//          is another extension's domain, and a copied property list drifts the
//          first time it changes a default. So step 1 goes through the
//          feature-neutral @api/buttonControlService seam that Controls
//          registers into, and the instanceId comes BACK from it — the recorder
//          never re-derives the id format, which is exactly how a button and a
//          script end up bound to different keys.
//
//          WHY AN OBJECT SCRIPT AND NOT THE CONTROL'S OWN `onSelect`. A run-mode
//          click on a floating button does two things: it runs the inline
//          `onSelect` source in the isolated QuickJS module runtime, and it
//          emits `button:clicked`, which the script host forwards to a mounted
//          object script whose instanceId matches. The recorded macro targets
//          the object-script API (`api.applyFormatting`, `api.insertRows`,
//          `api.beginBatch`, …) — none of which exists in the QuickJS runtime —
//          so the object script is the mechanism that can actually replay it.
//          `onSelect` is therefore left EMPTY: setting both would run the click
//          twice.

import { ObjectScriptManager, saveObjectScript } from "@api";
import { requireButtonControlProvider } from "@api/buttonControlService";
import { getDesignMode } from "@api/designMode";
import type { ObjectScriptDefinition } from "@api";

/**
 * The sentence to append to a "button created" message when Design Mode is on.
 *
 * In design mode a click SELECTS a control instead of running it, so a user who
 * has been placing controls would click their new macro button and see nothing
 * happen — the same "it doesn't work" the button bug already cost them once.
 * Empty string when there is nothing to warn about, so callers can concatenate
 * unconditionally.
 */
export function designModeHint(): string {
  return getDesignMode()
    ? " Design Mode is on, so clicking selects the button — turn it off (Developer ▸ Design Mode) to run the macro."
    : "";
}

export interface SaveAsButtonOptions {
  /** Macro name — becomes the button label and the script name. */
  name: string;
  /**
   * Generated object-script source. Must define `setup(context)` — that is the
   * entry point Calcula calls on mount, and the recorder's single object-script
   * wrapper emits one that wires `context.onClick` when it is given a button.
   */
  source: string;
  sheetIndex: number;
  row: number;
  col: number;
}

export interface SaveAsButtonResult {
  /** The control's instance id, as the Controls extension assigned it. */
  instanceId: string;
  scriptId: string;
  /** True only when the script is RUNNING right now — i.e. the next click works. */
  mounted: boolean;
  /**
   * Why it is not running, when it is not. Non-null exactly when `mounted` is
   * false.
   *
   * This field exists because the previous version reported the same outcome
   * two different ways and both were wrong: mount failures were swallowed into
   * a `console.warn`, and the UI turned `mounted: false` into the reassuring
   * "It runs after the workbook is reloaded" — a claim nothing verified, and a
   * false one whenever the cause was a declined Script Security prompt (which a
   * reload will decline again).
   */
  mountError: string | null;
}

/**
 * What to TELL the user about a button that was created but is not running.
 *
 * Deliberately prescriptive: every branch ends in something to do.
 */
export function describeMountFailure(anchor: string, name: string, mountError: string): string {
  return (
    `Button created at ${anchor}, but "${name}" is NOT running yet: ${mountError} ` +
    `Until that is resolved, clicking the button does nothing. ` +
    `Fix it and remount from Developer ▸ Object Scripts.`
  );
}

/**
 * Create the button and bind the recorded macro to its click.
 *
 * Throws if no button provider is registered (the Controls extension is not
 * loaded) or if either write fails — a half-made button with no script is worse
 * than an error, so the control is removed again when the script cannot be
 * stored.
 */
export async function saveAsButtonScript(
  options: SaveAsButtonOptions,
): Promise<SaveAsButtonResult> {
  const buttons = requireButtonControlProvider();
  const { name, source, sheetIndex, row, col } = options;

  const handle = await buttons.createButton({
    sheetIndex,
    row,
    col,
    label: name,
    tooltip: `Runs the recorded macro "${name}"`,
    // Intentionally no onSelect — see the header note on double-running.
  });
  const instanceId = handle.instanceId;
  const scriptId = `macro-${instanceId}`;

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
    // Roll the control back so the user is not left with a dead button. If the
    // rollback ALSO fails the user now has an orphan button on their sheet, and
    // being told only about the save error would leave them staring at a
    // control nothing explains — so both failures travel together.
    const saveMessage = e instanceof Error ? e.message : String(e);
    try {
      await buttons.removeButton({ sheetIndex, row, col });
    } catch (rollbackError) {
      const rollbackMessage =
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(
        `${saveMessage} — and the half-made button could not be removed again ` +
          `(${rollbackMessage}). Delete the control at row ${row + 1}, column ` +
          `${col + 1} by hand.`,
      );
    }
    throw e;
  }

  let mounted = false;
  let mountError: string | null = null;
  try {
    ObjectScriptManager.registerScript(definition);
    await ObjectScriptManager.mountScript(scriptId);
    mounted = ObjectScriptManager.isScriptMounted(scriptId);
    if (!mounted) {
      mountError =
        "the script host reported no running realm for it after the mount returned.";
    }
  } catch (e) {
    // NOT a console.warn. The caller renders this; see describeMountFailure.
    mountError = e instanceof Error ? e.message : String(e);
  }

  return { instanceId, scriptId, mounted, mountError };
}

export interface SaveAsInlineButtonOptions {
  /** Button label. */
  name: string;
  /** QuickJS module source — `Calcula.*` statements, not object-script `api`. */
  source: string;
  sheetIndex: number;
  row: number;
  col: number;
}

/**
 * Bind a QuickJS-runtime macro to a button via the control's OWN `onSelect`.
 *
 * The other half of the pair above. A notebook-target macro is `Calcula.*`
 * source for the isolated Rust interpreter, which is exactly what a control's
 * inline `onSelect` runs — so this needs no object script, no mount and no
 * unlocked tier. Using the object-script route for it instead would produce a
 * `setup()` that calls a function the source never declares: a button that
 * looks bound and does nothing.
 */
export async function saveAsInlineButton(
  options: SaveAsInlineButtonOptions,
): Promise<{ instanceId: string }> {
  const buttons = requireButtonControlProvider();
  const { name, source, sheetIndex, row, col } = options;

  const handle = await buttons.createButton({
    sheetIndex,
    row,
    col,
    label: name,
    tooltip: `Runs "${name}"`,
    onSelect: source,
  });
  return { instanceId: handle.instanceId };
}

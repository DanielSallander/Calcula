//! FILENAME: app/extensions/Controls/lib/controlKeys.ts
// PURPOSE: Ctrl+C / Ctrl+V / Ctrl+D / Ctrl+G for a selected floating control,
//          through the keybinding REGISTRY -- copy, paste, duplicate, group.
// CONTEXT: These four lived in a `document` capture keydown listener
//          (index.ts), and the keybinding dispatcher -- a `window` capture
//          listener, strictly earlier -- binds all four to built-ins: Copy,
//          Paste and Fill Down are grid-scoped (they match whenever the grid
//          has focus, which it does once a control has been pressed) and Go To
//          Special always matches. On a match the dispatcher calls
//          preventDefault() and stopPropagation(), so the Controls listener
//          never heard them. Not a dead key: with a shape selected on a
//          worksheet, Ctrl+D FILLED DOWN the cells hidden under the selection,
//          Ctrl+C copied cells and Ctrl+V pasted over them.
//
//          The cure is the one Delete got (index.ts
//          `ext.controls.deleteSelection`) and Charts' Delete before it: a
//          `when` predicate, which the dispatcher prefers over an unguarded
//          built-in -- so the key is Controls' exactly while a control is
//          selected AND the grid has focus (a text field, a task-pane button
//          or a claimed surface keeps its own keys; `context: "not-editing"`
//          refuses a text field and a claim). The acts themselves are the
//          ones the old listener ran, injected (lib/controlClipboard.ts).
//
//          EVERY selected control, not the first. The old listener handed Copy
//          and Duplicate `selectedIds()[0]`; once the keys reached Controls,
//          Ctrl+D with three shapes selected duplicated one and silently left
//          two (wave A review). Copy and Duplicate now take the whole list.
//
//          ON A CANVAS the canvas's door acts (W25). A canvas multi-selection
//          spans families -- a chart, a second chart, a shape -- and Copy /
//          Paste / Duplicate act on EVERY selected object as ONE undo step
//          through the object clipboard (@api/objectClipboard; the bindings
//          are CanvasSheet's lib/canvasClipboard.ts). Controls' Copy /
//          Duplicate / Paste bindings STAND ASIDE there (registered earlier,
//          they would win the tie and act on the controls alone -- the wave A
//          interim REFUSED such a selection with a toast instead), and the
//          three commands, run from the palette or a script on a canvas, hand
//          the whole selection to the same clipboard. The rule is the seam's
//          (`canvasOwnsObjectClipboard`); a worksheet keeps Controls' own act.

import { CommandRegistry } from "@api/commands";
import { registerKeybinding, isGridFocused } from "@api/keybindings";
import {
  canvasOwnsObjectClipboard,
  copySelectedObjects,
  duplicateSelectedObjects,
  pasteObjectClipboard,
  runObjectClipboardAction,
} from "@api/objectClipboard";

/** What the keys act on, injected by the extension (index.ts). */
export interface ControlClipboardKeyDeps {
  /** The selected controls, in selection order. */
  selectedIds(): readonly string[];
  /** Whether the object clipboard holds something to paste. */
  hasClipboard(): boolean;
  /** Copy EVERY one of these controls to the object clipboard. */
  copy(controlIds: readonly string[]): Promise<void>;
  /** Paste the object clipboard (on the active sheet). */
  paste(): Promise<void>;
  /** Duplicate EVERY one of these controls (offset copies, one undo step). */
  duplicate(controlIds: readonly string[]): Promise<void>;
  /** Group these controls. */
  group(controlIds: string[]): void;
}

export const CONTROLS_COPY_COMMAND = "ext.controls.copySelection";
export const CONTROLS_PASTE_COMMAND = "ext.controls.pasteSelection";
export const CONTROLS_DUPLICATE_COMMAND = "ext.controls.duplicateSelection";
export const CONTROLS_GROUP_COMMAND = "ext.controls.groupSelection";

/** Whether the browser holds a real text selection (the dispatcher defers copy to it). */
function hasDomTextSelection(): boolean {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  return !!sel && sel.rangeCount > 0 && !sel.isCollapsed && sel.toString().trim() !== "";
}

/** Register the four commands and their guarded bindings; returns the cleanup. */
export function installControlClipboardKeys(extensionId: string, deps: ControlClipboardKeyDeps): () => void {
  const cleanups: Array<() => void> = [];
  const report = (what: string) => (err: unknown) => {
    console.error(`[Controls] ${what} failed:`, err);
  };

  // Each command re-checks its subject at run time: the palette or a script
  // may execute it with nothing selected. On a CANVAS the whole selection --
  // every family's objects -- goes through the object clipboard (see above).
  //
  // On a worksheet Copy and Duplicate run on the object clipboard's QUEUE
  // (`runObjectClipboardAction`) and read the selection only when their turn
  // comes: a second Ctrl+D pressed while the first is still landing then
  // duplicates the first's copies as its own undo step, instead of joining
  // the first's open transaction and stacking a second copy exactly on each
  // first one (wave C review). Paste queues itself (`pasteObjectClipboard`).
  CommandRegistry.register(CONTROLS_COPY_COMMAND, () => {
    if (canvasOwnsObjectClipboard()) {
      void copySelectedObjects().catch(report("Copy"));
      return;
    }
    if (deps.selectedIds().length === 0) return;
    void runObjectClipboardAction(
      async () => {
        const ids = [...deps.selectedIds()];
        if (ids.length > 0) await deps.copy(ids);
      },
      { copies: true },
    ).catch(report("Copy"));
  });
  CommandRegistry.register(CONTROLS_PASTE_COMMAND, () => {
    if (canvasOwnsObjectClipboard()) {
      void pasteObjectClipboard().catch(report("Paste"));
      return;
    }
    if (deps.hasClipboard()) void deps.paste().catch(report("Paste"));
  });
  CommandRegistry.register(CONTROLS_DUPLICATE_COMMAND, () => {
    if (canvasOwnsObjectClipboard()) {
      void duplicateSelectedObjects().catch(report("Duplicate"));
      return;
    }
    if (deps.selectedIds().length === 0) return;
    void runObjectClipboardAction(async () => {
      const ids = [...deps.selectedIds()];
      if (ids.length > 0) await deps.duplicate(ids);
    }).catch(report("Duplicate"));
  });
  CommandRegistry.register(CONTROLS_GROUP_COMMAND, () => {
    const ids = [...deps.selectedIds()];
    if (ids.length >= 2) deps.group(ids);
  });
  for (const id of [CONTROLS_COPY_COMMAND, CONTROLS_PASTE_COMMAND, CONTROLS_DUPLICATE_COMMAND, CONTROLS_GROUP_COMMAND]) {
    cleanups.push(() => CommandRegistry.unregister(id));
  }

  const selectedAndFocused = (): boolean => deps.selectedIds().length > 0 && isGridFocused();
  // Copy / Paste / Duplicate stand aside on a canvas: the canvas's own door
  // (registered after Controls, so it would LOSE a tie) acts on the whole
  // selection there.
  const worksheetKey = (): boolean => selectedAndFocused() && !canvasOwnsObjectClipboard();
  const bind = (id: string, combo: string, commandId: string, label: string, when: () => boolean): void => {
    cleanups.push(
      registerKeybinding(
        {
          id,
          combo,
          commandId,
          label,
          category: "Editing",
          context: "not-editing",
          source: "extension",
          extensionId,
        },
        when,
      ),
    );
  };
  // Copy yields to a real DOM text selection, as the grid's own Copy does.
  bind("ext.controls.copySelection", "Ctrl+C", CONTROLS_COPY_COMMAND, "Copy Selected Control", () =>
    worksheetKey() && !hasDomTextSelection(),
  );
  bind("ext.controls.pasteSelection", "Ctrl+V", CONTROLS_PASTE_COMMAND, "Paste Control", () =>
    worksheetKey() && deps.hasClipboard(),
  );
  bind("ext.controls.duplicateSelection", "Ctrl+D", CONTROLS_DUPLICATE_COMMAND, "Duplicate Selected Control", worksheetKey);
  bind("ext.controls.groupSelection", "Ctrl+G", CONTROLS_GROUP_COMMAND, "Group Selected Controls", () =>
    deps.selectedIds().length >= 2 && isGridFocused(),
  );

  return () => {
    while (cleanups.length > 0) cleanups.pop()!();
  };
}

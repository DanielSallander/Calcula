//! FILENAME: app/src/api/version.ts
// PURPOSE: API version constant for extension compatibility checking.
// CONTEXT: Extensions declare which API version they target via manifest.apiVersion.
//          The ExtensionManager checks compatibility before activation.

/**
 * Current API version.
 * Uses semantic versioning (major.minor.patch):
 * - Major: Breaking changes to extension APIs
 * - Minor: New APIs added (backward compatible)
 * - Patch: Bug fixes to existing APIs
 *
 * An extension that USES an addition declares the version that added it
 * (`apiVersion: "^1.2.0"`), so a host without it refuses to load the extension
 * instead of handing it an `undefined` it never checks. Bump the minor version
 * whenever @api gains a member, and list it in API_CHANGELOG below
 * (src/api/__tests__/apiVersion.test.ts checks that every listed name exists).
 */
export const API_VERSION = "1.2.0";

/** One @api addition: a runtime export of `module` (a member of it when the
 *  name is dotted), or a TYPE-only member declared in `declaredIn`. */
export interface ApiAddition {
  name: string;
  /** The module that exports it at runtime ("@api", "@api/objectClipboard", ...). */
  module?: string;
  /** For a type-only member: the file that declares it (app-relative)... */
  declaredIn?: string;
  /** ...and a pattern its declaration matches there. */
  pattern?: string;
}

/** What one minor version added (and changed), newest first. */
export interface ApiChangelogEntry {
  version: string;
  added: readonly ApiAddition[];
  /** Existing members whose MEANING changed, compatibly. */
  changed: readonly string[];
}

/**
 * What each minor version added, newest first. 1.1.0 (context.keybindings,
 * context.settings, context.cellEditors, ...) is described in
 * docs/EXTENSION_GUIDE.md, "New in API v1.1.0".
 */
export const API_CHANGELOG: readonly ApiChangelogEntry[] = [
  {
    version: "1.2.0",
    added: [
      // Taking back what an extension added (every deactivate must).
      { name: "unregisterMenu", module: "@api" },
      {
        name: "IMenuAPI.unregister",
        declaredIn: "src/api/contract.ts",
        pattern: "unregister\\(menuId: string, options\\?: \\{ keepWhileShared\\?: boolean \\}\\): void;",
      },
      { name: "ExtensionRegistry.unregisterCommand", module: "@api" },
      // Selection owners: an object that holds the selection (a floating grid's cell).
      { name: "onSelectionOwnershipChanged", module: "@api/selectionOwner" },
      { name: "notifySelectionOwnershipChanged", module: "@api/selectionOwner" },
      {
        name: "SelectionOwner.receivesTyping",
        declaredIn: "src/core/lib/selectionOwner.ts",
        pattern: "receivesTyping\\?: \\(\\) => boolean;",
      },
      // ...and a GENERIC claim that stands behind every specific one (BUG-0270).
      {
        name: "SelectionOwner.fallback",
        declaredIn: "src/core/lib/selectionOwner.ts",
        pattern: "fallback\\?: boolean;",
      },
      // ...which says each refusal ONCE while the same object stays selected (BUG-0270 review).
      {
        name: "SelectionOwner.shouldAnnounce",
        declaredIn: "src/core/lib/selectionOwner.ts",
        pattern: "shouldAnnounce\\?: \\(sentence: string\\) => boolean;",
      },
      // ...and may let one KIND of door through: Insert Shape / Button / Image while an object is selected (owner call 25).
      {
        name: "SelectionOwner.admits",
        declaredIn: "src/core/lib/selectionOwner.ts",
        pattern: "admits\\?: readonly SelectionDoorKind\\[\\];",
      },
      {
        name: "SelectionDoorKind",
        declaredIn: "src/core/lib/selectionOwner.ts",
        pattern: 'export type SelectionDoorKind = "objectInsert";',
      },
      // A user shortcut on a BARE printable key is refused, with this sentence (owner call 23).
      { name: "bareKeyShortcutRefusal", module: "@api/keybindings" },
      // The object clipboard: Copy / Paste / Duplicate of floating objects across families.
      { name: "copySelectedObjects", module: "@api/objectClipboard" },
      { name: "copyObjectsToClipboard", module: "@api/objectClipboard" },
      { name: "pasteObjectClipboard", module: "@api/objectClipboard" },
      { name: "duplicateSelectedObjects", module: "@api/objectClipboard" },
      { name: "putOnObjectClipboard", module: "@api/objectClipboard" },
      { name: "hasObjectClipboard", module: "@api/objectClipboard" },
      { name: "canvasOwnsObjectClipboard", module: "@api/objectClipboard" },
      // ...and the ONE rule every Copy / Paste door asks (wave E).
      { name: "clipboardDoorCommand", module: "@api/objectClipboard" },
      { name: "objectClipboardHasClipboardKeys", module: "@api/objectClipboard" },
      { name: "OBJECT_COPY_COMMAND", module: "@api/objectClipboard" },
      { name: "OBJECT_PASTE_COMMAND", module: "@api/objectClipboard" },
      // Undo-transaction tickets: close ONLY what your own begin opened.
      { name: "readUndoBeginAnswer", module: "@api/undoTicket" },
      { name: "ownUndoTransaction", module: "@api/undoTicket" },
      // Run a command from whichever registry holds it (not a script door).
      { name: "executeCommandAnywhere", module: "@api/commandDispatch" },
      { name: "buildCommandContext", module: "@api/commandDispatch" },
      // Release claims: a cell click acts on RELEASE over the same target, sliding off cancels (BUG-0258 phase 4).
      { name: "actOnRelease", module: "@api/cellClickInterceptors" },
      { name: "actOnCellRelease", module: "@api/cellClickInterceptors" },
      { name: "isCellReleaseClaim", module: "@api/cellClickInterceptors" },
      { name: "isCellPressed", module: "@api/cellClickInterceptors" },
      {
        name: "CellReleaseClaim",
        declaredIn: "src/core/lib/cellClickInterceptors.ts",
        pattern: "export interface CellReleaseClaim \\{",
      },
    ],
    changed: [
      "unregisterMenuItem / IMenuAPI.unregisterItem remove an item at ANY depth, and a parent left empty goes with its last child",
      "ExtensionRegistry.unregisterCommand takes the registered OBJECT, never another extension's command of the same id",
      "beginUndoTransaction resolves a ticket when it OPENED the transaction and null when it joined one; " +
        "commitUndoTransaction / cancelUndoTransaction accept that ticket and then close only that transaction",
      "ObjectSelectionKey gains \"Delete\" (bare Delete / Backspace): a provider answers ownsKey(\"Delete\") true while its OWN " +
        "door or an inner keyboard takes those keys, and the generic Delete of a selected object stands down (BUG-0270); " +
        "deleteSelectedObjects refuses on a read-only (subscribed) page",
      "shouldActOnWholeObjectSelection answers on a WORKSHEET too (a selection spanning families is deleted whole): a plain " +
        "press on a worksheet object now deselects every other family (Core calls noteWorksheetObjectPress), so such a " +
        "selection is a deliberate Ctrl/Shift one (BUG-0270 review)",
      "A cell click interceptor (registerClickInterceptor, CellTypeDefinition.onClick) may answer a press with a RELEASE " +
        "CLAIM instead of true/false: it then acts only when the press is released over the same target, and sliding off " +
        "cancels; the built-in buttons, checkbox cells and a worksheet pivot's +/-, filter buttons and loading Cancel now act on release " +
        "(BUG-0258 design phase 4)",
      "refuseIfSelectionOwned / selectionRefusalFor / getSelectionOwner take an optional door KIND (SelectionDoorKind): an owner " +
        "that admits it (SelectionOwner.admits) is skipped, every other owner still answers; the generic \"an object is " +
        "selected\" claim admits \"objectInsert\", so Insert Shape / Button / Image work while an object is selected (owner call 25)",
      "setUserKeybinding and addCustomKeybinding THROW, storing nothing, for a bare Space, Enter or printable character " +
        "(no Ctrl, Alt, Shift or Meta): the sentence is bareKeyShortcutRefusal's (owner call 23); such a binding STORED " +
        "before the rule is dropped when initKeybindings loads the bindings, said on the console",
    ],
  },
];

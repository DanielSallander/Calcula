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
    ],
    changed: [
      "unregisterMenuItem / IMenuAPI.unregisterItem remove an item at ANY depth, and a parent left empty goes with its last child",
      "ExtensionRegistry.unregisterCommand takes the registered OBJECT, never another extension's command of the same id",
      "beginUndoTransaction resolves a ticket when it OPENED the transaction and null when it joined one; " +
        "commitUndoTransaction / cancelUndoTransaction accept that ticket and then close only that transaction",
    ],
  },
];

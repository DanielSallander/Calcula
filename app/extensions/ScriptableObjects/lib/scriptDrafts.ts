//! FILENAME: app/extensions/ScriptableObjects/lib/scriptDrafts.ts
// PURPOSE: The review queue for AI-authored object scripts — the frontend half
//          of the MCP `draft_object_script` tool.
// CONTEXT: `app/src-tauri/src/mcp/drafts.rs` emits `mcp:script-draft` and tells
//          the calling agent the draft "is queued for the user to review in the
//          Object Script Editor". Until this module existed, NOTHING in the
//          frontend listened for that event and no surface listed drafts: the
//          agent — and therefore the user — was told something false. That is
//          the same failure shape as the macro recorder that "shipped" as
//          plumbing with no caller, so the wiring lives here, with a test.
//
//          WHAT THIS MODULE MUST NEVER DO
//          ------------------------------
//          A draft is code an AI wrote. Arriving must not make it run. This
//          module therefore does not import ObjectScriptManager, does not call
//          `saveObjectScript`, and does not touch the mount path. It notifies,
//          and it hands the draft to the editor window as DATA. Promotion to a
//          real script is a human pressing Save in the editor, which goes
//          through the ordinary compile gate + `save_object_script` + register/
//          mount path — exactly what a hand-typed script goes through.

import { listenTauriEvent } from "@api/backend";
import type { UnlistenFn } from "@api/backend";
import { showToast } from "@api";
import type { ObjectScriptDefinition, ScriptableObjectType } from "@api/scriptableObjects";
import type { ScriptDraft } from "./crossWindowEvents";
import { openObjectScriptEditorWithDraft } from "./openObjectScriptWindow";

// ============================================================================
// Wire contract
// ============================================================================

/** The Tauri event `mcp/drafts.rs::draft_object_script` emits. */
export const MCP_SCRIPT_DRAFT_EVENT = "mcp:script-draft";

/**
 * The object types a draft may target. Mirrors `VALID_OBJECT_TYPES` in
 * `mcp/drafts.rs`, which is itself the set `string_to_object_type` accepts —
 * so a draft that reaches the editor is one the editor can actually save.
 */
const DRAFTABLE_OBJECT_TYPES: readonly ScriptableObjectType[] = [
  "workbook",
  "sheet",
  "cell",
  "row",
  "column",
  "slicer",
  "chart",
  "pivot",
  "button",
  "textbox",
  "timeline",
  "shape",
  "table",
  "namedRange",
  "panel",
  "range",
];

/**
 * Validate an inbound `mcp:script-draft` payload.
 *
 * A malformed payload must open NOTHING: an editor showing `undefined` source
 * under an "AI draft" banner is worse than no editor at all, and the event is
 * the only thing on this path that did not come from Calcula's own UI.
 */
export function isScriptDraft(value: unknown): value is ScriptDraft {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  if (typeof d.id !== "string" || d.id.length === 0) return false;
  if (typeof d.name !== "string" || d.name.length === 0) return false;
  if (typeof d.source !== "string" || d.source.length === 0) return false;
  if (typeof d.objectType !== "string") return false;
  if (!DRAFTABLE_OBJECT_TYPES.includes(d.objectType as ScriptableObjectType)) return false;
  if (d.instanceId !== null && typeof d.instanceId !== "string") return false;
  if (d.description !== null && typeof d.description !== "string") return false;
  if (!Array.isArray(d.declaredCapabilities)) return false;
  if (d.declaredCapabilities.some((c) => typeof c !== "string")) return false;
  // The backend states this invariant on the wire; a payload claiming a draft
  // is already mounted is not a draft, and this side refuses to render it as
  // one rather than repeat the claim.
  if (d.mounted !== false) return false;
  return true;
}

/**
 * Turn a draft into the script definition the editor edits.
 *
 * The id is FRESH: a draft id is not an object-script id, and reusing it would
 * let an AI choose the identity that a capability grant and a source hash are
 * keyed to. `accessLevel` is always "restricted" — an AI-authored script must
 * never arrive pre-escalated to the unlocked tier; raising it is a separate,
 * deliberate human action in the editor.
 */
export function draftToScriptDefinition(draft: ScriptDraft): ObjectScriptDefinition {
  return {
    id: crypto.randomUUID(),
    name: draft.name,
    objectType: draft.objectType as ScriptableObjectType,
    instanceId: draft.instanceId,
    source: draft.source,
    accessLevel: "restricted",
    ...(draft.description ? { description: draft.description } : {}),
  };
}

/** The toast the user sees the moment an AI drafts a script. */
export function draftArrivalMessage(draft: ScriptDraft): string {
  return (
    `An AI tool drafted the object script "${draft.name}" for review. ` +
    `It is not saved and has not run — opening it in the Object Script Editor.`
  );
}

// ============================================================================
// Installation
// ============================================================================

/**
 * Subscribe to `mcp:script-draft` for the lifetime of the extension.
 *
 * Returns a synchronous teardown suitable for `cleanupFunctions`, which also
 * covers the window where the listener is still being registered.
 */
export function installScriptDraftReview(): () => void {
  let unlisten: UnlistenFn | null = null;
  let disposed = false;

  void listenTauriEvent<unknown>(MCP_SCRIPT_DRAFT_EVENT, (payload) => {
    if (disposed) return;
    if (!isScriptDraft(payload)) {
      console.warn("[ScriptableObjects] Ignored a malformed mcp:script-draft payload:", payload);
      return;
    }
    showToast(draftArrivalMessage(payload), { type: "info" });
    void openObjectScriptEditorWithDraft(payload).catch((e) => {
      console.warn("[ScriptableObjects] Failed to open the script draft for review:", e);
    });
  })
    .then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    })
    .catch((e) => {
      console.warn("[ScriptableObjects] Failed to subscribe to script drafts:", e);
    });

  return () => {
    disposed = true;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}

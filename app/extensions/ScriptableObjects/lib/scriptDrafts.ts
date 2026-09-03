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
  "form",
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
  const objectType = draft.objectType as ScriptableObjectType;
  return {
    id: crypto.randomUUID(),
    name: draft.name,
    objectType,
    // A form's instanceId is its own minted identity (there is no backing
    // workbook object an AI could name), so a drafted form is minted HERE, the
    // same rule as its `id`: the AI never chooses the identity a grant is keyed to.
    instanceId: objectType === "form" ? crypto.randomUUID() : draft.instanceId,
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
// The session's drafts, remembered so they can be RE-opened
// ============================================================================

/**
 * Drafts seen this session, newest last.
 *
 * WHY A SECOND COPY. The authoritative queue is the Rust process-global in
 * `mcp/drafts.rs`, and it is reachable — but only through `get_script_draft`,
 * which is a TOOL: it runs behind `ai_chat_run_tool` / the MCP server, is gated
 * on the script-security tier, and is written to be called by a model. Wiring a
 * UI button through the model's own tool dispatcher to fetch something the
 * frontend was already handed, as data, on `mcp:script-draft`, would be a round
 * trip through the wrong layer for no gain.
 *
 * This is display state for a review affordance: it is never persisted, never
 * mounted, and never consulted by anything that runs code. `draftToScriptDefinition`
 * remains the only path from a draft to something the editor can save.
 */
const seen = new Map<string, ScriptDraft>();

/**
 * Matches `MAX_DRAFTS` in `mcp/drafts.rs`, so this map cannot outgrow the queue
 * it mirrors. A review queue is a queue, not an archive — and a "Open in editor"
 * button for a draft the backend has already evicted would be a lie either way.
 */
const MAX_REMEMBERED = 50;

/** Remember an arriving draft, evicting oldest-first past the cap. */
export function rememberDraft(draft: ScriptDraft): void {
  // Re-inserted rather than updated so the eviction order stays insertion order.
  seen.delete(draft.id);
  seen.set(draft.id, draft);
  while (seen.size > MAX_REMEMBERED) {
    const oldest = seen.keys().next();
    if (oldest.done) break;
    seen.delete(oldest.value);
  }
}

/** Every draft seen this session, oldest first. */
export function rememberedDrafts(): ScriptDraft[] {
  return [...seen.values()];
}

/** Test hook: empty the map. The session store is dropped with the window. */
export function clearRememberedDrafts(): void {
  seen.clear();
}

/**
 * Re-open a remembered draft in the Object Script Editor.
 *
 * The implementation behind `@api/scriptEditorService`'s `openDraftInEditor`.
 * THROWS on an unknown id rather than opening an empty editor: a draft can be
 * evicted by the cap, and "nothing happened" is the failure mode this whole
 * feature exists to stop repeating.
 */
export async function openRememberedDraft(draftId: string): Promise<void> {
  const draft = seen.get(draftId);
  if (!draft) {
    throw new Error(
      `Script draft "${draftId}" is no longer available. Drafts live only for the current ` +
        `session and the oldest are dropped past ${MAX_REMEMBERED}. Ask the AI to draft it again.`,
    );
  }
  await openObjectScriptEditorWithDraft(draft);
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
    // Remembered BEFORE the editor is opened, so the AI Chat's "Open in editor"
    // button works even if opening the window fails right now.
    rememberDraft(payload);
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

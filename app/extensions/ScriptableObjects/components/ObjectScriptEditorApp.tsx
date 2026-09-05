//! FILENAME: app/extensions/ScriptableObjects/components/ObjectScriptEditorApp.tsx
// PURPOSE: Root component for the standalone Object Script Editor window.
// CONTEXT: Mounted in a separate Tauri window. Communicates with the main window
//          via Tauri events for script mounting/unmounting. Calls backend directly
//          for CRUD operations.

import React, { useState, useCallback, useRef, useEffect, useSyncExternalStore } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import type { editor as monacoEditor } from "monaco-editor";
import * as monaco from "monaco-editor";
import { enforceLfLineEndings } from "../../_shared/lib/monacoLineEndings";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Monaco 0.52+ moved typescript to top-level; languages.typescript still works at runtime
const monacoTs = (monaco.languages as any).typescript;
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import objectContextsDts from "../objectContexts.d.ts?raw";

import {
  getScaffoldTemplate,
  getContextDocumentation,
  // TRUST ORIGIN, ONE DEFINITION. A module's `sourcePackage` is the only
  // authority on whether it is the user's or a publisher's, and the tier it may
  // run at is DERIVED from that — never written by this window. See
  // app/src/api/scriptHost/scriptOrigin.ts.
  accessLevelForOrigin,
  mountProvenanceForOrigin,
  originPackageName,
  scriptOriginForStoredRecord,
} from "@api";
import {
  loadAllObjectScripts,
  saveObjectScript,
  // The persisted half of "what was asked, what it answered, what I decided".
  // Beside `saveObjectScript` because that is the module that owns them, and
  // because every call below is made at the instant a human presses a button —
  // never when a result merely arrives.
  getScriptAuthoringRuns,
  appendScriptAuthoringRun,
  adoptScriptAuthoringRuns,
  clearScriptAuthoringRuns,
} from "@api/objectScriptBackend";
import type { AuthoringRun, RunDecision } from "@api/scriptHost/authoringRun";
import {
  getWorkbookScript,
  listWorkbookScriptRecords,
  onWorkbookScriptsChanged,
  parseModuleScriptRuntime,
  saveWorkbookScript,
} from "@api/workbookScripts";
import type {
  ModuleScriptRuntime,
  ScriptScope,
  WorkbookScriptRecord,
} from "@api/workbookScripts";
import {
  listTemplates,
  saveTemplate,
  createTemplateFromScript,
  stampFromTemplate,
  loadTemplate,
  deleteTemplate,
} from "../lib/templateManager";
import type { TemplateSummary } from "../lib/templateManager";
import { hostValidateScript } from "@api";
import { prefetchScriptTranspiler } from "@api/scriptTranspile";
import {
  clearBreakpoints,
  shiftBreakpoints,
  subscribeRemoteDebugState,
  setRemoteDebugTransport,
  runAtCursor,
  getDebugSession,
  stopDebugSessionAndWait,
} from "../lib/debugger";
import {
  LiveModulePersister,
  outcomeLeavesBufferUnsaved,
  outcomeWroteNewBytes,
  type LivePersistOutcome,
} from "../lib/liveModuleBuffer";
import { editorDocumentKind, liveEditPolicyFor } from "../lib/liveEditPolicy";
import {
  aiEditStateFor,
  askAiToEdit,
  cancelAiEdit,
  clearAiEdit,
  installAiEditClient,
  rejectAiEdit,
  subscribeToAiEdits,
} from "../lib/aiEditClient";
import AiEditStrip from "./AiEditStrip";
import {
  dismissFormPreviewStatus,
  formPreviewStateFor,
  installFormPreviewClient,
  reportFormPreviewFailure,
  requestFormPreview,
  subscribeToFormPreviews,
} from "../lib/formPreviewBridge";
import { ActivityDot } from "../../_shared/components/ActivityDot";
import { FormDesignerPanel } from "./formDesigner";
import AiEditDiff from "./AiEditDiff";
import ScriptHistoryPanel from "./ScriptHistoryPanel";
import {
  breakpointShift,
  DebugPanel,
  DebugToolbar,
  injectDebugStyles,
  useDebugSession,
  type DebugDecoration,
} from "./DebugPanel";
import {
  configureObjectScriptTypings,
  contextInterfaceNameFor,
  setActiveContextType,
  annotateScaffold,
} from "../lib/monacoTypings";
import {
  objectScriptModelPath,
  registerJavascriptLane,
  registerTypescriptLane,
  gateObjectScriptSave,
  type ScriptAuthoringLanguage,
} from "../lib/authoringLanguage";
import type { ObjectScriptDefinition, ScriptableObjectType, ScriptAccessLevel } from "@api/scriptableObjects";
import {
  emitSaveAndApply,
  emitRegisterScript,
  emitToggleAccess,
  emitEditorClosed,
  emitEditorReady,
  onOpenWithScript,
  onOpenWithDraft,
  onOpenWithModuleMacro,
  onConsoleOutput,
  onScriptError,
  onScriptsChanged,
} from "../lib/crossWindowEvents";
import type { ScriptDraft } from "../lib/crossWindowEvents";
import { draftToScriptDefinition } from "../lib/scriptDrafts";
import { readRequestedDocumentId } from "../lib/editorTarget";
import { promptAsync } from "@api/dialogs";

// ============================================================================
// Monaco Worker Setup
// ============================================================================

self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

loader.config({ monaco });
// Stored text is LF on every platform. Monaco defaults a model created from
// EMPTY text to the OS ending (CRLF here), and @monaco-editor/react creates the
// model before an async document arrives — see _shared/lib/monacoLineEndings.ts.
enforceLfLineEndings(monaco);

// Inject CSS
(function injectStyles() {
  const id = "objscript-editor-styles";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    .breakpoint-glyph {
      background: #E51400;
      border-radius: 50%;
      width: 10px !important;
      height: 10px !important;
      margin-left: 4px;
      margin-top: 5px;
    }
    .breakpoint-line-decoration {
      background: rgba(229, 20, 0, 0.1);
    }

    .ose-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      font-size: 11px;
      font-family: 'Segoe UI', Tahoma, sans-serif;
      border: 1px solid transparent;
      border-radius: 3px;
      background: transparent;
      color: #ccc;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .ose-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }
    .ose-btn:active { background: rgba(255,255,255,0.12); }
    .ose-btn[disabled] { opacity: 0.4; cursor: default; pointer-events: none; }
    .ose-btn.primary { background: #0078D4; color: #fff; border-color: #0078D4; }
    .ose-btn.primary:hover { background: #106EBE; border-color: #106EBE; }
    .ose-btn.primary[disabled] { background: #0078D4; opacity: 0.4; }

    .ose-select {
      padding: 4px 8px;
      font-size: 11px;
      font-family: 'Segoe UI', Tahoma, sans-serif;
      border: 1px solid #444;
      border-radius: 3px;
      background: #2D2D2D;
      color: #ccc;
      cursor: pointer;
      outline: none;
      max-width: 220px;
      transition: border-color 0.15s;
    }
    .ose-select:hover { border-color: #0078D4; }
    .ose-select:focus { border-color: #0078D4; box-shadow: 0 0 0 1px rgba(0,120,212,0.3); }

    .ose-sidebar-method {
      font-family: 'Cascadia Code', Consolas, monospace;
      font-size: 11px;
      color: #4FC1FF;
      margin-bottom: 1px;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 2px;
      transition: background 0.1s;
    }
    .ose-sidebar-method:hover { background: rgba(79,193,255,0.1); }

    .ose-splitter {
      height: 4px;
      cursor: ns-resize;
      background: #252526;
      border-top: 1px solid #333;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    .ose-splitter:hover { background: #0078D4; }

    .ose-console-line {
      margin-bottom: 1px;
      white-space: pre-wrap;
      word-break: break-all;
    }
  `;
  document.head.appendChild(style);
})();

// Register the GENERATED type definitions on both language services. The
// per-script `ObjectScriptContext` alias is published separately, whenever the
// edited script changes (see the effect in the component below) — without it
// the interfaces below are unreachable, because a script's context is a
// parameter of `setup(context)` and nothing binds it.
configureObjectScriptTypings(monacoTs, objectContextsDts);
// ...and claim the object-script share of the shared language services, so the
// merged configuration (not whichever extension was imported last) is what is
// live. Without this, another surface's fragment settings switched validation
// off here too and the generated typings produced completions but never a
// single diagnostic.
registerJavascriptLane(monacoTs, objectContextsDts);

// ============================================================================
// Console entry type
// ============================================================================

interface ConsoleEntry {
  id: number;
  level: "log" | "warn" | "error" | "info";
  message: string;
  scriptId?: string;
  timestamp: number;
}

// ============================================================================
// SVG Icons
// ============================================================================

function IconSave() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M13.353 1.146l1.5 1.5A.5.5 0 0115 3v11.5a.5.5 0 01-.5.5h-13a.5.5 0 01-.5-.5v-13A.5.5 0 011.5 1H12a.5.5 0 01.353.146zM2 2v12h12V3.207L12.793 2H11v4H4V2H2zm3 0v3h5V2H5z" />
    </svg>
  );
}

function IconTemplate() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M14 1H2a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1V2a1 1 0 00-1-1zM2 2h12v3H2V2zm0 4h5v8H2V6zm6 8V6h6v8H8z" />
    </svg>
  );
}

function IconLock() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
      <path d="M11 5V4a3 3 0 00-6 0v1H4v7h8V5h-1zM6 4a2 2 0 014 0v1H6V4z" />
    </svg>
  );
}

function IconUnlock() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
      <path d="M11 5h1v7H4V5h5V4a2 2 0 00-4 0v1H4V4a3 3 0 016 0v1z" />
    </svg>
  );
}

function IconTerminal() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1 3v10h14V3H1zm13 9H2V4h12v8zM5.146 5.146l.708.708L3.707 8l2.147 2.146-.708.708L2.293 8l2.853-2.854zM8 10h4v1H8v-1z" />
    </svg>
  );
}

function IconBook() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M14.5 2H9c-.69 0-1.25.56-1.25 1.25v9.5A1.25 1.25 0 019 14h5.5a.5.5 0 00.5-.5V2.5a.5.5 0 00-.5-.5zM14 13H9a.25.25 0 01-.25-.25v-9.5A.25.25 0 019 3h5v10zM7.25 3.25C7.25 2.56 6.69 2 6 2H1.5a.5.5 0 00-.5.5v11a.5.5 0 00.5.5H6c.69 0 1.25-.56 1.25-1.25v-9.5zM6 13H2V3h4a.25.25 0 01.25.25v9.5A.25.25 0 016 13z" />
    </svg>
  );
}

// ============================================================================
// Module scripts (recorded macros) as first-class documents
// ============================================================================

/**
 * One MODULE script open in — or merely listed by — this editor.
 *
 * A recorded macro is a module script (`save_script`), not an object script, so
 * `loadAllObjectScripts` cannot see it. The editor used to hold exactly ONE of
 * these, handed to it over the open-with-macro channel, which meant a user with
 * two macros could only ever see the one they navigated to: the second REPLACED
 * the first. Macros are enumerated from the store now, like any other inventory,
 * and this is the per-document state that enumeration produces.
 */
interface MacroDoc {
  macroId: string;
  /** Synthetic object-script shape for the editor chrome. `source` is the LIVE
   *  buffer for this document (stashed on switch-away), not the stored text. */
  script: ObjectScriptDefinition;
  /** The stored description — where the runtime marker lives. Preserved verbatim
   *  across a save so the macro keeps routing correctly. */
  description: string | null;
  /** The source as STORED, so a refresh can tell an external edit from a local one. */
  savedSource: string;
  /** Unsaved edits in this document's buffer. Per-document, so switching between
   *  two macros cannot lose either one's work. */
  dirty: boolean;
  /** Why this module could not be read, or that it has since been deleted. */
  loadError: string | null;
  /** Recorder marker: a marked module is a MACRO, an unmarked one a plain module. */
  runtime: ModuleScriptRuntime | null;
  /**
   * The application this module arrived in, or null for the user's own code.
   *
   * CARRIED, NOT RE-DERIVED AND NEVER DROPPED. `core/calp/src/pull.rs` stamps
   * `source_package` on every module a `.calp` ships, and every later decision
   * about the module — the tier a debug session mounts it at, whether this
   * window will let the buffer be edited at all, what it tells the user about
   * where the code came from — is derived from that one field.
   *
   * Read it together with `sourcePackageKnown`: `null` alone cannot say whether
   * the record is the user's or merely unread.
   */
  sourcePackage: string | null;
  /**
   * Whether `sourcePackage` is an ANSWER or an absence of one.
   *
   * `listWorkbookScriptRecords` fills in `sourcePackage: null` for a record it
   * could not read — not because the record is local, but because there was no
   * record to ask. Rendering that as "a macro you wrote" is the safe answer
   * asserted from no evidence, which is the one thing this window may never do
   * about provenance. False means: nothing about this module's origin has been
   * established since this window opened.
   */
  sourcePackageKnown: boolean;
  /**
   * The module's stored SCOPE — workbook-wide, or attached to one sheet.
   *
   * CARRIED, NEVER RE-ASSERTED. Every write from this window used to send
   * `{ type: "workbook" }` unconditionally, so an idle auto-persist of a
   * sheet-scoped module widened it to the whole workbook — invisibly, with no
   * gesture, from nothing but a pause in typing. `undefined` means the record
   * did not state one and the store's own default stands.
   */
  scope: ScriptScope | undefined;
}

/**
 * Build the editor's document for one module record.
 *
 * `lastKnown` is what THIS WINDOW already established about the module, and it
 * is consulted for one reason only: a record that failed to read states nothing
 * about its provenance, and a failed read must never be allowed to demote a
 * publisher's macro to local code on screen (or in the write below it).
 */
function macroDocFromRecord(
  record: WorkbookScriptRecord,
  lastKnown?: {
    sourcePackage: string | null;
    sourcePackageKnown: boolean;
    scope?: ScriptScope | undefined;
  },
): MacroDoc {
  const provenance =
    record.loadError === null
      ? { sourcePackage: record.sourcePackage ?? null, known: true }
      : {
          sourcePackage: lastKnown?.sourcePackage ?? null,
          known: lastKnown?.sourcePackageKnown ?? false,
        };
  const origin = scriptOriginForStoredRecord({ sourcePackage: provenance.sourcePackage });
  return {
    macroId: record.id,
    script: {
      id: record.id,
      name: record.name,
      objectType: "workbook",
      instanceId: null,
      source: record.source,
      // DERIVED FROM THE RECORD, NOT ASSERTED. This was hard-coded "unlocked",
      // which made the toolbar tell the user a publisher's macro runs at the
      // top tier while `hostStartModuleScriptDebugSession` (app/src/api/
      // scriptHost/host.ts) mounts exactly that module RESTRICTED. A window
      // that names a tier the runtime will not give it is worse than one that
      // names none: the user reads the promise and reasons from it.
      accessLevel: accessLevelForOrigin(origin, "unlocked"),
      // ...and the SAME origin, in the shape the rest of this window already
      // reads (`isReadOnly`, the status bar). `mountProvenanceForOrigin` is the
      // sanctioned inverse of the derivation above, so "distributed" is spelled
      // in exactly one place for object scripts and modules alike. Its
      // `provenance` is typed as a plain `string` because its other callers put
      // it into a mount definition; the stored-definition type spells the same
      // two values as the `ScriptProvenance` union, so the assertion narrows a
      // type, never a value.
      ...(mountProvenanceForOrigin(origin) as Pick<
        ObjectScriptDefinition,
        "provenance" | "packageName"
      >),
    },
    description: record.description,
    savedSource: record.source,
    dirty: false,
    loadError: record.loadError,
    runtime: parseModuleScriptRuntime(record.description),
    sourcePackage: originPackageName(origin),
    sourcePackageKnown: provenance.known,
    // The stored scope, verbatim. A read that failed reports none, so the last
    // known one stands rather than being replaced by the store's default.
    scope: record.loadError === null ? record.scope : lastKnown?.scope,
  };
}

/**
 * What this window has ESTABLISHED about where a module document came from.
 *
 * Three answers, and "unknown" is one of them. The tier chip used to have two —
 * a package name, or "A macro you wrote" — so a module whose record could not be
 * read (`sourcePackage: null` because nothing answered) rendered as the user's
 * own work. Unknown provenance rendered as the safe answer is how a publisher's
 * macro comes to look like yours on the one screen that exists to tell them
 * apart.
 */
type MacroProvenanceKnowledge =
  | { kind: "package"; name: string }
  | { kind: "local" }
  | { kind: "unknown" };

function macroProvenanceKnowledge(doc: {
  sourcePackage: string | null;
  sourcePackageKnown: boolean;
}): MacroProvenanceKnowledge {
  if (doc.sourcePackage !== null) return { kind: "package", name: doc.sourcePackage };
  return doc.sourcePackageKnown ? { kind: "local" } : { kind: "unknown" };
}

/**
 * WHY THIS WINDOW MUST NOT WRITE A MODULE DOCUMENT — or null when it may.
 *
 * ONE PREDICATE, CONSULTED BY EVERY DOOR. There are five ways a module's buffer
 * reaches the store from here — the idle auto-persist, the flush on switching
 * document, the flush on window close/blur, Ctrl+S, and an accepted AI edit —
 * and they all funnel through `LiveModulePersister`. This function decides, once,
 * whether the document may be TRACKED by it at all; not tracking is what disarms
 * every one of those doors together, rather than each of them separately (which
 * is how the previous rounds of this defect kept producing a new caller).
 *
 * Two refusals, and the SECOND one is the fix this round.
 *
 *   1. A module that arrived in an application. `save_script` makes the package
 *      stamp sticky, so an edit written back here would store the user's bytes
 *      under the publisher's name; the Rust consent gate matches (package, id,
 *      source) and would then recognise nothing, bricking a consented macro.
 *
 *   2. A module whose RECORD COULD NOT BE READ. The previous round taught the
 *      tier chip to say "origin unknown" for exactly this case, and stopped
 *      there: the buffer stayed editable and tracked, so the first keystroke
 *      auto-persisted the preview text over whatever is really stored under that
 *      id. UNKNOWN PROVENANCE IS NOT PERMISSION. We do not know whether that
 *      record is the user's own, or a publisher's — and writing it would either
 *      destroy the user's real macro or brick a distributed one, from a failed
 *      read plus a pause. The safe act, and the only honest one, is to write
 *      nothing until a read succeeds.
 */
export function macroWriteRefusal(doc: {
  name: string;
  sourcePackage: string | null;
  sourcePackageKnown: boolean;
}): string | null {
  if (doc.sourcePackage !== null) {
    return (
      `"${doc.name}" arrived in the application "${doc.sourcePackage}", so this window does ` +
      'not edit it. Developer ▸ Macros… ▸ "Save as my copy" makes a local macro of your ' +
      "own from it, which you can then edit here freely."
    );
  }
  if (!doc.sourcePackageKnown) {
    return (
      `"${doc.name}" could not be read from this workbook, so this window cannot say what is ` +
      "stored under that id — it may be yours, or it may have arrived in an application. " +
      "Writing this buffer back would overwrite a record nobody has read, so it is " +
      "read-only until a read succeeds. Reopen the workbook to try again, or use " +
      "Developer ▸ Macros… to save this text as a new macro of your own."
    );
  }
  return null;
}

/** The hover text on the tier chip — one sentence per state of knowledge. */
function macroTierChipTitle(knowledge: MacroProvenanceKnowledge): string {
  switch (knowledge.kind) {
    case "package":
      return (
        `This macro arrived in the application "${knowledge.name}". Run and Debug in ` +
        "this window mount it from the module store at the restricted tier — " +
        "context.api is null — and it receives capabilities only through that " +
        "application's consent record. You cannot raise it, and you cannot edit it " +
        "here."
      );
    case "local":
      return "A macro you wrote runs at the unlocked tier, where context.api is available.";
    default:
      return (
        "This module's record could not be read, so this window cannot say where it " +
        "came from — it may be yours or it may have arrived in an application. The " +
        "tier shown is what the last successful read implied, not a fact established " +
        "now."
      );
  }
}

/** The chip's own caption. Never states a tier it has not established. */
function macroTierChipLabel(
  knowledge: MacroProvenanceKnowledge,
  accessLevel: ScriptAccessLevel,
): string {
  if (knowledge.kind === "unknown") return " Macro (origin unknown)";
  return accessLevel === "restricted" ? " Macro (restricted)" : " Macro";
}

/** The dropdown prefix. A recorder-marked module is a MACRO; an unmarked one is
 *  a hand-authored module — both live in the same store and both belong here. */
function macroDocKindLabel(doc: MacroDoc): string {
  return doc.runtime ? "MACRO" : "MODULE";
}

/**
 * The list entry for one module document — the surface's existing
 * "KIND — name" idiom, with the publisher named in it.
 *
 * WHY IT IS IN THE LABEL AND NOT A BADGE. This list is an `<option>` inside a
 * `<select>`: it can hold text and nothing else. A publisher's macro that reads
 * identically to the user's own is a decision the user cannot make, and the one
 * place they make it is here, when they choose what to open.
 */
function macroDocOptionLabel(doc: MacroDoc): string {
  const origin = doc.sourcePackage === null ? "" : ` — from "${doc.sourcePackage}"`;
  return `${macroDocKindLabel(doc)} — ${doc.script.name}${origin}`;
}

/**
 * How live a module document's text is, as the author should be told.
 *
 * "Live" is the resting state and the whole point of the feature: the buffer and
 * the module store hold the same bytes, so every button that links this macro,
 * Run, and Debug all get exactly what is on screen. The other three states are
 * the honest exceptions, and each one names what the author must do.
 */
export type LiveDocState =
  | { state: "live" }
  /** Typed within the last few hundred ms, or a write is on its way. */
  | { state: "saving" }
  /** A module that arrived in an application. Nothing here writes it, ever —
   *  so "Live" would be true by accident and misleading on purpose. */
  | { state: "readOnly" }
  /** TypeScript: storing it means compiling it, which rewrites the buffer, and
   *  only an explicit gesture may do that. */
  | { state: "deferred"; message: string }
  /** The text does not compile (or the store refused it). The last good stored
   *  version is intact and is what a button would still run. */
  | { state: "error"; message: string };

/** The short label the toolbar/status bar shows for a live state. */
export function liveStateLabel(live: LiveDocState | undefined): string {
  switch (live?.state) {
    case "saving":
      return "Saving…";
    case "readOnly":
      return "Read-only";
    case "deferred":
      return "Compile to store";
    case "error":
      return "Not stored";
    default:
      return "Live";
  }
}

/**
 * Turn a persist outcome into what the author is shown.
 *
 * `bufferStillUnsaved` is the persister's own comparison of the buffer against
 * the bytes the store holds, taken at the moment the outcome lands — and it is
 * NOT redundant with the outcome. An outcome describes the pass that has just
 * finished, i.e. bytes that were current when the write STARTED; a keystroke
 * that arrives while the write is in flight leaves the buffer ahead of it. A
 * "saved" outcome is therefore not by itself evidence that the store holds what
 * is on screen, and the chip is the only thing that answers that question — so
 * while the buffer is ahead the honest answer is "Saving…", never "Live".
 * (BUG-0025: a spec waited for "Live" and read a keystroke-old module back.)
 */
export function liveStateFromOutcome(
  outcome: LivePersistOutcome,
  bufferStillUnsaved = false,
): LiveDocState {
  switch (outcome.status) {
    case "deferred":
      return { state: "deferred", message: outcome.message };
    case "invalid":
    case "failed":
      return { state: "error", message: outcome.message };
    default:
      return bufferStillUnsaved ? { state: "saving" } : { state: "live" };
  }
}

/** What a deleted-but-edited document says about itself. */
const DELETED_WITH_EDITS_NOTE =
  "This module was deleted from the workbook while you had unsaved edits. " +
  "The edits are still here — Save writes it back.";

/**
 * Fold a fresh listing into the documents already open, PRESERVING per-document
 * unsaved edits.
 *
 * The rules, in order:
 *   - a listed module with local unsaved edits keeps its buffer (the record
 *     supplies everything else);
 *   - a listed module with no local edits takes the record wholesale;
 *   - a module that has DISAPPEARED and has unsaved edits stays in the list,
 *     flagged, rather than silently taking the author's work with it;
 *   - a module that has disappeared and is clean simply goes.
 */
export function mergeMacroDocs(
  previous: MacroDoc[],
  records: WorkbookScriptRecord[],
): MacroDoc[] {
  const stale = new Map(previous.map((doc) => [doc.macroId, doc]));
  const next: MacroDoc[] = records.map((record) => {
    const existing = stale.get(record.id);
    stale.delete(record.id);
    // A listing whose per-record read FAILED reports `sourcePackage: null`
    // because it had nothing to ask, so a transient read failure must not turn
    // a publisher's macro into local code in the list, the chip or the buffer's
    // editability. What was established stands until a successful read replaces
    // it.
    const fresh = macroDocFromRecord(record, existing);
    if (!existing || !existing.dirty) return fresh;
    return {
      ...fresh,
      script: { ...fresh.script, source: existing.script.source },
      dirty: true,
    };
  });
  for (const orphan of stale.values()) {
    if (!orphan.dirty) continue;
    next.push({ ...orphan, loadError: DELETED_WITH_EDITS_NOTE });
  }
  // Macros together, in a stable, human order — the list is a menu, not a log.
  return next.sort((a, b) => a.script.name.localeCompare(b.script.name));
}

// ============================================================================
// Component
// ============================================================================

export function ObjectScriptEditorApp(): React.ReactElement {
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);

  // WHICH DOCUMENT THIS WINDOW WAS OPENED FOR.
  //
  // Read from the window's own URL on the very first render — before any
  // listener is registered, any timer fires or any backend listing lands. The
  // selection is therefore decided by IDENTITY, not by which asynchronous thing
  // happened to finish first. Without it, a slow-booting editor could have its
  // open payload delivered into a void by the main window's fallback timer, and
  // the "nothing selected yet, take the first one" fallback below would then
  // choose whatever sorted first alphabetically — the reported `-sbfault-`
  // instead of `-sb-`.
  const requestedDocIdRef = useRef<string | null>(readRequestedDocumentId());

  // Script list and current script
  const [scripts, setScripts] = useState<ObjectScriptDefinition[]>([]);
  const [activeScriptId, setActiveScriptId] = useState<string | null>(
    requestedDocIdRef.current,
  );
  /** True once BOTH initial listings have answered — the point at which
   *  "the requested document does not exist" becomes a fact rather than a race. */
  const [listingsLoaded, setListingsLoaded] = useState(false);
  const [source, setSource] = useState("");
  // The AI-authored draft under review, if any. It is NOT in `scripts`: it has
  // no backend record, is not registered and is not mounted. Saving it is what
  // turns it into one of `scripts`, through the same gate as typed code.
  const [draftDoc, setDraftDoc] = useState<
    { draft: ScriptDraft; script: ObjectScriptDefinition } | null
  >(null);
  // EVERY recorded macro / module script in the workbook. Unlike a draft these
  // are real, saved records — but in the MODULE store (`save_script`), not the
  // object-script store — so they need their own doc-kind: Save routes to
  // `saveWorkbookScript`, and debug/run mount them transiently under a synthetic
  // `workbook` definition the HOST builds from the store — at the tier the
  // record's own provenance allows (unlocked for the user's own, restricted for
  // a module that arrived in an application).
  const [macroDocs, setMacroDocs] = useState<MacroDoc[]>([]);
  const macroDocsRef = useRef<MacroDoc[]>([]);
  macroDocsRef.current = macroDocs;
  // Authoring language for the OPEN script. Stored scripts are always
  // JavaScript (that is the only thing the worker can import), so this always
  // starts at "javascript"; switching to TypeScript is an authoring decision
  // that lasts until the next save compiles the text back down.
  const [language, setLanguage] = useState<ScriptAuthoringLanguage>("javascript");
  const [isDirty, setIsDirty] = useState(false);
  // Live mirrors of the buffer, so the async listeners (a macro arriving on the
  // open channel, a background list refresh) can stash the author's current text
  // into its document instead of reading a stale closure and overwriting it.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  const activeDocIdRef = useRef<string | null>(activeScriptId);
  activeDocIdRef.current = activeScriptId;
  /** Which document the buffer currently holds. Guards the restore effect so a
   *  background refresh of the macro list can never replace text being typed. */
  const loadedDocIdRef = useRef<string | null>(null);
  /** Per-module-document live state, keyed by module id. */
  const [liveStates, setLiveStates] = useState<Record<string, LiveDocState>>({});
  /**
   * Module documents whose OPEN DEBUG SESSION is running older code than the
   * store now holds.
   *
   * A session instruments the source at mount and owns that snapshot for its
   * whole life. Persisting an edit must NOT hot-swap it — that would discard a
   * paused author's inspection mid-thought — so the session keeps running what
   * it was built from and this set is how the UI says so out loud.
   */
  const [staleSessionDocs, setStaleSessionDocs] = useState<string[]>([]);
  const staleSessionDocsRef = useRef<string[]>([]);
  staleSessionDocsRef.current = staleSessionDocs;
  const [showSidebar, setShowSidebar] = useState(true);
  const [showConsole, setShowConsole] = useState(true);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const consoleIdRef = useRef(0);

  // Console resize
  const [consoleHeight, setConsoleHeight] = useState(160);
  const consoleDragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onConsoleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    consoleDragRef.current = { startY: e.clientY, startH: consoleHeight };
    const onMove = (ev: MouseEvent) => {
      if (!consoleDragRef.current) return;
      const dy = consoleDragRef.current.startY - ev.clientY;
      setConsoleHeight(Math.max(60, Math.min(400, consoleDragRef.current.startH + dy)));
    };
    const onUp = () => {
      consoleDragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [consoleHeight]);

  // Push one line into the editor console and reveal it. Declared before the
  // loaders because they are the first thing that can need to speak.
  const reportToConsole = useCallback(
    (message: string, scriptId?: string, level: ConsoleEntry["level"] = "error") => {
      setConsoleEntries((prev) => [
        ...prev,
        {
          id: ++consoleIdRef.current,
          level,
          message,
          scriptId,
          timestamp: Date.now(),
        },
      ]);
      setShowConsole(true);
    },
    [],
  );

  // ==========================================================================
  // LIVE MODULE EDITING (the VBE model)
  // ==========================================================================
  //
  // A module script is the live code. There is no per-module save step: the
  // buffer is written through on an idle debounce and flushed by every explicit
  // gesture, so Run and Debug always execute what is on screen. `.cala` remains
  // the separate step that persists to disk — `saveWorkbookScript` marks the
  // workbook modified, so the title bar still says the file needs saving.
  //
  // WHAT DOES NOT AUTO-PERSIST, and why, is a policy table (lib/liveEditPolicy.ts)
  // rather than a comment: an object script's save is also an APPLY (it remounts
  // the realm and re-runs setup()), and an AI draft must never become real code
  // without a human pressing Save.

  /** Marks a document's open debug session as running older code than the store. */
  const markSessionStale = useCallback((docId: string) => {
    setStaleSessionDocs((prev) => (prev.includes(docId) ? prev : [...prev, docId]));
  }, []);
  const clearSessionStale = useCallback((docId: string) => {
    setStaleSessionDocs((prev) => (prev.includes(docId) ? prev.filter((id) => id !== docId) : prev));
  }, []);

  /** The last compile/write failure reported per document, so a debounce that
   *  keeps failing on the same broken line does not fill the console with it. */
  const lastLiveErrorRef = useRef<Map<string, string>>(new Map());

  /** The live-persist engine. The ref is declared HERE, above the handler that
   *  applies its outcomes, because that handler has to ask it what the buffer
   *  looks like NOW — an outcome only knows what it wrote. Constructed further
   *  down, where its options can close over the rest of this component. */
  const persisterRef = useRef<LiveModulePersister | null>(null);

  const applyLiveOutcome = useCallback(
    (docId: string, outcome: LivePersistOutcome) => {
      // THE CHIP IS SET LAST, NOT FIRST. It answers "does the store hold what I
      // am looking at", which is a question about the buffer as it is NOW — and
      // the buffer can still be adopted further down (a compile puts the stored
      // JavaScript on screen). Asking the persister before that would report the
      // moment before the swap and leave the chip a lie until the next write.
      const showChip = () => {
        const bufferStillUnsaved = persisterRef.current?.hasUnsavedEdits(docId) ?? false;
        setLiveStates((prev) => ({
          ...prev,
          [docId]: liveStateFromOutcome(outcome, bufferStillUnsaved),
        }));
      };

      if (outcome.status === "invalid" || outcome.status === "failed") {
        showChip();
        const detail = outcome.status === "invalid" ? outcome.detail : outcome.message;
        if (lastLiveErrorRef.current.get(docId) !== detail) {
          lastLiveErrorRef.current.set(docId, detail);
          reportToConsole(
            outcome.status === "invalid"
              ? `${detail}\nThe stored version is unchanged, so anything that runs this macro still runs the last version that compiled.`
              : `The module store refused the write: ${outcome.message}`,
            docId,
          );
        }
        return;
      }
      lastLiveErrorRef.current.delete(docId);
      if (!outcomeWroteNewBytes(outcome)) {
        showChip();
        return;
      }

      const stored = outcome.stored;
      const isActive = activeDocIdRef.current === docId;
      setMacroDocs((prev) =>
        prev.map((d) =>
          d.macroId === docId
            ? {
                ...d,
                // The ACTIVE document's buffer lives in `source`; every other
                // document's lives in its own `script.source`, and we just wrote
                // it, so that is now the stored text.
                script: { ...d.script, source: isActive ? d.script.source : stored },
                savedSource: stored,
                dirty: isActive ? sourceRef.current !== stored : false,
                // A successful write is also the answer to "this was deleted
                // while you had edits": it exists again.
                loadError: null,
              }
            : d,
        ),
      );
      if (isActive) setIsDirty(sourceRef.current !== stored);

      if (outcome.status === "compiled" && isActive) {
        if (sourceRef.current !== outcome.input) {
          // THE SAME STALENESS, IN ITS DESTRUCTIVE FORM. The author kept typing
          // while the compile ran, so what is on screen is no longer the text
          // that was compiled — and swapping it for `stored` would silently
          // delete those keystrokes. Rule 4 already says an author's moving text
          // is not rewritten underneath them: keep it, let the write that is
          // already armed catch up, and let the next gesture do the compile.
          // (`input` is compared, not "does the buffer differ from the store":
          // for a TypeScript module those bytes NEVER agree, which is the whole
          // reason this branch exists.)
          reportToConsole(
            "TypeScript compiled to JavaScript, but you have typed since — your text is " +
              "kept and is not yet stored. Press Ctrl+S (or Run) to compile and store it.",
            docId,
            "info",
          );
        } else {
          // The stored bytes are not the buffer bytes, so show what was stored:
          // the author must never be looking at text other than the text that
          // runs, is hashed for consent and is read by a reviewer. The persister
          // is TOLD about the swap — it is the mirror of what is on screen, and
          // a programmatic setSource never reaches it through the change handler.
          setSource(stored);
          setLanguage("javascript");
          persisterRef.current?.adopt(docId, stored);
          reportToConsole(
            "TypeScript compiled to JavaScript. The stored module is the JavaScript now shown.",
            docId,
            "info",
          );
        }
      }

      showChip();

      // AN OPEN SESSION IS NOT HOT-SWAPPED. It keeps its instrumented snapshot;
      // the next Run/Debug is what picks the new source up.
      if (getDebugSession(docId)) markSessionStale(docId);
    },
    [reportToConsole, markSessionStale],
  );
  const applyLiveOutcomeRef = useRef(applyLiveOutcome);
  applyLiveOutcomeRef.current = applyLiveOutcome;

  if (!persisterRef.current) {
    persisterRef.current = new LiveModulePersister({
      // The SAME gate the Save button always used. An auto-persist is still a
      // save: un-runnable text must never reach the store just because the
      // author paused typing.
      gate: (src, name) => gateObjectScriptSave(src, name, hostValidateScript),
      write: async (docId, javascript) => {
        const doc = macroDocsRef.current.find((d) => d.macroId === docId);
        // THE LAST LINE OF THE READ-ONLY RULE. A document `macroWriteRefusal`
        // names is never TRACKED by this persister (see the effect that calls
        // `track`), so nothing should ever reach here for one — and if a future
        // edit to this window arms one anyway, the write must not be the thing
        // that discovers it. The refusal is asked here in the SAME words the
        // tracking effect asks it, so a door added later cannot answer
        // differently from the one that guards the store.
        const refusal = doc
          ? macroWriteRefusal({
              name: doc.script.name,
              sourcePackage: doc.sourcePackage,
              sourcePackageKnown: doc.sourcePackageKnown,
            })
          : null;
        if (refusal !== null) throw new Error(refusal);
        await saveWorkbookScript({
          id: docId,
          name: doc?.script.name ?? docId,
          // The runtime marker lives in the description and decides how the
          // macro is executed — preserved verbatim on every write.
          description: doc?.description ?? null,
          source: javascript,
          // THE RECORD'S OWN SCOPE, NOT A CONSTANT. This was a hard-coded
          // `{ type: "workbook" }`, so an idle auto-persist of a sheet-scoped
          // module silently widened it to the whole workbook — the module then
          // resolves from every sheet, which is a visibility change the author
          // never asked for and is not told about. `undefined` when the record
          // stated none, which leaves the store's own default alone.
          scope: doc?.scope,
          // AND THE PACKAGE STAMP, ON EVERY WRITE — which, after the guard
          // above, is always `null`: only the user's own modules are written
          // from here. It is sent explicitly all the same, as a positive
          // statement that this record is local rather than a field the write
          // happened not to mention. (An omitted stamp is carried forward by
          // `sticky_source_package` in `save_script`, so "omitted" and "local"
          // are NOT the same thing to the store, and a writer that leaves the
          // difference to the backend is asserting a fact it never established.)
          sourcePackage: doc?.sourcePackage ?? null,
        });
      },
      onOutcome: (docId, outcome) => applyLiveOutcomeRef.current(docId, outcome),
    });
  }
  const persister = persisterRef.current;

  // Going away is the last chance to write: flush FIRST, then drop the timers.
  // Disposing without flushing would throw away up to one debounce window of
  // typing — the one loss this feature exists to prevent.
  useEffect(
    () => () => {
      void persister.flushAll().finally(() => persister.dispose());
    },
    [persister],
  );

  // Load scripts from backend
  const loadScripts = useCallback(async () => {
    try {
      const allScripts = await loadAllObjectScripts();
      setScripts(allScripts);
      return allScripts;
    } catch (e) {
      console.error("[ObjectScriptEditorApp] Failed to load scripts:", e);
      return [];
    }
  }, []);

  /**
   * Enumerate the workbook's MODULE scripts — every recorded macro, not just the
   * one this window was navigated to.
   *
   * This is the whole of bug A: the editor used to know about exactly the macro
   * handed to it on the open channel, so a second macro replaced the first.
   * `listWorkbookScriptRecords` is the same door the Macros library lists
   * through, reached through @api rather than by importing the Macro Recorder.
   */
  const loadMacros = useCallback(async () => {
    let records: WorkbookScriptRecord[];
    try {
      records = await listWorkbookScriptRecords();
    } catch (e) {
      // Never a silently empty dropdown: if the store cannot be read, say so.
      reportToConsole(
        `Could not list this workbook's script modules, so recorded macros are missing ` +
          `from the list: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }

    // An external edit to the module the author is LOOKING at, with no local
    // edits of their own, is shown rather than hidden — but it is announced,
    // because text changing under the cursor with no explanation is worse than
    // either outcome.
    const activeId = activeDocIdRef.current;
    if (activeId && !isDirtyRef.current) {
      const record = records.find((r) => r.id === activeId);
      if (record && !record.loadError && record.source !== sourceRef.current) {
        setSource(record.source);
        reportToConsole(
          `"${record.name}" changed in the workbook and has been reloaded here.`,
          record.id,
          "info",
        );
      }
    }

    setMacroDocs((prev) => {
      // Stash the live buffer into the ACTIVE document first. Its edits live in
      // `source`/`isDirty` until a switch moves them, and the merge decides what
      // to keep by looking at `dirty` — without this, a refresh that arrives
      // while the author is typing would judge the document clean and throw the
      // work away (deleted elsewhere) or overwrite it (edited elsewhere).
      const activeId = activeDocIdRef.current;
      const withLiveBuffer = activeId
        ? prev.map((d) =>
            d.macroId === activeId
              ? {
                  ...d,
                  script: { ...d.script, source: sourceRef.current },
                  dirty: isDirtyRef.current,
                }
              : d,
          )
        : prev;
      return mergeMacroDocs(withLiveBuffer, records);
    });
    for (const record of records) {
      if (record.loadError) {
        reportToConsole(
          `"${record.name}" (${record.id}) is listed but could not be read: ${record.loadError}`,
          record.id,
        );
      }
    }
  }, [reportToConsole]);

  // Initial load. `listingsLoaded` marks the moment both answers are in, which
  // is the only point at which "the document this window was opened for is not
  // in the workbook" can be concluded rather than guessed.
  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([loadScripts(), loadMacros()]).then(() => {
      if (!cancelled) setListingsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [loadScripts, loadMacros]);

  // Keep the persister's idea of "what the store holds" in step with the listing,
  // and let go of documents that are gone. `track` never touches a buffer, so a
  // refresh landing mid-edit cannot take the author's text — and it never lowers
  // the stored baseline underneath a write that is already in flight.
  //
  // A DOCUMENT `macroWriteRefusal` NAMES IS NEVER TRACKED — a module that
  // arrived in an application, and a module whose record could not be read.
  //
  // Tracking is what arms the idle timer, and this ONE line is what disarms
  // every write door at once: `handleChange` short-circuits on
  // `persister.tracks`, `flush`/`flushAll` return "unchanged", so switching
  // document, Ctrl+S, the flush in front of Run and the window close/blur flush
  // all write nothing, and an accepted AI edit reaches the store only through
  // the same `handleChange`. The buffer itself is read-only (Monaco `readOnly`),
  // so this is the structural half of the same rule; adding a sixth door and
  // forgetting to guard it is the failure this shape exists to make impossible.
  useEffect(() => {
    const known = new Set<string>();
    const editable = new Set<string>();
    for (const doc of macroDocs) {
      known.add(doc.macroId);
      const refusal = macroWriteRefusal({
        name: doc.script.name,
        sourcePackage: doc.sourcePackage,
        sourcePackageKnown: doc.sourcePackageKnown,
      });
      if (refusal !== null) continue;
      editable.add(doc.macroId);
      persister.track(doc.macroId, doc.script.name, doc.savedSource);
    }
    persister.retain(editable);
    setLiveStates((prev) => {
      const next: Record<string, LiveDocState> = {};
      let changed = false;
      for (const [id, state] of Object.entries(prev)) {
        if (known.has(id)) next[id] = state;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [macroDocs, persister]);

  // The list must follow the workbook: a macro recorded, renamed or deleted in
  // the main window while this editor is open changes what belongs here. The
  // module store announces every write it makes (@api/workbookScripts), so this
  // is a subscription, not a poll.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void onWorkbookScriptsChanged(() => {
      void loadMacros();
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* no event bus in this environment; the list still loads on open */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadMacros]);

  /**
   * Move the live buffer into the module document it belongs to.
   *
   * The single-macro editor already had the rule that "switching away must not
   * silently write" — a module script must never be auto-saved through the
   * object-script path. That rule is preserved for N documents by KEEPING the
   * edits here instead: nothing is written, and coming back shows exactly what
   * was being read.
   */
  const stashActiveMacroBuffer = useCallback(() => {
    const id = activeDocIdRef.current;
    if (!id) return;
    if (!macroDocsRef.current.some((d) => d.macroId === id)) return;
    const buffer = sourceRef.current;
    const dirty = isDirtyRef.current;
    setMacroDocs((prev) =>
      prev.map((d) =>
        d.macroId === id ? { ...d, script: { ...d.script, source: buffer }, dirty } : d,
      ),
    );
  }, []);
  const stashActiveBufferRef = useRef(stashActiveMacroBuffer);
  stashActiveBufferRef.current = stashActiveMacroBuffer;

  // Listen for Tauri events from main window (registered once on mount)
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    // The OPEN-channel registrations. The main window holds delivery of the
    // initial macro/script/draft until this editor says it is ready, and "ready"
    // means exactly these three listeners are live — so READY is emitted only
    // after all three `listen()` round-trips have resolved.
    const openChannelReady: Array<Promise<unknown>> = [];

    // Open with specific script — set activeScriptId and reload scripts
    // from backend to ensure we have the latest (including newly created scripts).
    const openWithScriptReady = onOpenWithScript(async (payload) => {
      if (cancelled) return;
      if (payload.scriptId) {
        requestedDocIdRef.current = payload.scriptId;
        setActiveScriptId(payload.scriptId);
        // Always reload from backend to pick up newly created scripts
        try {
          const allScripts = await loadAllObjectScripts();
          if (!cancelled) {
            setScripts(allScripts);
          }
        } catch (e) {
          console.error("[ObjectScriptEditorApp] Failed to reload scripts:", e);
        }
      }
    }).then((fn) => { if (!cancelled) unlisteners.push(fn); else fn(); });
    openChannelReady.push(openWithScriptReady);

    // An AI-authored draft handed over for review. Nothing here saves, registers
    // or mounts it — it is loaded into the editor as text, under a banner that
    // says so, and only the Save button can make it real.
    const openWithDraftReady = onOpenWithDraft((payload) => {
      if (cancelled) return;
      const script = draftToScriptDefinition(payload.draft);
      setDraftDoc({ draft: payload.draft, script });
      requestedDocIdRef.current = script.id;
      setActiveScriptId(script.id);
      setSource(script.source);
      setLanguage("javascript");
      setIsDirty(false);
    }).then((fn) => { if (!cancelled) unlisteners.push(fn); else fn(); });
    openChannelReady.push(openWithDraftReady);

    // A recorded macro (a MODULE script) opened for editing. Re-read the
    // authoritative record here so the editor always shows the live source, not
    // a copy that rode the wire; fall back to the preview if the record has
    // since been deleted, so the window still shows what the caller meant.
    //
    // OPENING IS SELECTING. A macro already in the list is SELECTED, never added
    // a second time, and if the author has unsaved edits in it those edits are
    // what they are shown — re-opening a document must not be a way to throw
    // work away.
    const openWithMacroReady = onOpenWithModuleMacro((payload) => {
      if (cancelled) return;

      // SELECTION HAPPENS NOW, NOT AFTER THE RECORD READ. Everything below this
      // point awaits the backend, and while it awaits, a listing that lands can
      // reach the "nothing selected yet" fallback and choose a different macro.
      // Whatever is in the buffer belongs to the document being left, so snapshot
      // that first — the stash is a state update that has not landed yet, and
      // re-opening the document already in front of the author must see its
      // unsaved edits.
      const leavingId = activeDocIdRef.current;
      const liveBuffer = sourceRef.current;
      const liveDirty = isDirtyRef.current;
      stashActiveBufferRef.current();
      requestedDocIdRef.current = payload.macroId;
      setActiveScriptId(payload.macroId);

      void (async () => {
        let record: WorkbookScriptRecord | null = null;
        let readError: string | null = null;
        try {
          const live = await getWorkbookScript(payload.macroId);
          record = {
            id: live.id,
            name: live.name,
            description: live.description ?? null,
            source: live.source,
            scope: live.scope,
            sourcePackage: live.sourcePackage ?? null,
            loadError: null,
          };
        } catch (e) {
          readError = e instanceof Error ? e.message : String(e);
        }
        if (cancelled) return;

        const listed = macroDocsRef.current.find((d) => d.macroId === payload.macroId);
        const isReopeningActive = listed !== undefined && listed.macroId === leavingId;
        const existing = listed
          ? {
              dirty: isReopeningActive ? liveDirty : listed.dirty,
              source: isReopeningActive ? liveBuffer : listed.script.source,
            }
          : undefined;
        if (!record) {
          // The record could not be read. Say so — a blank editor with no
          // explanation is the failure mode this whole feature keeps hitting.
          reportToConsole(
            `"${payload.name}" could not be read from the workbook (${readError}). ` +
              (existing
                ? "Showing the copy already open here."
                : "Showing the preview the caller sent.") +
              // NOT "saving will write it back", which is what this line used to
              // promise. Nothing here writes a record that could not be read —
              // we do not know whose it is, and the write would be over bytes
              // nobody has seen.
              " It is READ-ONLY until a read succeeds: this window will not write " +
              "over a record it could not read.",
            payload.macroId,
          );
          record = {
            id: payload.macroId,
            name: payload.name,
            description: payload.description,
            source: existing ? existing.source : payload.source,
            // The record could not be read, so this window knows nothing NEW
            // about its provenance. `macroDocFromRecord` is handed `listed` as
            // the last-known answer below and decides from there; the open
            // payload carries no provenance at all, so it cannot be asked, and
            // "I could not read it" is never rendered as "it is yours".
            sourcePackage: listed?.sourcePackage ?? null,
            // Nor does it know the scope — same reason, same answer: the last
            // established one, never the store's default asserted as a fact.
            scope: listed?.scope,
            loadError: readError,
          };
        }

        const fresh = macroDocFromRecord(record, listed);
        const keepBuffer = existing?.dirty === true;
        const doc: MacroDoc = keepBuffer
          ? {
              ...fresh,
              script: { ...fresh.script, source: existing!.source },
              dirty: true,
            }
          : fresh;

        setMacroDocs((prev) => {
          const without = prev.filter((d) => d.macroId !== doc.macroId);
          return [...without, doc].sort((a, b) => a.script.name.localeCompare(b.script.name));
        });
        setActiveScriptId(doc.macroId);
        setSource(doc.script.source);
        setLanguage("javascript");
        setIsDirty(doc.dirty);
        loadedDocIdRef.current = doc.macroId;
        if (keepBuffer) {
          reportToConsole(
            `"${doc.script.name}" was already open here with unsaved edits — those edits are shown, ` +
              "not the stored version.",
            doc.macroId,
            "info",
          );
        }
      })();
    }).then((fn) => { if (!cancelled) unlisteners.push(fn); else fn(); });
    openChannelReady.push(openWithMacroReady);

    // The main window waits for this before delivering the initial open payload.
    // Emitted only once every OPEN listener is registered, so a payload sent in
    // response cannot arrive before this editor can receive it.
    void Promise.all(openChannelReady)
      .then(() => {
        if (!cancelled) void emitEditorReady();
      })
      .catch(() => {
        /* a failed listen registration surfaces elsewhere; the timer fallback
           in the main window still delivers so the window is never left blank */
      });

    // Console output forwarded from main window
    onConsoleOutput((payload) => {
      if (cancelled) return;
      const message = payload.args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
      setConsoleEntries((prev) => [
        ...prev,
        {
          id: ++consoleIdRef.current,
          level: (payload.level as ConsoleEntry["level"]) || "log",
          message,
          scriptId: payload.scriptId,
          timestamp: Date.now(),
        },
      ]);
    }).then((fn) => { if (!cancelled) unlisteners.push(fn); else fn(); });

    // Script errors forwarded from main window
    onScriptError((payload) => {
      if (cancelled) return;
      const message = `[${payload.scriptName}] Error: ${payload.error}${payload.stack ? "\n" + payload.stack : ""}`;
      setConsoleEntries((prev) => [
        ...prev,
        {
          id: ++consoleIdRef.current,
          level: "error",
          message,
          scriptId: payload.scriptId,
          timestamp: Date.now(),
        },
      ]);
      setShowConsole(true);
    }).then((fn) => { if (!cancelled) unlisteners.push(fn); else fn(); });

    // Scripts changed externally
    onScriptsChanged((payload) => {
      if (cancelled) return;
      setScripts(payload.scripts);
    }).then((fn) => { if (!cancelled) unlisteners.push(fn); else fn(); });

    // Announce a RELOAD/navigation of this webview. NOT the window closing:
    // measured under Tauri + WebView2, `beforeunload` does not run when the
    // window is closed, so the authoritative close announcement is made by the
    // MAIN window from `tauri://destroyed` (openObjectScriptWindow.ts). This one
    // covers the case the main window cannot see — the editor's own document
    // going away while the window lives on.
    const handleBeforeUnload = () => {
      // FLUSH ON THE WAY OUT. Best effort by nature: an unload handler cannot
      // await a backend round trip, so the write is posted and the page may go
      // before it lands. That is why the blur flush below exists — it is the one
      // that can be relied on.
      void persisterRef.current?.flushAll();
      emitEditorClosed();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    // THE RELIABLE FLUSH. This editor is its own Tauri window, and the only way
    // to reach anything that runs a macro (a button on the grid, the Macros
    // dialog) is to leave it. Leaving is a blur, and a blur handler runs with
    // the window still alive, so the store is up to date before the main window
    // can execute anything. Without it the guarantee would rest on the 400 ms
    // debounce having happened to fire.
    const handleWindowBlur = () => {
      void persisterRef.current?.flushAll();
    };
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, []);

  // When the ACTIVE DOCUMENT changes, load its buffer. If nothing is selected
  // but something exists, auto-select it (object scripts first, then modules —
  // a workbook can hold macros and no object scripts at all).
  //
  // `loadedDocIdRef` guards the whole effect: it re-runs whenever the lists
  // change, and without the guard a background refresh of the macro list would
  // reset the buffer the author is typing in.
  useEffect(() => {
    // THE REQUESTED DOCUMENT OUTRANKS THE FALLBACK. While the id this window was
    // opened for is still outstanding, "take the first one" must not run — it is
    // what selected the wrong macro. The request is only released once both
    // listings have answered and the id is genuinely in neither of them (a macro
    // deleted between the open call and this window mounting), at which point the
    // fallback below runs on the next pass rather than leaving a blank editor.
    if (requestedDocIdRef.current && requestedDocIdRef.current === activeScriptId) {
      const found =
        scripts.some((s) => s.id === activeScriptId) ||
        macroDocs.some((d) => d.macroId === activeScriptId) ||
        draftDoc?.script.id === activeScriptId;
      if (found) {
        requestedDocIdRef.current = null;
      } else if (listingsLoaded) {
        requestedDocIdRef.current = null;
        setActiveScriptId(null);
        return;
      } else {
        return;
      }
    }
    if (!activeScriptId && scripts.length > 0) {
      setActiveScriptId(scripts[0].id);
      setSource(scripts[0].source);
      setIsDirty(false);
      loadedDocIdRef.current = scripts[0].id;
      return;
    }
    if (!activeScriptId && macroDocs.length > 0) {
      const first = macroDocs[0];
      setActiveScriptId(first.macroId);
      setSource(first.script.source);
      setIsDirty(first.dirty);
      loadedDocIdRef.current = first.macroId;
      return;
    }
    if (!activeScriptId) return;
    if (loadedDocIdRef.current === activeScriptId) return;
    const script = scripts.find((s) => s.id === activeScriptId);
    if (script) {
      setSource(script.source);
      setIsDirty(false);
      loadedDocIdRef.current = activeScriptId;
      return;
    }
    // The draft is not in `scripts`, so it needs its own restore path — without
    // it, selecting the draft again from the dropdown would show whatever text
    // the previous script left behind.
    if (draftDoc && draftDoc.script.id === activeScriptId) {
      setSource(draftDoc.script.source);
      setIsDirty(false);
      loadedDocIdRef.current = activeScriptId;
      return;
    }
    // Same for a module script (a recorded macro): it is not in the
    // object-script list either — and its buffer carries ITS unsaved edits.
    const doc = macroDocs.find((d) => d.macroId === activeScriptId);
    if (doc) {
      setSource(doc.script.source);
      setIsDirty(doc.dirty);
      loadedDocIdRef.current = activeScriptId;
    }
  }, [activeScriptId, scripts, draftDoc, macroDocs, listingsLoaded]);

  // Auto-scroll console
  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [consoleEntries]);

  const savedScript = scripts.find((s) => s.id === activeScriptId) ?? null;
  /** True while the document in front of the author is an unsaved AI draft. */
  const isDraft =
    savedScript === null && draftDoc !== null && draftDoc.script.id === activeScriptId;
  /** The module document in front of the author, if the active one is a module. */
  const macroDoc =
    savedScript === null && !isDraft
      ? macroDocs.find((d) => d.macroId === activeScriptId) ?? null
      : null;
  /** True while the document in front of the author is a recorded MACRO (module script). */
  const isMacro = macroDoc !== null;
  const activeScript =
    savedScript ?? (isDraft ? draftDoc!.script : macroDoc ? macroDoc.script : null);
  /**
   * READ-ONLY, FOR EITHER KIND OF DISTRIBUTED CODE.
   *
   * For an object script this was always true. For a MODULE it is the fix to a
   * regression the sticky-stamp rule created: this editor writes a module back
   * on an idle debounce, `save_script` now carries the package stamp forward,
   * and the Rust consent gate matches (package, id, source) — so an edit here
   * left a record that matches no consent record, and a consented macro the user
   * was happily running was refused FOREVER, from nothing more than opening it
   * and pausing. Before the stamp became sticky the same edit LAUNDERED the
   * macro into local code instead, which was the security hole. Neither is
   * acceptable, so this window does the third thing: it does not edit a
   * publisher's macro at all. The publisher's record stays byte-for-byte as it
   * arrived, which is exactly what keeps the escape hatch armed — Developer ▸
   * Macros… compares the buffer with the STORED source and offers "Save as my
   * copy" when they differ, and an in-place write from here would have made them
   * equal and disarmed it. (Forking from this window instead was the other
   * honest option; it is not taken here because the fork — id minting, unique
   * naming, lineage in the description — already exists in the Macro Recorder,
   * and a second copy of it in this extension would be a second source of truth
   * that drifts on the owner's first change.)
   */
  /**
   * The module refusal, if the open document is a module and is refused.
   *
   * Derived from `macroWriteRefusal`, which is the SAME call the persister's
   * tracking effect and its `write` make. The chrome and the store therefore
   * cannot disagree about whether this document is writable — a mismatch between
   * them is exactly how an "origin unknown" chip came to sit above a buffer that
   * was quietly persisting itself.
   */
  const macroRefusal = macroDoc
    ? macroWriteRefusal({
        name: macroDoc.script.name,
        sourcePackage: macroDoc.sourcePackage,
        sourcePackageKnown: macroDoc.sourcePackageKnown,
      })
    : null;
  const isReadOnly = activeScript?.provenance === "distributed" || macroRefusal !== null;
  /** Why the buffer refuses edits, in the words the user is owed. Null when it does not. */
  const readOnlyReason =
    macroRefusal ??
    (isReadOnly ? "Distributed scripts are read-only in this window." : null);
  /**
   * Why Run/Debug refuse, or null when they do not.
   *
   * READ-ONLY IS NOT UNRUNNABLE, and conflating them would be a fresh untruth.
   * A distributed MODULE is mounted BY ID from the module store
   * (`hostStartModuleScriptDebugSession`), at the restricted tier, from the
   * publisher's own stored bytes — exactly what a button on the grid runs — so
   * reading and stepping through it is both safe and the whole point of a
   * transparency surface. A distributed OBJECT SCRIPT has no such path here and
   * keeps its refusal.
   */
  const runBlockedReason =
    isReadOnly && !isMacro
      ? "Distributed scripts are read-only and cannot be run from here."
      : null;
  const docs = activeScript ? getContextDocumentation(activeScript.objectType) : [];

  /** What kind of document is open, and therefore what live editing may do to it. */
  const docKind = editorDocumentKind({ isDraft, isModule: isMacro });
  const livePolicy = liveEditPolicyFor(docKind);
  const livePolicyRef = useRef(livePolicy);
  livePolicyRef.current = livePolicy;
  const activeNameRef = useRef<string>(activeScript?.name ?? "");
  activeNameRef.current = activeScript?.name ?? "";
  /**
   * The live state of the module in front of the author (modules only).
   *
   * A refused module is never tracked by the persister and so can never reach
   * any of the written states: it reports READ-ONLY, which is the true answer to
   * "does the store hold what I am looking at, and will it keep holding it" —
   * "Live" would be accidentally true and would invite the author to type. For
   * an unreadable record it would be worse than accidental: "Live" asserts that
   * the store holds this text, which is the one thing that read failed to
   * establish.
   */
  const activeLive: LiveDocState | undefined = isMacro && activeScriptId
    ? macroRefusal !== null
      ? { state: "readOnly" }
      : liveStates[activeScriptId] ?? (isDirty ? { state: "saving" } : { state: "live" })
    : undefined;
  /** True when the open document's debug session is running pre-edit code. */
  const activeSessionStale = !!activeScriptId && staleSessionDocs.includes(activeScriptId);

  // ==========================================================================
  // Edit with AI
  // ==========================================================================
  // The run happens in the MAIN window: every AI backend command is
  // window-guarded to it, and this window activates no extensions. What lives
  // here is the ask, the progress, and the decision.
  //
  // THE PROPOSAL NEVER TOUCHES THE BUFFER ON ITS OWN. It arrives, a diff opens,
  // and only the Accept button writes. That is the whole point for a recorded
  // macro, which auto-persists about a second after any buffer change: an
  // auto-applied proposal would be SAVED over the author's version before they
  // had read a line of it.
  const [showAiEdit, setShowAiEdit] = useState(false);
  useEffect(() => installAiEditClient(), []);

  // ==========================================================================
  // Preview form
  // ==========================================================================
  // Offered ONLY for a `form` script. The text on screen is compiled through
  // the same gate a save uses — but NOT stored — and the JavaScript goes to
  // the MAIN window, where the preview realm runs it against a copy of the
  // active sheet and paints the captured layout in a labelled preview dialog.
  // Nothing is saved, mounted or written; what comes back is a status line.
  useEffect(() => installFormPreviewClient(), []);
  const formPreview = useSyncExternalStore(
    subscribeToFormPreviews,
    // The shared idle object when there is nothing — see aiEditStateFor.
    () => formPreviewStateFor(activeScriptId),
  );
  const isFormScript = activeScript?.objectType === "form";

  const handlePreviewForm = useCallback(async () => {
    if (!activeScript || !activeScriptId || activeScript.objectType !== "form") return;
    // The buffer ON SCREEN, unsaved edits included — the whole point of a
    // preview is to look before saving.
    const text = editorRef.current?.getValue() ?? sourceRef.current;
    const gate = await gateObjectScriptSave(text, activeScript.name, hostValidateScript);
    if (!gate.ok) {
      // The compiler's message lands here, in the window the author is typing
      // in — and nothing was sent, so nothing can come back.
      reportToConsole(gate.detail, activeScript.id);
      reportFormPreviewFailure(activeScriptId, `The preview did not start: ${gate.message}`);
      return;
    }
    requestFormPreview({ scriptId: activeScriptId, scriptName: activeScript.name, source: gate.javascript });
  }, [activeScript, activeScriptId, reportToConsole]);

  // ==========================================================================
  // Design form (the visual designer)
  // ==========================================================================
  // ONE ARTIFACT: the designer edits the `// #region Form layout` block IN THIS
  // BUFFER and nowhere else, so "the code tab" and "the designer" are two views
  // of one text. That is why Monaco stays MOUNTED while the designer is on
  // screen (hidden, not unmounted): its model, its undo stack and its
  // breakpoints survive the switch, and a designer edit lands on that same undo
  // stack — Ctrl+Z in the code tab takes back a drag.
  const [designing, setDesigning] = useState(false);
  useEffect(() => {
    // A different script is not necessarily a form, and one that is has a
    // different layout. Leaving the designer open across the switch would show
    // the previous script's widgets over the new script's buffer.
    setDesigning(false);
  }, [activeScriptId]);

  /**
   * Put text the designer produced into the buffer — the same path a keystroke
   * takes, never a save.
   *
   * Through Monaco when it is mounted (which it is: the designer hides it
   * rather than unmounting it), for the reason `handleAcceptAi` gives — the
   * edit goes on the undo stack and fires `handleChange`, so dirty-marking and
   * the module live-persist path behave exactly as they do for typing. The
   * fallback is not decoration: a test mounts this window without Monaco, and
   * an edit that silently did nothing there would be an edit that silently did
   * nothing anywhere the editor failed to mount.
   *
   * `handleChange` is defined further down (it needs the persister), so it is
   * reached through a ref rather than reordered: moving it up here would put
   * the buffer bookkeeping above the thing it books.
   */
  const handleChangeRef = useRef<(value: string | undefined) => void>(() => {});
  const handleDesignerSource = useCallback(
    (next: string) => {
      const ed = editorRef.current;
      const model = ed?.getModel();
      if (ed && model) {
        ed.pushUndoStop();
        ed.executeEdits("form-designer", [{ range: model.getFullModelRange(), text: next }]);
        ed.pushUndoStop();
        return;
      }
      handleChangeRef.current(next);
    },
    [],
  );

  // ==========================================================================
  // How this script was written
  // ==========================================================================
  // READ ON OPEN, never on load. An ordinary editing session never asks for the
  // history, and paying for it on every window open would be a cost with no
  // reader. The badge therefore counts what THIS window knows: the undecided
  // proposal on screen always, plus whatever the last read returned.
  const [showHistory, setShowHistory] = useState(false);
  const [historyRuns, setHistoryRuns] = useState<AuthoringRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  /**
   * Capabilities the DRAFT declares that no call in it appears to need.
   *
   * The reviewer is about to grant exactly these by pressing Save, and the
   * banner above showed only what was declared — never that nothing in the code
   * was seen to use it. §11.2 makes this a NOTICE precisely because a machine
   * cannot decide it and a person can, and this is the person.
   *
   * IMPORTED LAZILY. `scriptValidation` reaches the generated
   * `scriptSurfacePolicy` (~94 KB, which is all `scriptValidation/surface.ts`
   * imports), and this window loads Monaco on a cold start — an AI draft is a
   * rare document, so the surface is fetched when one actually arrives.
   *
   * Validated UNNARROWED. Only `declared-not-observed` is read, and that finding
   * is about pragmas versus observed capability use — the same answer for every
   * object type — so narrowing would change nothing here and add a second field
   * to keep true.
   */
  const [unobservedCaps, setUnobservedCaps] = useState<string[]>([]);
  const draftSource = isDraft && draftDoc ? draftDoc.script.source : null;
  useEffect(() => {
    if (!draftSource) {
      setUnobservedCaps([]);
      return;
    }
    let cancelled = false;
    void import("@api/scriptHost/scriptValidation")
      .then(({ validateScriptSource }) => {
        if (cancelled) return;
        const report = validateScriptSource(draftSource);
        setUnobservedCaps(
          report.findings
            .filter((f) => f.code === "declared-not-observed")
            .map((f) => f.capability ?? "")
            .filter((c) => c !== ""),
        );
      })
      .catch(() => {
        // A surface that cannot be loaded means this one extra line is missing,
        // nothing more. The banner's own facts do not depend on it.
        if (!cancelled) setUnobservedCaps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [draftSource]);
  const aiEdit = useSyncExternalStore(
    subscribeToAiEdits,
    // Returns the SHARED idle object when there is nothing, never a fresh
    // literal: a new object per call is a new snapshot every render, which this
    // hook answers with "Maximum update depth exceeded".
    () => aiEditStateFor(activeScriptId),
  );

  /** Send the text ON SCREEN — not the stored copy — with the instruction. */
  const handleAskAi = useCallback(
    (instruction: string) => {
      if (!activeScript || !activeScriptId) return;
      askAiToEdit({
        documentId: activeScriptId,
        documentName: activeScript.name,
        objectType: activeScript.objectType,
        documentKind: docKind,
        currentSource: editorRef.current?.getValue() ?? sourceRef.current,
        instruction,
      });
    },
    [activeScript, activeScriptId, docKind],
  );

  /**
   * Put the proposal in the buffer, as ONE undoable edit.
   *
   * Through Monaco rather than setSource, deliberately: it goes on the undo
   * stack (Ctrl+Z takes the author straight back), and it fires the change
   * handler, so dirty-marking and the module live-save path behave exactly as
   * they do for typing. A direct setSource would bypass both.
   */
  /**
   * Write one run down, at the instant its author decides about it.
   *
   * THE ONLY WRITE POINT FOR AN EDIT, and `mutates` is honest here because a
   * human pressed a button: an `objscript:ai-edit-result` event — a Tauri
   * channel — must not be able to dirty the workbook on its own. What is
   * captured is the fact a run cannot know about itself: "I asked for X, it
   * proposed Y, I said no."
   *
   * FIRE-AND-FORGET. A failed write must never block the buffer edit the author
   * actually asked for; the backend refuses an unknown id, and losing a log line
   * is not a reason to lose the edit.
   *
   * A DRAFT'S DECISIONS ARE WRITTEN UNDER ITS `draft-*` ID — the one key the
   * backend accepts before Save (`append_run` takes any draft-prefixed id and
   * REFUSES an unknown minted one), the same key `historyId` below reads, and
   * the key `adoptScriptAuthoringRuns` re-keys onto the real script id at Save.
   */
  const recordDecision = useCallback(
    (run: AuthoringRun | null, decision: RunDecision) => {
      // A REFUSED run is deliberately unpersistable: nothing was asked, so the
      // bridge's `fail()` stamps `runId: ""` and `append_run` refuses an empty
      // run id. Skip it here rather than fire an append that must fail.
      if (!run || !run.runId) return;
      const targetId = isDraft && draftDoc ? draftDoc.draft.id : activeScriptId;
      if (!targetId) return;
      void appendScriptAuthoringRun(targetId, {
        ...run,
        decision,
        decidedAt: new Date().toISOString(),
      }).catch(() => {});
    },
    [activeScriptId, isDraft, draftDoc],
  );

  const handleAcceptAi = useCallback(() => {
    if (!activeScriptId) return;
    const decided = aiEditStateFor(activeScriptId);
    const proposal = decided.proposal;
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (ed && model) {
      ed.pushUndoStop();
      ed.executeEdits("ai-edit", [{ range: model.getFullModelRange(), text: proposal }]);
      ed.pushUndoStop();
      ed.focus();
    } else {
      // No editor mounted (a test, or a window mid-teardown). The buffer is
      // still the source of truth for a save, so it must not be skipped.
      setSource(proposal);
      setIsDirty(true);
    }
    recordDecision(decided.run, "accepted");
    clearAiEdit(activeScriptId);
  }, [activeScriptId, recordDecision]);

  const handleRejectAi = useCallback(() => {
    if (!activeScriptId) return;
    // READ BEFORE REJECTING: `rejectAiEdit` clears `run`, and a rejection with
    // nothing written down is exactly the provenance that was asked for.
    recordDecision(aiEditStateFor(activeScriptId).run, "rejected");
    rejectAiEdit(activeScriptId);
  }, [activeScriptId, recordDecision]);

  /**
   * Which id this document's runs are filed under.
   *
   * A DRAFT'S RUNS LIVE UNDER THE `draft-*` ID until Save re-keys them, because
   * that is the only id that existed when the script was written. Reading the
   * minted id instead would show an empty history on the one document whose
   * history the author is most likely to want.
   */
  const historyId = isDraft && draftDoc ? draftDoc.draft.id : activeScriptId;

  const openHistory = useCallback(async () => {
    setShowHistory(true);
    if (!historyId) return;
    setHistoryLoading(true);
    try {
      setHistoryRuns(await getScriptAuthoringRuns(historyId));
    } catch (e) {
      // An unreadable history is a missing panel, not a broken editor.
      setHistoryRuns([]);
      console.warn("[ObjectScriptEditor] Could not read the authoring history:", e);
    } finally {
      setHistoryLoading(false);
    }
  }, [historyId]);

  const clearHistory = useCallback(async () => {
    if (!historyId) return;
    try {
      await clearScriptAuthoringRuns(historyId);
      setHistoryRuns([]);
    } catch (e) {
      console.warn("[ObjectScriptEditor] Could not delete the authoring history:", e);
    }
  }, [historyId]);


  // Point `ObjectScriptContext` at THIS script's context interface, so
  // `@param {ObjectScriptContext} context` resolves to (say) SlicerContext —
  // on BOTH lanes, because JSDoc types only apply to a .js model and real
  // annotations only apply to a .ts one.
  useEffect(() => {
    if (!activeScript) return;
    setActiveContextType(monacoTs, activeScript.objectType, objectContextsDts);
    registerTypescriptLane(monacoTs, activeScript.objectType, objectContextsDts);
  }, [activeScript]);

  // Switch active script
  const handleSelectScript = useCallback(async (scriptId: string) => {
    // An explicit choice ends the open request: from here the author decides
    // what is on screen, not the id this window was launched with.
    requestedDocIdRef.current = null;
    // A DRAFT is never auto-saved. Switching away from AI-authored code must
    // not be the thing that writes it into the workbook — the whole point of a
    // draft is that only an explicit Save promotes it. Keep the author's edits
    // in the draft instead, so coming back shows what they were reading.
    if (isDraft && draftDoc) {
      setDraftDoc({ ...draftDoc, script: { ...draftDoc.script, source } });
      setLanguage("javascript");
      setActiveScriptId(scriptId);
      return;
    }
    // A MODULE is live code, so switching away FLUSHES it: the module store must
    // hold what the author was looking at before anything in the main window
    // (a button that links this macro) can run it. The buffer is still stashed
    // into its own document first, because a flush that cannot compile stores
    // nothing — and the author's text must survive that.
    if (isMacro) {
      stashActiveMacroBuffer();
      const leavingId = activeDocIdRef.current;
      setLanguage("javascript");
      setActiveScriptId(scriptId);
      // Deliberately NOT awaited before the switch: the outcome is applied to the
      // document it belongs to (by id), so a slow write cannot delay opening the
      // next document — and cannot land in the wrong buffer either.
      if (leavingId) void persister.flush(leavingId, true);
      return;
    }
    // Auto-save current. The same gate as the Save button: an auto-save is
    // still a save, and un-runnable text must never reach the store just
    // because the author picked another script from the list.
    if (isDirty && activeScript) {
      const gate = await gateObjectScriptSave(source, activeScript.name, hostValidateScript);
      if (!gate.ok) {
        reportToConsole(gate.detail, activeScript.id);
        return;
      }
      const updated = { ...activeScript, source: gate.javascript };
      saveObjectScript(updated).catch(console.error);
      emitRegisterScript(updated).catch(console.error);
    }
    setLanguage("javascript");
    setActiveScriptId(scriptId);
  }, [
    isDirty,
    isDraft,
    draftDoc,
    isMacro,
    stashActiveMacroBuffer,
    activeScript,
    source,
    reportToConsole,
    persister,
  ]);

  /**
   * Push a MODULE document's buffer into the module store NOW, and report
   * whether the store ended up holding it.
   *
   * There is only one write path for a module (the persister), so an idle
   * debounce, Ctrl+S, switching document, closing the window and the flush in
   * front of Run all obey the same gate, the same coalescing and the same
   * "un-compilable text stores nothing" rule. The description marker
   * (runtime=objectScript) rides along in the persister's `write`, so the macro
   * keeps routing correctly however it was flushed.
   */
  const flushMacro = useCallback(
    async (docId: string): Promise<{ ok: boolean; source: string }> => {
      const outcome = await persister.flush(docId, true);
      const stored = persister.storedSource(docId) ?? sourceRef.current;
      // "ok" means one thing only: the store now holds the text on screen. Ask
      // the outcome type itself rather than re-listing the failing statuses here
      // — a new status added to LivePersistOutcome must not default to success
      // and let Run mount the older stored copy.
      return { ok: !outcomeLeavesBufferUnsaved(outcome), source: stored };
    },
    [persister],
  );

  /**
   * Store the open document, wherever it belongs, and say whether the store now
   * holds the text on screen. QUIET: the outcome handler reports failures, and
   * this is called on every Run/Debug, where a "saved!" line per press would be
   * noise. `handleSave` is the chatty wrapper for the deliberate gesture.
   */
  const flushActiveDocument = useCallback(async (): Promise<{ ok: boolean; source: string }> => {
    if (!activeScript) return { ok: false, source: sourceRef.current };
    // A REFUSED MODULE HAS NOTHING TO FLUSH — a publisher's, or one whose record
    // could not be read. It is read-only here and the persister does not track
    // it, so there is no write to make and none is attempted. `ok` is true so
    // Run and Debug may proceed: both mount the stored record BY ID, which is
    // the publisher's own bytes in the first case and, in the second, whatever
    // is really under that id — the store answers for itself and reports its own
    // read failure rather than this window inventing one. The source reported is
    // always the stored source, never the buffer, so no caller can be told a
    // write happened.
    if (isMacro && macroDoc && macroRefusal !== null) {
      return { ok: true, source: macroDoc.savedSource };
    }
    // A macro routes to the MODULE store, never the object-script store.
    if (isMacro) {
      return flushMacro(activeScript.id);
    }
    // A DRAFT is never written by anything but the Save button itself, and an
    // object script that has not changed must not be re-applied: re-saving it
    // would remount the realm and re-run setup() for nothing.
    if (!isDirty && !isDraft) return { ok: true, source };

    // THE GATE. Compile (TypeScript in, JavaScript out; JavaScript passes
    // through byte for byte) and parse the result in a scratch worker —
    // nothing user-authored executes. A failure here BLOCKS the save: the
    // store feeds the runtime, the source hash behind every capability grant,
    // the transparency panel and .calp distribution, so it must never hold
    // text that cannot run. The author's edit stays in the editor.
    const gate = await gateObjectScriptSave(source, activeScript.name, hostValidateScript);
    if (!gate.ok) {
      reportToConsole(gate.detail, activeScript.id);
      return { ok: false, source };
    }

    // From here on, ONE artifact: the JavaScript that will run.
    const storedSource = gate.javascript;
    const updated = { ...activeScript, source: storedSource };
    try {
      await saveObjectScript(updated);

      // Tell main window to register + remount. What is sent is exactly what was
      // stored: debug instrumentation is applied by the HOST, inside the worker,
      // only for a script the user opened a session on — never baked into the
      // artifact that is persisted, hashed for consent or distributed.
      await emitSaveAndApply(updated);

      setIsDirty(false);
      if (isDraft) {
        // THE EXACT INSTANT A DRAFT GAINS A PERSISTED IDENTITY. The run that
        // WROTE this script was recorded in the main window against the
        // `draft-*` id, because that is the only id that existed then; both ids
        // are in hand here, which is why no wire, seam or main-window change is
        // needed for any of this.
        //
        // Its own try/catch: the script is already stored and mounted at this
        // point, and a failed log write must not be reported to the author as
        // "Failed to save" about a save that succeeded.
        try {
          if (draftDoc) await adoptScriptAuthoringRuns(draftDoc.draft.id, updated.id);
          // Plus any EDIT the author asked for while reviewing the draft and
          // has not decided about: pressing Save is the decision. (A decided
          // run was appended under the draft id by `recordDecision` and is
          // null here, so this cannot double-write; a REFUSED run has
          // `runId: ""`, which the backend refuses, so it is skipped.)
          const pending = aiEditStateFor(activeScriptId ?? "").run;
          if (pending && pending.runId) {
            await appendScriptAuthoringRun(updated.id, {
              ...pending,
              decision: "saved",
              decidedAt: new Date().toISOString(),
            });
          }
        } catch (e) {
          console.warn("[ObjectScriptEditor] Could not carry the authoring history over:", e);
        }
        // The draft has become a real, saved, mounted script — it belongs in
        // the script list now, and the review banner must go away with it.
        setScripts((prev) => [...prev, updated]);
        setDraftDoc(null);
        reportToConsole(
          `AI draft "${updated.name}" saved as a local object script and mounted. ` +
            "It runs from now on; delete it if that is not what you wanted.",
          updated.id,
          "info",
        );
      }
      if (gate.transformed) {
        // Show the author exactly what was stored: the editor must never be
        // out of step with the text that runs, is hashed for consent and is
        // shown to whoever reviews this workbook.
        setSource(storedSource);
        setLanguage("javascript");
        reportToConsole(
          "TypeScript compiled to JavaScript. The stored script is the JavaScript now shown.",
          updated.id,
          "info",
        );
      }
      // Update local state
      setScripts((prev) => prev.map((s) => s.id === updated.id ? updated : s));
      // A save IS a remount, so the session (if any) is now instrumented from
      // this very text: whatever was stale about it no longer is.
      clearSessionStale(updated.id);
      return { ok: true, source: storedSource };
    } catch (e) {
      setConsoleEntries((prev) => [
        ...prev,
        {
          id: ++consoleIdRef.current,
          level: "error",
          message: `Failed to save: ${e}`,
          scriptId: activeScript.id,
          timestamp: Date.now(),
        },
      ]);
      setShowConsole(true);
      return { ok: false, source };
    }
  }, [
    activeScript,
    activeScriptId,
    draftDoc,
    isDirty,
    isDraft,
    isMacro,
    macroDoc,
    macroRefusal,
    flushMacro,
    source,
    reportToConsole,
    clearSessionStale,
  ]);

  /**
   * Ctrl+S / the Save button.
   *
   * For an object script or a draft this is the real save-and-apply. For a
   * MODULE it is only a flush — the edits were already live — so it says that
   * out loud rather than letting the gesture imply that unsaved work existed.
   */
  const handleSave = useCallback(async (): Promise<{ ok: boolean; source: string }> => {
    if (!activeScript) return { ok: false, source: sourceRef.current };
    // CTRL+S ON A PUBLISHER'S MACRO SAVES NOTHING, AND SAYS SO. The flush below
    // is a no-op for it, but a gesture that answers "stored" — the message this
    // branch used to reach, because the persister has no baseline to compare —
    // would tell the user their edit is now what every button runs. It is not,
    // and there is no edit: the buffer is read-only.
    if (isMacro && readOnlyReason !== null) {
      reportToConsole(readOnlyReason, activeScript.id, "info");
      return flushActiveDocument();
    }
    const before = isMacro ? persister.storedSource(activeScript.id) : null;
    const flushed = await flushActiveDocument();
    if (isMacro && flushed.ok) {
      reportToConsole(
        before === flushed.source
          ? `"${activeScript.name}" is already the stored version — module edits are live as you type.`
          : `Macro "${activeScript.name}" stored. Every button that links it runs this version now. ` +
              "Save the workbook to keep it on disk.",
        activeScript.id,
        "info",
      );
    }
    return flushed;
  }, [
    activeScript,
    isMacro,
    readOnlyReason,
    persister,
    flushActiveDocument,
    reportToConsole,
  ]);
  const flushActiveDocumentRef = useRef(flushActiveDocument);
  flushActiveDocumentRef.current = flushActiveDocument;

  // Toggle access level. The backend is authoritative: distributed scripts
  // cannot be escalated, so the local state and the cross-window event are
  // only updated AFTER the save succeeds — otherwise a rejected escalation
  // would still mount with the unlocked API for the session.
  const handleToggleAccess = useCallback(async () => {
    if (!activeScript) return;
    // A MODULE HAS NO TIER SETTING — its tier is a FACT, derived from whether
    // the record carries a package stamp (unlocked for the user's own code,
    // restricted for a module that arrived in an application). There is no
    // per-tier flag in the module store, routing this through the object-script
    // save path would fabricate an object script, and a toggle that appeared to
    // raise a publisher's macro would be a control that lies twice: once when
    // pressed, and again every time the mount ignores it. The chip states the
    // derived tier instead of offering to change it.
    if (isMacro) return;
    // A draft has no backend record, so there is nothing to persist yet —
    // and persisting it HERE would write AI-authored code into the workbook
    // behind a button the author pressed to read a tier label. Keep the choice
    // in the draft; the Save that promotes it carries the tier with it.
    if (isDraft && draftDoc) {
      const nextLevel: ScriptAccessLevel =
        draftDoc.script.accessLevel === "restricted" ? "unlocked" : "restricted";
      setDraftDoc({ ...draftDoc, script: { ...draftDoc.script, accessLevel: nextLevel } });
      return;
    }
    if (activeScript.provenance === "distributed") {
      setConsoleEntries((prev) => [
        ...prev,
        {
          id: ++consoleIdRef.current,
          level: "error",
          message: "Distributed scripts cannot change access level. Copy the script to a local one to take ownership.",
          scriptId: activeScript.id,
          timestamp: Date.now(),
        },
      ]);
      setShowConsole(true);
      return;
    }
    const newLevel: ScriptAccessLevel = activeScript.accessLevel === "restricted" ? "unlocked" : "restricted";
    const updated = { ...activeScript, accessLevel: newLevel };
    try {
      await saveObjectScript(updated);
    } catch (e) {
      setConsoleEntries((prev) => [
        ...prev,
        {
          id: ++consoleIdRef.current,
          level: "error",
          message: `Failed to change access level: ${e}`,
          scriptId: activeScript.id,
          timestamp: Date.now(),
        },
      ]);
      setShowConsole(true);
      return;
    }
    emitToggleAccess(updated).catch(console.error);
    setScripts((prev) => prev.map((s) => s.id === updated.id ? updated : s));
  }, [activeScript, isDraft, isMacro, draftDoc]);

  // Add new primitive script
  const handleAddScript = useCallback(async (objectType: ScriptableObjectType) => {
    // Check if one already exists
    const existing = scripts.find((s) => s.objectType === objectType && !s.instanceId);
    if (existing) {
      setActiveScriptId(existing.id);
      return;
    }

    const id = crypto.randomUUID();
    const name = objectType.charAt(0).toUpperCase() + objectType.slice(1) + " Script";
    const script: ObjectScriptDefinition = {
      id,
      name,
      objectType,
      instanceId: null,
      // The annotation is what makes `context.` complete; a new script starts
      // with it so an author never has to know the trick.
      source: annotateScaffold(getScaffoldTemplate(objectType)),
      accessLevel: "restricted",
    };
    await saveObjectScript(script);
    await emitRegisterScript(script);
    setScripts((prev) => [...prev, script]);
    setActiveScriptId(id);
    setSource(script.source);
    setLanguage("javascript");
    setIsDirty(false);
  }, [scripts]);

  // ---- Debugging (task H1) -------------------------------------------------
  // This window has no script host of its own: the workers live in the main
  // window, so every command travels over the Tauri bridge and the session
  // state is mirrored back.
  useEffect(() => {
    setRemoteDebugTransport();
    injectDebugStyles();
    return subscribeRemoteDebugState();
  }, []);

  // A MODULE macro has no standing mount by design — buttons run it transiently
  // per click — so Debug must be able to ask the host to mount it FROM THE
  // MODULE STORE. Without this the Debug button threw "Cannot debug a script
  // that is not mounted" on every cold open, and only worked after something
  // else had happened to leave a mount behind.
  const debug = useDebugSession(activeScriptId ?? null, { mountFromModuleStore: isMacro });
  const debugRef = useRef(debug);
  debugRef.current = debug;
  const activeScriptIdRef = useRef<string | null>(activeScriptId ?? null);
  activeScriptIdRef.current = activeScriptId ?? null;
  const debugDecorationsRef = useRef<string[]>([]);
  const breakpointLines = debug.breakpointLines;

  const applyDebugDecorations = useCallback(
    (ed: monacoEditor.IStandaloneCodeEditor, decorations: DebugDecoration[]) => {
      debugDecorationsRef.current = ed.deltaDecorations(
        debugDecorationsRef.current,
        decorations.map((d) => ({
          range: new monaco.Range(d.line, 1, d.line, 1),
          options: {
            isWholeLine: true,
            glyphMarginClassName: d.glyphClassName,
            glyphMarginHoverMessage: { value: d.hover },
            className: d.lineClassName,
            linesDecorationsClassName: d.lineClassName ?? "breakpoint-line-decoration",
          },
        })),
      );
    },
    [],
  );

  useEffect(() => {
    const ed = editorRef.current;
    if (ed) applyDebugDecorations(ed, debug.decorations);
  }, [debug.decorations, applyDebugDecorations]);

  /**
   * FLUSH, then answer whether Run/Debug may proceed.
   *
   * Run is never disabled merely because the buffer is unsaved — it stores the
   * buffer first and then runs it. The one thing it must never do is fall back
   * to the older stored copy when the buffer does not compile: that would run
   * code the author is not looking at while their real error sits silently in the
   * editor. So a failed flush REFUSES the gesture, loudly, with the compiler
   * message.
   */
  const flushBeforeRunning = useCallback(
    async (gesture: "Run" | "Debug"): Promise<{ ok: boolean; source: string }> => {
      if (!activeScript) return { ok: false, source: sourceRef.current };
      if (!livePolicyRef.current.persistOnGesture) {
        // An AI draft. Nothing may write it, and Run/Debug are not offered for
        // one — this is the belt to that suspenders.
        return { ok: false, source: sourceRef.current };
      }
      const flushed = await flushActiveDocumentRef.current();
      if (!flushed.ok) {
        reportToConsole(
          `${gesture} did not start: the code in the editor could not be stored (see the error above), ` +
            `and ${gesture} must never quietly fall back to the older stored version. ` +
            `That version is untouched — fix the problem and press ${gesture} again.`,
          activeScript.id,
        );
      }
      return flushed;
    },
    [activeScript, reportToConsole],
  );

  /**
   * Runs this window has STARTED and not yet finished, keyed by script id.
   *
   * F5 IS A MONACO KEYBINDING, AND KEYBINDINGS AUTO-REPEAT. Holding the key —
   * or pressing it twice while the first Run is still flushing the buffer and
   * waiting out a cross-window remount — used to stack two `runAtCursor` calls
   * on one script. Two starts then raced for one session and, worse, for one
   * answer: the debugger's start-refusal record could answer only one of them,
   * and the other reported a run that never happened. The record now carries an
   * attempt id so it can never misattribute an answer; this flag is the other
   * half, and it is the half that stops the second Run from existing at all.
   *
   * `announced` keeps the refusal from becoming its own noise: an auto-repeating
   * key would otherwise print a console line per repeat, so the first suppressed
   * press speaks and the rest of that burst is silent — the run they are asking
   * for is already on its way.
   */
  const runInFlightRef = useRef<Map<string, { announced: boolean }>>(new Map());

  // Run-at-cursor (VBA F5): run the top-level function the cursor is in, through
  // the same fire/exposed-method door the Fire buttons use. Never a wrong-arity
  // call and never a silent no-op — an unresolvable cursor speaks in the console.
  const runFromCursor = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed || !activeScript || isDraft) return;
    if (runBlockedReason) {
      // NEVER SILENTLY. The button is disabled, but F5 is bound in Monaco and
      // reaches here anyway — and a Run key that does nothing at all is the
      // exact silence this window keeps regressing into.
      reportToConsole(runBlockedReason, activeScript.id);
      return;
    }

    // ONE RUN PER SCRIPT AT A TIME. Held for the WHOLE gesture — flush, stale
    // session restart, mount and fire — because every one of those steps is a
    // point where a second press could overtake the first.
    const inFlight = runInFlightRef.current;
    const already = inFlight.get(activeScript.id);
    if (already) {
      if (!already.announced) {
        already.announced = true;
        reportToConsole(
          "A Run is already starting for this script, so this one was ignored rather than " +
            "queued behind it. Wait for it to report, then press Run again.",
          activeScript.id,
          "info",
        );
      }
      return;
    }
    inFlight.set(activeScript.id, { announced: false });

    try {
      const line = ed.getPosition()?.lineNumber ?? 1;

      // 1. WHAT YOU SEE IS WHAT RUNS. The buffer goes to the store before anything
      //    is mounted; a compile failure stops here rather than running the older
      //    stored copy behind the author's back.
      const flushed = await flushBeforeRunning("Run");
      if (!flushed.ok) return;

      // 2. An open session was instrumented from the source as it was when the
      //    session opened, and it OWNS that snapshot. If edits have been stored
      //    since, this Run would fire into the old code.
      if (staleSessionDocsRef.current.includes(activeScript.id)) {
        if (debugRef.current.isPaused) {
          // NEVER remount underneath a paused author: their locals, call stack and
          // position would vanish mid-inspection. Say what is true and let them
          // choose.
          reportToConsole(
            `The debug session is paused at line ${debugRef.current.session?.paused?.line ?? "?"} in the code as it was ` +
              "when the session started, so Run cannot use your newer edits. Your edits ARE stored — " +
              "press Stop (or continue to the end) and Run again to step through them.",
            activeScript.id,
          );
          return;
        }
        reportToConsole(
          "Restarting the debug session so it runs the code you are looking at…",
          activeScript.id,
          "info",
        );
        await stopDebugSessionAndWait(activeScript.id);
        clearSessionStale(activeScript.id);
      }

      // 3. A module macro is mounted from the STORE, by id — the host must never be
      //    handed a body by a caller — which is exactly why step 1 exists.
      //    The cursor is resolved against the text that was stored (identical to
      //    the buffer unless a TypeScript compile rewrote it, in which case the
      //    editor is already showing the stored JavaScript).
      // A throw here is the host refusing (no session, no such trigger, a mount
      // that Script Security blocked). Unhandled it would be an unhandled promise
      // rejection and, on screen, a Run button that did nothing at all — the exact
      // silence this whole feature keeps regressing into. It goes in the console.
      try {
        const outcome = await runAtCursor(activeScript.id, flushed.source, line, {
          mountFromModuleStore: isMacro,
        });
        if (outcome.status === "ran") {
          reportToConsole(`Running ${outcome.functionName}()…`, activeScript.id, "info");
        } else {
          reportToConsole(outcome.message, activeScript.id, "error");
        }
      } catch (e) {
        reportToConsole(
          `Run failed: ${e instanceof Error ? e.message : String(e)}`,
          activeScript.id,
          "error",
        );
      }
    } finally {
      inFlight.delete(activeScript.id);
    }
  }, [
    activeScript,
    isDraft,
    runBlockedReason,
    isMacro,
    reportToConsole,
    flushBeforeRunning,
    clearSessionStale,
  ]);
  const runFromCursorRef = useRef(runFromCursor);
  runFromCursorRef.current = runFromCursor;

  /**
   * Open a debug session on the text in front of the author.
   *
   * A session instruments the source AT MOUNT, so debugging without flushing
   * first would step through the stored copy while the editor showed something
   * else — the same lie Run avoids, with breakpoints landing on the wrong lines.
   */
  const startDebugFlushed = useCallback(
    (options: { pauseOnEntry: boolean }) => {
      void (async () => {
        if (!activeScript) return;
        const flushed = await flushBeforeRunning("Debug");
        if (!flushed.ok) return;
        clearSessionStale(activeScript.id);
        debugRef.current.start(options);
      })();
    },
    [activeScript, flushBeforeRunning, clearSessionStale],
  );

  // A session that has ended cannot be running older code than the store: the
  // warning goes with it, so "stale" can never be a state the user is stuck in.
  useEffect(() => {
    if (activeScriptId && !debug.session) clearSessionStale(activeScriptId);
  }, [debug.session, activeScriptId, clearSessionStale]);

  // A debugger that stops off-screen looks exactly like one that did not stop.
  const pausedLine = debug.session?.paused?.line;
  useEffect(() => {
    const ed = editorRef.current;
    if (ed && pausedLine) {
      ed.revealLineInCenterIfOutsideViewport(pausedLine);
      ed.setPosition({ lineNumber: pausedLine, column: 1 });
    }
  }, [pausedLine]);

  // Monaco mount
  const handleMount: OnMount = useCallback((ed) => {
    editorRef.current = ed;
    // Re-assert this surface's share of the shared language services. Module
    // load order decides who configured Monaco first; mount order decides who
    // configured it LAST, and the merged configuration has to win.
    registerJavascriptLane(monacoTs, objectContextsDts);
    // Warm the compiler chunk in the background so the first save is not the
    // moment it is fetched. Fire-and-forget: mounting never waits on it.
    prefetchScriptTranspiler();
    ed.addAction({
      id: "objectScript.save",
      label: "Save Script",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        void handleSave();
      },
    });
    ed.addAction({
      // VBA F5: when paused, F5 CONTINUES; otherwise it RUNS the function the
      // cursor is in. One key, the mental model VBA users already have.
      id: "objectScript.debug.runOrContinue",
      label: "Run / Continue (F5)",
      keybindings: [monaco.KeyCode.F5],
      run: () => {
        if (debugRef.current.isPaused) debugRef.current.send("continue");
        else void runFromCursorRef.current();
      },
    });
    ed.addAction({
      id: "objectScript.debug.stepOver",
      label: "Debug: Step Over",
      keybindings: [monaco.KeyCode.F10],
      run: () => debugRef.current.send("stepOver"),
    });
    ed.addAction({
      id: "objectScript.debug.stepInto",
      label: "Debug: Step Into",
      keybindings: [monaco.KeyCode.F11],
      run: () => debugRef.current.send("stepInto"),
    });
    ed.addAction({
      id: "objectScript.debug.toggleBreakpoint",
      label: "Debug: Toggle Breakpoint",
      keybindings: [monaco.KeyCode.F9],
      run: (editor) => {
        const line = editor.getPosition()?.lineNumber;
        if (line) debugRef.current.toggleLine(line);
      },
    });

    ed.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        const line = e.target.position?.lineNumber;
        if (line && activeScriptIdRef.current) debugRef.current.toggleLine(line);
      }
    });

    // Keep breakpoints anchored to their statement across edits.
    ed.onDidChangeModelContent((e) => {
      const scriptId = activeScriptIdRef.current;
      if (!scriptId) return;
      for (const change of e.changes) {
        const shift = breakpointShift(change);
        if (shift) shiftBreakpoints(scriptId, shift.fromLine, shift.delta);
      }
    });

    applyDebugDecorations(ed, debugRef.current.decorations);
    ed.focus();
  }, [handleSave, applyDebugDecorations]);

  const handleChange = useCallback(
    (val: string | undefined) => {
      if (val === undefined) return;
      setSource(val);
      setIsDirty(true);
      const docId = activeDocIdRef.current;
      if (!docId) return;
      // THE LIVE PATH. Only kinds whose policy allows an idle write get here —
      // an AI draft never does, and an object script's save is an apply, so it
      // waits for the gesture that asks for one.
      if (!livePolicyRef.current.autoPersistOnIdle) return;
      if (!persister.tracks(docId)) return;
      persister.note(docId, activeNameRef.current, val);
      // THE CHIP MUST NEVER CLAIM WORK THAT DOES NOT EXIST. An edit can land the
      // buffer back on the bytes the store already holds — an undo, a character
      // typed and deleted, a rejected edit reverted by hand — and `note` then
      // correctly arms nothing at all. Announcing "Saving…" for a write that is
      // never going to happen would strand the indicator there permanently,
      // because only a COMPLETED write clears it: the flush behind Ctrl+S and
      // Run also short-circuits on "unchanged" without reporting an outcome. So
      // the state is taken from the persister's own comparison, not from the
      // fact that a keystroke happened.
      const pending = persister.hasUnsavedEdits(docId);
      setIsDirty(pending);
      setLiveStates((prev) => {
        const next: LiveDocState = pending ? { state: "saving" } : { state: "live" };
        return prev[docId]?.state === next.state ? prev : { ...prev, [docId]: next };
      });
    },
    [persister],
  );
  // The designer writes through this same function when Monaco is not mounted.
  handleChangeRef.current = handleChange;

  const handleInsertMethod = useCallback((methodName: string) => {
    if (editorRef.current) {
      const position = editorRef.current.getPosition();
      if (position) {
        editorRef.current.executeEdits("", [
          {
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
            text: methodName,
          },
        ]);
        editorRef.current.focus();
      }
    }
  }, []);

  // Template state
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);

  useEffect(() => {
    listTemplates().then(setTemplates).catch(() => {});
  }, []);

  /**
   * Rename the open script.
   *
   * THE ESCAPE HATCH FOR A NAME NOBODY CHOSE. An AI draft arrives named from the
   * request that produced it, and however good that rule gets it will sometimes
   * be wrong — a heuristic with no way out is a heuristic you have to keep
   * tuning. Offered for a DRAFT too, deliberately: renaming before Save is the
   * cheapest possible fix.
   *
   * IT WRITES `activeScript.source`, THE STORED TEXT. A rename must not be the
   * gesture that saves unsaved edits, and must not discard them either — they
   * stay in the buffer, exactly as they were. `save_object_script` re-derives
   * `declared_capabilities` from that same stored source, so a rename cannot
   * move a capability ceiling.
   *
   * `emitRegisterScript`, NOT `emitSaveAndApply`: save-and-apply unmounts and
   * remounts the script in the main window, re-running `setup()` for what is a
   * cosmetic change. Registering only refreshes the registry, so the name a
   * runtime error quotes is the new one without anything being re-run.
   */
  const handleRename = useCallback(async () => {
    if (!activeScript || isReadOnly || isMacro) return;
    const answer = await promptAsync("Script name:", {
      title: "Rename script",
      defaultValue: activeScript.name,
    });
    const name = (answer ?? "").trim();
    if (!name || name === activeScript.name) return;
    // A DRAFT HAS NO BACKEND RECORD, so there is nothing to save: the new name
    // lives in the draft until the author presses Save as Script.
    if (isDraft && draftDoc) {
      setDraftDoc({ ...draftDoc, script: { ...draftDoc.script, name } });
      return;
    }
    const updated = { ...activeScript, name };
    try {
      await saveObjectScript(updated);
      await emitRegisterScript(updated);
      setScripts((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (e) {
      reportToConsole(`Could not rename the script: ${e}`, activeScript.id);
    }
  }, [activeScript, isReadOnly, isMacro, isDraft, draftDoc, reportToConsole]);

  const handleSaveAsTemplate = useCallback(async () => {
    if (!activeScript) return;
    const name = await promptAsync("Template name:", {
      title: "Save as template",
      defaultValue: `${activeScript.name} Template`,
    });
    if (!name) return;
    // A template is stamped straight into a new script, so it is subject to the
    // same rule: only JavaScript that compiles may be stored.
    const gate = await gateObjectScriptSave(source, activeScript.name, hostValidateScript);
    if (!gate.ok) {
      reportToConsole(gate.detail, activeScript.id);
      return;
    }
    const template = createTemplateFromScript({ ...activeScript, source: gate.javascript }, name);
    await saveTemplate(template);
    setTemplates(await listTemplates());
  }, [activeScript, source, reportToConsole]);

  const handleNewFromTemplate = useCallback(async (templateId: string) => {
    const template = await loadTemplate(templateId);
    if (!template) return;
    const instanceId = activeScript?.instanceId || null;
    const stamped = stampFromTemplate(template, instanceId || crypto.randomUUID());
    // Templates live on disk and can be hand-edited or copied in from
    // elsewhere, so a stamped script goes through the same gate as typed code.
    const gate = await gateObjectScriptSave(stamped.source, stamped.name, hostValidateScript);
    if (!gate.ok) {
      reportToConsole(gate.detail, stamped.id);
      return;
    }
    const created = { ...stamped, source: gate.javascript };
    await saveObjectScript(created);
    await emitRegisterScript(created);
    setScripts((prev) => [...prev, created]);
    setActiveScriptId(created.id);
    setSource(created.source);
    setLanguage("javascript");
    setIsDirty(false);
  }, [activeScript, reportToConsole]);

  const primitiveTypes: ScriptableObjectType[] = ["workbook", "sheet", "cell", "row", "column"];
  const errorCount = consoleEntries.filter((e) => e.level === "error").length;

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      backgroundColor: "#1E1E1E",
      fontFamily: "'Segoe UI', Tahoma, sans-serif",
      fontSize: 12,
    }}>
      {/* Toolbar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px",
        borderBottom: "1px solid #333",
        backgroundColor: "#252526",
        flexShrink: 0,
      }}>
        {/* Script selector */}
        <select
          className="ose-select"
          value={activeScriptId ?? ""}
          onChange={(e) => { void handleSelectScript(e.target.value); }}
        >
          {scripts.length === 0 && !draftDoc && macroDocs.length === 0 && (
            <option value="">No scripts</option>
          )}
          {draftDoc && (
            <option value={draftDoc.script.id}>
              AI DRAFT — {draftDoc.script.name} ({draftDoc.script.objectType})
            </option>
          )}
          {/* Every module script in the workbook, grouped — not just the one this
              window was navigated to. A recorder-marked module is a MACRO; an
              unmarked one is a hand-authored module, and both live here. */}
          {macroDocs.length > 0 && (
            <optgroup label="Macros / modules">
              {/* NO "unsaved" DOT FOR ORDINARY EDITING. A module's edits are
                  live, so a dot on every keystroke would claim work is at risk
                  when none is. The dot now means the one thing that IS true: this
                  module's buffer could NOT be stored (it does not compile, or the
                  store refused it), so what runs is still the older version. */}
              {macroDocs.map((d) => {
                const live = liveStates[d.macroId];
                const notStored = live?.state === "error" || live?.state === "deferred";
                return (
                  <option key={d.macroId} value={d.macroId}>
                    {macroDocOptionLabel(d)}
                    {notStored ? " •" : ""}
                    {d.loadError ? " (unreadable)" : ""}
                  </option>
                );
              })}
            </optgroup>
          )}
          {scripts.length > 0 && (
            <optgroup label="Object scripts">
              {scripts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.objectType}{s.instanceId ? ` #${s.instanceId.slice(0, 8)}` : ""})
                </option>
              ))}
            </optgroup>
          )}
        </select>

        {/* Add script dropdown */}
        <select
          className="ose-select"
          value=""
          onChange={(e) => {
            if (e.target.value) {
              handleAddScript(e.target.value as ScriptableObjectType);
              e.target.value = "";
            }
          }}
        >
          <option value="">+ Add Script...</option>
          {primitiveTypes.map((t) => (
            <option key={t} value={t}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>

        {/* Separator */}
        <div style={{ width: 1, height: 18, backgroundColor: "#444", margin: "0 2px" }} />

        {/* Template controls */}
        {templates.length > 0 && (
          <select
            className="ose-select"
            value=""
            onChange={(e) => {
              if (e.target.value) {
                handleNewFromTemplate(e.target.value);
                e.target.value = "";
              }
            }}
          >
            <option value="">From Template...</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.objectType})
              </option>
            ))}
          </select>
        )}

        {/* Rename. Deliberately a DIFFERENT guard from the Template button
            beside it: a draft IS offered this, because an AI draft arrives
            named after the request that produced it and renaming before Save is
            the cheapest fix when that name is wrong. A distributed script is
            read-only here, and a macro is named in the module store. */}
        {activeScript && !isReadOnly && !isMacro && (
          <button
            className="ose-btn"
            data-testid="script-rename"
            onClick={() => void handleRename()}
            title="Give this script a different name"
          >
            Rename
          </button>
        )}

        {/* Templates are auto-applied to newly created components, so an
            AI draft must become a script the user approved BEFORE it can be
            stamped into one. Save it first. */}
        {activeScript && !isDraft && !isMacro && (
          <button className="ose-btn" onClick={handleSaveAsTemplate} title="Save as reusable template">
            <IconTemplate /> Template
          </button>
        )}

        <div style={{ flex: 1 }} />

        {/* Right side */}
        {activeScript && !isReadOnly && (
          <button
            className="ose-btn"
            onClick={() => setLanguage((l) => (l === "typescript" ? "javascript" : "typescript"))}
            title={
              language === "typescript"
                ? "Authoring in TypeScript: type annotations are checked here and compiled to JavaScript when you save. The stored script is always the JavaScript."
                : "Authoring in JavaScript with JSDoc types. Switch to TypeScript to use real type annotations (compiled on save)."
            }
          >
            {language === "typescript" ? "TS" : "JS"}
          </button>
        )}

        {activeScript && !isMacro && (
          <button className="ose-btn" onClick={handleToggleAccess}
            title={`Access level: ${activeScript.accessLevel}. Click to toggle.`}>
            {activeScript.accessLevel === "restricted" ? <><IconLock /> Restricted</> : <><IconUnlock /> Unlocked</>}
          </button>
        )}
        {/* THE TIER THE RUNTIME WILL ACTUALLY GIVE IT. Derived in
            `macroDocFromRecord` from the record's own package stamp, not
            written here: a distributed module is mounted RESTRICTED by
            `hostStartModuleScriptDebugSession` and by `runObjectScriptOnce`,
            and this window used to say "unlocked" for every macro regardless —
            a promise the runtime refuses to keep. There is no toggle: for a
            module the tier is a fact about the record, not a setting. */}
        {activeScript && isMacro && macroDoc && (
          <span
            className="ose-btn"
            data-testid="macro-tier-chip"
            data-macro-tier={activeScript.accessLevel}
            // WHAT THIS WINDOW HAS ESTABLISHED — three answers, not two. An
            // unreadable record answers nothing about its origin, and the chip
            // used to render that silence as "A macro you wrote": the safe
            // answer, asserted from no evidence, on the one control whose job is
            // to say whose code this is.
            data-macro-provenance={macroProvenanceKnowledge(macroDoc).kind}
            style={{ cursor: "default", opacity: 0.85 }}
            title={macroTierChipTitle(macroProvenanceKnowledge(macroDoc))}
          >
            {activeScript.accessLevel === "restricted" ? <IconLock /> : <IconUnlock />}
            {macroTierChipLabel(macroProvenanceKnowledge(macroDoc), activeScript.accessLevel)}
          </span>
        )}

        <div style={{ width: 1, height: 18, backgroundColor: "#444", margin: "0 2px" }} />

        <button className="ose-btn" onClick={() => setShowConsole(!showConsole)}
          style={errorCount > 0 && !showConsole ? { color: "#F48771" } : undefined}>
          <IconTerminal /> Console
          {errorCount > 0 && <span style={{
            background: "#D13438", color: "#fff", borderRadius: 8,
            padding: "0 5px", fontSize: 10, fontWeight: 600, marginLeft: 2,
          }}>{errorCount}</span>}
        </button>

        {/* Design form. The visual designer edits the `// #region Form layout`
            block IN THIS BUFFER — there is no second stored layout — so the
            two views never disagree: what the designer writes is what the code
            tab shows, and code typed in the code tab is what the designer
            reads when it opens. Offered for a distributed script too, in
            read-only mode: looking at a layout is always allowed. */}
        {activeScript && isFormScript && (
          <button
            className="ose-btn"
            data-testid="script-form-design-action"
            aria-pressed={designing}
            onClick={() => setDesigning((v) => !v)}
            style={designing ? { color: "#9CDCFE" } : undefined}
            title={
              designing
                ? "Back to the code. The designer wrote its changes straight into it."
                : "Lay this form out visually. Every change is written into the layout block in this script."
            }
          >
            <IconTemplate /> {designing ? "Code" : "Design form"}
          </button>
        )}

        {/* Preview form. ONLY for a form script: the code on screen is run in
            the main window's preview realm against a copy of the active sheet
            and its layout painted in a preview dialog there. Nothing is saved
            or written, so it is offered for a draft and a distributed script
            too — looking is always allowed. */}
        {activeScript && isFormScript && (
          <button
            className="ose-btn"
            data-testid="script-form-preview-action"
            onClick={() => void handlePreviewForm()}
            disabled={formPreview.phase === "running"}
            style={formPreview.phase === "shown" ? { color: "#9CDCFE" } : undefined}
            title="Show this form as it would look, from the code on screen. Nothing is saved or written."
          >
            <ActivityDot
              status={
                formPreview.phase === "running"
                  ? "running"
                  : formPreview.phase === "shown"
                    ? "done"
                    : formPreview.phase === "failed"
                      ? "failed"
                      : "idle"
              }
              size={6}
            />
            Preview form
          </button>
        )}

        {/* Edit with AI. Offered for every document kind INCLUDING a recorded
            macro — a macro is the case where hand-editing is most tedious and
            AI help is worth the most. Never for a distributed script, which is
            read-only in this window. */}
        {activeScript && !isReadOnly && (
          <button
            className="ose-btn"
            data-testid="ai-edit-toggle"
            onClick={() => setShowAiEdit((v) => !v)}
            style={
              aiEdit.phase === "running" || aiEdit.phase === "proposed"
                ? { color: "#9CDCFE" }
                : undefined
            }
            title="Describe a change in words; review a diff before anything is written"
          >
            <ActivityDot
              status={
                aiEdit.phase === "running"
                  ? "running"
                  : aiEdit.phase === "proposed"
                    ? "done"
                    : aiEdit.phase === "error"
                      ? "failed"
                      : "idle"
              }
              size={6}
            />
            Edit with AI
          </button>
        )}

        {/* How this script was written. The badge counts what THIS window knows:
            the undecided proposal on screen always counts, and the persisted
            runs are read when the panel opens rather than on every window load —
            an ordinary editing session never asks for them. */}
        {activeScript && (
          <button
            className="ose-btn"
            data-testid="script-history-toggle"
            onClick={() => void openHistory()}
            title="Read what was asked, what the model replied, and what was decided"
          >
            History
            {historyRuns.length + (aiEdit.run ? 1 : 0) > 0 && (
              <span
                style={{
                  background: "#3C3C3C",
                  color: "#D4D4D4",
                  borderRadius: 8,
                  padding: "0 5px",
                  fontSize: 10,
                  fontWeight: 600,
                  marginLeft: 4,
                }}
              >
                {historyRuns.length + (aiEdit.run ? 1 : 0)}
              </span>
            )}
          </button>
        )}

        <button className="ose-btn" onClick={() => setShowSidebar(!showSidebar)}>
          <IconBook /> Docs
        </button>

        <div style={{ width: 1, height: 18, backgroundColor: "#444", margin: "0 2px" }} />

        {/* Step debugging. Only for an APPLIED script: a session instruments
            the source at mount, so there has to be a mount. A draft has none —
            and offering "run it" next to unreviewed AI code would be the one
            control this window must not have. */}
        {activeScript && !isDraft && (
          <DebugToolbar
            state={debug}
            buttonClassName="ose-btn"
            onRun={() => void runFromCursor()}
            onStart={startDebugFlushed}
            // NEITHER RUN NOR DEBUG IS EVER DISABLED BY AN UNSAVED BUFFER. Both
            // flush first and then run what the author is looking at, which is
            // the whole point of the change: in the VBE you never press Save
            // before you press F5. The only thing that still disables Run is a
            // distributed OBJECT SCRIPT — a distributed module is mounted from
            // the store at the restricted tier and reads/steps exactly as a
            // button click runs it, so read-only does not mean unrunnable.
            runDisabled={runBlockedReason !== null}
            runDisabledTitle={runBlockedReason ?? undefined}
          />
        )}

        {activeScript && !isDraft && breakpointLines.length > 0 && !debug.session && (
          <button
            className="ose-btn"
            onClick={() => activeScriptId && clearBreakpoints(activeScriptId)}
            title={`Remove ${breakpointLines.length} breakpoint(s) from this script`}
          >
            Clear {breakpointLines.length} BP
          </button>
        )}

        <div style={{ width: 1, height: 18, backgroundColor: "#444", margin: "0 2px" }} />

        {/* THE SAVE AFFORDANCE.
            A module has no Save button, exactly as a VBE module has none: its
            edits are already live, and a button offering to "save" them would
            state the opposite of what is true. What replaces it is a quiet
            indicator of the ONE thing the author cannot otherwise know — whether
            the store currently holds what they are looking at. Ctrl+S still
            flushes (and says so), for the hand that will press it anyway.
            An OBJECT SCRIPT keeps its button, because pressing it does something
            an edit does not: it remounts the script and re-runs setup().
            An AI DRAFT keeps its button, because only a human pressing it may
            turn AI-authored code into a real script. */}
        {activeScript && isMacro ? (
          <span
            className="ose-btn"
            data-testid="module-live-indicator"
            data-live-state={activeLive?.state ?? "live"}
            style={{
              cursor: "default",
              color:
                activeLive?.state === "error"
                  ? "#F48771"
                  : activeLive?.state === "deferred"
                    ? "#CCA700"
                    : activeLive?.state === "saving"
                      ? "#CCC"
                      : activeLive?.state === "readOnly"
                        ? "#CCC"
                        : "#89D185",
            }}
            title={
              activeLive?.state === "error"
                ? `${activeLive.message}\nThe stored module is unchanged — anything that runs this macro still runs the last version that compiled.`
                : activeLive?.state === "deferred"
                  ? activeLive.message
                  : activeLive?.state === "readOnly"
                    ? (readOnlyReason ?? "")
                    : `${livePolicy.rationale}\nCtrl+S stores it immediately; Run and Debug store it before they run.`
            }
          >
            <IconSave />
            {liveStateLabel(activeLive)}
          </span>
        ) : (
          <button className="ose-btn primary" onClick={() => void handleSave()}
            // A draft has never been saved, so it is savable the moment it
            // arrives — requiring an edit first would leave the only way to
            // accept AI code being to change it.
            disabled={(!isDirty && !isDraft) || isReadOnly}
            title={
              isReadOnly
                ? "Distributed scripts are read-only"
                : isDraft
                  ? "Save this AI draft as a real object script and mount it (Ctrl+S)"
                  : "Save and apply (Ctrl+S)"
            }>
            <IconSave />
            {isReadOnly ? "Read Only" : isDraft ? "Save as Script" : "Save & Apply"}
          </button>
        )}
      </div>

      {/* Preview form status. Inline beside the action, never a dialog: "no
          layout defined", a declined run, a held modal slot and a compile
          error are notes the author reads while they keep editing. */}
      {activeScript && isFormScript && formPreview.phase !== "idle" && (
        <div
          data-testid="script-form-preview-status"
          data-phase={formPreview.phase}
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 12px",
            backgroundColor: formPreview.phase === "failed" ? "#4A2B2B" : "#2B3A4A",
            borderBottom: "1px solid #444",
            color: formPreview.phase === "failed" ? "#F48771" : "#9CDCFE",
            fontSize: 11,
            lineHeight: "1.5",
            flexShrink: 0,
          }}
        >
          <span style={{ flex: 1 }}>{formPreview.message}</span>
          {formPreview.phase !== "running" && (
            <button
              className="ose-btn"
              data-testid="script-form-preview-dismiss"
              onClick={() => activeScriptId && dismissFormPreviewStatus(activeScriptId)}
              title="Hide this note"
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* AN OPEN DEBUG SESSION IS NOT HOT-SWAPPED BY AN EDIT.
          The realm was instrumented from the source as it stood when the session
          opened and it keeps that snapshot for its whole life — remounting it
          underneath a paused author would throw away the locals, the call stack
          and the position they are reading. So the edit is stored, the session
          keeps running the older code, and the difference is said out loud
          rather than left for the user to discover by stepping through a line
          that is no longer there. */}
      {activeSessionStale && debug.session && (
        <div
          data-testid="stale-session-banner"
          style={{
            padding: "8px 12px",
            backgroundColor: "#3A3320",
            borderBottom: "1px solid #6A5A2A",
            color: "#FFD666",
            fontSize: 11,
            lineHeight: "1.5",
            flexShrink: 0,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            This debug session is running the earlier version of the code
          </div>
          <div>
            Your edits are stored — every button that links this macro already runs them. The open
            session cannot take them: it was instrumented when it started, and replacing it now
            would discard {debug.isPaused ? "the pause you are inspecting" : "the session"}.{" "}
            {debug.isPaused
              ? "Press Stop when you are done here; the next Run or Debug picks up your edits."
              : "Run restarts the session for you, or press Stop and Debug again."}
          </div>
        </div>
      )}

      {/* The AI edit composer. Opened from the toolbar, and forced open
          whenever a run is live or has failed, so a result can never arrive
          somewhere the author cannot see it. */}
      {activeScript && !isReadOnly && (showAiEdit || aiEdit.phase === "running" || aiEdit.phase === "error") && (
        <AiEditStrip
          state={aiEdit}
          documentName={activeScript.name}
          onAsk={handleAskAi}
          onStop={() => activeScriptId && cancelAiEdit(activeScriptId)}
          onDismissError={handleRejectAi}
          onClose={() => setShowAiEdit(false)}
        />
      )}

      {/* AI draft review banner. The MCP tool tells the agent its draft is
          "queued for the user to review"; this is what the user is shown, and
          it must state the two facts the agent cannot: nothing was saved, and
          nothing has run. */}
      {isDraft && draftDoc && (
        <div
          data-testid="ai-draft-banner"
          style={{
            padding: "8px 12px",
            backgroundColor: "#4A3B00",
            borderBottom: "1px solid #7A6200",
            color: "#FFD666",
            fontSize: 11,
            lineHeight: "1.5",
            flexShrink: 0,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            AI draft — not saved, not mounted
          </div>
          <div>
            An AI tool wrote this for <strong>{draftDoc.draft.objectType}</strong>
            {draftDoc.draft.instanceId ? ` #${draftDoc.draft.instanceId.slice(0, 8)}` : ""}. None of
            it has run. It exists only in this window until you press{" "}
            <strong>Save as Script</strong>, which stores it, mounts it and lets it run from then
            on.
          </div>
          <div style={{ marginTop: 2 }}>
            Declares:{" "}
            {draftDoc.draft.declaredCapabilities.length === 0
              ? "no capabilities (grid only)"
              : draftDoc.draft.declaredCapabilities.join(", ")}
            {" · "}Tier: {draftDoc.script.accessLevel}
          </div>
          {/* WHAT IT ASKS FOR THAT IT DOES NOT APPEAR TO USE. Never a rejection
              — the scanner cannot follow computed access, so the declaration may
              well be right — but the reviewer grants exactly these by pressing
              Save, and until now the banner said only what was asked for. */}
          {unobservedCaps.length > 0 && (
            <div data-testid="ai-draft-unobserved" style={{ marginTop: 2 }}>
              Declared but not used anywhere this scan can see:{" "}
              <strong>{unobservedCaps.join(", ")}</strong>. Read the code before granting it.
            </div>
          )}
          {draftDoc.draft.description && (
            <div style={{ marginTop: 2, opacity: 0.85 }}>{draftDoc.draft.description}</div>
          )}
        </div>
      )}

      {/* The decision. Rendered off the phase alone: a proposal that arrives
          while the author is in another script waits, and opens when they come
          back to it — rather than being lost or hijacking the window. */}
      {activeScript && aiEdit.phase === "proposed" && (
        <AiEditDiff
          key={activeScriptId ?? "none"}
          documentName={activeScript.name}
          documentKind={docKind}
          original={source}
          proposed={aiEdit.proposal}
          language={language}
          summary={aiEdit.summary}
          run={aiEdit.run}
          instruction={aiEdit.instruction}
          // `original={source}` above is deliberately the CURRENT buffer, which
          // is what makes these two separate, meaningful inputs: "the model
          // returned it unchanged" is measured against what it was HANDED, and
          // "accepting changes nothing" against what is on screen NOW.
          askedAgainst={aiEdit.askedAgainst}
          unchangedFallback={aiEdit.unchanged}
          unexercisedHooks={aiEdit.unexercisedHooks}
          onAccept={handleAcceptAi}
          onReject={handleRejectAi}
        />
      )}

      {/* How this script was written. The LIVE run is passed alongside the
          persisted ones: the author was looking at an undecided proposal when
          they went looking for the reasoning, and an EDIT run is not persisted
          until a decision, so a panel that read only the backend would show an
          empty page at exactly that moment. (A draft's CREATE run is already
          on the backend under its draft-* id.) */}
      {showHistory && activeScript && (
        <ScriptHistoryPanel
          scriptName={activeScript.name}
          liveRun={aiEdit.run}
          runs={historyRuns}
          loading={historyLoading}
          onClear={() => void clearHistory()}
          onClose={() => setShowHistory(false)}
        />
      )}

      {/* WHOSE CODE IS ON SCREEN. A `.calp` may ship module scripts, and they
          list in this window beside the user's own; until this banner, a
          publisher's macro was indistinguishable from one the user recorded
          themselves — which is the decision the whole consent model rests on.
          It states the three facts this window can establish and the user
          cannot: where it came from, the tier it will actually be mounted at,
          and what an edit here does and does not change. */}
      {macroDoc && macroDoc.sourcePackage && (
        <div
          data-testid="macro-provenance-banner"
          data-macro-source-package={macroDoc.sourcePackage}
          style={{
            padding: "8px 12px",
            backgroundColor: "#3A3320",
            borderBottom: "1px solid #6A5A2A",
            color: "#FFD666",
            fontSize: 11,
            lineHeight: "1.5",
            flexShrink: 0,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            From the application "{macroDoc.sourcePackage}" — you did not write this
          </div>
          <div>
            Run and Debug here mount it <strong>from the module store, by id</strong> — the
            publisher's stored code, never the buffer — at the <strong>restricted</strong>{" "}
            tier: <code>context.api</code> is null, and it can use a capability only through
            that application's consent record, never the local prompt. That is the same mount
            a button on the grid uses, so what you step through is what runs.
          </div>
          {/* EVERY SENTENCE TRUE OF WHAT THE CODE DOES. This paragraph used to
              say editing here kept the stamp and that the runtime would then
              refuse the macro — a refusal this window's Run route does not
              perform, describing an edit that (because `save_script` makes the
              stamp sticky) actually BRICKED the macro against the Rust consent
              gate. The window no longer makes that edit at all, so the paragraph
              says what it does instead, and names a remedy that is still armed
              because the stored record was never touched. */}
          <div style={{ marginTop: 2, opacity: 0.9 }}>
            The editor is <strong>read-only</strong> for it: nothing you do here can change
            the publisher's macro, and nothing is written back. That is deliberate — an edit
            stored under the application's name would no longer match the code you consented
            to, and the macro could never run again. To adapt it, open Developer ▸ Macros…,
            edit the text there and press <strong>"Save as my copy"</strong>: you get a local
            macro of your own, which this window edits freely, and the application's macro is
            left exactly as it arrived.
          </div>
        </div>
      )}

      {/* A module the store could not give us. The editor still opens ON it —
          hiding it would leave a blank window with no explanation — but it is
          READ-ONLY, and this says so. It used to say "they will fail until this
          is saved", which invited the user to press Ctrl+S on a record nobody
          had read: the buffer would have been written over a stored module of
          unknown ownership, destroying the user's real macro if it was theirs
          and bricking a consented one if it was a publisher's. */}
      {macroDoc && macroDoc.loadError && (
        <div
          data-testid="macro-load-error-banner"
          style={{
            padding: "8px 12px",
            backgroundColor: "#3A2323",
            borderBottom: "1px solid #6A3A3A",
            color: "#FF9B9B",
            fontSize: 11,
            lineHeight: "1.5",
            flexShrink: 0,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            "{macroDoc.script.name}" could not be read from this workbook
          </div>
          <div>{macroDoc.loadError}</div>
          <div style={{ marginTop: 2, opacity: 0.85 }}>
            This document is <strong>read-only</strong> while that is true: nothing here —
            not typing, not Ctrl+S, not closing the window — writes over a record this
            window could not read, because it cannot tell whether that record is yours or
            arrived in an application. Run and Debug still mount whatever the store holds
            under this id, and will report the same failure. Reopen the workbook to try the
            read again, or use Developer ▸ Macros… to save this text as a macro of your own.
          </div>
        </div>
      )}

      {/* Main area */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Editor + Console */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {/* THE DESIGNER SITS BESIDE MONACO, NOT INSTEAD OF IT. Unmounting the
              editor to show the designer would dispose its model — and with it
              the undo stack a designer edit is pushed onto, the breakpoints and
              the cursor. So the code view is HIDDEN while the designer is open,
              which is also what lets `handleDesignerSource` route its write
              through `executeEdits`. */}
          {designing && activeScript && isFormScript && (
            <div style={{ flex: 1, minHeight: 0 }} data-testid="form-designer-host">
              <FormDesignerPanel
                source={source}
                onSourceChange={handleDesignerSource}
                onEditAsCode={() => {
                  setDesigning(false);
                  editorRef.current?.focus();
                }}
                fileLabel={activeScript.name}
                readOnly={isReadOnly}
                readOnlyReason={readOnlyReason ?? undefined}
              />
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0, display: designing ? "none" : undefined }}>
            <Editor
              height="100%"
              language={language}
              // The model NAME decides how Monaco's worker parses the text
              // (tsWorker.getScriptKind reads the extension), so the path —
              // not the `language` prop alone — is what makes TypeScript
              // annotations legal. One model per script keeps the squiggles
              // attached to the script in front of the author.
              path={objectScriptModelPath(activeScriptId, language)}
              theme="vs-dark"
              value={source}
              onChange={handleChange}
              onMount={handleMount}
              options={{
                fontSize: 13,
                fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
                lineNumbers: "on",
                glyphMargin: true,
                folding: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                wordWrap: "on",
                quickSuggestions: true,
                suggestOnTriggerCharacters: true,
                parameterHints: { enabled: true },
                hover: { enabled: true },
                fixedOverflowWidgets: true,
                matchBrackets: "always",
                readOnly: isReadOnly,
                renderLineHighlight: "all",
                cursorBlinking: "smooth",
                smoothScrolling: true,
                padding: { top: 8 },
              }}
            />
          </div>

          {/* Debugger: locals, call stack, and why a breakpoint did not stop */}
          <DebugPanel
            state={debug}
            onRevealLine={(line) => {
              const ed = editorRef.current;
              if (!ed) return;
              ed.revealLineInCenter(line);
              ed.setPosition({ lineNumber: line, column: 1 });
              ed.focus();
            }}
          />

          {/* Console */}
          {showConsole && (
            <>
              <div className="ose-splitter" onMouseDown={onConsoleSplitterMouseDown} />
              <div style={{ height: consoleHeight, display: "flex", flexDirection: "column", flexShrink: 0 }}>
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "3px 10px", backgroundColor: "#252526",
                  borderBottom: "1px solid #333", fontSize: 11, color: "#999", flexShrink: 0,
                }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ textTransform: "uppercase", fontWeight: 600, fontSize: 10, letterSpacing: "0.5px" }}>
                      Console
                    </span>
                    {errorCount > 0 && (
                      <span style={{ color: "#F48771", fontSize: 10 }}>
                        {errorCount} error{errorCount !== 1 && "s"}
                      </span>
                    )}
                  </span>
                  <button className="ose-btn" style={{ padding: "1px 6px", fontSize: 10 }}
                    onClick={() => setConsoleEntries([])}>
                    Clear
                  </button>
                </div>
                <div style={{
                  flex: 1, overflow: "auto", padding: "6px 12px",
                  fontFamily: "'Cascadia Code', Consolas, monospace",
                  fontSize: 11, lineHeight: "1.6", backgroundColor: "#1E1E1E", color: "#D4D4D4",
                }}>
                  {consoleEntries.length === 0 && (
                    <div style={{ color: "#555", fontStyle: "italic" }}>
                      Script output will appear here...
                    </div>
                  )}
                  {consoleEntries.map((entry) => (
                    <div key={entry.id} className="ose-console-line"
                      style={entry.level === "error" ? { color: "#F48771" }
                        : entry.level === "warn" ? { color: "#CCA700" } : undefined}>
                      <span style={{ color: "#555", marginRight: 8, fontSize: 10 }}>
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                      {entry.message}
                    </div>
                  ))}
                  <div ref={consoleEndRef} />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Sidebar */}
        {showSidebar && (
          <div style={{
            width: 230, borderLeft: "1px solid #333", backgroundColor: "#252526",
            overflowY: "auto", padding: "10px 12px", fontSize: 11,
          }}>
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8, color: "#ccc",
              display: "flex", alignItems: "center", gap: 6 }}>
              <IconBook /> API Reference
            </div>
            {activeScript && (
              <div style={{
                fontSize: 10, color: "#569CD6", marginBottom: 12,
                fontFamily: "'Cascadia Code', Consolas, monospace",
                padding: "3px 6px", background: "rgba(86,156,214,0.08)",
                borderRadius: 3, display: "inline-block",
              }}>
                {contextInterfaceNameFor(activeScript.objectType, objectContextsDts)}
              </div>
            )}
            {docs.map((cat) => (
              <div key={cat.category}>
                <div style={{
                  fontWeight: 600, fontSize: 10, color: "#888",
                  marginBottom: 4, marginTop: 12, textTransform: "uppercase", letterSpacing: "0.5px",
                }}>
                  {cat.category}
                </div>
                {cat.methods.map((m) => (
                  <div key={m.name}>
                    <div className="ose-sidebar-method"
                      onClick={() => handleInsertMethod(m.name)}
                      title={`Click to insert "${m.name}" at cursor`}>
                      {m.signature}
                    </div>
                    <div style={{ fontSize: 10, color: "#666", marginBottom: 6, marginLeft: 6, lineHeight: "1.4" }}>
                      {m.description}
                    </div>
                  </div>
                ))}
              </div>
            ))}
            {docs.length === 0 && (
              <div style={{ color: "#555", fontSize: 11, fontStyle: "italic", marginTop: 16 }}>
                No script selected
              </div>
            )}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "3px 12px", borderTop: "1px solid #333",
        backgroundColor: "#007ACC", fontSize: 11, color: "#fff", flexShrink: 0, height: 22,
      }}>
        <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {activeScript
            ? <>
                <span>{activeScript.objectType}</span>
                <span style={{ opacity: 0.7 }}>|</span>
                <span>{activeScript.accessLevel}</span>
                {isDraft && <><span style={{ opacity: 0.7 }}>|</span><span>AI draft (not saved, not mounted)</span></>}
                {isReadOnly && <><span style={{ opacity: 0.7 }}>|</span><span>distributed (read-only)</span></>}
                {activeScript.packageName && <><span style={{ opacity: 0.7 }}>|</span><span>from "{activeScript.packageName}"</span></>}
              </>
            : <span>No script selected</span>}
        </span>
        <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {errorCount > 0 && (
            <span style={{ background: "rgba(255,255,255,0.15)", padding: "0 6px", borderRadius: 3 }}>
              {errorCount} error{errorCount !== 1 && "s"}
            </span>
          )}
          {/* The status bar must never imply that unsaved edits exist when they
              are already live. For a module it reports the LIVE state; for the
              kinds that really do hold unsaved work, it still says so. */}
          <span data-testid="editor-save-state">
            {isDraft
              ? "Never saved"
              : isMacro
                ? activeLive?.state === "error"
                  ? "Not stored — does not compile"
                  : activeLive?.state === "deferred"
                    ? "Not stored — Ctrl+S to compile"
                    : activeLive?.state === "saving"
                      ? "Saving…"
                      : activeLive?.state === "readOnly"
                        ? "Read-only — the application's macro"
                        : "Live"
                : isDirty
                  ? "Modified"
                  : "Saved"}
          </span>
        </span>
      </div>
    </div>
  );
}

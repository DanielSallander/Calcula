//! FILENAME: app/src/api/objectScriptBackend.ts
// PURPOSE: Tauri command wrappers for object script CRUD operations.
// CONTEXT: Used by the ScriptableObjects extension to persist scripts in the backend.

import { invoke } from "@tauri-apps/api/core";
import type {
  ObjectScriptDefinition,
  ScriptableObjectType,
  ScriptAccessLevel,
  ScriptProvenance,
} from "./scriptableObjects";
import type { AuthoringRun } from "./scriptHost/authoringRun";

// ============================================================================
// Backend API Types (match Rust serialization)
// ============================================================================

interface ObjectScriptSummary {
  id: string;
  name: string;
  objectType: string;
  instanceId: string | null;
  accessLevel: string;
  provenance?: string | null;
  packageName?: string | null;
  packageVersion?: string | null;
}

interface ObjectScriptData {
  id: string;
  name: string;
  objectType: string;
  instanceId: string | null;
  source: string;
  accessLevel: string;
  description: string | null;
  /** "local" | "distributed" — read-only; the backend preserves stored provenance on save. */
  provenance?: string | null;
  packageName?: string | null;
  /** For distributed scripts: the resolved package version. Read-only over IPC. */
  packageVersion?: string | null;
  /** The R19 declared-capability ceiling (authoritative). Read-only over IPC. */
  declaredCapabilities?: string[];
}

// ============================================================================
// API Functions
// ============================================================================

/** List all object scripts (lightweight summaries). */
export async function listObjectScripts(): Promise<ObjectScriptSummary[]> {
  return invoke<ObjectScriptSummary[]>("list_object_scripts");
}

/** Get a single object script by ID (includes source code). */
export async function getObjectScript(id: string): Promise<ObjectScriptData> {
  return invoke<ObjectScriptData>("get_object_script", { id });
}

/** Get the object script for a specific object type and optional instance ID. */
export async function getObjectScriptByTarget(
  objectType: string,
  instanceId?: string | null,
): Promise<ObjectScriptData | null> {
  return invoke<ObjectScriptData | null>("get_object_script_by_target", {
    objectType,
    instanceId: instanceId ?? null,
  });
}

/** Save (create or update) an object script. */
export async function saveObjectScript(script: ObjectScriptDefinition): Promise<void> {
  const data: ObjectScriptData = {
    id: script.id,
    name: script.name,
    objectType: script.objectType,
    instanceId: script.instanceId,
    source: script.source,
    accessLevel: script.accessLevel,
    description: script.description ?? null,
    // Sent for type completeness; the backend ignores these and preserves
    // the stored provenance (anti-laundering guard).
    provenance: script.provenance ?? null,
    packageName: script.packageName ?? null,
    packageVersion: script.packageVersion ?? null,
  };
  return invoke<void>("save_object_script", { script: data });
}

/** Delete an object script by ID. */
export async function deleteObjectScript(id: string): Promise<void> {
  return invoke<void>("delete_object_script", { id });
}

/** Delete all object scripts for a component instance (when the component is deleted). */
export async function deleteObjectScriptsForInstance(instanceId: string): Promise<void> {
  return invoke<void>("delete_object_scripts_for_instance", { instanceId });
}

/** Load all object scripts from backend and convert to ObjectScriptDefinition format. */
export async function loadAllObjectScripts(): Promise<ObjectScriptDefinition[]> {
  const summaries = await listObjectScripts();
  const scripts: ObjectScriptDefinition[] = [];

  for (const summary of summaries) {
    try {
      const data = await getObjectScript(summary.id);
      scripts.push({
        id: data.id,
        name: data.name,
        objectType: data.objectType as ScriptableObjectType,
        instanceId: data.instanceId,
        source: data.source,
        accessLevel: data.accessLevel as ScriptAccessLevel,
        description: data.description ?? undefined,
        provenance: (data.provenance as ScriptProvenance | null) ?? undefined,
        packageName: data.packageName ?? undefined,
        packageVersion: data.packageVersion ?? undefined,
        // The backend already filtered to recognized capability ids, so the
        // cast is safe; the broker re-filters defensively when building the
        // ceiling set.
        declaredCapabilities: (data.declaredCapabilities ?? undefined) as
          | ObjectScriptDefinition["declaredCapabilities"],
      });
    } catch (e) {
      console.warn(`[ObjectScripts] Failed to load script "${summary.name}":`, e);
    }
  }

  return scripts;
}

// ============================================================================
// AI authoring transcript
// ============================================================================
//
// The persisted half of "what was asked, what the model said, what I decided".
// Four commands, all window-guarded to MAIN_AND_OBJECT_SCRIPT_EDITOR, because
// the two windows that make an authoring decision are exactly those two.
//
// NOTHING REACHES THE FILE EXCEPT THROUGH A DECISION. For an EDIT,
// `appendScriptAuthoringRun` is called only when a human presses Accept, Reject
// or Save — the `objscript:ai-edit-result` Tauri event channel itself never
// triggers a write, because an event channel must not be able to dirty the
// workbook on its own. A CREATE run is appended once, under its `draft-*` id,
// at the moment the drafted script is queued for review (authorRunner.ts), with
// `decision` unset; that bucket is SESSION-ONLY — the save path filters
// `draft-*` buckets out of the archive — and Save re-keys it via
// `adoptScriptAuthoringRuns`, which is what makes it persistent (the create run
// never gains a decision: adoption is the record that it was kept). Save
// separately appends, decided as "saved", any edit run still pending on the
// draft. The backend enforces replay-safety: a second append of the same
// `runId` REPLACES the stored run, because `replayAiEditResults` re-sends on
// every editor open and a client-side dedupe cannot survive a reopened window.

/** Every run recorded against one script id (or a `draft-*` id). A pure read. */
export async function getScriptAuthoringRuns(scriptId: string): Promise<AuthoringRun[]> {
  return invoke<AuthoringRun[]>("get_script_authoring_runs", { scriptId });
}

/**
 * Record ONE run — one caller, one write point per run: the author's decision
 * for an EDIT, draft delivery (decision unset, under the `draft-*` id) for a
 * CREATE.
 *
 * Singular on purpose: one call writes one run. A plural form would invite a
 * caller to batch runs it never individually decided about or delivered, which
 * is the fiction the backend's id check exists to refuse.
 */
export async function appendScriptAuthoringRun(
  scriptId: string,
  run: AuthoringRun,
): Promise<void> {
  return invoke<void>("append_script_authoring_run", { scriptId, run });
}

/** Re-key a draft's runs onto the script id it was just saved as. */
export async function adoptScriptAuthoringRuns(fromId: string, toId: string): Promise<void> {
  return invoke<void>("adopt_script_authoring_runs", { fromId, toId });
}

/** Forget one script's authoring history. The author's own words, removable. */
export async function clearScriptAuthoringRuns(scriptId: string): Promise<void> {
  return invoke<void>("clear_script_authoring_runs", { scriptId });
}

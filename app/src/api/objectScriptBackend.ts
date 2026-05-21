//! FILENAME: app/src/api/objectScriptBackend.ts
// PURPOSE: Tauri command wrappers for object script CRUD operations.
// CONTEXT: Used by the ScriptableObjects extension to persist scripts in the backend.

import { invoke } from "@tauri-apps/api/core";
import type { ObjectScriptDefinition, ScriptableObjectType, ScriptAccessLevel } from "./scriptableObjects";

// ============================================================================
// Backend API Types (match Rust serialization)
// ============================================================================

interface ObjectScriptSummary {
  id: string;
  name: string;
  objectType: string;
  instanceId: string | null;
  accessLevel: string;
}

interface ObjectScriptData {
  id: string;
  name: string;
  objectType: string;
  instanceId: string | null;
  source: string;
  accessLevel: string;
  description: string | null;
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
      });
    } catch (e) {
      console.warn(`[ObjectScripts] Failed to load script "${summary.name}":`, e);
    }
  }

  return scripts;
}

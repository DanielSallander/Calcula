//! FILENAME: app/extensions/ScriptableObjects/lib/templateManager.ts
// PURPOSE: Template system for saving and loading customized component objects.
// CONTEXT: Users can save a customized component object (with its script) as a
//          template, then stamp out independent copies. Templates are stored in
//          the user's %APPDATA%/Calcula/templates/ directory.

import { invoke } from "@tauri-apps/api/core";
import type { ObjectScriptDefinition, ScriptableObjectType } from "@api/scriptableObjects";

// ============================================================================
// Types
// ============================================================================

/** A saved object template (stored as JSON in the templates directory). */
export interface ObjectTemplate {
  /** Unique template ID */
  id: string;
  /** Template display name */
  name: string;
  /** The object type this template creates */
  objectType: ScriptableObjectType;
  /** The script source code */
  scriptSource: string;
  /** Script access level */
  accessLevel: "restricted" | "unlocked";
  /** Optional description */
  description?: string;
  /** ISO 8601 creation date */
  createdAt: string;
  /** Additional metadata (object-specific config, style, etc.) */
  metadata?: Record<string, unknown>;
}

/** Lightweight summary for listing templates. */
export interface TemplateSummary {
  id: string;
  name: string;
  objectType: ScriptableObjectType;
  description?: string;
  createdAt: string;
}

// ============================================================================
// Template Storage (via Tauri filesystem)
// ============================================================================

const TEMPLATES_DIR = "templates";

/** List all saved templates. */
export async function listTemplates(): Promise<TemplateSummary[]> {
  try {
    const templates = await invoke<ObjectTemplate[]>("list_object_templates");
    return templates.map((t) => ({
      id: t.id,
      name: t.name,
      objectType: t.objectType,
      description: t.description,
      createdAt: t.createdAt,
    }));
  } catch {
    // Template commands not yet implemented in backend — return empty
    return [];
  }
}

/** Save a template. */
export async function saveTemplate(template: ObjectTemplate): Promise<void> {
  try {
    await invoke<void>("save_object_template", { template });
  } catch {
    // Fallback: store in localStorage for now
    const key = `calcula.template.${template.id}`;
    localStorage.setItem(key, JSON.stringify(template));
  }
}

/** Load a template by ID. */
export async function loadTemplate(id: string): Promise<ObjectTemplate | null> {
  try {
    return await invoke<ObjectTemplate>("load_object_template", { id });
  } catch {
    // Fallback: check localStorage
    const key = `calcula.template.${id}`;
    const raw = localStorage.getItem(key);
    if (raw) {
      return JSON.parse(raw) as ObjectTemplate;
    }
    return null;
  }
}

/** Delete a template by ID. */
export async function deleteTemplate(id: string): Promise<void> {
  try {
    await invoke<void>("delete_object_template", { id });
  } catch {
    // Fallback: remove from localStorage
    localStorage.removeItem(`calcula.template.${id}`);
  }
}

// ============================================================================
// Template Operations
// ============================================================================

/**
 * Create a template from an existing object script definition.
 * The template captures the script source and metadata.
 */
export function createTemplateFromScript(
  script: ObjectScriptDefinition,
  templateName: string,
  metadata?: Record<string, unknown>,
): ObjectTemplate {
  return {
    id: crypto.randomUUID(),
    name: templateName,
    objectType: script.objectType,
    scriptSource: script.source,
    accessLevel: script.accessLevel,
    description: script.description,
    createdAt: new Date().toISOString(),
    metadata,
  };
}

/**
 * Stamp a new object script from a template.
 * Creates an independent copy — no live link back to the template.
 */
export function stampFromTemplate(
  template: ObjectTemplate,
  instanceId: string,
  instanceName?: string,
): ObjectScriptDefinition {
  return {
    id: crypto.randomUUID(),
    name: instanceName || `${template.name} (copy)`,
    objectType: template.objectType,
    instanceId,
    source: template.scriptSource,
    accessLevel: template.accessLevel,
    description: template.description,
  };
}

/**
 * Export a template as a JSON string (for .calcula-template file sharing).
 */
export function exportTemplate(template: ObjectTemplate): string {
  return JSON.stringify(template, null, 2);
}

/**
 * Import a template from a JSON string.
 */
export function importTemplate(json: string): ObjectTemplate {
  const template = JSON.parse(json) as ObjectTemplate;
  // Assign a new ID on import to avoid collisions
  template.id = crypto.randomUUID();
  return template;
}

//! FILENAME: app/extensions/ScriptableObjects/lib/templateManager.ts
// PURPOSE: Template system for saving and loading customized component objects.
// CONTEXT: Users can save a customized component object (with its script) as a
//          template, then stamp out independent copies. Templates are stored in
//          the user's %APPDATA%/Calcula/templates/ directory.

import {
  listObjectTemplates,
  saveObjectTemplate,
  loadObjectTemplate,
  deleteObjectTemplate,
} from "@api/backend";
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
  const templates = await listObjectTemplates<ObjectTemplate[]>();
  return templates.map((t) => ({
    id: t.id,
    name: t.name,
    objectType: t.objectType,
    description: t.description,
    createdAt: t.createdAt,
  }));
}

/** Save a template. */
export async function saveTemplate(template: ObjectTemplate): Promise<void> {
  await saveObjectTemplate(template);
}

/** Load a template by ID. */
export async function loadTemplate(id: string): Promise<ObjectTemplate | null> {
  return loadObjectTemplate<ObjectTemplate>(id);
}

/** Delete a template by ID. */
export async function deleteTemplate(id: string): Promise<void> {
  await deleteObjectTemplate(id);
  localStorage.removeItem(`calcula.template.${id}`);
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
 * The object types a template is allowed to name.
 *
 * Declared as a `Record` KEYED BY THE UNION rather than an array of strings, so
 * adding a `ScriptableObjectType` is a compile error here instead of a template
 * that imports with a type nothing can stamp.
 */
const VALID_OBJECT_TYPES: Record<ScriptableObjectType, true> = {
  workbook: true,
  sheet: true,
  cell: true,
  row: true,
  column: true,
  slicer: true,
  chart: true,
  pivot: true,
  button: true,
  textbox: true,
  timeline: true,
  shape: true,
  table: true,
  namedRange: true,
  range: true,
  panel: true,
  form: true,
};

/** A `.calcula-template` file that is not a template. */
export class TemplateImportError extends Error {
  constructor(message: string) {
    super(`Not a valid Calcula script template: ${message}`);
    this.name = "TemplateImportError";
  }
}

/**
 * Import a template from a JSON string.
 *
 * TWO THINGS THIS DOES THAT THE ORIGINAL DID NOT, both for the same reason: a
 * `.calcula-template` is a FILE THAT ARRIVES FROM SOMEWHERE ELSE. The dialog's
 * own empty state invites the user to "import a .calcula-template file", so the
 * user is choosing what they believe is a document, and what they get is
 * executable code plus the privilege level it runs at.
 *
 * 1. IT VALIDATES. The original was `JSON.parse(json) as ObjectTemplate` — a
 *    cast, which checks nothing at all — and the result was written straight to
 *    the templates directory. Any JSON object at all became a "template".
 *
 * 2. IT REFUSES TO TAKE THE TIER FROM THE FILE. `accessLevel` is forced to
 *    "restricted" no matter what the file says. It used to be copied verbatim,
 *    and it is load-bearing: `stampFromTemplate` puts it on the stamped
 *    `ObjectScriptDefinition`, and `buildHandleFromDefinition`
 *    (app/src/api/scriptHost/broker.ts) turns `accessLevel === "unlocked"` into
 *    `tier: "unlocked"` — whole-workbook reach, `api.getCellValue` /
 *    `api.setCellValue` / `api.updateCellsBatch` over 100,000 cells /
 *    `api.executeCommand`. An object script runs on its object's events, so
 *    nothing further had to be clicked. A file could therefore choose its own
 *    privilege level, and no part of the import flow ever said so.
 *
 *    This is not a new rule, it is the rule this door was missing:
 *    `draftToScriptDefinition` in ./scriptDrafts.ts already states it for
 *    AI-authored scripts — "must never arrive pre-escalated to the unlocked
 *    tier; raising it is a separate, deliberate human action in the editor."
 *    A file off the disk deserves it at least as much as an AI does. Raising
 *    the tier stays one visible click in the editor.
 *
 * Provenance stays "local" (the field is absent), which is correct and is why
 * the tier had to be closed here: a local script auto-grants `ui.html` and
 * takes its declared-capability ceiling from source pragmas, so the import
 * lands in the MOST trusted bucket, not the least.
 *
 * NOT COVERED, deliberately and stated rather than implied: a file written
 * DIRECTLY into %APPDATA%/Calcula/templates/ never passes through this
 * function. Anything that can write there can already write far worse, so the
 * boundary drawn here is the import door, not the directory.
 */
export function importTemplate(json: string): ObjectTemplate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new TemplateImportError(`the file is not valid JSON (${String(e)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TemplateImportError("the file is not a JSON object");
  }
  const raw = parsed as Record<string, unknown>;

  const name = raw.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new TemplateImportError("`name` is missing or not a non-empty string");
  }
  const objectType = raw.objectType;
  if (
    typeof objectType !== "string" ||
    !Object.prototype.hasOwnProperty.call(VALID_OBJECT_TYPES, objectType)
  ) {
    throw new TemplateImportError(
      `\`objectType\` is missing or not a scriptable object type (got ${JSON.stringify(objectType)})`,
    );
  }
  const scriptSource = raw.scriptSource;
  if (typeof scriptSource !== "string") {
    throw new TemplateImportError("`scriptSource` is missing or not a string");
  }
  const description = raw.description;
  if (description !== undefined && typeof description !== "string") {
    throw new TemplateImportError("`description` is present but not a string");
  }
  const metadata = raw.metadata;
  if (
    metadata !== undefined &&
    (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))
  ) {
    throw new TemplateImportError("`metadata` is present but not a JSON object");
  }
  const createdAt = raw.createdAt;

  return {
    // A FRESH id, so an imported file cannot choose the identity that a
    // capability grant or a source hash is keyed to (same reasoning as
    // `draftToScriptDefinition`).
    id: crypto.randomUUID(),
    name,
    objectType: objectType as ScriptableObjectType,
    scriptSource,
    // NEVER `raw.accessLevel`. See the note above.
    accessLevel: "restricted",
    ...(description !== undefined ? { description } : {}),
    createdAt: typeof createdAt === "string" ? createdAt : new Date().toISOString(),
    ...(metadata !== undefined ? { metadata: metadata as Record<string, unknown> } : {}),
  };
}

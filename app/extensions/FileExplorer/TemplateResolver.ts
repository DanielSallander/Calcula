//! FILENAME: app/extensions/FileExplorer/TemplateResolver.ts
// PURPOSE: Parses {{ expression }} templates in virtual files and resolves them
//          against the spreadsheet grid via the evaluate_expressions Tauri command.
// CONTEXT: Used by FileViewerPane to render resolved content in preview mode.

import { evaluateExpressions } from "../../src/api/backend";

/** Matches {{ expression }} blocks, non-greedy */
const TEMPLATE_RE = /\{\{(.+?)\}\}/g;

/** Check whether content contains any {{ }} template blocks */
export function hasTemplates(content: string): boolean {
  TEMPLATE_RE.lastIndex = 0;
  return TEMPLATE_RE.test(content);
}

/**
 * Resolve all {{ expression }} blocks in content by evaluating them
 * against the current grid state. Returns the content with all templates
 * replaced by their resolved values.
 *
 * Errors are inlined as error strings (e.g., "#REF!", "#SYNTAX!").
 */
export async function resolveTemplates(content: string): Promise<string> {
  const matches = [...content.matchAll(new RegExp(TEMPLATE_RE))];
  if (matches.length === 0) return content;

  const expressions = matches.map(m => m[1].trim());

  let results: string[];
  try {
    results = await evaluateExpressions(expressions);
  } catch (err) {
    // If the backend call itself fails, mark all templates as errors
    console.error("[TemplateResolver] Backend error:", err);
    results = expressions.map(() => "#ERROR!");
  }

  // Replace each match with its resolved value.
  // Process in reverse order to preserve string indices.
  let resolved = content;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const start = match.index!;
    const end = start + match[0].length;
    resolved = resolved.slice(0, start) + results[i] + resolved.slice(end);
  }

  return resolved;
}

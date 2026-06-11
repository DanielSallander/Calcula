//! FILENAME: app/e2e/oracles/digest.ts
// PURPOSE: TypeScript client for the `get_workbook_state_digest` Tauri command
//          plus canonicalization, hashing, and profile-aware digest diffing.
//          The digest is the foundation of the semantic oracles: two digests
//          of identical workbook state must compare equal.

import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";

// ============================================================================
// Types
// ============================================================================

/** Shape of the Rust WorkbookStateDigest (serde camelCase). Kept loose on
 *  purpose — the differ walks it generically. */
export interface WorkbookDigestJson {
  version: number;
  activeSheet: number;
  sheetNames: string[];
  sheets: SheetDigestJson[];
  usedStyles: Record<string, unknown>;
  [section: string]: unknown;
}

export interface SheetDigestJson {
  name: string;
  cells: Record<string, CellDigestJson>;
  [field: string]: unknown;
}

export interface CellDigestJson {
  v: string;
  raw: unknown;
  f?: string;
  s: number;
  rt?: unknown;
}

export interface Digest {
  /** sha256 of the canonical JSON — fast equality check. */
  hash: string;
  digest: WorkbookDigestJson;
}

export interface DigestDiffEntry {
  /** Dot path into the digest, e.g. "sheets[0].cells.4:1.v" */
  path: string;
  before: unknown;
  after: unknown;
}

export interface DigestDiff {
  equal: boolean;
  diffs: DigestDiffEntry[];
  /** True if more diffs existed than the cap. */
  truncated: boolean;
}

/**
 * Comparison profiles:
 *  - "undo": in-memory round-trip. Style indices are stable, compare directly.
 *  - "saveReload": across save/open. Style indices are NOT stable — cells are
 *    compared by resolved style content instead, and the usedStyles map itself
 *    is excluded.
 *
 * Both profiles exclude `protectedRegions` (registered by frontend extensions
 * with re-registration timing that varies).
 */
export type DiffProfile = "undo" | "saveReload";

const MAX_DIFFS = 200;

// ============================================================================
// Capture
// ============================================================================

/** Fetch the canonical workbook state digest from the backend. */
export async function getWorkbookDigest(
  page: Page,
  opts?: { cellsOnly?: boolean }
): Promise<Digest> {
  const digest = (await page.evaluate(async (cellsOnly) => {
    const tauri = (window as any).__TAURI__;
    return tauri.core.invoke("get_workbook_state_digest", {
      options: { cellsOnly },
    });
  }, opts?.cellsOnly ?? false)) as WorkbookDigestJson;

  return { hash: hashValue(digest), digest };
}

// ============================================================================
// Canonicalization & hashing
// ============================================================================

/** JSON.stringify with recursively sorted object keys (canonical form). */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function hashValue(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

// ============================================================================
// Diffing
// ============================================================================

/** Sections excluded from comparison in every profile. */
const COMMON_EXCLUDED_SECTIONS = new Set(["protectedRegions"]);

/** Extra sections excluded in the saveReload profile. */
const SAVE_RELOAD_EXCLUDED_SECTIONS = new Set(["usedStyles"]);

/**
 * Compare two digests under a profile. Returns path-level diffs that are
 * actionable in triage prompts ("sheets[0].cells.4:1.v: '12,5' -> '12.5'").
 */
export function diffDigests(
  a: Digest,
  b: Digest,
  profile: DiffProfile
): DigestDiff {
  const normA = normalizeForProfile(a.digest, profile);
  const normB = normalizeForProfile(b.digest, profile);

  const diffs: DigestDiffEntry[] = [];
  walkDiff(normA, normB, "", diffs);

  return {
    equal: diffs.length === 0,
    diffs: diffs.slice(0, MAX_DIFFS),
    truncated: diffs.length > MAX_DIFFS,
  };
}

function normalizeForProfile(
  digest: WorkbookDigestJson,
  profile: DiffProfile
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [section, value] of Object.entries(digest)) {
    if (COMMON_EXCLUDED_SECTIONS.has(section)) continue;
    if (profile === "saveReload" && SAVE_RELOAD_EXCLUDED_SECTIONS.has(section)) {
      continue;
    }
    out[section] = value;
  }

  if (profile === "saveReload") {
    // Style indices are not stable across save/reload: replace each cell's
    // numeric style index with the canonical JSON of the resolved style.
    const styles = (digest.usedStyles ?? {}) as Record<string, unknown>;
    out.sheets = ((digest.sheets ?? []) as SheetDigestJson[]).map((sheet) => {
      const cells: Record<string, unknown> = {};
      for (const [key, cell] of Object.entries(sheet.cells ?? {})) {
        const { s, ...rest } = cell;
        cells[key] = { ...rest, style: canonicalStringify(styles[String(s)]) };
      }
      return { ...sheet, cells };
    });
  }

  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function walkDiff(
  a: unknown,
  b: unknown,
  path: string,
  diffs: DigestDiffEntry[]
): void {
  // Cheap cap: keep collecting slightly past MAX_DIFFS to set `truncated`,
  // but do not walk forever on massive divergence.
  if (diffs.length > MAX_DIFFS * 2) return;

  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      walkDiff(a[i], b[i], `${path}[${i}]`, diffs);
    }
    return;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      const inA = key in a;
      const inB = key in b;
      if (inA && inB) {
        walkDiff(a[key], b[key], childPath, diffs);
      } else {
        diffs.push({
          path: childPath,
          before: inA ? summarize(a[key]) : "<absent>",
          after: inB ? summarize(b[key]) : "<absent>",
        });
      }
    }
    return;
  }

  if (!Object.is(a, b)) {
    // Distinct primitive values, or type mismatch (object vs primitive).
    if (canonicalStringify(a) !== canonicalStringify(b)) {
      diffs.push({ path, before: summarize(a), after: summarize(b) });
    }
  }
}

/** Keep diff entries readable: truncate huge values. */
function summarize(value: unknown): unknown {
  if (value === undefined) return "<absent>";
  if (typeof value === "string") {
    return value.length > 300 ? value.slice(0, 300) + "..." : value;
  }
  if (value !== null && typeof value === "object") {
    const json = canonicalStringify(value);
    return json.length > 300 ? json.slice(0, 300) + "..." : JSON.parse(json);
  }
  return value;
}

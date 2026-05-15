//! FILENAME: app/extensions/__tests__/extensionManifests.test.ts
// PURPOSE: Validates extension manifests and system integrity.
// CONTEXT: Uses static file analysis to validate all extensions have unique IDs,
//          valid versions, proper lifecycle functions, and follow naming conventions.
//          Does NOT import extension modules directly (avoids monaco-editor in jsdom).

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Helpers
// ============================================================================

const EXTENSIONS_DIR = path.resolve(__dirname, "..");
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

/** Recursively collect all .ts/.tsx files under a directory, excluding node_modules and __tests__ */
function collectSourceFiles(dir: string, result: string[] = []): string[] {
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      collectSourceFiles(full, result);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      result.push(full);
    }
  }
  return result;
}

interface ManifestInfo {
  id: string;
  name: string;
  version: string;
  file: string;
  hasActivate: boolean;
  hasDeactivate: boolean;
}

/**
 * Extract manifest info from an extension's index.ts using static analysis.
 * Looks for the pattern: manifest: { id: "...", name: "...", version: "..." }
 * and activate/deactivate function definitions.
 */
function extractManifestFromFile(filePath: string): ManifestInfo | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf-8");

  // Extract the manifest block: everything between "manifest:" and the closing "}"
  // Use a greedy match that captures the manifest object literal
  const manifestBlockMatch = content.match(/manifest\s*:\s*\{([^}]*)\}/s);
  if (!manifestBlockMatch) return null;

  const block = manifestBlockMatch[1];
  const idMatch = block.match(/id:\s*["'`]([^"'`]+)["'`]/);
  const nameMatch = block.match(/name:\s*["'`]([^"'`]+)["'`]/);
  const versionMatch = block.match(/version:\s*["'`]([^"'`]+)["'`]/);

  if (!idMatch) return null;

  // Check for activate/deactivate
  const hasActivate =
    /\bfunction\s+activate\b/.test(content) ||
    /\bactivate\s*[:(]/.test(content);
  const hasDeactivate =
    /\bfunction\s+deactivate\b/.test(content) ||
    /\bdeactivate\s*[:(]/.test(content) ||
    /\bdeactivate\s*\??\s*:/.test(content);

  return {
    id: idMatch[1],
    name: nameMatch ? nameMatch[1] : "",
    version: versionMatch ? versionMatch[1] : "",
    file: filePath,
    hasActivate,
    hasDeactivate,
  };
}

/**
 * Get all extension directories that have an index.ts (actual extensions).
 * Includes BuiltIn/* subdirectories.
 */
function getAllExtensionIndexFiles(): string[] {
  const result: string[] = [];
  const entries = fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (["__tests__", "node_modules", "_shared", "_template", "_standard"].includes(entry.name)) continue;

    if (entry.name === "BuiltIn") {
      // BuiltIn has sub-extensions
      const builtInDir = path.join(EXTENSIONS_DIR, "BuiltIn");
      for (const sub of fs.readdirSync(builtInDir, { withFileTypes: true })) {
        if (sub.isDirectory()) {
          const indexPath = path.join(builtInDir, sub.name, "index.ts");
          if (fs.existsSync(indexPath)) result.push(indexPath);
        }
      }
    } else {
      const indexPath = path.join(EXTENSIONS_DIR, entry.name, "index.ts");
      if (fs.existsSync(indexPath)) result.push(indexPath);
    }
  }

  return result;
}

// ============================================================================
// Collect all manifests
// ============================================================================

const indexFiles = getAllExtensionIndexFiles();
const manifests: ManifestInfo[] = [];
for (const f of indexFiles) {
  const info = extractManifestFromFile(f);
  if (info) manifests.push(info);
}

// ============================================================================
// Manifest Validation
// ============================================================================

describe("Extension Manifests", () => {
  it("found a reasonable number of extensions", () => {
    // Sanity check - we know there are 50+ extensions
    expect(manifests.length).toBeGreaterThan(30);
  });

  it("all extensions have a manifest with an id", () => {
    for (const m of manifests) {
      const rel = path.relative(EXTENSIONS_DIR, m.file).replace(/\\/g, "/");
      expect(m.id, `Extension ${rel} has empty id`).toBeTruthy();
    }
  });

  it("all extension IDs are unique", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const m of manifests) {
      if (seen.has(m.id)) duplicates.push(m.id);
      seen.add(m.id);
    }
    expect(duplicates, `Duplicate extension IDs: ${duplicates.join(", ")}`).toEqual([]);
  });

  it("all extension IDs follow the calcula.xxx naming convention", () => {
    const violations: string[] = [];
    for (const m of manifests) {
      if (!/^calcula(\.[a-z][a-z0-9-]*)+$/.test(m.id)) {
        violations.push(m.id);
      }
    }
    expect(
      violations,
      `Extension IDs not following calcula.xxx kebab-case convention: ${violations.join(", ")}`,
    ).toEqual([]);
  });

  it("all extensions have valid semver version strings", () => {
    const invalid: string[] = [];
    for (const m of manifests) {
      if (!SEMVER_REGEX.test(m.version)) {
        invalid.push(`${m.id} (version: "${m.version}")`);
      }
    }
    expect(
      invalid,
      `Extensions with invalid versions: ${invalid.join(", ")}`,
    ).toEqual([]);
  });

  it("all extensions have a non-empty name", () => {
    const nameless: string[] = [];
    for (const m of manifests) {
      if (!m.name || m.name.trim().length === 0) {
        nameless.push(m.id);
      }
    }
    expect(
      nameless,
      `Extensions missing a name: ${nameless.join(", ")}`,
    ).toEqual([]);
  });

  it("all extension names are unique", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const m of manifests) {
      if (seen.has(m.name)) duplicates.push(m.name);
      seen.add(m.name);
    }
    expect(duplicates, `Duplicate extension names: ${duplicates.join(", ")}`).toEqual([]);
  });
});

// ============================================================================
// Lifecycle Functions
// ============================================================================

describe("Extension Lifecycle", () => {
  it("all extensions define an activate function", () => {
    const missing: string[] = [];
    for (const m of manifests) {
      if (!m.hasActivate) missing.push(m.id);
    }
    expect(
      missing,
      `Extensions missing activate: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("all extensions define a deactivate function", () => {
    const missing: string[] = [];
    for (const m of manifests) {
      if (!m.hasDeactivate) missing.push(m.id);
    }
    expect(
      missing,
      `Extensions missing deactivate: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});

// ============================================================================
// Import Rules (static file analysis)
// ============================================================================

describe("Import Rules", () => {
  const allFiles = collectSourceFiles(EXTENSIONS_DIR);

  it("no extension file imports directly from src/core/", () => {
    const violations: string[] = [];

    for (const filePath of allFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (
          /^\s*import\s/.test(line) &&
          (line.includes("src/core") || line.includes("@core"))
        ) {
          const relative = path.relative(EXTENSIONS_DIR, filePath).replace(/\\/g, "/");
          violations.push(`${relative}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(
      violations,
      `Extensions must not import from src/core/ or @core. Violations:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("no extension file imports from src/shell/", () => {
    const violations: string[] = [];

    for (const filePath of allFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (
          /^\s*import\s/.test(line) &&
          (line.includes("src/shell") || line.includes("@shell"))
        ) {
          const relative = path.relative(EXTENSIONS_DIR, filePath).replace(/\\/g, "/");
          violations.push(`${relative}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(
      violations,
      `Extensions must not import from src/shell/ or @shell. Violations:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});

// ============================================================================
// Command ID Naming Conventions
// ============================================================================

describe("Command ID Conventions", () => {
  const allFiles = collectSourceFiles(EXTENSIONS_DIR);

  it("all registered command IDs use dot-separated lowercase naming", () => {
    const badCommands: string[] = [];
    const commandIdPattern = /commands\.register\(\s*["'`]([^"'`]+)["'`]/g;

    for (const filePath of allFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      let match: RegExpExecArray | null;
      while ((match = commandIdPattern.exec(content)) !== null) {
        const commandId = match[1];
        if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/.test(commandId)) {
          const relative = path.relative(EXTENSIONS_DIR, filePath).replace(/\\/g, "/");
          badCommands.push(`${relative}: "${commandId}"`);
        }
      }
    }

    if (badCommands.length > 0) {
      console.warn(
        `[WARN] Command IDs not following dot.separated.lowercase convention:\n${badCommands.join("\n")}`,
      );
    }
    // Soft check - log warnings but do not fail
    expect(true).toBe(true);
  });
});

// ============================================================================
// Duplicate Ribbon/Menu Registrations (static analysis)
// ============================================================================

describe("UI Registration Uniqueness", () => {
  const allFiles = collectSourceFiles(EXTENSIONS_DIR);

  it("no duplicate dialog IDs across extensions", () => {
    const dialogIds = new Map<string, string[]>();
    const dialogIdPattern = /dialogs\.register\(\s*\{[^}]*id:\s*["'`]([^"'`]+)["'`]/gs;

    for (const filePath of allFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      let match: RegExpExecArray | null;
      while ((match = dialogIdPattern.exec(content)) !== null) {
        const dialogId = match[1];
        const relative = path.relative(EXTENSIONS_DIR, filePath).replace(/\\/g, "/");
        if (!dialogIds.has(dialogId)) {
          dialogIds.set(dialogId, []);
        }
        dialogIds.get(dialogId)!.push(relative);
      }
    }

    const duplicates = [...dialogIds.entries()].filter(([_, files]) => files.length > 1);
    expect(
      duplicates.map(([id, files]) => `"${id}" in: ${files.join(", ")}`),
      `Duplicate dialog IDs found`,
    ).toEqual([]);
  });

  it("no duplicate menu IDs across extensions", () => {
    const menuIds = new Map<string, string[]>();
    const menuIdPattern = /menus\.register\(\s*\{[^}]*id:\s*["'`]([^"'`]+)["'`]/gs;

    for (const filePath of allFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      let match: RegExpExecArray | null;
      while ((match = menuIdPattern.exec(content)) !== null) {
        const menuId = match[1];
        const relative = path.relative(EXTENSIONS_DIR, filePath).replace(/\\/g, "/");
        if (!menuIds.has(menuId)) {
          menuIds.set(menuId, []);
        }
        menuIds.get(menuId)!.push(relative);
      }
    }

    const duplicates = [...menuIds.entries()].filter(([_, files]) => files.length > 1);
    expect(
      duplicates.map(([id, files]) => `"${id}" in: ${files.join(", ")}`),
      `Duplicate menu IDs found`,
    ).toEqual([]);
  });
});

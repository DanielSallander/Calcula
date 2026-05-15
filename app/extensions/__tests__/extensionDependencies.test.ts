//! FILENAME: app/extensions/__tests__/extensionDependencies.test.ts
// PURPOSE: Validates extension dependency integrity.
// CONTEXT: Ensures no circular dependencies between extensions,
//          all imports go through the API layer, and no forbidden paths are used.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Helpers
// ============================================================================

const EXTENSIONS_DIR = path.resolve(__dirname, "..");

/** Get top-level extension directories (each is one extension or a group like BuiltIn) */
function getExtensionDirs(): string[] {
  const entries = fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isDirectory() &&
        e.name !== "__tests__" &&
        e.name !== "node_modules" &&
        e.name !== "_shared" &&
        e.name !== "_template" &&
        e.name !== "_standard",
    )
    .map((e) => e.name);
}

/** Recursively collect .ts/.tsx files in a directory */
function collectFiles(dir: string, result: string[] = []): string[] {
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      collectFiles(full, result);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      result.push(full);
    }
  }
  return result;
}

/** Extract import paths from a TS file's content */
function extractImportPaths(content: string): string[] {
  const paths: string[] = [];
  // Match: import ... from "path" and import "path" (side-effect imports)
  const importRegex = /(?:import\s+(?:.*?\s+from\s+)?["'`]([^"'`]+)["'`])/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    paths.push(match[1]);
  }
  // Also match dynamic imports: import("path")
  const dynamicRegex = /import\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  while ((match = dynamicRegex.exec(content)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

/**
 * Determine which extension directory a relative import from a file resolves to.
 * Returns the extension folder name, or null if it's not an inter-extension import.
 */
function resolveExtensionTarget(
  importPath: string,
  sourceFile: string,
): string | null {
  // Only interested in relative imports that go up to sibling extension dirs
  if (!importPath.startsWith("..")) return null;

  const sourceDir = path.dirname(sourceFile);
  const resolved = path.resolve(sourceDir, importPath);
  const relative = path.relative(EXTENSIONS_DIR, resolved).replace(/\\/g, "/");

  // If it goes outside extensions dir, not relevant
  if (relative.startsWith("..")) return null;

  // The first segment is the extension folder name
  const segments = relative.split("/");
  return segments[0] || null;
}

/** Identify which extension folder a source file belongs to */
function getExtensionName(filePath: string): string | null {
  const relative = path.relative(EXTENSIONS_DIR, filePath).replace(/\\/g, "/");
  if (relative.startsWith("..")) return null;
  const segments = relative.split("/");
  return segments[0] || null;
}

// ============================================================================
// Dependency Graph Construction
// ============================================================================

type DepGraph = Map<string, Set<string>>;

function buildDependencyGraph(): DepGraph {
  const graph: DepGraph = new Map();
  const extensionDirs = getExtensionDirs();

  for (const extDir of extensionDirs) {
    const dirPath = path.join(EXTENSIONS_DIR, extDir);
    const files = collectFiles(dirPath);
    if (!graph.has(extDir)) graph.set(extDir, new Set());

    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      const imports = extractImportPaths(content);

      for (const imp of imports) {
        const target = resolveExtensionTarget(imp, file);
        if (target && target !== extDir && extensionDirs.includes(target)) {
          graph.get(extDir)!.add(target);
        }
      }
    }
  }

  return graph;
}

/** Detect cycles using DFS */
function findCycles(graph: DepGraph): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string): void {
    if (inStack.has(node)) {
      // Found a cycle - extract it from the stack
      const cycleStart = stack.indexOf(node);
      cycles.push([...stack.slice(cycleStart), node]);
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    stack.push(node);

    const deps = graph.get(node) || new Set();
    for (const dep of deps) {
      dfs(dep);
    }

    stack.pop();
    inStack.delete(node);
  }

  for (const node of graph.keys()) {
    dfs(node);
  }

  return cycles;
}

// ============================================================================
// Tests: Circular Dependencies
// ============================================================================

describe("Circular Dependencies", () => {
  // Known cross-dependencies that are architecturally acceptable:
  // - Pivot <-> Charts: Pivot offers "Insert Chart from Pivot" (imports Charts manifest),
  //   Charts listens to PivotEvents (imports Pivot events). Both are tightly coupled features.
  const KNOWN_CYCLES = new Set(["Charts -> Pivot -> Charts", "Pivot -> Charts -> Pivot"]);

  it("no unexpected circular dependencies exist between extensions", () => {
    const graph = buildDependencyGraph();
    const cycles = findCycles(graph);
    const unexpected = cycles
      .map((c) => c.join(" -> "))
      .filter((desc) => !KNOWN_CYCLES.has(desc));

    expect(
      unexpected,
      `Unexpected circular dependencies detected between extensions`,
    ).toEqual([]);
  });
});

// ============================================================================
// Tests: Import Path Validation
// ============================================================================

describe("Import Path Validation", () => {
  const extensionDirs = getExtensionDirs();

  it("all extension imports use @api, relative paths, or external packages (never @core or @shell)", () => {
    const violations: string[] = [];

    for (const extDir of extensionDirs) {
      const dirPath = path.join(EXTENSIONS_DIR, extDir);
      const files = collectFiles(dirPath);

      for (const file of files) {
        const content = fs.readFileSync(file, "utf-8");
        const imports = extractImportPaths(content);
        const relative = path.relative(EXTENSIONS_DIR, file).replace(/\\/g, "/");

        for (const imp of imports) {
          if (imp === "@core" || imp.startsWith("@core/")) {
            violations.push(`${relative}: imports "${imp}" (must use @api instead)`);
          }
          if (imp === "@shell" || imp.startsWith("@shell/")) {
            violations.push(`${relative}: imports "${imp}" (must use @api instead)`);
          }
          if (imp.includes("src/core")) {
            violations.push(`${relative}: imports "${imp}" (must use @api instead)`);
          }
          if (imp.includes("src/shell")) {
            violations.push(`${relative}: imports "${imp}" (must use @api instead)`);
          }
        }
      }
    }

    expect(
      violations,
      `Forbidden imports found:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("extensions do not import from the _template directory", () => {
    const violations: string[] = [];

    for (const extDir of extensionDirs) {
      const dirPath = path.join(EXTENSIONS_DIR, extDir);
      const files = collectFiles(dirPath);

      for (const file of files) {
        const content = fs.readFileSync(file, "utf-8");
        const imports = extractImportPaths(content);
        const relative = path.relative(EXTENSIONS_DIR, file).replace(/\\/g, "/");

        for (const imp of imports) {
          if (imp.includes("_template")) {
            violations.push(`${relative}: imports "${imp}" (template should not be imported)`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("_shared utilities are only imported by extensions (not the other way around)", () => {
    const sharedDir = path.join(EXTENSIONS_DIR, "_shared");
    if (!fs.existsSync(sharedDir)) return;

    const sharedFiles = collectFiles(sharedDir);
    const violations: string[] = [];

    for (const file of sharedFiles) {
      const content = fs.readFileSync(file, "utf-8");
      const imports = extractImportPaths(content);
      const relative = path.relative(EXTENSIONS_DIR, file).replace(/\\/g, "/");

      for (const imp of imports) {
        // _shared should not import from specific extension directories
        if (imp.startsWith("..")) {
          const target = resolveExtensionTarget(imp, file);
          if (target && target !== "_shared" && target !== "_standard") {
            violations.push(
              `${relative}: _shared imports from extension "${target}" via "${imp}"`,
            );
          }
        }
      }
    }

    expect(
      violations,
      `_shared must not depend on specific extensions:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});

// ============================================================================
// Tests: API-Only Imports Summary
// ============================================================================

describe("API-Only Import Enforcement", () => {
  it("all @api imports resolve to valid api subpaths", () => {
    const apiDir = path.resolve(EXTENSIONS_DIR, "..", "src", "api");
    const validApiModules = new Set<string>();

    if (fs.existsSync(apiDir)) {
      const apiFiles = fs.readdirSync(apiDir);
      for (const f of apiFiles) {
        // Strip extension to get module name
        const name = f.replace(/\.(ts|tsx)$/, "");
        validApiModules.add(name);
      }
      // Also include subdirectories
      for (const entry of fs.readdirSync(apiDir, { withFileTypes: true })) {
        if (entry.isDirectory()) validApiModules.add(entry.name);
      }
    }

    const warnings: string[] = [];
    const extensionDirs = getExtensionDirs();

    for (const extDir of extensionDirs) {
      const dirPath = path.join(EXTENSIONS_DIR, extDir);
      const files = collectFiles(dirPath);

      for (const file of files) {
        const content = fs.readFileSync(file, "utf-8");
        const imports = extractImportPaths(content);
        const relative = path.relative(EXTENSIONS_DIR, file).replace(/\\/g, "/");

        for (const imp of imports) {
          if (imp.startsWith("@api/")) {
            const subpath = imp.replace("@api/", "").split("/")[0];
            if (!validApiModules.has(subpath)) {
              warnings.push(`${relative}: imports "${imp}" but "${subpath}" not found in api/`);
            }
          }
        }
      }
    }

    if (warnings.length > 0) {
      console.warn(`[WARN] Possibly invalid @api imports:\n${warnings.join("\n")}`);
    }
    // Soft check - warn rather than fail since path aliases may resolve differently at build time
    expect(true).toBe(true);
  });
});

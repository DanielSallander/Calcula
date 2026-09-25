// FILENAME: app/extensions/Collaboration/lib/__tests__/workspacePickerSeam.test.ts
// PURPOSE: Every native OPEN picker in this extension goes through
//          `lib/pickWorkspace.ts`, so every place a user points at a workspace
//          aims at the same thing — the `workspace.calcula` pointer file.
// CONTEXT: The seam's rule used to be a sentence listing the dialogs its author
//          knew about. The Application Inspector is a separate window, the list
//          never named it, and it kept a raw folder picker: the one surface where
//          "Browse…" meant a folder while every other "Browse…" meant the
//          pointer file. Nobody decided that; the list simply did not reach it.
//          A list cannot notice a surface it was never told about. A scan can.

import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

const EXT_ROOT = path.resolve(__dirname, "../..");
const SEAM = path.join(EXT_ROOT, "lib", "pickWorkspace.ts");

/** Every non-test source file in the extension. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sources(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Comments stripped: these files explain the picker rule in prose, and a scan
 * that reads the explanation reports the sentence as the violation.
 */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * Does this file take the native OPEN dialog from the plugin, by any spelling?
 * `save` is a different gesture (choosing where to write an export) and is not
 * a way of pointing at a workspace.
 */
function importsOpenPicker(src: string): boolean {
  const body = code(src);
  const fromPlugin = /import\s*\{([^}]*)\}\s*from\s*["']@tauri-apps\/plugin-dialog["']/g;
  for (const m of body.matchAll(fromPlugin)) {
    const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]);
    if (names.includes("open")) return true;
  }
  if (/import\s*\*\s*as\s+\w+\s+from\s*["']@tauri-apps\/plugin-dialog["']/.test(body)) return true;
  if (/import\(\s*["']@tauri-apps\/plugin-dialog["']\s*\)/.test(body)) return true;
  return false;
}

describe("the workspace picker seam", () => {
  it("is the only file in the extension that opens a native OPEN picker", () => {
    // SABOTAGE: restore `import { open as openNativeDialog } from
    // "@tauri-apps/plugin-dialog"` in inspector/ApplicationInspectorApp.tsx.
    const files = sources(EXT_ROOT);
    expect(files.length, "the scan must actually see the extension").toBeGreaterThan(20);
    expect(files, "the seam itself must be in the scanned set").toContain(SEAM);

    const offenders = files
      .filter((f) => f !== SEAM)
      .filter((f) => importsOpenPicker(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(EXT_ROOT, f).replace(/\\/g, "/"));
    expect(
      offenders,
      "point at a workspace through lib/pickWorkspace.ts (pickWorkspaceFile, or " +
        "pickWorkspaceFolder for a publish that creates one) — never a raw picker",
    ).toEqual([]);
  });

  it("recognises the import spellings it claims to catch", () => {
    // The guard above passes trivially if this detector matches nothing, so its
    // positive cases are proved here and do not depend on the tree's contents.
    expect(importsOpenPicker('import { open } from "@tauri-apps/plugin-dialog";')).toBe(true);
    expect(
      importsOpenPicker('import { save, open as pick } from "@tauri-apps/plugin-dialog";'),
    ).toBe(true);
    expect(importsOpenPicker('import * as dlg from "@tauri-apps/plugin-dialog";')).toBe(true);
    expect(importsOpenPicker('const d = await import("@tauri-apps/plugin-dialog");')).toBe(true);
    // A save dialog is a different gesture, and a comment is not an import.
    expect(importsOpenPicker('import { save } from "@tauri-apps/plugin-dialog";')).toBe(false);
    expect(importsOpenPicker('// import { open } from "@tauri-apps/plugin-dialog";')).toBe(false);
  });

  it("gives the Application Inspector's Browse the pointer-file picker", () => {
    // SABOTAGE: swap `pickWorkspaceFile()` for `pickWorkspaceFolder()` in
    // handleBrowse. A folder picker there would still pass the import scan.
    const inspector = code(
      fs.readFileSync(
        path.join(EXT_ROOT, "components", "inspector", "ApplicationInspectorApp.tsx"),
        "utf8",
      ),
    );
    const browse = inspector.slice(inspector.indexOf("const handleBrowse = async"));
    const body = browse.slice(0, browse.indexOf("};"));
    expect(body).toContain("pickWorkspaceFile()");
    expect(body).not.toContain("pickWorkspaceFolder");
  });
});

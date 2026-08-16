//! FILENAME: app/src/api/__tests__/fileIngressSurfaces.test.ts
// PURPOSE: Enumerate EVERY way bytes enter the app through the WebView, repo-wide,
//          and make each one a declared, justified entry rather than a discovery.
// CONTEXT: The image-ingress pass (2026-08-15) reported "no FileReader, no
//          readAsDataURL, no file input remain -- a test asserts their absence
//          from the source." The substance was right and the SCOPE was not: the
//          assertion in extensions/Controls/__tests__/imageIngress.test.ts runs
//          over a hard-coded list of SEVEN files, all inside
//          app/extensions/Controls. It could not see another extension, and it
//          could not see a new file added to Controls either.
//
//          A second `<input type="file">` was living in
//          ScriptableObjects/components/TemplateManagerDialog.tsx the whole
//          time. It read text rather than images, so no media cap applied to it,
//          and it imported a script template whose `accessLevel` field it copied
//          verbatim -- letting a FILE choose the privilege tier of code that
//          then ran on object events (BUG-0092).
//
//          The lesson is the one this programme keeps re-learning: a guard
//          scoped to the place a defect was found does not cover the class. This
//          one sweeps app/src and app/extensions and holds the result against an
//          explicit inventory. A new door fails the test until somebody writes
//          down why it exists; a removed door fails it too, so an entry can
//          never outlive the thing it describes.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ROOTS = ["src", "extensions"];

/**
 * The shapes that put foreign bytes (or a foreign file's text) into the page.
 *
 * Deliberately NOT including the Rust-mediated path: `pickValidatedImage` ->
 * `read_media_file` passes a PATH over IPC and the host reads and validates the
 * bytes. That is the sanctioned door and it is not a WebView ingress at all.
 */
const INGRESS_SHAPES: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "readAsDataURL", re: /readAsDataURL/ },
  { id: "readAsArrayBuffer", re: /readAsArrayBuffer/ },
  { id: "readAsText", re: /readAsText/ },
  { id: "new FileReader", re: /new\s+FileReader/ },
  { id: "file input", re: /type\s*=\s*["']file["']/ },
  { id: "showOpenFilePicker", re: /showOpenFilePicker/ },
];

/**
 * THE INVENTORY. Every production occurrence of a shape above, with the reason
 * it is allowed to exist. Keep it exact: the test asserts in BOTH directions.
 */
const DECLARED: ReadonlyArray<{
  file: string;
  shape: string;
  why: string;
}> = [
  {
    file: "extensions/ScriptableObjects/components/TemplateManagerDialog.tsx",
    shape: "file input",
    why:
      "Script Templates > Import Template.... Reads TEXT (file.text()), never bytes, and " +
      "hands it to templateManager.importTemplate, which validates the shape and FORCES " +
      "accessLevel to 'restricted' so an imported file cannot choose the tier the stamped " +
      "script runs at (BUG-0092). No media, so no media cap applies.",
  },
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__screenshots__") continue;
      yield* sourceFiles(p);
    } else if (/\.tsx?$/.test(entry.name)) {
      yield p;
    }
  }
}

function isTestFile(rel: string): boolean {
  return /(^|\/)__tests__\//.test(rel) || /\.(test|spec)\.tsx?$/.test(rel);
}

/** Every production occurrence, as `file::shape`. */
function scan(): Array<{ file: string; shape: string; line: number; text: string }> {
  const found: Array<{ file: string; shape: string; line: number; text: string }> = [];
  for (const root of ROOTS) {
    for (const abs of sourceFiles(path.join(APP_DIR, root))) {
      const rel = path.relative(APP_DIR, abs).replace(/\\/g, "/");
      if (isTestFile(rel)) continue;
      const lines = stripComments(fs.readFileSync(abs, "utf8")).split("\n");
      lines.forEach((line, i) => {
        for (const shape of INGRESS_SHAPES) {
          if (shape.re.test(line)) {
            found.push({ file: rel, shape: shape.id, line: i + 1, text: line.trim().slice(0, 100) });
          }
        }
      });
    }
  }
  return found;
}

const key = (f: string, s: string) => `${f}::${s}`;

describe("every WebView file-ingress surface is declared", () => {
  const found = scan();

  it("finds no UNDECLARED ingress surface anywhere in src/ or extensions/", () => {
    const declared = new Set(DECLARED.map((d) => key(d.file, d.shape)));
    const undeclared = found.filter((f) => !declared.has(key(f.file, f.shape)));
    expect(
      undeclared,
      "A new way for a foreign file to enter the WebView appeared. This is not " +
        "automatically wrong -- it is automatically UNREVIEWED. Add it to DECLARED " +
        "with the reason it is safe (what it reads, what validates it, and what it " +
        "must never be trusted for), or route it through the Rust path " +
        "(pickValidatedImage -> read_media_file) instead:\n" +
        undeclared.map((u) => `  ${u.file}:${u.line} [${u.shape}] ${u.text}`).join("\n"),
    ).toEqual([]);
  });

  it("has no DECLARED entry that no longer exists", () => {
    // The other direction, and it is not pedantry: a suppression that outlived
    // its bug is how this programme blinded its own walker for weeks. An
    // inventory entry describing code that is gone is the same failure -- it
    // reads as due diligence and covers nothing.
    const foundKeys = new Set(found.map((f) => key(f.file, f.shape)));
    const stale = DECLARED.filter((d) => !foundKeys.has(key(d.file, d.shape)));
    expect(
      stale,
      "A DECLARED ingress surface is no longer in the source. Delete the entry " +
        "rather than leaving it to describe nothing:\n" +
        stale.map((s) => `  ${s.file} [${s.shape}]`).join("\n"),
    ).toEqual([]);
  });

  it("the sweep actually reaches both roots and a deep extension file", () => {
    // A sweep that silently walked nothing would pass every assertion above.
    const seen = new Set<string>();
    for (const root of ROOTS) {
      for (const abs of sourceFiles(path.join(APP_DIR, root))) {
        seen.add(path.relative(APP_DIR, abs).replace(/\\/g, "/"));
      }
    }
    expect(seen.size).toBeGreaterThan(1000);
    expect(seen.has("src/api/scriptHost/broker.ts")).toBe(true);
    expect(
      seen.has("extensions/ScriptableObjects/components/TemplateManagerDialog.tsx"),
    ).toBe(true);
    expect([...seen].some((f) => f.startsWith("extensions/Controls/"))).toBe(true);
  });

  it("the shapes it looks for would fire on the retired ingress", () => {
    // The pre-2026-08-15 image path, reconstructed. If a regex stops matching
    // the thing it was written for, the sweep above is decoration.
    const retired = [
      '<input type="file" accept="image/*" />',
      "const r = new FileReader();",
      "r.readAsDataURL(file);",
    ].join("\n");
    const firing = INGRESS_SHAPES.filter((s) => s.re.test(retired)).map((s) => s.id);
    expect(firing).toEqual(
      expect.arrayContaining(["file input", "new FileReader", "readAsDataURL"]),
    );
  });
});

describe("the sanctioned image path is still the Rust-mediated one", () => {
  it("no production source reads image bytes in the WebView", () => {
    const byteShapes = new Set(["readAsDataURL", "readAsArrayBuffer", "new FileReader"]);
    const inWebView = scan().filter((f) => byteShapes.has(f.shape));
    expect(
      inWebView,
      "Image/binary bytes must enter through the native picker and Rust's " +
        "inspect_media (magic bytes, 8 MiB, 12,000 px, 40 MP), which returns a " +
        "media:{sha256} handle. A WebView reader bypasses every one of those caps:\n" +
        inWebView.map((u) => `  ${u.file}:${u.line} [${u.shape}]`).join("\n"),
    ).toEqual([]);
  });
});

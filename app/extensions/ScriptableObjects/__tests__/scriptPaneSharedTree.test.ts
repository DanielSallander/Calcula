//! FILENAME: app/extensions/ScriptableObjects/__tests__/scriptPaneSharedTree.test.ts
// PURPOSE: A source-reading pin that the modal form and the modeless pane
//          paint the SAME widget tree — one `FormWidgetTree` module, one
//          `renderWidget` switch, one provenance sentence source — and that
//          the pane's own chrome is theme-token-only text.
// CONTEXT: "The pane renders the same tree as the dialog" is exactly the kind
//          of claim that stays true in prose after a copy has been pasted. The
//          nineteen widget arms are the security surface (no markup, no
//          script-supplied URL); a second copy is a second place for one of
//          them to drift. So the claim is read from the files, not asserted
//          about them.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const EXT_ROOT = path.resolve(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(EXT_ROOT, rel), "utf8");

/** Every .ts/.tsx source file under the extension, tests excluded. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(path.relative(EXT_ROOT, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(EXT_ROOT);
  return out;
}

const TREE = "components/scriptForm/FormWidgetTree.tsx";
const DIALOG = "components/scriptForm/ScriptFormDialog.tsx";
const PANE = "components/scriptPane/ScriptPaneSection.tsx";
const PANE_STYLES = "components/scriptPane/ScriptPaneSection.styles.ts";
const CHROME = "components/scriptForm/hostChrome.tsx";
/** M3c: the third surface — a form the user embedded on a sheet. */
const EMBED = "components/scriptEmbed/ScriptEmbeddedFormSurface.tsx";
const EMBED_STYLES = "components/scriptEmbed/ScriptEmbeddedFormSurface.styles.ts";

/** Every surface that paints the data-only tree. Adding a fourth adds it here. */
const SURFACES = [DIALOG, PANE, EMBED];

describe("one widget tree for two surfaces", () => {
  it("exactly one module defines FormWidgetTree, and it is the form's", () => {
    const defining = sourceFiles().filter((f) => /export function FormWidgetTree\b/.test(read(f)));
    expect(defining).toEqual([TREE]);
  });

  it("exactly one module holds the widget switch (renderWidget)", () => {
    const switching = sourceFiles().filter((f) => /function renderWidget\(/.test(read(f)));
    expect(switching).toEqual([TREE]);
  });

  it("the dialog, the pane and the embedded surface all import the tree from that module — no local copy", () => {
    expect(read(DIALOG)).toMatch(/import \{ FormWidgetTree[^}]*\} from "\.\/FormWidgetTree"/);
    expect(read(PANE)).toMatch(/import \{ FormWidgetTree[^}]*\} from "\.\.\/scriptForm\/FormWidgetTree"/);
    expect(read(EMBED)).toMatch(/import \{ FormWidgetTree[^}]*\} from "\.\.\/scriptForm\/FormWidgetTree"/);
    for (const surface of [PANE, EMBED]) {
      expect(read(surface), surface).toMatch(/<FormWidgetTree\b/);
      // No surface holds a widget arm of its own.
      for (const type of ["textbox", "listbox", "dropdown", "progress", "image", "table"]) {
        expect(read(surface), `${surface} / ${type}`).not.toContain(`case "${type}"`);
      }
    }
  });

  it("the embedded surface drives the SAME store as the pane — not a second one", () => {
    // `landFormPatch` (asserted below) is the shared body; the store is the
    // shared container. A surface with its own store is a second place for
    // "what a patch means" and "what counts as touched" to be decided.
    expect(read(EMBED)).toMatch(/from "\.\.\/\.\.\/lib\/scriptPaneStore"/);
    const defining = sourceFiles().filter((f) => /export function createScriptPaneStore\(/.test(read(f)));
    expect(defining).toEqual(["lib/scriptPaneStore.ts"]);
  });

  it("the tree lays its widgets out under panelLayout, so the pane inherits the sidebar geometry", () => {
    const tree = read(TREE);
    expect(tree).toMatch(/SurfaceLayoutProvider value=\{panelLayout\(width\)\}/);
  });

  it("the HOST's notice banner has one definition, shared by every modeless surface", () => {
    // The rule it carries — a script can neither clear the host's sentence nor
    // have the host's clear delete the script's message — is worth exactly one
    // implementation. It moved out of ScriptPaneSection.tsx when the embedded
    // surface needed it (M3c).
    expect(read(CHROME)).toMatch(/export function HostNoticeBanner\(/);
    const defining = sourceFiles().filter((f) => /function HostNoticeBanner\(/.test(read(f)));
    expect(defining).toEqual([CHROME]);
    for (const surface of [PANE, EMBED]) {
      expect(read(surface), surface).toMatch(/<HostNoticeBanner\b/);
    }
  });

  it("the provenance sentence and the focus lookup have one source, shared by every surface", () => {
    expect(read(CHROME)).toMatch(/export function originPhrase\(/);
    expect(read(CHROME)).toMatch(/export function findFormWidgetFocusable\(/);
    for (const surface of SURFACES) {
      const src = read(surface);
      expect(src, surface).toMatch(/originPhrase/);
      expect(src, surface).toMatch(/findFormWidgetFocusable/);
      // Neither surface branches on an origin NAME; only `kind` reaches the band.
      expect(src, surface).not.toMatch(/origin\.name\s*===/);
    }
    const defining = sourceFiles().filter((f) => /function originPhrase\(/.test(read(f)));
    expect(defining).toEqual([CHROME]);
  });

  it("both surfaces land a host patch through the one shared body", () => {
    for (const surface of [DIALOG, "lib/scriptPaneStore.ts"]) {
      expect(read(surface), surface).toMatch(/landFormPatch\(/);
    }
    const defining = sourceFiles().filter((f) => /export function landFormPatch\(/.test(read(f)));
    expect(defining).toEqual(["lib/scriptFormState.ts"]);
  });
});

describe("the pane's chrome is tokens and text", () => {
  it("paints with theme tokens only — no colour literal", () => {
    const src = read(PANE_STYLES);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\brgba?\(/);
    expect(src).not.toMatch(/\bhsla?\(/);
    // Colours arrive only as `var(--token)` (spelled `${v("--token")}` here).
    expect(src).toMatch(/v\("--/);
    expect(src).toMatch(/`var\(\$\{name\}\)`/);
  });

  it("renders every string as text: no dangerouslySetInnerHTML, no script-supplied URL", () => {
    for (const f of [
      PANE,
      PANE_STYLES,
      "components/scriptPane/createScriptPaneSection.tsx",
      "lib/scriptPaneHost.ts",
      "lib/scriptPaneStore.ts",
      EMBED,
      EMBED_STYLES,
      "lib/scriptEmbedHost.ts",
      "lib/embeddedFormLayer.ts",
    ]) {
      const src = read(f);
      expect(src, f).not.toContain("dangerouslySetInnerHTML");
      expect(src, f).not.toMatch(/\bhref=/);
      expect(src, f).not.toMatch(/<img\b/);
    }
  });
});

describe("the embedded surface's chrome", () => {
  it("is theme tokens, except the ORPHAN colour it shares with the cell-behaviour orphan badge", () => {
    const src = read(EMBED_STYLES);
    expect(src).toMatch(/v\("--/);
    // The one sanctioned exception, declared in the file's own header: the same
    // red `lib/cellBehaviorUx.ts` paints an orphaned binding with, so "this
    // object lost its anchor" looks the same everywhere in the grid.
    const literals = src.match(/rgba?\([^)]*\)/g) ?? [];
    const orphanReds = literals.filter((l) => l.startsWith("rgba(200, 60, 60"));
    expect(orphanReds.length).toBeGreaterThan(0);
    expect(read("lib/cellBehaviorUx.ts")).toContain("rgba(200, 60, 60");
    // ...and nothing else is a colour literal except the shared card shadow.
    for (const literal of literals) {
      expect(literal, literal).toMatch(/^rgba\((200, 60, 60|0, 0, 0)/);
    }
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

//! FILENAME: app/src/api/formDesigner/__tests__/formDesignerAst.test.ts
// PURPOSE: The whole risk of M5 in one file — that the designer's reader and
//          writer never damage a script. Every case here is one of the ways a
//          naive implementation eats a user's code: a marker that is really a
//          string, a second form.define outside the block, a spec built out of
//          variables, CRLF turned into LF, a comment silently deleted, a layout
//          the validator would refuse written to disk before anyone checked.
// CONTEXT: M5a of docs/design/typescript-forms.md §14.
//
//          THE SCAFFOLD IS THE FIXTURE, not a hand-written copy of it
//          (`getScaffoldTemplate("form", …)`, app/src/api/scriptableObjectScaffolds.ts).
//          A copy would keep passing on the day the scaffold changed shape,
//          which is precisely the day the designer would start refusing every
//          newly inserted form.
//
// SABOTAGE NOTE: the byte-identity assertions compare SLICES of the two
// strings, never `toContain` — a suffix check written as "the result still
// contains the run() function" stays green when the writer rewrites the
// indentation of everything after the region, which is the failure this file
// exists to catch.

import { describe, it, expect } from "vitest";

import { getScaffoldTemplate } from "../../scriptableObjectScaffolds";
import type { FormSpec } from "../../scriptHost/scriptFormSpec";
import {
  describeCommentLoss,
  detectEol,
  detectIndentUnit,
  readFormRegion,
  writeFormRegion,
} from "../index";

const SCAFFOLD = getScaffoldTemplate("form", "Form1");

/** A minimal script with `body` between the designer's two markers. */
function scriptWith(body: string, options?: { header?: string; tail?: string }): string {
  return [
    "// @capability ui.dialog",
    "// Form: \"Probe\"",
    ...(options?.header ? [options.header] : []),
    "",
    "function setup(form) {",
    "  // #region Form layout (designer-owned)",
    body,
    "  // #endregion",
    "}",
    ...(options?.tail ? [options.tail] : []),
    "",
  ].join("\n");
}

const SIMPLE_BODY = '  form.define({ title: "Probe", children: [{ type: "label", text: "hi" }] });';

/** `script` with an ordinary JSDoc block above its `setup` function. */
function withJsdocHeader(script: string): string {
  return script.replace(
    /^function setup\(/m,
    ["/**", " * The order form.", " * Bound to the Orders sheet.", " */", "function setup("].join("\n"),
  );
}

/** Deep clone so a test can edit the spec it just read. */
function clone(spec: FormSpec): FormSpec {
  return JSON.parse(JSON.stringify(spec)) as FormSpec;
}

async function readOk(source: string) {
  const result = await readFormRegion(source);
  if (!result.ok) throw new Error(`expected a read, got ${result.refusal.code}: ${result.refusal.message}`);
  return result;
}

async function readRefusal(source: string) {
  const result = await readFormRegion(source);
  if (result.ok) throw new Error("expected a refusal, got a spec");
  return result.refusal;
}

// ============================================================================
// The scaffold
// ============================================================================

describe("formDesigner — the scaffold", () => {
  it("reads the layout the scaffold declares", async () => {
    const read = await readOk(SCAFFOLD);
    expect(read.spec.title).toBe("Form1");
    expect(read.spec.submitLabel).toBe("Save");
    expect(read.spec.width).toBe(460);
    expect(read.spec.children.map((w) => w.type)).toEqual([
      "textbox",
      "dropdown",
      "row",
      "date",
      "checkbox",
      "label",
    ]);
    const textbox = read.spec.children[0] as { name: string; bind: string; maxLength: number };
    expect(textbox.name).toBe("customer");
    expect(textbox.bind).toBe("B2");
    expect(textbox.maxLength).toBe(80);
    const row = read.spec.children[2] as { children: Array<{ name: string; min: number }> };
    expect(row.children.map((w) => w.name)).toEqual(["qty", "price"]);
    expect(row.children[0].min).toBe(1);
    expect(read.calleeText).toBe("form.define");
    expect(read.definesOutsideRegion).toBe(0);
  });

  it("round-trips byte for byte when nothing was edited", async () => {
    const read = await readOk(SCAFFOLD);
    const written = await writeFormRegion(SCAFFOLD, read.spec);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.changed).toBe(false);
    expect(written.source).toBe(SCAFFOLD);
    expect(written.source.length).toBe(SCAFFOLD.length);
  });

  it("still round-trips byte for byte when the spec is an equal COPY, not the same object", async () => {
    // The no-op is decided by structural equality, not by object identity — a
    // designer always hands back a rebuilt tree, never the one it was given.
    const read = await readOk(SCAFFOLD);
    const written = await writeFormRegion(SCAFFOLD, clone(read.spec));
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.changed).toBe(false);
    expect(written.source).toBe(SCAFFOLD);
  });

  it("re-reads its own emitted layout as the same spec", async () => {
    const read = await readOk(SCAFFOLD);
    const edited = clone(read.spec);
    edited.title = "Order entry";
    const written = await writeFormRegion(SCAFFOLD, edited);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.changed).toBe(true);
    const back = await readOk(written.source);
    expect(back.spec).toEqual(edited);
  });
});

// ============================================================================
// Only the region moves
// ============================================================================

describe("formDesigner — a write touches only the region", () => {
  it("leaves every byte before and after the markers identical", async () => {
    const read = await readOk(SCAFFOLD);
    const edited = clone(read.spec);
    edited.children.push({ type: "label", text: "Thank you", style: "muted" });
    const written = await writeFormRegion(SCAFFOLD, edited);
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    const prefixBefore = SCAFFOLD.slice(0, read.region.start);
    const suffixBefore = SCAFFOLD.slice(read.region.end);
    expect(written.source.slice(0, written.region.start)).toBe(prefixBefore);
    expect(written.source.slice(written.region.end)).toBe(suffixBefore);
    // and the region itself really did change
    expect(written.source.slice(written.region.start, written.region.end)).not.toBe(
      SCAFFOLD.slice(read.region.start, read.region.end),
    );
  });

  it("leaves the // @capability pragma above the region untouched", async () => {
    const read = await readOk(SCAFFOLD);
    const edited = clone(read.spec);
    edited.width = 520;
    const written = await writeFormRegion(SCAFFOLD, edited);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(SCAFFOLD.startsWith("// @capability ui.dialog\n")).toBe(true);
    expect(written.source.startsWith("// @capability ui.dialog\n")).toBe(true);
    // The pragma is one line of a header the writer must not reflow at all.
    const header = SCAFFOLD.slice(0, SCAFFOLD.indexOf("function setup"));
    expect(written.source.slice(0, header.length)).toBe(header);
  });

  it("keeps the file's trailing newline and both marker comments verbatim", async () => {
    const read = await readOk(SCAFFOLD);
    const edited = clone(read.spec);
    edited.submitLabel = "Send";
    const written = await writeFormRegion(SCAFFOLD, edited);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.source.endsWith("\n")).toBe(true);
    expect(written.source).toContain(read.region.startComment);
    expect(written.source).toContain(read.region.endComment);
    // The scaffold's label carries a parenthetical the writer must not reword.
    expect(read.region.startComment).toContain("designer-owned");
  });
});

// ============================================================================
// Line endings and indentation
// ============================================================================

describe("formDesigner — line endings and indentation", () => {
  it("keeps a CRLF script CRLF", async () => {
    const crlf = SCAFFOLD.replace(/\n/g, "\r\n");
    expect(detectEol(crlf)).toBe("\r\n");
    const read = await readOk(crlf);
    const edited = clone(read.spec);
    edited.title = "CRLF";
    const written = await writeFormRegion(crlf, edited);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.changed).toBe(true);
    // No lone LF anywhere: every \n in the result is preceded by a \r.
    expect(/[^\r]\n/.test(written.source)).toBe(false);
    expect(written.source).toContain('title: "CRLF"');
    const back = await readOk(written.source);
    expect(back.spec).toEqual(edited);
  });

  it("keeps an LF script LF", async () => {
    expect(detectEol(SCAFFOLD)).toBe("\n");
    const read = await readOk(SCAFFOLD);
    const edited = clone(read.spec);
    edited.title = "LF";
    const written = await writeFormRegion(SCAFFOLD, edited);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.source).not.toContain("\r");
  });

  it("measures the file's indentation step and writes with it", async () => {
    expect(detectIndentUnit(SCAFFOLD)).toBe("  ");
    const tabbed = scriptWith("\tform.define({ children: [{ type: \"label\", text: \"hi\" }] });")
      .replace(/^ {2}\/\/ #(region|endregion)/gm, "\t// #$1");
    expect(detectIndentUnit(tabbed)).toBe("\t");
    const read = await readOk(tabbed);
    const edited = clone(read.spec);
    edited.title = "Tabbed";
    edited.description = "A long enough description to force the object to be printed over several lines.";
    const written = await writeFormRegion(tabbed, edited);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.source).toContain('\t\ttitle: "Tabbed"');
    expect(written.source).not.toContain('\t  title:');
  });

  // A JSDoc header is the most ordinary thing an author puts above their setup
  // function, and its continuation lines start with ONE space and an asterisk.
  // Counted as code indentation they made the smallest gap 1, and the whole
  // layout block was reprinted at one space per level under a file that is
  // indented at four — a fully rewritten block in the diff of a script nobody
  // had restyled. Measured on a FOUR-space file on purpose: a two-space one
  // would come out right by way of the floor below and prove nothing.
  it("does not read a JSDoc continuation line as a one-space indent", () => {
    const fourSpace = [
      "// @capability ui.dialog",
      "/**",
      " * The order form.",
      " * Bound to the Orders sheet.",
      " */",
      "function setup(form) {",
      "    // #region Form layout (designer-owned)",
      '    form.define({ children: [{ type: "label", text: "hi" }] });',
      "    // #endregion",
      "}",
      "",
    ].join("\n");
    expect(detectIndentUnit(fourSpace)).toBe("    ");
    expect(detectIndentUnit(withJsdocHeader(SCAFFOLD))).toBe("  ");

    // A block comment OPENED after code on its line is not seen by the opener
    // rule, which only recognises one that starts the line's own text — the
    // asterisk rule is what catches those continuation lines. Same widths of
    // one, reached the other way.
    const trailingOpen = [
      "// @capability ui.dialog",
      "const HELP = 1; /**",
      " * Why the form binds where it does.",
      " */",
      "function setup(form) {",
      "    // #region Form layout (designer-owned)",
      '    form.define({ children: [{ type: "label", text: "hi" }] });',
      "    // #endregion",
      "}",
      "",
    ].join("\n");
    expect(detectIndentUnit(trailingOpen)).toBe("    ");

    // And prose inside a plain `/* … */` note starts with no asterisk at all,
    // so it is the opener/closer tracking that keeps the writer's own hanging
    // alignment out of the measurement.
    const proseBlock = [
      "// @capability ui.dialog",
      "/*",
      "   Bind these to the Orders sheet",
      "   once the model lands.",
      "*/",
      "function setup(form) {",
      "    // #region Form layout (designer-owned)",
      '    form.define({ children: [{ type: "label", text: "hi" }] });',
      "    // #endregion",
      "}",
      "",
    ].join("\n");
    expect(detectIndentUnit(proseBlock)).toBe("    ");
  });

  // The failure scenario end to end: document the script, drag one widget in,
  // and every line of the rewritten block must still sit on the file's own
  // two-space grid rather than a one-space one.
  it("keeps a documented script's layout block on its own indentation grid", async () => {
    const source = withJsdocHeader(SCAFFOLD);
    const read = await readOk(source);
    const edited = clone(read.spec);
    edited.title = "Documented";
    edited.children.push({ type: "label", text: "added" });
    const written = await writeFormRegion(source, edited);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.changed).toBe(true);
    expect(written.source).toContain('\n    title: "Documented"');
    expect(written.source).not.toContain("\n   title:");
    // Every indented line inside the region, not just the first one: an odd
    // width anywhere is a level printed at the wrong step.
    const region = written.source.slice(written.region.start, written.region.end);
    const odd = region
      .split("\n")
      .map((line) => /^ */.exec(line)?.[0].length ?? 0)
      .filter((width) => width % 2 !== 0);
    expect(odd).toEqual([]);
  });

  // The second line of defence, on its own: nothing else in this file produces
  // a stray width of 1 once comments are skipped, but hand-aligned continuation
  // lines do it just as well, and one space per level is never what an author
  // meant. A measured 1 is nonsense, so it falls back to the scaffold's two.
  it("floors the step at two rather than printing one space per level", () => {
    const aligned = [
      "// @capability ui.dialog",
      "function setup(form) {",
      "  const ready = form.values().a &&",
      "   form.values().b;",
      "  // #region Form layout (designer-owned)",
      '  form.define({ children: [{ type: "label", text: "hi" }] });',
      "  // #endregion",
      "  form.log(ready);",
      "}",
      "",
    ].join("\n");
    expect(detectIndentUnit(aligned)).toBe("  ");
  });
});

// ============================================================================
// The locator is not fooled
// ============================================================================

describe("formDesigner — locating the region", () => {
  it("is not fooled by a marker inside a string literal", async () => {
    const source = scriptWith(SIMPLE_BODY, {
      header: 'const HELP = "// #region Form layout (designer-owned)";',
    });
    const read = await readOk(source);
    // The real marker is the one inside setup(), on the line the scaffold shape
    // puts it — not the decoy on line 3.
    expect(read.region.startLine).toBe(6);
    expect(source.slice(read.region.start, read.region.start + 2)).toBe("//");
    expect(read.spec.title).toBe("Probe");
  });

  it("refuses when the ONLY marker is inside a string literal", async () => {
    const source = [
      "// @capability ui.dialog",
      'const HELP = "// #region Form layout (designer-owned)";',
      "function setup(form) {",
      '  form.define({ children: [{ type: "label", text: "hi" }] });',
      "}",
      "",
    ].join("\n");
    const refusal = await readRefusal(source);
    expect(refusal.code).toBe("no-region");
    expect(refusal.message).toContain("#region Form layout");
  });

  it("is not fooled by a marker inside a block comment", async () => {
    const source = scriptWith(SIMPLE_BODY, {
      header: "/* // #region Form layout (designer-owned) is what the scaffold writes */",
    });
    const read = await readOk(source);
    expect(read.region.startLine).toBe(6);
    expect(read.spec.title).toBe("Probe");
  });

  it("refuses two designer regions rather than picking one", async () => {
    const source = scriptWith(SIMPLE_BODY, {
      tail: ["", "function other(form) {", "  // #region Form layout (designer-owned)", "  // #endregion", "}"].join("\n"),
    });
    const refusal = await readRefusal(source);
    expect(refusal.code).toBe("multiple-regions");
    expect(refusal.message).toContain("2 designer-owned layout blocks");
  });

  it("counts nested #region blocks and ends at the outer #endregion", async () => {
    const body = [
      "  // #region inner grouping",
      SIMPLE_BODY,
      "  // #endregion",
    ].join("\n");
    const source = scriptWith(body);
    const read = await readOk(source);
    expect(read.spec.title).toBe("Probe");
    // The span reaches the LAST #endregion, not the nested one.
    const region = source.slice(read.region.start, read.region.end);
    expect(region.match(/#endregion/g)).toHaveLength(2);
    expect(read.droppedComments.map((c) => c.text)).toEqual([
      "// #region inner grouping",
      "// #endregion",
    ]);
  });

  it("closes the region at an #endregion written at the END of a code line", async () => {
    // The other half of the trailing-trivia fix below: an end-of-line marker is
    // a real comment to the compiler, so the depth walk must count it. Before
    // the trailing scan existed this source refused with "unterminated-region"
    // — harmless, but it made the marker's placement decide whether the file
    // had a region at all.
    const source = [
      "// @capability ui.dialog",
      "function setup(form) {",
      "  // #region Form layout (designer-owned)",
      '  form.define({ title: "Trailing", children: [{ type: "label", text: "hi" }] }); // #endregion',
      "}",
      "",
    ].join("\n");
    const read = await readOk(source);
    expect(read.spec.title).toBe("Trailing");
    expect(read.region.endComment).toBe("// #endregion");
    expect(read.droppedComments).toEqual([]);
  });

  it("refuses a region that is never closed", async () => {
    const source = [
      "// @capability ui.dialog",
      "function setup(form) {",
      "  // #region Form layout (designer-owned)",
      SIMPLE_BODY,
      "}",
      "",
    ].join("\n");
    const refusal = await readRefusal(source);
    expect(refusal.code).toBe("unterminated-region");
    expect(refusal.message).toContain("never closed");
  });
});

// ============================================================================
// Ownership: only the define inside the markers
// ============================================================================

describe("formDesigner — the designer owns only the define inside the markers", () => {
  const TWO_DEFINES = scriptWith('  form.define({ title: "Inside", children: [{ type: "label", text: "in" }] });', {
    tail: [
      "",
      "function reconfigure(form) {",
      '  form.define({ title: "Outside", children: [{ type: "label", text: "out" }] });',
      "}",
    ].join("\n"),
  });

  it("reads the one inside and counts the one outside", async () => {
    const read = await readOk(TWO_DEFINES);
    expect(read.spec.title).toBe("Inside");
    expect(read.definesOutsideRegion).toBe(1);
  });

  it("rewrites the one inside and leaves the one outside byte-identical", async () => {
    const read = await readOk(TWO_DEFINES);
    const edited = clone(read.spec);
    edited.title = "Edited";
    const written = await writeFormRegion(TWO_DEFINES, edited);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.source.slice(written.region.end)).toBe(TWO_DEFINES.slice(read.region.end));
    expect(written.source).toContain('form.define({ title: "Outside"');
    expect(written.source).not.toContain('title: "Inside"');
  });

  it("refuses a region holding code besides the define", async () => {
    const body = ['  const width = 460;', SIMPLE_BODY].join("\n");
    const refusal = await readRefusal(scriptWith(body));
    expect(refusal.code).toBe("extra-code-in-region");
    expect(refusal.message).toContain("const width = 460");
  });

  it("refuses two defines INSIDE the region", async () => {
    const body = [SIMPLE_BODY, SIMPLE_BODY].join("\n");
    const refusal = await readRefusal(scriptWith(body));
    expect(refusal.code).toBe("multiple-defines");
    expect(refusal.message).toContain("declares the form twice");
  });

  it("refuses a marker that cuts a statement in half", async () => {
    const source = [
      "// @capability ui.dialog",
      "function setup(form) {",
      "  form.define({",
      "  // #region Form layout (designer-owned)",
      '    children: [{ type: "label", text: "hi" }],',
      "  // #endregion",
      "  });",
      "}",
      "",
    ].join("\n");
    const refusal = await readRefusal(source);
    expect(refusal.code).toBe("region-cuts-code");
    expect(refusal.message).toContain("in the middle of a statement");
  });

  it("refuses markers that overlap a statement rather than surround it", async () => {
    // The other shape of the same mistake: the opening marker is inside the
    // statement's span but the closing one is not, so no node lies wholly
    // inside the region at all.
    const source = [
      "// @capability ui.dialog",
      "function setup(form) {",
      "  form.define({",
      "  // #region Form layout (designer-owned)",
      '    children: [{ type: "label", text: "hi" }],',
      "  });",
      "  // #endregion",
      "}",
      "",
    ].join("\n");
    const refusal = await readRefusal(source);
    expect(refusal.code).toBe("region-cuts-code");
    expect(refusal.message).toContain("rather than whole lines");
  });
});

// ============================================================================
// Unrepresentable layouts
// ============================================================================

describe("formDesigner — a layout it cannot draw exactly is REFUSED, never approximated", () => {
  const cases: Array<{ what: string; body: string; names: string }> = [
    {
      what: "a spread",
      body: '  form.define({ ...DEFAULTS, children: [{ type: "label", text: "hi" }] });',
      names: "a spread",
    },
    {
      what: "a spread inside children",
      body: '  form.define({ children: [...COMMON, { type: "label", text: "hi" }] });',
      names: "a spread",
    },
    {
      what: "a computed key",
      body: '  form.define({ [KEY]: "x", children: [{ type: "label", text: "hi" }] });',
      names: "a computed key",
    },
    {
      what: "a variable reference",
      body: '  form.define({ title: HEADING, children: [{ type: "label", text: "hi" }] });',
      names: "a reference to a variable",
    },
    {
      what: "a shorthand property",
      body: '  form.define({ title, children: [{ type: "label", text: "hi" }] });',
      names: "a reference to a variable",
    },
    {
      what: "a property lookup",
      body: '  form.define({ title: config.heading, children: [{ type: "label", text: "hi" }] });',
      names: "a reference to a variable",
    },
    {
      what: "a function call",
      body: '  form.define({ title: heading(), children: [{ type: "label", text: "hi" }] });',
      names: "a function call",
    },
    {
      what: "a template string with substitutions",
      body: '  form.define({ title: `Order ${id}`, children: [{ type: "label", text: "hi" }] });',
      names: "a template string with substitutions",
    },
    {
      what: "a function",
      body: '  form.define({ title: "x", children: [{ type: "label", text: "hi" }], focus: () => 1 });',
      names: "a function",
    },
    {
      what: "a calculated expression",
      body: '  form.define({ width: 400 + 60, children: [{ type: "label", text: "hi" }] });',
      names: "a calculated expression",
    },
    {
      what: "a conditional expression",
      body: '  form.define({ width: wide ? 900 : 460, children: [{ type: "label", text: "hi" }] });',
      names: "a conditional expression",
    },
    {
      what: "a type assertion",
      body: '  form.define({ title: "x" as string, children: [{ type: "label", text: "hi" }] });',
      names: "a TypeScript type assertion",
    },
    // Three spellings of the same key, because the runtime treats all three as
    // "set this object's prototype" and only the computed one is already refused.
    {
      what: "a `__proto__` key",
      body: '  form.define({ __proto__: { width: 900 }, children: [{ type: "label", text: "hi" }] });',
      names: "a `__proto__` key",
    },
    {
      what: "a quoted `__proto__` key",
      body: '  form.define({ "__proto__": { width: 900 }, children: [{ type: "label", text: "hi" }] });',
      names: "a `__proto__` key",
    },
    {
      what: "a `__proto__` key on a widget",
      body: '  form.define({ children: [{ type: "label", text: "hi", __proto__: { hidden: true } }] });',
      names: "a `__proto__` key",
    },
  ];

  for (const { what, body, names } of cases) {
    it(`refuses ${what}, naming it and quoting the code`, async () => {
      const refusal = await readRefusal(scriptWith(body));
      expect(refusal.code).toBe("unrepresentable");
      expect(refusal.message).toContain(names);
      expect(refusal.message).toContain("opens in the code editor");
      expect(refusal.line).toBe(6);
      expect(refusal.nodeText).toBeTruthy();
    });
  }

  it("refuses the same property being set twice", async () => {
    const body = '  form.define({ title: "a", title: "b", children: [{ type: "label", text: "hi" }] });';
    const refusal = await readRefusal(scriptWith(body));
    expect(refusal.code).toBe("unrepresentable");
    expect(refusal.message).toContain('sets "title" twice');
  });

  // MEASURED BEFORE THE FIX, on the literal below: the read answered ok with
  // own keys ["title","children"], `spec.width` read 900 THROUGH THE PROTOTYPE
  // CHAIN (so the canvas would draw a 900-wide form the runtime never had —
  // structured clone drops a prototype on the way to the Worker), and the next
  // write emitted the block without the line the author typed. No banner, no
  // refusal, no entry in droppedComments: the only silent deletion in a module
  // whose contract is "exact or nothing". The duplicate-key refusal above could
  // not see it either, because `hasOwnProperty` is never true for a key that
  // never became an own property.
  it("refuses a __proto__ key instead of deleting the line from the script", async () => {
    const source = scriptWith(
      '  form.define({ title: "T", __proto__: { width: 900 }, children: [{ type: "label", text: "hi" }] });',
    );
    const refusal = await readRefusal(source);
    expect(refusal.code).toBe("unrepresentable");
    expect(refusal.nodeText).toBe("__proto__");
    expect(refusal.line).toBe(6);

    // The write refuses for the same reason, so the author's line is still in
    // the file after the drag that used to eat it.
    const written = await writeFormRegion(source, {
      title: "T2",
      children: [{ type: "label", text: "hi" }],
    });
    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.refusal.message).toContain("`__proto__`");
    expect(written).not.toHaveProperty("source");
  });

  it("refuses a repeated __proto__ and a scalar one, the two the duplicate-key guard cannot see", async () => {
    const twice = await readRefusal(
      scriptWith(
        '  form.define({ __proto__: { width: 900 }, __proto__: { width: 400 }, children: [{ type: "label", text: "hi" }] });',
      ),
    );
    expect(twice.message).toContain("`__proto__`");
    // A non-object value makes the prototype setter a no-op, so this one used to
    // vanish with no prototype change and no refusal at all.
    const scalar = await readRefusal(
      scriptWith('  form.define({ title: "T", __proto__: "hello", children: [{ type: "label", text: "hi" }] });'),
    );
    expect(scalar.message).toContain("`__proto__`");
  });

  it("refuses a define that is not handed one object literal", async () => {
    const refusal = await readRefusal(scriptWith("  form.define(LAYOUT);"));
    expect(refusal.code).toBe("define-argument");
    expect(refusal.message).toContain("one plain layout object");
  });

  it("ADMITS the plain values a layout is actually made of", async () => {
    const body = [
      "  form.define({",
      '    title: `Plain template`,',
      "    width: (460),",
      "    submitOnEnter: false,",
      "    focus: undefined,",
      "    children: [",
      '      { type: "number", name: "delta", label: "Delta", min: -5, max: 5, default: 0 },',
      '      { type: "dropdown", name: "region", label: "Region", options: ["EMEA", { value: "APAC", label: "Asia" }] },',
      '      { type: "table", columns: ["Item", "Qty"], rows: [["Widget", 3], ["Gap", null]] },',
      "    ],",
      "  });",
    ].join("\n");
    const read = await readOk(scriptWith(body));
    expect(read.spec.title).toBe("Plain template");
    expect(read.spec.width).toBe(460);
    expect(read.spec.submitOnEnter).toBe(false);
    expect("focus" in read.spec).toBe(false);
    const number = read.spec.children[0] as { min: number; max: number; default: number };
    expect(number.min).toBe(-5);
    expect(number.max).toBe(5);
    expect(number.default).toBe(0);
    const dropdown = read.spec.children[1] as { options: Array<unknown> };
    expect(dropdown.options).toEqual(["EMEA", { value: "APAC", label: "Asia" }]);
    const table = read.spec.children[2] as { rows: Array<Array<unknown>> };
    expect(table.rows).toEqual([["Widget", 3], ["Gap", null]]);
  });

  it("refuses a script that does not compile at all", async () => {
    const refusal = await readRefusal(scriptWith('  form.define({ children: [ });'));
    expect(refusal.code).toBe("parse-error");
    expect(refusal.message).toContain("does not compile");
  });
});

// ============================================================================
// The validator gate, before the write
// ============================================================================

describe("formDesigner — a layout Calcula would refuse is never written", () => {
  it("refuses a spec past MAX_FORM_INPUTS before touching the source", async () => {
    // 65 input widgets, one past MAX_FORM_INPUTS (64) — a literal, so raising
    // the limit reds this test instead of leaving it silently vacuous.
    const spec: FormSpec = {
      children: Array.from({ length: 65 }, (_, i) => ({
        type: "textbox" as const,
        name: `field${i}`,
        label: `Field ${i}`,
      })),
    };
    const written = await writeFormRegion(SCAFFOLD, spec);
    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.refusal.code).toBe("invalid-spec");
    expect(written.refusal.message).toContain("64");
    expect(written.refusal.message).toContain("not written");
    expect(written).not.toHaveProperty("source");
  });

  it("refuses a width outside MIN_FORM_WIDTH..MAX_FORM_WIDTH", async () => {
    const read = await readOk(SCAFFOLD);
    const edited = clone(read.spec);
    edited.width = 5000;
    const written = await writeFormRegion(SCAFFOLD, edited);
    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.refusal.code).toBe("invalid-spec");
    expect(written.refusal.message).toContain("width must be a number between 320 and 1200");
  });

  it("refuses to write into a region it could not read", async () => {
    const source = scriptWith('  form.define({ ...DEFAULTS, children: [{ type: "label", text: "hi" }] });');
    const written = await writeFormRegion(source, {
      children: [{ type: "label", text: "replacement" }],
    });
    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.refusal.code).toBe("unrepresentable");
    expect(written.refusal.message).toContain("a spread");
  });
});

// ============================================================================
// Comments inside the region
// ============================================================================

describe("formDesigner — comments inside the region", () => {
  const WITH_COMMENT = scriptWith(
    ["  // The customer name comes from the order sheet.", SIMPLE_BODY].join("\n"),
  );

  it("reports them on the read so the caller can warn", async () => {
    const read = await readOk(WITH_COMMENT);
    expect(read.droppedComments).toEqual([
      { text: "// The customer name comes from the order sheet.", line: 6 },
    ]);
    expect(describeCommentLoss(read.droppedComments)).toContain("deletes the 1 comment");
    expect(describeCommentLoss(read.droppedComments)).toContain("line 6");
    expect(describeCommentLoss([])).toBeNull();
  });

  it("refuses the write until the caller says it warned the user", async () => {
    const read = await readOk(WITH_COMMENT);
    const edited = clone(read.spec);
    edited.title = "Changed";
    const written = await writeFormRegion(WITH_COMMENT, edited);
    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.refusal.code).toBe("unacknowledged-comment-loss");
    expect(written.refusal.message).toContain("deletes the 1 comment");
  });

  it("writes once acknowledged, and the comment is gone", async () => {
    const read = await readOk(WITH_COMMENT);
    const edited = clone(read.spec);
    edited.title = "Changed";
    const written = await writeFormRegion(WITH_COMMENT, edited, { acknowledgeCommentLoss: true });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.source).not.toContain("comes from the order sheet");
    expect(written.source).toContain('title: "Changed"');
  });

  it("does NOT ask for acknowledgement when nothing changed", async () => {
    // A designer that merely opened and closed must not nag about comments it
    // is not going to touch.
    const read = await readOk(WITH_COMMENT);
    const written = await writeFormRegion(WITH_COMMENT, read.spec);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.changed).toBe(false);
    expect(written.source).toBe(WITH_COMMENT);
  });

  // The case above puts the comment on its OWN line, which is the shape a
  // leading-trivia-only scan happens to catch. The shape a user actually writes
  // in a layout block is one note per widget, at the END of the line — and that
  // is trailing trivia, which `getLeadingCommentRanges` never returns. It was
  // therefore absent from `droppedComments`, `describeCommentLoss` answered
  // null, the panel showed no banner and the first drag deleted both notes with
  // no acknowledgement anywhere.
  const TRAILING_COMMENTS = scriptWith(
    [
      "  form.define({",
      '    title: "Probe",',
      "    children: [",
      '      { type: "textbox", name: "customer", label: "Customer" }, // must match the order sheet',
      '      { type: "checkbox", name: "rush", label: "Rush order" }, // finance sign-off required',
      "    ],",
      "  });",
    ].join("\n"),
  );

  it("reports an end-of-line comment after a widget, not just an own-line one", async () => {
    const read = await readOk(TRAILING_COMMENTS);
    expect(read.droppedComments).toEqual([
      { text: "// must match the order sheet", line: 9 },
      { text: "// finance sign-off required", line: 10 },
    ]);
    expect(describeCommentLoss(read.droppedComments)).toContain("deletes the 2 comments");
    expect(describeCommentLoss(read.droppedComments)).toContain("lines 9, 10");
  });

  it("refuses an unacknowledged write over end-of-line comments", async () => {
    const read = await readOk(TRAILING_COMMENTS);
    const edited = clone(read.spec);
    edited.title = "Edited";
    const written = await writeFormRegion(TRAILING_COMMENTS, edited);
    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.refusal.code).toBe("unacknowledged-comment-loss");
    expect(written.refusal.line).toBe(9);
    // and the write really would have eaten them, which is why it refused
    const forced = await writeFormRegion(TRAILING_COMMENTS, edited, {
      acknowledgeCommentLoss: true,
    });
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    expect(forced.source).not.toContain("must match the order sheet");
    expect(forced.source).not.toContain("finance sign-off required");
  });

  it("reports a BLOCK comment written at the end of a line too", async () => {
    // Same blind spot, same fix: `/* B7 */` after a property is trailing trivia
    // of the comma before it, so the block-comment sweep missed it as well.
    const source = scriptWith(
      [
        "  form.define({",
        '    title: "Probe", /* B7 */',
        '    children: [{ type: "label", text: "hi" }],',
        "  });",
      ].join("\n"),
    );
    const read = await readOk(source);
    expect(read.droppedComments).toEqual([{ text: "/* B7 */", line: 7 }]);
    const edited = clone(read.spec);
    edited.title = "Edited";
    const written = await writeFormRegion(source, edited);
    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.refusal.code).toBe("unacknowledged-comment-loss");
  });

  it("holds the line on the REAL scaffold annotated the way a user would", async () => {
    // The two cases above are hand-built bodies; this one is the shipping
    // scaffold with one note added at the end of one widget line, which is the
    // whole reported failure: read said `droppedComments: []`, the panel showed
    // no banner, one drag wrote `changed: true` and the note was gone. The
    // refusal must fire and the source must still be byte-identical after it,
    // because a refusal that already ate the comment is not a refusal.
    const annotated = SCAFFOLD.replace(
      '{ type: "checkbox", name: "rush",     label: "Rush order" },',
      '{ type: "checkbox", name: "rush",     label: "Rush order" }, // keep this in sync with B7',
    );
    expect(annotated).not.toBe(SCAFFOLD);
    const read = await readOk(annotated);
    expect(read.droppedComments.map((c) => c.text)).toEqual(["// keep this in sync with B7"]);
    const edited = clone(read.spec);
    edited.title = "Changed";
    const written = await writeFormRegion(annotated, edited);
    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.refusal.code).toBe("unacknowledged-comment-loss");
    expect(annotated).toContain("// keep this in sync with B7");
  });
});

// ============================================================================
// One compiler, one chunk
// ============================================================================

describe("formDesigner — the TypeScript compiler is loaded once, by the transpiler", () => {
  // NAMED WITHOUT PARENTHESES OR QUOTES ON PURPOSE: vitest's -t is a REGEX, so
  // a test called `adds no second import("typescript")` can never be selected
  // by name — the parentheses become a group and the run silently matches
  // nothing while still exiting 0. A sabotage run against it reported "no
  // teeth" for a test that had simply never executed.
  it("adds no second dynamic import of the typescript package under formDesigner", async () => {
    // The instruction is in scriptTranspile.ts's `loadScriptTypeScript` doc and
    // in this module's header; a second dynamic import specifier would give the
    // bundle a second ~3.5 MB lazy chunk of the same package, and nothing else
    // would notice. Read the files rather than trusting the comment.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(__dirname, "..");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      // Comment lines are dropped first: every header here explains the rule by
      // quoting the very specifier it forbids, and a census that counted those
      // would be measuring its own documentation.
      const code = fs
        .readFileSync(path.join(dir, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      // A TYPE-only `import type … from "typescript"` is erased at build time
      // and costs nothing; a runtime `import("typescript")` is the chunk.
      expect(code.includes('import("typescript")'), `${file} loads the compiler itself`).toBe(false);
      expect(
        /^import\s+(?!type\b)[^\n]*from\s+"typescript"/m.test(code),
        `${file} imports typescript eagerly`,
      ).toBe(false);
    }
    const transpile = fs.readFileSync(path.resolve(dir, "..", "scriptTranspile.ts"), "utf8");
    expect(transpile).toContain('import("typescript")');
    expect(transpile).toContain("export async function loadScriptTypeScript");
  });
});

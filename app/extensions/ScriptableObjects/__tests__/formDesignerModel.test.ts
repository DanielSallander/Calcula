//! FILENAME: app/extensions/ScriptableObjects/__tests__/formDesignerModel.test.ts
// PURPOSE: The visual designer's tree arithmetic and its two tables — the
//          palette's defaults and the property panel's editors — checked against
//          the ONE authority on what a layout may be, `checkFormSpec`.
// CONTEXT: M5b of docs/design/typescript-forms.md §14.
//
//          WHY THE PALETTE IS TESTED AGAINST THE VALIDATOR AND NOT AGAINST A
//          LIST. A dropped widget is written into the user's script
//          immediately, and `writeFormRegion` runs `checkFormSpec` first — so a
//          default missing a required member is not a rough draft, it is a drop
//          that refuses. Asserting the defaults "look right" would keep passing
//          on the day the validator tightened; asking the validator cannot.
//
//          WHY THE PROPERTY TABLE IS TESTED FOR EXHAUSTIVENESS. `editorFor`
//          answers `null` for a key it has no editor for, and `fieldsForType`
//          skips those — which is exactly how a key added to the spec becomes
//          silently uneditable in the designer while every other test stays
//          green. The assertion below is the only thing standing there.
//
//          AND FOR VALUE TYPE, which is the half that "has an editor" misses. A
//          row whose control commits a string for a key the validator wants a
//          number for is a key nobody can set: every value it can produce is
//          refused by the pre-write `checkFormSpec`. So each editor is asked for
//          a value it could actually commit, and the validator is asked to
//          accept it.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  FORM_SPEC_KEYS,
  FORM_WIDGET_KEYS,
  FORM_WIDGET_TYPES,
  type FormSpec,
  type FormWidget,
  type FormWidgetType,
} from "@api/scriptHost/scriptFormSpec";
import { checkFormSpec } from "@api/scriptHost/validators";

import {
  childListAt,
  describeWidget,
  insertWidget,
  isPrefixPath,
  moveWidget,
  pathKey,
  removeWidget,
  samePath,
  setSpecKey,
  setWidgetKey,
  uniqueWidgetName,
  walkWidgets,
  widgetAt,
  type FormPath,
} from "../components/formDesigner/designerModel";
import {
  editorFor,
  fieldsForType,
  specEditorFor,
  type PropertyField,
} from "../components/formDesigner/propertyFields";
import { PALETTE_OMITTED, WIDGET_PALETTE, newWidgetOfType } from "../components/formDesigner/widgetPalette";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

/** A form with a nested group and a two-page tabs widget. */
function nested(): FormSpec {
  return {
    title: "Order",
    children: [
      { type: "textbox", name: "customer", label: "Customer" },
      {
        type: "group",
        title: "Amounts",
        children: [
          { type: "number", name: "qty", label: "Quantity" },
          { type: "number", name: "price", label: "Price" },
        ],
      },
      {
        type: "tabs",
        pages: [
          { title: "One", children: [{ type: "checkbox", name: "rush", label: "Rush" }] },
          { title: "Two", children: [{ type: "toggle", name: "gift", label: "Gift" }] },
        ],
      },
    ],
  };
}

const at = (...steps: Array<number | [number, number]>): FormPath =>
  steps.map((step) => (Array.isArray(step) ? { index: step[0], page: step[1] } : { index: step }));

const typeNames = (list: FormWidget[] | null): string[] => (list ?? []).map((w) => w.type);
const names = (list: FormWidget[] | null): Array<string | undefined> => (list ?? []).map((w) => w.name);

// ----------------------------------------------------------------------------
// Addressing
// ----------------------------------------------------------------------------

describe("addressing a widget by where it sits", () => {
  it("resolves a top-level widget, a widget in a group, and one on a tabs page", () => {
    const spec = nested();
    expect(widgetAt(spec, at(0))?.name).toBe("customer");
    expect(widgetAt(spec, at(1, 0))?.name).toBe("qty");
    expect(widgetAt(spec, at([2, 1], 0))?.name).toBe("gift");
  });

  it("answers null for a path nothing is at, rather than the nearest thing", () => {
    const spec = nested();
    expect(widgetAt(spec, at(9))).toBeNull();
    expect(widgetAt(spec, at(0, 0))).toBeNull();
    expect(childListAt(spec, at([2, 7]))).toBeNull();
  });

  it("gives a page-carrying path its own key, so two pages are two positions", () => {
    expect(pathKey(at([2, 0], 0))).not.toBe(pathKey(at([2, 1], 0)));
    expect(samePath(at([2, 0]), at([2, 1]))).toBe(false);
  });

  it("walks every widget in the tree, pages included", () => {
    const found = walkWidgets(nested()).map((entry) => entry.widget.type);
    expect(found).toEqual([
      "textbox", "group", "number", "number", "tabs", "checkbox", "toggle",
    ]);
  });
});

// ----------------------------------------------------------------------------
// Editing
// ----------------------------------------------------------------------------

describe("insert, remove and move", () => {
  it("inserts at an index and reports the path the caller should select", () => {
    const spec = nested();
    const widget: FormWidget = { type: "spacer", size: 8 };
    const { spec: next, path } = insertWidget(spec, [], 1, widget);
    expect(typeNames(next.children)).toEqual(["textbox", "spacer", "group", "tabs"]);
    expect(widgetAt(next, path)).toEqual(widget);
    // The spec it was given is untouched.
    expect(typeNames(spec.children)).toEqual(["textbox", "group", "tabs"]);
  });

  it("removes a widget and selects what slid into its place", () => {
    const { spec, path } = removeWidget(nested(), at(0));
    expect(typeNames(spec.children)).toEqual(["group", "tabs"]);
    expect(widgetAt(spec, path)?.type).toBe("group");
  });

  it("reorders within one container", () => {
    // Index 2 is "after the widget currently at 1" — the list is measured
    // BEFORE the removal, which is the contract the panel's Ctrl+Arrow relies on.
    const { spec } = moveWidget(nested(), at(0), [], 2);
    expect(names(spec.children)).toEqual([undefined, "customer", undefined]);
    expect(typeNames(spec.children)).toEqual(["group", "textbox", "tabs"]);
  });

  it("moves a widget INTO a group and out again", () => {
    const first = moveWidget(nested(), at(0), at(1), 0);
    expect(typeNames(first.spec.children)).toEqual(["group", "tabs"]);
    expect(names(childListAt(first.spec, at(0)))).toEqual(["customer", "qty", "price"]);
    expect(widgetAt(first.spec, first.path)?.name).toBe("customer");

    const back = moveWidget(first.spec, first.path, [], 0);
    expect(names(back.spec.children)).toEqual(["customer", undefined, undefined]);
    expect(names(childListAt(back.spec, at(1)))).toEqual(["qty", "price"]);
  });

  it("re-measures the target container after the removal shifted it", () => {
    // The group is at index 1 BEFORE the textbox at index 0 is taken out of the
    // list; without the adjustment the insert lands in the tabs widget instead.
    const { spec } = moveWidget(nested(), at(0), at(1), 2);
    expect(names(childListAt(spec, at(0)))).toEqual(["qty", "price", "customer"]);
    expect(typeNames(spec.children)).toEqual(["group", "tabs"]);
  });

  it("moves a widget onto a tabs page", () => {
    const { spec, path } = moveWidget(nested(), at(0), at([2, 1]), 1);
    expect(names(childListAt(spec, at([1, 1])))).toEqual(["gift", "customer"]);
    expect(widgetAt(spec, path)?.name).toBe("customer");
  });

  it("refuses to move a container into itself or into its own descendant", () => {
    const spec = nested();
    expect(isPrefixPath(at(1), at(1, 0))).toBe(true);
    const intoSelf = moveWidget(spec, at(1), at(1), 0);
    expect(intoSelf.spec).toBe(spec);
    expect(typeNames(intoSelf.spec.children)).toEqual(["textbox", "group", "tabs"]);
  });

  it("treats a move that changes nothing as a no-op, returning the same spec", () => {
    const spec = nested();
    expect(moveWidget(spec, at(0), [], 0).spec).toBe(spec);
    expect(moveWidget(spec, at(0), [], 1).spec).toBe(spec);
  });
});

describe("setting one key", () => {
  it("changes exactly that key and leaves every other member identical", () => {
    const spec = nested();
    const before = widgetAt(spec, at(1, 0)) as Record<string, unknown>;
    const next = setWidgetKey(spec, at(1, 0), "min", 1);
    const after = widgetAt(next, at(1, 0)) as Record<string, unknown>;
    expect(after.min).toBe(1);
    for (const key of Object.keys(before)) {
      expect(after[key], key).toEqual(before[key]);
    }
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), "min"].sort());
  });

  it("removes the key when the value is undefined, rather than writing a default", () => {
    const spec = setWidgetKey(nested(), at(0), "required", true);
    expect(widgetAt(spec, at(0))).toHaveProperty("required", true);
    const cleared = setWidgetKey(spec, at(0), "required", undefined);
    expect(Object.keys(widgetAt(cleared, at(0)) as object)).not.toContain("required");
  });

  it("returns the SAME spec when the value is already what was asked for", () => {
    const spec = nested();
    expect(setWidgetKey(spec, at(0), "label", "Customer")).toBe(spec);
    expect(setSpecKey(spec, "title", "Order")).toBe(spec);
    expect(setSpecKey(spec, "description", undefined)).toBe(spec);
  });

  it("sets and clears a form-level key", () => {
    const withWidth = setSpecKey(nested(), "width", 500);
    expect(withWidth.width).toBe(500);
    expect(setSpecKey(withWidth, "width", undefined)).not.toHaveProperty("width");
  });
});

describe("naming", () => {
  it("mints a name nothing anywhere in the tree is using", () => {
    const spec = nested();
    expect(uniqueWidgetName(spec, "qty")).toBe("qty2");
    // Taken on a TABS PAGE, which a container-local search would miss.
    expect(uniqueWidgetName(spec, "gift")).toBe("gift2");
    expect(uniqueWidgetName(spec, "fresh")).toBe("fresh");
  });

  it("describes a widget by what it is and what it says", () => {
    expect(describeWidget({ type: "textbox", name: "customer", label: "Customer" })).toContain("customer");
    expect(describeWidget({ type: "label", text: "Total" })).toContain("Total");
    expect(describeWidget({ type: "spacer" })).toBe("spacer");
  });
});

// ----------------------------------------------------------------------------
// The palette
// ----------------------------------------------------------------------------

describe("the palette's defaults", () => {
  it("offers every widget type the spec declares, except the reserved html", () => {
    expect([...PALETTE_OMITTED].sort()).toEqual(["html"].filter((t) => FORM_WIDGET_TYPES.includes(t as FormWidgetType)));
    expect(WIDGET_PALETTE.map((e) => e.type).sort()).toEqual(
      FORM_WIDGET_TYPES.filter((t) => t !== "html").slice().sort(),
    );
  });

  it("every default is a layout Calcula ACCEPTS — asked of checkFormSpec, not of a list", () => {
    const base = nested();
    for (const entry of WIDGET_PALETTE) {
      const widget = newWidgetOfType(entry.type, base);
      const spec: FormSpec = { children: [widget] };
      expect(checkFormSpec(spec), entry.type).toBe(true);
    }
  });

  it("a default dropped into a form that already uses its name gets a fresh one", () => {
    const spec: FormSpec = { children: [{ type: "textbox", name: "textbox", label: "First" }] };
    const widget = newWidgetOfType("textbox", spec);
    expect(widget.name).toBe("textbox2");
    const combined: FormSpec = { children: [...spec.children, widget] };
    expect(checkFormSpec(combined)).toBe(true);
  });

  it("an image default carries no bytes and no URL — only the empty handle", () => {
    expect(newWidgetOfType("image", nested())).toEqual({ type: "image", src: "", alt: "Image" });
  });
});

// ----------------------------------------------------------------------------
// The property table
// ----------------------------------------------------------------------------

describe("the property panel's editors", () => {
  it("has an editor for EVERY key the spec allows each widget type to carry", () => {
    const missing: string[] = [];
    for (const type of FORM_WIDGET_TYPES) {
      if (type === "html") continue;
      for (const key of FORM_WIDGET_KEYS[type]) {
        if (editorFor(type, key) === null) missing.push(`${type}.${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("has an editor for every FORM-level key", () => {
    const missing = FORM_SPEC_KEYS.filter((key) => specEditorFor(key) === null);
    expect(missing).toEqual([]);
  });

  it("offers no key the validator would refuse", () => {
    for (const type of FORM_WIDGET_TYPES) {
      if (type === "html") continue;
      const allowed = new Set(FORM_WIDGET_KEYS[type]);
      for (const field of fieldsForType(type)) {
        expect(allowed.has(field.key), `${type}.${field.key}`).toBe(true);
      }
    }
  });

  it("reads a key as the type that key actually holds, per widget", () => {
    // The same key name means different things on different widgets, and a
    // single key->editor table would offer a text box for a grid's column count.
    expect(editorFor("table", "columns")).toEqual({ kind: "stringList", itemLabel: "Heading" });
    expect(editorFor("grid", "columns")?.kind).toBe("number");
    expect(editorFor("listbox", "rows")?.kind).toBe("number");
    expect(editorFor("table", "rows")?.kind).toBe("structural");
    expect(editorFor("checkbox", "default")?.kind).toBe("boolean");
    expect(editorFor("number", "default")?.kind).toBe("number");
    expect(editorFor("textbox", "default")?.kind).toBe("text");
    expect(editorFor("number", "min")?.kind).toBe("number");
    expect(editorFor("date", "min")?.kind).toBe("text");
    // A progress bar's ceiling is a NUMBER (`max > 0`), a date field's is a
    // date string — the same key name, two value types, and the date box was
    // once offered for both.
    expect(editorFor("progress", "max")?.kind).toBe("number");
    expect(editorFor("number", "max")?.kind).toBe("number");
    expect(editorFor("date", "max")?.kind).toBe("text");
  });

  it("offers no editor whose own value the validator would refuse", () => {
    // EXHAUSTIVENESS IS ABOUT VALUE TYPES, not just key names. `editorFor`
    // answering non-null only proves a row appears; the row is USEFUL only if
    // what its control can commit is something `checkFormSpec` accepts. A
    // progress bar's `max` had an editor — the date text box — so every value
    // typed into it was refused and the key could not be set from the designer
    // at all.
    const refused: string[] = [];
    for (const type of FORM_WIDGET_TYPES) {
      if (type === "html") continue;
      const base = newWidgetOfType(type, { children: [] });
      for (const field of fieldsForType(type)) {
        if (field.editor.kind === "structural") continue;
        const value = representativeValue(field);
        const widget = { ...base, [field.key]: value } as FormWidget;
        const verdict = checkFormSpec({ children: [widget] });
        if (verdict !== true) refused.push(`${type}.${field.key} = ${JSON.stringify(value)}: ${verdict}`);
      }
    }
    expect(refused).toEqual([]);
  });
});

/**
 * A value the panel's own control can commit for one field.
 *
 * Derived from the EDITOR and never from the key — that is the whole point:
 * `parseValue` (DesignerProperties.tsx) can produce a string, a number, a
 * boolean, a listed choice, a list of strings or `number | "fill"`, and nothing
 * else, so this is what the row would put in the script. The three keys named
 * below accept a narrower language than "a string" (an identifier, a cell
 * reference, a media handle) and their placeholders ask the user for exactly
 * that shape; a date box is answered with a date for the same reason. Numbers
 * take the editor's own floor where it has one, so a key whose bound the editor
 * does not carry is a key this test cannot vouch for — `step`, whose editor has
 * no floor and whose validator wants `> 0`, is the one such row today.
 */
function representativeValue(field: PropertyField): unknown {
  const editor = field.editor;
  switch (editor.kind) {
    case "text":
      if (field.key === "name") return "widget1";
      if (field.key === "bind") return "B2";
      if (field.key === "src") return "";
      return editor.placeholder === "YYYY-MM-DD" ? "2026-01-01" : "Text";
    case "number": {
      const floor = Math.max(1, editor.min ?? 1);
      return editor.max !== undefined && floor > editor.max ? editor.max : floor;
    }
    case "boolean":
      return true;
    case "choice":
      return editor.values[0];
    case "stringList":
      return ["Option 1"];
    case "widthOrFill":
      return 100;
    case "structural":
      return undefined;
  }
}

// ----------------------------------------------------------------------------
// What the designer is allowed to touch
// ----------------------------------------------------------------------------

describe("the designer's only write path", () => {
  const DIR = path.resolve(__dirname, "../components/formDesigner");
  const sources = fs
    .readdirSync(DIR)
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(DIR, f), "utf8") }));

  it("writes only through the AST writer — nothing here saves, mounts or invokes", () => {
    for (const { file, text } of sources) {
      // The designer edits the BUFFER. A save call here would be a second write
      // path that bypasses the live-persist rules and the code editor alike.
      expect(text, file).not.toMatch(/saveObjectScript|saveWorkbookScript|emitSaveAndApply/);
      expect(text, file).not.toMatch(/invokeBackend|@tauri-apps/);
      expect(text, file).not.toMatch(/localStorage|sessionStorage/);
    }
    const joined = sources.map((s) => s.text).join("\n");
    expect(joined).toMatch(/writeFormRegion/);
    expect(joined).toMatch(/from "@api\/formDesigner"/);
  });

  it("paints through the ONE shared widget tree, never a copy of the switch", () => {
    const canvas = sources.find((s) => s.file === "DesignerCanvas.tsx");
    expect(canvas).toBeDefined();
    expect(canvas?.text).toMatch(/import \{ FormWidgetTree[^}]*\} from "\.\.\/scriptForm\/FormWidgetTree"/);
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/function renderWidget\(/);
      expect(text, file).not.toMatch(/export function FormWidgetTree\b/);
    }
  });

  it("uses the shared drag gesture rather than a second one", () => {
    const joined = sources.map((s) => s.text).join("\n");
    expect(joined).toMatch(/_shared\/components\/useDragDrop/);
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/addEventListener\(\s*["']mousemove/);
      expect(text, file).not.toMatch(/addEventListener\(\s*["']mouseup/);
    }
  });
});

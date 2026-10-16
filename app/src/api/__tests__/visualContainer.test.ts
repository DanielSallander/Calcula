//! FILENAME: app/src/api/__tests__/visualContainer.test.ts
// PURPOSE: The pure half of @api/visualContainer: the edit-path validation
//          (the SAME sentences Rust `visual_format::validate` writes -- the S1
//          table), patching, bound > stored > defaults resolution, heading
//          sizes, the layout arithmetic, the JSON-Schema fragment agreeing with
//          the validator, and the controls' flat-key map.

import { describe, it, expect } from "vitest";
import {
  BASE_CONTAINER_DEFAULTS,
  CONTROL_CONTAINER_PROPERTY_KEYS,
  VISUAL_CONTAINER_FIELD_IDS,
  VISUAL_CONTAINER_FIELD_TYPES,
  VISUAL_CONTAINER_JSON_SCHEMA,
  VISUAL_CONTAINER_LIMITS,
  applyVisualContainerPatch,
  checkContainerFieldValue,
  checkControlContainerValue,
  containerFieldIdOfPointer,
  containerFieldPatch,
  containerFieldPointer,
  containerFieldRange,
  controlContainerKey,
  controlContainerKeyField,
  headingFontSize,
  isEmptyVisualContainer,
  isSafeFontFamily,
  isSafeVisualColor,
  layoutVisualContainer,
  lineHeightFor,
  readContainerField,
  resolveVisualContainer,
  validateVisualContainer,
  validateVisualContainerPatch,
  type ContainerFieldId,
  type ResolvedVisualContainer,
  type VisualContainerFormat,
  type VisualContainerPatch,
} from "../visualContainer";

/** Build a container with ONE leaf set, by dotted id (bypasses the TS types on purpose). */
function withLeaf(id: string, value: unknown): Record<string, unknown> {
  const [group, leaf] = id.split(".");
  return leaf === undefined ? { [group]: value } : { [group]: { [leaf]: value } };
}

function defaults(over: Partial<ResolvedVisualContainer> = {}): ResolvedVisualContainer {
  return { ...structuredClone(BASE_CONTAINER_DEFAULTS), ...over };
}

// ============================================================================
// validate: the Rust sentences
// ============================================================================

describe("validateVisualContainer -- the Rust sentences (visual_format::validate_sentences_are_pinned)", () => {
  it("pins every sentence Rust pins, word for word", () => {
    expect(validateVisualContainer({ title: { fontSize: 97 } })).toBe("title.fontSize must be a number from 6 to 96.");
    expect(validateVisualContainer({ title: { headingLevel: 7 } })).toBe(
      "title.headingLevel must be a whole number from 0 to 6.",
    );
    expect(validateVisualContainer({ border: { color: "red" } })).toBe(
      "border.color must be empty or a #rgb, #rrggbb or #rrggbbaa colour.",
    );
    expect(validateVisualContainer({ subtitle: { fontFamily: "Arial; x" } })).toBe(
      "subtitle.fontFamily must be at most 64 letters, digits, spaces, commas, apostrophes or hyphens.",
    );
    expect(validateVisualContainer({ title: { text: "x".repeat(1025) } })).toBe(
      "title.text must be text of at most 1024 characters.",
    );
    expect(
      validateVisualContainer({ background: { gradient: { type: "linear", stops: [{ offset: 0, color: "#000" }] } } }),
    ).toBe("background.gradient must have from 2 to 8 stops.");
    // First bad leaf wins, in field order.
    expect(validateVisualContainer({ shadow: { blur: 99 }, padding: { left: -1 } })).toBe(
      "padding.left must be a number from 0 to 200.",
    );
    // The gradient is checked after background.transparency, before border.
    expect(
      validateVisualContainer({
        border: { width: 99 },
        background: { transparency: 5, gradient: { type: "linear", stops: [{ offset: 0, color: "#000" }] } },
      }),
    ).toBe("background.gradient must have from 2 to 8 stops.");
    expect(validateVisualContainer({ title: { align: "middle" } })).toBe(
      "title.align must be one of: left, center, right.",
    );
    expect(validateVisualContainer({ divider: { show: "yes" } })).toBe("divider.show must be true or false.");
  });

  it("refuses each limit + 1 and accepts each limit, for every numeric field (17)", () => {
    let checked = 0;
    for (const id of VISUAL_CONTAINER_FIELD_IDS) {
      const range = containerFieldRange(id);
      if (!range) continue;
      const [min, max] = range;
      const kind = VISUAL_CONTAINER_FIELD_TYPES[id] === "integer" ? "a whole number" : "a number";
      const sentence = `${id} must be ${kind} from ${min} to ${max}.`;
      expect(validateVisualContainer(withLeaf(id, max)), `${id} at max`).toBeNull();
      expect(validateVisualContainer(withLeaf(id, min)), `${id} at min`).toBeNull();
      expect(validateVisualContainer(withLeaf(id, max + 1)), `${id} over`).toBe(sentence);
      expect(validateVisualContainer(withLeaf(id, min - 1)), `${id} under`).toBe(sentence);
      expect(validateVisualContainer(withLeaf(id, NaN)), `${id} NaN`).toBe(sentence);
      expect(validateVisualContainer(withLeaf(id, Infinity)), `${id} Infinity`).toBe(sentence);
      expect(validateVisualContainer(withLeaf(id, String(min))), `${id} as a string`).toBe(sentence);
      checked++;
    }
    expect(checked).toBe(17);
    // A whole-number field refuses a fraction; a number field accepts one.
    expect(validateVisualContainer({ title: { headingLevel: 2.5 } })).toBe(
      "title.headingLevel must be a whole number from 0 to 6.",
    );
    expect(validateVisualContainer({ title: { fontSize: 10.5 } })).toBeNull();
  });

  it("refuses every unsafe colour on every colour field, and accepts the safe ones", () => {
    const unsafe = ["red", "url(x)", "#12345", "#1234567", "javascript:", "#ggg", "#1234", "rgb(1,2,3)", " #fff", "#fff "];
    const safe = ["", "#abc", "#AABBCC", "#aabbccdd", "#09F"];
    const colourIds = VISUAL_CONTAINER_FIELD_IDS.filter((id) => VISUAL_CONTAINER_FIELD_TYPES[id] === "color");
    expect(colourIds.length).toBe(8);
    for (const id of colourIds) {
      for (const bad of unsafe) {
        expect(validateVisualContainer(withLeaf(id, bad)), `${id} accepted ${bad}`).toBe(
          `${id} must be empty or a #rgb, #rrggbb or #rrggbbaa colour.`,
        );
        expect(isSafeVisualColor(bad)).toBe(false);
      }
      for (const good of safe) {
        expect(validateVisualContainer(withLeaf(id, good)), `${id} refused ${good}`).toBeNull();
        expect(isSafeVisualColor(good)).toBe(true);
      }
    }
  });

  it("bounds font families and texts like Rust (UTF-16 units, as String.length counts)", () => {
    expect(isSafeFontFamily("Segoe UI, Arial, sans-serif")).toBe(true);
    expect(isSafeFontFamily("'Times New Roman'")).toBe(true);
    expect(isSafeFontFamily("")).toBe(true);
    expect(isSafeFontFamily("Arial;color:red")).toBe(false);
    expect(isSafeFontFamily("url(x)")).toBe(false);
    expect(isSafeFontFamily('"Arial"')).toBe(false);
    expect(isSafeFontFamily("a".repeat(64))).toBe(true);
    expect(isSafeFontFamily("a".repeat(65))).toBe(false);
    expect(validateVisualContainer({ title: { text: "x".repeat(1024) } })).toBeNull();
    expect(validateVisualContainer({ subtitle: { text: "x".repeat(1025) } })).toBe(
      "subtitle.text must be text of at most 1024 characters.",
    );
    expect(validateVisualContainer({ title: { text: "\u{1F600}".repeat(512) } })).toBeNull();
    expect(validateVisualContainer({ title: { text: "\u{1F600}".repeat(513) } })).not.toBeNull();
  });

  it("gradients: 2..8 stops, offsets 0..1, non-empty safe colours (stop n counts from 1)", () => {
    const grad = (stops: unknown) => ({ background: { gradient: { type: "linear", stops } } });
    const stops = (n: number) => Array.from({ length: n }, (_, i) => ({ offset: i / 10, color: "#000" }));
    expect(validateVisualContainer(grad(stops(1)))).toBe("background.gradient must have from 2 to 8 stops.");
    expect(validateVisualContainer(grad(stops(2)))).toBeNull();
    expect(validateVisualContainer(grad(stops(8)))).toBeNull();
    expect(validateVisualContainer(grad(stops(9)))).toBe("background.gradient must have from 2 to 8 stops.");
    expect(validateVisualContainer(grad([{ offset: 0, color: "#000" }, { offset: 1.5, color: "#fff" }]))).toBe(
      "background.gradient stop 2 offset must be a number from 0 to 1.",
    );
    expect(validateVisualContainer(grad([{ offset: 0, color: "" }, { offset: 1, color: "#fff" }]))).toBe(
      "background.gradient stop 1 colour must be a #rgb, #rrggbb or #rrggbbaa colour.",
    );
    expect(validateVisualContainer(grad([{ offset: 0, color: "#000" }, { offset: 1, color: "red" }]))).not.toBeNull();
    // TS-only structure sentences (Rust refuses these at deserialization).
    expect(validateVisualContainer({ background: { gradient: { stops: stops(2) } } })).toBe(
      "background.gradient type must be one of: linear, radial.",
    );
    expect(validateVisualContainer({ background: { gradient: { type: "radial" } } })).toBe(
      "background.gradient must have from 2 to 8 stops.",
    );
    expect(
      validateVisualContainer({ background: { gradient: { type: "linear", direction: "up", stops: stops(2) } } }),
    ).toMatch(/^background\.gradient direction must be one of: topToBottom, /);
  });

  it("refuses unknown keys and non-objects (Rust would silently drop them; the edit path says so)", () => {
    expect(validateVisualContainer({ title: { nope: 1 } })).toBe("title.nope is not a visual container field.");
    expect(validateVisualContainer({ nope: {} })).toBe("nope is not a visual container field.");
    expect(validateVisualContainer({ title: 3 })).toBe("title must be an object.");
    expect(validateVisualContainer("x")).toBe("The visual container must be an object.");
    expect(validateVisualContainer({ border: { gradient: {} } })).toBe("border.gradient is not a visual container field.");
    // Absent / null is no container at all, and a null leaf is an absent leaf (as Rust reads JSON null).
    expect(validateVisualContainer(undefined)).toBeNull();
    expect(validateVisualContainer(null)).toBeNull();
    expect(validateVisualContainer({ title: { fontSize: null }, border: null })).toBeNull();
  });

  it("a full container (the Rust round-trip fixture) is valid", () => {
    const full = {
      padding: { top: 4, right: 6, bottom: 8, left: 10 },
      lockAspect: true,
      title: {
        show: true, text: "Sales", headingLevel: 2, fontFamily: "Segoe UI", fontSize: 14, bold: true, italic: false,
        underline: false, color: "#123", background: "#ffffff80", align: "center", wrap: true,
      },
      subtitle: { show: true, text: "FY", fontSize: 10, align: "left" },
      divider: { show: true, color: "#ccc", style: "dashed", width: 1, ignorePadding: true },
      spacing: { custom: true, belowTitle: 2, belowSubtitle: 3, belowDivider: 4 },
      background: {
        show: true, color: "#fff", transparency: 20,
        gradient: { type: "linear", direction: "leftToRight", stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#ffffff" }] },
      },
      border: { show: true, color: "#000", width: 2, radius: 12 },
      shadow: { show: true, color: "#00000040", transparency: 50, offset: "inside", position: "topLeft", blur: 4, distance: 3 },
    };
    expect(validateVisualContainer(full)).toBeNull();
  });

  it("checkContainerFieldValue names the leaf by the label it is given", () => {
    expect(checkContainerFieldValue("border.width", 21)).toBe("border.width must be a number from 0 to 20.");
    expect(checkContainerFieldValue("border.width", 21, "strokeWidth")).toBe("strokeWidth must be a number from 0 to 20.");
    expect(checkContainerFieldValue("border.width", 20)).toBeNull();
  });
});

// ============================================================================
// Patches
// ============================================================================

describe("patches", () => {
  it("a null leaf clears it, a null group clears the group, the input is never mutated", () => {
    const f: VisualContainerFormat = { title: { show: true, fontSize: 14 }, border: { show: true, width: 2 } };
    const before = JSON.stringify(f);
    const out = applyVisualContainerPatch(f, { title: { fontSize: null, bold: true }, border: null });
    expect(out).toEqual({ title: { show: true, bold: true } });
    expect(JSON.stringify(f)).toBe(before);
  });

  it("returns undefined when nothing is left (the record carries no key)", () => {
    expect(applyVisualContainerPatch({ border: { show: true } }, { border: { show: null } })).toBeUndefined();
    expect(applyVisualContainerPatch(undefined, {})).toBeUndefined();
    expect(applyVisualContainerPatch({ lockAspect: true }, { lockAspect: null })).toBeUndefined();
    expect(applyVisualContainerPatch(undefined, { lockAspect: false })).toEqual({ lockAspect: false });
  });

  it("the gradient is written and cleared WHOLE, and deep-copied", () => {
    const gradient = { type: "linear" as const, stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] };
    const out = applyVisualContainerPatch({ background: { color: "#fff" } }, { background: { gradient } });
    expect(out?.background?.gradient).toEqual(gradient);
    gradient.stops[0].color = "#f00";
    expect(out?.background?.gradient?.stops[0].color).toBe("#000");
    expect(applyVisualContainerPatch(out, { background: { gradient: null } })).toEqual({ background: { color: "#fff" } });
  });

  it("validateVisualContainerPatch accepts nulls and refuses bad leaves", () => {
    expect(validateVisualContainerPatch({ title: { fontSize: null }, border: null, lockAspect: null })).toBeNull();
    expect(validateVisualContainerPatch({ title: { fontSize: 200 } })).toBe("title.fontSize must be a number from 6 to 96.");
    expect(validateVisualContainerPatch({ title: { nope: null } })).toBe("title.nope is not a visual container field.");
  });

  it("containerFieldPatch / readContainerField / pointers round-trip every field id", () => {
    for (const id of VISUAL_CONTAINER_FIELD_IDS) {
      const patch = containerFieldPatch(id, "probe" as unknown) as VisualContainerPatch;
      const applied = applyVisualContainerPatch(undefined, patch);
      expect(readContainerField(applied, id), id).toBe("probe");
      const cleared = applyVisualContainerPatch(applied, containerFieldPatch(id, null));
      expect(cleared, id).toBeUndefined();
      expect(containerFieldIdOfPointer(containerFieldPointer(id))).toBe(id);
    }
    expect(containerFieldPointer("title.fontSize")).toBe("/title/fontSize");
    expect(containerFieldPointer("lockAspect")).toBe("/lockAspect");
    expect(containerFieldIdOfPointer("/title/nope")).toBeNull();
    expect(containerFieldIdOfPointer("/background/gradient")).toBeNull();
  });

  it("isEmptyVisualContainer", () => {
    expect(isEmptyVisualContainer(undefined)).toBe(true);
    expect(isEmptyVisualContainer({})).toBe(true);
    expect(isEmptyVisualContainer({ border: {} })).toBe(true);
    expect(isEmptyVisualContainer({ border: { show: false } })).toBe(false);
    expect(isEmptyVisualContainer({ lockAspect: false })).toBe(false);
  });
});

// ============================================================================
// Resolution: bound > stored > defaults
// ============================================================================

describe("resolveVisualContainer -- bound > stored > defaults, per leaf", () => {
  it("absent everywhere = the defaults (a fresh object, never the frozen base)", () => {
    const r = resolveVisualContainer(undefined, BASE_CONTAINER_DEFAULTS);
    expect(r).toEqual(BASE_CONTAINER_DEFAULTS);
    expect(r).not.toBe(BASE_CONTAINER_DEFAULTS);
    expect(r.title).not.toBe(BASE_CONTAINER_DEFAULTS.title);
    expect(Object.isFrozen(BASE_CONTAINER_DEFAULTS.title)).toBe(true);
  });

  it("stored beats the default; bound beats stored (title.color has BOTH)", () => {
    const stored: VisualContainerFormat = { title: { color: "#111111", show: true } };
    expect(resolveVisualContainer(stored, defaults()).title.color).toBe("#111111");
    const bound = new Map<ContainerFieldId, unknown>([["title.color", "#222222"]]);
    const r = resolveVisualContainer(stored, defaults(), bound);
    expect(r.title.color).toBe("#222222");
    expect(r.title.show).toBe(true); // an unbound leaf still reads the stored literal
  });

  it("an INVALID bound value falls back to the STORED literal, not the default", () => {
    const stored: VisualContainerFormat = { title: { color: "#111111", fontSize: 18 }, border: { width: 3 } };
    const bound = new Map<ContainerFieldId, unknown>([
      ["title.color", "rgb(1,2,3)"],
      ["title.fontSize", 500],
      ["border.width", "3px"],
    ]);
    const r = resolveVisualContainer(stored, defaults(), bound);
    expect(r.title.color).toBe("#111111");
    expect(r.title.fontSize).toBe(18);
    expect(r.border.width).toBe(3);
    // ...and with no stored literal, the default.
    const r2 = resolveVisualContainer(undefined, defaults(), bound);
    expect(r2.title.color).toBe(BASE_CONTAINER_DEFAULTS.title.color);
  });

  it("a colour \"\" from any source is the family default", () => {
    const stored: VisualContainerFormat = { border: { color: "#ff0000" }, title: { color: "" } };
    expect(resolveVisualContainer(stored, defaults()).title.color).toBe(BASE_CONTAINER_DEFAULTS.title.color);
    const bound = new Map<ContainerFieldId, unknown>([["border.color", ""]]);
    expect(resolveVisualContainer(stored, defaults(), bound).border.color).toBe(BASE_CONTAINER_DEFAULTS.border.color);
  });

  it("transparency -> alpha = 1 - transparency / 100", () => {
    const r = resolveVisualContainer({ background: { transparency: 25 }, shadow: { transparency: 100 } }, defaults());
    expect(r.background.alpha).toBe(0.75);
    expect(r.shadow.alpha).toBe(0);
    const bound = new Map<ContainerFieldId, unknown>([["background.transparency", 40]]);
    expect(resolveVisualContainer({ background: { transparency: 25 } }, defaults(), bound).background.alpha).toBeCloseTo(0.6);
  });

  it("title.fontSize follows an explicit heading level, unless a size is given", () => {
    expect(resolveVisualContainer({ title: { headingLevel: 1 } }, defaults()).title.fontSize).toBe(24);
    expect(resolveVisualContainer({ title: { headingLevel: 1, fontSize: 9 } }, defaults()).title.fontSize).toBe(9);
    const familySize = defaults({ title: { ...BASE_CONTAINER_DEFAULTS.title, fontSize: 17 } });
    expect(resolveVisualContainer(undefined, familySize).title.fontSize).toBe(17);
    expect(resolveVisualContainer({ title: { headingLevel: 3 } }, familySize).title.headingLevel).toBe(3);
  });

  it("spacing applies only while spacing.custom resolves true", () => {
    const stored: VisualContainerFormat = { spacing: { belowTitle: 30 } };
    expect(resolveVisualContainer(stored, defaults()).spacing.belowTitle).toBe(BASE_CONTAINER_DEFAULTS.spacing.belowTitle);
    expect(resolveVisualContainer({ spacing: { custom: true, belowTitle: 30 } }, defaults()).spacing.belowTitle).toBe(30);
    const bound = new Map<ContainerFieldId, unknown>([["spacing.custom", true]]);
    expect(resolveVisualContainer(stored, defaults(), bound).spacing.belowTitle).toBe(30);
  });

  it("the gradient: a valid stored one, else the default; the paint split is always the family's", () => {
    const gradient = { type: "radial" as const, stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] };
    const split = { background: "family", border: "family", title: "none", shadow: "none" } as const;
    const fam = defaults({ paint: split });
    const r = resolveVisualContainer({ background: { gradient } }, fam);
    expect(r.background.gradient).toEqual(gradient);
    expect(r.paint).toEqual(split);
    const bad = { type: "radial" as const, stops: [{ offset: 0, color: "#000" }] };
    expect(resolveVisualContainer({ background: { gradient: bad } }, fam).background.gradient).toBeNull();
  });
});

describe("headingFontSize", () => {
  it("0->14, 1->24, 2->20, 3->16, 4->14, 5->12, 6->11", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((l) => headingFontSize(l as 0))).toEqual([14, 24, 20, 16, 14, 12, 11]);
  });
});

// ============================================================================
// Layout
// ============================================================================

describe("layoutVisualContainer", () => {
  const outer = { x: 100, y: 50, width: 400, height: 300 };

  it("no container chrome: content == outer", () => {
    const l = layoutVisualContainer(outer, defaults());
    expect(l.content).toEqual(outer);
    expect(l.titleRect).toBeNull();
    expect(l.subtitleRect).toBeNull();
    expect(l.divider).toBeNull();
    expect([l.titleLines, l.subtitleLines]).toEqual([0, 0]);
  });

  it("padding insets each side; a shown border insets its width first", () => {
    const c = defaults({ padding: { top: 10, right: 20, bottom: 30, left: 40 } });
    expect(layoutVisualContainer(outer, c).content).toEqual({ x: 140, y: 60, width: 340, height: 260 });
    const b = defaults({ padding: { top: 10, right: 20, bottom: 30, left: 40 }, border: { show: true, color: "#000", width: 2, radius: 0 } });
    expect(layoutVisualContainer(outer, b).content).toEqual({ x: 142, y: 62, width: 336, height: 256 });
    const hidden = defaults({ border: { show: false, color: "#000", width: 5, radius: 0 } });
    expect(layoutVisualContainer(outer, hidden).content).toEqual(outer);
  });

  it("title + subtitle + divider + spacing stack above the content (Core-painted title)", () => {
    const c = defaults({
      padding: { top: 8, right: 8, bottom: 8, left: 8 },
      title: { ...BASE_CONTAINER_DEFAULTS.title, show: true, fontSize: 16 },
      subtitle: { ...BASE_CONTAINER_DEFAULTS.subtitle, show: true, fontSize: 10 },
      divider: { show: true, color: "#ccc", style: "solid", width: 2, ignorePadding: false },
      spacing: { belowTitle: 4, belowSubtitle: 6, belowDivider: 8 },
    });
    const l = layoutVisualContainer(outer, c);
    // title: y 58, h = ceil(16 * 1.25) = 20
    expect(l.titleRect).toEqual({ x: 108, y: 58, width: 384, height: 20 });
    // subtitle: 58 + 20 + 4 = 82, h = ceil(12.5) = 13
    expect(l.subtitleRect).toEqual({ x: 108, y: 82, width: 384, height: 13 });
    // divider: 82 + 13 + 6 = 101, centre 102, spans the padded box
    expect(l.divider).toEqual({ y: 102, x0: 108, x1: 492 });
    // content: 101 + 2 + 8 = 111 .. 350 - 8 = 342
    expect(l.content).toEqual({ x: 108, y: 111, width: 384, height: 231 });
    expect([l.titleLines, l.subtitleLines]).toEqual([1, 1]);
  });

  it("measured lines grow the bands; an unwrapped text stays one line", () => {
    const c = defaults({
      title: { ...BASE_CONTAINER_DEFAULTS.title, show: true, fontSize: 16 },
      subtitle: { ...BASE_CONTAINER_DEFAULTS.subtitle, show: true, fontSize: 10, wrap: false },
    });
    const l = layoutVisualContainer(outer, c, { title: 3, subtitle: 4 });
    expect(l.titleRect!.height).toBe(60);
    expect(l.subtitleRect!.height).toBe(13);
    expect([l.titleLines, l.subtitleLines]).toEqual([3, 1]);
  });

  it("ignorePadding spans the divider across the (border-inset) box", () => {
    const c = defaults({
      padding: { top: 0, right: 30, bottom: 0, left: 20 },
      border: { show: true, color: "#000", width: 1, radius: 0 },
      divider: { show: true, color: "#ccc", style: "solid", width: 1, ignorePadding: true },
    });
    const l = layoutVisualContainer(outer, c);
    expect(l.divider).toEqual({ y: 51.5, x0: 101, x1: 499 });
    const padded = layoutVisualContainer(outer, { ...c, divider: { ...c.divider, ignorePadding: false } });
    expect(padded.divider).toEqual({ y: 51.5, x0: 121, x1: 469 });
  });

  it("a family-painted (or absent) title reserves nothing", () => {
    for (const title of ["family", "none"] as const) {
      const c = defaults({
        title: { ...BASE_CONTAINER_DEFAULTS.title, show: true },
        divider: { ...BASE_CONTAINER_DEFAULTS.divider, show: true },
        paint: { ...BASE_CONTAINER_DEFAULTS.paint, title },
      });
      const l = layoutVisualContainer(outer, c);
      expect(l.titleRect).toBeNull();
      expect(l.divider).toBeNull();
      expect(l.content).toEqual(outer);
    }
  });

  it("content never has a negative size", () => {
    const tiny = { x: 0, y: 0, width: 10, height: 10 };
    const c = defaults({
      padding: { top: 200, right: 200, bottom: 200, left: 200 },
      title: { ...BASE_CONTAINER_DEFAULTS.title, show: true, fontSize: 96 },
    });
    const l = layoutVisualContainer(tiny, c);
    expect(l.content.width).toBe(0);
    expect(l.content.height).toBe(0);
    const titleOnly = layoutVisualContainer(tiny, defaults({ title: { ...BASE_CONTAINER_DEFAULTS.title, show: true, fontSize: 96 } }));
    expect(titleOnly.content.height).toBe(0);
    expect(titleOnly.content.y).toBe(10);
  });

  it("lineHeightFor = ceil(fontSize * 1.25)", () => {
    expect([6, 10, 11, 14, 16, 96].map(lineHeightFor)).toEqual([8, 13, 14, 18, 20, 120]);
  });
});

// ============================================================================
// JSON-Schema fragment agrees with the validator
// ============================================================================

/** A minimal draft-07 subset validator -- enough for the fragment's keywords. */
function schemaAccepts(schema: Record<string, unknown>, v: unknown): boolean {
  const type = schema.type as string | undefined;
  if (type === "object") {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const req of (schema.required as string[] | undefined) ?? []) if (!(req in v)) return false;
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (!props[k]) {
        if (schema.additionalProperties === false) return false;
        continue;
      }
      if (!schemaAccepts(props[k], child)) return false;
    }
    return true;
  }
  if (type === "array") {
    if (!Array.isArray(v)) return false;
    if (typeof schema.minItems === "number" && v.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && v.length > schema.maxItems) return false;
    return v.every((item) => schemaAccepts(schema.items as Record<string, unknown>, item));
  }
  if (type === "number" || type === "integer") {
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
    if (type === "integer" && !Number.isInteger(v)) return false;
    if (typeof schema.minimum === "number" && v < schema.minimum) return false;
    if (typeof schema.maximum === "number" && v > schema.maximum) return false;
    return true;
  }
  if (type === "boolean") return typeof v === "boolean";
  if (type === "string") {
    if (typeof v !== "string") return false;
    if (Array.isArray(schema.enum) && !schema.enum.includes(v)) return false;
    if (typeof schema.maxLength === "number" && v.length > schema.maxLength) return false;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(v)) return false;
    return true;
  }
  return false;
}

describe("VISUAL_CONTAINER_JSON_SCHEMA", () => {
  it("additionalProperties: false at every object level", () => {
    const walk = (s: Record<string, unknown>, at: string): void => {
      if (s.type === "object") expect(s.additionalProperties, at).toBe(false);
      for (const child of Object.values((s.properties ?? {}) as Record<string, Record<string, unknown>>)) walk(child, at + ".");
      if (s.items) walk(s.items as Record<string, unknown>, at + "[]");
    };
    walk(VISUAL_CONTAINER_JSON_SCHEMA, "container");
  });

  it("covers every field id, and agrees with validateVisualContainer on a table of values", () => {
    const samples: unknown[] = [true, false, 0, 1, 6, 7, 2.5, -1, 96, 97, 101, 201, "", "#abc", "red", "left", "middle",
      "solid", "double", "inside", "topLeft", "Segoe UI", "a;b", "x".repeat(1025), null, {}];
    for (const id of VISUAL_CONTAINER_FIELD_IDS) {
      for (const value of samples) {
        if (value === null) continue; // null = absent for the validator; JSON-Schema has no such notion
        const doc = withLeaf(id, value);
        expect(schemaAccepts(VISUAL_CONTAINER_JSON_SCHEMA, doc), `${id} = ${JSON.stringify(value)}`).toBe(
          validateVisualContainer(doc) === null,
        );
      }
    }
    const gradient = { type: "linear", stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] };
    for (const g of [gradient, { ...gradient, stops: gradient.stops.slice(0, 1) }, { stops: gradient.stops },
      { ...gradient, stops: [{ offset: 0, color: "" }, { offset: 1, color: "#fff" }] }]) {
      const doc = { background: { gradient: g } };
      expect(schemaAccepts(VISUAL_CONTAINER_JSON_SCHEMA, doc), JSON.stringify(g)).toBe(validateVisualContainer(doc) === null);
    }
    expect(schemaAccepts(VISUAL_CONTAINER_JSON_SCHEMA, { title: { nope: 1 } })).toBe(false);
  });
});

// ============================================================================
// Controls: the one flat-key map
// ============================================================================

describe("controls: the flat-key map (spec 2.1 table)", () => {
  it("CONTROL_CONTAINER_PROPERTY_KEYS = 'container' + PascalCase of every id, index for index", () => {
    expect(CONTROL_CONTAINER_PROPERTY_KEYS.length).toBe(VISUAL_CONTAINER_FIELD_IDS.length);
    expect(CONTROL_CONTAINER_PROPERTY_KEYS[VISUAL_CONTAINER_FIELD_IDS.indexOf("title.fontSize")]).toBe("containerTitleFontSize");
    expect(CONTROL_CONTAINER_PROPERTY_KEYS[VISUAL_CONTAINER_FIELD_IDS.indexOf("lockAspect")]).toBe("containerLockAspect");
    expect(CONTROL_CONTAINER_PROPERTY_KEYS[VISUAL_CONTAINER_FIELD_IDS.indexOf("divider.ignorePadding")]).toBe(
      "containerDividerIgnorePadding",
    );
    for (const key of ["fill", "stroke", "strokeWidth", "borderColor", "padding"]) {
      expect(CONTROL_CONTAINER_PROPERTY_KEYS).not.toContain(key);
    }
    VISUAL_CONTAINER_FIELD_IDS.forEach((id, i) => expect(controlContainerKeyField(CONTROL_CONTAINER_PROPERTY_KEYS[i])).toBe(id));
    expect(controlContainerKeyField("fill")).toBeNull();
  });

  it("the per-family table", () => {
    const rows: Array<[ContainerFieldId, string, string, string, string]> = [
      // field                shape                    button                   image                    pageNavigator
      ["background.color", "fill", "fill", "fill", "containerBackgroundColor"],
      ["background.show", "fill", "fill", "fill", "containerBackgroundShow"],
      ["border.color", "stroke", "borderColor", "stroke", "containerBorderColor"],
      ["border.width", "strokeWidth", "strokeWidth", "strokeWidth", "containerBorderWidth"],
      ["border.show", "strokeWidth", "strokeWidth", "strokeWidth", "containerBorderShow"],
      ["padding.top", "containerPaddingTop", "containerPaddingTop", "containerPaddingTop", "padding"],
      ["padding.left", "containerPaddingLeft", "containerPaddingLeft", "containerPaddingLeft", "padding"],
      ["title.fontSize", "containerTitleFontSize", "containerTitleFontSize", "containerTitleFontSize", "containerTitleFontSize"],
      ["shadow.blur", "containerShadowBlur", "containerShadowBlur", "containerShadowBlur", "containerShadowBlur"],
      ["border.radius", "containerBorderRadius", "containerBorderRadius", "containerBorderRadius", "containerBorderRadius"],
      ["lockAspect", "containerLockAspect", "containerLockAspect", "containerLockAspect", "containerLockAspect"],
    ];
    for (const [field, shape, button, image, nav] of rows) {
      expect(controlContainerKey("shape", field), `shape ${field}`).toBe(shape);
      expect(controlContainerKey("textBox", field), `textBox ${field}`).toBe(shape);
      expect(controlContainerKey("button", field), `button ${field}`).toBe(button);
      expect(controlContainerKey("image", field), `image ${field}`).toBe(image);
      expect(controlContainerKey("pageNavigator", field), `pageNavigator ${field}`).toBe(nav);
    }
    expect(controlContainerKey("checkbox", "title.show")).toBeNull();
    expect(controlContainerKey("", "title.show")).toBeNull();
  });

  it("checkControlContainerValue == Rust check_control_container_value (its table)", () => {
    const cases: Array<[string, string, boolean]> = [
      ["fill", "red", true], ["textColor", "anything", true], ["containerNope", "x", true],
      ["containerTitleFontSize", "", true], ["containerTitleBold", "", true],
      ["containerTitleFontSize", "14", true], ["containerTitleFontSize", "14.5", true],
      ["containerTitleFontSize", "6", true], ["containerTitleFontSize", "96", true],
      ["containerTitleFontSize", "5", false], ["containerTitleFontSize", "97", false],
      ["containerTitleFontSize", "abc", false], ["containerTitleFontSize", " 14", false],
      ["containerTitleFontSize", "inf", false], ["containerTitleFontSize", "NaN", false],
      ["containerTitleFontSize", "0x10", false], ["containerTitleFontSize", "Infinity", false],
      ["containerPaddingTop", "0", true], ["containerPaddingTop", "1e2", true], ["containerPaddingTop", "-1", false],
      ["containerPaddingLeft", "200", true], ["containerPaddingLeft", "201", false],
      ["containerBorderRadius", "12", true], ["containerBorderRadius", "101", false],
      ["containerShadowBlur", "50", true], ["containerShadowDistance", "51", false],
      ["containerBackgroundTransparency", "100", true], ["containerBackgroundTransparency", "100.1", false],
      ["containerTitleHeadingLevel", "3", true], ["containerTitleHeadingLevel", "3.0", true],
      ["containerTitleHeadingLevel", "3.5", false], ["containerTitleHeadingLevel", "7", false],
      ["containerTitleShow", "true", true], ["containerLockAspect", "false", true],
      ["containerTitleShow", "TRUE", false], ["containerTitleShow", "1", false], ["containerBorderShow", "yes", false],
      ["containerTitleColor", "#fff", true], ["containerBackgroundColor", "#11223344", true],
      ["containerBorderColor", "red", false], ["containerShadowColor", "url(x)", false], ["containerDividerColor", "#12345", false],
      ["containerTitleText", "Revenue", true], ["containerSubtitleText", "x".repeat(1024), true],
      ["containerSubtitleText", "x".repeat(1025), false],
      ["containerTitleFontFamily", "Segoe UI", true], ["containerTitleFontFamily", "Arial;x", false],
      ["containerTitleAlign", "center", true], ["containerTitleAlign", "Center", false],
      ["containerDividerStyle", "dashed", true], ["containerDividerStyle", "double", false],
      ["containerShadowOffset", "inside", true], ["containerShadowPosition", "bottomRight", true],
      ["containerShadowPosition", "middle", false],
    ];
    for (const [key, value, ok] of cases) {
      expect(checkControlContainerValue(key, value) === null, `${key} = ${JSON.stringify(value).slice(0, 20)}`).toBe(ok);
    }
    expect(checkControlContainerValue("containerTitleFontSize", "97")).toBe("containerTitleFontSize must be a number from 6 to 96.");
    expect(checkControlContainerValue("containerTitleShow", "1")).toBe("containerTitleShow must be true or false.");
  });

  it("the limits object is the spec's", () => {
    expect(VISUAL_CONTAINER_LIMITS).toEqual({
      paddingMax: 200, fontSizeMin: 6, fontSizeMax: 96, borderWidthMax: 20, radiusMax: 100, dividerWidthMax: 20,
      spacingMax: 200, shadowBlurMax: 50, shadowDistanceMax: 50, transparencyMax: 100, textMaxChars: 1024,
      fontFamilyMaxChars: 64, gradientStopsMin: 2, gradientStopsMax: 8,
    });
  });
});

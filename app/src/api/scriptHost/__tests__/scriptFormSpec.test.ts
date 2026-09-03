//! FILENAME: app/src/api/scriptHost/__tests__/scriptFormSpec.test.ts
// PURPOSE: The form validators (vFormDefine / vFormShow / vFormUpdate /
//          vFormClose) against the contract in scriptFormSpec.ts. A worked
//          example of every widget type validates; every limit in the spec is
//          exercised at its boundary; and the refusals that carry a SECURITY
//          reason (a reserved result key, a regex `pattern`, the reserved
//          `html` type, an image that would INTRODUCE bytes) are pinned by name.
// CONTEXT: The validator runs on the MAIN thread before the tier check, over a
//          script-supplied tree. Its walk is iterative, so the deep-tree case
//          here is a real 10k-level chain — a recursive walker would blow the
//          host stack on it instead of returning a message.
//
// SABOTAGE NOTE: the boundary cases below use LITERALS (201 nodes, depth 9,
// 65 inputs, 501 options, a 65-key initial, a 201-char error), and a separate
// test pins each MAX_FORM_* constant to the literal it is tested against.
// Raising MAX_FORM_NODES to 201 must turn the "201 nodes" case RED — the
// validator would then admit it — and the pin turns red too, so the change
// shows up as a decision to make rather than a number that drifted. A test
// that computed `MAX_FORM_NODES + 1` would stay green under that sabotage,
// which is the no-op-sabotage trap this layout exists to avoid. Verified by
// hand at authoring time: with MAX_FORM_NODES = 201 the 201-node case failed.

import { describe, it, expect } from "vitest";
import { vFormDefine, vFormShow, vFormUpdate, vFormClose } from "../validators";
import {
  FORM_WIDGET_TYPES,
  FORM_WIDGET_TYPE_SET,
  MAX_DIALOG_FIELD_LABEL,
  MAX_DIALOG_MESSAGE,
  MAX_FORM_DEPTH,
  MAX_FORM_ERROR_CHARS,
  MAX_FORM_INITIAL_KEYS,
  MAX_FORM_INPUTS,
  MAX_FORM_NODES,
  MAX_FORM_OPTIONS,
  MAX_FORM_PATCH_CONTROLS,
  MAX_FORM_VALUE_CHARS,
  MAX_FORM_WIDTH,
  MIN_FORM_WIDTH,
  formOriginForMount,
} from "../scriptFormSpec";

/** A syntactically valid media handle: "media:" + 64 lowercase hex. */
const MEDIA = "media:" + "0123456789abcdef".repeat(4);

/** The worked example: one of everything, the way a script would write it. */
const EXAMPLE = {
  title: "Monthly close",
  description: "Fill in the parameters for this month's close.",
  submitLabel: "Run",
  cancelLabel: "Not now",
  width: 640,
  writeOn: "submit",
  submitOnEnter: true,
  focus: "customer",
  children: [
    { type: "textbox", name: "customer", label: "Customer", bind: "B2", required: true, placeholder: "Name" },
    {
      type: "dropdown",
      name: "region",
      label: "Region",
      options: ["EMEA", { value: "apac", label: "APAC" }, { value: "na" }],
      default: "EMEA",
      allowEmpty: false,
    },
    {
      type: "row",
      gap: 8,
      children: [
        { type: "number", name: "rate", label: "Rate", bind: "B4", min: 0, max: 10, step: 0.1, default: 1 },
        { type: "number", name: "volume", label: "Volume", bind: { cell: "B5", sheet: "Inputs" } },
      ],
    },
    { type: "date", name: "period", label: "Period", bind: "B6", min: "2026-01-01", max: "2026-12-31" },
    { type: "checkbox", name: "lock", label: "Lock after run", default: true },
    { type: "label", name: "total", text: "Total: -", style: "heading" },
    {
      type: "group",
      title: "Advanced",
      children: [
        { type: "toggle", name: "dryRun", label: "Dry run" },
        { type: "radio", name: "mode", label: "Mode", options: ["fast", "safe"], layout: "row", default: "safe" },
        { type: "listbox", name: "sheets", label: "Sheets", options: { range: "Config!A2:A20" }, multi: true, rows: 6 },
      ],
    },
    {
      type: "tabs",
      pages: [
        { title: "Notes", children: [{ type: "textbox", name: "notes", label: "Notes", multiline: true, maxLength: 500 }] },
        { title: "Approver", children: [{ type: "textbox", name: "approver", label: "Approver", bind: { name: "Approver" } }] },
      ],
    },
    {
      type: "grid",
      columns: 2,
      children: [
        { type: "label", text: "Left" },
        { type: "label", text: "Right", style: "muted" },
      ],
    },
    { type: "spacer", size: 12 },
    { type: "image", src: MEDIA, alt: "Company logo", height: 48 },
    {
      type: "table",
      columns: ["Item", "Qty", "OK"],
      rows: [
        ["Widget", 3, true],
        ["Gadget", 1.5, null],
      ],
      maxRows: 50,
    },
    { type: "progress", name: "done", value: 2, max: 10, text: "2 of 10" },
    { type: "button", name: "recalc", text: "Recalculate", role: "default" },
    { type: "button", name: "wipe", text: "Clear all", danger: true },
  ],
};

/** A minimal valid spec with the given children. */
const form = (children: unknown[], over: Record<string, unknown> = {}) => ({ children, ...over });

/** N label widgets (no names, so no uniqueness or input-count interplay). */
const labels = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "label", text: `L${i}` }));

/** N uniquely named textboxes. */
const textboxes = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "textbox", name: `t${i}`, label: `T${i}` }));

/** A chain of N nested groups with one label at the bottom. */
const nested = (n: number): unknown => {
  let node: unknown = { type: "label", text: "leaf" };
  for (let i = 0; i < n; i++) node = { type: "group", children: [node] };
  return node;
};

describe("scriptFormSpec: the widget vocabulary", () => {
  it("does not contain the reserved html type", () => {
    expect(FORM_WIDGET_TYPES).not.toContain("html");
    expect(FORM_WIDGET_TYPE_SET.has("html")).toBe(false);
  });

  it("pins the limits the boundary cases below are written against", () => {
    // Change one of these deliberately and the matching literal case must be
    // updated in the same commit — that is the point (see the header note).
    expect(MAX_FORM_NODES).toBe(200);
    expect(MAX_FORM_DEPTH).toBe(8);
    expect(MAX_FORM_INPUTS).toBe(64);
    expect(MAX_FORM_OPTIONS).toBe(500);
    expect(MAX_FORM_INITIAL_KEYS).toBe(64);
    expect(MAX_FORM_PATCH_CONTROLS).toBe(64);
    expect(MAX_FORM_ERROR_CHARS).toBe(200);
    expect(MAX_FORM_VALUE_CHARS).toBe(32_767);
    expect(MIN_FORM_WIDTH).toBe(320);
    expect(MAX_FORM_WIDTH).toBe(1200);
  });
});

describe("vFormDefine: the worked example", () => {
  it("validates one of every widget type, bound and nested", () => {
    expect(vFormDefine([EXAMPLE])).toBe(true);
  });

  it("validates the smallest possible form", () => {
    expect(vFormDefine([form([{ type: "label", text: "Hi" }])])).toBe(true);
  });
});

describe("vFormDefine: tree limits (the renderer's budget)", () => {
  it("refuses 201 nodes and accepts 200 — containers count", () => {
    expect(vFormDefine([form(labels(200))])).toBe(true);
    const verdict = vFormDefine([form(labels(201))]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("200");
    // Containers are nodes too: a group plus 200 labels is 201.
    expect(vFormDefine([form([{ type: "group", children: labels(200) }])])).not.toBe(true);
    // ...and a group plus 199 is exactly 200.
    expect(vFormDefine([form([{ type: "group", children: labels(199) }])])).toBe(true);
  });

  it("refuses depth 9 and accepts depth 8", () => {
    expect(vFormDefine([form([nested(8)])])).toBe(true);
    const verdict = vFormDefine([form([nested(9)])]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("nested too deeply");
  });

  it("survives a hostile 10,000-deep chain without recursing (returns a message, not a stack overflow)", () => {
    const verdict = vFormDefine([form([nested(10_000)])]);
    expect(verdict).not.toBe(true);
    expect(typeof verdict).toBe("string");
  });

  it("refuses a hostile 10,000-wide children array at the length check", () => {
    expect(vFormDefine([form(labels(10_000))])).not.toBe(true);
  });

  it("refuses 65 inputs and accepts 64 — labels and buttons are not inputs", () => {
    expect(vFormDefine([form(textboxes(64))])).toBe(true);
    const verdict = vFormDefine([form(textboxes(65))]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("64");
    // 64 inputs plus non-input widgets is still fine.
    expect(vFormDefine([form([...textboxes(64), ...labels(10), { type: "button", name: "go", text: "Go" }])])).toBe(true);
  });

  it("refuses 501 options and accepts 500", () => {
    const opts = (n: number) => Array.from({ length: n }, (_, i) => `o${i}`);
    expect(vFormDefine([form([{ type: "dropdown", name: "d", options: opts(500) }])])).toBe(true);
    const verdict = vFormDefine([form([{ type: "dropdown", name: "d", options: opts(501) }])]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("children[0].options");
  });
});

describe("vFormDefine: names are result keys", () => {
  it("refuses a duplicate name anywhere in the tree, naming the second by index path", () => {
    const verdict = vFormDefine([
      form([
        { type: "textbox", name: "dup", label: "A" },
        { type: "group", children: [{ type: "checkbox", name: "dup", label: "B" }] },
      ]),
    ]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("children[1].children[0].name");
    expect(String(verdict)).toContain("dup");
  });

  it("refuses the reserved name __proto__ (and its prototype siblings)", () => {
    for (const name of ["__proto__", "constructor", "prototype", "hasOwnProperty", "toString", "valueOf"]) {
      const verdict = vFormDefine([form([{ type: "textbox", name, label: "X" }])]);
      expect(verdict, name).not.toBe(true);
      expect(String(verdict), name).toContain("reserved");
    }
  });

  it("refuses a name that is not a plain identifier", () => {
    for (const name of ["", "a b", "a.b", "1a", "x".repeat(65)]) {
      expect(vFormDefine([form([{ type: "textbox", name, label: "X" }])]), name).not.toBe(true);
    }
  });

  it("requires a name on inputs, buttons and progress bars; allows one elsewhere", () => {
    expect(vFormDefine([form([{ type: "textbox", label: "X" }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "button", text: "Go" }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "progress", value: 1 }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "label", text: "X" }])])).toBe(true);
    expect(vFormDefine([form([{ type: "label", name: "status", text: "X" }])])).toBe(true);
    expect(vFormDefine([form([{ type: "group", name: "adv", children: [] }])])).toBe(true);
  });
});

describe("vFormDefine: unknown keys and types are refused by name", () => {
  it("refuses a regex `pattern` on any widget (ReDoS on the trusted thread)", () => {
    const verdict = vFormDefine([form([{ type: "textbox", name: "a", label: "A", pattern: "^[a-z]+$" }])]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain('"pattern"');
    expect(String(verdict)).toContain("children[0]");
  });

  it("refuses an unknown top-level key", () => {
    expect(vFormDefine([{ ...form([{ type: "label", text: "x" }]), onSubmit: "handler" }])).not.toBe(true);
  });

  it("refuses the reserved widget type html, naming it", () => {
    const verdict = vFormDefine([form([{ type: "html", name: "h", html: "<b>x</b>" }])]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain('"html"');
    expect(String(verdict)).toContain("reserved");
  });

  it("refuses an unknown widget type, naming it and the index path", () => {
    const verdict = vFormDefine([form([{ type: "label", text: "ok" }, { type: "iframe", src: "x" }])]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain('"iframe"');
    expect(String(verdict)).toContain("children[1].type");
  });

  it("refuses a non-object child", () => {
    for (const child of ["textbox", 42, null, ["nested"]]) {
      const verdict = vFormDefine([form([{ type: "label", text: "ok" }, child])]);
      expect(verdict, String(child)).not.toBe(true);
      expect(String(verdict)).toContain("children[1]");
    }
  });

  it("refuses a key from a DIFFERENT widget type", () => {
    // `options` is a choice-widget member; on a textbox it is a typo.
    expect(vFormDefine([form([{ type: "textbox", name: "a", options: ["x"] }])])).not.toBe(true);
    // `children` on a leaf.
    expect(vFormDefine([form([{ type: "label", text: "x", children: [] }])])).not.toBe(true);
  });
});

describe("vFormDefine: images never introduce bytes (BUG-0086)", () => {
  it("accepts a media handle and the empty string", () => {
    expect(vFormDefine([form([{ type: "image", src: MEDIA }])])).toBe(true);
    expect(vFormDefine([form([{ type: "image", src: "" }])])).toBe(true);
  });

  it("refuses a data: URI, a URL and a file path", () => {
    for (const src of [
      "data:image/png;base64,AAAA",
      "https://x/y.png",
      "C:\\Users\\me\\logo.png",
      "/usr/share/logo.png",
      "logo.png",
      "media:../../etc",
      "MEDIA:" + "a".repeat(64),
    ]) {
      const verdict = vFormDefine([form([{ type: "image", src }])]);
      expect(verdict, src).not.toBe(true);
      expect(String(verdict), src).toContain("children[0].src");
    }
  });

  it("requires src (an image with nothing to show is a typo)", () => {
    expect(vFormDefine([form([{ type: "image" }])])).not.toBe(true);
  });
});

describe("vFormDefine: bindings", () => {
  it("accepts a bare reference, { cell }, { cell, sheet }, { name } and { control }", () => {
    for (const bind of ["B2", "Sheet1!B2", "Rate", { cell: "B2" }, { cell: "B2", sheet: "Inputs" }, { cell: "B2", sheet: 1 }, { name: "Rate" }, { control: "Region" }]) {
      expect(vFormDefine([form([{ type: "textbox", name: "a", bind }])]), JSON.stringify(bind)).toBe(true);
    }
  });

  it("refuses a binding with both cell and name", () => {
    const verdict = vFormDefine([form([{ type: "textbox", name: "a", bind: { cell: "B2", name: "Rate" } }])]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("children[0].bind");
  });

  it("refuses an empty binding, an empty object and an oversized reference", () => {
    expect(vFormDefine([form([{ type: "textbox", name: "a", bind: "" }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "textbox", name: "a", bind: {} }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "textbox", name: "a", bind: "A".repeat(65) }])])).not.toBe(true);
  });

  it("refuses sheet alongside anything but cell, and an unknown binding key", () => {
    expect(vFormDefine([form([{ type: "textbox", name: "a", bind: { name: "Rate", sheet: "S" } }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "textbox", name: "a", bind: { cell: "B2", formula: "=1" } }])])).not.toBe(true);
  });

  it("refuses bind on a widget that is not an input", () => {
    expect(vFormDefine([form([{ type: "label", text: "x", bind: "B2" }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "button", name: "b", text: "Go", bind: "B2" }])])).not.toBe(true);
  });
});

describe("vFormDefine: per-widget bounds", () => {
  it("refuses width 100 and 5000, accepts the bounds", () => {
    expect(vFormDefine([form([{ type: "label", text: "x" }], { width: 100 })])).not.toBe(true);
    expect(vFormDefine([form([{ type: "label", text: "x" }], { width: 5000 })])).not.toBe(true);
    expect(vFormDefine([form([{ type: "label", text: "x" }], { width: MIN_FORM_WIDTH })])).toBe(true);
    expect(vFormDefine([form([{ type: "label", text: "x" }], { width: MAX_FORM_WIDTH })])).toBe(true);
  });

  it("refuses options as an object without range", () => {
    expect(vFormDefine([form([{ type: "dropdown", name: "d", options: {} }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "dropdown", name: "d", options: { values: ["a"] } }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "dropdown", name: "d", options: { range: "" } }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "dropdown", name: "d", options: [] }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "dropdown", name: "d" }])])).not.toBe(true);
  });

  it("types defaults per widget", () => {
    expect(vFormDefine([form([{ type: "checkbox", name: "c", default: "yes" }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "number", name: "n", default: "1" }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "number", name: "n", default: Number.NaN }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "textbox", name: "t", default: 1 }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "listbox", name: "l", options: ["a", "b"], default: ["a", "b"] }])])).toBe(true);
    expect(vFormDefine([form([{ type: "listbox", name: "l", options: ["a", "b"], default: [1] }])])).not.toBe(true);
  });

  it("bounds number min/max/step like a dialog field", () => {
    expect(vFormDefine([form([{ type: "number", name: "n", min: 5, max: 1 }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "number", name: "n", step: 0 }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "number", name: "n", max: Number.POSITIVE_INFINITY }])])).not.toBe(true);
  });

  it("bounds text members to what a person reads", () => {
    expect(vFormDefine([form([{ type: "label", text: "x".repeat(MAX_DIALOG_MESSAGE + 1) }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "textbox", name: "t", label: "x".repeat(MAX_DIALOG_FIELD_LABEL + 1) }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "button", name: "b", text: "" }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "button", name: "b", text: "x".repeat(41) }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "label", text: "x" }], { title: "x".repeat(121) })])).not.toBe(true);
  });

  it("bounds the enum members", () => {
    expect(vFormDefine([form([{ type: "label", text: "x", style: "bold" }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "button", name: "b", text: "Go", role: "reset" }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "radio", name: "r", options: ["a"], layout: "diagonal" }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "label", text: "x" }], { writeOn: "blur" })])).not.toBe(true);
    expect(vFormDefine([form([{ type: "textbox", name: "t", writeOn: "blur" }])])).not.toBe(true);
  });

  it("bounds containers", () => {
    expect(vFormDefine([form([{ type: "grid", columns: 0, children: [] }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "grid", columns: 7, children: [] }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "grid", columns: 2.5, children: [] }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "row", children: [], gap: 65 }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "group", children: "nope" }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "tabs", pages: [] }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "tabs", pages: Array.from({ length: 13 }, () => ({ title: "t", children: [] })) }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "tabs", pages: [{ title: "t", children: [], icon: "x" }] }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "spacer", size: 401 }])])).not.toBe(true);
  });

  it("bounds a table's shape and cell count", () => {
    const ok = { type: "table", columns: ["A", "B"], rows: [["x", 1]] };
    expect(vFormDefine([form([ok])])).toBe(true);
    expect(vFormDefine([form([{ ...ok, rows: { range: "Data!A2:B50" } }])])).toBe(true);
    expect(vFormDefine([form([{ ...ok, columns: [] }])])).not.toBe(true);
    expect(vFormDefine([form([{ ...ok, columns: Array.from({ length: 21 }, (_, i) => `c${i}`) }])])).not.toBe(true);
    expect(vFormDefine([form([{ ...ok, rows: [["x", 1, "extra"]] }])])).not.toBe(true);
    expect(vFormDefine([form([{ ...ok, rows: [["x", { nested: true }]] }])])).not.toBe(true);
    expect(vFormDefine([form([{ ...ok, rows: Array.from({ length: 2501 }, () => ["x", 1]) }])])).not.toBe(true);
    expect(vFormDefine([form([{ ...ok, rows: Array.from({ length: 2500 }, () => ["x", 1]) }])])).toBe(true);
    expect(vFormDefine([form([{ ...ok, rows: {} }])])).not.toBe(true);
    expect(vFormDefine([form([{ ...ok, maxRows: 501 }])])).not.toBe(true);
  });

  it("bounds a progress bar", () => {
    expect(vFormDefine([form([{ type: "progress", name: "p", value: "1" }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "progress", name: "p", value: 1, max: 0 }])])).not.toBe(true);
    expect(vFormDefine([form([{ type: "progress", name: "p", value: 1, max: 10 }])])).toBe(true);
  });

  it("refuses a non-object spec and an empty tree", () => {
    expect(vFormDefine(["nope"])).not.toBe(true);
    expect(vFormDefine([null])).not.toBe(true);
    expect(vFormDefine([[]])).not.toBe(true);
    expect(vFormDefine([{}])).not.toBe(true);
    expect(vFormDefine([form([])])).not.toBe(true);
  });
});

describe("vFormShow", () => {
  it("accepts no options, and { initial } with every value kind", () => {
    expect(vFormShow([])).toBe(true);
    expect(vFormShow([undefined])).toBe(true);
    expect(vFormShow([{}])).toBe(true);
    expect(vFormShow([{ initial: { customer: "Acme", rate: 1.5, lock: true, note: null, sheets: ["A", "B"] } }])).toBe(true);
  });

  it("refuses a 65-key initial and accepts 64", () => {
    const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    expect(vFormShow([{ initial: keys(64) }])).toBe(true);
    expect(vFormShow([{ initial: keys(65) }])).not.toBe(true);
  });

  it("refuses a non-identifier key and a reserved one", () => {
    expect(vFormShow([{ initial: { "a.b": 1 } }])).not.toBe(true);
    expect(vFormShow([{ initial: { "": 1 } }])).not.toBe(true);
    // An own "__proto__" key (a JSON body has one; an object literal does not).
    const proto = JSON.parse('{"__proto__": 1}') as Record<string, unknown>;
    expect(vFormShow([{ initial: proto }])).not.toBe(true);
  });

  it("refuses an oversized string, a non-finite number and a nested object", () => {
    expect(vFormShow([{ initial: { a: "x".repeat(MAX_FORM_VALUE_CHARS + 1) } }])).not.toBe(true);
    expect(vFormShow([{ initial: { a: "x".repeat(MAX_FORM_VALUE_CHARS) } }])).toBe(true);
    expect(vFormShow([{ initial: { a: Number.NaN } }])).not.toBe(true);
    expect(vFormShow([{ initial: { a: { deep: 1 } } }])).not.toBe(true);
    expect(vFormShow([{ initial: { a: [1, 2] } }])).not.toBe(true);
  });

  it("refuses an unknown option and a non-object", () => {
    expect(vFormShow([{ modal: true }])).not.toBe(true);
    expect(vFormShow([{ initial: "x" }])).not.toBe(true);
    expect(vFormShow(["x"])).not.toBe(true);
  });
});

describe("vFormUpdate", () => {
  it("accepts the documented patch shape", () => {
    expect(
      vFormUpdate([{
        values: { total: "1,234", lock: true },
        controls: {
          rate: { disabled: true, label: "Rate (locked)", error: "Too high" },
          region: { options: ["EMEA", { value: "apac", label: "APAC" }] },
          done: { value: 5, max: 10, text: "5 of 10" },
          old: { hidden: true, error: null },
        },
        focus: "customer",
        message: { text: "Check the rate", kind: "warning" },
      }]),
    ).toBe(true);
    expect(vFormUpdate([{}])).toBe(true);
    expect(vFormUpdate([{ message: null }])).toBe(true);
  });

  it("refuses an error over MAX_FORM_ERROR_CHARS (200)", () => {
    expect(vFormUpdate([{ controls: { a: { error: "x".repeat(200) } } }])).toBe(true);
    const verdict = vFormUpdate([{ controls: { a: { error: "x".repeat(201) } } }]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("controls.a.error");
  });

  it("refuses a { range } choice list in a PATCH, and says what to do instead", () => {
    // A range-fed list is read once, by the host's audited range read, when the
    // form opens. A patch performs no read, so this used to be accepted and
    // then quietly ignored: the renderer got an object it cannot paint, the
    // dropdown kept its old list, and the script had no way to find out.
    const verdict = vFormUpdate([{ controls: { region: { options: { range: "A1:A5" } } } }]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("controls.region.options");
    expect(String(verdict)).toContain("an array");
    // The inline form is still fine.
    expect(vFormUpdate([{ controls: { region: { options: ["EMEA", "APAC"] } } }])).toBe(true);
  });

  it("refuses an unknown control key by name", () => {
    const verdict = vFormUpdate([{ controls: { a: { color: "red" } } }]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain('"color"');
    expect(String(verdict)).toContain("controls.a");
  });

  it("refuses too many controls, a bad control name and a non-object entry", () => {
    const controls = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, { hidden: true }]));
    expect(vFormUpdate([{ controls: controls(64) }])).toBe(true);
    expect(vFormUpdate([{ controls: controls(65) }])).not.toBe(true);
    expect(vFormUpdate([{ controls: { "a b": { hidden: true } } }])).not.toBe(true);
    // An OWN "__proto__" key, as a JSON body carries it (an object literal would set the prototype instead).
    expect(vFormUpdate([{ controls: JSON.parse('{"__proto__": {"hidden": true}}') }])).not.toBe(true);
    expect(vFormUpdate([{ controls: { a: true } }])).not.toBe(true);
  });

  it("refuses bad values / focus / message", () => {
    expect(vFormUpdate([{ values: { a: { deep: 1 } } }])).not.toBe(true);
    expect(vFormUpdate([{ values: { "a.b": 1 } }])).not.toBe(true);
    expect(vFormUpdate([{ focus: "a.b" }])).not.toBe(true);
    expect(vFormUpdate([{ message: { text: "x", kind: "fatal" } }])).not.toBe(true);
    expect(vFormUpdate([{ message: { text: "x".repeat(MAX_DIALOG_MESSAGE + 1) } }])).not.toBe(true);
    expect(vFormUpdate([{ message: { text: "x", html: "<b>" } }])).not.toBe(true);
    expect(vFormUpdate([{ message: "x" }])).not.toBe(true);
  });

  it("refuses an unknown patch key and a non-object patch", () => {
    expect(vFormUpdate([{ title: "x" }])).not.toBe(true);
    expect(vFormUpdate([undefined])).not.toBe(true);
    expect(vFormUpdate(["x"])).not.toBe(true);
  });
});

describe("vFormClose", () => {
  it("accepts no result, null, and a name -> value map", () => {
    expect(vFormClose([])).toBe(true);
    expect(vFormClose([null])).toBe(true);
    expect(vFormClose([{ customer: "Acme", picked: ["a", "b"], ok: true, n: 1, none: null }])).toBe(true);
  });

  it("refuses too many keys, a bad key, an oversized string and a non-object", () => {
    const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    expect(vFormClose([keys(64)])).toBe(true);
    expect(vFormClose([keys(65)])).not.toBe(true);
    expect(vFormClose([{ "a-b": 1 }])).not.toBe(true);
    expect(vFormClose([{ a: "x".repeat(MAX_FORM_VALUE_CHARS + 1) }])).not.toBe(true);
    expect(vFormClose(["done"])).not.toBe(true);
    expect(vFormClose([["a"]])).not.toBe(true);
  });
});

// ============================================================================
// Provenance
// ============================================================================

describe("formOriginForMount", () => {
  it("reads provenance, never the package NAME — an application called \"local\" is a package", () => {
    // THE BUG THIS SHAPE REMOVES. The identity band used to branch on a single
    // string in which "local" meant "a script in this workbook" and everything
    // else was an application name, so a publisher could buy the local phrasing
    // by choosing a name. `kind` is derived from `provenance`, which the pull
    // path stamps and no publisher writes.
    expect(
      formOriginForMount({ provenance: "distributed", packageName: "local" }),
    ).toEqual({ kind: "package", name: "local" });
  });

  it("calls a locally authored script local, whatever it is otherwise carrying", () => {
    expect(formOriginForMount({ provenance: "local" })).toEqual({ kind: "local" });
    expect(formOriginForMount({})).toEqual({ kind: "local" });
    // A stale packageName on a local script does not make it a package.
    expect(formOriginForMount({ provenance: "local", packageName: "Sales Pack" })).toEqual({
      kind: "local",
    });
  });

  it("uses the same nameless-package placeholder the trust handle uses", () => {
    // broker.ts's buildHandleFromDefinition spells it "(unknown package)"; the
    // band and the cross-script trust predicate must name one publisher one way.
    expect(formOriginForMount({ provenance: "distributed" })).toEqual({
      kind: "package",
      name: "(unknown package)",
    });
    expect(formOriginForMount({ provenance: "distributed", packageName: "" })).toEqual({
      kind: "package",
      name: "(unknown package)",
    });
  });
});

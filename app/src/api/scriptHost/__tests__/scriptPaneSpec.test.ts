//! FILENAME: app/src/api/scriptHost/__tests__/scriptPaneSpec.test.ts
// PURPOSE: The pane validators (vPaneDock / vPaneUpdate / vPaneSetBadge /
//          vPaneId) and the five `pane.*` ALLOWLIST rows (M2 S3).
// CONTEXT: "One validator body, two surfaces." vPaneDock and vPaneUpdate must
//          refuse EXACTLY what vFormDefine and vFormUpdate refuse, and the
//          proof is not a copy of the form tests: every case here is run through
//          BOTH doors and the two verdicts are asserted IDENTICAL. A pane
//          validator that grew its own walk — or a form validator that
//          tightened a bound the pane door did not — reds here on that case.
//          The rows are pinned the way formConsentHonesty.test.ts pins the form
//          rows: capability, class, deadline, audit classification, and consent
//          text that says what a pane is and never borrows the modal's words.

import { describe, it, expect } from "vitest";
import {
  vFormDefine,
  vFormShow,
  vFormUpdate,
  vPaneDock,
  vPaneId,
  vPaneSetBadge,
  vPaneUpdate,
} from "../validators";
import { MAX_PANE_BADGE_CHARS, MAX_PANE_ID_CHARS, MAX_PANE_KEY_CHARS, MAX_PANES_PER_SCRIPT } from "../scriptPaneSpec";
import { ALLOWLIST } from "../allowlist";
import { METHOD_DEADLINES_MS, UI_DIALOG_DEADLINE_MS, callDeadlineMs, CALL_TIMEOUT_MS } from "../protocol";
import { capabilityAuditClassification } from "../broker";

const MEDIA = "media:" + "0123456789abcdef".repeat(4);
const form = (children: unknown[], over: Record<string, unknown> = {}) => ({ children, ...over });
const labels = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "label", text: `L${i}` }));
const textboxes = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "textbox", name: `t${i}`, label: `T${i}` }));
const nested = (n: number): unknown => {
  let node: unknown = { type: "label", text: "leaf" };
  for (let i = 0; i < n; i++) node = { type: "group", children: [node] };
  return node;
};

/**
 * Trees the FORM validator has an opinion about, accepted and refused alike.
 * The expected verdict is not written here — it is whatever vFormDefine says,
 * and the assertion is that vPaneDock says the same thing.
 */
const SPEC_CASES: Array<[label: string, spec: unknown]> = [
  ["smallest valid form", form([{ type: "label", text: "Hi" }])],
  ["one of everything, nested", form([
    { type: "textbox", name: "customer", label: "Customer", bind: "B2", required: true },
    { type: "dropdown", name: "region", options: ["EMEA", { value: "apac", label: "APAC" }] },
    { type: "row", children: [{ type: "number", name: "rate", min: 0, max: 10 }] },
    { type: "group", title: "Adv", children: [{ type: "listbox", name: "sheets", options: { range: "A1:A9" }, multi: true }] },
    { type: "tabs", pages: [{ title: "N", children: [{ type: "textbox", name: "notes", multiline: true }] }] },
    { type: "image", src: MEDIA },
    { type: "table", columns: ["a"], rows: [["x"]] },
    { type: "progress", name: "done", value: 1, max: 3 },
    { type: "button", name: "go", text: "Go" },
  ], { title: "T", width: 640, writeOn: "change", focus: "customer" })],
  ["200 nodes (accepted)", form(labels(200))],
  ["201 nodes (refused)", form(labels(201))],
  ["depth 8 (accepted)", form([nested(8)])],
  ["depth 9 (refused)", form([nested(9)])],
  ["a hostile 10,000-deep chain", form([nested(10_000)])],
  ["64 inputs (accepted)", form(textboxes(64))],
  ["65 inputs (refused)", form(textboxes(65))],
  ["duplicate name", form([{ type: "textbox", name: "dup" }, { type: "group", children: [{ type: "checkbox", name: "dup" }] }])],
  ["reserved name __proto__", form([{ type: "textbox", name: "__proto__" }])],
  ["a regex pattern", form([{ type: "textbox", name: "a", pattern: "^[a-z]+$" }])],
  ["the reserved html type", form([{ type: "html", name: "h", html: "<b>x</b>" }])],
  ["an unknown widget type", form([{ type: "iframe", src: "x" }])],
  ["an image introducing bytes", form([{ type: "image", src: "data:image/png;base64,AAAA" }])],
  ["an unknown top-level key", { ...form([{ type: "label", text: "x" }]), onSubmit: "handler" }],
  ["empty children", form([])],
  ["width below the floor", form([{ type: "label", text: "x" }], { width: 10 })],
  ["not an object", "textbox"],
];

describe("vPaneDock is vFormDefine's verdict, case for case", () => {
  it.each(SPEC_CASES)("%s", (_label, spec) => {
    expect(vPaneDock([spec])).toEqual(vFormDefine([spec]));
  });

  it("the shared cases really contain refusals AND acceptances (the comparison is not vacuous)", () => {
    const verdicts = SPEC_CASES.map(([, spec]) => vFormDefine([spec]));
    expect(verdicts.filter((v) => v === true).length).toBeGreaterThanOrEqual(4);
    expect(verdicts.filter((v) => v !== true).length).toBeGreaterThanOrEqual(10);
  });

  it("a MISSING spec gets the author's sentence, not the walker's", () => {
    expect(vPaneDock([null])).toMatch(/pane\.define/);
    expect(vPaneDock([undefined])).toMatch(/pane\.define/);
    // ...while a wrong-typed one still gets the walker's.
    expect(vPaneDock(["x"])).toBe(vFormDefine(["x"]));
  });

  it("judges the dock options as form.show judges its options", () => {
    const spec = form([{ type: "textbox", name: "a" }]);
    expect(vPaneDock([spec, undefined])).toBe(true);
    expect(vPaneDock([spec, { initial: { a: "x" } }])).toBe(true);
    const unknown = vPaneDock([spec, { modal: true }]);
    expect(unknown).not.toBe(true);
    expect(String(unknown)).toContain("dock option");
    expect(vPaneDock([spec, { initial: { a: { nested: 1 } } }])).not.toBe(true);
  });

  it("judges `key` — the pane's slot name, a panel-id segment — as an identifier, and says what it is for", () => {
    const spec = form([{ type: "textbox", name: "a" }]);
    expect(vPaneDock([spec, { key: "status" }])).toBe(true);
    expect(vPaneDock([spec, { key: "a-b_C9" }])).toBe(true);
    expect(vPaneDock([spec, { key: "0" }])).toBe(true);
    expect(vPaneDock([spec, { key: "k".repeat(MAX_PANE_KEY_CHARS) }])).toBe(true);
    expect(vPaneDock([spec, { key: "status", initial: { a: "x" } }])).toBe(true);
    // Empty, too long, a space, a slash, a dot (a second separator inside the
    // panel id), and not a string at all — one sentence for every one of them.
    for (const bad of ["", "k".repeat(MAX_PANE_KEY_CHARS + 1), "my pane", "a/b", "a.b", 3, null]) {
      const verdict = vPaneDock([spec, { key: bad }]);
      expect(verdict, JSON.stringify(bad)).not.toBe(true);
      expect(String(verdict), JSON.stringify(bad)).toMatch(/^key must be 1-32 characters of letters, digits, "_" or "-"/);
      expect(String(verdict), JSON.stringify(bad)).toMatch(/remembered/);
    }
    // The key is refused BEFORE the shared option check, and it is the pane
    // door's alone: form.show has no placement to remember.
    expect(vPaneDock([spec, { key: "", modal: true }])).toMatch(/^key must be/);
    expect(vFormShow([{ key: "status" }])).not.toBe(true);
    expect(MAX_PANE_KEY_CHARS).toBe(32);
  });
});

const PATCH_CASES: Array<[label: string, patch: unknown]> = [
  ["values only", { values: { a: 1 } }],
  ["controls: disabled/hidden/text/options/error", { controls: { a: { disabled: true, hidden: false, text: "t", options: ["x"], error: null } } }],
  ["controls: a { range } list (refused)", { controls: { a: { options: { range: "A1:A3" } } } }],
  ["controls: an unknown control key", { controls: { a: { color: "red" } } }],
  // JSON.parse creates an OWN "__proto__" key (an object literal would set the prototype instead).
  ["controls: a reserved control name", { controls: JSON.parse('{"__proto__": { "text": "x" }}') }],
  ["controls: 65 entries", { controls: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`c${i}`, { text: "x" }])) }],
  ["focus + message", { focus: "a", message: { text: "hi", kind: "info" } }],
  ["message of an unknown kind", { message: { text: "hi", kind: "loud" } }],
  ["an unknown patch key", { badge: "3" }],
  ["not an object", []],
];

describe("vPaneUpdate is vFormUpdate's verdict, case for case", () => {
  it.each(PATCH_CASES)("%s", (_label, patch) => {
    expect(vPaneUpdate(["pane-1", patch])).toEqual(vFormUpdate([patch]));
  });

  it("the shared patch cases contain refusals AND acceptances", () => {
    const verdicts = PATCH_CASES.map(([, patch]) => vFormUpdate([patch]));
    expect(verdicts.filter((v) => v === true).length).toBeGreaterThanOrEqual(3);
    expect(verdicts.filter((v) => v !== true).length).toBeGreaterThanOrEqual(5);
  });

  it("names the pane first: an empty id is 'nothing is docked', never a patch complaint", () => {
    expect(vPaneUpdate(["", { values: { a: 1 } }])).toMatch(/no pane is docked/);
    expect(vPaneUpdate([undefined, { values: { a: 1 } }])).toMatch(/no pane is docked/);
  });
});

describe("vPaneSetBadge / vPaneId", () => {
  it("accepts a short badge or null, refuses a long one or a non-string", () => {
    expect(vPaneSetBadge(["pane-1", "3"])).toBe(true);
    expect(vPaneSetBadge(["pane-1", "x".repeat(MAX_PANE_BADGE_CHARS)])).toBe(true);
    expect(vPaneSetBadge(["pane-1", null])).toBe(true);
    expect(vPaneSetBadge(["pane-1", "x".repeat(MAX_PANE_BADGE_CHARS + 1)])).toMatch(/max 8 chars/);
    expect(vPaneSetBadge(["pane-1", 3])).not.toBe(true);
    expect(vPaneSetBadge(["", "3"])).toMatch(/no pane is docked/);
  });

  it("pins the badge bound the literal above is written against", () => {
    expect(MAX_PANE_BADGE_CHARS).toBe(8);
    expect(MAX_PANES_PER_SCRIPT).toBe(3);
  });

  it("a pane id is a non-empty bounded string", () => {
    expect(vPaneId(["pane-1"])).toBe(true);
    expect(vPaneId([""])).toMatch(/no pane is docked/);
    expect(vPaneId([undefined])).toMatch(/no pane is docked/);
    expect(vPaneId(["p".repeat(MAX_PANE_ID_CHARS + 1)])).toMatch(/max 64 chars/);
  });
});

// ----------------------------------------------------------------------------
// The six rows
// ----------------------------------------------------------------------------
// `pane.list` joined them with M3c: one registry answers for a docked task pane
// AND for a form the user embedded on a sheet, and a script that only ever
// docked knew its pane's id from the dock's own result — an embedded surface is
// opened by the host, so the list is the one call that says which surfaces
// exist. It rides ui.pane like the rest, and the host filters it to the caller.

const PANE_ROWS = ["pane.dock", "pane.update", "pane.setBadge", "pane.reveal", "pane.close", "pane.list"] as const;
/** The two capability-bearing doors whose FIRST call awaits a consent dialog. */
const PROMPTING_ROWS = ["pane.dock", "pane.reveal"] as const;

describe("the pane rows carry exactly the capability their consent sentence covers", () => {
  it("every pane row needs ui.pane — never ui.dialog, never nothing", () => {
    const paneRows = Object.keys(ALLOWLIST).filter((k) => k.startsWith("pane."));
    expect(paneRows.sort()).toEqual([...PANE_ROWS].sort());
    for (const name of paneRows) {
      expect(ALLOWLIST[name].tier, name).toBe("restricted");
      expect(ALLOWLIST[name].capability, name).toBe("ui.pane");
    }
  });

  it("the entry point and the reveal are class ui (their first call awaits consent); the rest emit", () => {
    for (const name of PROMPTING_ROWS) expect(ALLOWLIST[name].class, name).toBe("ui");
    expect(ALLOWLIST["pane.update"].class).toBe("emit");
    expect(ALLOWLIST["pane.setBadge"].class).toBe("emit");
    expect(ALLOWLIST["pane.close"].class).toBe("emit");
  });

  it("the two ui-class rows carry the person-length deadline, the others the ordinary one", () => {
    for (const name of PROMPTING_ROWS) {
      expect(METHOD_DEADLINES_MS[name], name).toBe(UI_DIALOG_DEADLINE_MS);
      expect(callDeadlineMs(name), name).toBe(UI_DIALOG_DEADLINE_MS);
    }
    for (const name of ["pane.update", "pane.setBadge", "pane.close"]) {
      expect(METHOD_DEADLINES_MS[name], name).toBeUndefined();
      expect(callDeadlineMs(name), name).toBe(CALL_TIMEOUT_MS);
    }
  });

  it("every pane row is BROKER-audited with a stated reason — no Rust gate records a pane", () => {
    const { brokerAudited, serverAudited } = capabilityAuditClassification();
    for (const name of PANE_ROWS) {
      expect(brokerAudited.has(name), name).toBe(true);
      expect(serverAudited.has(name), name).toBe(false);
      expect(brokerAudited.get(name)!.length).toBeGreaterThan(10);
    }
  });

  it("every desc says what a pane is — 'task pane', 'while you work' — and never borrows the modal's words", () => {
    for (const name of PANE_ROWS) {
      const desc = ALLOWLIST[name].desc;
      expect(desc, name).toMatch(/task pane/);
      expect(desc, name).toMatch(/while you work/);
      expect(desc, name).not.toMatch(/must answer|before continuing|dialog/);
    }
  });

  it("the update row states the bucket the host enforces", () => {
    expect(ALLOWLIST["pane.update"].limits?.perSecond).toBe(ALLOWLIST["form.update"].limits?.perSecond);
    expect(ALLOWLIST["pane.dock"].limits?.maxPanes).toBe(MAX_PANES_PER_SCRIPT);
  });
});

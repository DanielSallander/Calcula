//! FILENAME: app/extensions/ScriptableObjects/__tests__/formDesignerPanel.test.tsx
// PURPOSE: The visual designer against a REAL buffer: that a drag writes code, a
//          reorder writes only an order, a property writes only that key,
//          nothing outside the `#region` ever moves, an unreadable layout
//          refuses instead of guessing, and the code tab and the designer never
//          lose each other's work.
// CONTEXT: M5b of docs/design/typescript-forms.md §14.
//
//          THE BUFFER IS A REAL `LiveModulePersister`. Asserting against a
//          `vi.fn()` would prove the panel called something; asserting against
//          the persister's own `storedSource` proves the bytes a Run would
//          execute. Its gate is a pass-through (the scaffold is JavaScript, so
//          the real gate is a pass-through too) and its debounce is zero, so
//          `flush` is what a Ctrl+S would do.
//
//          THE SCAFFOLD IS THE FIXTURE, not a hand-written copy — the same rule
//          the AST tests follow (`getScaffoldTemplate("form", …)`). A copy stops
//          testing the designer the day the scaffold changes shape.
//
//          jsdom gives every element a zero-sized rect, so the drop tests STUB
//          the rects of the cards and of the drop target. That is honest about
//          what is being tested: the insert-index arithmetic and the write, not
//          the browser's hit testing (which the shared gesture owns and the
//          pivot field editor already exercises).
//
//          @testing-library/react is not installed in this repo, so this file
//          drives react-dom + `act` directly, as its sibling component tests do
//          (scriptPaneSection.test.tsx, embeddedFormSurface.test.tsx).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act, useCallback, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { getScaffoldTemplate } from "@api/scriptableObjectScaffolds";
import { readFormRegion } from "@api/formDesigner";
import type { FormSpec } from "@api/scriptHost/scriptFormSpec";

import { LiveModulePersister } from "../lib/liveModuleBuffer";
import { FormDesignerPanel } from "../components/formDesigner";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const SCAFFOLD = getScaffoldTemplate("form", "Form1");
const DOC_ID = "module-form-1";

const REGION_START = "// #region Form layout";
const REGION_END = "// #endregion";

// ----------------------------------------------------------------------------
// Harness
// ----------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
let persister: LiveModulePersister;
/** Every source the persister was told to store, newest last. */
let stored: string[];
/** Set the buffer from OUTSIDE the designer — what typing in the code tab does. */
let typeInCodeTab: (next: string) => void;

function Harness({ initial }: { initial: string }): React.ReactElement {
  const [source, setSource] = useState(initial);
  // The buffer's one write path, shared by the designer and by the test acting
  // as the code tab. Published to the test in an EFFECT rather than during
  // render — a module variable assigned mid-render is a side effect React may
  // discard, and the lint rule that says so is right about this file too.
  const write = useCallback((next: string) => {
    persister.note(DOC_ID, "Form1", next);
    setSource(next);
  }, []);
  useEffect(() => {
    typeInCodeTab = write;
  }, [write]);
  return (
    <FormDesignerPanel
      source={source}
      onSourceChange={write}
      onEditAsCode={() => {}}
      fileLabel="Form1"
    />
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  stored = [];
  persister = new LiveModulePersister({
    // The scaffold is JavaScript, so the real save gate passes it through byte
    // for byte too — the stored bytes ARE the buffer bytes.
    gate: (source) => Promise.resolve({ ok: true as const, javascript: source, transformed: false }),
    write: (_docId, javascript) => {
      stored.push(javascript);
      return Promise.resolve();
    },
    debounceMs: 0,
  });
  persister.track(DOC_ID, "Form1", SCAFFOLD);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  persister.dispose();
});

async function mount(source = SCAFFOLD): Promise<void> {
  // Re-baseline the buffer on the text actually being mounted. `track` on a
  // document the persister already follows moves only its "last stored" mark
  // and leaves the buffer where it was, which would make a mount of anything
  // but the scaffold look like an unsaved edit back TO the scaffold.
  persister.forget(DOC_ID);
  persister.track(DOC_ID, "Form1", source);
  await act(async () => {
    root.render(<Harness initial={source} />);
  });
  await settle();
}

/** Let the lazy compiler chunk load and every pending read/write land. */
async function settle(tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
    if (container.querySelector("[data-testid='form-designer'], [data-testid='designer-refusal']")) {
      // Give any in-flight write one more turn to reach the buffer.
      if (i > 2) return;
    }
  }
}

async function waitFor(predicate: () => boolean, label: string, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The bytes the store holds after everything pending has been written. */
async function bufferBytes(): Promise<string> {
  await act(async () => {
    await persister.flush(DOC_ID, true);
  });
  return persister.storedSource(DOC_ID) ?? "";
}

/** The layout the buffer now declares, read back through the real AST reader. */
async function bufferSpec(): Promise<FormSpec> {
  const result = await readFormRegion(await bufferBytes(), { fileLabel: "Form1" });
  if (!result.ok) throw new Error(`the buffer no longer reads: ${result.refusal.message}`);
  return result.spec;
}

const q = <T extends Element = HTMLElement>(testId: string): T | null =>
  container.querySelector<T>(`[data-testid='${testId}']`);

const must = <T extends Element = HTMLElement>(testId: string): T => {
  const found = q<T>(testId);
  if (!found) throw new Error(`no [data-testid='${testId}'] on screen`);
  return found;
};

const cards = (): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-designer-node]"));

/** jsdom has no layout: give the cards and the drop targets real geometry. */
function stubGeometry(): void {
  const rect = (top: number, height: number): DOMRect =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 300,
      width: 300,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  must("designer-node-list").getBoundingClientRect = () => rect(0, 10_000);
  cards().forEach((card, i) => {
    card.getBoundingClientRect = () => rect(i * 100, 100);
    // A container card's BODY is the lower 70px of it — the real layout too:
    // the header band above it belongs to no card target, which is what keeps
    // "drop BESIDE this container" reachable once the body takes drops.
    const body = card.querySelector<HTMLElement>("[data-designer-container-drop]");
    if (body) body.getBoundingClientRect = () => rect(i * 100 + 30, 70);
  });
}

function mouse(target: EventTarget, type: string, x: number, y: number): void {
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
  );
}

/** Press on `from`, move, release at (x, y) — the shared drag gesture. */
async function drag(from: Element, x: number, y: number): Promise<void> {
  await act(async () => {
    mouse(from, "mousedown", 0, 0);
    mouse(document, "mousemove", x, y);
    mouse(document, "mouseup", x, y);
  });
}

function key(target: Element, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

/** Everything before the opening marker, and everything from `// #endregion`. */
function outsideRegion(source: string): { prefix: string; suffix: string } {
  const start = source.indexOf(REGION_START);
  const end = source.indexOf(REGION_END);
  expect(start, "the region's opening marker").toBeGreaterThan(-1);
  expect(end, "the region's closing marker").toBeGreaterThan(start);
  return { prefix: source.slice(0, start), suffix: source.slice(end) };
}

// ----------------------------------------------------------------------------
// Opening
// ----------------------------------------------------------------------------

describe("opening the designer", () => {
  it("draws the scaffold's widgets through the shared tree, and writes nothing", async () => {
    await mount();
    expect(q("form-designer")).not.toBeNull();
    // The scaffold's six top-level widgets, in order.
    expect(cards().map((c) => c.getAttribute("data-widget-type"))).toEqual([
      "textbox", "dropdown", "row", "date", "checkbox", "label",
    ]);
    // Painted by FormWidgetTree, not by chrome of the designer's own.
    expect(must("designer-preview-0").querySelector("[data-script-form-widgets]")).not.toBeNull();
    // OPENING IS NOT AN EDIT. The writer's no-op rule is what makes this true,
    // and a designer that reprinted the block on open would dirty every form
    // script the moment it was looked at.
    expect(stored).toEqual([]);
    expect(await bufferBytes()).toBe(SCAFFOLD);
  });

  it("REFUSES a layout it cannot read exactly, naming what it found, and draws no canvas", async () => {
    const unreadable = SCAFFOLD.replace(
      '{ type: "checkbox", name: "rush",     label: "Rush order" },',
      "...extraWidgets(),",
    );
    await mount(unreadable);
    const refusal = must("designer-refusal");
    expect(refusal.getAttribute("data-refusal-code")).toBe("unrepresentable");
    expect(refusal.textContent).toMatch(/spread/i);
    expect(refusal.textContent).toMatch(/line \d+/);
    // No canvas, no palette: an approximation of the user's code is worse than
    // no designer, and the only thing offered is the code editor.
    expect(q("form-designer")).toBeNull();
    expect(q("designer-canvas")).toBeNull();
    expect(q("designer-refusal-edit-as-code")).not.toBeNull();
    expect(stored).toEqual([]);
  });
});

describe("a second define outside the block", () => {
  it("warns that what the designer edits may not be what the form shows", async () => {
    // Legal code — the designer owns only the call inside the markers — but
    // whichever define runs LAST is the layout, so silence here would be the
    // designer quietly editing a layout nobody sees.
    const twoDefines = SCAFFOLD.replace(
      "  const answers = await context.show();",
      '  context.define({ children: [{ type: "label", text: "Something else" }] });\n' +
        "  const answers = await context.show();",
    );
    await mount(twoDefines);
    const banner = must("designer-outside-define-banner");
    expect(banner.textContent).toContain("1 more time");
    // It is a warning, not a refusal: the canvas is drawn and editing works.
    expect(must("form-designer").getAttribute("data-designer-blocked")).toBe("false");
    expect(cards().length).toBe(6);
  });
});

describe("comments inside the block", () => {
  /** The scaffold with one comment strictly between the two markers. */
  const COMMENTED = SCAFFOLD.replace(
    "  form.define({",
    "  // Quantity and price feed the total below.\n  form.define({",
  );

  it("BLOCKS every edit until the user has been told the comment will be deleted", async () => {
    await mount(COMMENTED);
    const banner = must("designer-block-banner");
    // The sentence names how many, and which line — it is the only warning the
    // user gets before a re-emit destroys text they typed.
    expect(banner.textContent).toContain("1 comment");
    expect(banner.textContent).toMatch(/line \d+/);
    expect(must("form-designer").getAttribute("data-designer-blocked")).toBe("true");

    // A palette press while blocked writes NOTHING.
    await act(async () => {
      must("designer-palette-spacer").click();
    });
    await settle();
    expect(stored).toEqual([]);
    expect(await bufferBytes()).toBe(COMMENTED);

    // Accepting the loss unblocks it, and only then does the same press write.
    await act(async () => {
      must("designer-accept-comment-loss").click();
    });
    expect(q("designer-block-banner")).toBeNull();
    await act(async () => {
      must("designer-palette-spacer").click();
    });
    await waitFor(() => currentSource().includes('type: "spacer"'), "the write after acknowledging");
    expect((await bufferSpec()).children.map((w) => w.type)).toContain("spacer");
  });
});

// ----------------------------------------------------------------------------
// Editing
// ----------------------------------------------------------------------------

describe("dropping a widget", () => {
  it("writes the region and the buffer holds the new source", async () => {
    await mount();
    const before = await bufferSpec();
    stubGeometry();
    // Released between the second and third card: 120 is past the first card's
    // midpoint (50) and the second's (150) is still ahead of it.
    await drag(must("designer-palette-number"), 10, 120);
    await waitFor(() => stored.length > 0 || persister.hasUnsavedEdits(DOC_ID), "the write to land");

    const after = await bufferSpec();
    expect(after.children.map((w) => w.type)).toEqual([
      "textbox", "number", "dropdown", "row", "date", "checkbox", "label",
    ]);
    // The buffer holds SOURCE, not a spec: the new widget is in the text.
    const bytes = await bufferBytes();
    expect(bytes).toContain('type: "number"');
    expect(bytes).not.toBe(SCAFFOLD);
    // Everything that was there before is still there, unchanged.
    expect(after.children.filter((w) => w.type !== "number")).toEqual(before.children);
    expect(after.title).toBe(before.title);
  });

  it("moves nothing outside the region — the bytes before and after it are identical", async () => {
    await mount();
    stubGeometry();
    await drag(must("designer-palette-label"), 10, 5);
    await waitFor(() => stored.length > 0 || persister.hasUnsavedEdits(DOC_ID), "the write to land");

    const bytes = await bufferBytes();
    const was = outsideRegion(SCAFFOLD);
    const now = outsideRegion(bytes);
    // Compared as SLICES, never `toContain`: a suffix check would stay green
    // while the writer reindented everything after the block.
    expect(now.prefix).toBe(was.prefix);
    expect(now.suffix).toBe(was.suffix);
    // The `// @capability ui.dialog` pragma and the trailing newline are in that
    // prefix and suffix, so they are pinned by the two lines above — but say so.
    expect(now.prefix).toContain("// @capability ui.dialog");
    expect(bytes.endsWith("\n")).toBe(true);
  });
});

// A DESIGNER THAT CANNOT REPARENT IS A DESIGNER THAT MAKES YOU RETYPE. The
// canvas registered exactly one drop target — the open container's list — so
// every drop resolved to the list the drag STARTED in: the designer reordered,
// and a widget released onto a group landed beside it, silently, with the group
// unchanged. The only way to get a configured widget into a group was to delete
// it and build it again, property by property.
describe("moving a widget into a container", () => {
  /** The row's card body, once the geometry is stubbed: the third card, 230..300. */
  const ROW_BODY_Y = 260;

  it("drops a configured widget into a container card, carrying every key with it", async () => {
    await mount();
    const before = await bufferSpec();
    const wasTextbox = before.children[0] as Record<string, unknown>;
    // The widget being moved is CONFIGURED — that is the whole point of moving
    // one rather than deleting it: six keys, all of which must arrive intact.
    expect(Object.keys(wasTextbox).sort()).toEqual(
      ["bind", "label", "maxLength", "name", "required", "type"],
    );
    stubGeometry();

    // Press the textbox card's HEADER (the drag handle) and release over the
    // BODY of the row's card — the gesture that used to reorder instead.
    await drag(must("designer-node-header-0"), 10, ROW_BODY_Y);
    await waitFor(() => stored.length > 0 || persister.hasUnsavedEdits(DOC_ID), "the reparent to land");
    // The write and the re-read are two steps; the canvas is only inside the row
    // once the second has come back.
    await waitFor(() => cards().length === 3, "the canvas to descend into the row");

    const after = await bufferSpec();
    // It LEFT the root list...
    expect(after.children.map((w) => w.type)).toEqual([
      "dropdown", "row", "date", "checkbox", "label",
    ]);
    // ...and arrived at the end of the row, WHOLE. Member for member, not a
    // widget of the same type rebuilt on the way in.
    const row = after.children[1] as unknown as { type: string; children: unknown[] };
    expect(row.type).toBe("row");
    expect(row.children.map((w) => (w as { type: string }).type)).toEqual([
      "number", "number", "textbox",
    ]);
    expect(row.children[2]).toEqual(wasTextbox);
    // Nothing else about the form moved.
    expect(after.title).toBe(before.title);
    expect(after.children.slice(2)).toEqual(before.children.slice(3));

    // The canvas followed it in and kept it selected, so the property panel is
    // still editing the thing that just moved — the work the user would
    // otherwise have retyped is one keystroke away, not gone.
    expect(must("designer-breadcrumb").textContent).toContain("row");
    expect(cards().map((c) => c.getAttribute("data-widget-type"))).toEqual([
      "number", "number", "textbox",
    ]);
    expect(must("designer-node-1p0.2").getAttribute("aria-selected")).toBe("true");
    expect(must<HTMLInputElement>("designer-prop-label-input").value).toBe("Customer");
  });

  it("REFUSES a container released into its own body, and writes nothing", async () => {
    await mount();
    stubGeometry();
    // The row's card, dropped onto the row's card. `moveWidget` would detach the
    // whole branch, so this must be a sentence rather than a silent no-op.
    await drag(must("designer-node-header-2"), 10, ROW_BODY_Y);
    await settle();

    expect(must("designer-write-refusal").textContent).toContain("inside itself");
    expect(stored).toEqual([]);
    expect(await bufferBytes()).toBe(SCAFFOLD);
    expect(cards().length).toBe(6);
  });

  it("Ctrl+Right moves the selection into the container above it, Ctrl+Left back out", async () => {
    await mount();
    const before = await bufferSpec();
    const list = must("designer-node-list");

    // The date field — fourth card, sitting directly below the row. One press
    // per `act`: the key handler is a closure over the selection, so four
    // presses batched into one commit would all move from the same place.
    await act(async () => {
      list.focus();
    });
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        key(list, { key: "ArrowDown" });
      });
    }
    expect(must("designer-node-3").getAttribute("aria-selected")).toBe("true");
    expect(must("designer-node-3").getAttribute("data-widget-type")).toBe("date");

    await act(async () => {
      key(list, { key: "ArrowRight", ctrlKey: true });
    });
    await waitFor(() => cards().length === 3, "the indent to land");

    const indented = await bufferSpec();
    expect(indented.children.map((w) => w.type)).toEqual([
      "textbox", "dropdown", "row", "checkbox", "label",
    ]);
    const row = indented.children[2] as unknown as { children: unknown[] };
    expect(row.children.map((w) => (w as { type: string }).type)).toEqual([
      "number", "number", "date",
    ]);
    expect(row.children[2]).toEqual(before.children[3]);
    expect(must("designer-breadcrumb").textContent).toContain("row");

    // And back out, landing directly after the container it came from.
    await act(async () => {
      key(must("designer-node-list"), { key: "ArrowLeft", ctrlKey: true });
    });
    await waitFor(() => cards().length === 6, "the outdent to land");
    // Exactly the layout it started as — an indent and an outdent that did not
    // compose would show up here as a permutation, not as an error.
    expect(await bufferSpec()).toEqual(before);
  });

  it("says why Ctrl+Right did nothing when there is no container above", async () => {
    await mount();
    const list = must("designer-node-list");
    // The first widget: nothing at all is above it.
    await act(async () => {
      list.focus();
      key(list, { key: "ArrowDown" });
    });
    expect(must("designer-node-0").getAttribute("data-widget-type")).toBe("textbox");
    await act(async () => {
      key(list, { key: "ArrowRight", ctrlKey: true });
    });
    await settle();

    const message = must("designer-write-refusal").textContent ?? "";
    expect(message).toContain("Ctrl+Right");
    expect(message).toContain("group");
    expect(stored).toEqual([]);
    expect(await bufferBytes()).toBe(SCAFFOLD);
  });
});

describe("reordering", () => {
  it("changes the order and nothing else", async () => {
    await mount();
    const before = await bufferSpec();
    const list = must("designer-node-list");

    // Select the first widget from the KEYBOARD, then move it down one place.
    await act(async () => {
      list.focus();
      key(list, { key: "ArrowDown" });
    });
    expect(must("designer-node-0").getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      key(must("designer-node-0"), { key: "ArrowDown", ctrlKey: true });
    });
    await waitFor(() => stored.length > 0 || persister.hasUnsavedEdits(DOC_ID), "the reorder to land");

    const after = await bufferSpec();
    expect(after.children.map((w) => w.type)).toEqual([
      "dropdown", "textbox", "row", "date", "checkbox", "label",
    ]);
    // A REORDER IS A PERMUTATION. Every widget is the one it was, member for
    // member — a designer that rebuilt the widgets while moving them would pass
    // a type-order assertion and quietly drop `maxLength` on the way past.
    expect([...after.children].sort(byName)).toEqual([...before.children].sort(byName));
    expect(after.title).toBe(before.title);
    expect(after.submitLabel).toBe(before.submitLabel);
    expect(after.width).toBe(before.width);
  });
});

describe("editing a property", () => {
  it("writes only that key", async () => {
    await mount();
    const before = await bufferSpec();
    await act(async () => {
      mouse(must("designer-node-0"), "mousedown", 0, 0);
    });
    const input = must<HTMLInputElement>("designer-prop-label-input");
    expect(input.value).toBe("Customer");
    await act(async () => {
      setInputValue(input, "Client");
      blur(input);
    });
    await waitFor(() => stored.length > 0 || persister.hasUnsavedEdits(DOC_ID), "the property write");

    const after = await bufferSpec();
    const changed = after.children[0] as Record<string, unknown>;
    const was = before.children[0] as Record<string, unknown>;
    expect(changed.label).toBe("Client");
    // Every OTHER member of that widget, and every other widget, untouched.
    for (const k of Object.keys(was)) {
      if (k === "label") continue;
      expect(changed[k], k).toEqual(was[k]);
    }
    expect(Object.keys(changed).sort()).toEqual(Object.keys(was).sort());
    expect(after.children.slice(1)).toEqual(before.children.slice(1));
  });

  it("clearing an optional value removes the key rather than writing an empty one", async () => {
    await mount();
    await act(async () => {
      mouse(must("designer-node-0"), "mousedown", 0, 0);
    });
    const input = must<HTMLInputElement>("designer-prop-bind-input");
    expect(input.value).toBe("B2");
    await act(async () => {
      setInputValue(input, "");
      blur(input);
    });
    await waitFor(() => stored.length > 0 || persister.hasUnsavedEdits(DOC_ID), "the property write");

    const after = await bufferSpec();
    expect(Object.keys(after.children[0] as object)).not.toContain("bind");
    expect(await bufferBytes()).not.toContain('bind: ""');
  });

  // A DRAFT THE PANEL REFUSES IS A SENTENCE, not just a box that snaps back.
  // The bounds these rows carry are the SPEC's own (320..1200 on the form's
  // width), and the client-side check short-circuits before the writer — so the
  // one refusal the designer can name from its own knowledge was the one that
  // never produced any words at all, while an out-of-range value the panel does
  // NOT pre-check reaches `checkFormSpec` and gets a full sentence.
  describe("a value outside the spec's own limits", () => {
    it("names the limit, writes nothing, and retracts the message on the next keystroke", async () => {
      await mount();
      // Nothing is selected, so these are the FORM's own properties.
      expect(q("designer-prop-submitLabel")).not.toBeNull();
      const input = must<HTMLInputElement>("designer-prop-width-input");
      expect(input.value).toBe("460");

      await act(async () => {
        setInputValue(input, "100");
        blur(input);
      });

      // The sentence names the key and BOTH ends of the bound it missed.
      const message = must("designer-prop-width-invalid").textContent ?? "";
      expect(message).toContain("Width");
      expect(message).toContain("320");
      expect(message).toContain("1200");
      // Reverting the box is right; reverting it in silence is what this pins.
      expect(must<HTMLInputElement>("designer-prop-width-input").value).toBe("460");
      expect(q("designer-write-refusal")).toBeNull();
      expect(stored).toEqual([]);
      expect(await bufferBytes()).toBe(SCAFFOLD);

      // A value inside the bound retracts the complaint and writes normally.
      await act(async () => {
        setInputValue(must<HTMLInputElement>("designer-prop-width-input"), "500");
      });
      expect(q("designer-prop-width-invalid")).toBeNull();
      await act(async () => {
        blur(must<HTMLInputElement>("designer-prop-width-input"));
      });
      await waitFor(() => currentSource().includes("width: 500"), "the in-range width write");
      expect((await bufferSpec()).width).toBe(500);
    });

    it("says what a WIDGET's width accepts when the draft is neither a number nor fill", async () => {
      await mount();
      await act(async () => {
        mouse(must("designer-node-0"), "mousedown", 0, 0);
      });
      const input = must<HTMLInputElement>("designer-prop-width-input");
      expect(input.value).toBe("");
      await act(async () => {
        setInputValue(input, "wide");
        blur(input);
      });
      // `number | "fill"` is not a bound, so the sentence names the SHAPE.
      const message = must("designer-prop-width-invalid").textContent ?? "";
      expect(message).toContain("Width");
      expect(message).toContain("fill");
      expect(stored).toEqual([]);
      expect(await bufferBytes()).toBe(SCAFFOLD);
    });
  });

  // A key whose editor holds the WRONG VALUE TYPE is a key nobody can set: the
  // pre-write `checkFormSpec` refuses every value the row can commit, and an
  // existing legal value is reported as something the panel cannot edit. That
  // was the state of a progress bar's `max`, which shares its name with a date
  // field's and was routed to the date text box.
  describe("a progress bar's ceiling", () => {
    /** The scaffold's checkbox, replaced by a progress bar. */
    const withProgress = (extra: string): string => {
      const source = SCAFFOLD.replace(
        '{ type: "checkbox", name: "rush",     label: "Rush order" },',
        `{ type: "progress", name: "bar",      label: "Progress"${extra} },`,
      );
      // A replacement that matched nothing would leave a test that proves
      // nothing about progress bars at all.
      expect(source).not.toBe(SCAFFOLD);
      return source;
    };

    /** Select the progress bar — fifth of the six top-level widgets. */
    async function selectProgress(): Promise<void> {
      const card = must("designer-node-4");
      expect(card.getAttribute("data-widget-type")).toBe("progress");
      await act(async () => {
        mouse(card, "mousedown", 0, 0);
      });
    }

    it("shows a numeric max as editable, not as something the panel cannot edit", async () => {
      await mount(withProgress(", value: 0, max: 100"));
      await selectProgress();
      const row = must("designer-prop-max");
      expect(row.getAttribute("data-unrepresentable")).toBeNull();
      expect(row.textContent).not.toContain("cannot edit");
      expect(must<HTMLInputElement>("designer-prop-max-input").value).toBe("100");
    });

    it("writes a typed max as a NUMBER, which the validator accepts", async () => {
      await mount(withProgress(", value: 0"));
      await selectProgress();
      const input = must<HTMLInputElement>("designer-prop-max-input");
      expect(input.value).toBe("");
      await act(async () => {
        setInputValue(input, "100");
        blur(input);
      });
      // Either outcome ends the wait, so a commit the writer REFUSES fails on
      // the banner's own words rather than on a timeout that reads like a flake.
      await waitFor(
        () =>
          stored.length > 0 ||
          persister.hasUnsavedEdits(DOC_ID) ||
          q("designer-write-refusal") !== null,
        "the property write or its refusal",
      );
      expect(q("designer-write-refusal")?.textContent ?? null).toBeNull();
      const written = (await bufferSpec()).children[4] as Record<string, unknown>;
      expect(written.type).toBe("progress");
      expect(written.max).toBe(100);
      expect(typeof written.max).toBe("number");
      const bytes = await bufferBytes();
      expect(bytes).toContain("max: 100");
      expect(bytes).not.toContain('max: "100"');
    });

    // THE BOUND IS STRICT, AND ONLY THE ROW CAN SAY SO IN TIME. `checkFormSpec`
    // wants `max > 0`, which no inclusive floor expresses: `min: 0` admits 0 and
    // hands the writer a spec it refuses — the red banner blaming the user for a
    // gesture the panel invited — and `min: 1` would refuse a legal `max: 0.5`
    // the validator is perfectly happy with. Both halves are pinned here because
    // the editor's floor and the sentence that reports it are one decision.
    it("refuses a max of 0 in the ROW, in the validator's own words, and still takes 0.5", async () => {
      const source = withProgress(", value: 0");
      await mount(source);
      await selectProgress();
      const input = must<HTMLInputElement>("designer-prop-max-input");
      await act(async () => {
        setInputValue(input, "0");
        blur(input);
      });

      const message = must("designer-prop-max-invalid").textContent ?? "";
      expect(message).toContain("Max");
      expect(message).toContain("greater than 0");
      // 5e-324 is the floor arithmetically; printing it would be the panel
      // reciting its own implementation at the user.
      expect(message).not.toContain("e-324");
      expect(must<HTMLInputElement>("designer-prop-max-input").value).toBe("");
      expect(q("designer-write-refusal")).toBeNull();
      expect(stored).toEqual([]);
      expect(await bufferBytes()).toBe(source);

      // A fraction is above the bound and must go straight through.
      await act(async () => {
        setInputValue(must<HTMLInputElement>("designer-prop-max-input"), "0.5");
        blur(must<HTMLInputElement>("designer-prop-max-input"));
      });
      await waitFor(() => currentSource().includes("max: 0.5"), "the fractional max write");
      expect(((await bufferSpec()).children[4] as Record<string, unknown>).max).toBe(0.5);
    });
  });

  // A DRAFT THAT OUTLIVES ITS WIDGET WRITES ONTO A STRANGER. The boxes commit on
  // BLUR, and a palette press moves the selection without taking focus off the
  // box — the shared drag gesture cancels the button press's default, which is
  // the browser's focus shift. Rows keyed by the field name alone were reused
  // straight through that change, and the only thing that cleared a stale draft
  // was the rendered TEXT differing, so a key absent on BOTH widgets (both boxes
  // read "") kept the typing and handed it to whatever was selected next.
  describe("a draft still in a box when the selection moves", () => {
    const DRAFT = "Enter the customer's legal name";

    it("dies with the widget it was typed for, and never lands on the one that arrived", async () => {
      await mount();
      // The textbox. `help` is absent on it and on the spacer about to arrive,
      // so both render "" — the case a text comparison cannot tell apart.
      await act(async () => {
        mouse(must("designer-node-0"), "mousedown", 0, 0);
      });
      const help = must<HTMLTextAreaElement>("designer-prop-help-input");
      expect(help.value).toBe("");
      await act(async () => {
        setTextAreaValue(help, DRAFT);
      });
      expect(help.value).toBe(DRAFT);

      // Press the palette WITHOUT leaving the field: a spacer is inserted after
      // the selection and becomes the selection.
      await act(async () => {
        must("designer-palette-spacer").click();
      });
      await waitFor(() => cards().length === 7, "the spacer to arrive");
      expect(must("designer-properties").textContent).toContain("spacer");

      // The box now belongs to the spacer and it is EMPTY. Showing the textbox's
      // sentence under a heading that says "spacer" is the panel lying about
      // what the next blur would write.
      expect(must<HTMLTextAreaElement>("designer-prop-help-input").value).toBe("");

      // Leaving it writes nothing: the draft is gone, not merely out of sight.
      await act(async () => {
        blur(must("designer-prop-help-input"));
      });
      await settle();

      const after = await bufferSpec();
      expect(after.children.map((w) => w.type)).toEqual([
        "textbox", "spacer", "dropdown", "row", "date", "checkbox", "label",
      ]);
      // Neither the widget it was typed for nor the one that arrived carries it,
      // and no other widget quietly picked it up either.
      expect(JSON.stringify(after)).not.toContain("legal name");
      for (const widget of after.children) {
        expect(Object.keys(widget), widget.type).not.toContain("help");
      }
    });

    it("still commits normally when the field is left with the same widget selected", async () => {
      await mount();
      await act(async () => {
        mouse(must("designer-node-0"), "mousedown", 0, 0);
      });
      // The positive control for the test above: remounting on a SELECTION
      // change must not have turned the ordinary commit into a no-op.
      await act(async () => {
        setTextAreaValue(must<HTMLTextAreaElement>("designer-prop-help-input"), DRAFT);
        blur(must("designer-prop-help-input"));
      });
      await waitFor(() => stored.length > 0 || persister.hasUnsavedEdits(DOC_ID), "the property write");

      const written = (await bufferSpec()).children[0] as Record<string, unknown>;
      expect(written.type).toBe("textbox");
      expect(written.help).toBe(DRAFT);
    });
  });
});

// ----------------------------------------------------------------------------
// The designer and the code tab are one buffer
// ----------------------------------------------------------------------------

describe("the designer and the code editor never lose each other's work", () => {
  it("a designer edit, then a hand edit, then a designer edit — all three survive", async () => {
    await mount();

    // 1. A designer edit.
    await act(async () => {
      must("designer-palette-spacer").click();
    });
    await waitFor(() => currentSource().includes('type: "spacer"'), "the first designer edit");

    // 2. A hand edit in the code tab, INSIDE the block the designer owns — the
    //    case that catches a designer holding its own copy of the layout.
    const handEdited = currentSource()
      .replace('title: "Form1"', 'title: "Typed by hand"')
      .replace("context.notify(", "context.log('typed too'); context.notify(");
    await act(async () => {
      typeInCodeTab(handEdited);
    });
    await waitFor(() => must("designer-breadcrumb").textContent?.includes("Typed by hand") === true,
      "the designer to re-read the hand edit");

    // 3. A second designer edit.
    await act(async () => {
      must("designer-palette-toggle").click();
    });
    await waitFor(() => currentSource().includes('type: "toggle"'), "the second designer edit");

    const after = await bufferSpec();
    expect(after.title).toBe("Typed by hand");
    expect(after.children.map((w) => w.type)).toContain("spacer");
    expect(after.children.map((w) => w.type)).toContain("toggle");
    // The hand edit OUTSIDE the region survived too.
    expect(await bufferBytes()).toContain("context.log('typed too')");
  });
});

// ----------------------------------------------------------------------------
// Keyboard
// ----------------------------------------------------------------------------

describe("keyboard reach", () => {
  it("every palette entry is a focusable button that adds its widget", async () => {
    await mount();
    const palette = must("designer-palette");
    const buttons = Array.from(palette.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(10);
    for (const button of buttons) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(button.tabIndex).toBeGreaterThanOrEqual(0);
    }
    // A press — the keyboard route — adds the widget at the end.
    await act(async () => {
      must("designer-palette-spacer").click();
    });
    await waitFor(() => currentSource().includes('type: "spacer"'), "the palette press to write");
    const after = await bufferSpec();
    expect(after.children[after.children.length - 1].type).toBe("spacer");
    // AND IT IS SELECTED. `insertWidget` returns the path for exactly this
    // reason, and the property panel is on the new widget without a further
    // click. It is a position that exists only in the spec still being re-read,
    // so a designer that judged it against the spec it edited FROM would throw
    // away the selection of every successful edit at the moment it succeeded.
    await waitFor(() => cards().length === 7, "the canvas to redraw with the spacer");
    expect(must("designer-node-6").getAttribute("aria-selected")).toBe("true");
  });

  it("the canvas is a listbox whose selection and order move on arrow keys", async () => {
    await mount();
    const list = must("designer-node-list");
    expect(list.getAttribute("role")).toBe("listbox");
    expect(list.tabIndex).toBe(0);

    await act(async () => {
      list.focus();
      key(list, { key: "ArrowDown" });
    });
    expect(must("designer-node-0").getAttribute("aria-selected")).toBe("true");
    expect(must("designer-node-0").tabIndex).toBe(0);
    expect(must("designer-node-1").tabIndex).toBe(-1);

    await act(async () => {
      key(must("designer-node-0"), { key: "ArrowDown" });
    });
    expect(must("designer-node-1").getAttribute("aria-selected")).toBe("true");

    // Enter walks INTO a container, Escape walks back out.
    await act(async () => {
      key(must("designer-node-1"), { key: "ArrowDown" });
    });
    expect(must("designer-node-2").getAttribute("data-widget-type")).toBe("row");
    await act(async () => {
      key(must("designer-node-2"), { key: "Enter" });
    });
    expect(must("designer-breadcrumb").textContent).toContain("row");
    expect(cards().map((c) => c.getAttribute("data-widget-type"))).toEqual(["number", "number"]);
    await act(async () => {
      key(must("designer-node-list"), { key: "Escape" });
    });
    expect(cards().length).toBe(6);
  });

  // A ROVING TABINDEX THAT DOES NOT ROVE IS WORSE THAN NONE. The selected card
  // takes `tabIndex=0` and the listbox drops to `-1` the moment anything is
  // selected, so if focus does not move with the selection it is left on an
  // element that is no longer in the tab order — and, with no
  // `aria-activedescendant` either, a screen reader on the listbox is told
  // nothing about the selection that just moved. The guard that was supposed to
  // move focus asked the INNER WRAPPER whether it contained `activeElement`,
  // while the focusable listbox is that wrapper's parent, so it answered "no"
  // on the only path a keyboard user can take in.
  it("moves focus onto the selected card when the canvas was reached from the keyboard", async () => {
    await mount();
    const list = must("designer-node-list");

    // Tab into the canvas: the cards are `tabIndex=-1` until something is
    // selected, so the listbox is the first and only stop — a mouse is never
    // touched in this test.
    await act(async () => {
      list.focus();
    });
    expect(document.activeElement).toBe(list);

    await act(async () => {
      key(list, { key: "ArrowDown" });
    });
    const card0 = must("designer-node-0");
    expect(card0.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(card0);
    // ...and the listbox names it, so the announcement does not depend on the
    // frame in which focus lands.
    expect(card0.id).toBe("designer-node-0");
    expect(list.getAttribute("aria-activedescendant")).toBe("designer-node-0");

    // Focus keeps up with every further arrow, from the card it is now on.
    await act(async () => {
      key(card0, { key: "ArrowDown" });
    });
    const card1 = must("designer-node-1");
    expect(document.activeElement).toBe(card1);
    expect(list.getAttribute("aria-activedescendant")).toBe("designer-node-1");
  });

  it("does NOT pull focus into the canvas when the selection moved from somewhere else", async () => {
    await mount();
    // A palette press selects the widget it just added. Focus belongs to the
    // palette button the user is standing on — the guard's whole reason for
    // existing is that a property field or a palette button must not be yanked
    // out from under the user every time the selection changes.
    const spacer = must<HTMLButtonElement>("designer-palette-spacer");
    await act(async () => {
      spacer.focus();
      spacer.click();
    });
    await waitFor(() => currentSource().includes('type: "spacer"'), "the palette press to write");
    await waitFor(() => cards().length === 7, "the canvas to redraw with the spacer");

    expect(must("designer-node-6").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(spacer);
  });
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * The last text the persister actually STORED, or the scaffold before any write.
 *
 * Used only to decide when a `waitFor` may stop; every assertion about the exact
 * bytes goes through `bufferBytes()`, which flushes first.
 */
function currentSource(): string {
  return stored.length > 0 ? stored[stored.length - 1] : SCAFFOLD;
}

/**
 * Leave the field.
 *
 * `focusout`, not `blur`: React implements `onBlur` on the bubbling `focusout`
 * event, so a dispatched `blur` reaches nothing at all — the property panel
 * commits on leaving the field, and a test that dispatched `blur` would report
 * "nothing was written" for a panel that works perfectly.
 */
function blur(input: HTMLElement): void {
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}

/** React tracks the DOM value node, so a bare `.value =` is not seen. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * The same, for a multiline row (`help`, a label's text, a list of options).
 *
 * A textarea's `value` lives on ITS OWN prototype, so the input setter above
 * silently writes nothing there and the panel sees an empty draft — which reads
 * exactly like a box the designer refused to fill.
 */
function setTextAreaValue(area: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(area, value);
  area.dispatchEvent(new Event("input", { bubbles: true }));
}

function byName(a: { type: string; name?: string }, b: { type: string; name?: string }): number {
  return `${a.type}:${a.name ?? ""}`.localeCompare(`${b.type}:${b.name ?? ""}`);
}

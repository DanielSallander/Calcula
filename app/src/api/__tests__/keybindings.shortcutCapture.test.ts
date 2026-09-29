//! FILENAME: app/src/api/__tests__/keybindings.shortcutCapture.test.ts
// PURPOSE: Any number of shortcut capture boxes can be open at once; a key goes
//          to the box that holds it, and releasing one box never ends another.
// CONTEXT: Review of BUG-0199 (K3). beginShortcutCapture kept ONE slot ("a
//          newer capture replaces an older one"), but Settings shows two boxes
//          at once -- the Add Shortcut form stays open while a row's Edit is
//          used. The row evicted the Add box, which never registered again, so
//          Ctrl+S in the Add box saved the workbook. The page-level proof is
//          extensions/Settings/__tests__/KeybindingsPage.capture.test.tsx; this
//          pins the registry's own rules.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { beginShortcutCapture, handleGlobalKeyDown, initKeybindings, resetAllKeybindings } from "../keybindings";
import { CommandRegistry } from "../commands";

const save = vi.fn();
const releases: (() => void)[] = [];

beforeAll(() => {
  initKeybindings();
});

beforeEach(() => {
  save.mockReset();
  resetAllKeybindings();
  CommandRegistry.register("core.file.save", save);
});

afterEach(() => {
  while (releases.length > 0) releases.pop()!();
  CommandRegistry.unregister("core.file.save");
  document.body.innerHTML = "";
});

function box(parent: HTMLElement = document.body): HTMLDivElement {
  const el = document.createElement("div");
  el.tabIndex = 0;
  parent.appendChild(el);
  return el;
}

function capture(el: HTMLElement): { keys: string[]; release: () => void } {
  const keys: string[] = [];
  const release = beginShortcutCapture(el, (e) => keys.push(e.key));
  releases.push(release);
  return { keys, release };
}

async function pressAt(el: HTMLElement, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: el });
  handleGlobalKeyDown(event);
  await Promise.resolve();
  return event;
}

describe("several capture boxes", () => {
  it("each box records the keys pressed in IT, and nothing runs", async () => {
    const a = box();
    const b = box();
    const ca = capture(a);
    const cb = capture(b);
    await pressAt(a, { key: "s", ctrlKey: true });
    await pressAt(b, { key: "p", ctrlKey: true });
    expect(ca.keys).toEqual(["s"]);
    expect(cb.keys).toEqual(["p"]);
    expect(save).not.toHaveBeenCalled();
  });

  it("releasing the NEWER box does not end the older one", async () => {
    const a = box();
    const b = box();
    const ca = capture(a);
    const cb = capture(b);
    cb.release();
    const e = await pressAt(a, { key: "s", ctrlKey: true });
    expect(save, "the older box's Ctrl+S saved the workbook").not.toHaveBeenCalled();
    expect(ca.keys).toEqual(["s"]);
    expect(e.defaultPrevented).toBe(true);
  });

  it("releasing the OLDER box does not end the newer one, and a second release is harmless", async () => {
    const a = box();
    const b = box();
    const ca = capture(a);
    const cb = capture(b);
    ca.release();
    ca.release();
    await pressAt(b, { key: "s", ctrlKey: true });
    expect(save).not.toHaveBeenCalled();
    expect(cb.keys).toEqual(["s"]);
  });

  it("nested boxes: the innermost holder records", async () => {
    const outer = box();
    const inner = box(outer);
    const ci = capture(inner);
    const co = capture(outer);
    await pressAt(inner, { key: "s", ctrlKey: true });
    expect(ci.keys).toEqual(["s"]);
    expect(co.keys).toEqual([]);
  });

  it("a key aimed at no box dispatches as usual (positive control)", async () => {
    const a = box();
    const ca = capture(a);
    const elsewhere = box();
    await pressAt(elsewhere, { key: "s", ctrlKey: true });
    expect(ca.keys).toEqual([]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("once every box is released, the combination runs again", async () => {
    const a = box();
    const b = box();
    capture(a).release();
    capture(b).release();
    await pressAt(a, { key: "s", ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

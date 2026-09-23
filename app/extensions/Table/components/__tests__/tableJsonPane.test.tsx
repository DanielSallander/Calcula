//! FILENAME: app/extensions/Table/components/__tests__/tableJsonPane.test.tsx
// PURPOSE: The "Table JSON" task pane that replaced the Table Design ribbon's
//          `position: fixed` JSON overlay.
// CONTEXT: The overlay kept its editor text when the selection moved to
//          another table but pointed Apply at the NEW table's id, so an Apply
//          could write one table's JSON over another. The pane keys its editor
//          by table id (a retarget is a fresh fetch) and refuses to retarget
//          while edits are pending, saying so instead.
//
//          The real `useJsonToggle` runs; only the Monaco editor is replaced by
//          a textarea double (Monaco is stubbed to render nothing in jsdom, so
//          there would be nothing to type into).

/* eslint-disable @typescript-eslint/naming-convention --
 * The module doubles below stand in for the @api namespace objects
 * (RibbonIcon, AppEvents) and a React component (JsonToggleEditor), whose real
 * names are PascalCase; `data-testid` is a DOM attribute; React's own act()
 * flag is spelled IS_REACT_ACT_ENVIRONMENT. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  listeners: new Map<string, Set<(detail: unknown) => void>>(),
  emitted: [] as Array<[string, unknown]>,
  getObjectJson: vi.fn(),
  setObjectJson: vi.fn(),
}));

vi.mock("@api", async () => {
  const icons = await vi.importActual<typeof import("@api/ribbonIcons")>("@api/ribbonIcons");
  return {
    RibbonIcon: icons.RibbonIcon,
    AppEvents: {
      TABLE_CREATED: "app:table-created",
      TABLE_DEFINITIONS_UPDATED: "app:table-definitions-updated",
    },
    onAppEvent: (name: string, cb: (detail: unknown) => void) => {
      if (!h.listeners.has(name)) h.listeners.set(name, new Set());
      h.listeners.get(name)!.add(cb);
      return () => h.listeners.get(name)?.delete(cb);
    },
    emitAppEvent: (name: string, detail?: unknown) => {
      h.emitted.push([name, detail]);
    },
  };
});

vi.mock("@api/jsonView", () => ({
  getObjectJson: (...a: unknown[]) => h.getObjectJson(...a),
  setObjectJson: (...a: unknown[]) => h.setObjectJson(...a),
}));

vi.mock("../../../_shared/components/jsonToggle", async () => {
  const actual = await vi.importActual<
    typeof import("../../../_shared/components/jsonToggle/useJsonToggle")
  >("../../../_shared/components/jsonToggle/useJsonToggle");
  const ReactActual = await vi.importActual<typeof import("react")>("react");
  interface EditorProps {
    json: string;
    onChange: (v: string) => void;
    onApply: () => void;
    onRevert: () => void;
    dirty: boolean;
  }
  return {
    useJsonToggle: actual.useJsonToggle,
    JsonToggleEditor: (props: EditorProps) =>
      ReactActual.createElement(
        "div",
        null,
        ReactActual.createElement("textarea", {
          "data-testid": "json-text",
          value: props.json,
          onChange: (e: { target: { value: string } }) => props.onChange(e.target.value),
        }),
        ReactActual.createElement("button", { onClick: props.onApply }, "Apply"),
        ReactActual.createElement("button", { onClick: props.onRevert }, "Revert"),
      ),
  };
});

import { findHardcodedColours } from "@api/layout";
import { TableJsonPane, TABLE_JSON_PANE_ID } from "../TableJsonPane";

const TABLE_STATE = "app:table-state";
const TABLE_REQUEST_STATE = "app:table-request-state";
const TABLE_DEFINITIONS_UPDATED = "app:table-definitions-updated";

let container: HTMLDivElement;
let root: Root;

function deliver(name: string, detail: unknown): void {
  act(() => {
    h.listeners.get(name)?.forEach((cb) => cb(detail));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function q<T extends Element = HTMLElement>(testId: string): T | null {
  return container.querySelector<T>(`[data-testid="${testId}"]`);
}

function typeInto(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(text: string): HTMLButtonElement {
  const b = Array.from(container.querySelectorAll("button")).find((x) => x.textContent === text);
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

async function mount(data?: Record<string, unknown>): Promise<void> {
  act(() => {
    root.render(<TableJsonPane data={data} />);
  });
  await flush();
}

beforeEach(() => {
  h.listeners.clear();
  h.emitted.length = 0;
  h.getObjectJson.mockReset();
  h.getObjectJson.mockImplementation(async (_type: string, id: string) =>
    JSON.stringify({ id, name: `Name of ${id}` }),
  );
  h.setObjectJson.mockReset();
  h.setObjectJson.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the Table JSON task pane", () => {
  it("is the table-json view", () => {
    expect(TABLE_JSON_PANE_ID).toBe("table-json");
  });

  it("with no table to show, it says how to get one", async () => {
    await mount();
    expect(q("table-json-empty")?.textContent).toMatch(/Select a cell inside a table/);
    expect(h.getObjectJson).not.toHaveBeenCalled();
    // It asked the Table extension which table the selection is on.
    expect(h.emitted.map(([n]) => n)).toContain(TABLE_REQUEST_STATE);
  });

  it("opens straight into the JSON of the table it was opened for", async () => {
    await mount({ tableId: "t1", tableName: "Sales" });
    expect(h.getObjectJson).toHaveBeenCalledWith("table", "t1");
    expect(q<HTMLTextAreaElement>("json-text")?.value).toBe('{"id":"t1","name":"Name of t1"}');
    expect(q("table-json-pane")?.textContent).toContain("Sales");
    expect(findHardcodedColours(q("table-json-pane")!.firstElementChild!)).toEqual([]);
  });

  it("follows the selection to another table (a fresh fetch, not the old text)", async () => {
    await mount({ tableId: "t1", tableName: "Sales" });
    deliver(TABLE_STATE, { table: { id: "t2", name: "Costs" } });
    await flush();
    expect(h.getObjectJson).toHaveBeenLastCalledWith("table", "t2");
    expect(q<HTMLTextAreaElement>("json-text")?.value).toBe('{"id":"t2","name":"Name of t2"}');
    expect(q("table-json-pane")?.textContent).toContain("Costs");
    expect(q("table-json-held")).toBeNull();
  });

  it("does NOT retarget while edits are pending — and Apply still targets the edited table", async () => {
    await mount({ tableId: "t1", tableName: "Sales" });
    typeInto(q<HTMLTextAreaElement>("json-text")!, '{"id":"t1","name":"Edited"}');

    deliver(TABLE_STATE, { table: { id: "t2", name: "Costs" } });
    await flush();
    expect(h.getObjectJson).not.toHaveBeenCalledWith("table", "t2");
    expect(q<HTMLTextAreaElement>("json-text")?.value).toBe('{"id":"t1","name":"Edited"}');
    expect(q("table-json-held")?.textContent).toContain("Costs");

    act(() => button("Apply").click());
    await flush();
    expect(h.setObjectJson).toHaveBeenCalledWith("table", "t1", '{"id":"t1","name":"Edited"}');
    const names = h.emitted.map(([n]) => n);
    expect(names).toContain(TABLE_DEFINITIONS_UPDATED);

    // Applied = nothing pending: now it follows the selection.
    await flush();
    expect(h.getObjectJson).toHaveBeenLastCalledWith("table", "t2");
    expect(q("table-json-held")).toBeNull();
  });

  it("Revert releases the hold too", async () => {
    await mount({ tableId: "t1", tableName: "Sales" });
    typeInto(q<HTMLTextAreaElement>("json-text")!, "{}");
    deliver(TABLE_STATE, { table: { id: "t2", name: "Costs" } });
    await flush();
    expect(q("table-json-held")).not.toBeNull();

    act(() => button("Revert").click());
    await flush();
    expect(h.getObjectJson).toHaveBeenLastCalledWith("table", "t2");
    expect(q("table-json-held")).toBeNull();
  });

  it("a rename of the SAME table updates the header without refetching", async () => {
    await mount({ tableId: "t1", tableName: "Sales" });
    const calls = h.getObjectJson.mock.calls.length;
    deliver(TABLE_STATE, { table: { id: "t1", name: "Revenue" } });
    await flush();
    expect(q("table-json-pane")?.textContent).toContain("Revenue");
    expect(h.getObjectJson.mock.calls.length).toBe(calls);
  });

  it("a failed load says why and offers a retry", async () => {
    h.getObjectJson.mockRejectedValueOnce(new Error("no such table"));
    await mount({ tableId: "t9", tableName: "Gone" });
    expect(q("table-json-status")?.textContent).toMatch(/Failed to load JSON/);
    act(() => button("Retry").click());
    await flush();
    expect(q<HTMLTextAreaElement>("json-text")?.value).toBe('{"id":"t9","name":"Name of t9"}');
  });
});

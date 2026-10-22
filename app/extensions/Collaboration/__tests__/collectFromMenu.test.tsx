//! FILENAME: app/extensions/Collaboration/__tests__/collectFromMenu.test.tsx
// PURPOSE: Writeback > Collect From, rendered: the publisher tab's Responses
//          cluster is [Collect From v][Collected Responses][Writeback Pane] in
//          one row of heroes; the menu is a STAY-OPEN list of check rows whose
//          clicks send the toggled choice to Rust; the last ticked row cannot be
//          unticked; a workbook that has published nothing gets a disabled hero
//          that says what to do; nothing is painted with a colour literal.
// CONTEXT: react-dom + `act` (no @testing-library). Every backend door is the
//          @api/collaboration wrapper, doubled here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CollectionStreamsView } from "@api/collaboration";

const h = vi.hoisted(() => ({
  view: null as unknown,
  getCollectionStreams: vi.fn(),
  setCollectionStreams: vi.fn(),
  emitted: [] as Array<[string, unknown]>,
}));

vi.mock("@api/collaboration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/collaboration")>()),
  getCollectionStreams: () => h.getCollectionStreams(),
  setCollectionStreams: (c: unknown) => h.setCollectionStreams(c),
}));
vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/events")>()),
  emitAppEvent: (name: string, p: unknown) => h.emitted.push([name, p]),
}));
vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));

import { SurfaceLayoutProvider, bandLayout, findHardcodedColours } from "@api/layout";
import { WritebackPublisherResponsesSection } from "../components/WritebackPublisherTabSections";
import { CollectFromMenuButton } from "../components/CollectFromMenuButton";
import { refreshCollectStreams, resetCollectStreams } from "../lib/collectStreamsStore";
import { NOT_PUBLISHED_TOOLTIP } from "../lib/collectStreamsModel";
import { WRITEBACK_COLLECTION_STREAMS_CHANGED_EVENT } from "../lib/writebackIds";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const DEFAULT_VIEW: CollectionStreamsView = {
  linked: true,
  packageName: "app",
  registryUrl: "C:\\ws",
  mode: "default",
  selection: null,
  collecting: ["prod"],
  defaultStream: "prod",
  choices: [
    { stream: "", label: "Development line", kind: "developmentLine", included: false, version: null, hint: "" },
    { stream: "test", label: "test", kind: "environment", included: false, version: "1.0.0", hint: "v1.0.0" },
    { stream: "prod", label: "prod", kind: "environment", included: true, version: "1.0.0", hint: "v1.0.0 · the default" },
  ],
  notCollected: [],
  environmentsError: null,
  summary: "prod (the last environment)",
  canChange: true,
  changeRefusal: null,
};

let container: HTMLDivElement;
let root: Root;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(<SurfaceLayoutProvider value={bandLayout(800)}>{node}</SurfaceLayoutProvider>);
  });
  await refreshCollectStreams();
  await settle();
}

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function openMenu(testId = "writeback-tab-collect-from"): Promise<void> {
  await act(async () => {
    byTestId(testId)!.click();
  });
  await settle();
}

beforeEach(() => {
  resetCollectStreams();
  h.view = DEFAULT_VIEW;
  h.emitted = [];
  h.getCollectionStreams.mockReset().mockImplementation(async () => h.view);
  h.setCollectionStreams.mockReset().mockImplementation(async () => h.view);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("Writeback > Collect From", () => {
  it("is the first of three heroes in the publisher tab's Responses cluster", async () => {
    await render(<WritebackPublisherResponsesSection {...({} as never)} />);
    const buttons = Array.from(container.querySelectorAll("button")).map((b) => b.getAttribute("data-testid"));
    expect(buttons).toEqual([
      "writeback-tab-collect-from",
      "writeback-tab-collected-responses",
      "writeback-tab-publisher-open-pane",
    ]);
    const hero = byTestId("writeback-tab-collect-from")!;
    expect(hero.getAttribute("aria-haspopup")).toBe("menu");
    expect(hero.textContent).toContain("Collect");
    expect(hero.getAttribute("title")).toContain("Collecting from: prod (the last environment).");
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("opens a list of check rows that say what is collected", async () => {
    await render(<CollectFromMenuButton testId="writeback-tab-collect-from" />);
    await openMenu();
    const checked = (id: string) => byTestId(id)?.getAttribute("aria-checked");
    expect(byTestId("writeback-collect-all")?.getAttribute("role")).toBe("menuitemcheckbox");
    expect(checked("writeback-collect-all")).toBe("false");
    expect(checked("writeback-collect-stream-development-line")).toBe("false");
    expect(checked("writeback-collect-stream-test")).toBe("false");
    expect(checked("writeback-collect-stream-prod")).toBe("true");
    expect(byTestId("writeback-collect-stream-prod")?.textContent).toContain("the default");
    expect(findHardcodedColours(document.body)).toEqual([]);
  });

  // SABOTAGE: drop `closeOnSelect={false}` -- the menu closes after the click.
  it("a click sends the toggled choice and the menu STAYS OPEN for the next tick", async () => {
    await render(<CollectFromMenuButton testId="writeback-tab-collect-from" />);
    await openMenu();
    h.view = { ...DEFAULT_VIEW, mode: "only", selection: ["prod", "test"] };
    await act(async () => {
      byTestId("writeback-collect-stream-test")!.click();
    });
    await settle();
    expect(h.setCollectionStreams).toHaveBeenCalledWith({ only: ["prod", "test"] });
    expect(byTestId("writeback-collect-stream-test")).not.toBeNull();
    expect(h.emitted.map(([name]) => name)).toContain(WRITEBACK_COLLECTION_STREAMS_CHANGED_EVENT);

    await act(async () => {
      byTestId("writeback-collect-all")!.click();
    });
    await settle();
    expect(h.setCollectionStreams).toHaveBeenLastCalledWith("all");
  });

  it("the last collected row is disabled: an empty choice is refused", async () => {
    await render(<CollectFromMenuButton testId="writeback-tab-collect-from" />);
    await openMenu();
    const prod = byTestId("writeback-collect-stream-prod")!;
    expect((prod as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      prod.click();
    });
    await settle();
    expect(h.setCollectionStreams).not.toHaveBeenCalled();
  });

  it("a workbook that published nothing gets a disabled hero that says what to do", async () => {
    h.view = { ...DEFAULT_VIEW, linked: false, choices: [], summary: "" };
    await render(<CollectFromMenuButton testId="writeback-tab-collect-from" />);
    const hero = byTestId("writeback-tab-collect-from") as HTMLButtonElement;
    expect(hero.disabled).toBe(true);
    expect(hero.getAttribute("title")).toBe(NOT_PUBLISHED_TOOLTIP);
  });

  it("a computer without the publisher key sees the choice but cannot change it", async () => {
    h.view = { ...DEFAULT_VIEW, canChange: false, changeRefusal: "Only the publisher of 'app' -- or a co-publisher they authorized -- can view or manage its writeback submissions." };
    await render(<CollectFromMenuButton testId="writeback-tab-collect-from" />);
    await openMenu();
    expect((byTestId("writeback-collect-stream-test") as HTMLButtonElement).disabled).toBe(true);
    expect((byTestId("writeback-collect-all") as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain("Only the publisher of 'app'");
  });
});

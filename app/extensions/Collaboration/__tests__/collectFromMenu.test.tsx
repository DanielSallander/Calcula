//! FILENAME: app/extensions/Collaboration/__tests__/collectFromMenu.test.tsx
// PURPOSE: Writeback > Collect From, rendered: the publisher tab's Responses
//          cluster is [Collect From v][Collected Responses][Writeback Pane] in
//          one row of heroes; the menu is a STAY-OPEN list of check rows whose
//          clicks send the toggled choice to Rust; the last ticked row cannot be
//          unticked; a workbook that has published nothing gets a disabled hero
//          that says what to do; nothing is painted with a colour literal.
//          The Collected Responses pane's DROPDOWN presentation (owner,
//          2026-10-22: the hero squeezed beside the region select read
//          "Collect Fr"): a field-height trigger whose text IS the current
//          choice, opening the same menu; the hero is unchanged.
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

import { Dropdown, SurfaceLayoutProvider, bandLayout, panelLayout, findHardcodedColours } from "@api/layout";
import { WritebackPublisherResponsesSection } from "../components/WritebackPublisherTabSections";
import {
  CollectFromMenuButton,
  collectFromChoiceText,
  COLLECT_FROM_LOADING_TEXT,
  COLLECT_FROM_NOT_PUBLISHED_TEXT,
  COLLECT_FROM_READ_FAILED_TEXT,
} from "../components/CollectFromMenuButton";
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

// ============================================================================
// The Collected Responses pane's dropdown presentation (owner, 2026-10-22)
// ============================================================================

const ALL_VIEW: CollectionStreamsView = {
  ...DEFAULT_VIEW,
  mode: "all",
  collecting: null,
  choices: DEFAULT_VIEW.choices.map((c) => ({ ...c, included: true })),
  summary: "All streams",
};

/** test + prod chosen. Rust holds the set in name order ("prod", "test"); the
 *  dropdown AND its tooltip say it in the menu's (pipeline) order. */
const SEVERAL_VIEW: CollectionStreamsView = {
  ...DEFAULT_VIEW,
  mode: "only",
  selection: ["prod", "test"],
  collecting: ["prod", "test"],
  choices: DEFAULT_VIEW.choices.map((c) => ({ ...c, included: c.stream !== "", hint: c.stream === "" ? "not collected" : "v1.0.0" })),
  summary: "prod, test",
};

const PANE_ID = "publisher-dashboard-collect-from";

async function renderInPane(): Promise<HTMLButtonElement> {
  await act(async () => {
    root.render(
      <SurfaceLayoutProvider value={panelLayout(300)}>
        <CollectFromMenuButton presentation="dropdown" testId={PANE_ID} />
      </SurfaceLayoutProvider>,
    );
  });
  await refreshCollectStreams();
  await settle();
  return byTestId(PANE_ID) as HTMLButtonElement;
}

/** The text the trigger SHOWS (its accessible name adds "Collect from: "). */
const shown = (trigger: HTMLElement) => trigger.querySelector("[data-collect-from-text]")?.textContent ?? null;

describe("collectFromChoiceText: what the pane's dropdown says", () => {
  it("All / one / several streams", () => {
    expect(collectFromChoiceText(ALL_VIEW)).toBe("All streams");
    expect(collectFromChoiceText(DEFAULT_VIEW)).toBe("prod");
    // SABOTAGE: join `view.collecting` as Rust ordered it -- "prod, test".
    expect(collectFromChoiceText(SEVERAL_VIEW)).toBe("test, prod");
  });

  it("the development line and a removed environment in the menu's own words", () => {
    const view: CollectionStreamsView = {
      ...DEFAULT_VIEW,
      mode: "only",
      selection: ["", "old"],
      collecting: ["", "old"],
      choices: [
        { stream: "", label: "Development line", kind: "developmentLine", included: true, version: null, hint: "" },
        { stream: "prod", label: "prod", kind: "environment", included: false, version: "1.0.0", hint: "v1.0.0" },
        { stream: "old", label: "old", kind: "removed", included: true, version: null, hint: "not in the pipeline" },
      ],
      summary: "Development line, old",
    };
    expect(collectFromChoiceText(view)).toBe("Development line, old");
    // A collected stream no row lists is still named, never dropped.
    expect(collectFromChoiceText({ ...DEFAULT_VIEW, collecting: ["prod", "ghost"] })).toBe("prod, ghost");
  });

  it("the default with no environments is every stream; an unresolvable choice says so in Rust's words", () => {
    const none: CollectionStreamsView = {
      ...DEFAULT_VIEW,
      collecting: null,
      defaultStream: null,
      choices: [{ stream: "", label: "Development line", kind: "developmentLine", included: true, version: null, hint: "" }],
      summary: "All streams",
    };
    expect(collectFromChoiceText(none)).toBe("All streams");
    const broken: CollectionStreamsView = {
      ...DEFAULT_VIEW,
      collecting: null,
      choices: DEFAULT_VIEW.choices.map((c) => ({ ...c, included: false })),
      environmentsError: "The workspace could not be read.",
      summary: "The last environment (the pipeline could not be read)",
    };
    // Never "All streams" for a choice that collects nothing it can name.
    expect(collectFromChoiceText(broken)).toBe("The last environment (the pipeline could not be read)");
  });

  it("before the first read, unpublished, and a failed read", () => {
    expect(collectFromChoiceText(null)).toBe(COLLECT_FROM_LOADING_TEXT);
    expect(collectFromChoiceText({ ...DEFAULT_VIEW, linked: false, choices: [], summary: "" })).toBe(COLLECT_FROM_NOT_PUBLISHED_TEXT);
    expect(collectFromChoiceText(null, "the share is offline")).toBe(COLLECT_FROM_READ_FAILED_TEXT);
    // A re-read that failed over a view already shown keeps saying the view
    // (the "!" pill and the tooltip say the read failed).
    expect(collectFromChoiceText(DEFAULT_VIEW, "the share is offline")).toBe("prod");
  });
});

describe("Collect From as the pane's dropdown", () => {
  // The tooltip names the streams in the SAME order as the text (it used to
  // read "Collecting from: prod, test." under "test, prod").
  it.each([
    ["All streams", ALL_VIEW, "Collecting from: All streams."],
    ["prod", DEFAULT_VIEW, "Collecting from: prod (the last environment)."],
    ["test, prod", SEVERAL_VIEW, "Collecting from: test, prod."],
  ])("says the current choice: %s", async (text, view, tooltip) => {
    h.view = view;
    const trigger = await renderInPane();
    expect(trigger).not.toBeNull();
    expect(trigger.tagName).toBe("BUTTON");
    expect(shown(trigger)).toBe(text);
    expect(trigger.textContent).toBe(text);
    expect(trigger.getAttribute("aria-label")).toBe(`Collect from: ${text}`);
    // The full explanation rides on the title (E2E reads it), so an ellipsis
    // in a narrow pane never hides what is collected.
    expect(trigger.getAttribute("title")).toContain(tooltip);
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.disabled).toBe(false);
  });

  it("is the @api field trigger (the Dropdown's own), and keeps the id a label names it by", async () => {
    h.view = SEVERAL_VIEW;
    await act(async () => {
      root.render(
        <SurfaceLayoutProvider value={panelLayout(300)}>
          <label htmlFor="collect-from-field">Collect from</label>
          <CollectFromMenuButton presentation="dropdown" testId={PANE_ID} id="collect-from-field" />
          <Dropdown ariaLabel="Reference" testId="reference-dropdown" value="a" options={[{ value: "a", label: "prod" }]} onChange={() => {}} />
        </SurfaceLayoutProvider>,
      );
    });
    await refreshCollectStreams();
    await settle();
    const trigger = byTestId(PANE_ID) as HTMLButtonElement;
    const reference = byTestId("reference-dropdown") as HTMLButtonElement;
    // ONE recipe: the same class as the @api Dropdown's trigger, not a copy.
    expect(trigger.className.split(" ")[0]).toBe(reference.className.split(" ")[0]);
    expect(trigger.style.width).toBe("100%");
    expect(trigger.id).toBe("collect-from-field");
    expect((container.querySelector("label") as HTMLLabelElement).control).toBe(trigger);
  });

  // SABOTAGE: render the CommandButton for presentation "dropdown" -- the text
  // becomes "Collect From", the filter icon appears and data-presentation goes.
  it("is never the ribbon hero: no icon, no 'Collect From' label, a chevron only", async () => {
    h.view = SEVERAL_VIEW;
    const trigger = await renderInPane();
    expect(trigger.getAttribute("data-presentation")).toBe("dropdown");
    expect(trigger.textContent).not.toContain("Collect From");
    expect(trigger.querySelectorAll("svg")).toHaveLength(1);
    expect(trigger.querySelector("[data-hero-line]")).toBeNull();
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("opens the SAME stay-open menu, and a tick goes to Rust", async () => {
    h.view = DEFAULT_VIEW;
    await renderInPane();
    await openMenu(PANE_ID);
    expect(byTestId("writeback-collect-stream-prod")?.getAttribute("aria-checked")).toBe("true");
    h.view = SEVERAL_VIEW;
    await act(async () => {
      byTestId("writeback-collect-stream-test")!.click();
    });
    await settle();
    expect(h.setCollectionStreams).toHaveBeenCalledWith({ only: ["prod", "test"] });
    // The menu stayed open, and the trigger follows the store at once.
    expect(byTestId("writeback-collect-stream-test")).not.toBeNull();
    expect(shown(byTestId(PANE_ID)!)).toBe("test, prod");
    expect(findHardcodedColours(document.body)).toEqual([]);
  });

  it("warns with the ! pill when an explicit choice leaves an environment out", async () => {
    h.view = { ...SEVERAL_VIEW, notCollected: ["staging"] };
    const trigger = await renderInPane();
    expect(shown(trigger)).toBe("test, prod");
    // The pill is decoration (aria-hidden): the name and the text stay the choice.
    const pill = trigger.querySelector('[data-tone="accent"]');
    expect(pill?.textContent).toBe("!");
    expect(pill?.getAttribute("aria-hidden")).toBe("true");
    expect(trigger.getAttribute("title")).toContain("Not collected: staging.");
  });

  it("an unpublished workbook gets a disabled dropdown that says so", async () => {
    h.view = { ...DEFAULT_VIEW, linked: false, choices: [], summary: "" };
    const trigger = await renderInPane();
    expect(trigger.disabled).toBe(true);
    expect(shown(trigger)).toBe(COLLECT_FROM_NOT_PUBLISHED_TEXT);
    expect(trigger.getAttribute("title")).toBe(NOT_PUBLISHED_TOOLTIP);
  });

  it("a failed read keeps the dropdown live (the click is the retry) and says so", async () => {
    h.getCollectionStreams.mockImplementation(async () => {
      throw new Error("the share is offline");
    });
    const trigger = await renderInPane();
    expect(trigger.disabled).toBe(false);
    expect(shown(trigger)).toBe(COLLECT_FROM_READ_FAILED_TEXT);
    expect(trigger.getAttribute("title")).toContain("the share is offline");
    const calls = h.getCollectionStreams.mock.calls.length;
    h.getCollectionStreams.mockImplementation(async () => DEFAULT_VIEW);
    await openMenu(PANE_ID);
    expect(h.getCollectionStreams.mock.calls.length).toBeGreaterThan(calls);
    expect(shown(byTestId(PANE_ID)!)).toBe("prod");
  });

  it("the ribbon hero is unchanged: the 'Collect From' hero with its icon, no dropdown text", async () => {
    await render(<CollectFromMenuButton testId="writeback-tab-collect-from" />);
    const hero = byTestId("writeback-tab-collect-from")!;
    expect(hero.getAttribute("data-presentation")).toBeNull();
    expect(hero.querySelector("[data-collect-from-text]")).toBeNull();
    expect(hero.textContent).toContain("Collect");
    expect(hero.textContent).toContain("From");
    // The filter icon and the chevron.
    expect(hero.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2);
  });
});

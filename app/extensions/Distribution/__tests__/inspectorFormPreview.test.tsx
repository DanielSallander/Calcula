//! FILENAME: app/extensions/Distribution/__tests__/inspectorFormPreview.test.tsx
// PURPOSE: The Application Inspector's "Preview layout" action — what it does
//          when clicked, and what it tells the reviewer before they click.
// CONTEXT: 2026-09-03, rebuild. The action shipped BROKEN BY DESIGN: it called
//          `previewFormLayout` inside the inspector's own Tauri window, which
//          mounts no Shell and therefore activates no extensions — so the app
//          event that show ends in reached no renderer, nothing painted, and
//          the show died ten seconds later on its ack timeout. The fix puts the
//          WIRE between the windows: this window ASKS, the main window runs and
//          paints, the outcome comes back.
//
//          FOUR THINGS THIS PINS, each of which is a way the action is worse
//          than not having it:
//           1. It must not call the preview core in THIS window. That is the
//              defect, and it is invisible in a unit test that mocks the core
//              and asserts it was called — which is exactly what the previous
//              version of this file did.
//           2. It is FORMS ONLY, and the reviewer is told that label is the
//              publisher's claim rather than a boundary. An action that ran the
//              setup half of an arbitrary unconsented script would be a new
//              reason to run other people's code, which is the opposite of what
//              this window is for.
//           3. The hint before the click is TRUE. "Nothing is run" was not: the
//              application's setup executes, sandboxed, against a copy of the
//              reviewer's sheet. And it says where the dialog appears, because
//              a form surfacing behind this window unexplained is worse than no
//              feature.
//           4. Every outcome is RENDERED. A silent button in a window with no
//              devtools is indistinguishable from a broken one.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const inspectorScripts = vi.fn();
const previewFormLayout = vi.fn();

vi.mock("@api/distribution", () => ({
  inspectorScripts: (...a: unknown[]) => inspectorScripts(...a),
}));

// The preview CORE. In this window it must never be reached — the whole point
// of the rebuild — so it is doubled here purely to catch it if it is.
vi.mock("@api", () => ({
  previewFormLayout: (...a: unknown[]) => previewFormLayout(...a),
  previewScriptId: (id: string) => `preview:${id}`,
}));

const emitted: Array<{ event: string; payload: unknown }> = [];
const handlers = new Map<string, (p: unknown) => void>();

vi.mock("@api/backend", () => ({
  emitTauriEvent: vi.fn(async (event: string, payload: unknown) => {
    emitted.push({ event, payload });
  }),
  listenTauriEvent: vi.fn(async (event: string, cb: (p: unknown) => void) => {
    handlers.set(event, cb);
    return vi.fn();
  }),
}));

// React batches state updates inside `act` only when it is told it is in a test
// environment; without it the flag flip that disables the button can land after
// the assertion that reads it.
(globalThis as unknown as Record<string, boolean>).IS_REACT_ACT_ENVIRONMENT = true;

import { ScriptsSection } from "../components/inspector/ScriptsSection";
import type { InspectorContext } from "../components/inspector/ApplicationInspectorApp";
import {
  __resetInspectorFormPreview,
  installInspectorFormPreviewClient,
} from "../lib/inspectorFormPreview";
import { InspectorFormPreviewEvents } from "../lib/inspectorWindowEvents";
import type { InspectorFormPreviewRequest } from "../lib/inspectorWindowEvents";
import type { InspectorOverview } from "@api/distribution";

const CTX: InspectorContext = {
  registryPath: "C:\\shared\\ws",
  packageName: "vendor-kpis",
  version: "2.1.0",
};

/** Only the four counts ScriptsSection reads to decide it has anything to show. */
const OVERVIEW = {
  objectScripts: [{}],
  moduleScripts: [],
  notebooks: [],
  customFunctionCount: 0,
} as unknown as InspectorOverview;

function objectScript(over: { id: string; name: string; objectType: string; source?: string }) {
  return {
    id: over.id,
    name: over.name,
    objectType: over.objectType,
    instanceId: null,
    description: null,
    capabilities: [],
    source: over.source ?? "export function setup(){}",
  };
}

function withScripts(...scripts: ReturnType<typeof objectScript>[]): void {
  inspectorScripts.mockResolvedValue({
    objectScripts: scripts,
    moduleScripts: [],
    notebooks: [],
    customFunctions: null,
  });
}

let container: HTMLDivElement;
let root: Root;
let offClient: (() => void) | null = null;

async function render(): Promise<void> {
  // The inspector window subscribes to the result channel at mount; a section
  // rendered without it would never hear an answer.
  offClient = installInspectorFormPreviewClient();
  await Promise.resolve();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(ScriptsSection, { ctx: CTX, overview: OVERVIEW }));
  });
}

/**
 * The action, whatever it currently says. Its label CHANGES while a run is in
 * flight ("Previewing…"), so matching the idle caption would silently find
 * nothing exactly where the disabled state is being asserted.
 */
function previewButton(): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("button")].find((b) => /preview/i.test(b.textContent ?? "")) ??
    null
  );
}

function requests(): InspectorFormPreviewRequest[] {
  return emitted
    .filter((e) => e.event === InspectorFormPreviewEvents.REQUEST)
    .map((e) => e.payload as InspectorFormPreviewRequest);
}

/** Deliver a result the way the main window would. */
async function answer(over: Record<string, unknown>): Promise<void> {
  const handler = handlers.get(InspectorFormPreviewEvents.RESULT);
  expect(handler, "the inspector never subscribed to preview results").toBeTruthy();
  await act(async () => {
    handler!({
      requestId: requests().at(-1)?.requestId ?? "",
      packageName: CTX.packageName,
      scriptId: "s1",
      shown: false,
      outcome: "refused",
      reason: "",
      ...over,
    });
  });
}

beforeEach(() => {
  inspectorScripts.mockReset();
  previewFormLayout.mockReset();
  emitted.length = 0;
  handlers.clear();
  __resetInspectorFormPreview();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  offClient?.();
  offClient = null;
});

describe("the Application Inspector's form preview", () => {
  it("offers no preview for a script that is not a form", async () => {
    // A button script's product is behaviour, not a picture; running its setup
    // in the preview realm would buy the reviewer nothing and would make this
    // read-only window a place where unconsented code executes.
    withScripts(objectScript({ id: "s1", name: "Recalc", objectType: "button" }));
    await render();
    expect(container.textContent).toContain("Recalc");
    expect(previewButton()).toBeNull();
  });

  it("offers it for a form, and keeps the source block that was already there", async () => {
    withScripts(objectScript({ id: "s1", name: "Expense claim", objectType: "form" }));
    await render();
    expect(previewButton(), "no Preview layout action for a form script").toBeTruthy();
    expect(previewButton()!.textContent).toBe("Preview layout");
    // This is an ADDITION: the emitted JavaScript stays available beside it.
    expect(container.textContent).toMatch(/Show source/);
  });

  it("says the declared object type is the publisher's claim, not an enforced boundary", async () => {
    // The "forms only" gate reads a field the PUBLISHER wrote. Presenting it as
    // a guarantee would be the inspector vouching for something it cannot check.
    withScripts(objectScript({ id: "s1", name: "Expense claim", objectType: "form" }));
    await render();
    expect(container.textContent).toMatch(/publisher's own\s+declaration about a script/);
    expect(container.textContent).toMatch(/not a boundary Calcula enforces/);
  });

  describe("the hint before the click", () => {
    beforeEach(() => {
      withScripts(objectScript({ id: "s1", name: "Expense claim", objectType: "form" }));
    });

    it("says the dialog opens in the MAIN window, not in this one", async () => {
      await render();
      expect(container.textContent).toMatch(/main Calcula window, behind this one/);
    });

    it("admits that the application's setup code is RUN, and names what bounds it", async () => {
      await render();
      const text = container.textContent ?? "";
      // The old sentence said "Nothing is run", which was false: drawing the
      // layout executes this application's setup in the preview rung.
      expect(text).not.toMatch(/Nothing is run/);
      expect(text).toMatch(/setup code IS RUN/);
      // And the real guarantee, said out loud.
      expect(text).toMatch(/no capabilities, nothing mounted/);
      expect(text).toMatch(/throwaway copy of your active sheet/);
    });
  });

  describe("clicking it", () => {
    beforeEach(() => {
      withScripts(objectScript({ id: "s1", name: "Expense claim", objectType: "form" }));
    });

    it("asks the main window instead of running the preview in this one", async () => {
      await render();
      await act(async () => previewButton()!.click());

      // THE DEFECT, PINNED. This window has no renderer for a script form: a
      // preview started here paints nothing and dies on the ack timeout.
      expect(
        previewFormLayout,
        "the inspector window ran the preview itself; nothing there can paint it",
      ).not.toHaveBeenCalled();

      expect(requests()).toHaveLength(1);
      expect(requests()[0]).toMatchObject({
        packageName: "vendor-kpis",
        scriptId: "s1",
        scriptName: "Expense claim",
        source: "export function setup(){}",
      });
      expect(requests()[0].requestId).toBeTruthy();
    });

    it("holds the button and says where it is going while it waits", async () => {
      await render();
      await act(async () => previewButton()!.click());
      expect(previewButton()!.disabled, "a second run can be started over the first").toBe(true);
      expect(container.textContent).toMatch(/Opening the preview in the main Calcula window/);
    });

    it("renders the answer inline, and tells the reviewer whose data they see", async () => {
      await render();
      await act(async () => previewButton()!.click());
      await answer({
        shown: true,
        outcome: "shown",
        reason:
          "Preview open in the main Calcula window, behind this one. The layout is this application's; any values in it were seeded from a copy of YOUR active sheet, and nothing is written anywhere.",
      });
      expect(container.textContent).toMatch(/copy of YOUR active sheet/);
      expect(container.textContent).toMatch(/main Calcula window, behind this one/);
      expect(previewButton()!.disabled).toBe(false);
    });

    it("renders a refusal inline and leaves the action usable", async () => {
      // The modal slot is shared and can already be held by a real script.
      await render();
      await act(async () => previewButton()!.click());
      await answer({
        outcome: "refused",
        reason: "The preview could not open: this script already has a dialog open.",
      });
      expect(container.textContent).toContain("this script already has a dialog open");
      expect(previewButton()!.disabled).toBe(false);
    });

    it("clears the note when the preview closes in the main window", async () => {
      // Otherwise the inspector goes on claiming a form is open that is not.
      await render();
      await act(async () => previewButton()!.click());
      await answer({ shown: true, outcome: "shown", reason: "Preview open in the main window." });
      expect(container.textContent).toContain("Preview open in the main window.");
      await answer({ outcome: "closed", reason: "" });
      expect(container.textContent).not.toContain("Preview open in the main window.");
      // Back to the pre-click hint, so the action explains itself again.
      expect(container.textContent).toMatch(/setup code IS RUN/);
    });

    it("ignores an answer meant for a different script", async () => {
      await render();
      await act(async () => previewButton()!.click());
      await answer({
        scriptId: "some-other-script",
        outcome: "refused",
        reason: "not for this row",
      });
      expect(container.textContent).not.toContain("not for this row");
      expect(container.textContent).toMatch(/Opening the preview in the main Calcula window/);
    });
  });
});

//! FILENAME: app/extensions/Collaboration/__tests__/snapshotRefusalSiblings.test.tsx
// PURPOSE: The push dialog's two SIBLINGS that run the same snapshot -- the
//          Application Explorer's "Preview publish" and the subscriber's
//          "View changes" diff -- say the backend's retryable refusal in plain
//          words, never its internal code, and leave every other error as it
//          was.
// CONTEXT: Both reach Rust's `take_consistent_snapshot` (calp_publish_preview;
//          calp_diff_working_copy through publish_into_for_preview), so both can
//          meet "WORKBOOK_CHANGED_WHILE_SAVING: ..." while an agent deletes or
//          moves sheets. Each showed `String(err)`. The Explorer's "Preview
//          publish" button sits right above its error (that IS the retry). The
//          subscriber diff used to be said to "run on open" -- true only after
//          a Close: a re-show hung on "Comparing..." (review round 8). It now
//          compares again on every show and has "Compare again" beside its
//          refusal; subscriptionDiffReshow.test.tsx pins both.
//          The ONE recogniser is @api/backendRefusal; only the Tauri boundary is
//          doubled here, rejecting with the bare string as Tauri does.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const REFUSAL =
  "WORKBOOK_CHANGED_WHILE_SAVING: the workbook changed while it was being published -- a sheet was " +
  "added, deleted or moved during each of 3 attempts to read it. Nothing was written; try again.";
const PLAIN =
  "The workbook changed while it was being published -- a sheet was added, deleted or moved during " +
  "each of 3 attempts to read it. Nothing was written; try again.";
const CODE = "WORKBOOK_CHANGED_WHILE_SAVING";

const h = vi.hoisted(() => ({
  /** What the next preview / diff rejects with (bare, as Tauri does). */
  previewRejection: "" as string,
  diffRejection: "" as string,
}));

vi.mock("@api", () => ({
  publishPreview: vi.fn(async () => {
    throw h.previewRejection;
  }),
  getSubscriptions: vi.fn(async () => ({ subscriptions: [] })),
  getApplicationObjects: vi.fn(),
  activateSheet: vi.fn(),
  onAppEvent: vi.fn(() => () => undefined),
  AppEvents: {},
}));
vi.mock("@api/collaboration", () => ({
  diffWorkingCopy: vi.fn(async () => {
    throw h.diffRejection;
  }),
  resetSubscription: vi.fn(),
  getSheetProvenance: vi.fn(async () => [
    {
      role: "subscribed",
      packageName: "sales",
      registryUrl: "\\\\server\\apps",
      upstreamRemoved: false,
      sheetIndex: 1,
      packageSheetId: "pub-sheet-1",
    },
  ]),
}));
vi.mock("../lib/openApplicationInspectorWindow", () => ({ openApplicationInspectorWindow: vi.fn() }));
vi.mock("../lib/refreshAftermath", () => ({ announceSubscribedContentReplaced: vi.fn(async () => undefined) }));

import { PublishPreviewSection } from "../components/ApplicationExplorerPanel";
import { SubscriptionDiffDialog } from "../components/SubscriptionDiffDialog";

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const screenText = (): string => container.textContent ?? "";

async function pressPreviewPublish(): Promise<void> {
  await act(async () => {
    root.render(<PublishPreviewSection placement="sidebar" />);
  });
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Preview publish");
  expect(button, "the Explorer's Preview publish button is gone").toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function openSubscriberDiff(): Promise<void> {
  await act(async () => {
    root.render(
      <SubscriptionDiffDialog
        isOpen
        onClose={vi.fn()}
        data={{
          registryUrl: "\\\\server\\apps",
          packageName: "sales",
          resolvedVersion: "1.0.0",
          mode: "view",
          __openCount: 1,
        }}
      />,
    );
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.previewRejection = "";
  h.diffRejection = "";
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the Application Explorer's Preview publish", () => {
  // SABOTAGE: setError(String(err)) back in PublishPreviewSection's catch.
  it("says the refusal's plain sentence, never the code", async () => {
    h.previewRejection = REFUSAL;
    await pressPreviewPublish();
    expect(screenText()).toContain(PLAIN);
    expect(screenText(), "the raw code reached the screen").not.toContain(CODE);
  });

  it("shows any other failure exactly as before", async () => {
    h.previewRejection = "CALP_WORKSPACE_UNREADABLE: the share is gone";
    await pressPreviewPublish();
    expect(screenText()).toContain("CALP_WORKSPACE_UNREADABLE: the share is gone");
  });
});

describe("the subscriber's View changes diff", () => {
  // SABOTAGE: setDiffError(String(err)) back in SubscriptionDiffDialog.
  it("says the refusal's plain sentence, never the code", async () => {
    h.diffRejection = REFUSAL;
    await openSubscriberDiff();
    expect(screenText()).toContain(PLAIN);
    expect(screenText(), "the raw code reached the screen").not.toContain(CODE);
  });

  it("shows any other failure exactly as before", async () => {
    h.diffRejection = "CALP_VERSION_UNREADABLE: the published version cannot be read";
    await openSubscriberDiff();
    expect(screenText()).toContain("CALP_VERSION_UNREADABLE: the published version cannot be read");
  });
});

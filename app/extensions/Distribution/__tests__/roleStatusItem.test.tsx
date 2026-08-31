//! FILENAME: app/extensions/Distribution/__tests__/roleStatusItem.test.tsx
// PURPOSE: The status bar must say, without being asked, whether this workbook
//          is a WORKING COPY you can push or a SUBSCRIBED copy you never can.
// CONTEXT: Reported from live testing: "I quickly lose myself in what I have
//          opened as a developer and what I open as a subscriber." The two look
//          identical on screen and behave oppositely on Push — publishing from a
//          subscribed copy is refused, because it would re-mint every sheet id
//          and orphan the other subscribers' overrides. The only surface that
//          said which role you held was a sidebar section you had to go and
//          open.
//
//          The roles are exclusive PER APPLICATION, so a workbook can hold both
//          at once — a working copy of one, a subscriber to another — and the
//          badge must show both rather than picking a winner.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const workingCopyStatus = vi.fn();
const getSubscriptions = vi.fn();
const openPanel = vi.fn();

vi.mock("@api", () => ({
  workingCopyStatus: (...a: unknown[]) => workingCopyStatus(...a),
  getSubscriptions: (...a: unknown[]) => getSubscriptions(...a),
  openPanel: (...a: unknown[]) => openPanel(...a),
  AppEvents: { AFTER_OPEN: "app:after-open", AFTER_NEW: "app:after-new", PACKAGE_UPDATED: "app:package-updated" },
  // Returns an unsubscribe, like the real one — a component that leaks a
  // listener across document replacement would show the previous file's role.
  onAppEvent: () => () => undefined,
}));

import { DistributionRoleStatusItem } from "../components/DistributionRoleStatusItem";

const LINK = {
  registryUrl: "C:\\shared\\ws",
  packageName: "sales-report",
  kind: "report",
  baseVersion: "1.0.0",
  checkedOutAt: "",
  lastPushedVersion: "",
  lastPushedAt: "",
  baseSheets: [],
  registryReachable: true,
  headVersion: "1.0.0",
  isStale: false,
  versions: [],
  holdsPublisherKey: true,
  registryError: "",
};

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<string> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(DistributionRoleStatusItem));
  });
  return container.textContent ?? "";
}

beforeEach(() => {
  workingCopyStatus.mockReset();
  getSubscriptions.mockReset();
  openPanel.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the distribution role badge", () => {
  it("says WORKING COPY, with the application and the base version", async () => {
    workingCopyStatus.mockResolvedValue(LINK);
    getSubscriptions.mockResolvedValue({ subscriptions: [] });
    const text = await render();
    expect(text).toMatch(/Working copy/i);
    expect(text).toContain("sales-report");
    expect(text).toContain("1.0.0");
    expect(text).not.toMatch(/Subscribed/i);
  });

  it("says SUBSCRIBED for a pulled copy, and never calls it a working copy", async () => {
    // The distinction the user lost track of. Getting this backwards would tell
    // somebody they can push when the gate is going to refuse them.
    workingCopyStatus.mockResolvedValue(null);
    getSubscriptions.mockResolvedValue({
      subscriptions: [{ packageName: "vendor-kpis", resolvedVersion: "2.1.0" }],
    });
    const text = await render();
    expect(text).toMatch(/Subscribed/i);
    expect(text).toContain("vendor-kpis");
    expect(text).not.toMatch(/Working copy/i);
  });

  it("shows BOTH when the workbook holds both roles for different applications", async () => {
    workingCopyStatus.mockResolvedValue(LINK);
    getSubscriptions.mockResolvedValue({
      subscriptions: [{ packageName: "vendor-kpis", resolvedVersion: "2.1.0" }],
    });
    const text = await render();
    expect(text).toMatch(/Working copy/i);
    expect(text).toMatch(/Subscribed/i);
  });

  it("renders nothing at all for a plain workbook", async () => {
    // A permanent "Standalone" chip on every new file is noise in shared
    // real estate; the badge earns its place only when the answer is not
    // obvious.
    workingCopyStatus.mockResolvedValue(null);
    getSubscriptions.mockResolvedValue({ subscriptions: [] });
    expect((await render()).trim()).toBe("");
  });

  it("marks a stale working copy, because that is the push that gets refused", async () => {
    workingCopyStatus.mockResolvedValue({ ...LINK, isStale: true, headVersion: "1.2.0" });
    getSubscriptions.mockResolvedValue({ subscriptions: [] });
    const text = await render();
    expect(text).toMatch(/behind/i);
  });

  it("collapses many subscriptions to a count rather than overflowing the bar", async () => {
    workingCopyStatus.mockResolvedValue(null);
    getSubscriptions.mockResolvedValue({
      subscriptions: [
        { packageName: "a", resolvedVersion: "1.0.0" },
        { packageName: "b", resolvedVersion: "1.0.0" },
        { packageName: "c", resolvedVersion: "1.0.0" },
      ],
    });
    expect(await render()).toMatch(/3 applications/);
  });

  it("keeps the role it COULD read when the other lookup fails", async () => {
    // Absence means "standalone" here, so a transient failure must not blank a
    // role that did answer — that would actively mislead.
    workingCopyStatus.mockResolvedValue(LINK);
    getSubscriptions.mockRejectedValue(new Error("backend down"));
    const text = await render();
    expect(text).toMatch(/Working copy/i);
  });

  it("opens the Application Explorer when clicked", async () => {
    workingCopyStatus.mockResolvedValue(LINK);
    getSubscriptions.mockResolvedValue({ subscriptions: [] });
    await render();
    const badge = container.querySelector('[role="button"]') as HTMLElement | null;
    expect(badge, "the badge is not reachable as a control").toBeTruthy();
    await act(async () => badge!.click());
    expect(openPanel).toHaveBeenCalledWith("distribution:applicationExplorer");
  });
});

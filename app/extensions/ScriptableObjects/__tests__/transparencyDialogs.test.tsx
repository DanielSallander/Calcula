//! FILENAME: app/extensions/ScriptableObjects/__tests__/transparencyDialogs.test.tsx
// PURPOSE: "Code in This File" and "Script Permissions" as dialog windows: a
//          named, movable frame around the SAME sections the panels showed,
//          that closes from its own button, and -- for Script Permissions --
//          shows one view at a time, opening on the tab a caller asks for.
// CONTEXT: Owner decision 2026-10-04 (dialogs like Insert Chart, not side
//          panels). The sections themselves are pinned by their own tests
//          (CodeInThisFilePanel.*, permissionsPanel*); here they are stand-ins
//          that say which one rendered and at which geometry.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../components/CodeInThisFilePanel", () => ({
  CodeInThisFileSection: ({ placement }: { placement: string }) => (
    <div data-testid="section-code" data-placement={placement} />
  ),
}));
vi.mock("../components/PermissionsPanel", () => ({
  MountedScriptsSection: ({ placement }: { placement: string }) => (
    <div data-testid="section-mounted" data-placement={placement} />
  ),
  PolicyTableSection: () => <div data-testid="section-policy" />,
  ActivitySection: () => <div data-testid="section-activity" />,
}));

import { createCodeInThisFileDialog, createScriptPermissionsDialog } from "../components/TransparencyDialogs";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const ICONS = { code: <svg data-testid="icon-code" />, permissions: <svg data-testid="icon-shield" /> };
const CodeDialog = createCodeInThisFileDialog(ICONS);
const PermissionsDialog = createScriptPermissionsDialog(ICONS);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const q = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel);

describe("Code in This File, as a dialog", () => {
  it("is a named dialog window with the inventory inside, at the vertical geometry", () => {
    act(() => root.render(<CodeDialog isOpen onClose={() => undefined} />));
    const dialog = q("[data-testid='code-in-this-file-dialog']")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Code in This File");
    expect(dialog.textContent).toContain("Code in This File");
    expect(q("[data-testid='icon-code']")).not.toBeNull();
    expect(q("[data-testid='section-code']")!.getAttribute("data-placement")).toBe("sidebar");
    // A real window: fixed, with the shared drag-to-resize handles.
    expect(getComputedStyle(dialog).position).toBe("fixed");
  });

  it("its Close button closes it", () => {
    const onClose = vi.fn();
    act(() => root.render(<CodeDialog isOpen onClose={onClose} />));
    act(() => q("button[aria-label='Close']")!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while closed (so it re-reads the file each time it opens)", () => {
    act(() => root.render(<CodeDialog isOpen={false} onClose={() => undefined} />));
    expect(q("[data-testid='code-in-this-file-dialog']")).toBeNull();
  });
});

describe("Script Permissions, as a dialog", () => {
  it("shows one view at a time, Running scripts first, and the tabs switch it", () => {
    act(() => root.render(<PermissionsDialog isOpen onClose={() => undefined} />));
    expect(q("[data-testid='script-permissions-dialog']")!.getAttribute("aria-label")).toBe("Script Permissions");
    expect(q("[data-testid='section-mounted']")).not.toBeNull();
    expect(q("[data-testid='section-policy']")).toBeNull();
    act(() => q("[data-testid='script-permissions-tab-policy']")!.click());
    expect(q("[data-testid='section-policy']")).not.toBeNull();
    expect(q("[data-testid='section-mounted']")).toBeNull();
    act(() => q("[data-testid='script-permissions-tab-activity']")!.click());
    expect(q("[data-testid='section-activity']")).not.toBeNull();
  });

  it("opens on the tab a caller asks for (the indicator sends refusals to Activity)", () => {
    act(() => root.render(<PermissionsDialog isOpen onClose={() => undefined} data={{ tab: "activity" }} />));
    expect(q("[data-testid='section-activity']")).not.toBeNull();
    // ...and a second show while open, with other data, switches.
    act(() => root.render(<PermissionsDialog isOpen onClose={() => undefined} data={{ tab: "policy" }} />));
    expect(q("[data-testid='section-policy']")).not.toBeNull();
  });

  it("an unknown tab falls back to Running scripts", () => {
    act(() => root.render(<PermissionsDialog isOpen onClose={() => undefined} data={{ tab: "nope" }} />));
    expect(q("[data-testid='section-mounted']")).not.toBeNull();
  });
});

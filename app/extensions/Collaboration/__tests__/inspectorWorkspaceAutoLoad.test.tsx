//! FILENAME: app/extensions/Collaboration/__tests__/inspectorWorkspaceAutoLoad.test.tsx
// PURPOSE: Picking a WORKSPACE in the Application Inspector shows an application,
//          not eight empty tabs (BUG-0552).
// CONTEXT: Browse returns the `workspace.calcula` pointer file, and the backend
//          rightly resolves it with no application name (a workspace root names
//          none). The window listed the workspace's applications and stopped
//          there: the application list sat on "Select application…", no overview
//          was ever requested, and every section showed the "Browse … then
//          Inspect" hint the user had just followed. The owner reported it as
//          "all I see is empty tabs".
//
//          Pinned here: a workspace with ONE application opens it from every
//          route (Browse, a typed folder, a handover from the main window); a
//          workspace with several opens nothing by guesswork and says to choose,
//          and choosing opens it; and switching workspace never leaves the
//          previous workspace's application on screen.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---------------------------------------------------------------------------
// Doubles: the backend, the picker, the cross-window bridge, and the sections
// (each section has its own tests; here only WHICH overview reaches them matters).
// ---------------------------------------------------------------------------

const backend = vi.hoisted(() => ({
  resolve: vi.fn(),
  list: vi.fn(),
  overview: vi.fn(),
  pick: vi.fn(),
  openHandler: null as null | ((p: { registryPath: string; packageName: string; versionPin: string }) => void),
}));

vi.mock("@api/collaboration", () => ({
  inspectorResolveLocation: (path: string) => backend.resolve(path),
  listApplicationsInWorkspace: (path: string) => backend.list(path),
  inspectorOverview: (path: string, pkg: string, pin: string) => backend.overview(path, pkg, pin),
}));

vi.mock("@api/collaborationWorkspaces", () => ({
  listWorkspaces: () => Promise.resolve([]),
}));

vi.mock("../lib/pickWorkspace", () => ({
  pickWorkspaceFile: () => backend.pick(),
}));

vi.mock("../lib/inspectorWindowEvents", () => ({
  onOpenPackage: (cb: typeof backend.openHandler) => {
    backend.openHandler = cb;
    return Promise.resolve(() => {
      backend.openHandler = null;
    });
  },
  emitInspectorReady: () => Promise.resolve(),
}));

vi.mock("../lib/inspectorFormPreview", () => ({
  installInspectorFormPreviewClient: () => () => undefined,
}));

vi.mock("../components/inspector/OverviewSection", () => ({
  OverviewSection: (p: { overview: { package: { name: string }; resolvedVersion: string } }) => (
    <h2 data-testid="overview-title">
      {p.overview.package.name} v{p.overview.resolvedVersion}
    </h2>
  ),
}));
vi.mock("../components/inspector/WritebackSection", () => ({
  WritebackSection: (p: { ctx: { packageName: string } }) => (
    <div data-testid="writeback-section">writeback of {p.ctx.packageName}</div>
  ),
}));
vi.mock("../components/inspector/CompareSection", () => ({ CompareSection: () => <div /> }));
vi.mock("../components/inspector/SheetsSection", () => ({ SheetsSection: () => <div /> }));
vi.mock("../components/inspector/ObjectsSection", () => ({ ObjectsSection: () => <div /> }));
vi.mock("../components/inspector/ScriptsSection", () => ({ ScriptsSection: () => <div /> }));
vi.mock("../components/inspector/ModelSection", () => ({ ModelSection: () => <div /> }));
vi.mock("../components/inspector/ArtifactsSection", () => ({ ArtifactsSection: () => <div /> }));

import { ApplicationInspectorApp } from "../components/inspector/ApplicationInspectorApp";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const POINTER = "C:\\ws\\workspace.calcula";
const FOLDER = "C:\\ws";

function app(name: string) {
  return {
    name,
    description: "",
    kind: "workbook",
    author: "",
    versions: [{ version: "1.0.0", publishedAt: "", publishedBy: "", sheets: [] }],
    environments: [],
  };
}

function overviewOf(name: string, version = "1.0.0") {
  return { package: { name }, resolvedVersion: version };
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<ApplicationInspectorApp />);
  });
  await flush();
}

function button(label: string): HTMLButtonElement {
  const b = Array.from(container.querySelectorAll("button")).find(
    (x) => x.textContent?.trim() === label,
  );
  if (!b) throw new Error(`no button "${label}"`);
  return b as HTMLButtonElement;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

function applicationSelect(): HTMLSelectElement {
  const s = Array.from(container.querySelectorAll("select")).find((x) =>
    Array.from(x.options).some((o) => o.textContent === "Select application…"),
  );
  if (!s) throw new Error("no application list");
  return s as HTMLSelectElement;
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function typeAndEnter(text: string): Promise<void> {
  const input = container.querySelector('input[placeholder^="Workspace, application"]') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await flush();
}

function title(): string | null {
  return container.querySelector('[data-testid="overview-title"]')?.textContent ?? null;
}

function placeholder(): string | null {
  return container.querySelector('[data-testid="inspector-placeholder"]')?.textContent ?? null;
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  backend.resolve.mockReset();
  backend.list.mockReset();
  backend.overview.mockReset();
  backend.pick.mockReset();
  backend.openHandler = null;
  // The backend's real answer for the pointer file and for the bare folder: a
  // workspace root names no application (calp_inspector.rs resolve_location).
  backend.resolve.mockImplementation((p: string) =>
    Promise.resolve({ registryPath: p, packageName: null, version: null }),
  );
  backend.overview.mockImplementation((_p: string, pkg: string) => Promise.resolve(overviewOf(pkg)));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------

describe("Application Inspector: a picked workspace shows an application (BUG-0552)", () => {
  it("Browse to workspace.calcula with ONE application opens it, at latest, with no Inspect press", async () => {
    backend.pick.mockResolvedValue(POINTER);
    backend.list.mockResolvedValue([app("writeback-test")]);
    await mount();

    await click(button("Browse…"));

    expect(backend.overview).toHaveBeenCalledTimes(1);
    expect(backend.overview).toHaveBeenCalledWith(POINTER, "writeback-test", "latest");
    expect(title()).toBe("writeback-test v1.0.0");
    expect(placeholder()).toBeNull();
    expect(applicationSelect().value).toBe("writeback-test");
  });

  it("a typed workspace FOLDER with one application opens it the same way", async () => {
    backend.list.mockResolvedValue([app("writeback-test")]);
    await mount();

    await typeAndEnter(FOLDER);

    expect(backend.overview).toHaveBeenCalledWith(FOLDER, "writeback-test", "latest");
    expect(title()).toBe("writeback-test v1.0.0");
  });

  it("every tab then has content: the Writeback tab shows the loaded application, not the hint", async () => {
    backend.pick.mockResolvedValue(POINTER);
    backend.list.mockResolvedValue([app("writeback-test")]);
    await mount();
    await click(button("Browse…"));

    const nav = Array.from(container.querySelectorAll("div")).find(
      (d) => d.textContent === "Writeback" && d.children.length === 0,
    ) as HTMLElement;
    await click(nav);

    expect(container.querySelector('[data-testid="writeback-section"]')?.textContent).toBe(
      "writeback of writeback-test",
    );
    expect(placeholder()).toBeNull();
  });

  it("TWO applications: nothing is guessed, the hint says to choose, and choosing opens it", async () => {
    backend.pick.mockResolvedValue(POINTER);
    backend.list.mockResolvedValue([app("alpha"), app("beta")]);
    await mount();

    await click(button("Browse…"));

    expect(backend.overview).not.toHaveBeenCalled();
    expect(title()).toBeNull();
    expect(placeholder()).toMatch(/2 applications are in this workspace\. Choose one/);
    expect(placeholder()).not.toMatch(/Browse to a workspace/);

    await choose(applicationSelect(), "beta");

    expect(backend.overview).toHaveBeenCalledWith(POINTER, "beta", "latest");
    expect(title()).toBe("beta v1.0.0");
  });

  it("a location that NAMES an application still opens that one, at the version it named", async () => {
    backend.resolve.mockResolvedValue({ registryPath: FOLDER, packageName: "beta", version: "1.0.0" });
    backend.list.mockResolvedValue([app("alpha"), app("beta")]);
    await mount();

    await typeAndEnter("C:\\ws\\beta\\1.0.0");

    expect(backend.overview).toHaveBeenCalledWith(FOLDER, "beta", "1.0.0");
    expect(title()).toBe("beta v1.0.0");
  });

  it("a handover from the main window with a workspace and NO application opens its only one", async () => {
    backend.list.mockResolvedValue([app("writeback-test")]);
    await mount();
    expect(backend.openHandler).not.toBeNull();

    await act(async () => {
      backend.openHandler!({ registryPath: FOLDER, packageName: "", versionPin: "" });
    });
    await flush();

    expect(backend.overview).toHaveBeenCalledWith(FOLDER, "writeback-test", "latest");
    expect(title()).toBe("writeback-test v1.0.0");
  });

  it("a handover that names the application opens it at the pin it carried", async () => {
    backend.list.mockResolvedValue([app("alpha"), app("beta")]);
    await mount();

    await act(async () => {
      backend.openHandler!({ registryPath: FOLDER, packageName: "alpha", versionPin: "1.0.0" });
    });
    await flush();

    expect(backend.overview).toHaveBeenCalledWith(FOLDER, "alpha", "1.0.0");
    expect(title()).toBe("alpha v1.0.0");
  });

  it("switching to a workspace with several applications drops the previous workspace's application", async () => {
    backend.list.mockResolvedValueOnce([app("writeback-test")]);
    backend.pick.mockResolvedValue(POINTER);
    await mount();
    await click(button("Browse…"));
    expect(title()).toBe("writeback-test v1.0.0");

    backend.list.mockResolvedValueOnce([app("alpha"), app("beta")]);
    await typeAndEnter("C:\\other");

    expect(title()).toBeNull();
    expect(placeholder()).toMatch(/2 applications are in this workspace/);
  });
  it("a SLOW workspace picked first cannot land over a FAST one picked after it", async () => {
    // A (slow share, two applications) is picked, then B (one application) is
    // typed; B finishes first and opens its application. A's listing then
    // arrives -- and must change nothing: not the path, not the list, and not
    // B's overview (its own load would have dropped B's).
    let releaseA: (v: unknown) => void = () => undefined;
    const slowA = new Promise((resolve) => {
      releaseA = resolve;
    });
    backend.pick.mockResolvedValue("C:\\slow\\workspace.calcula");
    backend.list.mockImplementation((p: string) =>
      p.startsWith("C:\\slow")
        ? slowA.then(() => [app("alpha"), app("beta")])
        : Promise.resolve([app("fast-app")]),
    );
    await mount();

    await click(button("Browse…"));
    await typeAndEnter("C:\\fast");
    expect(title()).toBe("fast-app v1.0.0");

    await act(async () => {
      releaseA(undefined);
    });
    await flush();

    expect(title()).toBe("fast-app v1.0.0");
    expect(applicationSelect().value).toBe("fast-app");
    expect(Array.from(applicationSelect().options).map((o) => o.value)).toEqual(["", "fast-app"]);
    const input = container.querySelector('input[placeholder^="Workspace, application"]') as HTMLInputElement;
    expect(input.value).toBe("C:\\fast");
    expect(backend.overview).toHaveBeenCalledTimes(1);
  });

  it("a handover to an EMPTY workspace says so, like Browse does -- not the generic hint", async () => {
    backend.list.mockResolvedValue([]);
    await mount();

    await act(async () => {
      backend.openHandler!({ registryPath: FOLDER, packageName: "", versionPin: "" });
    });
    await flush();

    expect(container.textContent).toContain("No applications found here.");
    expect(backend.overview).not.toHaveBeenCalled();
  });

  it("a handover whose listing FAILS keeps the overview and says why the pickers are missing", async () => {
    backend.list.mockRejectedValue(new Error("share went away"));
    await mount();

    await act(async () => {
      backend.openHandler!({ registryPath: FOLDER, packageName: "alpha", versionPin: "1.0.0" });
    });
    await flush();

    expect(title()).toBe("alpha v1.0.0");
    expect(container.textContent).toContain("Could not list the workspace's applications");
    expect(container.textContent).toContain("share went away");
  });
});

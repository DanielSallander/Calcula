// FILENAME: app/extensions/Distribution/lib/__tests__/pickWorkspace.test.ts
// PURPOSE: The workspace picker must hand the backend a location the backend
//          actually accepts.
// CONTEXT: The native dialog filters by EXTENSION, so "Calcula workspace
//          (*.calcula)" also lists any other `.calcula` file sitting in the
//          folder. The backend's reduction (`strip_workspace_marker`) is
//          deliberately strict — it strips ONLY the exact name
//          `workspace.calcula`, so that a directory merely ending in
//          `.calcula` is never silently retargeted one level up. Those two
//          facts together leave a gap: a differently-named `.calcula` file
//          would arrive as a location, pass `root.exists()` (it exists — as a
//          FILE), and fail later inside `read_dir` with an error that says
//          nothing about what the user did wrong.
//
//          Narrowing it in the BACKEND instead would be worse: `workspace_scope`
//          derives the publisher-pin identity from the same string, so a
//          reduction that ran on the opening path but not the scoping path
//          would file a pin under one identity and read it under another.
//          That is the split-view bug the whole marker design exists to avoid,
//          so the picker resolves it where the choice is made.

import { describe, it, expect, vi, beforeEach } from "vitest";

const openNativeDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openNativeDialog(...args),
}));

import { pickWorkspaceFile, pickWorkspaceFolder, WORKSPACE_MARKER_FILE } from "../pickWorkspace";

describe("pickWorkspaceFile", () => {
  beforeEach(() => openNativeDialog.mockReset());

  it("passes the marker file through untouched", async () => {
    openNativeDialog.mockResolvedValue("C:\\shared\\budget-ws\\workspace.calcula");
    await expect(pickWorkspaceFile()).resolves.toBe(
      "C:\\shared\\budget-ws\\workspace.calcula",
    );
  });

  it("accepts the marker in any casing, as a file dialog may return it", async () => {
    openNativeDialog.mockResolvedValue("C:\\shared\\ws\\Workspace.Calcula");
    await expect(pickWorkspaceFile()).resolves.toBe("C:\\shared\\ws\\Workspace.Calcula");
  });

  it("reduces ANY OTHER .calcula file to its containing folder", async () => {
    // The gap this whole file exists for: the extension filter lists it, the
    // backend would not strip it, and a file path is not a workspace.
    openNativeDialog.mockResolvedValue("C:\\shared\\ws\\notes.calcula");
    await expect(pickWorkspaceFile()).resolves.toBe("C:\\shared\\ws");
  });

  it("handles forward slashes the same way", async () => {
    openNativeDialog.mockResolvedValue("//server/share/ws/notes.calcula");
    await expect(pickWorkspaceFile()).resolves.toBe("//server/share/ws");
  });

  it("returns null when the user cancels", async () => {
    openNativeDialog.mockResolvedValue(null);
    await expect(pickWorkspaceFile()).resolves.toBeNull();
  });

  // NOT COVERED HERE: the `catch` that turns a failing dialog plugin into
  // `null`. Making the mock fail — as a rejected promise OR as a synchronous
  // throw — reports the error against the test with a stack containing no frame
  // from pickWorkspace.ts at all, i.e. the harness surfaces it from somewhere
  // other than the call under test. The behaviour itself is sound: the same
  // helper shape, with the same failing mock, returns null in an isolated file.
  // Rather than assert something this harness cannot observe, the gap is
  // written down. The cancel case below covers the same `null` return through
  // the normal path.

  it("asks for a file, never a directory", async () => {
    openNativeDialog.mockResolvedValue(null);
    await pickWorkspaceFile();
    const opts = openNativeDialog.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.directory).toBeUndefined();
    expect(opts.filters).toEqual([{ name: "Calcula workspace", extensions: ["calcula"] }]);
  });
});

describe("pickWorkspaceFolder", () => {
  beforeEach(() => openNativeDialog.mockReset());

  // Its ONE caller is the Publish dialog's create mode. Not a fallback for
  // workspaces that lack a marker — there are none, since publishing into a
  // location is what makes it a workspace — but the create path, where no
  // pointer file exists to be picked yet.
  it("asks for a directory, for the workspace this publish will create", async () => {
    openNativeDialog.mockResolvedValue("C:\\shared\\new-ws");
    await expect(pickWorkspaceFolder()).resolves.toBe("C:\\shared\\new-ws");
    const opts = openNativeDialog.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.directory).toBe(true);
  });

  it("returns null when the user cancels", async () => {
    openNativeDialog.mockResolvedValue(null);
    await expect(pickWorkspaceFolder()).resolves.toBeNull();
  });
});

describe("the marker name", () => {
  it("matches the Rust constant it mirrors", () => {
    // `WORKSPACE_MARKER_FILE` in core/calp/src/workspace_id.rs. If these two
    // drift, the picker passes through a name the backend does not strip.
    expect(WORKSPACE_MARKER_FILE).toBe("workspace.calcula");
  });
});

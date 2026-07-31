//! FILENAME: app/extensions/Settings/__tests__/ScriptSecurityPage.test.tsx
// PURPOSE: Cover the Script Security settings page — the destination every
//          script prompt names. It must actually offer the three levels, list
//          what is trusted, and revoke in one click.
// CONTEXT: Before this page existed the prompts pointed at a setting with no
//          UI, so the only escape from per-session re-prompting was to flip the
//          global level to "enabled" — defeating the whole tier model. These
//          tests keep the page honest: it never claims a declared capability is
//          granted, and every trust decision is visibly revocable.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invokeMock = vi.fn();
vi.mock("@api/backend", () => ({
  invokeBackend: (...args: unknown[]) => invokeMock(...args),
  createVirtualFile: vi.fn(),
  readVirtualFile: vi.fn(async () => {
    throw new Error("none");
  }),
}));

vi.mock("@core/lib/file-api", () => ({ getCurrentFilePath: async () => null }));

import { ScriptSecurityPage } from "../components/ScriptSecurityPage";
import { listWorkbookTrust } from "@api/scriptSecurity";

const KEY = "c:/books/q4.cala";
const STORE_KEY = "calcula.scriptTrust.v1";

let container: HTMLDivElement;
let root: Root;

function seedTrust(): void {
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      version: 1,
      records: [
        {
          workbookKey: KEY,
          displayPath: "C:\\Books\\Q4.cala",
          runTrust: {
            scripts: [{ id: "object-script:btn", sourceHash: "abc", source: "noop()" }],
            declaredCapabilities: ["net.fetch"],
            trustedAt: "2026-07-30T10:00:00.000Z",
          },
          notebookGrants: [
            { notebookId: "nb-1", capabilities: ["bi.query"], grantedAt: "2026-07-30T10:00:00.000Z" },
          ],
        },
      ],
    }),
  );
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<ScriptSecurityPage />);
  });
}

function buttonWithText(text: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!match) throw new Error(`no button labelled "${text}"`);
  return match as HTMLButtonElement;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "get_script_security_level") return "prompt";
    return undefined;
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Script Security settings page", () => {
  it("offers all three levels and marks the persisted one", async () => {
    await render();
    const radios = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[name='scriptSecurityLevel']"),
    );
    expect(radios.map((r) => r.value)).toEqual(["disabled", "prompt", "enabled"]);
    expect(radios.find((r) => r.checked)?.value).toBe("prompt");
    // The honest description of the ACTIVE level is expanded.
    expect(container.textContent).toContain("stored on this computer only");
  });

  it("writes the chosen level through to the backend", async () => {
    await render();
    const enabled = container.querySelector<HTMLInputElement>(
      "input[name='scriptSecurityLevel'][value='enabled']",
    )!;
    await act(async () => {
      enabled.click();
    });
    expect(invokeMock).toHaveBeenCalledWith("set_script_security_level", { level: "enabled" });
  });

  it("does not oversell 'enabled'", async () => {
    await render();
    expect(container.textContent).toContain("Not recommended");
  });

  it("lists a trusted workbook and says its capabilities are NOT granted", async () => {
    seedTrust();
    await render();
    expect(container.textContent).toContain("Q4.cala");
    expect(container.textContent).toContain("1 script covered");
    expect(container.textContent).toContain("declares (but is NOT granted)");
    expect(container.textContent).toContain("Network");
  });

  it("revokes trust in one click and drops it from the store", async () => {
    seedTrust();
    await render();
    await click(buttonWithText("Revoke trust"));
    expect(listWorkbookTrust().find((r) => r.workbookKey === KEY)?.runTrust ?? null).toBeNull();
    expect(container.textContent).toContain("No workbook is trusted");
  });

  it("lists persisted notebook capability grants and revokes one", async () => {
    seedTrust();
    await render();
    expect(container.textContent).toContain("nb-1");
    expect(container.textContent).toContain("BI query");

    await click(buttonWithText("Revoke"));
    expect(invokeMock).toHaveBeenCalledWith("revoke_script_capabilities", {
      scriptId: "notebook:nb-1",
    });
    expect(container.textContent).toContain("No notebook capability grants are remembered");
  });

  it("clears every decision behind a confirm", async () => {
    seedTrust();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await render();
    await click(buttonWithText("Clear all trust decisions"));
    expect(listWorkbookTrust()).toEqual([]);
  });

  it("says package consent is stored elsewhere, so trust is not confused with it", async () => {
    seedTrust();
    await render();
    expect(container.textContent).toContain(".calp package is separate");
  });

  it("shows an empty state when nothing has ever been trusted", async () => {
    await render();
    expect(container.textContent).toContain("No workbook is trusted");
    expect(container.textContent).toContain("No notebook capability grants are remembered");
  });
});

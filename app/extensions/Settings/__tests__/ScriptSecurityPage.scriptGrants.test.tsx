//! FILENAME: app/extensions/Settings/__tests__/ScriptSecurityPage.scriptGrants.test.tsx
// PURPOSE: Cover the "Script Capability Grants" section — the visible, revocable
//          list of every "Always allow in this workbook" answer the user has
//          given a LOCAL object script (F1).
// CONTEXT: A persisted grant that the user cannot find is a grant they cannot
//          withdraw, which is the failure mode this whole program exists to
//          avoid. These tests pin the transparency half: the grant is listed
//          with its script, its capabilities and its net.fetch origins; it can
//          be revoked per capability AND per script; and the copy tells the
//          truth about scope (this computer, tied to the code, lapses on edit).

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

// The OPEN workbook is the one holding the grants, so revoking must also drop
// the live + authoritative backend grant ("revoked means stop").
vi.mock("@core/lib/file-api", () => ({
  getCurrentFilePath: async () => "C:\\Books\\Q4.cala",
}));

import { ScriptSecurityPage } from "../components/ScriptSecurityPage";
import { listWorkbookTrust } from "@api/scriptSecurity";

const KEY = "c:/books/q4.cala";
const STORE_KEY = "calcula.scriptTrust.v1";

let container: HTMLDivElement;
let root: Root;

function seedScriptGrants(): void {
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      version: 1,
      records: [
        {
          workbookKey: KEY,
          displayPath: "C:\\Books\\Q4.cala",
          runTrust: null,
          notebookGrants: [],
          scriptGrants: [
            {
              scriptId: "btn-1",
              scriptName: "Refresh Button",
              sourceHash: "a".repeat(64),
              source: "function setup(){}",
              capabilities: ["net.fetch", "schedule"],
              netOrigins: ["https://api.example.com"],
              grantedAt: "2026-07-31T09:00:00.000Z",
            },
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

function buttonWithTitle(title: string): HTMLButtonElement {
  const match = container.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  if (!match) throw new Error(`no button titled "${title}"`);
  return match;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function grantsOf(): unknown[] {
  return listWorkbookTrust().find((r) => r.workbookKey === KEY)?.scriptGrants ?? [];
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

describe("Script Security page — script capability grants", () => {
  it("lists the script, its capabilities and the exact origins it may reach", async () => {
    seedScriptGrants();
    await render();
    expect(container.textContent).toContain("Script Capability Grants");
    expect(container.textContent).toContain("Refresh Button");
    expect(container.textContent).toContain("Network");
    expect(container.textContent).toContain("Scheduled jobs");
    expect(container.textContent).toContain("https://api.example.com");
  });

  it("states the scope honestly: this computer, tied to the code, lapses on edit", async () => {
    seedScriptGrants();
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("Always allow in this workbook");
    expect(text).toContain("tied to that script");
    expect(text).toContain("asked again");
    expect(text).toContain("stored on this computer");
    // Escalation is promised explicitly, because it is the property a user
    // cannot verify for themselves.
    expect(text).toContain("A capability the script never had is always asked for");
  });

  it("revokes ONE capability from the chip and keeps the sibling", async () => {
    seedScriptGrants();
    await render();
    await click(buttonWithTitle("Revoke Network for Refresh Button"));

    const grants = grantsOf() as Array<{ capabilities: string[]; netOrigins: string[] }>;
    expect(grants).toHaveLength(1);
    expect(grants[0].capabilities).toEqual(["schedule"]);
    expect(grants[0].netOrigins).toEqual([]);
    expect(container.textContent).not.toContain("https://api.example.com");
    // No script is mounted here, so there is no live grant to tear down and the
    // page must not fabricate a backend call. (The "revoked means stop" path for
    // a RUNNING script is covered in api/__tests__/scriptCapabilityGrants.test.ts,
    // where the live grant set is populated first.)
    expect(invokeMock).not.toHaveBeenCalledWith("revoke_script_capabilities", {
      scriptId: "btn-1",
    });
  });

  it("revokes every capability of one script", async () => {
    seedScriptGrants();
    await render();
    await click(buttonWithText("Revoke all"));
    expect(grantsOf()).toEqual([]);
    expect(container.textContent).toContain("No script capability grants are remembered");
  });

  it("shows an empty state when nothing was ever answered 'Always'", async () => {
    await render();
    expect(container.textContent).toContain("No script capability grants are remembered");
  });

  it("clear-all removes script grants too", async () => {
    seedScriptGrants();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await render();
    await click(buttonWithText("Clear all trust decisions"));
    expect(listWorkbookTrust()).toEqual([]);
  });
});

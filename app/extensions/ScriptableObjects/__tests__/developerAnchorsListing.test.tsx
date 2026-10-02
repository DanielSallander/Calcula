//! FILENAME: app/extensions/ScriptableObjects/__tests__/developerAnchorsListing.test.tsx
// PURPOSE: "Code in This File" lists who this COMPUTER remembers as the creator
//          of each application it develops (the developer anchor) -- workspace
//          in the user's own spelling, application, creator and key fingerprint
//          -- never the normalized scope id, never an unreadable store as an
//          empty list, and Forget only behind an awaited, fail-closed confirm.
// CONTEXT: The anchor is the one guard a share-writer cannot forge: a workspace
//          proves a planted first version by its own signature just as well as
//          the real one. Forgetting it is a deliberate hole, so the gate is what
//          is pinned. The confirm is doubled in the TAURI shape (a Promise).

import fs from "fs";
import path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DeveloperAnchorInfo, TrustedPublisherReport } from "@api";

const h = vi.hoisted(() => ({ invokes: [] as { cmd: string; args: unknown }[] }));
const confirmAsync = vi.fn();

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  invokeBackend: async (cmd: string, args?: unknown) => {
    h.invokes.push({ cmd, args });
    if (cmd === "calp_forget_developer_anchor") return { forgotten: 1 };
    throw new Error(`unexpected command ${cmd}`);
  },
}));

vi.mock("@api/dialogs", () => ({
  confirmAsync: (...a: unknown[]) => confirmAsync(...a),
}));

import {
  ANCHOR_SOURCE,
  DeveloperAnchorsSection,
  forgetRememberedCreatorQuestion,
} from "../components/DeveloperAnchorsSection";

const SCOPE_ID = "\\\\server\\share\\ws-normalized-lowercase-id";

const SALES: DeveloperAnchorInfo = {
  scopeLabel: "\\\\Server\\Share\\WS",
  application: "sales",
  rootName: "Alice",
  rootFingerprint: "a1b2c3d4e5f6a7b8...",
  rootVersion: "1.0.0",
  publishersRevision: 2,
  anchoredAt: "2026-09-01T08:00:00Z",
  anchoredBy: "checkout",
};

function report(overrides: Partial<TrustedPublisherReport> = {}): TrustedPublisherReport {
  return {
    names: [],
    totalPins: 0,
    conflictCount: 0,
    error: "",
    developerAnchors: [
      // A row smuggling the normalized scope id: the section must not render it.
      { ...SALES, scope: SCOPE_ID } as DeveloperAnchorInfo,
      { ...SALES, application: "finance", anchoredBy: "publish", publishersRevision: 0 },
    ],
    developerAnchorsError: "",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
const rows = () => [...container.querySelectorAll<HTMLElement>('[data-testid="developer-anchor-row"]')];

async function mount(r: TrustedPublisherReport, onChanged = vi.fn()): Promise<void> {
  await act(async () => {
    root.render(<DeveloperAnchorsSection report={r} onChanged={onChanged} />);
  });
}

async function forgetFirst(): Promise<void> {
  const button = rows()[0].querySelector<HTMLElement>('[data-testid="developer-anchor-forget"]');
  expect(button, "a remembered creator has no Forget").toBeTruthy();
  await act(async () => {
    button!.click();
  });
  await act(async () => {});
}

beforeEach(() => {
  h.invokes.length = 0;
  confirmAsync.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Applications you develop (the developer anchor)", () => {
  it("lists workspace, application, creator and key -- and never the scope id", async () => {
    await mount(report());
    expect(rows()).toHaveLength(2);
    const text = container.textContent ?? "";
    expect(text).toContain("Applications you develop: this computer remembers who created them (2)");
    expect(text).toContain(SALES.scopeLabel);
    expect(text).toContain("sales");
    expect(text).toContain("finance");
    expect(text).toContain("a1b2c3d4e5f6a7b8...");
    expect(text).toContain(ANCHOR_SOURCE.checkout);
    expect(text).toContain(ANCHOR_SOURCE.publish);
    expect(text).toContain("co-publisher list revision 2");
    expect(text, "the normalized scope id is key material").not.toContain("normalized-lowercase-id");
    expect(text).toMatch(/NOT part of this workbook/);
  });

  // SABOTAGE: render the empty state whenever the list is empty.
  it("renders an unreadable store as a failure, never as 'nothing remembered'", async () => {
    await mount(report({ developerAnchors: [], developerAnchorsError: "developer-anchors.json: bad json" }));
    expect(container.querySelector('[data-testid="developer-anchors-error"]')!.textContent).toMatch(
      /could not be read: developer-anchors\.json: bad json/,
    );
    expect(container.textContent).not.toContain("Nothing remembered yet");
  });

  // SABOTAGE: drop the `await` on confirmAsync and test it with `!`.
  it("forgets nothing on a No (Tauri-shaped confirm) or a dialog that cannot be shown", async () => {
    const onChanged = vi.fn();
    confirmAsync.mockReturnValue(Promise.resolve(false));
    await mount(report(), onChanged);
    await forgetFirst();
    expect(confirmAsync).toHaveBeenCalledTimes(1);
    expect(confirmAsync.mock.calls[0][0]).toBe(forgetRememberedCreatorQuestion(SALES));
    expect(h.invokes, "a No forgot the remembered creator").toEqual([]);

    confirmAsync.mockImplementation(() => Promise.reject(new Error("no dialog")));
    await forgetFirst();
    expect(h.invokes, "a dialog that could not be shown forgot it").toEqual([]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("with a yes, forgets that application in that workspace -- as the user spelled it -- and reloads", async () => {
    const onChanged = vi.fn();
    confirmAsync.mockReturnValue(Promise.resolve(true));
    await mount(report(), onChanged);
    await forgetFirst();
    expect(h.invokes).toEqual([
      {
        cmd: "calp_forget_developer_anchor",
        args: { params: { registryPath: SALES.scopeLabel, packageName: "sales" } },
      },
    ]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("the question names the creator's key and says to confirm with the creator first", () => {
    const q = forgetRememberedCreatorQuestion(SALES);
    expect(q).toContain("a1b2c3d4e5f6a7b8...");
    expect(q).toContain(SALES.scopeLabel);
    expect(q).toMatch(/only after the application's creator has confirmed/);
  });
});

describe("wiring", () => {
  const APP_ROOT = path.resolve(__dirname, "../../..");

  it("sits in Code in This File beside the trusted publishers, reloading after a forget", () => {
    const panel = fs.readFileSync(
      path.join(APP_ROOT, "extensions/ScriptableObjects/components/CodeInThisFilePanel.tsx"),
      "utf8",
    );
    expect(panel).toContain("<TrustedPublishersSection report={pins} />");
    expect(panel).toContain("<DeveloperAnchorsSection report={pins} onChanged={() => void reload()} />");
  });

  it("has a row for every way Rust records an anchor", () => {
    const rs = fs.readFileSync(path.join(APP_ROOT, "../core/calp/src/developer_anchor.rs"), "utf8");
    const asStr = rs.match(/impl AnchoredBy \{[\s\S]*?\n\}/)![0];
    const via = [...asStr.matchAll(/AnchoredBy::\w+ => "(\w+)"/g)].map((m) => m[1]);
    expect(via.length).toBe(3);
    for (const v of via) expect(Object.keys(ANCHOR_SOURCE), `anchoredBy "${v}" has no row`).toContain(v);
  });
});

//! FILENAME: app/src/api/__tests__/buttonControlService.test.ts
// PURPOSE: The button-creation seam refuses LOUDLY when nothing is registered,
//          and hands back the provider's own instanceId when something is.
// CONTEXT: The seam exists because a caller that hand-rolled control metadata
//          reported success and drew no button. A seam that answered "no
//          provider" with a silent no-op would reproduce exactly that failure,
//          so the refusal is the behaviour under test, not an edge case.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  hasButtonControlProvider,
  registerButtonControlProvider,
  requireButtonControlProvider,
  resetButtonControlProvider,
  type ButtonControlHandle,
  type ButtonControlProvider,
  type CreateButtonControlRequest,
} from "../buttonControlService";

function fakeProvider(
  onCreate?: (req: CreateButtonControlRequest) => void,
): ButtonControlProvider {
  return {
    async createButton(request): Promise<ButtonControlHandle> {
      onCreate?.(request);
      return {
        instanceId: `control-${request.sheetIndex}-${request.row}-${request.col}`,
        sheetIndex: request.sheetIndex,
        row: request.row,
        col: request.col,
        x: 100,
        y: 40,
        width: 80,
        height: 28,
      };
    },
    async removeButton(): Promise<void> {
      /* no-op */
    },
  };
}

describe("buttonControlService (IoC seam)", () => {
  beforeEach(() => {
    resetButtonControlProvider();
  });

  it("reports no provider before registration", () => {
    expect(hasButtonControlProvider()).toBe(false);
  });

  it("THROWS an actionable error when nothing is registered", () => {
    expect(() => requireButtonControlProvider()).toThrow(
      /no button provider is registered/i,
    );
    // The message must name the extension the user has to enable — an error
    // that only says "unavailable" is not actionable.
    expect(() => requireButtonControlProvider()).toThrow(/Controls extension/);
  });

  it("returns the registered provider and reports availability", async () => {
    const seen: CreateButtonControlRequest[] = [];
    registerButtonControlProvider(fakeProvider((r) => seen.push(r)));

    expect(hasButtonControlProvider()).toBe(true);
    const handle = await requireButtonControlProvider().createButton({
      sheetIndex: 2,
      row: 4,
      col: 1,
      label: "Macro1245",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].label).toBe("Macro1245");
    // The instanceId comes BACK from the provider — callers must never derive it.
    expect(handle.instanceId).toBe("control-2-4-1");
  });

  it("unregistering clears the provider", () => {
    const off = registerButtonControlProvider(fakeProvider());
    expect(hasButtonControlProvider()).toBe(true);
    off();
    expect(hasButtonControlProvider()).toBe(false);
    expect(() => requireButtonControlProvider()).toThrow();
  });

  it("a stale cleanup cannot blank out a newer provider", () => {
    const first = fakeProvider();
    const offFirst = registerButtonControlProvider(first);
    const second = fakeProvider();
    registerButtonControlProvider(second);

    offFirst(); // the OLD activation's cleanup runs after a re-activation
    expect(hasButtonControlProvider()).toBe(true);
    expect(requireButtonControlProvider()).toBe(second);
  });

  it("last registration wins", async () => {
    const a = vi.fn();
    const b = vi.fn();
    registerButtonControlProvider(fakeProvider(a));
    registerButtonControlProvider(fakeProvider(b));

    await requireButtonControlProvider().createButton({
      sheetIndex: 0,
      row: 0,
      col: 0,
      label: "x",
    });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});

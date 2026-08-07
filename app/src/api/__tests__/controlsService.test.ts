//! FILENAME: app/src/api/__tests__/controlsService.test.ts
// PURPOSE: The controls seam refuses LOUDLY when nothing is registered, hands
//          back the provider's own instanceId when something is, and keeps the
//          read door (empty list) separate from the write door (throw).
// CONTEXT: The seam exists because a caller that hand-rolled control metadata
//          reported success and drew an INVISIBLE button. A seam that answered
//          "no provider" with a silent no-op would reproduce exactly that
//          failure, so the refusal is the behaviour under test, not an edge
//          case. The read/write asymmetry is deliberate and is pinned here: for
//          an enumeration, "the extension is not loaded" and "there are no
//          controls" are the same answer and an empty list is honest; for a
//          mutation they must never look alike.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  hasControlsProvider,
  getControlsProvider,
  registerControlsProvider,
  requireControlsProvider,
  resetControlsProvider,
  type ControlsProvider,
  type CreateShapeControlRequest,
  type ShapeCatalogEntry,
  type ShapeControlHandle,
} from "../controlsService";

const CATALOG: ShapeCatalogEntry[] = [
  {
    id: "rectangle",
    label: "Rectangle",
    categoryId: "rectangles",
    categoryLabel: "Rectangles",
    defaultWidth: 120,
    defaultHeight: 80,
    isLine: false,
  },
];

function fakeProvider(
  onCreate?: (req: CreateShapeControlRequest) => void,
  onDelete?: (id: string) => void,
): ControlsProvider {
  return {
    listShapeCatalog: () => CATALOG,
    async createShape(request): Promise<ShapeControlHandle> {
      onCreate?.(request);
      return {
        instanceId: `control-${request.sheetIndex}-${request.row}-${request.col}`,
        shapeType: request.shapeType,
        sheetIndex: request.sheetIndex,
        row: request.row,
        col: request.col,
        x: 100,
        y: 40,
        width: request.width ?? 120,
        height: request.height ?? 80,
      };
    },
    async deleteControl(instanceId): Promise<boolean> {
      onDelete?.(instanceId);
      return instanceId === "control-0-0-0";
    },
    async listControls() {
      return [];
    },
  };
}

describe("controlsService (IoC seam)", () => {
  beforeEach(() => {
    resetControlsProvider();
  });

  it("reports no provider before registration", () => {
    expect(hasControlsProvider()).toBe(false);
    expect(getControlsProvider()).toBeNull();
  });

  it("THROWS an actionable error when nothing is registered", () => {
    expect(() => requireControlsProvider()).toThrow(/no controls provider is registered/i);
    // The message must name the extension the user has to enable — an error
    // that only says "unavailable" is not actionable.
    expect(() => requireControlsProvider()).toThrow(/Controls extension/);
  });

  it("the READ accessor stays silent where the WRITE accessor throws", () => {
    // Same absent provider, two deliberately different answers.
    expect(getControlsProvider()).toBeNull();
    expect(() => requireControlsProvider()).toThrow();
  });

  it("returns the registered provider and reports availability", async () => {
    const seen: CreateShapeControlRequest[] = [];
    registerControlsProvider(fakeProvider((r) => seen.push(r)));

    expect(hasControlsProvider()).toBe(true);
    const handle = await requireControlsProvider().createShape({
      sheetIndex: 2,
      row: 4,
      col: 1,
      shapeType: "rectangle",
      text: "Run",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].shapeType).toBe("rectangle");
    // `text`, never `label` — the property name is part of the contract.
    expect(seen[0].text).toBe("Run");
    // The instanceId comes BACK from the provider — callers must never derive it.
    expect(handle.instanceId).toBe("control-2-4-1");
    expect(handle.shapeType).toBe("rectangle");
  });

  it("reports false rather than throwing when a delete finds nothing", async () => {
    const deleted: string[] = [];
    registerControlsProvider(fakeProvider(undefined, (id) => deleted.push(id)));

    await expect(requireControlsProvider().deleteControl("control-0-0-0")).resolves.toBe(true);
    await expect(requireControlsProvider().deleteControl("control-9-9-9")).resolves.toBe(false);
    expect(deleted).toEqual(["control-0-0-0", "control-9-9-9"]);
  });

  it("exposes the shape catalog so 123 shapes need not live in a consent string", () => {
    registerControlsProvider(fakeProvider());
    const catalog = requireControlsProvider().listShapeCatalog();
    expect(catalog[0].id).toBe("rectangle");
    expect(catalog[0].categoryLabel).toBe("Rectangles");
  });

  it("unregistering clears the provider", () => {
    const off = registerControlsProvider(fakeProvider());
    expect(hasControlsProvider()).toBe(true);
    off();
    expect(hasControlsProvider()).toBe(false);
    expect(() => requireControlsProvider()).toThrow();
  });

  it("a stale cleanup cannot blank out a newer provider", () => {
    const first = fakeProvider();
    const offFirst = registerControlsProvider(first);
    const second = fakeProvider();
    registerControlsProvider(second);

    offFirst(); // the OLD activation's cleanup runs after a re-activation
    expect(hasControlsProvider()).toBe(true);
    expect(requireControlsProvider()).toBe(second);
  });

  it("last registration wins", async () => {
    const a = vi.fn();
    const b = vi.fn();
    registerControlsProvider(fakeProvider(a));
    registerControlsProvider(fakeProvider(b));

    await requireControlsProvider().createShape({
      sheetIndex: 0,
      row: 0,
      col: 0,
      shapeType: "rectangle",
    });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});

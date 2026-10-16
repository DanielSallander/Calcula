//! FILENAME: app/src/api/__tests__/objectPane.test.ts
// PURPOSE: The OBJECT PANE seam (WP-C D-PANE, @api/objectPane): the provider
//          registry (last wins per type, stale cleanup), the host doors
//          (false without a host, never a silent "opened"), state change
//          notifications, the "Format..." menu row every family adds, and the
//          test reset.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GridRegion } from "../gridOverlays";
import {
  OBJECT_PANE_COMMAND_FORMAT,
  OBJECT_PANE_FORMAT_LABEL,
  OBJECT_PANE_FORMAT_TAB,
  OBJECT_PANE_ID,
  OBJECT_PANE_NOT_INSTALLED,
  OBJECT_PANE_NO_PROVIDER,
  closeObjectPane,
  getObjectPaneProvider,
  getObjectPaneState,
  hasObjectPaneProvider,
  notifyObjectPaneStateChanged,
  objectPaneMenuEntry,
  objectPaneNoTabReason,
  onObjectPaneStateChanged,
  openObjectPane,
  registerObjectPaneHost,
  registerObjectPaneProvider,
  resetObjectPane,
  type ObjectPaneHost,
  type ObjectPaneOpenRequest,
  type ObjectPaneProvider,
  type ObjectPaneState,
} from "../objectPane";

function region(id: string, type: string): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
}

const CHART = region("chart-1", "chart");
const SLICER = region("slicer-1", "slicer");

function provider(types: string[], tabIds: string[] = []): ObjectPaneProvider {
  return {
    types,
    tabs: () => tabIds.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1), render: () => null })),
  };
}

/** A recording host whose state is whatever the last accepted open asked for. */
function recordingHost(accept = true): ObjectPaneHost & { requests: ObjectPaneOpenRequest[]; closes: number } {
  let state: ObjectPaneState = { open: false, regionId: null, regionType: null, tabId: null };
  const h = {
    requests: [] as ObjectPaneOpenRequest[],
    closes: 0,
    open(req: ObjectPaneOpenRequest): boolean {
      h.requests.push(req);
      if (!accept) return false;
      state = {
        open: true,
        regionId: req.region?.id ?? null,
        regionType: req.region?.type ?? null,
        tabId: req.tab ?? null,
      };
      notifyObjectPaneStateChanged();
      return true;
    },
    close(): void {
      h.closes += 1;
      state = { open: false, regionId: null, regionType: null, tabId: null };
      notifyObjectPaneStateChanged();
    },
    state: () => state,
  };
  return h;
}

beforeEach(() => {
  resetObjectPane();
});

afterEach(() => {
  resetObjectPane();
  vi.restoreAllMocks();
});

describe("names", () => {
  it("the pane id, Format tab id and command ids are the contract the doors use", () => {
    expect(OBJECT_PANE_ID).toBe("object-pane");
    expect(OBJECT_PANE_FORMAT_TAB).toBe("format");
    expect(OBJECT_PANE_FORMAT_LABEL).toBe("Format...");
    expect(OBJECT_PANE_COMMAND_FORMAT).toBe("objectPane.format");
  });
});

describe("without a host", () => {
  it("openObjectPane answers false for every reason; close is a no-op; the state reads closed", () => {
    registerObjectPaneProvider(provider(["chart"], ["data"]));
    for (const reason of ["press", "follow", "command"] as const) {
      expect(openObjectPane({ region: CHART, reason })).toBe(false);
    }
    expect(() => closeObjectPane()).not.toThrow();
    expect(getObjectPaneState()).toEqual({ open: false, regionId: null, regionType: null, tabId: null });
  });
});

describe("the provider registry", () => {
  it("finds a provider by the region's type", () => {
    const p = provider(["chart", "chart-alt"]);
    registerObjectPaneProvider(p);
    expect(getObjectPaneProvider(CHART)).toBe(p);
    expect(getObjectPaneProvider(region("x", "chart-alt"))).toBe(p);
    expect(getObjectPaneProvider(SLICER)).toBeNull();
    expect(hasObjectPaneProvider("chart")).toBe(true);
    expect(hasObjectPaneProvider("slicer")).toBe(false);
  });

  it("last registration wins per type, and a stale cleanup cannot remove the newer one", () => {
    const first = provider(["chart", "slicer"]);
    const second = provider(["chart"]);
    const disposeFirst = registerObjectPaneProvider(first);
    const disposeSecond = registerObjectPaneProvider(second);
    expect(getObjectPaneProvider(CHART)).toBe(second);
    expect(getObjectPaneProvider(SLICER)).toBe(first);

    disposeFirst();
    // The stale cleanup removed only what was still ITS: the slicer type.
    expect(getObjectPaneProvider(CHART)).toBe(second);
    expect(hasObjectPaneProvider("slicer")).toBe(false);

    disposeSecond();
    expect(hasObjectPaneProvider("chart")).toBe(false);
  });
});

describe("the host doors", () => {
  it("openObjectPane forwards the request verbatim and returns the host's answer", () => {
    const h = recordingHost();
    registerObjectPaneHost(h);
    expect(openObjectPane({ region: CHART, tab: "format", reason: "command" })).toBe(true);
    expect(h.requests).toEqual([{ region: CHART, tab: "format", reason: "command" }]);
    expect(getObjectPaneState()).toEqual({ open: true, regionId: "chart-1", regionType: "chart", tabId: "format" });
  });

  it("a host that refuses makes the door answer false", () => {
    registerObjectPaneHost(recordingHost(false));
    expect(openObjectPane({ region: CHART, reason: "press" })).toBe(false);
    expect(getObjectPaneState().open).toBe(false);
  });

  it("a host that throws is logged and the door answers false (and close/state never throw)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    registerObjectPaneHost({
      open: () => {
        throw new Error("boom");
      },
      close: () => {
        throw new Error("boom");
      },
      state: () => {
        throw new Error("boom");
      },
    });
    expect(openObjectPane({ reason: "command" })).toBe(false);
    expect(() => closeObjectPane()).not.toThrow();
    expect(getObjectPaneState().open).toBe(false);
    expect(err).toHaveBeenCalled();
  });

  it("closeObjectPane reaches the host", () => {
    const h = recordingHost();
    registerObjectPaneHost(h);
    openObjectPane({ region: CHART, reason: "command" });
    closeObjectPane();
    expect(h.closes).toBe(1);
    expect(getObjectPaneState().open).toBe(false);
  });

  it("last host wins; a stale host cleanup leaves the newer host installed", () => {
    const a = recordingHost();
    const b = recordingHost();
    const disposeA = registerObjectPaneHost(a);
    registerObjectPaneHost(b);
    disposeA();
    expect(openObjectPane({ region: CHART, reason: "command" })).toBe(true);
    expect(a.requests).toHaveLength(0);
    expect(b.requests).toHaveLength(1);
  });
});

describe("state change notifications", () => {
  it("every open/close the host announces reaches each listener with the CURRENT state", () => {
    const h = recordingHost();
    registerObjectPaneHost(h);
    const seen: ObjectPaneState[] = [];
    onObjectPaneStateChanged((s) => seen.push(s));

    openObjectPane({ region: SLICER, tab: "settings", reason: "command" });
    closeObjectPane();
    expect(seen).toEqual([
      { open: true, regionId: "slicer-1", regionType: "slicer", tabId: "settings" },
      { open: false, regionId: null, regionType: null, tabId: null },
    ]);
  });

  it("installing and removing the host are announced (a pane whose host goes away reads closed)", () => {
    const seen: boolean[] = [];
    onObjectPaneStateChanged((s) => seen.push(s.open));
    const h = recordingHost();
    const dispose = registerObjectPaneHost(h);
    openObjectPane({ region: CHART, reason: "command" });
    dispose();
    expect(seen).toEqual([false, true, false]);
    expect(getObjectPaneState().open).toBe(false);
  });

  it("a throwing listener is logged and the others still run; unsubscribe stops delivery", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const good = vi.fn();
    onObjectPaneStateChanged(() => {
      throw new Error("bad listener");
    });
    const off = onObjectPaneStateChanged(good);
    notifyObjectPaneStateChanged();
    expect(good).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
    off();
    notifyObjectPaneStateChanged();
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe("objectPaneMenuEntry -- the row every family's menu adds", () => {
  it("no provider: disabled with the reason, and run does nothing", () => {
    const h = recordingHost();
    registerObjectPaneHost(h);
    const entry = objectPaneMenuEntry(CHART);
    expect(entry).toMatchObject({
      id: OBJECT_PANE_COMMAND_FORMAT,
      label: OBJECT_PANE_FORMAT_LABEL,
      disabled: true,
      reason: OBJECT_PANE_NO_PROVIDER,
    });
    entry.run();
    expect(h.requests).toHaveLength(0);
  });

  it("a provider but no host: disabled with 'not available'", () => {
    registerObjectPaneProvider(provider(["chart"]));
    const entry = objectPaneMenuEntry(CHART);
    expect(entry.disabled).toBe(true);
    expect(entry.reason).toBe(OBJECT_PANE_NOT_INSTALLED);
    expect(() => entry.run()).not.toThrow();
  });

  it("provider and host: enabled; run opens THIS object on Format as a door (reason command)", () => {
    registerObjectPaneProvider(provider(["chart"], ["data"]));
    const h = recordingHost();
    registerObjectPaneHost(h);
    const entry = objectPaneMenuEntry(CHART);
    expect(entry.disabled).toBe(false);
    expect(entry.reason).toBeNull();
    entry.run();
    expect(h.requests).toEqual([{ region: CHART, tab: OBJECT_PANE_FORMAT_TAB, reason: "command" }]);
  });

  it("a build tab the object offers: labelled by the tab, opens that tab", () => {
    registerObjectPaneProvider(provider(["chart"], ["data"]));
    const h = recordingHost();
    registerObjectPaneHost(h);
    const entry = objectPaneMenuEntry(CHART, "data");
    expect(entry).toMatchObject({ id: "objectPane.tab.data", label: "Data...", disabled: false, reason: null });
    entry.run();
    expect(h.requests).toEqual([{ region: CHART, tab: "data", reason: "command" }]);
  });

  it("a build tab the object does NOT offer: disabled with the reason naming the tab", () => {
    registerObjectPaneProvider(provider(["chart"], ["data"]));
    const h = recordingHost();
    registerObjectPaneHost(h);
    const entry = objectPaneMenuEntry(CHART, "fields");
    expect(entry.disabled).toBe(true);
    expect(entry.reason).toBe(objectPaneNoTabReason("fields"));
    entry.run();
    expect(h.requests).toHaveLength(0);
  });

  it("a provider whose tabs() throws: the build-tab row is disabled, Format stays enabled", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    registerObjectPaneProvider({
      types: ["chart"],
      tabs: () => {
        throw new Error("boom");
      },
    });
    registerObjectPaneHost(recordingHost());
    expect(objectPaneMenuEntry(CHART, "data").disabled).toBe(true);
    expect(objectPaneMenuEntry(CHART).disabled).toBe(false);
  });
});

describe("resetObjectPane", () => {
  it("forgets every provider, the host and every listener", () => {
    registerObjectPaneProvider(provider(["chart"]));
    registerObjectPaneHost(recordingHost());
    const listener = vi.fn();
    onObjectPaneStateChanged(listener);

    resetObjectPane();

    expect(hasObjectPaneProvider("chart")).toBe(false);
    expect(openObjectPane({ region: CHART, reason: "command" })).toBe(false);
    notifyObjectPaneStateChanged();
    expect(listener).not.toHaveBeenCalled();
  });
});

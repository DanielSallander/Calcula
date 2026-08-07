//! FILENAME: app/extensions/Controls/__tests__/imageRendererMedia.test.ts
// PURPOSE: The renderer resolves a `media:` handle ONCE per picture, paints it
//          from ONE blob URL keyed by content hash, and lets go of that URL when
//          the last control referencing it disappears.
// CONTEXT: The property used to hold the whole picture as base64, cached by that
//          multi-megabyte string. Two costs came with it, and both are asserted
//          against here:
//
//            * `resolve_control_properties` returns EVERY property, and
//              `invalidateAllImageCaches` marks every entry stale — so one theme
//              change re-pulled every image's entire base64 across IPC. With
//              handles that pull is ~70 bytes, and the BYTES must not be
//              re-pulled at all: they are immutable under their hash.
//            * N controls showing one logo meant N copies. Content addressing
//              collapses that to one IPC call, one Blob and one decode.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const REF_A = `media:${HASH_A}`;
const REF_B = `media:${HASH_B}`;

const resolveMediaRef = vi.fn(async (ref: string) => {
  const hash = ref.slice("media:".length);
  // One byte of "PNG", base64'd. The renderer only needs a decodable payload.
  return `data:image/png;base64,${btoa(hash.slice(0, 3))}`;
});
const resolveControlProperties = vi.fn();
const requestOverlayRedraw = vi.fn();

vi.mock("@api/filesystem", () => ({ resolveMediaRef: (r: string) => resolveMediaRef(r) }));
vi.mock("@api/gridOverlays", () => ({
  overlayGetRowHeaderWidth: () => 0,
  overlayGetColHeaderHeight: () => 0,
  overlaySheetToCanvas: (_c: unknown, x: number, y: number) => ({ canvasX: x, canvasY: y }),
  requestOverlayRedraw: () => requestOverlayRedraw(),
}));
vi.mock("../lib/controlApi", () => ({
  resolveControlProperties: (s: number, r: number, c: number) =>
    resolveControlProperties(s, r, c),
}));
vi.mock("../Button/floatingSelection", () => ({ isFloatingControlSelected: () => false }));

import {
  renderFloatingImage,
  invalidateAllImageCaches,
  forgetImageControl,
  releaseAllImageMedia,
  getMediaNaturalSize,
} from "../Image/imageRenderer";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const createdUrls: string[] = [];
const revokedUrls: string[] = [];
let urlCounter = 0;

/** A canvas context that records the calls we care about and swallows the rest. */
function fakeCtx(): CanvasRenderingContext2D & { drawn: unknown[] } {
  const drawn: unknown[] = [];
  const target: Record<string, unknown> = {
    drawn,
    globalAlpha: 1,
    drawImage: (...args: unknown[]) => drawn.push(args),
  };
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop as string];
      return () => undefined;
    },
    set(obj, prop, value) {
      obj[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D & { drawn: unknown[] };
}

function overlayCtx(ctx: CanvasRenderingContext2D, id: string, row: number) {
  return {
    ctx,
    canvasWidth: 800,
    canvasHeight: 600,
    region: {
      id,
      floating: { x: 10, y: 10, width: 100, height: 80 },
      data: { controlType: "image", sheetIndex: 0, row, col: 0 },
    },
  } as never;
}

/** Let the renderer's async metadata fetch and media resolution settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Render, settle, render — the paint is sync, so a value that arrives async is
 *  only visible on the following frame. Mirrors how the grid actually redraws. */
async function paint(ctx: CanvasRenderingContext2D, id: string, row: number): Promise<void> {
  renderFloatingImage(overlayCtx(ctx, id, row));
  await settle();
  renderFloatingImage(overlayCtx(ctx, id, row));
  await settle();
  renderFloatingImage(overlayCtx(ctx, id, row));
  await settle();
  renderFloatingImage(overlayCtx(ctx, id, row));
}

class FakeImage {
  static created: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  complete = false;
  naturalWidth = 0;
  naturalHeight = 0;
  private value = "";
  constructor() {
    FakeImage.created.push(this);
  }
  get src(): string {
    return this.value;
  }
  set src(v: string) {
    this.value = v;
    this.complete = true;
    this.naturalWidth = 32;
    this.naturalHeight = 32;
    queueMicrotask(() => this.onload?.());
  }
}

beforeEach(() => {
  releaseAllImageMedia();
  resolveMediaRef.mockClear();
  resolveControlProperties.mockReset();
  requestOverlayRedraw.mockClear();
  createdUrls.length = 0;
  revokedUrls.length = 0;
  FakeImage.created.length = 0;
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (_blob: Blob) => {
      const url = `blob:calcula/${++urlCounter}`;
      createdUrls.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => {
      revokedUrls.push(url);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe("resolving a media handle", () => {
  it("pulls the bytes once, wraps them in ONE blob URL, and paints from it", async () => {
    resolveControlProperties.mockResolvedValue({ src: REF_A, opacity: "1" });
    const ctx = fakeCtx();

    await paint(ctx, "ctrl-a", 0);

    expect(resolveMediaRef).toHaveBeenCalledTimes(1);
    expect(resolveMediaRef).toHaveBeenCalledWith(REF_A);
    expect(createdUrls).toHaveLength(1);
    // What reaches the <img> is the blob URL, never a data URL or a handle.
    expect(FakeImage.created).toHaveLength(1);
    expect(FakeImage.created[0].src).toBe(createdUrls[0]);
    expect(ctx.drawn.length).toBeGreaterThan(0);
  });

  it("two controls showing the same picture share one pull, one blob and one decode", async () => {
    resolveControlProperties.mockResolvedValue({ src: REF_A, opacity: "1" });
    const ctx = fakeCtx();

    await paint(ctx, "ctrl-a", 0);
    await paint(ctx, "ctrl-b", 1);

    // Both controls' metadata was read (they are different controls)...
    expect(resolveControlProperties.mock.calls.length).toBeGreaterThanOrEqual(2);
    // ...but the picture itself was fetched, blobbed and decoded exactly once.
    expect(resolveMediaRef).toHaveBeenCalledTimes(1);
    expect(createdUrls).toHaveLength(1);
    expect(FakeImage.created).toHaveLength(1);
  });

  it("a control that switches to a different picture pulls the new one only", async () => {
    resolveControlProperties.mockResolvedValue({ src: REF_A, opacity: "1" });
    const ctx = fakeCtx();
    await paint(ctx, "ctrl-a", 0);
    expect(resolveMediaRef).toHaveBeenCalledTimes(1);

    resolveControlProperties.mockResolvedValue({ src: REF_B, opacity: "1" });
    invalidateAllImageCaches();
    await paint(ctx, "ctrl-a", 0);

    expect(resolveMediaRef).toHaveBeenCalledTimes(2);
    expect(resolveMediaRef).toHaveBeenLastCalledWith(REF_B);
    // The picture nothing points at any more is released, not kept forever.
    expect(revokedUrls).toContain(createdUrls[0]);
  });

  it("a handle the document cannot resolve says so instead of spinning forever", async () => {
    resolveControlProperties.mockResolvedValue({ src: REF_A, opacity: "1" });
    resolveMediaRef.mockRejectedValueOnce(new Error("This document holds no media"));
    const ctx = fakeCtx();

    await paint(ctx, "ctrl-a", 0);
    await paint(ctx, "ctrl-a", 0);

    // One attempt, not one per frame, and nothing painted.
    expect(resolveMediaRef).toHaveBeenCalledTimes(1);
    expect(ctx.drawn).toHaveLength(0);
  });
});

describe("invalidation does not become a bulk pull", () => {
  it("a theme change re-reads properties but never re-pulls the bytes", async () => {
    resolveControlProperties.mockResolvedValue({ src: REF_A, opacity: "1" });
    const ctx = fakeCtx();
    await paint(ctx, "ctrl-a", 0);
    const pullsBefore = resolveMediaRef.mock.calls.length;
    const propReadsBefore = resolveControlProperties.mock.calls.length;

    // What APPEARANCE_CHANGED / CELLS_UPDATED / a row resize all do.
    invalidateAllImageCaches();
    await paint(ctx, "ctrl-a", 0);

    // The ~70-byte property is re-read (a formula-driven opacity may have moved)...
    expect(resolveControlProperties.mock.calls.length).toBeGreaterThan(propReadsBefore);
    // ...and the megabytes are not. Bytes are immutable under their hash.
    expect(resolveMediaRef.mock.calls.length).toBe(pullsBefore);
    expect(revokedUrls).toHaveLength(0);
  });
});

describe("releasing object URLs", () => {
  it("deleting the last control referencing a picture revokes its blob URL", async () => {
    resolveControlProperties.mockResolvedValue({ src: REF_A, opacity: "1" });
    const ctx = fakeCtx();
    await paint(ctx, "ctrl-a", 0);
    await paint(ctx, "ctrl-b", 1);
    expect(createdUrls).toHaveLength(1);

    // One of two controls goes: the picture is still referenced.
    forgetImageControl("ctrl-a");
    expect(revokedUrls).toHaveLength(0);

    // The last one goes: nothing points at those bytes now.
    forgetImageControl("ctrl-b");
    expect(revokedUrls).toEqual([createdUrls[0]]);
  });

  it("teardown revokes everything, and a later render starts from scratch", async () => {
    resolveControlProperties.mockResolvedValue({ src: REF_A, opacity: "1" });
    const ctx = fakeCtx();
    await paint(ctx, "ctrl-a", 0);

    releaseAllImageMedia();
    expect(revokedUrls).toEqual([createdUrls[0]]);

    await paint(ctx, "ctrl-a", 0);
    expect(resolveMediaRef).toHaveBeenCalledTimes(2);
    expect(createdUrls).toHaveLength(2);
  });
});

describe("asking whether a handle can actually be painted", () => {
  // This is what the placement seam (`api.createPicture` -> the Controls
  // provider) asks before creating a control. A picture created for bytes the
  // document does not hold is a permanent broken-image box the user has to hunt
  // down, produced by an operation that reported success.

  it("answers with the picture's real size when the document holds it", async () => {
    const size = await getMediaNaturalSize(REF_A);
    expect(size).toEqual({ width: 32, height: 32 });
    // And the decode is kept, so the paint that follows does not repeat it.
    expect(FakeImage.created).toHaveLength(1);
  });

  it("refuses a handle this document cannot resolve", async () => {
    resolveMediaRef.mockRejectedValueOnce(new Error("This document holds no media"));
    expect(await getMediaNaturalSize(REF_B)).toBeNull();
  });

  it("refuses anything that is not a handle, without asking the host", async () => {
    for (const bad of [
      "data:image/png;base64,AAAA",
      "https://tracker.example/pixel.gif",
      "C:/Users/someone/logo.png",
      "media:not-a-hash",
      "",
    ]) {
      expect(await getMediaNaturalSize(bad), bad).toBeNull();
    }
    expect(resolveMediaRef).not.toHaveBeenCalled();
  });

  it("shares its resolution with the paint — asking costs no extra pull", async () => {
    resolveControlProperties.mockResolvedValue({ src: REF_A, opacity: "1" });
    await getMediaNaturalSize(REF_A);
    const ctx = fakeCtx();
    await paint(ctx, "ctrl-a", 0);
    expect(resolveMediaRef).toHaveBeenCalledTimes(1);
    expect(createdUrls).toHaveLength(1);
  });
});

describe("the legacy inline corpus still renders", () => {
  it("an inline data URL is painted as-is, with no host round trip", async () => {
    // The host's migration refuses to re-admit an SVG, and leaves it inline
    // rather than destroying a picture the user can see. It must keep painting.
    const svg = "data:image/svg+xml;base64,PHN2Zy8+";
    resolveControlProperties.mockResolvedValue({ src: svg, opacity: "1" });
    const ctx = fakeCtx();

    await paint(ctx, "ctrl-legacy", 0);

    expect(resolveMediaRef).not.toHaveBeenCalled();
    expect(FakeImage.created).toHaveLength(1);
    expect(FakeImage.created[0].src).toBe(svg);
    expect(ctx.drawn.length).toBeGreaterThan(0);
  });
});

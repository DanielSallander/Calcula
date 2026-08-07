//! FILENAME: app/extensions/Controls/__tests__/imageIngress.test.ts
// PURPOSE: Pin the door a picture enters a document through.
// CONTEXT: The shipped Insert > Image had no validation of any kind: a hidden
//          `<input type="file">` in the WebView, `FileReader.readAsDataURL` over
//          the whole file, and the base64 stored verbatim as the control's
//          `src`. Two behaviours made that worse than "unvalidated":
//
//            * a file that failed to DECODE still got embedded — the decode
//              error fell through to a `{ width: 200, height: 150 }` placeholder
//              over bytes already written into the document;
//            * a refusal was invisible, because a menu action's rejected promise
//              reaches nobody (`MenuBar.tsx` calls `item.action()` unawaited).
//
//          So the assertions that matter here are not "the happy path works".
//          They are: a refusal produces NO handle and a VISIBLE reason, and no
//          code path in this extension can any longer turn a file into bytes.

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

const toasts: Array<{ message: string; type?: string }> = [];
const picker = vi.fn();

vi.mock("@api/notifications", () => ({
  showToast: (message: string, options?: { type?: string }) => {
    toasts.push({ message, type: options?.type });
  },
}));

vi.mock("@api/filesystem", () => ({
  importImageViaPicker: (req: unknown) => picker(req),
}));

import {
  pickValidatedImage,
  initialImageSize,
  pictureLayoutSize,
  IMAGE_DISPLAY_MAX_DIM,
  IMAGE_DISPLAY_MIN_DIM,
  UNDECODABLE_PICTURE_BOX,
} from "../Image/imageIngress";
import { isMediaRef, mediaHashOf, isLegacyInlineImage, dataUrlToBlob } from "../Image/mediaRefs";

const HASH = "a".repeat(64);
const REF = `media:${HASH}`;

beforeEach(() => {
  toasts.length = 0;
  picker.mockReset();
});

describe("fresh ingress yields a handle, never bytes", () => {
  it("returns the media handle the host issued, and nothing that looks like a payload", async () => {
    picker.mockResolvedValue({
      ref: REF,
      mimeType: "image/png",
      width: 1200,
      height: 900,
      byteLength: 51_234,
    });

    const media = await pickValidatedImage();

    expect(media).not.toBeNull();
    // This is the whole point: what gets stored is a 70-byte handle.
    expect(media!.ref).toBe(REF);
    expect(isMediaRef(media!.ref)).toBe(true);
    expect(media!.ref.startsWith("data:")).toBe(false);
    expect(media!.ref.length).toBeLessThan(80);
    // Dimensions come from the header the HOST parsed, not from a WebView decode.
    expect(media!.width).toBe(1200);
    expect(media!.height).toBe(900);
    expect(toasts).toHaveLength(0);
  });

  it("uses the NATIVE picker — the host needs a path, not a File object", async () => {
    picker.mockResolvedValue({
      ref: REF,
      mimeType: "image/png",
      width: 10,
      height: 10,
      byteLength: 100,
    });
    await pickValidatedImage();
    expect(picker).toHaveBeenCalledTimes(1);
    expect(picker.mock.calls[0][0]).toMatchObject({ title: expect.any(String) });
  });
});

describe("a refused file creates nothing, and says why", () => {
  it("an over-cap image: no handle, and the host's message with the limit in it", async () => {
    picker.mockRejectedValue(
      new Error("The image is 41231922 bytes; the limit is 8388608 bytes."),
    );

    const media = await pickValidatedImage();

    // No handle means the caller creates no control. Nothing is embedded.
    expect(media).toBeNull();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe("error");
    // The limit is NAMED. "Could not insert image" would throw away the only
    // thing the validation learned.
    expect(toasts[0].message).toContain("41231922");
    expect(toasts[0].message).toContain("8388608");
  });

  it("a non-image: no handle, no placeholder, no 200x150 anything", async () => {
    picker.mockRejectedValue(
      new Error("The file is not a PNG, JPEG, GIF or WebP image."),
    );

    const media = await pickValidatedImage();

    expect(media).toBeNull();
    expect(toasts[0].message).toContain("not a PNG");
  });

  it("a decompression bomb refused on DIMENSIONS is refused just as hard", async () => {
    picker.mockRejectedValue(
      new Error("The image is 30000x30000 pixels; the limit is 12000 per side."),
    );
    expect(await pickValidatedImage()).toBeNull();
    expect(toasts[0].message).toContain("30000x30000");
  });

  it("a handle with impossible dimensions is refused rather than laid out at a guess", async () => {
    // Cannot happen while the host holds its contract. It is asserted because
    // the deleted fallback is exactly how a corrupt file became a control.
    picker.mockResolvedValue({
      ref: REF,
      mimeType: "image/png",
      width: 0,
      height: 0,
      byteLength: 10,
    });

    expect(await pickValidatedImage()).toBeNull();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe("error");
  });

  it("cancelling is not an error: no handle, and no scolding", async () => {
    picker.mockResolvedValue(null);
    expect(await pickValidatedImage()).toBeNull();
    expect(toasts).toHaveLength(0);
  });
});

describe("initial layout size", () => {
  it("scales the longest edge down to the box and keeps the aspect ratio", () => {
    const size = initialImageSize(4000, 2000);
    expect(size.width).toBe(IMAGE_DISPLAY_MAX_DIM);
    expect(size.height).toBe(IMAGE_DISPLAY_MAX_DIM / 2);
  });

  it("leaves a small picture alone", () => {
    expect(initialImageSize(120, 90)).toEqual({ width: 120, height: 90 });
  });

  it("floors a sliver at the minimum so it stays clickable", () => {
    const size = initialImageSize(1, 2000);
    expect(size.height).toBe(IMAGE_DISPLAY_MAX_DIM);
    expect(size.width).toBe(IMAGE_DISPLAY_MIN_DIM);
  });
});

describe("laying out a picture a caller asked to place", () => {
  const natural = { width: 800, height: 400 };

  it("honours both dimensions when both are named", () => {
    expect(pictureLayoutSize({ width: 120, height: 300 }, natural)).toEqual({
      width: 120,
      height: 300,
    });
  });

  it("derives the missing dimension from the real aspect ratio", () => {
    expect(pictureLayoutSize({ width: 200 }, natural)).toEqual({ width: 200, height: 100 });
    expect(pictureLayoutSize({ height: 100 }, natural)).toEqual({ width: 200, height: 100 });
  });

  it("falls back to the natural size, scaled into the standard box", () => {
    expect(pictureLayoutSize({}, { width: 4000, height: 2000 })).toEqual({
      width: IMAGE_DISPLAY_MAX_DIM,
      height: IMAGE_DISPLAY_MAX_DIM / 2,
    });
  });

  it("ignores nonsense dimensions rather than laying a picture out at zero", () => {
    expect(pictureLayoutSize({ width: 0, height: -5 }, natural)).toEqual(
      initialImageSize(natural.width, natural.height),
    );
    expect(pictureLayoutSize({ width: Number.NaN }, natural)).toEqual(
      initialImageSize(natural.width, natural.height),
    );
  });

  it("uses the standard box when the WebView could not decode a picture the host proved", () => {
    // Distinct from the deleted fallback: those bytes ARE a valid image by the
    // host's header check, so placing them is right — only the size is a guess.
    expect(pictureLayoutSize({}, { width: 0, height: 0 })).toEqual({
      ...UNDECODABLE_PICTURE_BOX,
    });
  });
});

describe("what counts as a media handle", () => {
  it("accepts exactly `media:{64 lowercase hex}` and nothing else", () => {
    expect(mediaHashOf(REF)).toBe(HASH);
    for (const bad of [
      "media:" + "A".repeat(64), // uppercase hex
      "media:" + "a".repeat(63), // short
      "media:" + "a".repeat(65), // long
      "media:../../etc/passwd",
      "media:",
      ` media:${HASH}`,
      `${REF}?v=2`,
      `https://tracker.example/pixel.gif`,
      "data:image/png;base64,AAAA",
      "",
    ]) {
      expect(mediaHashOf(bad), bad).toBeNull();
      expect(isMediaRef(bad), bad).toBe(false);
    }
    expect(mediaHashOf(undefined)).toBeNull();
  });

  it("recognises the legacy inline corpus without treating it as a handle", () => {
    expect(isLegacyInlineImage("data:image/png;base64,AAAA")).toBe(true);
    expect(isLegacyInlineImage("data:image/svg+xml;base64,PHN2Zy8+")).toBe(true);
    expect(isLegacyInlineImage(REF)).toBe(false);
    expect(isLegacyInlineImage("data:text/html;base64,AAAA")).toBe(false);
    expect(isMediaRef("data:image/png;base64,AAAA")).toBe(false);
  });

  it("turns a base64 data URL into one typed Blob, and refuses anything else", () => {
    const blob = dataUrlToBlob("data:image/png;base64,AAECAw==");
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe("image/png");
    expect(blob!.size).toBe(4);

    for (const bad of ["", "not a url", "data:image/png,raw", "https://x/y.png"]) {
      expect(dataUrlToBlob(bad), bad).toBeNull();
    }
  });
});

describe("the WebView no longer has a way to turn a file into bytes", () => {
  const controlsDir = path.resolve(__dirname, "..");
  const read = (rel: string) => fs.readFileSync(path.join(controlsDir, rel), "utf8");
  /** Source with comments removed — the files DESCRIBE what was deleted, on
   *  purpose, and a tombstone must not read as the thing it replaced. */
  const codeOf = (rel: string) =>
    read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join("\n");

  it("the extension contains no FileReader, no readAsDataURL and no file input", () => {
    // These are the retired ingress. A grep-shaped assertion is the right shape
    // here: the defect was not a bug inside a function, it was the existence of
    // the function.
    for (const rel of [
      "index.ts",
      "Image/imageIngress.ts",
      "Image/imageRenderer.ts",
      "Image/imageProperties.ts",
      "Image/mediaRefs.ts",
      "lib/controlClipboard.ts",
      "lib/controlContextMenu.ts",
    ]) {
      const code = codeOf(rel);
      expect(code, rel).not.toMatch(/readAsDataURL/);
      expect(code, rel).not.toMatch(/new FileReader/);
      expect(code, rel).not.toMatch(/type\s*=\s*["']file["']/);
    }
  });

  it("insertImage stores the handle, and the 200x150 fallback is gone", () => {
    const code = codeOf("index.ts");
    expect(code).toContain("src: { valueType: \"static\", value: media.ref }");
    expect(code).not.toMatch(/width:\s*200,\s*height:\s*150/);
    expect(code).not.toContain("getImageNaturalSize");
    expect(code).not.toContain("pickImageFile");
  });

  it("the Source property is not a free-text box any more", () => {
    // `src` holds a handle the host issued. As free text it was a documented
    // route to `https://tracker.example/pixel.gif` with the CSP as the only
    // thing in the way.
    const props = read("Image/imageProperties.ts");
    expect(props).toMatch(/key:\s*"src"[\s\S]*?readOnly:\s*true/);
  });
});

describe("the CSP that backs all of this", () => {
  it("img-src still allows exactly `data:` and `blob:` — and that is load-bearing", () => {
    // JSON cannot carry a comment and Tauri's config denies unknown fields, so
    // this test IS the comment on `tauri.conf.json`'s csp line. It is a better
    // one: delete the directive and this goes red.
    //
    //   blob:  the renderer paints resolved media as ONE object URL per picture.
    //   data:  the legacy inline corpus the host refuses to re-admit (SVG, BMP,
    //          over-cap) still renders from its data URL rather than being
    //          destroyed by a migration that could not accept it.
    //
    // Everything NOT listed is the actual protection: `src` is a document
    // property that travels inside .cala and signed .calp packages, so without
    // this CSP a picture property is a tracking beacon that fires on every open.
    const conf = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../../src-tauri/tauri.conf.json"),
        "utf8",
      ),
    );
    for (const key of ["csp", "devCsp"]) {
      const policy: string = conf.app.security[key];
      const imgSrc = policy
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.startsWith("img-src"));
      expect(imgSrc, key).toBe("img-src 'self' data: blob:");
    }
  });
});

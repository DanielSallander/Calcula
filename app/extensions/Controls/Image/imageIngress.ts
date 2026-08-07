//! FILENAME: app/extensions/Controls/Image/imageIngress.ts
// PURPOSE: The ONE door a picture enters a document through, and the decisions
//          made at that door.
// CONTEXT: Split out of `insertImage` so the door can be TESTED. The rules here
//          are the difference between the feature as shipped and the feature as
//          it should have shipped:
//
//            * the bytes are read by the HOST, from a path the user chose in the
//              native dialog — never by the WebView, and never from a `File`
//              object whose contents only the WebView can see;
//            * a refusal is surfaced, verbatim, naming the rule and the limit;
//            * a refusal creates NOTHING. The old path fell back to a 200x150
//              placeholder over a file it had already embedded, so "this is not
//              an image" produced a document containing that not-an-image.
//
//          Everything downstream of `pickValidatedImage` may assume it is
//          holding a handle to bytes the host proved are a picture.

import { showToast } from "@api/notifications";

/** What the door hands back: a handle, and the size its HEADER declared. */
export interface ValidatedImage {
  /** `media:{sha256}` — the document handle. Never bytes, never a path. */
  ref: string;
  /** Pixel width from the file header, as parsed by the host. */
  width: number;
  /** Pixel height from the file header, as parsed by the host. */
  height: number;
}

/** Longest edge, in px, a freshly inserted picture is laid out at. */
export const IMAGE_DISPLAY_MAX_DIM = 400;
/** Shortest edge, in px, so a favicon-sized picture is still grabbable. */
export const IMAGE_DISPLAY_MIN_DIM = 50;

/**
 * Open the native picker and return a validated handle, or null.
 *
 * Null means BOTH "the user cancelled" and "the file was refused" — the two are
 * the same to the caller (create nothing), and they differ for the user in the
 * only way that matters: a refusal has already put the host's reason on screen.
 */
export async function pickValidatedImage(): Promise<ValidatedImage | null> {
  const { importImageViaPicker } = await import("@api/filesystem");

  let media: Awaited<ReturnType<typeof importImageViaPicker>>;
  try {
    media = await importImageViaPicker({ title: "Insert Image" });
  } catch (err) {
    // The host's message already names the rule and the number: "The image is
    // 41231922 bytes; the limit is 8388608 bytes.", "SVG is not embeddable...",
    // "PNG header is malformed...". Passing it through verbatim is the point of
    // having validated at all — flattening it to "could not insert image" would
    // throw away everything the check learned.
    showToast(
      `That file was not inserted: ${err instanceof Error ? err.message : String(err)}`,
      { type: "error", duration: 9000 },
    );
    return null;
  }

  if (!media) return null; // cancelled; not an error and not a control

  // The host only returns a MediaRef for a file it read real dimensions out of,
  // so this cannot fire in normal operation. It is here because the alternative
  // — the deleted `{ width: 200, height: 150 }` fallback — is precisely how a
  // corrupt file used to become a silently wrong control.
  if (
    !Number.isFinite(media.width) ||
    !Number.isFinite(media.height) ||
    media.width <= 0 ||
    media.height <= 0
  ) {
    showToast(
      "That file was not inserted: the host could not determine the image's dimensions.",
      { type: "error", duration: 9000 },
    );
    return null;
  }

  return { ref: media.ref, width: media.width, height: media.height };
}

/**
 * Layout box for a picture the host validated but the WebView could not decode.
 *
 * Not the deleted `{200, 150}` fallback wearing a new name. That one asserted a
 * size for a file NOTHING had managed to read, and embedded it anyway; this one
 * is a layout default for bytes the host has already proved are a picture with a
 * valid header. The difference is whether the thing exists.
 */
export const UNDECODABLE_PICTURE_BOX = { width: 200, height: 150 } as const;

/**
 * The size to place a picture at, for a caller that may have named neither
 * dimension, one, or both.
 *
 * One named dimension gets the other from the picture's real aspect ratio —
 * squashing a logo because the caller only cared about width is the kind of
 * "correct" nobody wants. Neither named: the natural size, scaled into the
 * standard box.
 */
export function pictureLayoutSize(
  asked: { width?: number; height?: number },
  natural: { width: number; height: number },
): { width: number; height: number } {
  const positive = (n: number | undefined): number | null =>
    typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  const askedWidth = positive(asked.width);
  const askedHeight = positive(asked.height);
  const ratio = natural.width > 0 && natural.height > 0 ? natural.height / natural.width : null;

  if (askedWidth !== null && askedHeight !== null) {
    return { width: askedWidth, height: askedHeight };
  }
  if (askedWidth !== null) {
    return {
      width: askedWidth,
      height: ratio ? Math.max(1, Math.round(askedWidth * ratio)) : askedWidth,
    };
  }
  if (askedHeight !== null) {
    return {
      width: ratio ? Math.max(1, Math.round(askedHeight / ratio)) : askedHeight,
      height: askedHeight,
    };
  }
  if (natural.width > 0 && natural.height > 0) {
    return initialImageSize(natural.width, natural.height);
  }
  return { ...UNDECODABLE_PICTURE_BOX };
}

/**
 * Lay a picture out at its header size, scaled into a sane on-grid box.
 *
 * Aspect ratio is preserved on the way down; the minimum is applied afterwards
 * and can break it, deliberately — a 1x2000 sliver still needs to be clickable.
 */
export function initialImageSize(
  width: number,
  height: number,
): { width: number; height: number } {
  let w = width;
  let h = height;
  const longest = Math.max(w, h);
  if (longest > IMAGE_DISPLAY_MAX_DIM) {
    const scale = IMAGE_DISPLAY_MAX_DIM / longest;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  return {
    width: Math.max(w, IMAGE_DISPLAY_MIN_DIM),
    height: Math.max(h, IMAGE_DISPLAY_MIN_DIM),
  };
}

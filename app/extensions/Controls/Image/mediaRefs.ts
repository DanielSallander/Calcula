//! FILENAME: app/extensions/Controls/Image/mediaRefs.ts
// PURPOSE: The one place the FRONTEND decides what a `media:` handle is, and
//          the only base64 decoder in the picture path.
// CONTEXT: An image control's `src` property can hold exactly two things now:
//
//            media:{64 lowercase hex}   the handle the host gives back for bytes
//                                       it read, validated and filed itself
//            data:image/...;base64,...  a LEGACY inline payload from a document
//                                       written by the old, unvalidated ingress
//
//          The second form can only ever be READ. Nothing in this extension
//          writes one any more: `insertImage` hands a PATH to the host and
//          stores the handle that comes back, and the host's load-time migration
//          rewrites every legacy payload it can revalidate. What survives as
//          inline `data:` is exactly the set the current rules refuse to
//          re-admit (an SVG, or something over a cap) — kept rendering rather
//          than deleted, because refusing to migrate a picture must not mean
//          destroying one the user can see.
//
//          The parse is STRICT on purpose. `mediaHashOf` accepts nothing but the
//          exact handle shape, so a handle can never be smuggled into a URL, a
//          path segment, or a `media:` string with a query on the end.

/** Prefix of a media handle. The full form is `media:{sha256}`. */
export const MEDIA_REF_PREFIX = "media:";

/** Anchored, lowercase-hex, exactly 64 digits. Nothing else is a handle. */
const MEDIA_REF_PATTERN = /^media:([0-9a-f]{64})$/;

/** The content hash inside a media handle, or null when this is not one. */
export function mediaHashOf(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const m = MEDIA_REF_PATTERN.exec(value);
  return m ? m[1] : null;
}

/** True when `value` is a well-formed `media:{sha256}` handle. */
export function isMediaRef(value: string | null | undefined): boolean {
  return mediaHashOf(value) !== null;
}

/**
 * True when `value` is a legacy inline image payload.
 *
 * Only used to RECOGNISE the old corpus (so the renderer keeps painting it and
 * the user can be told those pictures are stored the old way). It is never a
 * gate on a write — there is no write path that produces one.
 */
export function isLegacyInlineImage(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("data:image/");
}

/**
 * Turn a `data:{mime};base64,{payload}` URL into a Blob.
 *
 * This exists so a resolved picture becomes ONE object URL keyed by its content
 * hash instead of a multi-megabyte string threaded through caches and DOM
 * attributes. Returns null for anything that is not a base64 data URL, so a
 * malformed host response degrades to "image unavailable" rather than to a
 * thrown exception inside a canvas paint.
 */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  if (typeof dataUrl !== "string") return null;
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) return null;
  const header = dataUrl.slice(5, comma);
  if (!header.endsWith(";base64")) return null;
  const mime = header.slice(0, header.length - ";base64".length) || "application/octet-stream";
  let binary: string;
  try {
    binary = atob(dataUrl.slice(comma + 1));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

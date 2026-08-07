//! FILENAME: app/extensions/Controls/Image/legacyInlineImages.ts
// PURPOSE: Recognise, and report to the user, pictures the host could not
//          migrate out of the old inline format.
// CONTEXT: THE MIGRATION ITSELF IS THE HOST'S. Every `.cala` load decodes each
//          inline `data:image/...` control property, revalidates it under the
//          current rules, files the bytes under their content hash and rewrites
//          the property to a `media:` handle
//          (`app/src-tauri/src/media.rs::migrate_legacy_data_urls`). It is
//          one-way, idempotent — a handle is not a data URL, so re-running it on
//          a migrated document is a no-op — and it deliberately does NOT dirty
//          the document.
//
//          WHY NOT DIRTY. A user who merely opens a file must not be told it
//          changed, and must not be given a "save changes?" prompt they did not
//          cause. The migration is a normalisation of what was already on disk,
//          not an edit. Nothing is lost by leaving the file alone: the rewrite
//          is deterministic and idempotent, so if the user never saves, the next
//          open migrates the same document to the same state. The bytes reach
//          disk on the first save the user actually asks for.
//
//          WHAT REACHES HERE. Anything still holding an inline payload after the
//          load is something the current rules REFUSE to re-admit: an SVG, a
//          BMP, a file over the 8 MB cap, or a malformed header. Those are left
//          exactly as they were rather than dropped — refusing to migrate a
//          picture must never mean destroying one the user can see. They keep
//          rendering from their data URL under the CSP's `img-src ... data:`
//          allowance, while the WRITE door stays shut so no new one can be made.
//          Read tolerance and write strictness are different questions and this
//          answers them differently, on purpose.
//
//          That outcome is worth SAYING rather than only logging: the file on
//          disk is still the old shape and will stay that way, which is exactly
//          the sort of thing a user discovers later, at the worst moment.

import type { ControlEntry } from "../lib/types";
import { isLegacyInlineImage } from "./mediaRefs";

/**
 * The controls in `entries` still holding an inline picture, excluding any this
 * session has already reported.
 *
 * `reported` is MUTATED with the ids returned, which is what makes this safe to
 * call on every reload (a structural undo re-reads the whole sheet): the user is
 * told once per control per session, not once per reload.
 */
export function collectUnmigratedInlineImages(
  entries: ControlEntry[],
  makeId: (sheetIndex: number, row: number, col: number) => string,
  reported: Set<string>,
): string[] {
  const found: string[] = [];
  for (const entry of entries) {
    if (!isLegacyInlineImage(entry.metadata.properties.src?.value)) continue;
    const id = makeId(entry.sheetIndex, entry.row, entry.col);
    if (reported.has(id)) continue;
    reported.add(id);
    found.push(id);
  }
  return found;
}

/**
 * What to tell the user about those pictures.
 *
 * Three things, in order of what they will worry about: nothing was removed,
 * they still display, and here is why they were not converted.
 */
export function legacyInlineImageWarning(count: number): string {
  const noun = count === 1 ? "image is" : "images are";
  return (
    `${count} ${noun} still stored inline in this workbook, the old way. ` +
    "Nothing has been removed and they still display, but this build will not " +
    "re-embed them: SVG and BMP are not embeddable, and the limit is 8 MB per " +
    "image. They stay inline until you replace them with Insert > Image."
  );
}

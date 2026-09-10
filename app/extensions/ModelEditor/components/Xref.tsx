// FILENAME: app/extensions/ModelEditor/components/Xref.tsx
// PURPOSE: The cross-section link. Renders as inline text that navigates the
//          editor to another section (optionally selecting an object there).
// CONTEXT: Before this existed, `setActive` was called in exactly ONE place —
//          the nav map in ModelEditorApp — so every empty state that said
//          "import some under Import" or "add some in the Measures section"
//          was a dead end: prose naming a destination with no way to reach it.
//          Five such states shipped. The standing rule now is that AN EMPTY
//          STATE MAY NOT NAME A DESTINATION IT CANNOT NAVIGATE TO, which is
//          reviewable precisely because there is one navigation call.
//
//          It is a <button>, not an <a>: there is no URL to put in an href
//          (the window loads a fixed /modelEditor.html), and a link with
//          href="#" is a keyboard and screen-reader trap.

import React from "react";
import { ACCENT } from "./editorShared";
import type { SectionId } from "./editorShared";

const xrefStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  margin: 0,
  font: "inherit",
  color: ACCENT,
  cursor: "pointer",
  textDecoration: "underline",
  textUnderlineOffset: 2,
};

export function Xref({
  to,
  select,
  navigate,
  children,
  title,
}: {
  /** The section to move to. */
  to: SectionId;
  /** Optional object to select once there (e.g. a table or measure name). */
  select?: string;
  /** `ctx.navigate` — passed in rather than pulled from a context so that the
   *  diagram, which receives no SectionCtx, can use the same component. */
  navigate: (section: SectionId, selection?: string) => void;
  children: React.ReactNode;
  title?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      style={xrefStyle}
      title={title}
      data-testid={`xref-${to}`}
      onClick={() => navigate(to, select)}
    >
      {children}
    </button>
  );
}

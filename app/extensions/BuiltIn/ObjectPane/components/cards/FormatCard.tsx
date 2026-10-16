//! FILENAME: app/extensions/BuiltIn/ObjectPane/components/cards/FormatCard.tsx
// PURPOSE: The collapsible frame every Format card sits in (Power BI's
//          expandable card): a header button and the card's rows.
// CONTEXT: `data-format-card` is the handle the E2E helper `formatRow(page,
//          cardId, fieldId)` and the unit tests locate a card by. The header
//          is a real <button>: focus on it is focus in the pane, so the
//          object's Delete never fires from here (every Delete door asks
//          `isGridFocused()`, BUG-0125 class).

import React, { useState } from "react";
import { paneStyles } from "../paneStyles";

export interface FormatCardProps {
  id: string;
  title: string;
  children: React.ReactNode;
  /** Start collapsed (default: expanded). */
  collapsed?: boolean;
}

export function FormatCard({ id, title, children, collapsed = false }: FormatCardProps): React.ReactElement {
  const [open, setOpen] = useState(!collapsed);
  return (
    <section style={paneStyles.card} data-format-card={id} aria-label={title}>
      <button
        type="button"
        style={paneStyles.cardHeader}
        aria-expanded={open}
        data-format-card-header={id}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true" style={{ width: 10, display: "inline-block" }}>
          {open ? "▾" : "▸"}
        </span>
        {title}
      </button>
      {open && <div style={paneStyles.cardBody}>{children}</div>}
    </section>
  );
}

/** A small sub-heading inside a card ("Title", "Subtitle", "Shadow"...). */
export function CardGroup({ title }: { title: string }): React.ReactElement {
  return <div style={paneStyles.group}>{title}</div>;
}

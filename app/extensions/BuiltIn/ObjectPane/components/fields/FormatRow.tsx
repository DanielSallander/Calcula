//! FILENAME: app/extensions/BuiltIn/ObjectPane/components/fields/FormatRow.tsx
// PURPOSE: One labelled row of a Format card. When the field is BINDABLE on
//          this object -- the family's provider names a WP-D catalog pointer
//          for it and the object's binding ref is known -- the row's literal
//          editor is wrapped in WP-D's `BindableField`, which adds the fx
//          switch, the formula editor, the resolved value or the error
//          sentence under it, and "Remove binding". WP-C builds no fx editor.
// CONTEXT: The row carries `data-field-id` (the E2E helper `formatRow(page,
//          cardId, fieldId)` locates `[data-format-card] [data-field-id]`) and
//          `data-bindable`. On a subscribed page the fx is disabled with the
//          read-only sentence; the literal editor is disabled by its own field.

import React from "react";
import { BindableField } from "../../../../_shared/components/bindings";
import type { ContainerFieldId } from "@api/visualContainer";
import { useFormatContext } from "../formatContext";
import { paneStyles } from "../paneStyles";

export interface FormatRowProps {
  /** A container field id, or a pane-local id ("geometry.width", "dataFormat.0") for rows that never bind. */
  fieldId: string;
  label: string;
  children: React.ReactNode;
  /** A container field the row may bind; omit for rows that are not container fields. */
  bindable?: ContainerFieldId;
}

/** A plain labelled row (no fx): geometry, data formats, actions. */
export function PlainRow({ fieldId, label, children }: Omit<FormatRowProps, "bindable">): React.ReactElement {
  return (
    <div style={paneStyles.row} data-field-id={fieldId} data-bindable="false">
      <span style={paneStyles.rowLabel} title={label}>
        {label}
      </span>
      <div style={paneStyles.rowBody}>{children}</div>
    </div>
  );
}

export function FormatRow({ fieldId, label, children, bindable }: FormatRowProps): React.ReactElement {
  const ctx = useFormatContext();
  const path = bindable ? ctx.bindingPathOf(bindable) : null;
  const ref = ctx.bindingRef;
  if (!path || !ref) return <PlainRow fieldId={fieldId} label={label}>{children}</PlainRow>;
  return (
    <div style={paneStyles.row} data-field-id={fieldId} data-bindable="true">
      <span style={paneStyles.rowLabel} title={label}>
        {label}
      </span>
      <div style={paneStyles.rowBody}>
        <BindableField
          object={ref}
          path={path}
          label={label}
          literal={children}
          disabledReason={ctx.readOnly ? (ctx.readOnlyReason ?? undefined) : undefined}
        />
      </div>
    </div>
  );
}

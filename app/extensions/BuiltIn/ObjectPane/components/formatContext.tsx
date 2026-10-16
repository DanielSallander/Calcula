//! FILENAME: app/extensions/BuiltIn/ObjectPane/components/formatContext.tsx
// PURPOSE: What every Format card and field row reads: the object, its format
//          snapshot (@api/objectFormat), its binding ref (@api/objectBindings)
//          and the three writes -- commit a field, preview a field, end the
//          preview.
// CONTEXT: Built once per render of the Format tab (FormatTab.tsx), so every
//          row of every card reads the SAME snapshot and commits through the
//          SAME door: `commitObjectFormat` (one undo step, refusals in one
//          toast). A row never writes a literal any other way; a bound row's
//          formula is WP-D's `BindableField`, which writes through
//          `setBinding` / `clearBinding` itself.

import React, { createContext, useContext } from "react";
import type { GridRegion } from "@api/gridOverlays";
import type { ObjectBindingRef } from "@api/objectBindings";
import {
  commitObjectFormat,
  endObjectFormatPreview,
  previewObjectFormat,
  type ObjectFormatProvider,
  type ObjectFormatSnapshot,
} from "@api/objectFormat";
import type { ContainerFieldId, VisualContainerPatch } from "@api/visualContainer";
import { normaliseFieldValue, rowPatch } from "../lib/formatValues";

export interface FormatContextValue {
  region: GridRegion;
  provider: ObjectFormatProvider | null;
  /** Null when no format provider owns the object (geometry rows still show). */
  snapshot: ObjectFormatSnapshot | null;
  /** The object's WP-D binding ref, once known (null: no fx on any row). */
  bindingRef: ObjectBindingRef | null;
  readOnly: boolean;
  readOnlyReason: string | null;
  /** Commit one field (`null` = back to the family default). Unchanged = no write. */
  commitField(id: ContainerFieldId, value: unknown): Promise<void>;
  /** Commit a whole patch (several leaves, one undo step). */
  commitPatch(patch: VisualContainerPatch, label?: string): Promise<void>;
  /** Show one field's value on the object without persisting it. */
  previewField(id: ContainerFieldId, value: unknown): void;
  /** Restore after a preview. */
  endPreview(): void;
  /** The WP-D pointer a field binds to on this object, or null (not bindable). */
  bindingPathOf(id: ContainerFieldId): string | null;
}

const FormatContext = createContext<FormatContextValue | null>(null);

/** Build the context value for one object (pure apart from the seam calls it closes over). */
export function makeFormatContext(args: {
  region: GridRegion;
  provider: ObjectFormatProvider | null;
  snapshot: ObjectFormatSnapshot | null;
  bindingRef: ObjectBindingRef | null;
  readOnly: boolean;
  readOnlyReason: string | null;
}): FormatContextValue {
  const { region, provider, snapshot, readOnly } = args;
  const commitPatch = async (patch: VisualContainerPatch, label?: string): Promise<void> => {
    if (readOnly) return;
    await commitObjectFormat([{ region, patch }], label);
  };
  return {
    ...args,
    commitPatch,
    async commitField(id, value) {
      if (!snapshot || readOnly) {
        endObjectFormatPreview();
        return;
      }
      const patch = rowPatch(snapshot, id, value);
      if (!patch) {
        endObjectFormatPreview();
        return;
      }
      await commitPatch(patch);
    },
    previewField(id, value) {
      if (!snapshot || readOnly) return;
      const v = value === null ? null : normaliseFieldValue(id, value);
      if (v === undefined) return;
      const dot = id.indexOf(".");
      const patch = (dot < 0 ? { [id]: v } : { [id.slice(0, dot)]: { [id.slice(dot + 1)]: v } }) as VisualContainerPatch;
      previewObjectFormat(region, patch);
    },
    endPreview() {
      endObjectFormatPreview();
    },
    bindingPathOf(id) {
      if (!provider?.bindingPath || !snapshot) return null;
      try {
        const path = provider.bindingPath(region, id);
        return typeof path === "string" && path !== "" ? path : null;
      } catch (err) {
        console.error(`[ObjectPane] bindingPath threw for ${region.type} ${id}:`, err);
        return null;
      }
    },
  };
}

export function FormatContextProvider({
  value,
  children,
}: {
  value: FormatContextValue;
  children: React.ReactNode;
}): React.ReactElement {
  return <FormatContext.Provider value={value}>{children}</FormatContext.Provider>;
}

/** The current object's format context (throws outside a Format tab: a programming error). */
export function useFormatContext(): FormatContextValue {
  const ctx = useContext(FormatContext);
  if (!ctx) throw new Error("useFormatContext outside a FormatContextProvider");
  return ctx;
}

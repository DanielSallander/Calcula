//! FILENAME: app/extensions/BuiltIn/ObjectPane/components/FormatTab.tsx
// PURPOSE: The object pane's shared FORMAT tab (Power BI's Format pane): a
//          Visual | General switch. Visual holds the family's own cards
//          (chart elements, the pivot style gallery, slicer items...); General
//          holds the four common cards -- Properties, Title, Effects, Data
//          format. The Visual half is omitted when the family has no cards.
// CONTEXT: Everything is read LIVE: the snapshot (@api/objectFormat
//          `readObjectFormat`) is re-read on every render, and the tab
//          re-renders when a binding changes (@api/objectBindings
//          `onBindingsChanged`), so a value a script, the AI or a cell edit
//          changed shows at once. The object's binding ref is ASYNC (a
//          control's comes from the backend, ruling R5) and is asked once per
//          object. Any preview in progress ends when the object changes or the
//          tab goes away.

import React, { useEffect, useReducer, useState } from "react";
import type { GridRegion } from "@api/gridOverlays";
import { SegmentedTabs } from "@api/layout";
import { onBindingsChanged, type ObjectBindingRef } from "@api/objectBindings";
import {
  OBJECT_FORMAT_NO_PROVIDER,
  endObjectFormatPreview,
  getObjectFormatProvider,
  objectFormatBindingRef,
  readObjectFormat,
  type FormatCardContribution,
} from "@api/objectFormat";
import { FormatContextProvider, makeFormatContext } from "./formatContext";
import { PropertiesCard } from "./cards/PropertiesCard";
import { TitleCard } from "./cards/TitleCard";
import { EffectsCard } from "./cards/EffectsCard";
import { DataFormatCard } from "./cards/DataFormatCard";
import { FormatCard } from "./cards/FormatCard";
import { paneStyles } from "./paneStyles";
import { rememberFormatSection, rememberedFormatSection, type FormatSection } from "../lib/tabMemory";

export interface FormatTabProps {
  region: GridRegion;
  readOnly: boolean;
  readOnlyReason: string | null;
}

const SECTION_TABS = [
  { id: "visual", label: "Visual" },
  { id: "general", label: "General" },
] as const;

function familyVisualCards(region: GridRegion): FormatCardContribution[] {
  const provider = getObjectFormatProvider(region);
  if (!provider?.visualCards) return [];
  try {
    return [...(provider.visualCards(region) ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  } catch (err) {
    console.error(`[ObjectPane] the "${region.type}" format provider's visualCards() threw:`, err);
    return [];
  }
}

export function FormatTab({ region, readOnly, readOnlyReason }: FormatTabProps): React.ReactElement {
  const provider = getObjectFormatProvider(region);
  const [bindingRef, setBindingRef] = useState<ObjectBindingRef | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const regionId = region.id;
  const regionType = region.type;

  // The binding ref, once per object.
  useEffect(() => {
    let live = true;
    setBindingRef(null);
    if (!provider) return;
    void objectFormatBindingRef(region).then((ref) => {
      if (live) setBindingRef(ref);
    });
    return () => {
      live = false;
    };
    // The ref names the OBJECT; a re-publish of the same region keeps it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionId, provider]);

  // A binding changed anywhere: re-read (the snapshot's `bound` and `resolved`).
  useEffect(() => onBindingsChanged(() => rerender()), []);

  // A preview belongs to the object it was shown on.
  useEffect(() => () => endObjectFormatPreview(), [regionId]);

  const visual = familyVisualCards(region);
  const [chosen, setChosen] = useState<FormatSection | null>(() => rememberedFormatSection(regionType));
  const section: FormatSection = visual.length === 0 ? "general" : (chosen ?? "visual");

  const snapshot = provider ? readObjectFormat(region, bindingRef) : null;
  const ctx = makeFormatContext({ region, provider, snapshot, bindingRef, readOnly, readOnlyReason });

  return (
    <FormatContextProvider value={ctx}>
      <div data-testid="object-pane-format" data-format-section={section}>
        {visual.length > 0 && (
          <div style={paneStyles.tabs} data-testid="object-pane-format-sections">
            <SegmentedTabs
              tabs={SECTION_TABS}
              value={section}
              ariaLabel="Format sections"
              testIdPrefix="object-pane-format-"
              onChange={(id) => {
                const next = id === "visual" ? "visual" : "general";
                setChosen(next);
                rememberFormatSection(regionType, next);
              }}
            />
          </div>
        )}
        {!provider && (
          <div style={paneStyles.note} data-testid="object-pane-format-none">
            {OBJECT_FORMAT_NO_PROVIDER}
          </div>
        )}
        {section === "visual" ? (
          visual.map((card) => (
            <FormatCard key={card.id} id={card.id} title={card.title}>
              <card.Component region={region} readOnly={readOnly} readOnlyReason={readOnlyReason} />
            </FormatCard>
          ))
        ) : (
          <>
            <PropertiesCard />
            <TitleCard />
            <EffectsCard />
            <DataFormatCard />
          </>
        )}
      </div>
    </FormatContextProvider>
  );
}

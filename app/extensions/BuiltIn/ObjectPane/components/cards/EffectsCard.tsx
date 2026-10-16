//! FILENAME: app/extensions/BuiltIn/ObjectPane/components/cards/EffectsCard.tsx
// PURPOSE: The Format tab's Effects card: Background (on/off, colour,
//          transparency), Visual border (on/off, colour, rounded corners,
//          width) and Shadow (on/off, colour, transparency, outside/inside,
//          position, blur, distance).
// CONTEXT: Container format (@api/visualContainer), so it stays editable under
//          Lock Objects; which rows show is the family's `capabilities`. The
//          transparency sliders PREVIEW while they drag and commit once at the
//          end; the colour pickers preview while they drag and commit when they
//          close (fields/).

import React from "react";
import { useFormatContext } from "../formatContext";
import { fieldOffered } from "../../lib/formatValues";
import { ColorField } from "../fields/ColorField";
import { NumberField, SliderField } from "../fields/NumberField";
import { SelectField } from "../fields/SelectField";
import { ToggleField } from "../fields/ToggleField";
import { CardGroup, FormatCard } from "./FormatCard";

const SHADOW_OFFSET_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["outside", "Outside"],
  ["inside", "Inside"],
];

const SHADOW_POSITION_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["bottomRight", "Bottom right"],
  ["bottom", "Bottom"],
  ["bottomLeft", "Bottom left"],
  ["right", "Right"],
  ["center", "Center"],
  ["left", "Left"],
  ["topRight", "Top right"],
  ["top", "Top"],
  ["topLeft", "Top left"],
];

export function EffectsCard(): React.ReactElement | null {
  const ctx = useFormatContext();
  const caps = ctx.snapshot?.capabilities;
  if (!caps) return null;
  return (
    <FormatCard id="effects" title="Effects">
      {fieldOffered(caps, "background.show") && (
        <>
          <CardGroup title="Background" />
          <ToggleField fieldId="background.show" label="Background" />
          <ColorField fieldId="background.color" label="Color" />
          {fieldOffered(caps, "background.transparency") && (
            <SliderField fieldId="background.transparency" label="Transparency" suffix="%" />
          )}
        </>
      )}
      {fieldOffered(caps, "border.show") && (
        <>
          <CardGroup title="Visual border" />
          <ToggleField fieldId="border.show" label="Border" />
          <ColorField fieldId="border.color" label="Color" />
          {fieldOffered(caps, "border.radius") && (
            <NumberField fieldId="border.radius" label="Rounded corners" suffix="px" />
          )}
          <NumberField fieldId="border.width" label="Width" suffix="px" />
        </>
      )}
      {fieldOffered(caps, "shadow.show") && (
        <>
          <CardGroup title="Shadow" />
          <ToggleField fieldId="shadow.show" label="Shadow" />
          <ColorField fieldId="shadow.color" label="Color" />
          <SliderField fieldId="shadow.transparency" label="Transparency" suffix="%" />
          <SelectField fieldId="shadow.offset" label="Offset" options={SHADOW_OFFSET_OPTIONS} />
          <SelectField fieldId="shadow.position" label="Position" options={SHADOW_POSITION_OPTIONS} />
          <NumberField fieldId="shadow.blur" label="Blur" suffix="px" />
          <NumberField fieldId="shadow.distance" label="Distance" suffix="px" />
        </>
      )}
    </FormatCard>
  );
}

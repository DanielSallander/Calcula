//! FILENAME: app/extensions/BuiltIn/ObjectPane/components/cards/TitleCard.tsx
// PURPOSE: The Format tab's Title card: Title (on/off, text, heading level,
//          font, size, bold / italic / underline, colour, background,
//          alignment, wrap), Subtitle (the same), Divider (colour, style,
//          width, ignore padding) and Spacing (custom + three distances).
// CONTEXT: Every row is a container field (@api/visualContainer); which rows
//          show is the family's `capabilities`. A family whose title IS the
//          object's identity (`titleText: "identity"`, the floating grid's
//          name) shows the text read-only with "rename it" and a Rename button:
//          the new name goes through the provider's commit of `title.text`,
//          which renames through the family's own validated door -- and the row
//          is never bindable (a formula must not rename an object that
//          formulas refer to by name).

import React from "react";
import { promptAsync } from "@api/dialogs";
import { useFormatContext } from "../formatContext";
import { HEADING_LEVEL_OPTIONS, TITLE_IS_IDENTITY, fieldOffered, literalFieldValue } from "../../lib/formatValues";
import { ColorField } from "../fields/ColorField";
import { FontField } from "../fields/FontField";
import { NumberField } from "../fields/NumberField";
import { SelectField } from "../fields/SelectField";
import { TextBox, TextField } from "../fields/TextField";
import { ToggleField } from "../fields/ToggleField";
import { PlainRow } from "../fields/FormatRow";
import { CardGroup, FormatCard } from "./FormatCard";
import { paneStyles } from "../paneStyles";

const ALIGN_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["left", "Left"],
  ["center", "Center"],
  ["right", "Right"],
];

const LINE_STYLE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["solid", "Solid"],
  ["dashed", "Dashed"],
  ["dotted", "Dotted"],
];

/** The undo label of a rename from the Title card. */
export const TITLE_RENAME_LABEL = "Rename";

function TextStyleRows({ prefix }: { prefix: "title" | "subtitle" }): React.ReactElement {
  const caps = useFormatContext().snapshot?.capabilities;
  // A one-line header (slicer, timeline, floating grid) honours no wrap.
  const wrap = !caps || fieldOffered(caps, `${prefix}.wrap`);
  return (
    <>
      <FontField fieldId={`${prefix}.fontFamily`} label="Font" />
      <NumberField fieldId={`${prefix}.fontSize`} label="Font size" suffix="pt" />
      <ToggleField fieldId={`${prefix}.bold`} label="Bold" />
      <ToggleField fieldId={`${prefix}.italic`} label="Italic" />
      <ToggleField fieldId={`${prefix}.underline`} label="Underline" />
      <ColorField fieldId={`${prefix}.color`} label="Text color" />
      <ColorField fieldId={`${prefix}.background`} label="Background" />
      <SelectField fieldId={`${prefix}.align`} label="Alignment" options={ALIGN_OPTIONS} />
      {wrap && <ToggleField fieldId={`${prefix}.wrap`} label="Wrap text" />}
    </>
  );
}

function IdentityTitleRow(): React.ReactElement | null {
  const ctx = useFormatContext();
  if (!ctx.snapshot) return null;
  const raw = literalFieldValue(ctx.snapshot, "title.text");
  const name = typeof raw === "string" ? raw : "";
  const rename = async (): Promise<void> => {
    const next = await promptAsync("New name", { title: "Rename", defaultValue: name, okLabel: "Rename" });
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed === "" || trimmed === name) return;
    await ctx.commitPatch({ title: { text: trimmed } }, TITLE_RENAME_LABEL);
  };
  return (
    <PlainRow fieldId="title.text" label="Text">
      <div style={paneStyles.inline}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <TextBox value={name} onCommit={() => {}} disabled ariaLabel="Title text" testId="format-title.text" />
        </div>
        <button
          type="button"
          style={paneStyles.smallButton}
          disabled={ctx.readOnly}
          data-testid="format-title-rename"
          onClick={() => void rename()}
        >
          Rename
        </button>
      </div>
      <div style={paneStyles.muted} data-testid="format-title-identity">
        {TITLE_IS_IDENTITY}
      </div>
    </PlainRow>
  );
}

export function TitleCard(): React.ReactElement | null {
  const ctx = useFormatContext();
  const caps = ctx.snapshot?.capabilities;
  if (!caps) return null;
  const custom = ctx.snapshot ? literalFieldValue(ctx.snapshot, "spacing.custom") === true : false;
  return (
    <FormatCard id="title" title="Title">
      {fieldOffered(caps, "title.show") && (
        <>
          <CardGroup title="Title" />
          <ToggleField fieldId="title.show" label="Title" />
          {caps.titleText === "identity" ? (
            <IdentityTitleRow />
          ) : (
            fieldOffered(caps, "title.text") && <TextField fieldId="title.text" label="Text" />
          )}
          <SelectField fieldId="title.headingLevel" label="Heading level" options={HEADING_LEVEL_OPTIONS} />
          <TextStyleRows prefix="title" />
        </>
      )}
      {fieldOffered(caps, "subtitle.show") && (
        <>
          <CardGroup title="Subtitle" />
          <ToggleField fieldId="subtitle.show" label="Subtitle" />
          <TextField fieldId="subtitle.text" label="Text" />
          <TextStyleRows prefix="subtitle" />
        </>
      )}
      {fieldOffered(caps, "divider.show") && (
        <>
          <CardGroup title="Divider" />
          <ToggleField fieldId="divider.show" label="Divider" />
          <ColorField fieldId="divider.color" label="Color" />
          <SelectField fieldId="divider.style" label="Line style" options={LINE_STYLE_OPTIONS} />
          <NumberField fieldId="divider.width" label="Width" suffix="px" />
          <ToggleField fieldId="divider.ignorePadding" label="Ignore padding" />
        </>
      )}
      {fieldOffered(caps, "spacing.custom") && (
        <>
          <CardGroup title="Spacing" />
          <ToggleField fieldId="spacing.custom" label="Custom spacing" />
          {fieldOffered(caps, "spacing.belowTitle") && (
            <NumberField fieldId="spacing.belowTitle" label="Below title" suffix="px" disabled={!custom} />
          )}
          {fieldOffered(caps, "spacing.belowSubtitle") && (
            <NumberField fieldId="spacing.belowSubtitle" label="Below subtitle" suffix="px" disabled={!custom} />
          )}
          {fieldOffered(caps, "spacing.belowDivider") && (
            <NumberField fieldId="spacing.belowDivider" label="Below divider" suffix="px" disabled={!custom} />
          )}
        </>
      )}
    </FormatCard>
  );
}

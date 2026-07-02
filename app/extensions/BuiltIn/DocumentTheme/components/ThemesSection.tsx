//! FILENAME: app/extensions/BuiltIn/DocumentTheme/components/ThemesSection.tsx
//! PURPOSE: "Themes" panel section hosting the theme gallery + theme font picker.
//! CONTEXT: Rendered by the shell's panel system on either surface (ribbon band
//!          or sidebar). The shell owns all group chrome (label below content,
//!          dividers), so this section renders only its controls. The gallery
//!          and font-picker widgets are band-designed dropdown buttons with
//!          their own popovers, so the section is registered with
//!          ribbonPresentation "inline". Replaces the former PageLayoutTab,
//!          which hand-rolled the group wrapper and label.

import React from "react";
import type { PanelSectionProps } from "@api/uiTypes";
import { ControlRow } from "@api/layout";
import { ThemeGallery } from "./ThemeGallery";
import { ThemeFontPicker } from "./ThemeFontPicker";

export function ThemesSection(_props: PanelSectionProps): React.ReactElement {
  return (
    <ControlRow gap={4}>
      <ThemeGallery />
      <ThemeFontPicker />
    </ControlRow>
  );
}

//! FILENAME: app/extensions/BuiltIn/DocumentTheme/components/ThemesSection.tsx
//! PURPOSE: "Themes" panel section hosting the theme gallery + theme font picker.
//! CONTEXT: Rendered by the shell's panel system on either surface (ribbon band
//!          or sidebar). The shell owns all group chrome (cluster card, caption),
//!          so this section renders only its controls: two CommandButton heroes,
//!          each opening its own card popover. In the band that is ONE TALL ROW
//!          of 61px heroes — the first of the two shapes the fill rule allows
//!          (@api/layout tokens.ts) — which is why the section is registered
//!          with ribbonPresentation "inline". In the sidebar the same heroes
//!          render as standard 28px buttons that wrap.
//!
//!          There is deliberately no "Colors" hero: no theme-colours action
//!          exists yet, and a hero with nothing behind it is worse than none.

import React from "react";
import type { PanelSectionProps } from "@api/uiTypes";
import { ControlRow, GAP_XS } from "@api/layout";
import { ThemeGallery } from "./ThemeGallery";
import { ThemeFontPicker } from "./ThemeFontPicker";

export function ThemesSection(_props: PanelSectionProps): React.ReactElement {
  return (
    <ControlRow gap={GAP_XS}>
      <ThemeGallery />
      <ThemeFontPicker />
    </ControlRow>
  );
}

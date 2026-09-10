// FILENAME: app/extensions/ModelEditor/components/diagram/diagramTheme.ts
// PURPOSE: The relationship diagram's palette, resolved from the app skin.
// CONTEXT: This file used to open by explaining that "the Studio original used
//          CSS custom properties; the Model Editor window is a neutral light
//          theme, so we inline the equivalent colors here." THAT PREMISE IS NO
//          LONGER TRUE — the window now stamps the active skin's variables, so
//          the inlined literals would have made the diagram the one surface
//          that stayed light while everything around it went dark, which is
//          worse than either extreme.
//
//          It is still a separate object rather than direct ME.* use, because
//          SVG needs its own vocabulary (node header vs node body vs edge) and
//          the lineage graph will share this vocabulary when the two renderers
//          are given one theme.

import { ME } from "../theme";

export const DIAGRAM_COLORS = {
  bgPrimary: ME.canvas,
  bgSurface: ME.surface,
  bgSurfaceHover: ME.rowHover,
  border: ME.border,
  accent: ME.accent,
  textPrimary: ME.text,
  textSecondary: ME.text2,
  textMuted: ME.text3,
  /** InMemory tables are tinted so storage mode is readable at a glance. */
  inMemoryHeader: ME.accentSoft,
  inMemoryBorder: ME.accent,
};

//! FILENAME: app/src/api/icons/index.ts
// PURPOSE: Barrel for the duotone icon set (@api/icons).
// CONTEXT: Most callers want the one `RibbonIcon` namespace from @api (see
//          ../ribbonIcons.tsx), which spreads the four groups exported here.
//          This barrel additionally exposes the FRAME and the four paint
//          channels, so an extension that must draw a glyph the set does not
//          have (an extension's own affordance) draws it in the same language
//          — 24-unit grid, SOFT/STRONG/ACCENT/DANGER, no literals — through
//          the facade (`@api/icons`) instead of inventing a fifth style.

export {
  IconFrame,
  SOFT,
  STRONG,
  ACCENT,
  DANGER,
  DEFAULT_ICON_SIZE,
  MIN_STROKE,
  line,
} from "./frame";
export type { RibbonIconProps, RibbonIconComponent, IconFrameProps } from "./frame";

export { HOME_ICONS } from "./home";
export { CHART_ICONS } from "./chart";
export { DATA_ICONS } from "./data";
export { GENERIC_ICONS } from "./generic";

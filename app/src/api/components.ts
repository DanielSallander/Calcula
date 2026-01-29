//! FILENAME: app/src/api/components.ts
// PURPOSE: UI components for extensions to use in ribbons and task panes.
// CONTEXT: Extensions building ribbon tabs/groups use these components.

// Ribbon components
export {
  RibbonButton,
  RibbonGroup,
  RibbonSeparator,
  RibbonDropdownButton,
} from "../shell/Ribbon/components";

export type {
  RibbonButtonProps,
  RibbonGroupProps,
  RibbonDropdownButtonProps,
} from "../shell/Ribbon/components";

// Ribbon styles (for custom styling)
export * from "../shell/Ribbon/styles";

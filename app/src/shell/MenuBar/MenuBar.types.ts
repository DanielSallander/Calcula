//! FILENAME: app/src/shell/MenuBar/MenuBar.types.ts
// PURPOSE: Type definitions for the MenuBar component.
// CONTEXT: We now mirror the API types to ensure the Shell renders exactly what Extensions register.

import type { MenuDefinition, MenuItemDefinition } from '../../api/ui';

// Alias the API types for local use. 
// This creates a "Single Source of Truth" - the API.
export type Menu = MenuDefinition;
export type MenuItem = MenuItemDefinition;

// View-specific props (if the MenuBar component needs props)
export interface MenuBarProps {
  className?: string;
}
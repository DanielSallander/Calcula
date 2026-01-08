//FILENAME: app/src/lib/gridRenderer/index.ts
//PURPOSE: Main entry point that exports all gridRenderer functionality
//CONTEXT: This barrel export file maintains backward compatibility with existing imports

// Re-export all types
export type { GridTheme, RenderState } from "./types";
export { DEFAULT_THEME } from "./types";

// Re-export style utilities
export * from "./styles/styleUtils";
export * from "./styles/cellFormatting";

// Re-export layout utilities
export * from "./layout/dimensions";
export * from "./layout/viewport";

// Re-export rendering functions
export * from "./rendering/headers";
export * from "./rendering/grid";
export * from "./rendering/cells";
export * from "./rendering/selection";
export * from "./rendering/references";

// Re-export interaction functions
export * from "./interaction/hitTesting";

// Re-export reference conversion functions
export * from "./references/conversion";

// Re-export main render function
export { renderGrid } from "./core";

// Re-export columnToLetter from types for backward compatibility
export { columnToLetter } from "../../types";
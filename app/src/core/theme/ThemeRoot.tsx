//! FILENAME: app/src/core/theme/ThemeRoot.tsx
import React from "react";
import { initSkinLoader } from "./skinLoader";

interface ThemeRootProps {
  children: React.ReactNode;
}

/**
 * Theme boundary for the React tree. The App Skin system now owns CSS-variable
 * injection via the runtime skinLoader (initialized in main.tsx before first
 * paint). This component is a thin pass-through that also calls initSkinLoader()
 * idempotently as a safety net for entry points that don't run main.tsx's boot
 * sequence (e.g. the standalone script/chart editor windows).
 */
export const ThemeRoot: React.FC<ThemeRootProps> = ({ children }) => {
  initSkinLoader();
  return <>{children}</>;
};

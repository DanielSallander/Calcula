//! FILENAME: app/src/shell/App.tsx
// PURPOSE: Main application shell
// CONTEXT: Provides the root layout and state management

import React from "react";
import { Layout } from "./Layout";
import { GridProvider } from "../core/state/GridContext";
import { ThemeRoot } from "../core/theme/ThemeRoot";

export function App(): React.ReactElement {
  return (
    <ThemeRoot>
      <GridProvider>
        <Layout />
      </GridProvider>
    </ThemeRoot>
  );
}
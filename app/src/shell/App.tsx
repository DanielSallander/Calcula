// FILENAME: shell/App.tsx
// PURPOSE: Main application shell
// CONTEXT: Provides the root layout and state management

import React from "react";
import { Layout } from "./Layout";
import { GridProvider } from "../core/state/GridContext";

export function App(): React.ReactElement {
  return (
    <GridProvider>
      <Layout />
    </GridProvider>
  );
}

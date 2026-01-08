// FILENAME: shell/Layout.tsx
// PURPOSE: Main application layout
// CONTEXT: Arranges menu bar, ribbon, spreadsheet, sheet tabs, and status bar

import React from "react";
import { MenuBar } from "./MenuBar";
import { RibbonContainer } from "./Ribbon/RibbonContainer";
import { Spreadsheet } from "../core/components/Spreadsheet";
import { SheetTabs } from "./SheetTabs";

console.log("[Layout] Module loaded, SheetTabs imported:", SheetTabs);

export function Layout(): React.ReactElement {
  console.log("[Layout] Rendering");
  
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        width: "100vw",
        overflow: "hidden",
        backgroundColor: "#ffffff",
      }}
    >
      {/* Menu Bar */}
      <MenuBar />

      {/* Ribbon Area */}
      <RibbonContainer />

      {/* Spreadsheet Area */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        <Spreadsheet />
      </div>

      {/* Sheet Tabs */}
      <SheetTabs />

      {/* Status Bar */}
      <div
        style={{
          height: "24px",
          backgroundColor: "#217346",
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          fontSize: "12px",
          color: "#ffffff",
        }}
      >
        Ready
      </div>
    </div>
  );
}
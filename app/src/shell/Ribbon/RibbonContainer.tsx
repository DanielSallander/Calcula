//! FILENAME: app/src/shell/Ribbon/RibbonContainer.tsx
// PURPOSE: The ribbon container - renders tabs registered by add-ins
// CONTEXT: This is an empty ribbon shell that add-ins populate via ExtensionRegistry
// REFACTOR: Imports from api layer instead of core internals

import React, { useState, useEffect } from "react";
import { ExtensionRegistry } from "../../api/extensions";
import type { RibbonTabDefinition, RibbonContext } from "../../api/extensions";
import { useGridState } from "../../api/state";

export function RibbonContainer(): React.ReactElement {
  const state = useGridState();
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<RibbonTabDefinition[]>([]);

  // Subscribe to registry changes
  useEffect(() => {
    const updateTabs = () => {
      const registeredTabs = ExtensionRegistry.getRibbonTabs();
      setTabs(registeredTabs);

      setActiveTabId((current) => {
        // If no tabs, clear active
        if (registeredTabs.length === 0) return null;
        // If current tab still exists, keep it
        if (current && registeredTabs.some((t) => t.id === current)) return current;
        // Otherwise select first tab
        return registeredTabs[0].id;
      });
    };

    updateTabs();
    return ExtensionRegistry.onRegistryChange(updateTabs);
  }, []);

  // Build context for ribbon components
  const context: RibbonContext = {
    selection: state.selection,
    // Fix: Derive disabled state from editing (isEditing property does not exist on GridState)
    isDisabled: state.editing !== null,
    executeCommand: async (commandId: string) => {
      const command = ExtensionRegistry.getCommand(commandId);
      if (command) {
        console.log(`[Ribbon] Executing command: ${commandId}`);
      }
    },
    refreshCells: async () => {
      console.log("[Ribbon] Refresh cells requested");
    },
  };

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const groups = activeTabId
    ? ExtensionRegistry.getRibbonGroupsForTab(activeTabId)
    : [];

  return (
    <div
      style={{
        backgroundColor: "#f3f3f3",
        borderBottom: "1px solid #d0d0d0",
      }}
    >
      {/* Tab Headers */}
      <div
        style={{
          display: "flex",
          gap: "4px",
          padding: "4px 8px 0 8px",
          borderBottom: "1px solid #d0d0d0",
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTabId(tab.id)}
            style={{
              padding: "6px 16px",
              border: "none",
              backgroundColor: activeTabId === tab.id ? "#fff" : "transparent",
              borderTopLeftRadius: "4px",
              borderTopRightRadius: "4px",
              cursor: "pointer",
              fontWeight: activeTabId === tab.id ? 600 : 400,
              fontSize: "12px",
              color: "#333",
              fontFamily: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
              borderBottom:
                activeTabId === tab.id ? "1px solid #fff" : "none",
              marginBottom: "-1px",
            }}
          >
            {tab.label}
          </button>
        ))}

        {tabs.length === 0 && (
          <div
            style={{
              padding: "6px 16px",
              color: "#999",
              fontStyle: "italic",
              fontSize: "12px",
            }}
          >
            No tabs registered - add-ins disabled
          </div>
        )}
      </div>

      {/* Tab Content Area - fixed height to prevent grid jumping when tabs change */}
      <div
        style={{
          height: "80px",
          padding: "8px",
          backgroundColor: "#fff",
          display: "flex",
          gap: "16px",
          overflow: "hidden",
        }}
      >
        {groups.length > 0 ? (
          groups.map((group) => (
            <div
              key={group.id}
              style={{
                display: "flex",
                flexDirection: "column",
                borderRight: "1px solid #e0e0e0",
                paddingRight: "16px",
              }}
            >
              <div style={{ flex: 1 }}>
                <group.component context={context} />
              </div>
              <div
                style={{
                  fontSize: "11px",
                  color: "#666",
                  textAlign: "center",
                  marginTop: "4px",
                }}
              >
                {group.label}
              </div>
            </div>
          ))
        ) : activeTab ? (
          <activeTab.component context={context} />
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "100%",
              color: "#999",
              fontStyle: "italic",
              fontSize: "12px",
            }}
          >
            Core mode - ribbon add-ins will appear here when enabled
          </div>
        )}
      </div>
    </div>
  );
}
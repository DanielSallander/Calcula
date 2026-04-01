//! FILENAME: app/src/shell/Ribbon/RibbonContainer.tsx
// PURPOSE: The ribbon container - renders tabs registered by add-ins
// CONTEXT: This is an empty ribbon shell that add-ins populate via ExtensionRegistry
// REFACTOR: Imports from api layer instead of core internals

import React, { useState, useEffect, useRef } from "react";
import { ExtensionRegistry } from "../../api/extensions";
import type { RibbonTabDefinition, RibbonContext } from "../../api/extensions";
import { useGridState } from "../../api/state";

export function RibbonContainer(): React.ReactElement {
  const state = useGridState();
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<RibbonTabDefinition[]>([]);
  const prevTabIdsRef = useRef<Set<string>>(new Set());

  // Subscribe to registry changes
  useEffect(() => {
    const updateTabs = () => {
      const registeredTabs = ExtensionRegistry.getRibbonTabs();
      const prevIds = prevTabIdsRef.current;
      const newIds = new Set(registeredTabs.map((t) => t.id));

      // Detect newly added contextual tabs (e.g. Design tab when pivot selected)
      let newlyAddedTab: RibbonTabDefinition | undefined;
      if (prevIds.size > 0) {
        newlyAddedTab = registeredTabs.find((t) => !prevIds.has(t.id));
      }

      prevTabIdsRef.current = newIds;
      setTabs(registeredTabs);

      setActiveTabId((current) => {
        // Auto-activate contextual tabs: if a new tab appeared after initial
        // load, switch to it. Matches Excel behavior where clicking a pivot
        // auto-switches to the Design tab.
        if (newlyAddedTab) return newlyAddedTab.id;
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
        backgroundColor: "#f5f5f5",
        borderBottom: "1px solid #d0d0d0",
        position: "relative",
        zIndex: 10,
      }}
    >
      {/* Tab Headers - fixed height to prevent layout shift when contextual tabs appear */}
      <div
        style={{
          display: "flex",
          gap: "4px",
          padding: "0 8px",
          borderBottom: "1px solid #d0d0d0",
          height: "30px",
          alignItems: "flex-end",
          overflow: "hidden",
        }}
      >
        {tabs.map((tab) => {
          const isActive = activeTabId === tab.id;
          const accentColor = tab.color;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              style={{
                padding: "6px 16px",
                border: "none",
                backgroundColor: isActive ? "#fff" : "transparent",
                borderTopLeftRadius: "4px",
                borderTopRightRadius: "4px",
                cursor: "pointer",
                fontWeight: isActive ? 600 : 400,
                fontSize: "12px",
                color: accentColor
                  ? isActive ? accentColor : accentColor + "cc"
                  : "#333",
                fontFamily: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
                borderBottom: isActive ? "1px solid #fff" : "none",
                borderTop: accentColor ? `3px solid ${accentColor}` : "none",
                marginBottom: "-1px",
              }}
            >
              {tab.label}
            </button>
          );
        })}

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
          height: "92px",
          padding: "6px 8px",
          backgroundColor: "#fff",
          display: "flex",
          gap: "0",
        }}
      >
        {groups.length > 0 ? (
          groups.map((group, idx) => (
            <div
              key={group.id}
              style={{
                display: "flex",
                flexDirection: "column",
                borderRight: idx < groups.length - 1 ? "1px solid #e5e5e5" : "none",
                paddingLeft: idx === 0 ? "4px" : "10px",
                paddingRight: "10px",
              }}
            >
              <div style={{ flex: 1 }}>
                <group.component context={context} />
              </div>
              <div
                style={{
                  fontSize: "10px",
                  color: "#999",
                  textAlign: "center",
                  marginTop: "2px",
                  textTransform: "uppercase" as const,
                  letterSpacing: "0.5px",
                  fontWeight: 400,
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
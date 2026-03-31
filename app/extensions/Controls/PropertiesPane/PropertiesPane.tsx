//! FILENAME: app/extensions/Controls/PropertiesPane/PropertiesPane.tsx
// PURPOSE: Properties Pane task pane component for editing control properties.
// CONTEXT: Shows when a control is selected in design mode. Supports static and formula values.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { TaskPaneViewProps } from "../../../src/api";
import { PropertyRow } from "./PropertyRow";
import {
  getPropertyDefinitions,
  type ControlPropertyValue,
  type ControlMetadata,
} from "../lib/types";
import {
  getControlMetadata,
  setControlProperty,
} from "../lib/controlApi";
import { listScripts } from "../../ScriptEditor/lib/scriptApi";
import { getShapeDefinition } from "../Shape/shapeCatalog";

// ============================================================================
// Styles
// ============================================================================

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  fontFamily: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
  fontSize: 12,
  backgroundColor: "#f8f9fa",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 12px",
  borderBottom: "1px solid #e0e0e0",
  backgroundColor: "#ffffff",
  flexShrink: 0,
};

const titleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  color: "#1a1a1a",
  letterSpacing: "-0.01em",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#999",
  marginTop: 1,
};

const propertiesListStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
};

const emptyStateStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  color: "#aaa",
  fontSize: 12,
  padding: 24,
  textAlign: "center",
  lineHeight: 1.5,
};

const sectionHeaderStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 11,
  fontWeight: 600,
  color: "#555",
  backgroundColor: "#f0f1f3",
  borderBottom: "1px solid #e0e0e0",
  borderTop: "1px solid #e0e0e0",
  letterSpacing: "0.02em",
  textTransform: "capitalize" as const,
};

// ============================================================================
// Component
// ============================================================================

export const PropertiesPane: React.FC<TaskPaneViewProps> = ({ data }) => {
  const [metadata, setMetadata] = useState<ControlMetadata | null>(null);
  const [scripts, setScripts] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  // Extract cell location from data passed when opening the pane
  const row = (data?.row as number) ?? -1;
  const col = (data?.col as number) ?? -1;
  const sheetIndex = (data?.sheetIndex as number) ?? 0;
  const controlType = (data?.controlType as string) ?? "";

  // Re-read trigger: incremented when external changes (e.g., drag resize) update metadata
  const [reloadTrigger, setReloadTrigger] = useState(0);

  // Listen for external metadata refreshes (e.g., after drag-resize persists new bounds)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.row === row && detail?.col === col) {
        setReloadTrigger((prev) => prev + 1);
      }
    };
    window.addEventListener("controls:metadata-refresh", handler);
    return () => window.removeEventListener("controls:metadata-refresh", handler);
  }, [row, col]);

  // Load control metadata and scripts
  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);

    const load = async () => {
      try {
        const [meta, scriptList] = await Promise.all([
          row >= 0 && col >= 0
            ? getControlMetadata(sheetIndex, row, col)
            : Promise.resolve(null),
          listScripts(),
        ]);
        if (!mountedRef.current) return;
        setMetadata(meta);
        setScripts(scriptList.map((s) => ({ id: s.id, name: s.name })));
      } catch (err) {
        console.error("[Controls] Failed to load properties:", err);
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    };

    load();

    return () => {
      mountedRef.current = false;
    };
  }, [row, col, sheetIndex, reloadTrigger]);

  // Handle property change
  const handlePropertyChange = useCallback(
    async (key: string, valueType: "static" | "formula", value: string) => {
      if (row < 0 || col < 0) return;

      try {
        const updatedMeta = await setControlProperty(
          sheetIndex,
          row,
          col,
          controlType,
          key,
          valueType,
          value,
        );
        if (mountedRef.current) {
          setMetadata(updatedMeta);
        }

        // For visual properties, invalidate the floating cache and trigger redraw
        if (["text", "fill", "color", "borderColor", "fontSize",
             "stroke", "strokeWidth", "textColor", "fontBold", "fontItalic",
             "textAlign", "opacity", "rotation", "shapeType", "src"].includes(key)) {
          window.dispatchEvent(new CustomEvent("controls:invalidate-cache", {
            detail: { sheetIndex, row, col },
          }));
          window.dispatchEvent(new CustomEvent("styles:refresh"));
        }

        // For size properties, notify the floating store so the overlay updates
        if (["width", "height"].includes(key)) {
          window.dispatchEvent(new CustomEvent("controls:bounds-changed", {
            detail: { sheetIndex, row, col },
          }));
        }

        // For embedded toggle, dispatch event so index.ts can handle the mode switch
        if (key === "embedded") {
          window.dispatchEvent(new CustomEvent("controls:embedded-changed", {
            detail: { sheetIndex, row, col, embedded: value === "true" },
          }));
        }
      } catch (err) {
        console.error("[Controls] Failed to set property:", err);
      }
    },
    [row, col, sheetIndex, controlType],
  );

  // Get property definitions for this control type
  const propDefs = getPropertyDefinitions(controlType || metadata?.controlType || "");

  if (row < 0 || col < 0) {
    return (
      <div style={containerStyle}>
        <div style={emptyStateStyle}>
          Select a control in Design Mode to view its properties.
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={emptyStateStyle}>Loading properties...</div>
      </div>
    );
  }

  const typeLabel = (() => {
    if (controlType === "button") return "Button";
    if (controlType === "image") return "Image";
    if (controlType === "shape") {
      const shapeType = metadata?.properties?.shapeType?.value;
      if (shapeType) {
        const shapeDef = getShapeDefinition(shapeType);
        return shapeDef?.label ?? "Shape";
      }
      return "Shape";
    }
    return controlType || metadata?.controlType || "Control";
  })();

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <div>
          <div style={titleStyle}>{typeLabel} Properties</div>
          <div style={subtitleStyle}>
            Cell ({row}, {col})
          </div>
        </div>
      </div>

      {/* Properties list */}
      <div style={propertiesListStyle}>
        {propDefs.length === 0 ? (
          <div style={emptyStateStyle}>No properties available for this control type.</div>
        ) : (
          <>
            {/* Visual properties */}
            <div style={sectionHeaderStyle}>Appearance</div>
            {propDefs
              .filter((d) => d.inputType !== "script" && d.inputType !== "code" && d.inputType !== "boolean")
              .map((def) => (
                <PropertyRow
                  key={def.key}
                  definition={def}
                  value={metadata?.properties[def.key]}
                  scripts={scripts}
                  onChange={handlePropertyChange}
                />
              ))}

            {/* Layout properties */}
            {propDefs.some((d) => d.inputType === "boolean") && (
              <>
                <div style={sectionHeaderStyle}>Layout</div>
                {propDefs
                  .filter((d) => d.inputType === "boolean")
                  .map((def) => (
                    <PropertyRow
                      key={def.key}
                      definition={def}
                      value={metadata?.properties[def.key]}
                      scripts={scripts}
                      onChange={handlePropertyChange}
                    />
                  ))}
              </>
            )}

            {/* Action properties */}
            {propDefs.some((d) => d.inputType === "script" || d.inputType === "code") && (
              <>
                <div style={sectionHeaderStyle}>Actions</div>
                {propDefs
                  .filter((d) => d.inputType === "script" || d.inputType === "code")
                  .map((def) => (
                    <PropertyRow
                      key={def.key}
                      definition={def}
                      value={metadata?.properties[def.key]}
                      scripts={scripts}
                      onChange={handlePropertyChange}
                    />
                  ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};

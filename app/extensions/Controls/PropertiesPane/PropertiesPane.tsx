//! FILENAME: app/extensions/Controls/PropertiesPane/PropertiesPane.tsx
// PURPOSE: Properties Pane task pane component for editing control properties.
// CONTEXT: Shows when a control is selected in design mode. Supports static and formula values.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { TaskPaneViewProps } from "@api";
import { emitAppEvent } from "@api/events";
import { PropertyRow } from "./PropertyRow";
import { CollapsibleSection } from "./CollapsibleSection";
import {
  getPropertyDefinitions,
  type ControlPropertyValue,
  type ControlMetadata,
  type PropertyDefinition,
} from "../lib/types";
import {
  getControlMetadata,
  setControlProperty,
} from "../lib/controlApi";
import { listScripts } from "../../ScriptEditor/lib/scriptApi";
import { getShapeDefinition } from "../Shape/shapeCatalog";
import { getShapeHtmlContent, shapeHasScript } from "../Shape/shapeRenderer";
import { getTemplateCategories, type ShapeTemplate } from "../Shape/shapeTemplateCatalog";

// ============================================================================
// Styles (theme-aware via CSS variables)
// ============================================================================

const v = (token: string) => `var(${token})`;

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  fontFamily: v("--font-family-sans"),
  fontSize: 12,
  backgroundColor: v("--panel-bg"),
  color: v("--text-primary"),
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "12px 14px",
  borderBottom: `1px solid ${v("--border-default")}`,
  backgroundColor: v("--bg-surface"),
  flexShrink: 0,
};

const headerIconStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  backgroundColor: v("--panel-bg"),
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const titleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  color: v("--text-primary"),
  letterSpacing: "-0.01em",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 11,
  color: v("--text-tertiary"),
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
  color: v("--text-disabled"),
  fontSize: 12,
  padding: 24,
  textAlign: "center",
  lineHeight: 1.5,
};

const inlineRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 4,
};

const inlineItemStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  borderBottom: `1px solid ${v("--border-default")}`,
  backgroundColor: v("--bg-surface"),
  flexShrink: 0,
};

const tabBaseStyle: React.CSSProperties = {
  flex: 1,
  padding: "8px 12px",
  fontSize: 11,
  fontWeight: 500,
  textAlign: "center",
  cursor: "pointer",
  border: "none",
  background: "transparent",
  color: v("--text-secondary"),
  transition: "color 0.15s, border-color 0.15s",
  borderBottom: "2px solid transparent",
  fontFamily: v("--font-family-sans"),
};

const tabActiveStyle: React.CSSProperties = {
  color: v("--accent-color"),
  fontWeight: 600,
  borderBottom: `2px solid ${v("--accent-color")}`,
};

const codeTabContentStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  gap: 12,
  flex: 1,
};

const openEditorButtonStyle: React.CSSProperties = {
  padding: "8px 20px",
  backgroundColor: v("--accent-color"),
  color: "#ffffff",
  border: "none",
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: v("--font-family-sans"),
  transition: "background-color 0.15s",
};

const previewFrameStyle: React.CSSProperties = {
  flex: 1,
  border: "none",
  width: "100%",
  backgroundColor: v("--bg-surface"),
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Groups property definitions by their `group` field, preserving definition order.
 * Properties without a group are placed in "General".
 */
function groupProperties(defs: PropertyDefinition[]): Map<string, PropertyDefinition[]> {
  const groups = new Map<string, PropertyDefinition[]>();
  for (const def of defs) {
    const groupName = def.group || "General";
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName)!.push(def);
  }
  return groups;
}

/**
 * Renders a list of property definitions within a group, handling inline pairing.
 */
function renderGroupProperties(
  defs: PropertyDefinition[],
  metadata: ControlMetadata | null,
  scripts: Array<{ id: string; name: string }>,
  handlePropertyChange: (key: string, valueType: "static" | "formula", value: string) => void,
): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < defs.length) {
    const def = defs[i];

    // Check for consecutive inline properties to pair them side-by-side
    if (def.inline && i + 1 < defs.length && defs[i + 1].inline) {
      const nextDef = defs[i + 1];
      elements.push(
        <div key={`inline-${def.key}-${nextDef.key}`} style={inlineRowStyle}>
          <div style={inlineItemStyle}>
            <PropertyRow
              definition={def}
              value={metadata?.properties[def.key]}
              scripts={scripts}
              onChange={handlePropertyChange}
            />
          </div>
          <div style={inlineItemStyle}>
            <PropertyRow
              definition={nextDef}
              value={metadata?.properties[nextDef.key]}
              scripts={scripts}
              onChange={handlePropertyChange}
            />
          </div>
        </div>,
      );
      i += 2;
    } else {
      elements.push(
        <PropertyRow
          key={def.key}
          definition={def}
          value={metadata?.properties[def.key]}
          scripts={scripts}
          onChange={handlePropertyChange}
        />,
      );
      i += 1;
    }
  }

  return elements;
}

// ============================================================================
// Template Card (inline sub-component for Code tab)
// ============================================================================

const TemplateCard: React.FC<{ template: ShapeTemplate; onApply: () => void }> = ({ template, onApply }) => {
  const [hovered, setHovered] = useState(false);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onApply();
  }, [onApply]);

  return (
    <button
      type="button"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 14px",
        cursor: "pointer",
        transition: "background-color 0.1s",
        backgroundColor: hovered ? v("--panel-bg") : "transparent",
        border: "none",
        width: "100%",
        textAlign: "left",
        fontFamily: v("--font-family-sans"),
      }}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{
        position: "relative",
        width: 48,
        height: 32,
        borderRadius: 3,
        border: `1px solid ${v("--border-default")}`,
        overflow: "hidden",
        flexShrink: 0,
        backgroundColor: "#fff",
      }}>
        <div
          dangerouslySetInnerHTML={{ __html: template.previewHtml }}
          style={{
            transform: "scale(0.48)",
            transformOrigin: "top left",
            width: "208%",
            height: "208%",
            pointerEvents: "none",
          }}
        />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: v("--text-primary") }}>{template.name}</div>
        <div style={{ fontSize: 10, color: v("--text-tertiary"), lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{template.description}</div>
      </div>
    </button>
  );
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

  // Tab state (used for shapes — must be declared before any early returns per Rules of Hooks)
  const [activeTab, setActiveTab] = useState<"properties" | "code" | "preview">("properties");

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

      // Capture old value before the change (for shape script notifications)
      const oldValue = metadata?.properties[key]?.value ?? "";

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

        // Notify shape scripts of property changes
        if (controlType === "shape") {
          emitAppEvent("shape:propertyChanged", {
            instanceId: `control-${sheetIndex}-${row}-${col}`,
            key,
            oldValue,
            newValue: value,
          });
        }
      } catch (err) {
        console.error("[Controls] Failed to set property:", err);
      }
    },
    [row, col, sheetIndex, controlType, metadata],
  );

  // Compute control instance ID for script-declared properties
  const instanceId = row >= 0 && col >= 0 ? `control-${sheetIndex}-${row}-${col}` : undefined;

  // Get property definitions for this control type (includes script-declared properties)
  const propDefs = getPropertyDefinitions(controlType || metadata?.controlType || "", instanceId);

  // Must be before early returns (Rules of Hooks)
  const handleOpenScriptEditor = useCallback(() => {
    if (!instanceId) return;
    emitAppEvent("scriptable-objects:edit-script", {
      objectType: "shape",
      instanceId,
      objectName: `Shape (${row}, ${col})`,
    });
  }, [instanceId, row, col]);

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

  const isShape = controlType === "shape";

  // Group properties by their group field
  const groups = groupProperties(propDefs);

  // HTML preview content (for shapes with setHtmlContent)
  const htmlContent = instanceId ? getShapeHtmlContent(instanceId) : undefined;

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <div style={headerIconStyle}>
          <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
            {controlType === "shape" ? (
              <path d="M3 3h10v10H3z" stroke="#4472C4" strokeWidth={1.5} fill="#4472C4" fillOpacity={0.15} rx={1} />
            ) : controlType === "image" ? (
              <path d="M2 4h12v8H2zM5 7a1 1 0 110-2 1 1 0 010 2zM2 12l3-4 2 2 3-3 4 5" stroke="#666" strokeWidth={1.2} fill="none" />
            ) : (
              <rect x={3} y={5} width={10} height={6} rx={2} stroke="#666" strokeWidth={1.2} fill="none" />
            )}
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={titleStyle}>{typeLabel} Properties</span>
            {isShape && instanceId && shapeHasScript(instanceId) && (
              <span style={{
                fontSize: 9,
                fontWeight: 600,
                color: v("--accent-color"),
                backgroundColor: v("--panel-bg"),
                border: `1px solid ${v("--accent-color")}`,
                borderRadius: 3,
                padding: "1px 5px",
                letterSpacing: "0.03em",
              }}>
                JS
              </span>
            )}
          </div>
          <div style={subtitleStyle}>
            Cell ({row}, {col})
          </div>
        </div>
      </div>

      {/* Tab bar (shapes only) */}
      {isShape && (
        <div style={tabBarStyle}>
          <button
            style={{ ...tabBaseStyle, ...(activeTab === "properties" ? tabActiveStyle : {}) }}
            onClick={() => setActiveTab("properties")}
          >
            Properties
          </button>
          <button
            style={{ ...tabBaseStyle, ...(activeTab === "code" ? tabActiveStyle : {}) }}
            onClick={() => setActiveTab("code")}
          >
            Code
          </button>
          <button
            style={{ ...tabBaseStyle, ...(activeTab === "preview" ? tabActiveStyle : {}) }}
            onClick={() => setActiveTab("preview")}
          >
            Preview
          </button>
        </div>
      )}

      {/* Tab content */}
      {(!isShape || activeTab === "properties") && (
        <div style={propertiesListStyle}>
          {propDefs.length === 0 ? (
            <div style={emptyStateStyle}>No properties available for this control type.</div>
          ) : (
            Array.from(groups.entries()).map(([groupName, defs]) => (
              <CollapsibleSection key={groupName} title={groupName} defaultExpanded>
                {renderGroupProperties(defs, metadata, scripts, handlePropertyChange)}
              </CollapsibleSection>
            ))
          )}
        </div>
      )}

      {isShape && activeTab === "code" && (
        <div style={{ flex: 1, overflow: "auto" }}>
          {/* Script editor link */}
          <div style={codeTabContentStyle}>
            <svg width={40} height={40} viewBox="0 0 48 48" fill="none">
              <rect x={4} y={6} width={40} height={36} rx={4} stroke={v("--border-default")} strokeWidth={2} fill="none" />
              <path d="M18 18l-6 6 6 6M30 18l6 6-6 6" stroke={v("--accent-color")} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              <path d="M26 16l-4 16" stroke={v("--text-disabled")} strokeWidth={1.5} strokeLinecap="round" />
            </svg>
            <div style={{ fontSize: 12, color: v("--text-tertiary"), textAlign: "center", lineHeight: 1.5 }}>
              Write custom script or pick a template below
            </div>
            <button
              style={openEditorButtonStyle}
              onClick={handleOpenScriptEditor}
            >
              Open Script Editor
            </button>
          </div>

          {/* Template gallery inline */}
          <div style={{ borderTop: `1px solid ${v("--border-default")}`, padding: "0" }}>
            <div style={{ padding: "8px 14px 4px", fontSize: 11, fontWeight: 600, color: v("--text-secondary"), textTransform: "uppercase" as const, letterSpacing: "0.04em" }}>
              Templates
            </div>
            {getTemplateCategories().map(({ category, templates }) => (
              <div key={category}>
                <div style={{ padding: "6px 14px 2px", fontSize: 10, color: v("--text-tertiary"), fontWeight: 500 }}>{category}</div>
                {templates.map((tpl) => (
                  <TemplateCard
                    key={tpl.id}
                    template={tpl}
                    onApply={() => {
                      if (instanceId) {
                        emitAppEvent("shape:applyTemplate", { instanceId, templateId: tpl.id });
                      }
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {isShape && activeTab === "preview" && (
        <div style={propertiesListStyle}>
          {htmlContent ? (
            <iframe
              style={previewFrameStyle}
              srcDoc={`<!DOCTYPE html><html><head><style>body{margin:0;font-family:'Segoe UI Variable','Segoe UI',sans-serif;font-size:12px;}</style></head><body>${htmlContent}</body></html>`}
              sandbox="allow-scripts"
              title="Shape HTML Preview"
            />
          ) : (
            <div style={emptyStateStyle}>
              No HTML content. Use <code style={{ fontSize: 11 }}>shape.render.setHtmlContent(html)</code> in the shape script to add HTML rendering.
            </div>
          )}
        </div>
      )}
    </div>
  );
};

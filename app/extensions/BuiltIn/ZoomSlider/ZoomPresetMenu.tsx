//! FILENAME: app/extensions/BuiltIn/ZoomSlider/ZoomPresetMenu.tsx
// PURPOSE: Dropdown menu for selecting preset zoom levels.
// CONTEXT: Opens when clicking the zoom percentage label in the status bar.
//          Provides quick access to common zoom levels and a custom zoom input.

import React, { useState, useEffect, useRef, useCallback } from "react";
import { ZOOM_MIN, ZOOM_MAX, ZOOM_PRESETS } from "../../../src/api";

interface ZoomPresetMenuProps {
  currentZoom: number;
  onSelectZoom: (zoom: number) => void;
  onClose: () => void;
  anchorRect: DOMRect;
}

export function ZoomPresetMenu({
  currentZoom,
  onSelectZoom,
  onClose,
  anchorRect,
}: ZoomPresetMenuProps): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);
  const [customValue, setCustomValue] = useState("");
  const [showCustomInput, setShowCustomInput] = useState(false);
  const customInputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    // Use a small timeout to prevent the opening click from immediately closing
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Focus custom input when shown
  useEffect(() => {
    if (showCustomInput && customInputRef.current) {
      customInputRef.current.focus();
      customInputRef.current.select();
    }
  }, [showCustomInput]);

  const handlePresetClick = useCallback(
    (zoom: number) => {
      onSelectZoom(zoom);
      onClose();
    },
    [onSelectZoom, onClose]
  );

  const handleCustomSubmit = useCallback(() => {
    const parsed = parseInt(customValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      const zoomValue = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, parsed / 100));
      onSelectZoom(zoomValue);
      onClose();
    }
  }, [customValue, onSelectZoom, onClose]);

  const handleCustomKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter") {
        handleCustomSubmit();
      } else if (event.key === "Escape") {
        setShowCustomInput(false);
      }
    },
    [handleCustomSubmit]
  );

  // Position menu above the anchor, right-aligned so it doesn't overflow the viewport
  const menuWidth = 160;
  const desiredRight = window.innerWidth - anchorRect.right;
  // Ensure the menu doesn't go off the left edge either
  const clampedRight = Math.max(0, Math.min(desiredRight, window.innerWidth - menuWidth));

  const menuStyle: React.CSSProperties = {
    position: "fixed",
    bottom: window.innerHeight - anchorRect.top + 4,
    right: clampedRight,
    backgroundColor: "#2d2d2d",
    border: "1px solid #555",
    borderRadius: "4px",
    boxShadow: "0 -4px 12px rgba(0, 0, 0, 0.3)",
    zIndex: 10000,
    minWidth: "160px",
    padding: "4px 0",
    color: "#ffffff",
    fontSize: "12px",
  };

  const itemStyle: React.CSSProperties = {
    padding: "6px 16px",
    cursor: "pointer",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    userSelect: "none",
  };

  const activeItemStyle: React.CSSProperties = {
    ...itemStyle,
    backgroundColor: "#217346",
    fontWeight: 600,
  };

  const separatorStyle: React.CSSProperties = {
    height: "1px",
    backgroundColor: "#555",
    margin: "4px 0",
  };

  return (
    <div ref={menuRef} style={menuStyle}>
      {ZOOM_PRESETS.map((preset) => {
        const pct = Math.round(preset * 100);
        const isActive = Math.abs(currentZoom - preset) < 0.005;

        return (
          <div
            key={preset}
            style={isActive ? activeItemStyle : itemStyle}
            onMouseEnter={(e) => {
              if (!isActive) {
                (e.currentTarget as HTMLDivElement).style.backgroundColor = "#3a3a3a";
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                (e.currentTarget as HTMLDivElement).style.backgroundColor = "transparent";
              }
            }}
            onClick={() => handlePresetClick(preset)}
          >
            <span>{pct}%</span>
            {isActive && <span>&#10003;</span>}
          </div>
        );
      })}

      <div style={separatorStyle} />

      {showCustomInput ? (
        <div style={{ padding: "6px 12px", display: "flex", alignItems: "center", gap: "6px" }}>
          <input
            ref={customInputRef}
            type="number"
            min={Math.round(ZOOM_MIN * 100)}
            max={Math.round(ZOOM_MAX * 100)}
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            onKeyDown={handleCustomKeyDown}
            onBlur={handleCustomSubmit}
            style={{
              width: "60px",
              padding: "2px 6px",
              backgroundColor: "#1a1a1a",
              border: "1px solid #666",
              borderRadius: "3px",
              color: "#fff",
              fontSize: "12px",
              outline: "none",
            }}
          />
          <span style={{ opacity: 0.7 }}>%</span>
        </div>
      ) : (
        <div
          style={itemStyle}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLDivElement).style.backgroundColor = "#3a3a3a";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLDivElement).style.backgroundColor = "transparent";
          }}
          onClick={() => {
            setCustomValue(String(Math.round(currentZoom * 100)));
            setShowCustomInput(true);
          }}
        >
          <span>Custom...</span>
        </div>
      )}
    </div>
  );
}

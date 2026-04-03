//! FILENAME: app/extensions/BuiltIn/ZoomSlider/ZoomSliderWidget.tsx
// PURPOSE: Excel-style zoom slider widget for the status bar.
// CONTEXT: Renders a [ - ] ===slider=== [ + ] 100% control.
//          Clicking the percentage opens a preset zoom menu.
//          Uses the public API exclusively (no deep Core imports).

import React, { useState, useCallback, useRef } from "react";
import {
  useGridState,
  useGridDispatch,
  setZoom,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
} from "@api";
import { ZoomPresetMenu } from "./ZoomPresetMenu";

export function ZoomSliderWidget(): React.ReactElement {
  const { zoom } = useGridState();
  const dispatch = useGridDispatch();
  const [showMenu, setShowMenu] = useState(false);
  const percentRef = useRef<HTMLSpanElement>(null);
  const [menuAnchorRect, setMenuAnchorRect] = useState<DOMRect | null>(null);

  const handleZoomChange = useCallback(
    (newZoom: number) => {
      dispatch(setZoom(newZoom));
    },
    [dispatch]
  );

  const handleSliderChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseFloat(event.target.value);
      handleZoomChange(value);
    },
    [handleZoomChange]
  );

  const handleDecrement = useCallback(() => {
    const newZoom = Math.round((zoom - ZOOM_STEP) * 100) / 100;
    handleZoomChange(Math.max(ZOOM_MIN, newZoom));
  }, [zoom, handleZoomChange]);

  const handleIncrement = useCallback(() => {
    const newZoom = Math.round((zoom + ZOOM_STEP) * 100) / 100;
    handleZoomChange(Math.min(ZOOM_MAX, newZoom));
  }, [zoom, handleZoomChange]);

  const handlePercentClick = useCallback(() => {
    if (percentRef.current) {
      setMenuAnchorRect(percentRef.current.getBoundingClientRect());
      setShowMenu((prev) => !prev);
    }
  }, []);

  const handleMenuClose = useCallback(() => {
    setShowMenu(false);
  }, []);

  const zoomPercent = Math.round(zoom * 100);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "4px",
        userSelect: "none",
      }}
    >
      {/* Minus button */}
      <button
        onClick={handleDecrement}
        disabled={zoom <= ZOOM_MIN}
        title="Zoom Out"
        style={{
          background: "none",
          border: "none",
          color: zoom <= ZOOM_MIN ? "rgba(255,255,255,0.3)" : "#ffffff",
          cursor: zoom <= ZOOM_MIN ? "default" : "pointer",
          padding: "0 2px",
          fontSize: "14px",
          lineHeight: "1",
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "18px",
          height: "18px",
          borderRadius: "2px",
        }}
        onMouseEnter={(e) => {
          if (zoom > ZOOM_MIN) {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = "rgba(255,255,255,0.15)";
          }
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
        }}
      >
        -
      </button>

      {/* Slider */}
      <input
        type="range"
        min={ZOOM_MIN}
        max={ZOOM_MAX}
        step={0.01}
        value={zoom}
        onChange={handleSliderChange}
        title={`Zoom: ${zoomPercent}%`}
        style={{
          width: "100px",
          height: "4px",
          cursor: "pointer",
          accentColor: "#ffffff",
          opacity: 0.9,
        }}
      />

      {/* Plus button */}
      <button
        onClick={handleIncrement}
        disabled={zoom >= ZOOM_MAX}
        title="Zoom In"
        style={{
          background: "none",
          border: "none",
          color: zoom >= ZOOM_MAX ? "rgba(255,255,255,0.3)" : "#ffffff",
          cursor: zoom >= ZOOM_MAX ? "default" : "pointer",
          padding: "0 2px",
          fontSize: "14px",
          lineHeight: "1",
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "18px",
          height: "18px",
          borderRadius: "2px",
        }}
        onMouseEnter={(e) => {
          if (zoom < ZOOM_MAX) {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = "rgba(255,255,255,0.15)";
          }
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
        }}
      >
        +
      </button>

      {/* Percentage label (clickable to open preset menu) */}
      <span
        ref={percentRef}
        onClick={handlePercentClick}
        title="Click to select zoom level"
        style={{
          cursor: "pointer",
          minWidth: "40px",
          textAlign: "right",
          fontSize: "12px",
          fontWeight: 500,
          opacity: 0.95,
          borderRadius: "2px",
          padding: "1px 4px",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLSpanElement).style.backgroundColor = "rgba(255,255,255,0.15)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLSpanElement).style.backgroundColor = "transparent";
        }}
      >
        {zoomPercent}%
      </span>

      {/* Preset menu */}
      {showMenu && menuAnchorRect && (
        <ZoomPresetMenu
          currentZoom={zoom}
          onSelectZoom={handleZoomChange}
          onClose={handleMenuClose}
          anchorRect={menuAnchorRect}
        />
      )}
    </div>
  );
}

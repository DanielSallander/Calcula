// FILENAME: core/components/Scrollbar/Scrollbar.tsx
// PURPOSE: Custom scrollbar component for virtual scrolling
// CONTEXT: Renders proportional scrollbars based on used range and virtual bounds
// UPDATED: Excel-like thumb sizing that changes based on content size

import React, { useCallback, useRef, useState, useEffect, useLayoutEffect } from "react";

export interface ScrollbarProps {
  /** Orientation of the scrollbar */
  orientation: "horizontal" | "vertical";
  /** Current scroll position in pixels */
  scrollPosition: number;
  /** Total content size in pixels */
  contentSize: number;
  /** Visible viewport size in pixels */
  viewportSize: number;
  /** Callback when scroll position changes */
  onScroll: (position: number) => void;
  /** Scrollbar track size in pixels (width for vertical, height for horizontal) */
  thickness?: number;
  /** Minimum thumb size in pixels */
  minThumbSize?: number;
}

const SCROLLBAR_THICKNESS = 14;
const MIN_THUMB_SIZE = 20; // Reduced minimum for better visual feedback
const SCROLLBAR_BG = "#f0f0f0";
const THUMB_COLOR = "#c0c0c0";
const THUMB_HOVER_COLOR = "#a0a0a0";
const THUMB_ACTIVE_COLOR = "#808080";

export function Scrollbar({
  orientation,
  scrollPosition,
  contentSize,
  viewportSize,
  onScroll,
  thickness = SCROLLBAR_THICKNESS,
  minThumbSize = MIN_THUMB_SIZE,
}: ScrollbarProps): React.ReactElement | null {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [trackSize, setTrackSize] = useState(0);
  const dragStartRef = useRef<{ position: number; scrollStart: number } | null>(null);

  const isHorizontal = orientation === "horizontal";

  // Measure the actual track size from DOM
  useLayoutEffect(() => {
    const measureTrack = () => {
      if (trackRef.current) {
        const rect = trackRef.current.getBoundingClientRect();
        const size = isHorizontal ? rect.width : rect.height;
        if (size > 0) {
          setTrackSize(size);
        }
      }
    };

    measureTrack();

    // Re-measure on window resize
    window.addEventListener("resize", measureTrack);
    return () => window.removeEventListener("resize", measureTrack);
  }, [isHorizontal]);

  // Re-measure when viewportSize changes (indicates container resize)
  useEffect(() => {
    if (trackRef.current) {
      const rect = trackRef.current.getBoundingClientRect();
      const size = isHorizontal ? rect.width : rect.height;
      if (size > 0) {
        setTrackSize(size);
      }
    }
  }, [viewportSize, isHorizontal]);

  // Calculate scrollbar metrics
  // maxScroll = how much we can scroll (content that extends beyond viewport)
  const maxScroll = Math.max(0, contentSize - viewportSize);

  // If content fits in viewport, don't show scrollbar
  if (maxScroll <= 0) {
    return null;
  }

  // Use measured track size, fall back to a reasonable default
  const effectiveTrackSize = trackSize > 0 ? trackSize : Math.max(100, viewportSize);

  // THUMB SIZE CALCULATION (Excel-like behavior):
  // The thumb represents what fraction of total content is visible.
  // thumbRatio = viewportSize / contentSize
  // - Small content (contentSize ~= viewportSize): thumbRatio ~= 1.0 --> large thumb
  // - Large content (contentSize >> viewportSize): thumbRatio ~= 0.0 --> small thumb (min size)
  const thumbRatio = Math.min(1, viewportSize / contentSize);
  const calculatedThumbSize = thumbRatio * effectiveTrackSize;
  const thumbSize = Math.max(minThumbSize, Math.min(calculatedThumbSize, effectiveTrackSize - 10));

  // THUMB POSITION CALCULATION:
  // The thumb position represents scroll progress through the scrollable range.
  // thumbRange = track space available for thumb movement
  // scrollProgress = scrollPosition / maxScroll (0 to 1)
  const thumbRange = effectiveTrackSize - thumbSize;
  const scrollProgress = maxScroll > 0 ? Math.min(1, Math.max(0, scrollPosition / maxScroll)) : 0;
  const thumbPosition = scrollProgress * thumbRange;

  // Handle thumb drag start
  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const position = isHorizontal ? event.clientX : event.clientY;
      dragStartRef.current = { position, scrollStart: scrollPosition };
      setIsDragging(true);
    },
    [isHorizontal, scrollPosition]
  );

  // Handle track click (jump to position)
  const handleTrackClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!trackRef.current || thumbRange <= 0) return;

      const rect = trackRef.current.getBoundingClientRect();
      const clickPosition = isHorizontal
        ? event.clientX - rect.left
        : event.clientY - rect.top;

      // Calculate where the center of the thumb should be
      const targetThumbCenter = clickPosition - thumbSize / 2;
      const newThumbPosition = Math.max(0, Math.min(thumbRange, targetThumbCenter));
      const newScrollProgress = newThumbPosition / thumbRange;
      const newScrollPosition = newScrollProgress * maxScroll;

      onScroll(Math.max(0, Math.min(maxScroll, newScrollPosition)));
    },
    [isHorizontal, thumbSize, thumbRange, maxScroll, onScroll]
  );

  // Global mouse move and up handlers for dragging
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (event: MouseEvent) => {
      if (!dragStartRef.current || thumbRange <= 0) return;

      const currentPosition = isHorizontal ? event.clientX : event.clientY;
      const delta = currentPosition - dragStartRef.current.position;

      // Convert pixel delta to scroll delta
      // delta pixels on track = (delta / thumbRange) * maxScroll in content
      const scrollDelta = (delta / thumbRange) * maxScroll;
      const newScrollPosition = Math.max(
        0,
        Math.min(maxScroll, dragStartRef.current.scrollStart + scrollDelta)
      );

      onScroll(newScrollPosition);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, isHorizontal, thumbRange, maxScroll, onScroll]);

  // Styles
  const trackStyle: React.CSSProperties = {
    position: "absolute",
    backgroundColor: SCROLLBAR_BG,
    ...(isHorizontal
      ? {
          bottom: 0,
          left: 0,
          right: thickness, // Leave space for corner
          height: thickness,
          cursor: "default",
        }
      : {
          top: 0,
          right: 0,
          bottom: thickness, // Leave space for corner
          width: thickness,
          cursor: "default",
        }),
  };

  const thumbStyle: React.CSSProperties = {
    position: "absolute",
    backgroundColor: isDragging
      ? THUMB_ACTIVE_COLOR
      : isHovered
        ? THUMB_HOVER_COLOR
        : THUMB_COLOR,
    borderRadius: 3,
    transition: isDragging ? "none" : "background-color 0.1s",
    ...(isHorizontal
      ? {
          left: thumbPosition,
          top: 2,
          width: thumbSize,
          height: thickness - 4,
          cursor: "pointer",
        }
      : {
          top: thumbPosition,
          left: 2,
          width: thickness - 4,
          height: thumbSize,
          cursor: "pointer",
        }),
  };

  return (
    <div
      ref={trackRef}
      style={trackStyle}
      onClick={handleTrackClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div
        style={thumbStyle}
        onMouseDown={handleMouseDown}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

/**
 * Corner piece where horizontal and vertical scrollbars meet.
 */
export function ScrollbarCorner({
  size = SCROLLBAR_THICKNESS,
}: {
  size?: number;
}): React.ReactElement {
  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        right: 0,
        width: size,
        height: size,
        backgroundColor: SCROLLBAR_BG,
      }}
    />
  );
}
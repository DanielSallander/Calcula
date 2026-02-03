//! FILENAME: app/src/core/components/Scrollbar/Scrollbar.tsx
// PURPOSE: Custom scrollbar component for virtual scrolling
// CONTEXT: Renders proportional scrollbars based on used range and virtual bounds

import React, { useCallback, useRef, useState, useEffect, useLayoutEffect } from "react";
import * as S from "./Scrollbar.styles";

export interface ScrollbarProps {
  /** Orientation of the scrollbar */
  orientation: "horizontal" | "vertical";
  /** Current scroll position in pixels */
  scrollPosition: number;
  /** Total content size in pixels (The Used Range + Buffer) */
  contentSize: number;
  /** Visible viewport size in pixels */
  viewportSize: number;
  /** Callback when scroll position changes */
  onScroll: (position: number) => void;
  /** Scrollbar track size in pixels (width for vertical, height for horizontal) */
  thickness?: number;
  /** Minimum thumb size in pixels */
  minThumbSize?: number;
  /** Optional custom style for the track */
  style?: React.CSSProperties;
}

const SCROLLBAR_THICKNESS = 14;
const MIN_THUMB_SIZE = 20;

export function Scrollbar({
  orientation,
  scrollPosition,
  contentSize,
  viewportSize,
  onScroll,
  thickness = SCROLLBAR_THICKNESS,
  minThumbSize = MIN_THUMB_SIZE,
  style,
}: ScrollbarProps): React.ReactElement | null {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
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
        setTrackSize(size); // eslint-disable-line react-hooks/set-state-in-effect -- DOM measurement requires effect
      }
    }
  }, [viewportSize, isHorizontal]);

  // Calculate scrollbar metrics
  const maxScroll = Math.max(0, contentSize - viewportSize);

  // Use measured track size, fall back to a reasonable default
  const effectiveTrackSize = trackSize > 0 ? trackSize : Math.max(100, viewportSize);

  // THUMB SIZE CALCULATION
  const thumbRatio = Math.min(1, viewportSize / contentSize);
  const calculatedThumbSize = thumbRatio * effectiveTrackSize;
  const thumbSize = Math.max(minThumbSize, Math.min(calculatedThumbSize, effectiveTrackSize - 10));

  // THUMB POSITION CALCULATION
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

  // Early return AFTER all hooks (Rules of Hooks require hooks to always run)
  if (maxScroll <= 0) {
    return null;
  }

  // Dynamic thumb styles (geometry only)
  // We use inline styles for these specific properties to ensure 
  // high-performance scrolling without generating new classes.
  const dynamicThumbStyle: React.CSSProperties = isHorizontal
    ? {
        left: thumbPosition,
        width: thumbSize,
        height: thickness - 1,
      }
    : {
        top: thumbPosition,
        height: thumbSize,
        width: thickness - 1,
      };

  return (
    <S.Track
      ref={trackRef}
      $isHorizontal={isHorizontal}
      $thickness={thickness}
      onClick={handleTrackClick}
      style={style}
    >
      <S.Thumb
        $isHorizontal={isHorizontal}
        $isDragging={isDragging}
        onMouseDown={handleMouseDown}
        onClick={(e) => e.stopPropagation()}
        style={dynamicThumbStyle}
      />
    </S.Track>
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
  return <S.Corner $size={size} />;
}
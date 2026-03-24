//! FILENAME: app/extensions/FormulaVisualizer/components/PlanEdge.tsx
// PURPOSE: SVG edge connecting child to parent node, with particle animation.

import React, { useEffect, useRef, useState } from "react";
import type { PlanEdgeData } from "../types";
import {
  EDGE_DEFAULT_COLOR,
  EDGE_ACTIVE_COLOR,
  EDGE_DEFAULT_WIDTH,
  EDGE_ACTIVE_WIDTH,
  PARTICLE_RADIUS,
  PARTICLE_DURATION,
} from "../constants";

interface PlanEdgeProps {
  edge: PlanEdgeData;
  /** Whether the child node's evaluation is complete. */
  isChildDone: boolean;
  /** Whether the child just completed (trigger particle animation). */
  justCompleted: boolean;
}

export function PlanEdge({
  edge,
  isChildDone,
  justCompleted,
}: PlanEdgeProps): React.ReactElement {
  const pathRef = useRef<SVGPathElement>(null);
  const [particleProgress, setParticleProgress] = useState<number | null>(null);

  // Compute bezier path: child top-center -> parent bottom-center
  const startX = edge.fromX + edge.fromWidth / 2;
  const startY = edge.fromY; // top of child
  const endX = edge.toX + edge.toWidth / 2;
  const endY = edge.toY + edge.toHeight; // bottom of parent

  const verticalGap = startY - endY;
  const cp1y = startY - verticalGap * 0.4;
  const cp2y = endY + verticalGap * 0.4;

  const pathD = `M ${startX} ${startY} C ${startX} ${cp1y}, ${endX} ${cp2y}, ${endX} ${endY}`;

  const strokeColor = isChildDone ? EDGE_ACTIVE_COLOR : EDGE_DEFAULT_COLOR;
  const strokeWidth = isChildDone ? EDGE_ACTIVE_WIDTH : EDGE_DEFAULT_WIDTH;
  const opacity = isChildDone ? 0.8 : 0.5;

  // Particle animation when child just completed
  useEffect(() => {
    if (!justCompleted || !pathRef.current) return;

    const pathEl = pathRef.current;
    const totalLength = pathEl.getTotalLength();
    const startTime = performance.now();

    let animId: number;
    function animate(now: number) {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / PARTICLE_DURATION);
      setParticleProgress(t);
      if (t < 1) {
        animId = requestAnimationFrame(animate);
      } else {
        setParticleProgress(null);
      }
    }
    animId = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(animId);
      setParticleProgress(null);
    };
  }, [justCompleted]);

  // Compute particle position
  let particleX = 0;
  let particleY = 0;
  if (particleProgress !== null && pathRef.current) {
    const totalLength = pathRef.current.getTotalLength();
    const point = pathRef.current.getPointAtLength(particleProgress * totalLength);
    particleX = point.x;
    particleY = point.y;
  }

  return (
    <g>
      <path
        ref={pathRef}
        d={pathD}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        opacity={opacity}
        style={{ transition: "stroke 0.3s, stroke-width 0.3s, opacity 0.3s" }}
      />
      {particleProgress !== null && (
        <circle
          cx={particleX}
          cy={particleY}
          r={PARTICLE_RADIUS}
          fill={EDGE_ACTIVE_COLOR}
          opacity={0.9}
        />
      )}
    </g>
  );
}

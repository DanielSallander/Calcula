//! FILENAME: app/extensions/Animation/components/icons.tsx
// PURPOSE: Small inline SVG icons for the Animation transport + panel.
import React from "react";

type IconProps = { size?: number; color?: string };

function svg(size: number, children: React.ReactNode): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      {children}
    </svg>
  );
}

export function PlayIcon({ size = 14 }: IconProps): React.ReactElement {
  return svg(size, <path d="M5 3.5v9l7-4.5-7-4.5z" />);
}

export function PauseIcon({ size = 14 }: IconProps): React.ReactElement {
  return svg(size, <path d="M4.5 3h2.5v10H4.5V3zm4.5 0h2.5v10H9V3z" />);
}

export function StopIcon({ size = 14 }: IconProps): React.ReactElement {
  return svg(size, <rect x="4" y="4" width="8" height="8" rx="1" />);
}

export function StepBackIcon({ size = 14 }: IconProps): React.ReactElement {
  return svg(size, <path d="M5 3v10H3.7V3H5zm7 0v10l-6-5 6-5z" />);
}

export function StepFwdIcon({ size = 14 }: IconProps): React.ReactElement {
  return svg(size, <path d="M11 3v10h1.3V3H11zM4 3v10l6-5L4 3z" />);
}

export function FilmIcon({ size = 16 }: IconProps): React.ReactElement {
  return svg(
    size,
    <path d="M2 2h12v12H2V2zm1.5 1.5v2h2v-2h-2zm0 4v2h2v-2h-2zm0 4v0.5h2V11.5h-2zm7-8v2h2v-2h-2zm0 4v2h2v-2h-2zm0 4v0.5h2V11.5h-2zM6 3.5v9h4v-9H6z" />,
  );
}

//! FILENAME: app/src/shell/OverlayContainer.tsx
// PURPOSE: Renders all visible overlays registered via OverlayExtensions.
// CONTEXT: This component subscribes to the overlay registry and renders
// overlay components (dropdowns, popovers, tooltips) dynamically.

import React, { useState, useEffect } from "react";
import { OverlayExtensions } from "../core/extensions/overlayExtensions";

/**
 * Container that renders all visible overlays from the OverlayExtensions registry.
 * Place this component at the root of your layout to enable dynamic overlay rendering.
 */
export function OverlayContainer(): React.ReactElement {
  const [, forceUpdate] = useState({});

  // Subscribe to overlay registry changes
  useEffect(() => {
    return OverlayExtensions.onChange(() => {
      forceUpdate({});
    });
  }, []);

  const visibleOverlays = OverlayExtensions.getVisibleOverlays();

  return (
    <>
      {visibleOverlays.map(({ definition, state }) => {
        const OverlayComponent = definition.component;
        return (
          <OverlayComponent
            key={definition.id}
            onClose={() => OverlayExtensions.hideOverlay(definition.id)}
            data={state.data}
            anchorRect={state.anchorRect}
          />
        );
      })}
    </>
  );
}

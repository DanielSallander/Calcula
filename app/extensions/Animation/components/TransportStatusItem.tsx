//! FILENAME: app/extensions/Animation/components/TransportStatusItem.tsx
// PURPOSE: Compact status-bar transport — a play/pause toggle + live "Frame N/M"
//          readout. Hidden when no driver is configured so it stays out of the way.
import React, { useEffect, useState } from "react";
import { playbackEngine, type EngineState } from "../lib/animationEngine";
import { PlayIcon, PauseIcon } from "./icons";

export function TransportStatusItem(): React.ReactElement | null {
  const [state, setState] = useState<EngineState>(() => playbackEngine.getState());
  useEffect(() => playbackEngine.subscribe(setState), []);

  if (state.frameCount === 0) return null;
  const isPlaying = state.status === "playing";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 4px" }}>
      <button
        title={isPlaying ? "Pause animation" : "Play animation"}
        onClick={() => (isPlaying ? playbackEngine.pause() : playbackEngine.play())}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 18,
          height: 18,
          border: "none",
          borderRadius: 3,
          background: "transparent",
          cursor: "pointer",
          color: "inherit",
        }}
      >
        {isPlaying ? <PauseIcon size={11} /> : <PlayIcon size={11} />}
      </button>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>
        {state.frameLabel ? `${state.frameLabel} · ` : ""}
        {state.frame + 1}/{state.frameCount}
      </span>
    </div>
  );
}

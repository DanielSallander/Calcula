//! FILENAME: app/extensions/FormulaVisualizer/hooks/usePlayback.ts
// PURPOSE: Playback state machine for the formula evaluation animation.

import { useState, useRef, useCallback, useEffect } from "react";
import type { PlaybackStatus } from "../types";
import { SPEED_LEVELS, DEFAULT_SPEED_INDEX } from "../constants";

export interface PlaybackState {
  status: PlaybackStatus;
  currentStep: number;
  speedIndex: number;
}

export interface PlaybackControls {
  state: PlaybackState;
  play: () => void;
  pause: () => void;
  stepForward: () => void;
  stepBack: () => void;
  reset: () => void;
  jumpToEnd: () => void;
  setSpeed: (index: number) => void;
}

export function usePlayback(totalSteps: number): PlaybackControls {
  const [status, setStatus] = useState<PlaybackStatus>("idle");
  const [currentStep, setCurrentStep] = useState(-1);
  const [speedIndex, setSpeedIndex] = useState(DEFAULT_SPEED_INDEX);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentStepRef = useRef(currentStep);
  currentStepRef.current = currentStep;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => clearTimer, [clearTimer]);

  const play = useCallback(() => {
    if (totalSteps === 0) return;
    // If at the end, reset first
    let startStep = currentStepRef.current;
    if (startStep >= totalSteps - 1) {
      startStep = -1;
      setCurrentStep(-1);
    }
    setStatus("playing");
    clearTimer();
    timerRef.current = setInterval(() => {
      setCurrentStep((prev) => {
        const next = prev + 1;
        if (next >= totalSteps) {
          clearTimer();
          setStatus("complete");
          return totalSteps - 1;
        }
        return next;
      });
    }, SPEED_LEVELS[speedIndex]);
  }, [totalSteps, speedIndex, clearTimer]);

  const pause = useCallback(() => {
    clearTimer();
    setStatus("paused");
  }, [clearTimer]);

  const stepForward = useCallback(() => {
    clearTimer();
    setCurrentStep((prev) => {
      const next = prev + 1;
      if (next >= totalSteps) {
        setStatus("complete");
        return totalSteps - 1;
      }
      setStatus("paused");
      return next;
    });
  }, [totalSteps, clearTimer]);

  const stepBack = useCallback(() => {
    clearTimer();
    setCurrentStep((prev) => {
      const next = Math.max(-1, prev - 1);
      setStatus(next < 0 ? "idle" : "paused");
      return next;
    });
  }, [clearTimer]);

  const reset = useCallback(() => {
    clearTimer();
    setCurrentStep(-1);
    setStatus("idle");
  }, [clearTimer]);

  const jumpToEnd = useCallback(() => {
    clearTimer();
    setCurrentStep(totalSteps - 1);
    setStatus("complete");
  }, [totalSteps, clearTimer]);

  const setSpeed = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(SPEED_LEVELS.length - 1, index));
      setSpeedIndex(clamped);
      // If currently playing, restart the timer with new speed
      if (timerRef.current !== null) {
        clearTimer();
        timerRef.current = setInterval(() => {
          setCurrentStep((prev) => {
            const next = prev + 1;
            if (next >= totalSteps) {
              clearTimer();
              setStatus("complete");
              return totalSteps - 1;
            }
            return next;
          });
        }, SPEED_LEVELS[clamped]);
      }
    },
    [totalSteps, clearTimer],
  );

  return {
    state: { status, currentStep, speedIndex },
    play,
    pause,
    stepForward,
    stepBack,
    reset,
    jumpToEnd,
    setSpeed,
  };
}

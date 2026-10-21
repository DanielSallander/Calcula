//! FILENAME: app/extensions/_shared/components/colorPick/useNativeColorPick.ts
// PURPOSE: ONE way to drive an OS colour picker (`<input type="color">`) so a
//          pick is previewed while it moves and COMMITTED exactly once when it
//          closes on a colour.
// CONTEXT: Round 2 (2026-10-16, owner finding G1 "chart background colour does
//          nothing"). Three surfaces had each hand-rolled the picker and each
//          got it wrong in a different way:
//            - a CONTROLLED picker whose React onChange only previewed: React's
//              controlled restore wrote the OLD prop back into the DOM, so the
//              native `change` saw "same colour" and never committed;
//            - a picker that diffed its commit against a DRAFT the preview had
//              already moved to the picked colour, so the diff was empty;
//            - a picker that committed on every `input` (one undo step per drag
//              step).
//          The rules, each pinned by a unit test
//          (`_shared/components/__tests__/useNativeColorPick.test.tsx`):
//          (a) the picker shows LOCAL state, so React's restore keeps the pick;
//          (b) the commit is compared against the colour stored when the pick
//              STARTED (snapshotted on its first `input`), never against `value`
//              at `change` time -- every real caller previews INTO `value`;
//          (c) the same colour ends the pick (`onEnd`), anything else commits;
//          (d) blur ends the preview and never commits; a `change` arriving
//              after such a blur still commits the colour that was picked;
//          (e) N `input` + 1 `change` = N `onStep` + exactly 1 `onCommit`;
//          (f) an external `value` change re-syncs the picker between picks;
//          (g) the native listener is attached once and reads the latest
//              callbacks through a ref.
//          A caller that keeps a separate draft must ALSO build its own commit
//          patch against its STORED value (rule (h) of the P1 spec): the hook's
//          snapshot protects the hook's equality test, not the caller's diff.
//          Lives in `_shared` (a widget hook, not an @api contract).

import type React from "react";
import { useEffect, useRef, useState } from "react";

/** The 6-digit form an `<input type="color">` accepts (it refuses #rgb and
 *  alpha); "#000000" for anything else. */
export function pickerHex(color: string): string {
  const c = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
  if (/^#[0-9a-fA-F]{8}$/.test(c)) return c.slice(0, 7).toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(c)) {
    return ("#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]).toLowerCase();
  }
  return "#000000";
}

export interface NativeColorPickOptions {
  /** The STORED colour (hex) or "" for none/default. The picker shows
   *  pickerHex(value || fallback). */
  value: string;
  /** Shown when value is "" (e.g. the painted container colour). Default "#000000". */
  fallback?: string;
  /** Every `input` step (the OS picker's live report). Preview only -- never a
   *  write. MAY re-render the host with `value` = the stepped colour (every
   *  real caller does); the hook does not care. */
  onStep?: (hex: string) => void;
  /** Once per pick: the native `change`. Not called when the picked hex equals
   *  the colour stored when the pick STARTED (non-empty). */
  onCommit: (hex: string) => void;
  /** The pick ended without a commit (same colour, or blur with no change).
   *  Ends any preview. */
  onEnd?: () => void;
}

export interface NativeColorPickProps {
  ref: React.RefObject<HTMLInputElement>;
  type: "color";
  /** LOCAL state, so React's controlled restore keeps the picked colour. */
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur: () => void;
}

interface PickBase {
  /** pickerHex of the stored colour (or the fallback) when the pick started. */
  hex: string;
  /** The stored colour was "" (none/default): no pick can equal it. */
  empty: boolean;
}

export function useNativeColorPick(o: NativeColorPickOptions): NativeColorPickProps {
  const fallback = o.fallback ?? "#000000";
  const ref = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState(() => pickerHex(o.value || fallback));
  // Bumped when a pick ENDS without a commit, so the picker re-syncs to the
  // stored colour even when the host's `value` did not change (rule (f)).
  const [endTick, setEndTick] = useState(0);

  const latest = useRef(o);
  latest.current = o;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;

  /** A pick has started (an `input` arrived) and has not ended yet. */
  const inFlight = useRef(false);
  /** The comparison base, snapshotted when the pick started (rule (b)). */
  const base = useRef<PickBase | null>(null);
  /** The last `input` step of the pick in flight. */
  const lastStep = useRef<string | null>(null);
  /** The last step of a pick that a BLUR ended: a `change` that arrives after
   *  the blur (an engine that blurs before it reports `change`) commits it,
   *  because by then the picker has re-synced to the stored colour (rule (d)). */
  const blurredStep = useRef<string | null>(null);

  const snapshotBase = (): PickBase => {
    const stored = latest.current.value;
    return { hex: pickerHex(stored || fallbackRef.current), empty: stored === "" };
  };

  const resetPick = (): void => {
    inFlight.current = false;
    base.current = null;
    lastStep.current = null;
  };

  // (a)/(f): follow the stored colour while no pick is in flight.
  useEffect(() => {
    if (!inFlight.current) setShown(pickerHex(o.value || fallback));
  }, [o.value, fallback, endTick]);

  // (b)/(c)/(g): the native `change` (the picker closed on a colour) ends the pick.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onNativeChange = (): void => {
      let hex: string;
      let pickBase: PickBase;
      if (inFlight.current && base.current) {
        hex = lastStep.current ?? el.value;
        pickBase = base.current;
      } else {
        // No `input` before this `change`: nothing has previewed, so the
        // stored colour is `value` right now.
        pickBase = snapshotBase();
        // A blur-ended pick's last step stands in for the picker only while
        // the picker still shows the re-synced STORED colour (the late
        // `change` of that same pick). A picker showing any other colour is
        // a NEW pick, and the remembered step is stale.
        const now = el.value.toLowerCase();
        hex = blurredStep.current !== null && now === pickBase.hex ? blurredStep.current : now;
      }
      hex = hex.toLowerCase();
      blurredStep.current = null;
      resetPick();
      const { onCommit, onEnd } = latest.current;
      if (!pickBase.empty && hex === pickBase.hex) {
        setEndTick((t) => t + 1);
        onEnd?.();
        return;
      }
      setShown(hex);
      onCommit(hex);
    };
    el.addEventListener("change", onNativeChange);
    return () => el.removeEventListener("change", onNativeChange);
  }, []);

  const onChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const hex = e.target.value.toLowerCase();
    // React also reports the native `change` through onChange when the value
    // moved without an `input` before it; the native listener above has
    // already ended that pick, so it is not a step.
    if (e.nativeEvent.type === "change") {
      setShown(hex);
      return;
    }
    if (!inFlight.current) {
      base.current = snapshotBase();
      inFlight.current = true;
      blurredStep.current = null;
    }
    lastStep.current = hex;
    setShown(hex);
    latest.current.onStep?.(hex);
  };

  const onBlur = (): void => {
    if (inFlight.current) blurredStep.current = lastStep.current;
    resetPick();
    setEndTick((t) => t + 1);
    latest.current.onEnd?.();
  };

  return { ref, type: "color", value: shown, onChange, onBlur };
}

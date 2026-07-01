//! FILENAME: app/extensions/Animation/lib/monteCarloStore.ts
// PURPOSE: Accumulator for a Monte Carlo run — the outcome samples plus derived
//          stats/histogram the panel renders. The driver pushes one sample per
//          trial; notifications are rAF-coalesced so 1000s of pushes don't thrash
//          React. Pure stat/histogram helpers are unit-tested.

let samples: number[] = [];
let active = false;
let outcomeLabel = "";
const listeners = new Set<() => void>();
let rafPending = false;

function notify(): void {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    for (const l of listeners) {
      try {
        l();
      } catch (e) {
        console.error("[Animation] monteCarlo listener error", e);
      }
    }
  });
}

/** Begin a run: clear samples, mark active, record the outcome cell label. */
export function mcReset(label = ""): void {
  samples = [];
  active = true;
  outcomeLabel = label;
  notify();
}

/** Record one trial's outcome. */
export function mcPush(value: number): void {
  samples.push(value);
  notify();
}

/** Hide the histogram (a non-Monte-Carlo driver was loaded / cleared). */
export function mcDeactivate(): void {
  active = false;
  samples = [];
  notify();
}

export function mcActive(): boolean {
  return active;
}

export function mcOutcomeLabel(): string {
  return outcomeLabel;
}

export function mcSamples(): readonly number[] {
  return samples;
}

export function mcSubscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export interface McStats {
  count: number;
  mean: number;
  std: number;
  min: number;
  max: number;
  p5: number;
  p95: number;
}

/** Summary stats over the given samples (null when empty). Pure. */
export function computeStats(values: readonly number[]): McStats | null {
  const n = values.length;
  if (n === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const pct = (p: number): number => sorted[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
  return {
    count: n,
    mean,
    std: Math.sqrt(variance),
    min: sorted[0],
    max: sorted[n - 1],
    p5: pct(0.05),
    p95: pct(0.95),
  };
}

/** Fixed-width histogram of the given samples (null when empty). Pure. */
export function computeHistogram(
  values: readonly number[],
  bins = 20,
): { edges: number[]; counts: number[] } | null {
  const n = values.length;
  if (n === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return { edges: [min, max], counts: [n] };
  const b = Math.max(1, Math.floor(bins));
  const width = (max - min) / b;
  const counts = new Array<number>(b).fill(0);
  for (const v of values) {
    let idx = Math.floor((v - min) / width);
    if (idx >= b) idx = b - 1;
    if (idx < 0) idx = 0;
    counts[idx] += 1;
  }
  const edges = Array.from({ length: b + 1 }, (_, i) => min + i * width);
  return { edges, counts };
}

export function mcStats(): McStats | null {
  return computeStats(samples);
}

export function mcHistogram(bins = 20): { edges: number[]; counts: number[] } | null {
  return computeHistogram(samples, bins);
}

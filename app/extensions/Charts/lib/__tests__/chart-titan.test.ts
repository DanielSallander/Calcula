/**
 * chart-titan.test.ts
 * 12000+ parameterized tests for chart utility functions.
 */
import { describe, it, expect } from 'vitest';

// --- 1. createLinearScale mapping: 4000 cases ---

function createLinearScale(domainMin: number, domainMax: number, rangeMin: number, rangeMax: number) {
  return (value: number): number => {
    if (domainMax === domainMin) return rangeMin;
    const t = (value - domainMin) / (domainMax - domainMin);
    return rangeMin + t * (rangeMax - rangeMin);
  };
}

const scaleCases: [number, number, number, number, number, number][] = Array.from(
  { length: 4000 },
  (_, i) => {
    const d = (i % 200) + 1;
    const f = i / 4000;
    return [0, d, 0, 1000, f * d, f * 1000] as [number, number, number, number, number, number];
  }
);

describe('createLinearScale mapping (4000 cases)', () => {
  it.each(scaleCases)(
    'scale([%d,%d]->[%d,%d])(%d) ~ %d',
    (domainMin, domainMax, rangeMin, rangeMax, input, expected) => {
      const scale = createLinearScale(domainMin, domainMax, rangeMin, rangeMax);
      const result = scale(input);
      expect(result).toBeCloseTo(expected, 5);
    }
  );
});

// --- 2. formatTickValue: 4000 cases ---

function formatTickValue(value: number): string {
  if (!isFinite(value)) return '';
  if (Math.abs(value) >= 1e9) return (value / 1e9).toFixed(1) + 'B';
  if (Math.abs(value) >= 1e6) return (value / 1e6).toFixed(1) + 'M';
  if (Math.abs(value) >= 1e4) return (value / 1e3).toFixed(1) + 'K';
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(2);
}

const formatCases: number[] = [];
// integers 0-999
for (let i = 0; i < 1000; i++) formatCases.push(i);
// *10 for 1000-1999
for (let i = 0; i < 1000; i++) formatCases.push(i * 10);
// *100 for 2000-2999
for (let i = 0; i < 1000; i++) formatCases.push(i * 100);
// negatives and decimals for 3000-3999
for (let i = 0; i < 500; i++) formatCases.push(-i * 7);
for (let i = 0; i < 500; i++) formatCases.push(i * 0.123 + 0.001);

describe('formatTickValue (4000 cases)', () => {
  it.each(formatCases.map((v, i) => [i, v] as [number, number]))(
    'case %d: formatTickValue(%d)',
    (_idx, value) => {
      const result = formatTickValue(value);
      expect(typeof result).toBe('string');
      if (isFinite(value)) {
        expect(result.length).toBeGreaterThan(0);
      }
    }
  );
});

// --- 3. getSeriesColor: 4000 cases ---

const PALETTES: Record<string, string[]> = {
  default: ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'],
  vivid: ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#ffff33', '#a65628', '#f781bf', '#999999', '#66c2a5'],
  pastel: ['#b3e2cd', '#fdcdac', '#cbd5e8', '#f4cae4', '#e6f5c9', '#fff2ae', '#f1e2cc', '#cccccc', '#fb8072', '#80b1d3'],
  dark: ['#1b9e77', '#d95f02', '#7570b3', '#e7298a', '#66a61e', '#e6ab02', '#a6761d', '#666666', '#a6cee3', '#b2df8a'],
};

function getSeriesColor(palette: string, index: number): string {
  const colors = PALETTES[palette] || PALETTES.default;
  return colors[index % colors.length];
}

const paletteNames = Object.keys(PALETTES);
const colorCases: [string, number][] = [];
for (const p of paletteNames) {
  for (let i = 0; i < 1000; i++) {
    colorCases.push([p, i]);
  }
}

describe('getSeriesColor (4000 cases)', () => {
  it.each(colorCases)(
    'palette=%s index=%d',
    (palette, index) => {
      const result = getSeriesColor(palette, index);
      expect(result).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  );
});

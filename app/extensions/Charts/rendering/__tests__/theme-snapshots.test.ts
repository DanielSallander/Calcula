//! FILENAME: app/extensions/Charts/rendering/__tests__/theme-snapshots.test.ts
// PURPOSE: Snapshot tests to catch accidental changes to chart theme constants.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CHART_THEME,
  PALETTES,
  PALETTE_NAMES,
  mergeTheme,
  resolveChartTheme,
  getSeriesColor,
} from '../chartTheme';

// ============================================================================
// DEFAULT_CHART_THEME snapshot
// ============================================================================

describe('DEFAULT_CHART_THEME', () => {
  it('matches snapshot', () => {
    expect(DEFAULT_CHART_THEME).toMatchSnapshot();
  });
});

// ============================================================================
// PALETTES snapshots
// ============================================================================

describe('PALETTES', () => {
  it('palette names match snapshot', () => {
    expect(PALETTE_NAMES).toMatchInlineSnapshot(`
      [
        "default",
        "vivid",
        "pastel",
        "ocean",
      ]
    `);
  });

  for (const name of Object.keys(PALETTES)) {
    it(`"${name}" palette matches snapshot`, () => {
      expect(PALETTES[name]).toMatchSnapshot();
    });
  }
});

// ============================================================================
// resolveChartTheme snapshots
// ============================================================================

describe('resolveChartTheme', () => {
  it('with no config returns default theme', () => {
    expect(resolveChartTheme(undefined)).toMatchSnapshot();
  });

  it('with empty theme override returns default theme', () => {
    expect(resolveChartTheme({ theme: {} })).toMatchSnapshot();
  });

  it('with background override', () => {
    expect(resolveChartTheme({ theme: { background: '#000000' } })).toMatchSnapshot();
  });

  it('with multiple overrides', () => {
    expect(
      resolveChartTheme({
        theme: {
          background: '#1a1a2e',
          plotBackground: '#16213e',
          titleColor: '#e94560',
          gridLineColor: '#333333',
          titleFontSize: 18,
          labelFontSize: 12,
        },
      }),
    ).toMatchSnapshot();
  });
});

// ============================================================================
// mergeTheme snapshots
// ============================================================================

describe('mergeTheme', () => {
  it('with undefined overrides returns base unchanged', () => {
    expect(mergeTheme(DEFAULT_CHART_THEME, undefined)).toMatchSnapshot();
  });

  it('with partial overrides merges correctly', () => {
    expect(
      mergeTheme(DEFAULT_CHART_THEME, {
        barBorderRadius: 8,
        barGap: 4,
        fontFamily: 'monospace',
      }),
    ).toMatchSnapshot();
  });
});

// ============================================================================
// getSeriesColor snapshots
// ============================================================================

describe('getSeriesColor', () => {
  it('returns override when provided', () => {
    expect(getSeriesColor('default', 0, '#ff0000')).toMatchInlineSnapshot(`"#ff0000"`);
  });

  it('cycles through default palette', () => {
    const colors = Array.from({ length: 10 }, (_, i) => getSeriesColor('default', i, null));
    expect(colors).toMatchSnapshot();
  });

  it('falls back to default palette for unknown palette name', () => {
    expect(getSeriesColor('nonexistent', 0, null)).toMatchInlineSnapshot(`"#4E79A7"`);
  });
});

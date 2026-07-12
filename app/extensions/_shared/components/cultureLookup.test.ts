//! FILENAME: app/extensions/_shared/components/cultureLookup.test.ts
// PURPOSE: Unit tests for the culture resolution + translation lookup helpers.

import { describe, it, expect } from 'vitest';
import { resolveCulture, buildCultureLookup, type BiCultureInfo } from './cultureLookup';

const CULTURES: BiCultureInfo[] = [
  {
    locale: 'sv-SE',
    tables: [{ object: 'Sales', displayName: 'Försäljning', description: 'Faktatabell' }],
    columns: [
      { object: 'Sales[amount]', displayName: 'Belopp', description: 'Radbelopp' },
      { object: 'Sales[qty]', displayName: null, description: 'Antal enheter' },
    ],
    measures: [{ object: 'Revenue', displayName: 'Intäkter' }],
  },
  {
    locale: 'de-DE',
    tables: [],
    columns: [],
    measures: [{ object: 'Revenue', displayName: 'Umsatz' }],
  },
];

describe('resolveCulture', () => {
  it('returns null with no locale or no cultures', () => {
    expect(resolveCulture(CULTURES, null)).toBeNull();
    expect(resolveCulture(CULTURES, undefined)).toBeNull();
    expect(resolveCulture(CULTURES, '')).toBeNull();
    expect(resolveCulture([], 'sv-SE')).toBeNull();
    expect(resolveCulture(undefined, 'sv-SE')).toBeNull();
  });

  it('matches the exact locale case-insensitively', () => {
    expect(resolveCulture(CULTURES, 'sv-SE')?.locale).toBe('sv-SE');
    expect(resolveCulture(CULTURES, 'SV-se')?.locale).toBe('sv-SE');
    expect(resolveCulture(CULTURES, ' de-de ')?.locale).toBe('de-DE');
  });

  it('falls back to a language-prefix match', () => {
    // sv-FI has no exact culture; the sv-SE culture serves all "sv" locales.
    expect(resolveCulture(CULTURES, 'sv-FI')?.locale).toBe('sv-SE');
    expect(resolveCulture(CULTURES, 'sv')?.locale).toBe('sv-SE');
    expect(resolveCulture(CULTURES, 'de-AT')?.locale).toBe('de-DE');
  });

  it('prefers the exact match over a prefix match', () => {
    const withBoth: BiCultureInfo[] = [
      { locale: 'sv-FI', tables: [], columns: [], measures: [] },
      ...CULTURES,
    ];
    expect(resolveCulture(withBoth, 'sv-SE')?.locale).toBe('sv-SE');
    expect(resolveCulture(withBoth, 'sv-FI')?.locale).toBe('sv-FI');
  });

  it('returns null for a locale with no matching culture', () => {
    expect(resolveCulture(CULTURES, 'fr-FR')).toBeNull();
  });
});

describe('buildCultureLookup', () => {
  const lookup = buildCultureLookup(CULTURES[0]);

  it('returns nulls for a missing culture', () => {
    const empty = buildCultureLookup(null);
    expect(empty.table('Sales')).toBeNull();
    expect(empty.column('Sales', 'amount')).toBeNull();
    expect(empty.columnDescription('Sales', 'amount')).toBeNull();
    expect(empty.measure('Revenue')).toBeNull();
  });

  it('translates tables, columns, and measures case-insensitively', () => {
    expect(lookup.table('Sales')).toBe('Försäljning');
    expect(lookup.table('SALES')).toBe('Försäljning');
    expect(lookup.column('sales', 'AMOUNT')).toBe('Belopp');
    expect(lookup.measure('revenue')).toBe('Intäkter');
  });

  it('returns null for untranslated objects', () => {
    expect(lookup.table('Customer')).toBeNull();
    expect(lookup.column('Sales', 'region')).toBeNull();
    expect(lookup.measure('Units')).toBeNull();
  });

  it('translates column descriptions independently of display names', () => {
    expect(lookup.columnDescription('Sales', 'amount')).toBe('Radbelopp');
    // qty has a description but no display name.
    expect(lookup.column('Sales', 'qty')).toBeNull();
    expect(lookup.columnDescription('Sales', 'qty')).toBe('Antal enheter');
  });
});

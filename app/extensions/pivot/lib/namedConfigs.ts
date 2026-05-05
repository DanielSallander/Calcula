//! FILENAME: app/extensions/Pivot/lib/namedConfigs.ts
// PURPOSE: CRUD operations for named pivot layout configs.
// CONTEXT: Stored in localStorage for now; future integration with .calp publish format.

const STORAGE_KEY = 'calcula.pivot.namedConfigs';

/** A saved pivot layout configuration. */
export interface NamedPivotConfig {
  name: string;
  dslText: string;
  createdAt: number;
  updatedAt: number;
  /** Optional pivot ID this config was created from. */
  pivotId?: number;
}

/** Load all named configs from localStorage. */
export function loadNamedConfigs(): NamedPivotConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as NamedPivotConfig[];
  } catch {
    return [];
  }
}

/** Save a named config. Creates new or updates existing (by name). */
export function saveNamedConfig(config: Omit<NamedPivotConfig, 'createdAt' | 'updatedAt'> & { createdAt?: number }): void {
  const configs = loadNamedConfigs();
  const now = Date.now();
  const existing = configs.findIndex(c => c.name === config.name);

  if (existing >= 0) {
    configs[existing] = {
      ...configs[existing],
      ...config,
      updatedAt: now,
    };
  } else {
    configs.push({
      ...config,
      createdAt: now,
      updatedAt: now,
    });
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
}

/** Delete a named config by name. */
export function deleteNamedConfig(name: string): void {
  const configs = loadNamedConfigs().filter(c => c.name !== name);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
}

/** Get a specific named config by name. */
export function getNamedConfig(name: string): NamedPivotConfig | undefined {
  return loadNamedConfigs().find(c => c.name === name);
}

/** Common pivot layout templates. */
export const PIVOT_TEMPLATES: { name: string; description: string; dslText: string }[] = [
  {
    name: 'Basic Summary',
    description: 'Simple rows and values layout',
    dslText: `ROWS:    \nVALUES:  \nLAYOUT:  compact`,
  },
  {
    name: 'Cross-Tab',
    description: 'Rows vs columns comparison',
    dslText: `ROWS:    \nCOLUMNS: \nVALUES:  \nLAYOUT:  tabular`,
  },
  {
    name: 'Year-over-Year',
    description: 'Time-based comparison with date grouping',
    dslText: `ROWS:    \nCOLUMNS: .group(years, quarters)\nVALUES:  \nLAYOUT:  tabular, repeat-labels`,
  },
  {
    name: 'Detailed Report',
    description: 'Tabular layout with repeat labels, no totals',
    dslText: `ROWS:    \nVALUES:  \nLAYOUT:  tabular, repeat-labels, no-grand-totals`,
  },
  {
    name: 'Top 10 Analysis',
    description: 'Ranked top items',
    dslText: `ROWS:    \nVALUES:  \nTOP 10 BY \nLAYOUT:  compact`,
  },
];

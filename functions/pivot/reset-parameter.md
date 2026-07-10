# Reset Parameter

The **reset** parameter controls when a window function restarts its calculation. It partitions the row axis so that each partition is computed independently.

## Syntax

The reset parameter is the last (optional) argument in window functions:

```
RUNNINGSUM(field, reset)
MOVINGAVERAGE(field, window, reset)
PREVIOUS(field, steps, reset)
NEXT(field, steps, reset)
FIRST(field, reset)
LAST(field, reset)
```

## Reset Values

| Value | Mode | Description |
|-------|------|-------------|
| `NONE` or `0` | Default | No reset. The entire axis is one partition. |
| `HIGHESTPARENT` or `1` | Absolute | Reset at the outermost (top-level) group. |
| `LOWESTPARENT` or `-1` | Relative | Reset at the immediate parent group. |
| Positive integer N | Absolute | Reset at depth level N (1 = top, 2 = second level, etc.). N greater than the number of fields on the axis is an error. |
| Negative integer -N | Relative | Reset N levels above the current row's level. |
| Field name | Absolute | Reset at the level of the named field (must be a field on the axis). |

Anything else — a misspelled keyword or a field name that is not on the axis —
is a **hard error**: the calculated cell shows an error instead of quietly
computing without a reset. `ROWS`/`COLUMNS` are axis keywords, not resets;
using one in a reset slot is an error (the axis keyword must be the last
argument).

## Examples

Given a pivot with **ROWS: Year, Quarter, Month**:

### No Reset (default)
```
CALC RunTotal = RUNNINGSUM([Sales])
```
Running sum across all months, never restarting.

### HIGHESTPARENT
```
CALC RunByYear = RUNNINGSUM([Sales], HIGHESTPARENT)
```
Running sum restarts at the beginning of each Year.

### LOWESTPARENT
```
CALC RunByQuarter = RUNNINGSUM([Sales], LOWESTPARENT)
```
Running sum restarts at the beginning of each Quarter (the immediate parent of Month).

### Integer Reset
```
CALC RunByQ = RUNNINGSUM([Sales], 2)
```
Reset at depth level 2 (Quarter). Equivalent to specifying the Quarter field.

### Relative Integer Reset
```
CALC RunUpTwo = RUNNINGSUM([Sales], -2)
```
Reset two levels above the current row's own level, wherever the formula is
evaluated. `-1` is the same as `LOWESTPARENT`.

### Field Name Reset
```
CALC RunByQ = RUNNINGSUM([Sales], Quarter)
```
Reset whenever the Quarter value changes. Same as integer 2 in this hierarchy.
An unknown field name is an error, not a silent no-reset.

## Behavior at Different Levels

Consider **RUNNINGSUM([Sales], HIGHESTPARENT)** with Years 2024-2025:

| Row | [Sales] | RunByYear |
|-----|---------|-----------|
| 2024 Q1 | 100 | 100 |
| 2024 Q2 | 150 | 250 |
| 2024 Q3 | 200 | 450 |
| 2024 Q4 | 180 | 630 |
| 2025 Q1 | 120 | 120 (restarted) |
| 2025 Q2 | 160 | 280 |

## Reset on the COLUMNS Axis

Resets also work when a window function traverses the columns axis. Combine
the reset with the trailing `COLUMNS` axis keyword; field-name resets then
resolve against the **column** fields:

```
CALC RunCols = RUNNINGSUM([Sales], HIGHESTPARENT, COLUMNS)
CALC RunByQ  = RUNNINGSUM([Sales], Quarter, COLUMNS)
```

## Subtotal and Grand Total Rows

Window functions skip subtotal and grand total rows. These rows are not part of the "visible row" sequence that window functions traverse. On subtotal/grand total rows, window functions return NaN. Window functions also only traverse rows at the same hierarchy level as the current row.

## Partition Boundaries

When a reset is active, the calculation only sees rows within the current partition. For example, with `PREVIOUS([Sales], HIGHESTPARENT)`:
- At `2025 Q1`: returns NaN (first row in the 2025 partition, no previous)
- At `2024 Q4`: returns 200 (previous is 2024 Q3)
- The 2024 and 2025 partitions are completely independent

# COUNTIFS function

## Introduction
The COUNTIFS function counts the number of cells that meet multiple conditions across one or more ranges. It extends COUNTIF by applying AND logic across all criteria, making it suitable for multi-dimensional counting such as determining how many orders from a specific region were above a certain value, or how many employees in a department have a particular job title.

## Syntax
```
=COUNTIFS(criteria_range1, criteria1, [criteria_range2, criteria2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| criteria_range1 | Required | The first range to evaluate. |
| criteria1 | Required | The condition applied to criteria_range1. |
| criteria_range2, criteria2, ... | Optional | Additional range/criteria pairs. Up to 127 pairs supported. |

## Remarks
- All criteria ranges must have the same number of rows and columns.
- All conditions must be satisfied for a cell to be counted (AND logic).
- Wildcard characters (* and ?) are supported in text criteria.
- If no cells meet all criteria, COUNTIFS returns 0.
- Each criteria range is evaluated row by row against its corresponding criteria.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Region** | **Status** | **Amount** |
| 2 | East | Closed | 5000 |
| 3 | West | Open | 3200 |
| 4 | East | Open | 7800 |
| 5 | East | Closed | 4100 |
| 6 | West | Closed | 6500 |

| | E | F |
|---|---|---|
| 1 | **East & Closed** | =COUNTIFS(A2:A6, "East", B2:B6, "Closed") |

**Result:** 2

The formula counts rows where the region is "East" AND the status is "Closed" (rows 2 and 5).

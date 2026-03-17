# AVERAGEIFS function

## Introduction
The AVERAGEIFS function calculates the arithmetic mean of cells that satisfy multiple conditions. It extends AVERAGEIF by supporting two or more criteria across different ranges, enabling precise multi-dimensional averaging. This is useful for scenarios like finding the average revenue for a specific product in a specific quarter, or the mean test score for students in a particular grade and subject.

## Syntax
```
=AVERAGEIFS(average_range, criteria_range1, criteria1, [criteria_range2, criteria2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| average_range | Required | The range of cells to average. |
| criteria_range1 | Required | The first range to evaluate against its paired criteria. |
| criteria1 | Required | The condition applied to criteria_range1. |
| criteria_range2, criteria2, ... | Optional | Additional range/criteria pairs. Up to 127 pairs supported. |

## Remarks
- All criteria ranges must have the same dimensions as **average_range**.
- If no cells meet all the criteria, AVERAGEIFS returns a #DIV/0! error.
- Cells in average_range that are empty or contain text are not counted.
- Wildcard characters (* and ?) are supported in text criteria.
- All conditions use AND logic -- every condition must be satisfied.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Region** | **Quarter** | **Revenue** |
| 2 | North | Q1 | 45000 |
| 3 | South | Q1 | 52000 |
| 4 | North | Q2 | 48000 |
| 5 | South | Q2 | 55000 |
| 6 | North | Q1 | 42000 |

| | E | F |
|---|---|---|
| 1 | **Avg North Q1** | =AVERAGEIFS(C2:C6, A2:A6, "North", B2:B6, "Q1") |

**Result:** 43500

The formula averages revenue only for rows where the region is "North" AND the quarter is "Q1": (45000 + 42000) / 2.

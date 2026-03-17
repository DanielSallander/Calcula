# MAXIFS function

## Introduction
The MAXIFS function returns the maximum value among cells that satisfy one or more conditions. It combines the functionality of MAX with conditional filtering, allowing you to find the highest value within a specific subset of data. For example, you can find the highest sale in a particular region or the maximum score for a specific grade level.

## Syntax
```
=MAXIFS(max_range, criteria_range1, criteria1, [criteria_range2, criteria2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| max_range | Required | The range of cells from which to find the maximum value. |
| criteria_range1 | Required | The first range to evaluate against its paired criteria. |
| criteria1 | Required | The condition applied to criteria_range1. |
| criteria_range2, criteria2, ... | Optional | Additional range/criteria pairs. Up to 126 pairs supported. |

## Remarks
- All criteria ranges must have the same dimensions as **max_range**.
- If no cells meet all the criteria, MAXIFS returns 0.
- Wildcard characters (* and ?) are supported in text criteria.
- All conditions use AND logic.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Salesperson** | **Region** | **Deal Size** |
| 2 | Alice | North | 45000 |
| 3 | Bob | South | 62000 |
| 4 | Carol | North | 58000 |
| 5 | Dave | South | 71000 |
| 6 | Eve | North | 39000 |

| | E | F |
|---|---|---|
| 1 | **Largest North Deal** | =MAXIFS(C2:C6, B2:B6, "North") |

**Result:** 58000

The formula returns the largest deal size among the "North" region entries (Carol's deal of 58,000).

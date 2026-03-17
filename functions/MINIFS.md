# MINIFS function

## Introduction
The MINIFS function returns the minimum value among cells that satisfy one or more conditions. It is the conditional counterpart of MIN, allowing you to find the smallest value within a filtered subset of data. Practical uses include finding the lowest price from a specific vendor, the minimum score in a particular category, or the earliest delivery time for a given product line.

## Syntax
```
=MINIFS(min_range, criteria_range1, criteria1, [criteria_range2, criteria2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| min_range | Required | The range of cells from which to find the minimum value. |
| criteria_range1 | Required | The first range to evaluate against its paired criteria. |
| criteria1 | Required | The condition applied to criteria_range1. |
| criteria_range2, criteria2, ... | Optional | Additional range/criteria pairs. Up to 126 pairs supported. |

## Remarks
- All criteria ranges must have the same dimensions as **min_range**.
- If no cells meet all the criteria, MINIFS returns 0.
- Wildcard characters (* and ?) are supported in text criteria.
- All conditions use AND logic.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Product** | **Warehouse** | **Lead Time (days)** |
| 2 | Widget | East | 5 |
| 3 | Gadget | West | 3 |
| 4 | Widget | West | 7 |
| 5 | Gadget | East | 4 |
| 6 | Widget | East | 3 |

| | E | F |
|---|---|---|
| 1 | **Fastest Widget** | =MINIFS(C2:C6, A2:A6, "Widget") |

**Result:** 3

The formula returns the shortest lead time among "Widget" entries (row 6, 3 days).

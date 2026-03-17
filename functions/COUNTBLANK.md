# COUNTBLANK function

## Introduction
The COUNTBLANK function counts the number of empty cells in a specified range. It is useful for data quality checks, identifying missing entries in a dataset, and verifying that required fields have been filled in. For example, you can use COUNTBLANK to find how many employees are missing a phone number or how many survey responses are incomplete.

## Syntax
```
=COUNTBLANK(range)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| range | Required | The range of cells in which to count blank cells. |

## Remarks
- Cells containing empty strings ("") returned by formulas are counted as blank.
- Cells containing zero (0) are NOT counted as blank.
- Cells with spaces only are NOT counted as blank.
- COUNTBLANK accepts only a single contiguous range.

## Example

| | A | B |
|---|---|---|
| 1 | **Employee** | **Phone** |
| 2 | Alice | 555-0101 |
| 3 | Bob | |
| 4 | Carol | 555-0103 |
| 5 | Dave | |
| 6 | Eve | 555-0105 |
| 7 | **Missing Phones** | =COUNTBLANK(B2:B6) |

**Result:** 2

The formula identifies that two employees (Bob and Dave) have no phone number recorded.

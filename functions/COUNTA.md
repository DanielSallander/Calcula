# COUNTA function

## Introduction

The COUNTA function counts the number of cells in a range that are not empty. It counts cells containing any type of value, including numbers, text, logical values, error values, and empty strings (""). Only truly blank cells are excluded from the count.

Use COUNTA when you need to determine how many cells in a range contain data, regardless of data type. It is commonly used to count entries in a list, determine how far data extends in a column, or calculate the number of responses in a survey. For counting only numeric values, use COUNT instead.

## Syntax

```
=COUNTA(value1, [value2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value1 | Required | The first range or value to count. |
| value2, ... | Optional | Additional ranges or values to count, up to 255 arguments. |

## Remarks

- COUNTA counts cells containing error values (e.g., #N/A, #VALUE!) as non-empty.
- COUNTA counts cells containing empty strings ("") as non-empty. Use COUNTBLANK or SUMPRODUCT with LEN for more precise empty-cell detection.
- COUNTA does NOT count truly blank (empty) cells.
- You can mix individual values, cell references, and ranges as arguments.

## Example

| | A | B |
|---|---|---|
| 1 | **Data** | |
| 2 | Alice | |
| 3 | | |
| 4 | 100 | |
| 5 | TRUE | |
| 6 | #N/A | |
| 7 | | |
| 8 | **Count** | =COUNTA(A2:A7) |

**Result (B8):** 4

The formula counts 4 non-empty cells: "Alice" (text), 100 (number), TRUE (logical), and #N/A (error). The two blank cells in A3 and A7 are not counted.

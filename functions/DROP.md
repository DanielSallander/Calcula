# DROP function

## Introduction
The DROP function removes a specified number of rows or columns from the start or end of an array, returning the remaining data. It is useful for skipping header rows, removing trailing totals, or trimming data from either end of a dataset.

## Syntax
```
=DROP(array, [rows], [columns])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The source array or range. |
| rows | Optional | Number of rows to drop. Positive = from the top, negative = from the bottom. |
| columns | Optional | Number of columns to drop. Positive = from the left, negative = from the right. |

## Remarks
- At least one of rows or columns must be specified.
- Positive values drop from the start; negative values drop from the end.
- Returns #VALUE! if dropping all rows or columns (nothing left to return).
- Commonly used with TAKE as complementary functions.

## Example

| | A | B |
|---|---|---|
| 1 | **Name** | **Score** |
| 2 | Alice | 95 |
| 3 | Bob | 87 |
| 4 | Carol | 92 |
| 5 | **Without header** | =DROP(A1:B4, 1) |

**Result:** {Alice, 95; Bob, 87; Carol, 92} (header row removed)

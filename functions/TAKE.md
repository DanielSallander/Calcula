# TAKE function

## Introduction
The TAKE function returns a specified number of rows or columns from the start or end of an array. It is useful for extracting the first N or last N records from a dataset, such as the top entries from a sorted list.

## Syntax
```
=TAKE(array, [rows], [columns])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The source array or range. |
| rows | Optional | Number of rows to take. Positive = from the top, negative = from the bottom. |
| columns | Optional | Number of columns to take. Positive = from the left, negative = from the right. |

## Remarks
- At least one of rows or columns must be specified.
- Positive values take from the start; negative values take from the end.
- Returns #VALUE! if the requested rows or columns exceed the array dimensions.
- Can be combined with SORT to get "top N" or "bottom N" results.

## Example

| | A | B |
|---|---|---|
| 1 | Alice | 95 |
| 2 | Bob | 87 |
| 3 | Carol | 92 |
| 4 | Dave | 78 |
| 5 | **Top 2** | =TAKE(A1:B4, 2) |

**Result:** {Alice, 95; Bob, 87} (first 2 rows)

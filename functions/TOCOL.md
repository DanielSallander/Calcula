# TOCOL function

## Introduction
The TOCOL function transforms an array or range into a single column. It flattens a 2D array into a vertical list, scanning either by row or by column. This is useful for converting tabular data into a single-column format for further processing.

## Syntax
```
=TOCOL(array, [ignore], [scan_by_column])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The array or range to flatten into a column. |
| ignore | Optional | 0 = keep all values (default), 1 = ignore blanks, 2 = ignore errors, 3 = ignore blanks and errors. |
| scan_by_column | Optional | FALSE = scan by row left-to-right then down (default), TRUE = scan by column top-to-bottom then right. |

## Remarks
- Returns a spilled vertical array (single column).
- By default, reads left-to-right across each row before moving to the next row.
- The ignore parameter lets you filter out blanks and/or errors from the result.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | 1 | 2 | 3 |
| 2 | 4 | 5 | 6 |
| 3 | **Column** | =TOCOL(A1:C2) | |

**Result:** B3:B8 = {1; 2; 3; 4; 5; 6} (scanned by row)

# TOROW function

## Introduction
The TOROW function transforms an array or range into a single row. It flattens a 2D array into a horizontal list, scanning either by row or by column. This is useful for converting tabular data into a single-row format for further processing.

## Syntax
```
=TOROW(array, [ignore], [scan_by_column])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The array or range to flatten into a row. |
| ignore | Optional | 0 = keep all values (default), 1 = ignore blanks, 2 = ignore errors, 3 = ignore blanks and errors. |
| scan_by_column | Optional | FALSE = scan by row left-to-right then down (default), TRUE = scan by column top-to-bottom then right. |

## Remarks
- Returns a spilled horizontal array (single row).
- By default, reads left-to-right across each row before moving to the next row.
- The ignore parameter lets you filter out blanks and/or errors from the result.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | 1 | 4 | |
| 2 | 2 | 5 | |
| 3 | 3 | 6 | |
| 4 | **Row** | =TOROW(A1:B3) | |

**Result:** B4:G4 = {1, 4, 2, 5, 3, 6} (scanned by row)

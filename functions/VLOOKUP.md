# VLOOKUP function

## Introduction

The VLOOKUP function searches for a value in the first column of a table range and returns a value in the same row from a column you specify. The "V" stands for vertical, meaning the function looks down the first column of the table.

VLOOKUP is one of the most commonly used lookup functions in spreadsheets. While XLOOKUP is the modern replacement, VLOOKUP remains essential for compatibility with existing spreadsheets.

## Syntax

```
=VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| lookup_value | Required | The value to search for in the first column of the table. |
| table_array | Required | The range of cells containing the data. The first column is searched. |
| col_index_num | Required | The column number in the table from which to return the value. 1 returns the first column. |
| range_lookup | Optional | TRUE (default) for approximate match (data must be sorted ascending), FALSE for exact match. |

## Remarks

- When range_lookup is TRUE or omitted, the first column must be sorted in ascending order.
- When range_lookup is FALSE, an exact match is performed. If no match is found, #N/A is returned.
- If col_index_num is greater than the number of columns in table_array, a #REF! error is returned.
- VLOOKUP only searches the first column. For more flexibility, consider using XLOOKUP.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **ID** | **Name** | **Score** |
| 2 | 101 | Alice | 85 |
| 3 | 102 | Bob | 92 |
| 4 | 103 | Carol | 78 |

**Formula:** `=VLOOKUP(102, A2:C4, 3, FALSE)`

**Result:** **92** - Finds 102 in column A and returns the value from column 3 (Score).

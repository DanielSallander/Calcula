# HLOOKUP function

## Introduction

The HLOOKUP function searches for a value in the first row of a table range and returns a value in the same column from a row you specify. The "H" stands for horizontal, meaning the function looks across the first row of the table.

## Syntax

```
=HLOOKUP(lookup_value, table_array, row_index_num, [range_lookup])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| lookup_value | Required | The value to search for in the first row of the table. |
| table_array | Required | The range of cells containing the data. The first row is searched. |
| row_index_num | Required | The row number in the table from which to return the value. 1 returns the first row. |
| range_lookup | Optional | TRUE (default) for approximate match (data must be sorted ascending), FALSE for exact match. |

## Remarks

- When range_lookup is TRUE or omitted, the first row must be sorted in ascending order.
- When range_lookup is FALSE, an exact match is performed. If no match is found, #N/A is returned.
- If row_index_num is greater than the number of rows in table_array, a #REF! error is returned.

## Example

| | A | B | C | D |
|---|---|---|---|---|
| 1 | **Q1** | **Q2** | **Q3** | **Q4** |
| 2 | 100 | 150 | 200 | 250 |
| 3 | 80 | 120 | 160 | 200 |

**Formula:** `=HLOOKUP("Q3", A1:D3, 2, FALSE)`

**Result:** **200** - Finds "Q3" in row 1 and returns the value from row 2.

# RANK.EQ function

## Introduction
The RANK.EQ function returns the rank of a number within a list of numbers. When values are tied, RANK.EQ assigns the highest rank (smallest number) to all tied values. It is functionally identical to the RANK function.

## Syntax
```
=RANK.EQ(number, ref, [order])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number whose rank you want to find. |
| ref | Required | A range of numbers to rank against. |
| order | Optional | 0 or omitted = descending (largest is rank 1), nonzero = ascending (smallest is rank 1). |

## Remarks
- If number is not found in ref, RANK.EQ returns #N/A.
- Tied values all receive the same rank; subsequent ranks are skipped.
- Non-numeric values in ref are ignored.
- For averaged tie-breaking, use RANK.AVG instead.

## Example

| | A | B |
|---|---|---|
| 1 | **Score** | **Rank** |
| 2 | 85 | =RANK.EQ(A2, $A$2:$A$5) |
| 3 | 90 | =RANK.EQ(A3, $A$2:$A$5) |
| 4 | 85 | =RANK.EQ(A4, $A$2:$A$5) |
| 5 | 95 | =RANK.EQ(A5, $A$2:$A$5) |

**Result:** B2 = 3, B3 = 2, B4 = 3, B5 = 1 (both 85s get rank 3, rank 4 is skipped)

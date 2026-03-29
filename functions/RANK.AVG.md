# RANK.AVG function

## Introduction
The RANK.AVG function returns the rank of a number within a list of numbers. When multiple values share the same rank, RANK.AVG returns the average rank rather than the highest rank, which is useful in statistical analyses where tie-breaking matters.

## Syntax
```
=RANK.AVG(number, ref, [order])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number whose rank you want to find. |
| ref | Required | A range of numbers to rank against. |
| order | Optional | 0 or omitted = descending (largest is rank 1), nonzero = ascending (smallest is rank 1). |

## Remarks
- If number is not found in ref, RANK.AVG returns #N/A.
- Tied values receive the average of the ranks they would span (e.g., two values tied for 2nd and 3rd both get rank 2.5).
- Non-numeric values in ref are ignored.

## Example

| | A | B |
|---|---|---|
| 1 | **Score** | **Rank** |
| 2 | 85 | =RANK.AVG(A2, $A$2:$A$5) |
| 3 | 90 | =RANK.AVG(A3, $A$2:$A$5) |
| 4 | 85 | =RANK.AVG(A4, $A$2:$A$5) |
| 5 | 95 | =RANK.AVG(A5, $A$2:$A$5) |

**Result:** B2 = 3.5, B3 = 2, B4 = 3.5, B5 = 1 (the two 85s share ranks 3 and 4, averaged to 3.5)

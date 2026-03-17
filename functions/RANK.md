# RANK function

## Introduction

The RANK function returns the rank of a number within a list of numbers. The rank of a number is its position relative to the other values in the list. If you were to sort the list, the rank would be the position of the number in that sorted list.

RANK is widely used for creating leaderboards, scoring comparisons, and competitive analysis. For example, a school might use RANK to determine each student's class standing, or a business might rank sales regions by performance.

## Syntax

```
=RANK(number, ref, [order])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number whose rank you want to find. |
| ref | Required | A reference to a list of numbers. Non-numeric values in ref are ignored. |
| order | Optional | A number specifying how to rank the number. If 0 or omitted, the list is ranked in descending order (largest = rank 1). If any non-zero value, the list is ranked in ascending order (smallest = rank 1). |

### Remarks

- RANK gives duplicate numbers the same rank. However, the presence of duplicate numbers affects the ranks of subsequent numbers. For example, if two values tie for rank 2, the next rank assigned is 4 (rank 3 is skipped).
- If the number is not found in ref, RANK returns the #N/A error.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Region** | **Q4 Sales ($)** | **Rank** |
| 2 | North | 245,000 | =RANK(B2, B$2:B$6) |
| 3 | South | 312,000 | =RANK(B3, B$2:B$6) |
| 4 | East | 198,000 | =RANK(B4, B$2:B$6) |
| 5 | West | 287,000 | =RANK(B5, B$2:B$6) |
| 6 | Central | 312,000 | =RANK(B6, B$2:B$6) |

| **Region** | **Q4 Sales** | **Rank** |
|---|---|---|
| North | 245,000 | 4 |
| South | 312,000 | 1 |
| East | 198,000 | 5 |
| West | 287,000 | 3 |
| Central | 312,000 | 1 |

**Result:** South and Central both have the highest sales and share rank 1. The next rank assigned is 3 (rank 2 is skipped), given to West. North is rank 4, and East is rank 5.

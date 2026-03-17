# SMALL function

## Introduction

The SMALL function returns the k-th smallest value in a data set. Use this function to select a value based on its relative position from the bottom. For example, you can use SMALL to find the lowest, second-lowest, or third-lowest value in a list.

SMALL is particularly useful in scenarios such as identifying the lowest costs, shortest delivery times, or minimum threshold values. A procurement team might use SMALL to find the three cheapest supplier bids for a contract.

## Syntax

```
=SMALL(array, k)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The range or array of data for which you want to determine the k-th smallest value. |
| k | Required | The position (from the smallest) in the array to return. For example, k=1 returns the smallest value, k=2 returns the second smallest, and so on. |

### Remarks

- If the array is empty, SMALL returns the #NUM! error.
- If k is less than 1 or greater than the number of data points, SMALL returns the #NUM! error.
- If k equals 1, SMALL returns the minimum value (equivalent to MIN).
- Duplicate values are counted individually. If the two smallest values are equal, SMALL with k=1 and k=2 will both return the same value.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Supplier** | **Bid Price ($)** | |
| 2 | AlphaCorp | 45,200 | |
| 3 | BetaInc | 38,900 | |
| 4 | GammaCo | 52,100 | |
| 5 | DeltaLtd | 41,500 | |
| 6 | EpsilonGrp | 39,800 | |
| 7 | | | |
| 8 | **Formula** | **Result** | **Description** |
| 9 | =SMALL(B2:B6, 1) | 38,900 | Lowest bid |
| 10 | =SMALL(B2:B6, 2) | 39,800 | Second lowest |
| 11 | =SMALL(B2:B6, 3) | 41,500 | Third lowest |

**Result:** The formulas return the three lowest bids: 38,900, 39,800, and 41,500 respectively.

This helps the procurement team quickly shortlist the most cost-effective suppliers.

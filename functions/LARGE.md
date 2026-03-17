# LARGE function

## Introduction

The LARGE function returns the k-th largest value in a data set. Use this function to select a value based on its relative standing. For example, you can use LARGE to find the highest, second-highest, or third-highest score in a list.

LARGE is commonly used in business scenarios such as identifying top performers, finding the highest sales figures, or determining threshold values. For instance, you might use LARGE to find the top 3 revenue-generating products out of hundreds.

## Syntax

```
=LARGE(array, k)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| array | Required | The range or array of data for which you want to determine the k-th largest value. |
| k | Required | The position (from the largest) in the array to return. For example, k=1 returns the largest value, k=2 returns the second largest, and so on. |

### Remarks

- If the array is empty, LARGE returns the #NUM! error.
- If k is less than 1 or greater than the number of data points, LARGE returns the #NUM! error.
- If k equals 1, LARGE returns the maximum value (equivalent to MAX).
- Duplicate values are counted individually. If the two largest values are equal, LARGE with k=1 and k=2 will both return the same value.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Sales Rep** | **Revenue** | |
| 2 | Adams | 87,500 | |
| 3 | Baker | 124,000 | |
| 4 | Clark | 95,200 | |
| 5 | Davis | 110,800 | |
| 6 | Evans | 78,300 | |
| 7 | | | |
| 8 | **Formula** | **Result** | **Description** |
| 9 | =LARGE(B2:B6, 1) | 124,000 | Highest revenue |
| 10 | =LARGE(B2:B6, 2) | 110,800 | Second highest |
| 11 | =LARGE(B2:B6, 3) | 95,200 | Third highest |

**Result:** The formulas return the top three revenue figures: 124,000, 110,800, and 95,200 respectively.

This allows a manager to quickly identify the top-performing sales representatives without sorting the entire data set.

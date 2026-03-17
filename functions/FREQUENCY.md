# FREQUENCY function

## Introduction

The FREQUENCY function calculates how often values occur within ranges of values, and returns a vertical array of numbers. Use FREQUENCY to count the number of data points that fall within specified intervals (bins). This is essential for creating histograms and understanding the distribution of data.

FREQUENCY is commonly used in quality control, grading systems, and data analysis. For example, a teacher might use FREQUENCY to count how many students scored in each grade band (0-59, 60-69, 70-79, 80-89, 90-100), or a manufacturer might count how many products fall within specified weight ranges.

## Syntax

```
=FREQUENCY(data_array, bins_array)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| data_array | Required | The range or array of values for which you want to count frequencies. |
| bins_array | Required | The range or array of intervals (bin boundaries) into which you want to group the values in data_array. |

### Remarks

- FREQUENCY returns an array that has one more element than bins_array. The extra element represents the count of values greater than the highest bin value.
- For example, if bins_array contains 3 values, FREQUENCY returns an array of 4 values.
- The returned array elements represent:
  - Element 1: Count of values less than or equal to the first bin
  - Element 2: Count of values greater than the first bin and less than or equal to the second bin
  - (and so on...)
  - Last element: Count of values greater than the last bin
- Empty cells and text are ignored.
- FREQUENCY must be entered as an array formula if your spreadsheet requires it. In Calcula, it returns an array that spills into adjacent cells.

## Example

| | A | B | C | D |
|---|---|---|---|---|
| 1 | **Test Score** | | **Bin** | **Frequency** |
| 2 | 72 | | 59 | =FREQUENCY(A2:A11, C2:C6) |
| 3 | 85 | | 69 | |
| 4 | 91 | | 79 | |
| 5 | 68 | | 89 | |
| 6 | 74 | | 100 | |
| 7 | 55 | | | |
| 8 | 88 | | | |
| 9 | 79 | | | |
| 10 | 93 | | | |
| 11 | 82 | | | |

The FREQUENCY formula in D2 returns the following array (spilling into D2:D7):

| **Grade Range** | **Bin** | **Count** |
|---|---|---|
| 0-59 | 59 | 1 |
| 60-69 | 69 | 1 |
| 70-79 | 79 | 3 |
| 80-89 | 89 | 3 |
| 90-100 | 100 | 2 |
| Above 100 | | 0 |

**Result:** The data shows that most students scored in the 70-79 and 80-89 ranges (3 each), 2 students scored in the 90-100 range, and 1 student each scored below 60 and in the 60-69 range.

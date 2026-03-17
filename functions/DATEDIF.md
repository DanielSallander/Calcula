# DATEDIF function

## Introduction

The DATEDIF function calculates the difference between two dates in various units: complete years, complete months, or days. It is a powerful function for age calculations, tenure computations, and duration measurements.

Use DATEDIF to calculate a person's age, determine how long an employee has been with a company, compute the remaining time on a contract, or break down a duration into years, months, and days. Despite being undocumented in some spreadsheet applications, DATEDIF is widely supported and heavily used.

## Syntax

```
=DATEDIF(start_date, end_date, unit)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| start_date | Required | The start date (must be earlier than or equal to end_date). |
| end_date | Required | The end date. |
| unit | Required | A text code specifying the unit of the result (see table below). |

### Unit values

| Unit | Description |
|------|-------------|
| "Y" | Complete years between the dates. |
| "M" | Complete months between the dates. |
| "D" | Total days between the dates. |
| "YM" | Months remaining after subtracting complete years (0-11). |
| "YD" | Days remaining after subtracting complete years (0-365). |
| "MD" | Days remaining after subtracting complete months (0-30). |

## Remarks

- If start_date is later than end_date, DATEDIF returns a #NUM! error.
- The unit argument is not case-sensitive ("Y", "y", and "Y" all work).
- The "MD" unit may produce unexpected results in some edge cases involving month boundaries.
- DATEDIF does not appear in the formula autocomplete list in some spreadsheet applications, but it is fully functional.

## Example

| | A | B |
|---|---|---|
| 1 | **Start Date** | 1990-06-15 |
| 2 | **End Date** | 2025-03-16 |
| 3 | | |
| 4 | **Complete Years** | =DATEDIF(B1, B2, "Y") |
| 5 | **Complete Months** | =DATEDIF(B1, B2, "M") |
| 6 | **Total Days** | =DATEDIF(B1, B2, "D") |
| 7 | **Months after years** | =DATEDIF(B1, B2, "YM") |
| 8 | **Days after months** | =DATEDIF(B1, B2, "MD") |

**Result (B4):** 34 (34 complete years)
**Result (B5):** 417 (417 complete months)
**Result (B6):** 12692 (total days between the two dates)
**Result (B7):** 9 (9 months beyond the 34 complete years)
**Result (B8):** 1 (1 day beyond the complete months)

To display a full age breakdown like "34 years, 9 months, 1 day", combine DATEDIF with the "Y", "YM", and "MD" units.

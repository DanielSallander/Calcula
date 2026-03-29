# WORKDAY.INTL function

## Introduction
The WORKDAY.INTL function returns the date that is a specified number of working days before or after a start date, with custom weekend parameters. It extends WORKDAY by allowing you to define which days count as weekends.

## Syntax
```
=WORKDAY.INTL(start_date, days, [weekend], [holidays])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| start_date | Required | The start date. |
| days | Required | Number of working days to advance. Negative values go backward. |
| weekend | Optional | A number (1-17) or a 7-character string indicating weekend days. Default is 1 (Saturday-Sunday). |
| holidays | Optional | A range or array of dates to exclude as holidays. |

## Remarks
- Weekend number codes: 1=Sat-Sun, 2=Sun-Mon, 3=Mon-Tue, ..., 7=Fri-Sat, 11=Sun only, 12=Mon only, ..., 17=Sat only.
- Weekend string: 7 characters of 0s and 1s representing Mon-Sun (e.g., "0000011" = Sat-Sun weekend).
- The start_date itself is not counted; counting begins on the next day.

## Example

| | A | B |
|---|---|---|
| 1 | **Start** | **Days** |
| 2 | 2024-01-01 | 10 |
| 3 | **Due Date** | =WORKDAY.INTL(A2, B2, 11) |

**Result:** 2024-01-12 (only Sundays are weekends)

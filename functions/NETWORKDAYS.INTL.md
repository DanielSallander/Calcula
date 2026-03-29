# NETWORKDAYS.INTL function

## Introduction
The NETWORKDAYS.INTL function returns the number of whole working days between two dates, with custom weekend parameters. Unlike NETWORKDAYS which assumes Saturday-Sunday weekends, this function lets you specify which days of the week are non-working days.

## Syntax
```
=NETWORKDAYS.INTL(start_date, end_date, [weekend], [holidays])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| start_date | Required | The start date (inclusive). |
| end_date | Required | The end date (inclusive). |
| weekend | Optional | A number (1-17) or a 7-character string indicating weekend days. Default is 1 (Saturday-Sunday). |
| holidays | Optional | A range or array of dates to exclude as holidays. |

## Remarks
- Weekend number codes: 1=Sat-Sun, 2=Sun-Mon, 3=Mon-Tue, ..., 7=Fri-Sat, 11=Sun only, 12=Mon only, ..., 17=Sat only.
- Weekend string: 7 characters of 0s and 1s representing Mon-Sun (e.g., "0000011" = Sat-Sun weekend).
- Returns #VALUE! if the weekend string is invalid.

## Example

| | A | B |
|---|---|---|
| 1 | **Start** | **End** |
| 2 | 2024-01-01 | 2024-01-31 |
| 3 | **Workdays** | =NETWORKDAYS.INTL(A2, B2, 11) |

**Result:** 27 (only Sundays excluded)

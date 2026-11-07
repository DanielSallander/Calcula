# FORMAT

Formats a value as text with a DAX format string, in the engine's format culture or in the culture a locale name names.

## Syntax

```
FORMAT(value, format_string [, locale_name])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `value` | The value to format: a number, a date or timestamp, text, or a boolean. |
| `format_string` | A string literal (in double quotes): a named format or a custom pattern in DAX's (VBA-compatible) format-string language. |
| `locale_name` | (Optional) The culture to format in, as a BCP 47 tag (`"en-US"`, `"de-DE"`; matched case-insensitively, `_` read as `-`). A language-only name (`"de"`) takes the first known culture of that language. BLANK or `""` is the engine's own culture, as if the argument were not given. A name the engine knows no culture for is an error. |

### Named formats

| Name | en-US (1234.5 / 2024-01-15 14:30:05) | sv-SE |
|------|-------------------------------------|-------|
| `"General Number"` | `1234.5` | `1234,5` |
| `"Currency"` | `$1,234.50`; negative `($1,234.50)` | `1 234,50 kr`; negative `-1 234,50 kr` |
| `"Fixed"` | `1234.50` | `1234,50` |
| `"Standard"` | `1,234.50` | `1 234,50` |
| `"Percent"` (0.1234) | `12.34%` | `12,34%` |
| `"Scientific"` | `1.23E+03` | `1,23E+03` |
| `"Yes/No"`, `"True/False"`, `"On/Off"` | `Yes` / `True` / `On` for non-zero, `No` / `False` / `Off` for zero | `Ja` / `Sant` / `På`, `Nej` / `Falskt` / `Av` |
| `"Short Date"` | `1/15/2024` | `2024-01-15` |
| `"Long Date"` | `Monday, January 15, 2024` | `den 15 januari 2024` |
| `"Medium Date"` | `15-Jan-24` | `15/01 2024` |
| `"Long Time"` | `2:30:05 PM` | `14:30:05` |
| `"Medium Time"` | `02:30 PM` | `02:30 ` (sv-SE has no AM/PM designator) |
| `"Short Time"` | `14:30` | `14:30` |
| `"General Date"` | `1/15/2024 2:30:05 PM` | `2024-01-15 14:30:05` |

In sv-SE the group separator is the no-break space; the space before `kr` is a plain space. The sv-SE column is measured on the Power BI DAX engine (Excel 16's data model on a Swedish machine). The en-US negative currency follows Windows' en-US negative currency pattern; Excel 16's engine has no 3-argument FORMAT to measure it with.

### Custom patterns

- Numbers: up to three `;`-separated sections (positive; negative; zero); `0` and `#` digit placeholders; `.` the culture's decimal separator; `,` between digit placeholders the culture's group separator (a `,` right before the decimal point or at the end divides by 1000); `%` multiplies by 100; `E+`, `E-` for scientific notation; `\x` and `"text"` literals. `"#,0.00"` writes `1,234.50` in en-US and `1 234,50` in sv-SE.
- Dates and times: `d dd ddd dddd`, `m mm mmm mmmm` (an `m` right after an hour, or right before `:s`, is the minute), `yy yyyy`, `q`, `w ww`, `h hh` (12-hour when the pattern has an AM/PM token, else 24-hour), `n nn` (minutes), `s ss`, `AM/PM am/pm A/P a/p` (those letters, in every culture), `AMPM` (the culture's designators: `PM` in en-US, nothing in sv-SE and de-DE), `ddddd` (short date), `dddddd` (long date), `ttttt` (long time), `c` (general date). `/` and `:` are the culture's date and time separators. Tokens are case-insensitive, so `"yyyy-MM-dd HH:mm:ss"` reads the same as `"yyyy-mm-dd hh:nn:ss"` -- but .NET's `tt` is not a token: `"hh:nn tt"` writes `14:30 tt`, as DAX does.

## Return value

A text string. BLANK formats to the empty string; text is returned unchanged. A number formatted with a date pattern is read as an OLE serial date (day 0 = 1899-12-30), and a date formatted with a number pattern as its serial. A boolean formatted with a number pattern is VBA's `-1` (TRUE) or `0`; with no format it is `True` / `False` in every culture.

## Remarks

- The culture is the host's (`Engine::set_format_culture`; Calcula passes its app locale). Built in: `FormatCulture::en_us()`, `sv_se()`, `de_de()`; a host may build any other. The cultures `locale_name` may name are the engine's own, those the host lists (`Engine::set_named_format_cultures`; Calcula lists every locale it knows), and the built-ins.
- FORMAT runs in the local DataFusion session as the UDF `calcula_format`. An expression containing it is never pushed to a source: no database speaks DAX's format strings (PostgreSQL's `TO_CHAR`, which FORMAT used to compile to, does not). That includes a context-driven calculated column whose expression holds FORMAT.
- Because FORMAT returns text, sort order is lexicographic. Use `"yyyy-mm"` patterns (not `"mm-yyyy"`) for chronological sorting.

## Example 1: Year-month grouping

```
DEFINE YearMonth = FORMAT(dim_date[order_date], "yyyy-mm")
```

## Example 2: A measure that formats itself

```
Revenue Text = FORMAT(SUM(Sales[amount]), "#,0.00")
```

## Example 3: A fixed culture, whatever the engine's

```
Revenue EUR = FORMAT(SUM(Sales[amount]), "Currency", "de-DE")
```

## See also

- [YEAR](../Date%20and%20Time%20Functions/YEAR.md) — extract year as a number
- [MONTH](../Date%20and%20Time%20Functions/MONTH.md) — extract month as a number
- [QUARTER](../Date%20and%20Time%20Functions/QUARTER.md) — extract quarter as a number
- [CONCATENATE](CONCATENATE.md) — join text values

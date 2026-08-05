//! FILENAME: core/script-engine/src/ops/text.rs
//! PURPOSE: Pure text-processing operations for the script engine
//! (Calcula.text.parseCsv / Calcula.text.toCsv).
//! CONTEXT: Ports the parsing semantics of
//! app/extensions/CsvImportExport/lib/csvParser.ts (RFC-4180-ish: quoted
//! fields, escaped quotes by doubling, mixed CR/LF/CRLF line endings) and the
//! serialization semantics of csvExporter.ts, so a script running in the Rust
//! QuickJS realm and the TS import dialog can never disagree about what a CSV
//! means. Pure compute: no grid, no I/O, nothing leaves the realm.

use rquickjs::{Array, Ctx, Function, Object, Value};

// ============================================================================
// Pure parsing / serialization cores (unit-tested below, no JS involved)
// ============================================================================

/// Parse CSV text into rows of fields.
///
/// Straight port of `parseCsv` in csvParser.ts (same control flow, same edge
/// cases — the table-driven tests below mirror the TS fixtures):
///  - a quote char opens a quoted region only at FIELD START; mid-field quotes
///    are literal characters
///  - inside a quoted region, a doubled quote is an escaped quote
///  - delimiters and line endings inside a quoted region are field content
///  - `\r\n`, `\n` and `\r` all end a row
///  - a trailing newline does not produce a phantom empty row
///  - `quote = None` disables quoting entirely (TS: textQualifier == "")
pub(crate) fn parse_csv_text(text: &str, delimiter: char, quote: Option<char>) -> Vec<Vec<String>> {
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut rows: Vec<Vec<String>> = Vec::new();

    let mut i = 0usize;
    while i < len {
        let mut row: Vec<String> = Vec::new();
        let mut field = String::new();
        let mut in_quoted = false;

        while i < len {
            let ch = chars[i];

            // Handle text qualifier
            if let Some(q) = quote {
                if ch == q {
                    if !in_quoted {
                        // Start of quoted field (only valid at field start)
                        if field.is_empty() {
                            in_quoted = true;
                            i += 1;
                            continue;
                        }
                    } else {
                        // Inside quoted field - check for escaped qualifier (doubled)
                        if i + 1 < len && chars[i + 1] == q {
                            field.push(q);
                            i += 2;
                            continue;
                        }
                        // End of quoted region
                        in_quoted = false;
                        i += 1;
                        continue;
                    }
                }
            }

            // Delimiter outside quotes = next field
            if !in_quoted && ch == delimiter {
                row.push(std::mem::take(&mut field));
                i += 1;
                continue;
            }

            // Line ending outside quotes = end of row
            if !in_quoted && (ch == '\r' || ch == '\n') {
                if ch == '\r' && i + 1 < len && chars[i + 1] == '\n' {
                    i += 1;
                }
                i += 1;
                break;
            }

            field.push(ch);
            i += 1;
        }

        // Push the last field of the row
        row.push(field);

        // Don't push a completely empty trailing row
        if i >= len && row.len() == 1 && row[0].is_empty() {
            break;
        }

        rows.push(row);
    }

    rows
}

/// Serialize rows of fields to CSV text.
///
/// Straight port of `exportToCsv` in csvExporter.ts: a field containing the
/// delimiter, the quote char, `\r` or `\n` is wrapped in quotes with inner
/// quotes doubled; everything else is emitted verbatim.
pub(crate) fn to_csv_text(
    rows: &[Vec<String>],
    delimiter: char,
    quote: char,
    line_ending: &str,
) -> String {
    let mut lines: Vec<String> = Vec::with_capacity(rows.len());
    for row in rows {
        let fields: Vec<String> = row
            .iter()
            .map(|value| {
                let needs_quoting = value
                    .chars()
                    .any(|c| c == delimiter || c == quote || c == '\r' || c == '\n');
                if needs_quoting {
                    let escaped =
                        value.replace(quote, &format!("{}{}", quote, quote));
                    format!("{}{}{}", quote, escaped, quote)
                } else {
                    value.clone()
                }
            })
            .collect();
        lines.push(fields.join(&delimiter.to_string()));
    }
    lines.join(line_ending)
}

// ============================================================================
// JS glue
// ============================================================================

/// Read a single-character option (e.g. `delimiter`, `quote`) off an options
/// object. Missing/undefined = `default_ch`. An empty string is only legal
/// where the caller allows it (`allow_empty`, used by `quote` to disable
/// quoting); anything longer than one char throws.
fn read_char_option<'js>(
    ctx: &Ctx<'js>,
    options: Option<&Object<'js>>,
    key: &str,
    default_ch: Option<char>,
    allow_empty: bool,
) -> rquickjs::Result<Option<char>> {
    let Some(obj) = options else {
        return Ok(default_ch);
    };
    let value: Value<'js> = obj.get(key)?;
    if value.is_undefined() || value.is_null() {
        return Ok(default_ch);
    }
    let Some(s) = value.as_string() else {
        return Err(rquickjs::Exception::throw_type(
            ctx,
            &format!("{} must be a string", key),
        ));
    };
    let s = s.to_string()?;
    let mut chars = s.chars();
    match (chars.next(), chars.next()) {
        (None, _) if allow_empty => Ok(None),
        (None, _) => Err(rquickjs::Exception::throw_message(
            ctx,
            &format!("{} must be exactly one character", key),
        )),
        (Some(c), None) => Ok(Some(c)),
        _ => Err(rquickjs::Exception::throw_message(
            ctx,
            &format!("{} must be exactly one character", key),
        )),
    }
}

/// Coerce one JS cell value to its CSV string, mirroring JS `String(v)` for
/// the types a script realistically hands over: strings pass through, numbers
/// and booleans stringify, null/undefined become the empty string.
fn value_to_csv_string(v: &Value<'_>) -> rquickjs::Result<String> {
    if v.is_undefined() || v.is_null() {
        return Ok(String::new());
    }
    if let Some(s) = v.as_string() {
        return Ok(s.to_string()?);
    }
    if let Some(b) = v.as_bool() {
        return Ok(if b { "true".to_string() } else { "false".to_string() });
    }
    if let Some(n) = v.as_number() {
        // Match JS String(n) for the integer case ("2", not "2.0"); Rust's
        // shortest-roundtrip Display matches JS for the fractional case.
        if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
            return Ok(format!("{}", n as i64));
        }
        return Ok(format!("{}", n));
    }
    // Objects/arrays make no sense in a CSV cell; stringify defensively.
    Ok(String::new())
}

/// Register text operations on a `Calcula.text` sub-object.
pub fn register_text_ops<'js>(
    ctx: &rquickjs::Ctx<'js>,
    calcula: &Object<'js>,
) -> Result<(), String> {
    let text = Object::new(ctx.clone())
        .map_err(|e| format!("Failed to create text object: {}", e))?;

    // parseCsv(content, { delimiter?, quote?, hasHeaders? }?)
    //   -> { rows: string[][], headers?: string[] }
    {
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>,
                  content: String,
                  options: rquickjs::function::Opt<Object<'js>>|
                  -> rquickjs::Result<Object<'js>> {
                let opts = options.0;
                let delimiter =
                    read_char_option(&ctx, opts.as_ref(), "delimiter", Some(','), false)?
                        .expect("delimiter default");
                let quote = read_char_option(&ctx, opts.as_ref(), "quote", Some('"'), true)?;
                let has_headers: bool = match opts.as_ref() {
                    Some(o) => {
                        let v: Value<'js> = o.get("hasHeaders")?;
                        if v.is_undefined() || v.is_null() {
                            false
                        } else {
                            v.as_bool().unwrap_or(false)
                        }
                    }
                    None => false,
                };

                let mut parsed = parse_csv_text(&content, delimiter, quote);

                let result = Object::new(ctx.clone())?;
                if has_headers {
                    let headers = if parsed.is_empty() {
                        Vec::new()
                    } else {
                        parsed.remove(0)
                    };
                    let headers_arr = Array::new(ctx.clone())?;
                    for (i, h) in headers.iter().enumerate() {
                        headers_arr.set(i, h.as_str())?;
                    }
                    result.set("headers", headers_arr)?;
                }

                let rows_arr = Array::new(ctx.clone())?;
                for (ri, row) in parsed.iter().enumerate() {
                    let row_arr = Array::new(ctx.clone())?;
                    for (ci, fieldv) in row.iter().enumerate() {
                        row_arr.set(ci, fieldv.as_str())?;
                    }
                    rows_arr.set(ri, row_arr)?;
                }
                result.set("rows", rows_arr)?;
                Ok(result)
            },
        )
        .map_err(|e| format!("Failed to create parseCsv: {}", e))?;
        text.set("parseCsv", func)
            .map_err(|e| format!("Failed to set parseCsv: {}", e))?;
    }

    // toCsv(rows, { delimiter?, quote?, lineEnding?, headers? }?) -> string
    // `rows` cells may be string | number | boolean | null; `headers`, when
    // given, is emitted as the first line (the symmetric inverse of
    // parseCsv's hasHeaders split).
    {
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>,
                  rows: Array<'js>,
                  options: rquickjs::function::Opt<Object<'js>>|
                  -> rquickjs::Result<String> {
                let opts = options.0;
                let delimiter =
                    read_char_option(&ctx, opts.as_ref(), "delimiter", Some(','), false)?
                        .expect("delimiter default");
                let quote = read_char_option(&ctx, opts.as_ref(), "quote", Some('"'), false)?
                    .expect("quote default");
                let line_ending: String = match opts.as_ref() {
                    Some(o) => {
                        let v: Value<'js> = o.get("lineEnding")?;
                        if v.is_undefined() || v.is_null() {
                            "\r\n".to_string()
                        } else if let Some(s) = v.as_string() {
                            let s = s.to_string()?;
                            if s == "\r\n" || s == "\n" || s == "\r" {
                                s
                            } else {
                                return Err(rquickjs::Exception::throw_message(
                                    &ctx,
                                    "lineEnding must be \"\\r\\n\", \"\\n\" or \"\\r\"",
                                ));
                            }
                        } else {
                            return Err(rquickjs::Exception::throw_type(
                                &ctx,
                                "lineEnding must be a string",
                            ));
                        }
                    }
                    None => "\r\n".to_string(),
                };

                let mut data: Vec<Vec<String>> = Vec::new();
                if let Some(o) = opts.as_ref() {
                    let hv: Value<'js> = o.get("headers")?;
                    if !hv.is_undefined() && !hv.is_null() {
                        let Some(headers) = hv.as_array() else {
                            return Err(rquickjs::Exception::throw_type(
                                &ctx,
                                "headers must be an array",
                            ));
                        };
                        let mut header_row: Vec<String> = Vec::new();
                        for item in headers.iter::<Value<'js>>() {
                            header_row.push(value_to_csv_string(&item?)?);
                        }
                        data.push(header_row);
                    }
                }
                for row in rows.iter::<Value<'js>>() {
                    let row = row?;
                    let Some(row_arr) = row.as_array() else {
                        return Err(rquickjs::Exception::throw_type(
                            &ctx,
                            "toCsv rows must be an array of arrays",
                        ));
                    };
                    let mut out_row: Vec<String> = Vec::new();
                    for item in row_arr.iter::<Value<'js>>() {
                        out_row.push(value_to_csv_string(&item?)?);
                    }
                    data.push(out_row);
                }

                Ok(to_csv_text(&data, delimiter, quote, &line_ending))
            },
        )
        .map_err(|e| format!("Failed to create toCsv: {}", e))?;
        text.set("toCsv", func)
            .map_err(|e| format!("Failed to set toCsv: {}", e))?;
    }

    calcula
        .set("text", text)
        .map_err(|e| format!("Failed to set Calcula.text: {}", e))?;

    Ok(())
}

// ============================================================================
// Tests — table-driven, mirroring the TS fixtures in
// app/extensions/CsvImportExport/lib/__tests__ so the two parsers cannot
// silently diverge.
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(v: Vec<Vec<&str>>) -> Vec<Vec<String>> {
        v.into_iter()
            .map(|r| r.into_iter().map(|s| s.to_string()).collect())
            .collect()
    }

    // ---- parse: the TS parser's semantics, case by case ----

    #[test]
    fn parse_table_driven_parity_with_ts() {
        // (input, delimiter, quote, expected)
        let cases: Vec<(&str, char, Option<char>, Vec<Vec<&str>>)> = vec![
            // simple rows, LF
            ("a,b,c\n1,2,3", ',', Some('"'), vec![vec!["a", "b", "c"], vec!["1", "2", "3"]]),
            // CRLF line endings
            ("a,b\r\nc,d", ',', Some('"'), vec![vec!["a", "b"], vec!["c", "d"]]),
            // bare CR line endings
            ("a,b\rc,d", ',', Some('"'), vec![vec!["a", "b"], vec!["c", "d"]]),
            // trailing newline does not create a phantom row
            ("a,b\n", ',', Some('"'), vec![vec!["a", "b"]]),
            // quoted field containing the delimiter
            ("\"a,b\",c", ',', Some('"'), vec![vec!["a,b", "c"]]),
            // escaped (doubled) quote inside a quoted field
            ("\"He said \"\"hi\"\"\",x", ',', Some('"'), vec![vec!["He said \"hi\"", "x"]]),
            // newline inside a quoted field stays in the field
            ("\"line1\nline2\",b", ',', Some('"'), vec![vec!["line1\nline2", "b"]]),
            // CRLF inside a quoted field stays in the field (verbatim)
            ("\"line1\r\nline2\",b", ',', Some('"'), vec![vec!["line1\r\nline2", "b"]]),
            // empty fields
            ("a,,c", ',', Some('"'), vec![vec!["a", "", "c"]]),
            // empty leading/trailing fields
            (",a,", ',', Some('"'), vec![vec!["", "a", ""]]),
            // empty line in the middle IS a row with one empty field
            ("a\n\nb", ',', Some('"'), vec![vec!["a"], vec![""], vec!["b"]]),
            // quote in the MIDDLE of an unquoted field is literal
            ("ab\"cd,e", ',', Some('"'), vec![vec!["ab\"cd", "e"]]),
            // semicolon delimiter (sv-SE style)
            ("a;b;c", ';', Some('"'), vec![vec!["a", "b", "c"]]),
            // tab delimiter
            ("a\tb\tc", '\t', Some('"'), vec![vec!["a", "b", "c"]]),
            // quoting disabled: quotes are literal characters
            ("\"a\",b", ',', None, vec![vec!["\"a\"", "b"]]),
            // empty input = no rows
            ("", ',', Some('"'), vec![]),
            // quoted empty field
            ("\"\",b", ',', Some('"'), vec![vec!["", "b"]]),
            // unterminated quote runs to end of input (TS behavior)
            ("\"abc", ',', Some('"'), vec![vec!["abc"]]),
        ];

        for (input, delim, quote, expected) in cases {
            let got = parse_csv_text(input, delim, quote);
            assert_eq!(
                got,
                rows(expected),
                "parse mismatch for input {:?} (delimiter {:?}, quote {:?})",
                input,
                delim,
                quote
            );
        }
    }

    // ---- serialize: the TS exporter's semantics ----

    #[test]
    fn to_csv_table_driven_parity_with_ts() {
        // (rows, delimiter, quote, line_ending, expected)
        let cases: Vec<(Vec<Vec<&str>>, char, char, &str, &str)> = vec![
            (vec![vec!["a", "b"], vec!["1", "2"]], ',', '"', "\r\n", "a,b\r\n1,2"),
            // field containing the delimiter is quoted
            (vec![vec!["a,b", "c"]], ',', '"', "\r\n", "\"a,b\",c"),
            // field containing a quote is quoted with the quote doubled
            (vec![vec!["He said \"hi\"", "x"]], ',', '"', "\r\n", "\"He said \"\"hi\"\"\",x"),
            // field containing a newline is quoted
            (vec![vec!["line1\nline2", "b"]], ',', '"', "\r\n", "\"line1\nline2\",b"),
            // custom line ending
            (vec![vec!["a"], vec!["b"]], ',', '"', "\n", "a\nb"),
            // semicolon delimiter: comma no longer forces quoting, semicolon does
            (vec![vec!["a,b", "c;d"]], ';', '"', "\r\n", "a,b;\"c;d\""),
            // empty rows list
            (vec![], ',', '"', "\r\n", ""),
        ];

        for (input, delim, quote, ending, expected) in cases {
            let got = to_csv_text(&rows(input.clone()), delim, quote, ending);
            assert_eq!(
                got, expected,
                "serialize mismatch for rows {:?} (delimiter {:?})",
                input, delim
            );
        }
    }

    // ---- the two directions agree ----

    #[test]
    fn roundtrip_parse_of_to_csv_is_identity() {
        let original = rows(vec![
            vec!["plain", "with,comma", "with\"quote"],
            vec!["multi\nline", "", "tail"],
        ]);
        let text = to_csv_text(&original, ',', '"', "\r\n");
        let back = parse_csv_text(&text, ',', Some('"'));
        assert_eq!(back, original);
    }

    // ---- the registered JS surface behaves like the core fns ----

    fn run_script(src: &str) -> (Vec<String>, Option<String>) {
        let context = crate::types::ScriptContext::new(
            vec![engine::grid::Grid::new()],
            engine::style::StyleRegistry::new(),
            vec!["Sheet1".to_string()],
            0,
            crate::types::AppInfo::default(),
            crate::types::HostState::default(),
        );
        let outcome = crate::runtime::execute_script(
            src,
            "text-ops-test.js",
            context,
            crate::limits::ScriptLimits::default(),
        )
        .expect("runtime");
        let lines = outcome
            .context
            .console_output
            .borrow()
            .iter()
            .map(|i| i.to_text())
            .collect();
        (lines, outcome.error)
    }

    #[test]
    fn js_parse_csv_returns_rows_and_headers() {
        let (lines, error) = run_script(
            r#"
            var r = Calcula.text.parseCsv('name,age\r\n"Doe, Jane",42\n', { hasHeaders: true });
            console.log(JSON.stringify(r.headers));
            console.log(JSON.stringify(r.rows));
            var plain = Calcula.text.parseCsv('a;b', { delimiter: ';' });
            console.log(JSON.stringify(plain.rows));
            console.log(JSON.stringify(plain.headers === undefined));
            "#,
        );
        assert_eq!(error, None, "script failed: {:?}", lines);
        assert_eq!(lines[0], r#"["name","age"]"#);
        assert_eq!(lines[1], r#"[["Doe, Jane","42"]]"#);
        assert_eq!(lines[2], r#"[["a","b"]]"#);
        assert_eq!(lines[3], "true");
    }

    #[test]
    fn js_to_csv_serializes_and_quotes() {
        let (lines, error) = run_script(
            r#"
            console.log(Calcula.text.toCsv([["a,b", 1, true, null]]));
            console.log(Calcula.text.toCsv([["x"],["y"]], { lineEnding: "\n" }));
            console.log(Calcula.text.toCsv([[1.5, 2]], { delimiter: ";", headers: ["v", "w"] }));
            "#,
        );
        assert_eq!(error, None, "script failed: {:?}", lines);
        assert_eq!(lines[0], "\"a,b\",1,true,");
        assert_eq!(lines[1], "x\ny");
        assert_eq!(lines[2], "v;w\r\n1.5;2");
    }

    #[test]
    fn js_parse_csv_rejects_multichar_delimiter() {
        let (_lines, error) = run_script(
            r#"Calcula.text.parseCsv("a,b", { delimiter: ",," });"#,
        );
        let err = error.expect("multi-char delimiter must throw");
        assert!(
            err.contains("delimiter"),
            "error should name the option: {}",
            err
        );
    }

    #[test]
    fn js_roundtrip_via_both_ops() {
        let (lines, error) = run_script(
            r#"
            var rows = [["a", "b,c"], ["d\"e", ""]];
            var text = Calcula.text.toCsv(rows);
            var back = Calcula.text.parseCsv(text);
            console.log(JSON.stringify(back.rows) === JSON.stringify(rows) ? "OK" : "MISMATCH: " + JSON.stringify(back.rows));
            "#,
        );
        assert_eq!(error, None, "script failed: {:?}", lines);
        assert_eq!(lines[0], "OK");
    }
}

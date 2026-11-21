// Faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Same answers, bit for bit, on every input {text, header} -> {columns, rows, errors}.
// The reference reads one character at a time and builds every field with `+=`;
// this one scans with indexOf (C++ memchr-class search) and takes each field
// out with a single slice, so the common case — a plain unquoted field — costs
// two short searches and one slice instead of a per-character JS loop.
//
// Semantics (matched to vendor/csv-reader/index.js, the reference):
//  - U+FEFF at the very start is dropped; a record ends at LF or CRLF; a line
//    left with no characters is no record.
//  - Outside quotes a CR not followed by LF is dropped (stray_cr). Inside a
//    quoted field CRLF and a lone CR each read as one LF and count one line.
//  - A field opening with a quote runs to the next non-doubled quote; "" is
//    one quote; what follows the closing quote up to the next comma or line
//    break is appended as it stands (quote_junk when the field ends); a quote
//    that never closes is a literal character and the text after it is read
//    again as unquoted (unterminated_quote).
//  - A quote inside an unquoted field is literal; fields stay strings, never
//    trimmed or converted. columns is the first record when header is true,
//    else null; rows are padded (short_row, with fields) or cut (long_row,
//    with extra) to the first record's width. Errors are {code, line, row} in
//    the order met; line is the 1-based line the record starts on, row its
//    index in rows (null for the header).
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the
// next, so two runs write byte-identical output.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, faster. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // How the last field ended, and how many characters the last unquoted read kept
  // (the quote_junk test reads this right after the junk read).
  let ended = END;
  let added = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Line breaks inside a quoted span: one per LF, one per CR not followed by LF
  // (a CRLF counts once). The span is short, so two indexOf walks are cheap.
  function countBreaks(s) {
    let c = 0;
    let i = -1;
    while ((i = s.indexOf('\n', i + 1)) !== -1) c += 1;
    i = -1;
    while ((i = s.indexOf('\r', i + 1)) !== -1) {
      if (s.charCodeAt(i + 1) !== 10) c += 1;
    }
    return c;
  }

  // Reads unquoted characters from pos, starting from `prefix`, up to the next
  // comma or line break. A CR not followed by LF is dropped (stray_cr); a
  // CRLF ends the field as one line break. Returns the field; sets `ended`
  // and `added` (characters kept after `prefix`).
  function readUnquoted(prefix) {
    const ci = text.indexOf(',', pos);
    const ni = text.indexOf('\n', pos);
    let end;
    let e;
    if (ci !== -1 && (ni === -1 || ci < ni)) {
      end = ci;
      e = COMMA;
    } else if (ni !== -1) {
      end = ni;
      e = LINE_BREAK;
      if (end > pos && text.charCodeAt(end - 1) === 13) end -= 1; // CRLF: the CR is not part of the field
    } else {
      end = len;
      e = END;
    }
    let seg = text.slice(pos, end);
    // Any CR left in the segment is stray: a CR followed by LF would have
    // ended the field at that LF instead, so the segment holds no CRLF.
    if (seg.indexOf('\r') !== -1) {
      let out = '';
      let count = 0;
      let s = 0;
      for (;;) {
        const r = seg.indexOf('\r', s);
        if (r === -1) {
          out += seg.slice(s);
          break;
        }
        out += seg.slice(s, r);
        count += 1;
        s = r + 1;
      }
      seg = out;
      for (let k = 0; k < count; k += 1) error('stray_cr');
    }
    added = seg.length;
    if (e === COMMA) {
      pos = end + 1;
    } else if (e === LINE_BREAK) {
      pos = ni + 1;
      line += 1;
    } else {
      pos = len;
    }
    ended = e;
    return prefix === '' ? seg : prefix + seg;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let p = pos + 1;
    let hasDoubled = false;
    let closed = -1;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        hasDoubled = true;
        p = q + 2;
        continue;
      }
      closed = q;
      break;
    }
    if (closed === -1) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted. Line stays at the opening line.
      error('unterminated_quote');
      pos = open + 1;
      line = openLine;
      return readUnquoted('"');
    }
    const content = text.slice(open + 1, closed);
    line += countBreaks(content);
    let value;
    if (hasDoubled || content.indexOf('\r') !== -1) {
      value = content;
      if (hasDoubled) value = value.replaceAll('""', '"');
      if (value.indexOf('\r') !== -1) value = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    } else {
      value = content;
    }
    pos = closed + 1;
    if (pos >= len) {
      ended = END;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      ended = COMMA;
      return value;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      ended = LINE_BREAK;
      return value;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      ended = LINE_BREAK;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (added > 0) error('quote_junk');
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      fields.push(quoted ? readQuoted() : readUnquoted(''));
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

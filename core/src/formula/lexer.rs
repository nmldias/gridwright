//! Tokeniser for spreadsheet formulas (the text after the leading `=`).

use crate::model::letters_to_col;

#[derive(Clone, Debug, PartialEq)]
pub enum Token {
    Number(f64),
    Str(String),
    /// Identifier: function name, TRUE/FALSE, or a bare table name.
    Ident(String),
    /// Quoted name such as `'Table 1'` (used before `::`).
    Quoted(String),
    /// A1-style cell reference.
    CellRef {
        col: u32,
        row: u32,
        abs_col: bool,
        abs_row: bool,
    },
    Op(String),
    LParen,
    RParen,
    LBrace,
    RBrace,
    Comma,
    Semicolon,
    Colon,
    DoubleColon,
    Percent,
    /// Error literal such as `#REF!` (appears in rewritten formulas).
    ErrorLit(String),
    /// Structured-reference column selector: `[Amount]`, `[@Amount]` (text between brackets).
    Bracket(String),
    Eof,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LexError(pub String);

pub fn tokenize(src: &str) -> Result<Vec<Token>, LexError> {
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        // number literal
        if c.is_ascii_digit() || (c == '.' && i + 1 < chars.len() && chars[i + 1].is_ascii_digit()) {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            // exponent
            if i < chars.len() && (chars[i] == 'e' || chars[i] == 'E') {
                let save = i;
                i += 1;
                if i < chars.len() && (chars[i] == '+' || chars[i] == '-') {
                    i += 1;
                }
                if i < chars.len() && chars[i].is_ascii_digit() {
                    while i < chars.len() && chars[i].is_ascii_digit() {
                        i += 1;
                    }
                } else {
                    i = save;
                }
            }
            let text: String = chars[start..i].iter().collect();
            let n: f64 = text.parse().map_err(|_| LexError(format!("bad number '{}'", text)))?;
            out.push(Token::Number(n));
            continue;
        }
        // string literal with "" escape
        if c == '"' {
            i += 1;
            let mut s = String::new();
            loop {
                if i >= chars.len() {
                    return Err(LexError("unterminated string".into()));
                }
                if chars[i] == '"' {
                    if i + 1 < chars.len() && chars[i + 1] == '"' {
                        s.push('"');
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                s.push(chars[i]);
                i += 1;
            }
            out.push(Token::Str(s));
            continue;
        }
        // quoted name 'Table 1'
        if c == '\'' {
            i += 1;
            let mut s = String::new();
            loop {
                if i >= chars.len() {
                    return Err(LexError("unterminated quoted name".into()));
                }
                if chars[i] == '\'' {
                    if i + 1 < chars.len() && chars[i + 1] == '\'' {
                        s.push('\'');
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                s.push(chars[i]);
                i += 1;
            }
            out.push(Token::Quoted(s));
            continue;
        }
        // structured reference column: [Amount] / [@Amount]  ("]]" escapes a bracket)
        if c == '[' {
            i += 1;
            let mut s = String::new();
            loop {
                if i >= chars.len() {
                    return Err(LexError("unterminated '['".into()));
                }
                if chars[i] == ']' {
                    if i + 1 < chars.len() && chars[i + 1] == ']' {
                        s.push(']');
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                s.push(chars[i]);
                i += 1;
            }
            out.push(Token::Bracket(s));
            continue;
        }
        // error literal (#REF!, #DIV/0!, #N/A ...)
        if c == '#' {
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || "/!?".contains(chars[i])) {
                i += 1;
            }
            let text: String = chars[start..i].iter().collect();
            out.push(Token::ErrorLit(text.to_ascii_uppercase()));
            continue;
        }
        // cell reference or identifier
        if c.is_alphabetic() || c == '_' || c == '$' {
            if let Some((tok, len)) = try_cell_ref(&chars[i..]) {
                out.push(tok);
                i += len;
                continue;
            }
            if c == '$' {
                return Err(LexError("unexpected '$'".into()));
            }
            let start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '.') {
                i += 1;
            }
            let text: String = chars[start..i].iter().collect();
            out.push(Token::Ident(text));
            continue;
        }
        // operators and punctuation
        let two: String = chars[i..(i + 2).min(chars.len())].iter().collect();
        match two.as_str() {
            "::" => {
                out.push(Token::DoubleColon);
                i += 2;
                continue;
            }
            "<>" | "<=" | ">=" => {
                out.push(Token::Op(two));
                i += 2;
                continue;
            }
            _ => {}
        }
        match c {
            '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<' | '>' => out.push(Token::Op(c.to_string())),
            '(' => out.push(Token::LParen),
            ')' => out.push(Token::RParen),
            '{' => out.push(Token::LBrace),
            '}' => out.push(Token::RBrace),
            ',' => out.push(Token::Comma),
            ';' => out.push(Token::Semicolon),
            ':' => out.push(Token::Colon),
            '%' => out.push(Token::Percent),
            _ => return Err(LexError(format!("unexpected character '{}'", c))),
        }
        i += 1;
    }
    out.push(Token::Eof);
    Ok(out)
}

/// Try to read `$?[A-Z]{1,3}$?[0-9]{1,7}` not followed by an identifier char or `(`.
fn try_cell_ref(s: &[char]) -> Option<(Token, usize)> {
    let mut i = 0;
    let mut abs_col = false;
    if i < s.len() && s[i] == '$' {
        abs_col = true;
        i += 1;
    }
    let col_start = i;
    while i < s.len() && s[i].is_ascii_alphabetic() && i - col_start < 3 {
        i += 1;
    }
    if i == col_start {
        return None;
    }
    let letters: String = s[col_start..i].iter().collect();
    let mut abs_row = false;
    if i < s.len() && s[i] == '$' {
        abs_row = true;
        i += 1;
    }
    let row_start = i;
    while i < s.len() && s[i].is_ascii_digit() && i - row_start < 7 {
        i += 1;
    }
    if i == row_start {
        return None;
    }
    // must not continue as an identifier (e.g. "LOG10(" is a function, "A1B" is not a ref)
    if i < s.len() && (s[i].is_alphanumeric() || s[i] == '_' || s[i] == '(') {
        return None;
    }
    let row: u32 = s[row_start..i].iter().collect::<String>().parse().ok()?;
    if row == 0 {
        return None;
    }
    let col = letters_to_col(&letters)?;
    Some((
        Token::CellRef {
            col,
            row: row - 1,
            abs_col,
            abs_row,
        },
        i,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lex_basic() {
        let t = tokenize("SUM(A1:B2, 3.5) * -2% & \"x\"\"y\"").unwrap();
        assert_eq!(t[0], Token::Ident("SUM".into()));
        assert_eq!(t[1], Token::LParen);
        assert!(matches!(t[2], Token::CellRef { col: 0, row: 0, .. }));
        assert_eq!(t[3], Token::Colon);
        assert!(matches!(t[4], Token::CellRef { col: 1, row: 1, .. }));
        assert_eq!(t[5], Token::Comma);
        assert_eq!(t[6], Token::Number(3.5));
        assert_eq!(t[7], Token::RParen);
        assert_eq!(t[8], Token::Op("*".into()));
        assert_eq!(t[9], Token::Op("-".into()));
        assert_eq!(t[10], Token::Number(2.0));
        assert_eq!(t[11], Token::Percent);
        assert_eq!(t[12], Token::Op("&".into()));
        assert_eq!(t[13], Token::Str("x\"y".into()));
    }

    #[test]
    fn lex_table_refs_and_functions() {
        let t = tokenize("'Table 1'::$A$1 + Sales::B2 + LOG10(100)").unwrap();
        assert_eq!(t[0], Token::Quoted("Table 1".into()));
        assert_eq!(t[1], Token::DoubleColon);
        assert_eq!(
            t[2],
            Token::CellRef {
                col: 0,
                row: 0,
                abs_col: true,
                abs_row: true
            }
        );
        assert_eq!(t[4], Token::Ident("Sales".into()));
        assert_eq!(t[5], Token::DoubleColon);
        assert_eq!(t[8], Token::Ident("LOG10".into()));
    }
}

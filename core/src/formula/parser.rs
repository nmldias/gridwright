//! Pratt-style parser producing an AST, plus a printer (used to rewrite
//! references when rows/columns are inserted or cells are copied).

use super::lexer::{tokenize, LexError, Token};
use crate::model::col_to_letters;

#[derive(Clone, Debug, PartialEq)]
pub enum RefKind {
    Cell {
        row: u32,
        col: u32,
        abs_row: bool,
        abs_col: bool,
    },
    Range {
        r0: u32,
        c0: u32,
        r1: u32,
        c1: u32,
        abs: [bool; 4], // abs_r0, abs_c0, abs_r1, abs_c1
    },
    /// Whole columns, e.g. `A:C`
    Cols { c0: u32, c1: u32 },
    /// Whole rows, e.g. `2:5`
    Rows { r0: u32, r1: u32 },
    /// Structured reference to a column by header name: `Orders[Amount]` (data rows)
    /// or `Orders[@Amount]` (the value on the formula's own row).
    Column { name: String, this_row: bool },
}

#[derive(Clone, Debug, PartialEq)]
pub struct RefExpr {
    /// Table name when qualified (`Sales::A1`); None means the current table.
    pub table: Option<String>,
    pub kind: RefKind,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Pow,
    Concat,
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    Num(f64),
    Str(String),
    Bool(bool),
    Ref(RefExpr),
    Call(String, Vec<Expr>),
    Neg(Box<Expr>),
    Percent(Box<Expr>),
    Binary(BinOp, Box<Expr>, Box<Expr>),
    /// Array literal `{1,2;3,4}`
    Array(Vec<Vec<Expr>>),
    /// Error literal such as `#REF!`
    ErrorLit(String),
    /// Workbook-level named range (resolved at evaluation time).
    Name(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParseError(pub String);

impl From<LexError> for ParseError {
    fn from(e: LexError) -> Self {
        ParseError(e.0)
    }
}

pub fn parse(src: &str) -> Result<Expr, ParseError> {
    let tokens = tokenize(src)?;
    let mut p = Parser { tokens, pos: 0 };
    let e = p.expr()?;
    if p.peek() != &Token::Eof {
        return Err(ParseError(format!("unexpected token {:?}", p.peek())));
    }
    Ok(e)
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> &Token {
        &self.tokens[self.pos]
    }
    fn next(&mut self) -> Token {
        let t = self.tokens[self.pos].clone();
        if self.pos < self.tokens.len() - 1 {
            self.pos += 1;
        }
        t
    }
    fn expect(&mut self, t: Token) -> Result<(), ParseError> {
        if self.peek() == &t {
            self.next();
            Ok(())
        } else {
            Err(ParseError(format!("expected {:?}, found {:?}", t, self.peek())))
        }
    }

    fn expr(&mut self) -> Result<Expr, ParseError> {
        self.comparison()
    }

    fn comparison(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.concat()?;
        loop {
            let op = match self.peek() {
                Token::Op(o) => match o.as_str() {
                    "=" => BinOp::Eq,
                    "<>" => BinOp::Ne,
                    "<" => BinOp::Lt,
                    ">" => BinOp::Gt,
                    "<=" => BinOp::Le,
                    ">=" => BinOp::Ge,
                    _ => break,
                },
                _ => break,
            };
            self.next();
            let right = self.concat()?;
            left = Expr::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn concat(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.additive()?;
        while matches!(self.peek(), Token::Op(o) if o == "&") {
            self.next();
            let right = self.additive()?;
            left = Expr::Binary(BinOp::Concat, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn additive(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.term()?;
        loop {
            let op = match self.peek() {
                Token::Op(o) if o == "+" => BinOp::Add,
                Token::Op(o) if o == "-" => BinOp::Sub,
                _ => break,
            };
            self.next();
            let right = self.term()?;
            left = Expr::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn term(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.power()?;
        loop {
            let op = match self.peek() {
                Token::Op(o) if o == "*" => BinOp::Mul,
                Token::Op(o) if o == "/" => BinOp::Div,
                _ => break,
            };
            self.next();
            let right = self.power()?;
            left = Expr::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn power(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.unary()?;
        while matches!(self.peek(), Token::Op(o) if o == "^") {
            self.next();
            let right = self.unary()?;
            left = Expr::Binary(BinOp::Pow, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<Expr, ParseError> {
        match self.peek() {
            Token::Op(o) if o == "-" => {
                self.next();
                let e = self.unary()?;
                Ok(Expr::Neg(Box::new(e)))
            }
            Token::Op(o) if o == "+" => {
                self.next();
                self.unary()
            }
            _ => self.postfix(),
        }
    }

    fn postfix(&mut self) -> Result<Expr, ParseError> {
        let mut e = self.primary()?;
        while self.peek() == &Token::Percent {
            self.next();
            e = Expr::Percent(Box::new(e));
        }
        Ok(e)
    }

    fn primary(&mut self) -> Result<Expr, ParseError> {
        match self.next() {
            Token::Number(n) => {
                // unqualified whole-row range `2:5`
                if self.peek() == &Token::Colon
                    && n.fract() == 0.0
                    && n >= 1.0
                    && matches!(self.tokens.get(self.pos + 1), Some(Token::Number(m)) if m.fract() == 0.0 && *m >= 1.0)
                {
                    self.next();
                    if let Token::Number(m) = self.next() {
                        let r0 = n as u32 - 1;
                        let r1 = m as u32 - 1;
                        return Ok(Expr::Ref(RefExpr {
                            table: None,
                            kind: RefKind::Rows {
                                r0: r0.min(r1),
                                r1: r0.max(r1),
                            },
                        }));
                    }
                }
                Ok(Expr::Num(n))
            }
            Token::Str(s) => Ok(Expr::Str(s)),
            Token::ErrorLit(e) => Ok(Expr::ErrorLit(e)),
            Token::LParen => {
                let e = self.expr()?;
                self.expect(Token::RParen)?;
                Ok(e)
            }
            Token::LBrace => {
                let mut rows: Vec<Vec<Expr>> = vec![vec![]];
                loop {
                    match self.peek() {
                        Token::RBrace => {
                            self.next();
                            break;
                        }
                        Token::Comma => {
                            self.next();
                        }
                        Token::Semicolon => {
                            self.next();
                            rows.push(vec![]);
                        }
                        _ => {
                            let e = self.expr()?;
                            rows.last_mut().unwrap().push(e);
                        }
                    }
                }
                Ok(Expr::Array(rows))
            }
            Token::CellRef {
                col,
                row,
                abs_col,
                abs_row,
            } => self.finish_ref(None, row, col, abs_row, abs_col),
            Token::Bracket(sel) => Ok(column_ref(None, &sel)),
            Token::Quoted(name) => {
                if let Token::Bracket(sel) = self.peek().clone() {
                    self.next();
                    return Ok(column_ref(Some(name), &sel));
                }
                self.expect(Token::DoubleColon)?;
                self.qualified_ref(name)
            }
            Token::Ident(name) => {
                let upper = name.to_ascii_uppercase();
                if let Token::Bracket(sel) = self.peek().clone() {
                    self.next();
                    return Ok(column_ref(Some(name), &sel));
                }
                if self.peek() == &Token::LParen {
                    self.next();
                    let mut args = Vec::new();
                    if self.peek() != &Token::RParen {
                        loop {
                            // allow empty arguments like IF(A1,,"x")
                            if self.peek() == &Token::Comma || self.peek() == &Token::Semicolon {
                                args.push(Expr::Str(String::new()));
                            } else {
                                args.push(self.expr()?);
                            }
                            match self.peek() {
                                Token::Comma | Token::Semicolon => {
                                    self.next();
                                    if self.peek() == &Token::RParen {
                                        args.push(Expr::Str(String::new()));
                                    }
                                }
                                _ => break,
                            }
                        }
                    }
                    self.expect(Token::RParen)?;
                    return Ok(Expr::Call(upper, args));
                }
                if self.peek() == &Token::DoubleColon {
                    self.next();
                    return self.qualified_ref(name);
                }
                match upper.as_str() {
                    "TRUE" => Ok(Expr::Bool(true)),
                    "FALSE" => Ok(Expr::Bool(false)),
                    _ => {
                        // whole-column range like A:C (letters only)
                        if self.peek() == &Token::Colon {
                            if let Some(c0) = crate::model::letters_to_col(&name) {
                                self.next();
                                if let Token::Ident(n2) = self.next() {
                                    if let Some(c1) = crate::model::letters_to_col(&n2) {
                                        return Ok(Expr::Ref(RefExpr {
                                            table: None,
                                            kind: RefKind::Cols {
                                                c0: c0.min(c1),
                                                c1: c0.max(c1),
                                            },
                                        }));
                                    }
                                }
                                return Err(ParseError("bad column range".into()));
                            }
                        }
                        // anything else is a workbook-level name (checked at evaluation time)
                        Ok(Expr::Name(name))
                    }
                }
            }
            t => Err(ParseError(format!("unexpected token {:?}", t))),
        }
    }

    /// After `Name::` — expects a cell ref, range, or whole column/row range.
    fn qualified_ref(&mut self, table: String) -> Result<Expr, ParseError> {
        match self.next() {
            Token::CellRef {
                col,
                row,
                abs_col,
                abs_row,
            } => self.finish_ref(Some(table), row, col, abs_row, abs_col),
            Token::Ident(letters) => {
                let c0 = crate::model::letters_to_col(&letters)
                    .ok_or_else(|| ParseError(format!("bad reference '{}'", letters)))?;
                self.expect(Token::Colon)?;
                match self.next() {
                    Token::Ident(l2) => {
                        let c1 = crate::model::letters_to_col(&l2)
                            .ok_or_else(|| ParseError(format!("bad reference '{}'", l2)))?;
                        Ok(Expr::Ref(RefExpr {
                            table: Some(table),
                            kind: RefKind::Cols {
                                c0: c0.min(c1),
                                c1: c0.max(c1),
                            },
                        }))
                    }
                    t => Err(ParseError(format!("bad column range near {:?}", t))),
                }
            }
            Token::Number(n) => {
                // row range 2:5
                self.expect(Token::Colon)?;
                match self.next() {
                    Token::Number(m) => {
                        let r0 = (n as u32).max(1) - 1;
                        let r1 = (m as u32).max(1) - 1;
                        Ok(Expr::Ref(RefExpr {
                            table: Some(table),
                            kind: RefKind::Rows {
                                r0: r0.min(r1),
                                r1: r0.max(r1),
                            },
                        }))
                    }
                    t => Err(ParseError(format!("bad row range near {:?}", t))),
                }
            }
            t => Err(ParseError(format!("expected reference after '::', found {:?}", t))),
        }
    }

    fn finish_ref(
        &mut self,
        table: Option<String>,
        row: u32,
        col: u32,
        abs_row: bool,
        abs_col: bool,
    ) -> Result<Expr, ParseError> {
        if self.peek() == &Token::Colon {
            self.next();
            match self.next() {
                Token::CellRef {
                    col: c1,
                    row: r1,
                    abs_col: ac1,
                    abs_row: ar1,
                } => Ok(Expr::Ref(RefExpr {
                    table,
                    kind: RefKind::Range {
                        r0: row.min(r1),
                        c0: col.min(c1),
                        r1: row.max(r1),
                        c1: col.max(c1),
                        abs: [abs_row, abs_col, ar1, ac1],
                    },
                })),
                t => Err(ParseError(format!("bad range end {:?}", t))),
            }
        } else {
            Ok(Expr::Ref(RefExpr {
                table,
                kind: RefKind::Cell {
                    row,
                    col,
                    abs_row,
                    abs_col,
                },
            }))
        }
    }
}

// ---------------------------------------------------------------------------
// Printer
// ---------------------------------------------------------------------------

fn fmt_cell(row: u32, col: u32, abs_row: bool, abs_col: bool) -> String {
    format!(
        "{}{}{}{}",
        if abs_col { "$" } else { "" },
        col_to_letters(col),
        if abs_row { "$" } else { "" },
        row + 1
    )
}

fn fmt_table(name: &str) -> String {
    let simple = !name.is_empty()
        && name.chars().all(|c| c.is_alphanumeric() || c == '_')
        && !name.chars().next().unwrap().is_ascii_digit();
    if simple {
        format!("{}::", name)
    } else {
        format!("'{}'::", name.replace('\'', "''"))
    }
}

fn column_ref(table: Option<String>, selector: &str) -> Expr {
    let s = selector.trim();
    let (this_row, name) = match s.strip_prefix('@') {
        Some(rest) => (true, rest.trim().to_string()),
        None => (false, s.to_string()),
    };
    Expr::Ref(RefExpr {
        table,
        kind: RefKind::Column { name, this_row },
    })
}

pub fn ref_to_string(r: &RefExpr) -> String {
    if let RefKind::Column { name, this_row } = &r.kind {
        let tbl = match r.table.as_deref() {
            None => String::new(),
            Some(t) => {
                let simple = !t.is_empty() && t.chars().all(|c| c.is_alphanumeric() || c == '_') && !t.chars().next().unwrap().is_ascii_digit();
                if simple {
                    t.to_string()
                } else {
                    format!("'{}'", t.replace('\'', "''"))
                }
            }
        };
        return format!("{}[{}{}]", tbl, if *this_row { "@" } else { "" }, name.replace(']', "]]"));
    }
    let prefix = r.table.as_deref().map(fmt_table).unwrap_or_default();
    let body = match &r.kind {
        RefKind::Cell {
            row,
            col,
            abs_row,
            abs_col,
        } => fmt_cell(*row, *col, *abs_row, *abs_col),
        RefKind::Range { r0, c0, r1, c1, abs } => format!(
            "{}:{}",
            fmt_cell(*r0, *c0, abs[0], abs[1]),
            fmt_cell(*r1, *c1, abs[2], abs[3])
        ),
        RefKind::Cols { c0, c1 } => format!("{}:{}", col_to_letters(*c0), col_to_letters(*c1)),
        RefKind::Rows { r0, r1 } => format!("{}:{}", r0 + 1, r1 + 1),
        RefKind::Column { .. } => unreachable!(),
    };
    format!("{}{}", prefix, body)
}

fn prec(op: BinOp) -> u8 {
    match op {
        BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Gt | BinOp::Le | BinOp::Ge => 1,
        BinOp::Concat => 2,
        BinOp::Add | BinOp::Sub => 3,
        BinOp::Mul | BinOp::Div => 4,
        BinOp::Pow => 5,
    }
}

fn op_str(op: BinOp) -> &'static str {
    match op {
        BinOp::Add => "+",
        BinOp::Sub => "-",
        BinOp::Mul => "*",
        BinOp::Div => "/",
        BinOp::Pow => "^",
        BinOp::Concat => "&",
        BinOp::Eq => "=",
        BinOp::Ne => "<>",
        BinOp::Lt => "<",
        BinOp::Gt => ">",
        BinOp::Le => "<=",
        BinOp::Ge => ">=",
    }
}

pub fn to_string(e: &Expr) -> String {
    fn go(e: &Expr, parent_prec: u8) -> String {
        match e {
            Expr::Num(n) => crate::model::format_number(*n),
            Expr::Str(s) => format!("\"{}\"", s.replace('"', "\"\"")),
            Expr::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
            Expr::Ref(r) => ref_to_string(r),
            Expr::Call(name, args) => {
                let a: Vec<String> = args.iter().map(|x| go(x, 0)).collect();
                format!("{}({})", name, a.join(", "))
            }
            Expr::Neg(x) => format!("-{}", go(x, 6)),
            Expr::Percent(x) => format!("{}%", go(x, 7)),
            Expr::Binary(op, l, r) => {
                let p = prec(*op);
                let s = format!("{} {} {}", go(l, p), op_str(*op), go(r, p + 1));
                if p < parent_prec {
                    format!("({})", s)
                } else {
                    s
                }
            }
            Expr::Array(rows) => {
                let rs: Vec<String> = rows
                    .iter()
                    .map(|r| r.iter().map(|x| go(x, 0)).collect::<Vec<_>>().join(", "))
                    .collect();
                format!("{{{}}}", rs.join("; "))
            }
            Expr::ErrorLit(e) => e.clone(),
            Expr::Name(n) => n.clone(),
        }
    }
    go(e, 0)
}

/// Rename every table-qualified reference from `old` to `new` (case-insensitive match).
pub fn rename_table_refs(e: &mut Expr, old: &str, new: &str) -> bool {
    let needle = old.trim().to_lowercase();
    let mut changed = false;
    for_each_ref_mut(e, &mut |r| {
        if let Some(t) = &r.table {
            if t.trim().to_lowercase() == needle {
                r.table = Some(new.to_string());
                changed = true;
            }
        }
    });
    changed
}

/// Rewrite references; when `f` returns false the reference becomes `#REF!`.
pub fn map_refs(e: &mut Expr, f: &mut dyn FnMut(&mut RefExpr) -> bool) {
    let replace = match e {
        Expr::Ref(r) => !f(r),
        Expr::Call(_, args) => {
            args.iter_mut().for_each(|a| map_refs(a, f));
            false
        }
        Expr::Neg(x) | Expr::Percent(x) => {
            map_refs(x, f);
            false
        }
        Expr::Binary(_, l, r) => {
            map_refs(l, f);
            map_refs(r, f);
            false
        }
        Expr::Array(rows) => {
            rows.iter_mut().flatten().for_each(|x| map_refs(x, f));
            false
        }
        _ => false,
    };
    if replace {
        *e = Expr::ErrorLit("#REF!".into());
    }
}

/// Visit every reference in the expression (mutable), used by the shifting helpers.
pub fn for_each_ref_mut(e: &mut Expr, f: &mut dyn FnMut(&mut RefExpr)) {
    match e {
        Expr::Ref(r) => f(r),
        Expr::Call(_, args) => args.iter_mut().for_each(|a| for_each_ref_mut(a, f)),
        Expr::Neg(x) | Expr::Percent(x) => for_each_ref_mut(x, f),
        Expr::Binary(_, l, r) => {
            for_each_ref_mut(l, f);
            for_each_ref_mut(r, f);
        }
        Expr::Array(rows) => rows.iter_mut().flatten().for_each(|x| for_each_ref_mut(x, f)),
        _ => {}
    }
}

pub fn for_each_ref(e: &Expr, f: &mut dyn FnMut(&RefExpr)) {
    match e {
        Expr::Ref(r) => f(r),
        Expr::Call(_, args) => args.iter().for_each(|a| for_each_ref(a, f)),
        Expr::Neg(x) | Expr::Percent(x) => for_each_ref(x, f),
        Expr::Binary(_, l, r) => {
            for_each_ref(l, f);
            for_each_ref(r, f);
        }
        Expr::Array(rows) => rows.iter().flatten().for_each(|x| for_each_ref(x, f)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_print_round_trip() {
        for src in [
            "1 + 2 * 3",
            "(1 + 2) * 3",
            "-A1 + $B$2",
            "SUM(A1:B3, 'Table 1'::C1:C9) / COUNT(Sales::A:A)",
            "IF(A1 > 2, \"big\", \"small\")",
            "A1 & \" \" & B1",
            "2 ^ 3 ^ 2",
            "10%",
            "{1, 2; 3, 4}",
            "Sales::2:4",
            "SUM(Orders[Amount]) + [@Unit price] * 'Q3 sales'[Units]",
            "TaxRate * [@Amount]",
        ] {
            let e = parse(src).unwrap();
            let printed = to_string(&e);
            let e2 = parse(&printed).unwrap();
            assert_eq!(e, e2, "{} -> {}", src, printed);
        }
    }

    #[test]
    fn parse_errors() {
        assert!(parse("SUM(").is_err());
        assert!(parse("1 +").is_err());
        assert!(parse("\"unterminated").is_err());
    }
}

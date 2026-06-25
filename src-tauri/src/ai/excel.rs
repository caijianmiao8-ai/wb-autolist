#![allow(dead_code)]
//! Parse the first worksheet of an .xlsx into a 2D array of cell strings
//! (ported from src/lib/excel.ts; exceljs → calamine).

use anyhow::Result;
use calamine::{Data, Reader, Xlsx};
use std::io::Cursor;

pub fn parse_excel(bytes: &[u8]) -> Result<Vec<Vec<String>>> {
    let cursor = Cursor::new(bytes.to_vec());
    let mut wb: Xlsx<_> = Xlsx::new(cursor)?;
    let name = match wb.sheet_names().first().cloned() {
        Some(n) => n,
        None => return Ok(vec![]),
    };
    let range = wb.worksheet_range(&name)?;
    let mut rows: Vec<Vec<String>> = vec![];
    for row in range.rows() {
        let cells: Vec<String> = row.iter().map(cell_text).collect();
        if cells.iter().any(|c| !c.is_empty()) {
            rows.push(cells);
        }
        if rows.len() >= 500 {
            break;
        }
    }
    Ok(rows)
}

fn cell_text(c: &Data) -> String {
    match c {
        Data::Empty | Data::Error(_) => String::new(),
        Data::Float(f) => {
            if f.fract() == 0.0 {
                format!("{}", *f as i64)
            } else {
                f.to_string()
            }
        }
        other => other.to_string().trim().to_string(),
    }
}

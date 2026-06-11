#![allow(dead_code)]
//! EAN-13 barcode generation (ported from src/lib/wb/barcode.ts).
//! WB accepts a seller-provided barcode as a size's SKU. "20" is the in-store
//! prefix range reserved for internal/private use.

use rand::RngCore;

pub fn generate_ean13() -> String {
    let mut digits = String::from("20");
    let mut rnd = [0u8; 10];
    rand::thread_rng().fill_bytes(&mut rnd);
    for b in rnd.iter() {
        digits.push((b'0' + (b % 10)) as char);
    }
    let check = ean13_check_digit(&digits);
    format!("{}{}", digits, check)
}

fn ean13_check_digit(twelve: &str) -> u32 {
    let mut sum = 0u32;
    for (i, c) in twelve.bytes().enumerate() {
        let d = (c - b'0') as u32;
        sum += if i % 2 == 0 { d } else { d * 3 };
    }
    (10 - (sum % 10)) % 10
}

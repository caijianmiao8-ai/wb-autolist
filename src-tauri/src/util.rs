#![allow(dead_code)]
//! Small helpers ported 1:1 from src/lib/util.ts.

use rand::RngCore;
use unicode_normalization::UnicodeNormalization;

pub fn new_id(prefix: &str) -> String {
    let mut b = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut b);
    format!("{}{}", prefix, hex::encode(b))
}

/// Latin-only, uppercase vendor code WB accepts as the seller SKU.
pub fn make_vendor_code(product_name: &str) -> String {
    // NFKD then drop non-ascii (accents) → map non-alnum to '-' → collapse → trim.
    let mapped: String = product_name
        .nfkd()
        .filter(|c| c.is_ascii())
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let mut collapsed = String::new();
    let mut prev_dash = false;
    for c in mapped.chars() {
        if c == '-' {
            if !prev_dash {
                collapsed.push('-');
            }
            prev_dash = true;
        } else {
            collapsed.push(c);
            prev_dash = false;
        }
    }
    let base: String = collapsed
        .trim_matches('-')
        .to_uppercase()
        .chars()
        .take(24)
        .collect();
    let base = if base.is_empty() { "ITEM".to_string() } else { base };

    let mut r = [0u8; 3];
    rand::thread_rng().fill_bytes(&mut r);
    format!("{}-{}", base, hex::encode(r).to_uppercase())
}

pub fn clamp_len(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        return s.to_string();
    }
    let head: String = chars[..max.saturating_sub(1)].iter().collect();
    format!("{}…", head.trim_end())
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The user enters the FINAL price the buyer pays. WB stores a pre-discount base
/// and the buyer pays base×(1-discount). So the base we submit (and strike
/// through on the banner) is finalPrice / (1-discount).
pub fn original_price(final_price: f64, discount_pct: f64) -> f64 {
    let d = discount_pct.clamp(0.0, 99.0);
    if d <= 0.0 {
        final_price.round()
    } else {
        (final_price / (1.0 - d / 100.0)).round()
    }
}

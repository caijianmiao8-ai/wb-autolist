#![allow(dead_code)]
//! Persist generated images to disk and inline them as data URLs for the
//! webview (ported from src/lib/ai/assets.ts; the /api/images route is gone, so
//! the frontend gets `data:` URLs while WB upload reads the on-disk bytes).

use crate::paths::Paths;
use crate::types::GeneratedImage;
use crate::util::new_id;
use base64::Engine;
use std::path::Path;

pub fn save_image(
    paths: &Paths,
    bytes: &[u8],
    kind: &str,
    prompt: &str,
    width: u32,
    height: u32,
    ext: &str,
) -> GeneratedImage {
    paths.ensure();
    let id = new_id("img_");
    let file = format!("{}.{}", id, ext);
    let _ = std::fs::write(paths.images().join(&file), bytes);
    GeneratedImage {
        id,
        kind: kind.to_string(),
        url: file, // bare filename; hydrated to a data URL on the way to the UI
        prompt: prompt.to_string(),
        width,
        height,
    }
}

pub fn content_type_for(file: &str) -> &'static str {
    let lower = file.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        "image/jpeg"
    }
}

/// Read the on-disk file for `url` (a bare filename or path) and return a
/// `data:` URL, or None if missing.
pub fn to_data_url(paths: &Paths, url: &str) -> Option<String> {
    let name = Path::new(url).file_name()?.to_str()?.to_string();
    let bytes = std::fs::read(paths.images().join(&name)).ok()?;
    let mime = content_type_for(&name);
    Some(format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

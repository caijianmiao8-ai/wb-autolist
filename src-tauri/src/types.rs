#![allow(dead_code)]
//! Shared domain types — serde-serialized to the exact camelCase JSON the
//! React frontend already expects (ported 1:1 from src/lib/types.ts).

use serde::{Deserialize, Serialize};

/// AI-generated marketing copy for a product card.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductCopy {
    pub title: String,       // ≤ 60 chars (WB limit)
    pub description: String, // ≤ 2000 chars
    pub bullets: Vec<String>,
    pub brand: String,
    pub keywords: Vec<String>,
    pub category_hint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImage {
    pub id: String,
    pub kind: String, // "main" | "promo" | "gallery"
    pub url: String,
    pub prompt: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ListingStage {
    Draft,
    Queued,
    Creating,
    Media,
    Pricing,
    Live,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageLog {
    pub ts: String,
    pub stage: String, // ListingStage | "generate"
    pub ok: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    // input
    pub product_name: String,
    pub keywords: Vec<String>,
    pub price: f64,
    pub discount: f64,
    pub brand: String,
    // generated
    pub copy: Option<ProductCopy>,
    pub images: Vec<GeneratedImage>,
    // WB resolution
    pub subject_id: Option<i64>,
    pub subject_name: Option<String>,
    pub vendor_code: String,
    // WB result
    pub stage: ListingStage,
    #[serde(rename = "nmID")]
    pub nm_id: Option<i64>,
    #[serde(rename = "imtID")]
    pub imt_id: Option<i64>,
    pub dry_run: bool,
    /// true if created in the WB sandbox (no public buyer page)
    pub sandbox: bool,
    pub logs: Vec<StageLog>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingInput {
    pub product_name: String,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub price: f64,
    #[serde(default)]
    pub discount: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brand: Option<String>,
    /// Free-text styling/instructions injected into the image prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_prompt: Option<String>,
    /// How many images to generate (default 3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_count: Option<u32>,
    /// Real product photos (base64, optionally a data: URL) → img2img base.
    /// Empty → text-to-image.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub base_photos: Vec<String>,
}

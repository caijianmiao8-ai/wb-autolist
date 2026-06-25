#![allow(dead_code)]
//! Wildberries Content API response shapes (subset). Field names follow WB's
//! exact casing (subjectID, charcID, nmID …).

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct WbSubject {
    #[serde(rename = "subjectID")]
    pub subject_id: i64,
    #[serde(rename = "subjectName")]
    pub subject_name: String,
    #[serde(default, rename = "parentID")]
    pub parent_id: i64,
    #[serde(default, rename = "parentName")]
    pub parent_name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WbCharacteristic {
    #[serde(rename = "charcID")]
    pub charc_id: i64,
    #[serde(default, rename = "subjectName")]
    pub subject_name: String,
    #[serde(default, rename = "subjectID")]
    pub subject_id: i64,
    pub name: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default, rename = "unitName")]
    pub unit_name: String,
    #[serde(default, rename = "maxCount")]
    pub max_count: i64,
    #[serde(default)]
    pub popular: bool,
    #[serde(default, rename = "charcType")]
    pub charc_type: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WbColor {
    pub name: String,
    #[serde(default, rename = "parentName")]
    pub parent_name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WbCardListItem {
    #[serde(rename = "nmID")]
    pub nm_id: i64,
    #[serde(default, rename = "imtID")]
    pub imt_id: i64,
    #[serde(default, rename = "vendorCode")]
    pub vendor_code: String,
    #[serde(default, rename = "subjectID")]
    pub subject_id: i64,
    #[serde(default, rename = "subjectName")]
    pub subject_name: String,
    #[serde(default)]
    pub brand: String,
    #[serde(default)]
    pub title: String,
}

#![allow(dead_code)]
//! Editable image-prompt templates. The prompts that drive image generation are
//! NO LONGER hardcoded — they live here as parametric defaults and can be
//! overridden by the user in config.json (client-visible + editable in the UI).
//!
//! A template `body` contains `{PLACEHOLDER}` tokens filled at generation time
//! from the AI copy + a few knobs. `text_mode = "overlay"` means the model is
//! asked for a clean (text-free) visual and the critical Russian text is
//! composited deterministically (resvg) on top — perfect Cyrillic for exact
//! numbers / long banners where the model would otherwise garble glyphs.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageTemplate {
    /// stable id, e.g. "main","hero","food_grid","scene","guarantee","dimensions"
    pub kind: String,
    /// WB media slot: "main" | "promo" | "gallery"
    pub slot: String,
    /// 中文 label shown in progress + the editor
    pub label: String,
    /// parametric prompt with {PLACEHOLDER} tokens
    pub body: String,
    /// "model" (model renders text) | "overlay" (resvg overlays exact text)
    #[serde(default = "mode_model")]
    pub text_mode: String,
    /// included in the default rotation / available for use
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn mode_model() -> String {
    "model".into()
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageTemplates {
    pub version: u32,
    /// order of kinds to cycle when generating N images
    pub rotation: Vec<String>,
    pub templates: Vec<ImageTemplate>,
}

impl ImageTemplates {
    pub fn get(&self, kind: &str) -> Option<&ImageTemplate> {
        self.templates.iter().find(|t| t.kind == kind)
    }

    /// Pick N templates by cycling the enabled rotation (index 0 is always the
    /// WB main slot). Falls back to any enabled template if the rotation is empty.
    pub fn plan(&self, n: usize) -> Vec<ImageTemplate> {
        let mut enabled: Vec<ImageTemplate> = self
            .rotation
            .iter()
            .filter_map(|k| self.get(k))
            .filter(|t| t.enabled)
            .cloned()
            .collect();
        if enabled.is_empty() {
            enabled = self.templates.iter().filter(|t| t.enabled).cloned().collect();
        }
        if enabled.is_empty() {
            return vec![];
        }
        let n = n.clamp(1, 12);
        (0..n).map(|i| enabled[i % enabled.len()].clone()).collect()
    }
}

/// Substitute `{KEY}` tokens from `ctx` (keys are UPPERCASE). Unfilled tokens are
/// stripped; whitespace is collapsed. If the body never references `{CUSTOM}`,
/// the custom text is appended once at the end (so a user can place it inline
/// without getting it twice).
pub fn fill(body: &str, ctx: &HashMap<String, String>) -> String {
    let mut out = body.to_string();
    for (k, v) in ctx {
        out = out.replace(&format!("{{{}}}", k), v);
    }
    let referenced_custom = body.contains("{CUSTOM}");
    out = strip_tokens(&out);
    out = collapse_ws(&out);
    if !referenced_custom {
        if let Some(c) = ctx.get("CUSTOM").map(|s| s.trim()).filter(|s| !s.is_empty()) {
            out.push(' ');
            out.push_str(c);
        }
    }
    out.trim().to_string()
}

/// Remove any leftover `{TOKEN}` (UPPERCASE/digits/underscore) the ctx didn't
/// fill. UTF-8 safe — operates on chars, never bytes (the string already holds
/// substituted Cyrillic/中文).
fn strip_tokens(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '{' {
            if let Some(rel) = chars[i + 1..].iter().position(|&c| c == '}') {
                let inner: String = chars[i + 1..i + 1 + rel].iter().collect();
                if !inner.is_empty()
                    && inner.chars().all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit())
                {
                    i = i + 1 + rel + 1; // skip the whole {TOKEN}
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for ch in s.chars() {
        let is_ws = ch.is_whitespace();
        if is_ws {
            if !prev_space {
                out.push(' ');
            }
            prev_space = true;
        } else {
            // drop a space that sits right before sentence punctuation
            if matches!(ch, '.' | ',' | '!' | '?' | ';' | ':') && out.ends_with(' ') {
                out.pop();
            }
            out.push(ch);
            prev_space = false;
        }
    }
    out
}

const GUARD: &str = "Accurate, perfectly legible Russian typography; keep every label to 1-2 words; no paragraphs, no duplicated text, no price. Clean premium Wildberries retail style, soft studio lighting, sharp focus, high resolution.";

/// The built-in defaults — the single source of truth for first-run + reset.
/// Validated wording (red banner / kept product / icon callouts / benefit glow).
pub fn built_in_defaults() -> ImageTemplates {
    let t = |kind: &str, slot: &str, label: &str, mode: &str, enabled: bool, body: String| ImageTemplate {
        kind: kind.into(),
        slot: slot.into(),
        label: label.into(),
        body,
        text_mode: mode.into(),
        enabled,
    };
    ImageTemplates {
        // v2: redesigned defaults — the MAIN image is now a designed card (NOT plain
        // white; real WB listings all have text/design), plus a deeper rotation so 8–10
        // images stay varied. Bumping the version makes config.rs swap any stored v1
        // defaults for these (active_templates version-gate).
        version: 2,
        rotation: vec![
            "main".into(), "hero".into(), "features".into(), "result".into(), "scene".into(),
            "detail".into(), "dimensions".into(), "package".into(), "guarantee".into(), "how_to".into(),
        ],
        templates: vec![
            // 1) MAIN — designed lead image: product big on a soft accent-tinted backdrop
            // (never stark white), a short headline + ONE benefit chip. Tasteful, uncluttered.
            t("main", "main", "主图(设计)", "model", true, format!(
                "Keep THIS exact product unchanged (real shape, color, proportions). A premium Wildberries MAIN product image, vertical 3:4: the product LARGE and centered on a soft {{ACCENT}}-tinted gradient studio backdrop (NOT plain white), gentle realistic shadow. A short bold Russian headline «{{TITLE}}» near the top and ONE small benefit chip «{{KEY_BENEFIT}}». Clean, premium, uncluttered, modern e-commerce. {GUARD} {{CUSTOM}}"
            )),
            // 2) HERO — selling-point infographic (banner + side callouts).
            t("hero", "promo", "卖点信息图", "model", true, format!(
                "Using THIS exact product (keep its real shape and color unchanged), create a vertical 3:4 Wildberries product infographic. A bold {{ACCENT}} banner across the top with a large white Russian headline «{{TITLE}}». Down one side, {{N}} short Russian benefit callouts, each with a small clean line icon: {{CALLOUTS}}. Subtly emphasize the key benefit ({{KEY_BENEFIT}}) with a tasteful graphic hint. {GUARD} {{CUSTOM}}"
            )),
            // 3) FEATURES — labelled feature highlights pointing at the product.
            t("features", "gallery", "功能特性", "model", true, format!(
                "Using THIS exact product, create a vertical 3:4 Wildberries feature infographic. A {{ACCENT}} top banner «{{TITLE}}». Keep the exact product centered/large with {{N}} thin callout lines pointing to its parts, each with a 1-2 word Russian label and tiny icon: {{CALLOUTS}}. {GUARD}"
            )),
            // 4) RESULT — what the product produces / is used for (generic by category).
            t("result", "gallery", "成品/效果", "model", true, format!(
                "Using THIS exact product, create a vertical 3:4 Wildberries infographic. A {{ACCENT}} top banner with a short white Russian headline «{{TITLE}}». Below it a clean 2x2 grid showing great results/uses of a {{CATEGORY}}: {{SCENE}}. Place a small inset of this exact product in one corner. Vivid professional photography. {GUARD}"
            )),
            // 5) SCENE — lifestyle / in-context.
            t("scene", "gallery", "生活场景", "model", true, format!(
                "Using THIS exact product (unchanged), create a vertical 3:4 Wildberries lifestyle infographic. Place it naturally in {{SCENE}}, premium photography, warm natural light. Add a {{ACCENT}} banner with a short white Russian headline «{{TITLE}}». Place a small clean inset of this exact product in a top corner. {GUARD}"
            )),
            // 6) DETAIL — macro close-up of material/quality with 1-2 labels.
            t("detail", "gallery", "细节特写", "model", true, format!(
                "Using THIS exact product (unchanged), create a vertical 3:4 Wildberries detail shot: a premium macro close-up emphasizing the material/texture/build quality. One small {{ACCENT}} label with a 1-2 word Russian caption about the key material or feature. Sharp, premium. {GUARD}"
            )),
            // 7) DIMENSIONS — clean shot with empty margins; crisp numbers added via overlay.
            t("dimensions", "gallery", "尺寸图", "overlay", true, format!(
                "Keep THIS exact product unchanged. Clean, soft {{ACCENT}}-tinted studio photo of the product, centered, leaving generous empty margins on the right and bottom for dimension labels. Soft shadow, NO text, NO numbers. {GUARD}"
            )),
            // 8) PACKAGE — what's in the box (комплектация flat-lay).
            t("package", "gallery", "包装清单", "model", true, format!(
                "Using THIS exact product, create a vertical 3:4 Wildberries 'in the box' infographic: a neat top-down flat-lay of the product with its included items, each tagged with a small 1-2 word Russian label: {{CALLOUTS}}. A {{ACCENT}} top banner «{{TITLE}}». {GUARD}"
            )),
            // 9) GUARANTEE — trust badges.
            t("guarantee", "gallery", "质保徽章", "model", true, format!(
                "Using THIS exact product, create a vertical 3:4 Wildberries trust infographic. A {{ACCENT}} top banner «{{TITLE}}». Show {{N}} round trust badges with a small icon and a 1-2 word Russian label each: {{CALLOUTS}}. Keep the exact product centered. {GUARD}"
            )),
            // 10) HOW-TO — 3 numbered steps.
            t("how_to", "gallery", "三步用法", "model", true, format!(
                "Using THIS exact product, create a vertical 3:4 Wildberries 'how to use' infographic. A {{ACCENT}} top banner «{{TITLE}}». Three numbered steps stacked vertically, each a small clean illustration with a 2-3 word Russian caption. Keep the exact product visible. {GUARD}"
            )),
            // ── extra (off by default) ──
            t("comparison", "gallery", "对比图", "model", false, format!(
                "Using THIS exact product, create a vertical 3:4 Wildberries comparison infographic. A {{ACCENT}} top banner «{{TITLE}}». Two columns: «обычный» (ordinary, dull) vs «наш» (ours, bright, this exact product) with a few short Russian labels and check/cross icons. {GUARD}"
            )),
            t("main_white", "main", "主图(纯白·备用)", "model", false, format!(
                "Keep THIS exact product unchanged (real shape, color, proportions). Clean white studio e-commerce product photo, the product centered and large, soft natural shadow, premium, NO text. {GUARD}"
            )),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(custom: &str) -> HashMap<String, String> {
        let mut m = HashMap::new();
        m.insert("TITLE".into(), "Вафельница 750 Вт".into());
        m.insert("ACCENT".into(), "red".into());
        m.insert("CUSTOM".into(), custom.into());
        m
    }

    #[test]
    fn fill_keeps_cyrillic_and_strips_unknown() {
        // {TITLE} → Cyrillic; {MISSING} stripped; UTF-8 must survive intact.
        let out = fill("A {ACCENT} banner «{TITLE}» {MISSING} end.", &ctx(""));
        assert!(out.contains("Вафельница 750 Вт"), "cyrillic corrupted: {out}");
        assert!(out.contains("red banner"));
        assert!(!out.contains("{MISSING}") && !out.contains("MISSING"));
        assert!(!out.contains("{TITLE}"));
    }

    #[test]
    fn custom_appended_once_when_not_referenced() {
        let out = fill("Make it nice.", &ctx("青绿配色"));
        assert!(out.ends_with("青绿配色"));
        assert_eq!(out.matches("青绿配色").count(), 1);
    }

    #[test]
    fn custom_inline_not_duplicated() {
        let out = fill("Style: {CUSTOM}. Done.", &ctx("минимализм"));
        assert_eq!(out.matches("минимализм").count(), 1, "{out}");
    }

    #[test]
    fn defaults_have_main_first_and_parse() {
        let d = built_in_defaults();
        assert_eq!(d.rotation.first().map(|s| s.as_str()), Some("main"));
        let plan = d.plan(3);
        assert_eq!(plan.len(), 3);
        assert_eq!(plan[0].slot, "main");
        // a round-trip through JSON (config storage) must preserve everything
        let j = serde_json::to_string(&d).unwrap();
        let back: ImageTemplates = serde_json::from_str(&j).unwrap();
        assert_eq!(back.templates.len(), d.templates.len());
    }
}

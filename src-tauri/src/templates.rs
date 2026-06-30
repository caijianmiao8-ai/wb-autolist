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
    /// "builtin" = shipped defaults (may be replaced when the app ships newer
    /// defaults). "user" = explicitly edited & saved in the editor → owned by the
    /// user, never auto-overridden. Older configs predate this field → serde
    /// defaults to "builtin", so a stale frozen-default set gets refreshed once.
    #[serde(default = "src_builtin")]
    pub source: String,
    /// order of kinds to cycle when generating N images
    pub rotation: Vec<String>,
    pub templates: Vec<ImageTemplate>,
}

fn src_builtin() -> String {
    "builtin".into()
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

// Shared style guard appended to every template. KEY architecture decision: the
// image model renders ONLY a clean, text-free photo; ALL titles/chips/badges/
// labels are composited afterward by code (resvg → perfect Cyrillic). So the
// guard FORBIDS the model from drawing any text (that's what garbles), and pins
// one cohesive soft {ACCENT}-tinted light look across the whole set. The literal
// "{ACCENT}" survives format! (argument data, not a format token) and is filled
// at render time.
const GUARD: &str = "Soft, clean studio background with a subtle {ACCENT} tint (NEVER pure white), one cohesive premium Wildberries look across the set, soft even lighting, sharp focus, high resolution. CRITICAL: render NO text, letters, words, numbers, logos, captions, icons, badges or watermarks anywhere in the image — leave tidy empty space instead; all text is added separately.";

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
        // v4: reference-grounded + overlay-driven. v3 chased a different LAYOUT per
        // image AND asked the image model to draw text/icons/grids — both wrong: the
        // model garbles Cyrillic + the set looks incoherent. Real top WB listings
        // (studied the Scarlett вафельница listing) are clean PHOTOS with text/chips
        // overlaid by a designer. So here the model makes only a clean text-free
        // photo and CODE composites perfect-Cyrillic text via `text_mode`:
        //   overlay        = headline + benefit chips   (infographic cards)
        //   overlay_header = headline only              (photo + title)
        //   overlay_badge  = one small accent badge      (photo-forward)
        //   clean          = no overlay                  (pure photo / dimensions)
        // Cohesion comes from one shared accent (photo tint + overlay color) and one
        // overlay style system; variety comes from the TOPIC, not the layout. Three
        // cards put a real PERSON with the product (inuse/scene/lifestyle).
        version: 4,
        source: "builtin".into(),
        rotation: vec![
            "main".into(), "benefits".into(), "inuse".into(), "scene".into(), "result".into(),
            "lifestyle".into(), "variety".into(), "dimensions".into(), "package".into(), "guarantee".into(),
        ],
        templates: vec![
            // 1) MAIN — clean big product shot; code overlays title + spec chips.
            t("main", "main", "主图·规格", "overlay", true, format!(
                "Keep THIS exact product unchanged (real shape, color, proportions). Premium Wildberries MAIN product photo, vertical 3:4: the product LARGE and clearly centered, gentle realistic shadow, generous clean empty space at the TOP and BOTTOM. {GUARD} {{CUSTOM}}"
            )),
            // 2) BENEFITS — clean product shot; code overlays title + benefit chips.
            t("benefits", "promo", "卖点信息图", "overlay", true, format!(
                "Using THIS exact product, a clean premium vertical 3:4 product shot: the product shown clearly and large with lots of tidy empty space around it (top and bottom kept clear for a title and benefit chips). {GUARD} {{CUSTOM}}"
            )),
            // 3) IN-USE — PHOTO of hands using the product; code overlays a small badge.
            t("inuse", "gallery", "实拍·使用中", "overlay_badge", true, format!(
                "Using THIS exact product (unchanged), a premium vertical 3:4 PHOTO of the product BEING USED — a person's hands actively using it for its main purpose, a real in-use moment for a {{CATEGORY}}; realistic natural hands. Warm, inviting, keep the top corners clean. {GUARD}"
            )),
            // 4) SCENE — PHOTO of a person using it at home; code overlays a small badge.
            t("scene", "gallery", "生活场景", "overlay_badge", true, format!(
                "Using THIS exact product (unchanged), a premium vertical 3:4 lifestyle photo: a real person using the product naturally in a tidy modern home ({{SCENE}}), warm natural light, candid; realistic, undistorted face and hands. Keep the top corners clean. {GUARD}"
            )),
            // 5) RESULT — PHOTO of the appealing result; code overlays the title.
            t("result", "gallery", "效果展示", "overlay_header", true, format!(
                "Using THIS exact product, a premium vertical 3:4 photo showcasing the appealing RESULT it delivers — the end result/output of a {{CATEGORY}}: {{SCENE}}. Vivid, professional, keep the top clear for a title. {GUARD}"
            )),
            // 6) LIFESTYLE — candid PHOTO of a happy person with the product (people sell).
            t("lifestyle", "gallery", "人物·生活", "overlay_badge", true, format!(
                "Using THIS exact product, a premium vertical 3:4 candid lifestyle photo: a happy real person enjoying or presenting the product at home, natural relaxed pose, warm light; realistic, undistorted face and hands. Keep the top corners clean. {GUARD}"
            )),
            // 7) VARIETY — ONE clean assortment photo (NOT a model-drawn grid); title overlaid.
            t("variety", "gallery", "用途/款式", "overlay_header", true, format!(
                "Using THIS exact product, a premium vertical 3:4 photo showing an attractive ASSORTMENT of the results/uses of a {{CATEGORY}}: {{SCENE}}, arranged appealingly together as ONE cohesive photo (not a grid, no panels). Keep the top clear for a title. {GUARD}"
            )),
            // 8) DIMENSIONS — clean shot with empty margins (numbers added separately).
            t("dimensions", "gallery", "尺寸图", "clean", true, format!(
                "Keep THIS exact product unchanged. A clean, simple vertical 3:4 studio photo of the product, centered, with generous empty margins on the right and bottom for dimension labels added later. Soft shadow. {GUARD}"
            )),
            // 9) PACKAGE — clean flat-lay of in-the-box items; code overlays the title.
            t("package", "gallery", "开箱清单", "overlay_header", true, format!(
                "Using THIS exact product, a clean vertical 3:4 top-down flat-lay of the product with its included accessories, evenly spaced with generous spacing on a tidy surface. Keep the top clear for a title. {GUARD}"
            )),
            // 10) GUARANTEE — clean reassuring product shot; code overlays title + chips.
            t("guarantee", "gallery", "信任保障", "overlay", true, format!(
                "Using THIS exact product, a clean premium vertical 3:4 product shot on a calm, reassuring background, the product centered with tidy empty space at the top and bottom (for a title and trust chips). {GUARD}"
            )),
            // ── extra (off by default; editable/enable-able in the editor) ──
            t("detail", "gallery", "材质细节(备用)", "overlay_badge", false, format!(
                "Using THIS exact product (unchanged), a premium vertical 3:4 macro detail photo: a close-up emphasizing the material, texture and build quality. Sharp, tactile, keep a top corner clean. {GUARD}"
            )),
            t("main_white", "main", "主图·纯白(备用)", "clean", false, format!(
                "Keep THIS exact product unchanged (real shape, color, proportions). Clean white studio e-commerce product photo, the product centered and large, soft natural shadow, premium. {GUARD}"
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
        assert_eq!(d.source, "builtin");
        let plan = d.plan(3);
        assert_eq!(plan.len(), 3);
        assert_eq!(plan[0].slot, "main");
        // a round-trip through JSON (config storage) must preserve everything
        let j = serde_json::to_string(&d).unwrap();
        let back: ImageTemplates = serde_json::from_str(&j).unwrap();
        assert_eq!(back.templates.len(), d.templates.len());
        assert_eq!(back.source, "builtin");
    }

    #[test]
    fn five_eight_ten_are_all_distinct() {
        // The whole point of v3: 5/8/10 must never repeat a kind (v2's deeper
        // rotation could still feel samey; here we assert NO cycling at all).
        let d = built_in_defaults();
        for n in [5usize, 8, 10] {
            let mut kinds: Vec<String> = d.plan(n).iter().map(|t| t.kind.clone()).collect();
            assert_eq!(kinds.len(), n);
            kinds.sort();
            kinds.dedup();
            assert_eq!(kinds.len(), n, "plan({n}) repeated a kind");
        }
    }

    #[test]
    fn guard_accent_is_filled_no_leftover_tokens() {
        // GUARD embeds a literal {ACCENT}; after fill() nothing braces-shaped may
        // survive, and the accent must actually appear in the prompt.
        let d = built_in_defaults();
        let main = d.get("main").unwrap();
        let out = fill(&main.body, &ctx(""));
        assert!(out.contains("red"), "accent not filled: {out}");
        assert!(!out.contains('{') && !out.contains('}'), "leftover token: {out}");
        assert!(!out.contains("ACCENT"));
    }

    #[test]
    fn source_defaults_to_builtin_for_old_configs() {
        // A stored set saved BEFORE the `source` field existed must deserialize
        // as "builtin" (so active_templates refreshes it to current defaults).
        let legacy = r#"{"version":2,"rotation":["main"],"templates":[]}"#;
        let t: ImageTemplates = serde_json::from_str(legacy).unwrap();
        assert_eq!(t.source, "builtin");
    }
}

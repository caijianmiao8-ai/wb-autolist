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

// Shared style guard appended to every template. The default image model is
// gpt-image-2, which renders Russian text + icons cleanly (verified: headlines,
// multi-word labels and lifestyle badges all came out correctly), so we LET the
// model draw the text and only ask it to spell correctly + keep labels short.
// Cohesion is pinned by one shared soft {ACCENT}-tinted light background +
// consistent {ACCENT} accents. The literal "{ACCENT}" survives format! (argument
// data, not a format token) and is filled at render time.
// (The resvg code-overlay path still exists for the optional overlay_* text_modes
// — useful for weaker fallback models — but the defaults below use the model.)
const GUARD: &str = "One cohesive premium Wildberries look across the whole set: a soft {ACCENT}-tinted light background (NEVER pure white) with consistent {ACCENT} design accents, soft even lighting, sharp focus, high resolution. Render any Russian text crisply and SPELLED CORRECTLY; keep labels short (1-4 words), no paragraphs, no price, no watermark. People must have realistic, natural, undistorted faces and hands.";

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
        // v5: model-rendered text. Verified that gpt-image-2 (the default provider)
        // renders Russian headlines, multi-word labels, icons and lifestyle badges
        // cleanly — so v4's "model draws no text, code overlays everything" was the
        // wrong call (it made plainer images than the model can do natively). v5 lets
        // the model draw the designed text/icons, using CLEAN, PROVEN layouts (top
        // accent banner + product + side icon-labels; lifestyle photo + corner badge)
        // and getting variety from the TOPIC, with one shared accent for cohesion.
        // Three cards put a real PERSON with the product (inuse/scene/lifestyle).
        // (The resvg overlay_* modes still exist as an option for weaker models.)
        version: 5,
        source: "builtin".into(),
        rotation: vec![
            "main".into(), "benefits".into(), "inuse".into(), "scene".into(), "result".into(),
            "lifestyle".into(), "variety".into(), "detail".into(), "package".into(), "guarantee".into(),
        ],
        templates: vec![
            // 1) MAIN — designed lead: product large + accent banner title + a few chips.
            t("main", "main", "主图·规格", "model", true, format!(
                "Keep THIS exact product unchanged (real shape, color, proportions). Premium Wildberries MAIN image, vertical 3:4: the exact product LARGE and centered with a gentle shadow. A clean {{ACCENT}} banner at the top with a short bold white Russian title «{{TITLE}}», and 2-3 small rounded {{ACCENT}} spec chips «{{CALLOUTS}}». Uncluttered, premium. {GUARD} {{CUSTOM}}"
            )),
            // 2) BENEFITS — the verified infographic: banner + product + side icon-labels.
            t("benefits", "promo", "卖点信息图", "model", true, format!(
                "Using THIS exact product (keep its real shape and color), a vertical 3:4 Wildberries infographic: a clean {{ACCENT}} banner at the top with a short bold white Russian title «{{TITLE}}»; the exact product centered; down ONE side a column of {{N}} rounded white cards, each with a small {{ACCENT}} line icon and a short Russian label: {{CALLOUTS}}. Clean, modern, evenly spaced. {GUARD} {{CUSTOM}}"
            )),
            // 3) IN-USE — hands actively using the product (people sell on WB).
            t("inuse", "gallery", "实拍·使用中", "model", true, format!(
                "Using THIS exact product (unchanged), a premium vertical 3:4 PHOTO of a person's hands actively using it for its main purpose — a real in-use moment for a {{CATEGORY}}; realistic natural hands. A small rounded {{ACCENT}} corner badge with a short Russian caption «{{KEY_BENEFIT}}». Warm, realistic. {GUARD}"
            )),
            // 4) SCENE — a real person using it at home (verified-good layout).
            t("scene", "gallery", "生活场景·人物", "model", true, format!(
                "Using THIS exact product (unchanged), a premium vertical 3:4 lifestyle photo: a real, happy person using the product naturally in a bright modern home ({{SCENE}}), warm natural light, candid. A small rounded {{ACCENT}} corner badge with a short Russian caption «{{KEY_BENEFIT}}». {GUARD}"
            )),
            // 5) RESULT — the appealing result + accent banner title.
            t("result", "gallery", "效果展示", "model", true, format!(
                "Using THIS exact product, a premium vertical 3:4 image showcasing the appealing RESULT it delivers — the end result/output of a {{CATEGORY}}: {{SCENE}}. A clean {{ACCENT}} banner with a short Russian title «{{TITLE}}». Vivid, professional. {GUARD}"
            )),
            // 6) LIFESTYLE — candid person enjoying/presenting the product.
            t("lifestyle", "gallery", "人物·生活", "model", true, format!(
                "Using THIS exact product, a premium vertical 3:4 candid lifestyle photo: a happy real person enjoying or presenting the product at home, natural relaxed pose, warm light. A small rounded {{ACCENT}} corner badge with a short Russian caption «{{KEY_BENEFIT}}». {GUARD}"
            )),
            // 7) VARIETY — the assortment of uses/results + banner title.
            t("variety", "gallery", "用途/款式", "model", true, format!(
                "Using THIS exact product, a vertical 3:4 Wildberries image: a clean {{ACCENT}} banner with a short Russian title «{{TITLE}}», showing an attractive variety of the results/uses of a {{CATEGORY}}: {{SCENE}}, arranged appealingly (a tidy 2x2 layout or assortment) with a short Russian label on each. {GUARD}"
            )),
            // 8) DETAIL — macro of material/build + one small label.
            t("detail", "gallery", "材质细节", "model", true, format!(
                "Using THIS exact product (unchanged), a premium vertical 3:4 macro detail shot: a close-up emphasizing the material, texture and build quality. One small rounded {{ACCENT}} label with a short Russian caption about the key material/feature. Sharp, tactile. {GUARD}"
            )),
            // 9) PACKAGE — in-the-box flat-lay with short labels (комплектация).
            t("package", "gallery", "开箱清单", "model", true, format!(
                "Using THIS exact product, a clean vertical 3:4 'in the box' (комплектация) image: a neat top-down flat-lay of the product with its included accessories, evenly spaced, each with a short Russian label: {{CALLOUTS}}. A small {{ACCENT}} banner with a short Russian title «{{TITLE}}». Tidy. {GUARD}"
            )),
            // 10) GUARANTEE — calm trust/service card with round badges.
            t("guarantee", "gallery", "信任保障", "model", true, format!(
                "Using THIS exact product, a vertical 3:4 Wildberries trust/service card: a clean {{ACCENT}} banner with a short Russian title «{{TITLE}}» and {{N}} round trust badges, each a small icon + short Russian label: {{CALLOUTS}}. Calm and reassuring. {GUARD}"
            )),
            // ── extra (off by default; enable/edit in the editor) ──
            t("comparison", "gallery", "对比图(备用)", "model", false, format!(
                "Using THIS exact product, a vertical 3:4 Wildberries comparison image. A small {{ACCENT}} header «{{TITLE}}». Two clean columns: «обычный» (ordinary, dull) vs «наш» (ours — this exact product, bright), a few short Russian labels and green check / grey cross icons. {GUARD}"
            )),
            // Numbers should come from real measurements; until those are fed in, this
            // uses the resvg overlay path. Off by default.
            t("dimensions", "gallery", "尺寸图(备用)", "clean", false, format!(
                "Keep THIS exact product unchanged. A clean, simple vertical 3:4 studio photo of the product, centered, with generous empty margins on the right and bottom for dimension labels added later. Soft shadow, no text. {GUARD}"
            )),
            t("main_white", "main", "主图·纯白(备用)", "clean", false, format!(
                "Keep THIS exact product unchanged (real shape, color, proportions). Clean white studio e-commerce product photo, the product centered and large, soft natural shadow, premium, no text. {GUARD}"
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

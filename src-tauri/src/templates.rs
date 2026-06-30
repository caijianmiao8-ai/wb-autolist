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
        // v3: diversified defaults. v2 had 4 near-identical "top {ACCENT} banner +
        // «TITLE» + N icon callouts" templates (hero/features/package/guarantee) that
        // all stamped the SAME headline banner → the set FELT repetitive even at 10
        // distinct kinds. v3 gives each kind a different COMPOSITION (split panel /
        // annotation diagram / immersive photo / macro / comparison / flat-lay / grid
        // / steps / badge strip) and stops repeating the big banner. The pure-white
        // main stays disabled (real WB listings are designed, not blank white).
        version: 3,
        source: "builtin".into(),
        // Front-loaded so even 5 images already span 5 very different looks.
        rotation: vec![
            "main".into(), "hero".into(), "features".into(), "scene".into(), "detail".into(),
            "comparison".into(), "dimensions".into(), "package".into(), "result".into(),
            "how_to".into(), "guarantee".into(),
        ],
        templates: vec![
            // 1) MAIN — designed lead card: product big on a soft accent backdrop
            // (never stark white), short headline + ONE benefit chip. Uncluttered.
            t("main", "main", "主图·设计", "model", true, format!(
                "Keep THIS exact product unchanged (real shape, color, proportions). A premium Wildberries MAIN image, vertical 3:4: the product LARGE and centered on a soft {{ACCENT}}-tinted gradient studio backdrop (NEVER plain white), gentle realistic shadow. A short bold Russian headline «{{TITLE}}» near the top and ONE small rounded benefit chip «{{KEY_BENEFIT}}». Uncluttered, modern, premium. {GUARD} {{CUSTOM}}"
            )),
            // 2) HERO — SPLIT layout: product half + solid accent panel half. The big
            // headline lives in the side panel (not a top banner) → distinct silhouette.
            t("hero", "promo", "核心卖点·分栏", "model", true, format!(
                "Using THIS exact product (keep its real shape and color), a vertical 3:4 Wildberries infographic with a SPLIT layout: the product photographed large on one half; a solid {{ACCENT}} vertical panel on the other half carrying a big white Russian headline «{{TITLE}}» and {{N}} short benefit lines, each with a small clean line icon: {{CALLOUTS}}. Bold, high-contrast, modern. {GUARD} {{CUSTOM}}"
            )),
            // 3) FEATURES — annotation diagram: callout LINES to parts, NO big banner.
            t("features", "gallery", "功能标注", "model", true, format!(
                "Using THIS exact product, a vertical 3:4 Wildberries feature-callout image: the exact product centered and large on a clean soft {{ACCENT}}-tinted background, with {{N}} thin callout lines pointing to different parts, each ending in a 1-2 word Russian label and a tiny icon: {{CALLOUTS}}. No big banner — airy and technical. {GUARD}"
            )),
            // 4) SCENE — immersive lifestyle photo, NO banner, only a tiny corner chip.
            t("scene", "gallery", "生活场景", "model", true, format!(
                "Using THIS exact product (unchanged), a vertical 3:4 premium lifestyle photo: the product used naturally in {{SCENE}}, warm natural light, shallow depth of field, real environment. Only a tiny {{ACCENT}} corner chip «{{KEY_BENEFIT}}» — NO large banner, let the photo breathe. {GUARD}"
            )),
            // 5) DETAIL — extreme macro of material/build, one tiny caption.
            t("detail", "gallery", "材质细节", "model", true, format!(
                "Using THIS exact product (unchanged), a vertical 3:4 Wildberries macro detail shot: an extreme close-up emphasizing the material, texture and build quality. One small {{ACCENT}} caption with a 1-2 word Russian label about the key material/feature. Sharp, tactile, premium. {GUARD}"
            )),
            // 6) COMPARISON — two-column обычный/наш (now enabled — distinct & persuasive).
            t("comparison", "gallery", "对比图", "model", true, format!(
                "Using THIS exact product, a vertical 3:4 Wildberries comparison image. A small {{ACCENT}} header «{{TITLE}}». Two clean columns: «обычный» (an ordinary, dull alternative) on the left vs «наш» (ours — this exact product, bright and appealing) on the right, with a few short Russian labels and green check / grey cross icons. {GUARD}"
            )),
            // 7) DIMENSIONS — clean shot with empty margins; crisp numbers via overlay.
            t("dimensions", "gallery", "尺寸图", "overlay", true, format!(
                "Keep THIS exact product unchanged. Clean, soft {{ACCENT}}-tinted studio photo of the product, centered, leaving generous empty margins on the right and bottom for dimension labels. Soft shadow. NO text, NO numbers. {GUARD}"
            )),
            // 8) PACKAGE — top-down flat-lay of in-the-box items (комплектация).
            t("package", "gallery", "开箱清单", "model", true, format!(
                "Using THIS exact product, a vertical 3:4 Wildberries 'in the box' (комплектация) image: a neat top-down flat-lay of the product with all included items arranged on a soft {{ACCENT}}-tinted surface, each item tagged with a small 1-2 word Russian label: {{CALLOUTS}}. Tidy, premium. {GUARD}"
            )),
            // 9) RESULT — 2x2 grid of results/uses with a small product inset.
            t("result", "gallery", "效果/成品", "model", true, format!(
                "Using THIS exact product, a vertical 3:4 Wildberries results image. A small {{ACCENT}} top banner «{{TITLE}}». A clean 2x2 grid showing great results/uses of a {{CATEGORY}}: {{SCENE}}. Place a small inset of this exact product in one corner. Vivid professional photography. {GUARD}"
            )),
            // 10) HOW-TO — 3 numbered steps.
            t("how_to", "gallery", "三步用法", "model", true, format!(
                "Using THIS exact product, a vertical 3:4 Wildberries 'how to use' image. A small {{ACCENT}} top banner «{{TITLE}}». Three numbered steps stacked vertically, each a small clean illustration with a 2-3 word Russian caption. Keep the exact product visible. {GUARD}"
            )),
            // 11) GUARANTEE — distinct framing: product up top, trust badges along the BOTTOM.
            t("guarantee", "gallery", "信任保障", "model", true, format!(
                "Using THIS exact product, a vertical 3:4 Wildberries trust image: the exact product large in the upper area on a soft {{ACCENT}}-tinted background with a short Russian headline «{{TITLE}}», and ALONG THE BOTTOM a calm row of {{N}} round trust badges, each a small icon + 1-2 word Russian label: {{CALLOUTS}}. {GUARD}"
            )),
            // ── extra (off by default) ──
            t("main_white", "main", "主图·纯白(备用)", "model", false, format!(
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
    fn source_defaults_to_builtin_for_old_configs() {
        // A stored set saved BEFORE the `source` field existed must deserialize
        // as "builtin" (so active_templates refreshes it to current defaults).
        let legacy = r#"{"version":2,"rotation":["main"],"templates":[]}"#;
        let t: ImageTemplates = serde_json::from_str(legacy).unwrap();
        assert_eq!(t.source, "builtin");
    }
}

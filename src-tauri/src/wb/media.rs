#![allow(dead_code)]
//! Media upload by raw bytes (ported from src/lib/wb/media.ts).
//! multipart field: uploadfile; headers: X-Nm-Id, X-Photo-Number (1-based).

use crate::state::AppState;
use crate::wb::client::{wb_fetch, MultipartData, WbCtx, WbReq};
use anyhow::Result;

pub async fn upload_media_bytes(
    state: &AppState,
    ctx: &WbCtx,
    nm_id: i64,
    photo_number: i64,
    bytes: Vec<u8>,
    filename: &str,
) -> Result<()> {
    wb_fetch(
        state,
        ctx,
        WbReq::post("/content/v3/media/file")
            .form(MultipartData {
                field: "uploadfile".into(),
                filename: filename.to_string(),
                content_type: "image/jpeg".into(),
                bytes,
            })
            .header("X-Nm-Id", &nm_id.to_string())
            .header("X-Photo-Number", &photo_number.to_string())
            .timeout(60_000),
    )
    .await?;
    Ok(())
}

/// Upload a product VIDEO to a card. Same `media/file` endpoint as photos, but a
/// video content-type puts it in WB's independent video lane (X-Photo-Number=1
/// does NOT clobber the cover photo); WB transcodes to HLS server-side. Larger
/// timeout — a dubbed mp4 is tens of MB. (Verified on the WB sandbox.)
pub async fn upload_video_bytes(
    state: &AppState,
    ctx: &WbCtx,
    nm_id: i64,
    bytes: Vec<u8>,
    filename: &str,
) -> Result<()> {
    wb_fetch(
        state,
        ctx,
        WbReq::post("/content/v3/media/file")
            .form(MultipartData {
                field: "uploadfile".into(),
                filename: filename.to_string(),
                content_type: "video/mp4".into(),
                bytes,
            })
            .header("X-Nm-Id", &nm_id.to_string())
            .header("X-Photo-Number", "1")
            .timeout(300_000),
    )
    .await?;
    Ok(())
}

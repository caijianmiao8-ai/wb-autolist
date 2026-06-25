// providers/cosyvoiceTtsVc.mjs — Alibaba CosyVoice v3.5 voice cloning (DashScope).
//
// Why this over qwen3-tts-vc: CosyVoice v3.5 synthesis is DETERMINISTIC — same
// voiceId + same text returns byte-identical audio (verified). qwen3-tts-vc drifts
// ~40Hz in pitch and varies timbre per call (it's a stochastic sampler with no
// seed/stability knob), which is the root cause of the "two voices / wandering
// timbre" we had to paper over with pitch-normalization. CosyVoice removes that
// drift at the source. Same DashScope key — just a newer model.
//
// Flow:
//   enroll: upload the reference clip to DashScope's own OSS (getPolicy -> POST to
//     OSS -> oss:// url; stays in Alibaba infra, private ACL, not a third party),
//     then POST voice-enrollment/create_voice {target_model, url} with the
//     X-DashScope-OssResourceResolve header -> returns a voice_id.
//   synthesize: WebSocket TTS (run-task -> continue-task -> finish-task), collect
//     the binary wav frames. (CosyVoice is NOT on the multimodal-generation HTTP
//     endpoint — that returns "url error".)

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { makeQwenTts } from './qwenTtsVc.mjs';

let _seq = 0;

function safeName(s) {
  // CosyVoice prefix must be <= 10 chars (qwen allowed 24).
  return (('d' + String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 10)) || 'dvoice';
}

export function makeCosyVoiceTtsVc({
  apiKey,
  baseUrl = 'https://dashscope.aliyuncs.com',
  wsUrl = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/',
  model = 'cosyvoice-v3.5-plus',
  presetModel = 'qwen3-tts-flash',
  sampleRate = 24000,
  rate = 1.9, // CosyVoice's RU default is ~2x too slow vs natural speech; speed it up so renders ≈ the slot (then iso/fit only fine-tune)
  timeoutMs = 60000,
  retries = 2,
} = {}) {
  const base = baseUrl.replace(/\/$/, '');
  // CosyVoice v3.5 needs ~10s+ of reference and accepts ONLY cloned voice_ids (no
  // usable system voices). A minority speaker with too little audio to clone falls
  // back to a DISTINCT qwen3-tts preset (e.g. "Chelsie"), synthesized on the Qwen
  // engine — so we route preset names there instead of CosyVoice.
  const presetTts = makeQwenTts({ apiKey, baseUrl, model: presetModel, sampleRate, timeoutMs, retries });

  // Upload a local file to DashScope's temporary OSS and return its oss:// url.
  async function uploadToOss(filePath) {
    const pr = await fetch(`${base}/api/v1/uploads?action=getPolicy&model=${model}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!pr.ok) throw new Error(`CosyVoice getPolicy HTTP ${pr.status}`);
    const pol = (await pr.json()).data;
    const buf = await readFile(filePath);
    const filename = `${Date.now()}_${basename(filePath)}`;
    const key = `${pol.upload_dir}/${filename}`;
    const fd = new FormData();
    fd.append('key', key);
    fd.append('policy', pol.policy);
    fd.append('OSSAccessKeyId', pol.oss_access_key_id);
    fd.append('signature', pol.signature);
    if (pol.x_oss_object_acl) fd.append('x-oss-object-acl', pol.x_oss_object_acl);
    if (pol.x_oss_forbid_overwrite) fd.append('x-oss-forbid-overwrite', pol.x_oss_forbid_overwrite);
    fd.append('success_action_status', '200');
    fd.append('file', new Blob([buf]), filename);
    const up = await fetch(pol.upload_host, { method: 'POST', body: fd });
    if (!up.ok && up.status !== 204) throw new Error(`CosyVoice OSS upload HTTP ${up.status}`);
    return `oss://${key}`;
  }

  async function enroll(samplePath, { name } = {}) {
    if (!apiKey) throw new Error('CosyVoice enroll: QWEN_API_KEY missing');
    const ossUrl = await uploadToOss(samplePath);
    const r = await fetch(`${base}/api/v1/services/audio/tts/customization`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-DashScope-OssResourceResolve': 'enable' },
      body: JSON.stringify({ model: 'voice-enrollment', input: { action: 'create_voice', target_model: model, prefix: safeName(name), url: ossUrl } }),
    });
    if (!r.ok) throw new Error(`CosyVoice enroll HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const vid = j?.output?.voice_id || j?.output?.voice;
    if (!vid) throw new Error(`CosyVoice enroll: no voice_id (${JSON.stringify(j).slice(0, 200)})`);
    return vid;
  }

  // One WebSocket round-trip: stream the text, collect the wav frames.
  function synthesizeWs(text, voice) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: { Authorization: `bearer ${apiKey}` } });
      const tid = `cv-${process.pid}-${_seq++}`;
      const chunks = [];
      let done = false;
      const to = setTimeout(() => fail(new Error('CosyVoice WS timeout')), timeoutMs);
      const fin = () => { if (done) return; done = true; clearTimeout(to); try { ws.close(); } catch { /* ignore */ } resolve(Buffer.concat(chunks)); };
      const fail = (e) => { if (done) return; done = true; clearTimeout(to); try { ws.close(); } catch { /* ignore */ } reject(e); };
      ws.onopen = () => ws.send(JSON.stringify({
        header: { action: 'run-task', task_id: tid, streaming: 'duplex' },
        payload: { task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model, parameters: { text_type: 'PlainText', format: 'wav', sample_rate: sampleRate, voice, rate }, input: {} },
      }));
      ws.onmessage = async (e) => {
        if (typeof e.data !== 'string') {
          const ab = e.data.arrayBuffer ? await e.data.arrayBuffer() : e.data;
          chunks.push(Buffer.from(ab));
          return;
        }
        let m; try { m = JSON.parse(e.data); } catch { return; }
        const ev = m.header?.event;
        if (ev === 'task-started') {
          ws.send(JSON.stringify({ header: { action: 'continue-task', task_id: tid, streaming: 'duplex' }, payload: { input: { text } } }));
          ws.send(JSON.stringify({ header: { action: 'finish-task', task_id: tid, streaming: 'duplex' }, payload: { input: {} } }));
        } else if (ev === 'task-finished') fin();
        else if (ev === 'task-failed') fail(new Error(`CosyVoice TTS failed: ${m.header?.error_code} ${m.header?.error_message}`));
      };
      ws.onerror = (e) => fail(new Error(`CosyVoice WS error: ${e.message || ''}`));
    });
  }

  async function synthesize(text, opts = {}) {
    const voice = opts.voiceId;
    if (!voice) throw new Error('CosyVoice TTS-VC: voiceId required (enroll a speaker first)');
    // preset fallback name (not a cosyvoice clone id) → Qwen preset engine
    if (!String(voice).startsWith('cosyvoice')) return presetTts.synthesize(text, opts);
    let buf, lastErr;
    for (let a = 0; a <= retries; a++) {
      try { buf = await synthesizeWs(text, voice); if (buf?.length > 44) break; } catch (e) { lastErr = e; }
    }
    if (!buf?.length) throw lastErr || new Error('CosyVoice: no audio returned');
    await writeFile(opts.outPath, buf);
    return { outPath: opts.outPath, bytes: buf.length };
  }

  return { kind: 'cosyvoice-vc', supportsCloning: true, enroll, synthesize };
}

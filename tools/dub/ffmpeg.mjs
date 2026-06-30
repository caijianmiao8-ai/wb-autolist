// ffmpeg.mjs — spawn helper + all media operations for the dub pipeline.
//
// Every recipe here is LIVE-VERIFIED against ffmpeg 8.1.1 (martin-riedl arm64).
// Binaries resolve from FFMPEG_PATH/FFPROBE_PATH (default ~/.local/bin), so a
// future system ffmpeg or different machine is a pure-config change.
//
// KEY FACTS baked in:
//  - atempo single-stage range in 8.1.1 is [0.5, 100] (NOT the classic 0.5-2.0).
//    Speed-ups up to 100x are ONE filter; slow-downs < 0.5 must chain (each
//    stage >= 0.5). factor = src_dur / target_dur (factor>1 = compress/speed up).
//  - amix normalize=0 keeps non-overlapping segments at full volume.
//  - adelay takes one value PER CHANNEL separated by '|', in MILLISECONDS.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';

export const FFMPEG = process.env.FFMPEG_PATH || join(homedir(), '.local/bin/ffmpeg');
export const FFPROBE = process.env.FFPROBE_PATH || join(homedir(), '.local/bin/ffprobe');

/** Run a binary with args; resolve {stdout,stderr} on rc 0, reject otherwise. */
// `idleMs`: a STALL watchdog. If the child emits no stdout/stderr for this long,
// kill it and reject. Used for the heavy network steps (Demucs/voice-select via
// uvx) so a dead/stalled first-run model download can't hang the dub forever —
// the caller catches the reject and degrades gracefully. Progress output (uv's
// download bar, demucs ticks) resets the timer, so a slow-but-moving download is
// never killed. 0/undefined = no watchdog (ffmpeg ops are fast).
export function run(bin, args, { onLog, idleMs = 0, cwd } = {}) {
  return new Promise((resolve, reject) => {
    // windowsHide: don't pop a console window for each ffmpeg/uvx/python child
    // spawned on Windows (alarming for GUI users).
    // cwd: run from a dir so a relative input path can be used — needed for the
    // `subtitles=` filter, whose Windows path parsing chokes on drive colons.
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd });
    let out = '';
    let err = '';
    let timer = null;
    let stalled = false;
    const bump = () => {
      if (!idleMs) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        try {
          p.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, idleMs);
    };
    const clear = () => timer && clearTimeout(timer);
    bump();
    p.stdout.on('data', (d) => {
      out += d;
      bump();
    });
    p.stderr.on('data', (d) => {
      err += d;
      bump();
      if (onLog) onLog(d.toString());
    });
    p.on('error', (e) => {
      clear();
      reject(e);
    }); // e.g. ENOENT if binary missing
    p.on('close', (code) => {
      clear();
      // Surface BOTH streams on failure. uv/uvx can exit non-zero writing nothing
      // to stderr (its diagnostics sometimes land on stdout, or it dies before
      // logging) — stderr-only error messages then read as a bare "exited 1" and
      // hide the real cause. Tag each stream so a degrade "详情" is self-explaining.
      const diag = () => {
        const e = (err || '').trim();
        const o = (out || '').trim();
        const parts = [];
        if (e) parts.push(`stderr: ${e.slice(-1800)}`);
        if (o) parts.push(`stdout: ${o.slice(-1800)}`);
        if (!parts.length) parts.push('(no stdout/stderr output)');
        return '\n' + parts.join('\n');
      };
      if (stalled) {
        reject(new Error(`${bin} stalled (no output for ${Math.round(idleMs / 1000)}s) — killed${diag()}`));
      } else if (code === 0) {
        resolve({ stdout: out, stderr: err });
      } else {
        reject(new Error(`${bin} exited ${code}${diag()}`));
      }
    });
  });
}

export function makeFf(cfg = {}) {
  const ffmpegBin = cfg.FFMPEG_PATH || FFMPEG;
  const ffprobeBin = cfg.FFPROBE_PATH || FFPROBE;
  const ffmpeg = (args, opts) => run(ffmpegBin, args, opts);
  const ffprobe = (args, opts) => run(ffprobeBin, args, opts);

  /** Media duration in seconds (Number). Works for video AND audio. */
  async function probeDuration(file) {
    const { stdout } = await ffprobe([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      file,
    ]);
    const d = parseFloat(stdout.trim());
    if (!Number.isFinite(d)) throw new Error(`probeDuration: bad duration for ${file}: "${stdout.trim()}"`);
    return d;
  }

  /** Full JSON probe (format + streams). */
  async function probeJson(file) {
    const { stdout } = await ffprobe([
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format', '-show_streams',
      file,
    ]);
    return JSON.parse(stdout);
  }

  /**
   * Extract audio to 16kHz mono PCM WAV for STT (smaller/standard input).
   * Scribe accepts video too, but the audio-only track is cheaper/faster.
   */
  async function extractAudio(inputVideo, outWav) {
    await ffmpeg(['-y', '-i', inputVideo, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWav]);
    return outWav;
  }

  /**
   * Build an atempo filter chain for a tempo factor (factor = src_dur/target_dur).
   * Single-stage range [0.5, 100]; >100 or <0.5 must be chained.
   */
  function atempoChain(factor) {
    const parts = [];
    let f = factor;
    if (!Number.isFinite(f) || f <= 0) f = 1;
    if (f >= 0.5) {
      while (f > 100) {
        parts.push(100);
        f /= 100;
      }
      parts.push(f);
    } else {
      while (f < 0.5) {
        parts.push(0.5);
        f /= 0.5;
      }
      parts.push(f);
    }
    return parts.map((x) => `atempo=${x.toFixed(6)}`).join(',');
  }

  /**
   * Fit an audio clip to an EXACT target duration.
   *  - If audio is LONGER than target: speed up via atempo (chained if needed),
   *    optionally capped at maxSpeedup for intelligibility, then hard-trim.
   *  - If audio is SHORTER: optionally slow slightly (down to minSlowdown),
   *    then pad with trailing silence (apad) and hard-cut at target.
   *
   * @returns {Promise<{outPath, srcDur, targetDur, factor, capped}>}
   */
  async function fitAudioToDuration(inWav, outWav, targetDur, opts = {}) {
    const { maxSpeedup = 1.5, minSlowdown = 0.85, srcDur: knownSrc, padShort = true, fillShort = false } = opts;
    const srcDur = knownSrc != null ? knownSrc : await probeDuration(inWav);
    if (!(targetDur > 0)) {
      // Degenerate slot — just copy a hard-trimmed/padded clip.
      await ffmpeg(['-y', '-i', inWav, '-af', 'apad', '-t', String(Math.max(targetDur, 0.05)), outWav]);
      return { outPath: outWav, srcDur, targetDur, factor: 1, capped: false };
    }
    let factor = srcDur / targetDur; // >1 means src is longer -> speed up
    let capped = false;

    // Don't speed up insanely fast — clamp for intelligibility (caller's choice).
    if (factor > maxSpeedup) {
      factor = maxSpeedup;
      capped = true;
    }
    // Don't over-stretch tiny clips into long slots; floor the slow-down.
    if (factor < minSlowdown) factor = minSlowdown;

    // padShort=false (gap-aware mode): if the clip already fits the target window
    // keep it at NATURAL speed/length — no padding, no time-stretch. EXCEPTION:
    // fillShort gently SLOWS a short clip (down to minSlowdown) so it COVERS the
    // speaker's on-screen time instead of ending early and leaving the mouth moving
    // over silence. The stretch is capped (≤ minSlowdown), so a much-too-short clip
    // still ends a little early rather than dragging.
    if (!padShort && !fillShort && factor <= 1.0001) {
      await ffmpeg(['-y', '-i', inWav, '-ar', '44100', '-ac', '2', outWav]);
      return { outPath: outWav, srcDur, targetDur, factor: 1, capped: false };
    }

    const chain = atempoChain(factor);
    const compressing = factor > 1.0001;
    // CAPPED = too long even at max speed-up: play the COMPLETE (max-compressed)
    // word with NO apad and NO -t, so it finishes (overflowing slightly into the
    // following pause) instead of being hard-cut into a fragment/artifact.
    // CRITICAL: never apply apad without -t — apad pads silence forever (runaway).
    let filter, trim;
    if (capped) { filter = chain; trim = false; }
    else if (padShort) { filter = `${chain},apad`; trim = true; } // fill short clip to target
    else if (compressing) { filter = chain; trim = true; }        // compress, exact cut
    else { filter = chain; trim = false; }                        // ~natural, leave as-is
    const args = ['-y', '-i', inWav, '-filter:a', filter];
    if (trim) args.push('-t', String(targetDur));
    args.push('-ar', '44100', '-ac', '2', outWav);
    await ffmpeg(args);
    return { outPath: outWav, srcDur, targetDur, factor, capped };
  }

  /**
   * Assemble per-segment clips into ONE stereo track positioned at their
   * start times. Uses adelay(ms) per clip + amix(normalize=0) so gaps AND
   * overlaps are handled, then apad/atrim to the exact total duration.
   *
   * @param {Array<{path:string,start:number}>} clips  (start in SECONDS)
   * @param {number} totalDur  final track length in seconds
   * @param {string} outWav
   */
  async function assembleTimeline(clips, totalDur, outWav) {
    if (!clips.length) {
      // pure silence track
      await ffmpeg([
        '-y', '-f', 'lavfi', '-t', String(totalDur),
        '-i', 'anullsrc=r=44100:cl=stereo',
        '-ar', '44100', '-ac', '2', outWav,
      ]);
      return outWav;
    }
    const inputs = [];
    const labels = [];
    const fc = [];
    clips.forEach((c, idx) => {
      inputs.push('-i', c.path);
      const startSec = Number.isFinite(c.start) ? Math.max(0, c.start) : 0;
      const ms = Math.round(startSec * 1000);
      // resample/repad to a common stereo 44.1k layout before mixing
      fc.push(`[${idx}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[a${idx}]`);
      labels.push(`[a${idx}]`);
    });
    const mix = `${labels.join('')}amix=inputs=${clips.length}:duration=longest:normalize=0,apad,atrim=0:${totalDur}[mix]`;
    fc.push(mix);
    await ffmpeg([
      '-y',
      ...inputs,
      '-filter_complex', fc.join(';'),
      '-map', '[mix]',
      '-ac', '2', '-ar', '44100',
      outWav,
    ]);
    return outWav;
  }

  /**
   * Mux a dub track into the source video.
   *  - opts.background (path): mix the dub OVER the separated M&E/background stem
   *    (foley/ambient/noise, vocals removed) at opts.bgVolume — preserves the
   *    soundscape, the recommended mode. (Takes priority over keepOriginal.)
   *  - keepOriginal in (0,1]: DUCK the FULL original (incl. English voice) under
   *    the dub — fallback when no separated background is available.
   *  - default: REPLACE the original audio entirely.
   */
  async function muxReplaceAudio(inputVideo, dubWav, outMp4, opts = {}) {
    const { keepOriginal = 0, audioBitrate = '192k', background = null, bgVolume = 0.8, duck = true } = opts;
    if (background) {
      const g = Math.min(Math.max(bgVolume, 0), 2);
      // duck=true: sidechain-compress the background by the dub voice so the M&E
      // drops ~6 dB while someone speaks (voice stays clear) and returns in pauses.
      // alimiter at the end is a cheap true-peak safety against mix clipping.
      const fc = duck
        ? `[1:a]asplit=2[dk][dv];[2:a]volume=${g}[bgv];[bgv][dk]sidechaincompress=threshold=0.05:ratio=6:attack=20:release=350[bg];[bg][dv]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`
        : `[2:a]volume=${g}[bg];[1:a]volume=1.0[dub];[bg][dub]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`;
      await ffmpeg([
        '-y', '-i', inputVideo, '-i', dubWav, '-i', background,
        '-filter_complex', fc,
        '-map', '0:v:0', '-map', '[aout]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', audioBitrate,
        '-shortest', outMp4,
      ]);
    } else if (keepOriginal && keepOriginal > 0) {
      const g = Math.min(Math.max(keepOriginal, 0), 1);
      await ffmpeg([
        '-y', '-i', inputVideo, '-i', dubWav,
        '-filter_complex',
        `[0:a]volume=${g}[bg];[1:a]volume=1.0[dub];[bg][dub]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
        '-map', '0:v:0', '-map', '[aout]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', audioBitrate,
        '-shortest', outMp4,
      ]);
    } else {
      await ffmpeg([
        '-y', '-i', inputVideo, '-i', dubWav,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', audioBitrate,
        '-shortest', outMp4,
      ]);
    }
    return outMp4;
  }

  /**
   * Burn an SRT subtitle file INTO the video (hardsub). WB's player shows no
   * separate subtitle track, so for a product feed (often autoplayed MUTED) the
   * Russian text must be baked into the pixels. Re-encodes video (libass burn);
   * audio is copied. Runs from the SRT's own dir with a RELATIVE filename so the
   * `subtitles=` filter never sees a Windows drive colon (which it mis-parses).
   */
  async function burnSubtitles(inVideo, srtPath, outVideo, opts = {}) {
    const crf = opts.crf ?? 20;
    const fontSize = opts.fontSize ?? 18;
    // libass force_style: white fill, black outline, bottom-centered, no shadow.
    const style = opts.force_style
      || `FontSize=${fontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=40`;
    const dir = dirname(srtPath);
    const rel = basename(srtPath);
    await run(
      ffmpegBin,
      [
        '-y', '-i', inVideo,
        '-vf', `subtitles=${rel}:force_style='${style}'`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        outVideo,
      ],
      { cwd: dir, idleMs: opts.idleMs || 0 }
    );
    return outVideo;
  }

  /**
   * Extract a clean single-speaker SAMPLE for voice enrollment: concatenate the
   * given time ranges from the source media (audio track) into one mp3, capped
   * at maxDur seconds. Used to clone each diarized speaker's voice.
   * @param {string} source   source video/audio path
   * @param {Array<{start:number,end:number}>} ranges (seconds)
   * @param {string} outMp3
   * @param {object} [opts] {maxDur=30}
   * @returns {Promise<number>} the sample duration actually used (seconds)
   */
  async function extractSpeakerSample(source, ranges, outMp3, opts = {}) {
    const maxDur = opts.maxDur || 30;
    const gapMerge = opts.gapMerge ?? 1.0;
    // IMPORTANT: use a single CONTIGUOUS slice, not a concatenation of scattered
    // segments — concat boundary artifacts trip Qwen's audio content inspection
    // (DataInspectionFailed "inappropriate material"). Merge adjacent same-speaker
    // segments (small gaps = continuous speech) into runs and take the longest.
    const segs = ranges
      .map((r) => ({ s: Number(r.start), e: Number(r.end) }))
      .filter((r) => Number.isFinite(r.s) && Number.isFinite(r.e) && r.e > r.s)
      .sort((a, b) => a.s - b.s);
    if (!segs.length) throw new Error('extractSpeakerSample: no usable ranges');
    const runs = [];
    let cur = { s: segs[0].s, e: segs[0].e };
    for (let i = 1; i < segs.length; i++) {
      if (segs[i].s - cur.e <= gapMerge) cur.e = Math.max(cur.e, segs[i].e);
      else { runs.push(cur); cur = { s: segs[i].s, e: segs[i].e }; }
    }
    runs.push(cur);
    runs.sort((a, b) => b.e - b.s - (a.e - a.s));
    const best = runs[0];
    const dur = Math.min(best.e - best.s, maxDur);
    await ffmpeg(['-y', '-ss', best.s.toFixed(3), '-i', source, '-t', dur.toFixed(3), '-vn', '-ac', '1', '-ar', '24000', '-b:a', '128k', outMp3]);
    return dur;
  }

  /**
   * Loudness-normalize a clip to a consistent target (EBU R128). Compensates for
   * TTS engines (esp. zero-shot voice clones like qwen-vc) that render each call
   * at a different level — the main cue behind a cloned voice "sounding like two
   * people" across segments. Cheap, provider-agnostic.
   */
  async function normalizeLoudness(inPath, outPath, opts = {}) {
    const mode = opts.mode || 'rms';
    if (mode === 'rms') {
      // Level each clip to a target RMS with a SINGLE gain (no compression) — fixes
      // clone level-drift between clips while preserving each clip's natural
      // dynamics (loud emphasis / soft asides), which loudnorm would flatten.
      const cur = await meanRms(inPath, 0, 1e6);
      const gain = (opts.targetDb ?? -20) - cur;
      const g = Math.max(-30, Math.min(30, gain)); // clamp to avoid extreme boosts
      await ffmpeg(['-y', '-i', inPath, '-af', `volume=${g.toFixed(2)}dB`, '-ar', '44100', '-ac', '2', outPath]);
      return outPath;
    }
    const I = opts.I ?? -16, TP = opts.TP ?? -1.5, LRA = opts.LRA ?? 11;
    await ffmpeg(['-y', '-i', inPath, '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}`, '-ar', '44100', '-ac', '2', outPath]);
    return outPath;
  }

  /**
   * Separate the original's BACKGROUND (music & effects — foley/ambient/noise)
   * from the speech, via Demucs (htdemucs two-stems). Returns the path to the
   * vocals-removed track. Keeping this under the dub preserves the soundscape
   * (clinks, sprays, room tone) instead of a bare voice over silence.
   * Demucs runs via uvx (cached after first use, ~20s for a 90s clip).
   */
  async function separateBackground(srcVideoOrAudio, workDir, opts = {}) {
    const uvx = opts.uvx || join(homedir(), '.local/bin/uvx');
    const full = join(workDir, 'orig_full.wav');
    await ffmpeg(['-y', '-i', srcVideoOrAudio, '-vn', '-ar', '44100', '-ac', '2', full]);
    const outDir = join(workDir, 'demucs');
    // --mp3: demucs' default WAV writer needs torchcodec (often absent); mp3 uses
    // lameenc and Just Works. Lossy is fine — it gets re-encoded to aac at mux.
    // `-v`: uv verbose — logs interpreter discovery + resolution to stderr, so when
    // it fails (esp. the silent "exited 1" some Windows setups produce) the reason
    // is captured instead of an empty error. Also keeps the stall watchdog fed.
    try {
      await run(uvx, ['-v', '--from', 'demucs', 'demucs', '--two-stems=vocals', '--mp3', '-o', outDir, full], { idleMs: opts.idleMs || 0 });
    } catch (e) {
      // Self-diagnose so the degrade "详情" explains WHY uvx failed. uvx == `uv tool
      // run`; its sibling `uv` does the Python discovery. Probe both: does the
      // binary even run, and can uv see/obtain a Python? (No-Python is the usual
      // first-run failure on a fresh, unsigned, network-restricted box.)
      const uvBin = uvx.replace(/uvx(\.exe)?$/i, (_m, ext) => 'uv' + (ext || ''));
      const probe = async (label, bin, args) => {
        try {
          const r = await run(bin, args, { idleMs: 30000 });
          return `\n[${label}] ${((r.stdout || '') + (r.stderr || '')).trim().slice(0, 500) || 'ok'}`;
        } catch (pe) {
          return `\n[${label} FAILED] ${String(pe?.message || pe).replace(/\s+/g, ' ').slice(0, 400)}`;
        }
      };
      let diag = '';
      diag += await probe('uv --version', uvBin, ['--version']);
      diag += await probe('uv python list', uvBin, ['python', 'list']);
      e.message = `${e.message}${diag}`;
      throw e;
    }
    const bg = join(outDir, 'htdemucs', 'orig_full', 'no_vocals.mp3');
    const vocals = join(outDir, 'htdemucs', 'orig_full', 'vocals.mp3');
    if (!existsSync(bg)) throw new Error(`demucs background stem not found at ${bg}`);
    // background = M&E (for the mix); vocals = clean speech (for clean clone refs)
    return { background: bg, vocals: existsSync(vocals) ? vocals : null };
  }

  /**
   * Estimate the median fundamental frequency (pitch, Hz) of voiced speech in a
   * clip, via short-frame autocorrelation. Used to detect & correct the per-call
   * PITCH DRIFT of clone TTS (the same cloned voice rendering 5-10% higher/lower
   * across calls — which the ear hears as "two different people"). Returns null
   * if too little voiced audio. 8kHz mono is plenty for an 80-400Hz search.
   */
  async function estimateF0(path, opts = {}) {
    const sr = opts.sr || 8000;
    const tmp = `${path}.f0.pcm`;
    await ffmpeg(['-y', '-i', path, '-ac', '1', '-ar', String(sr), '-f', 's16le', tmp]);
    let buf;
    try { buf = readFileSync(tmp); } finally { try { unlinkSync(tmp); } catch { /* best effort */ } }
    const n = buf.length >> 1;
    if (n < sr * 0.2) return null;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = buf.readInt16LE(i * 2);
    const W = Math.round(sr * 0.04); // 40ms frame
    const H = Math.round(sr * 0.02); // 20ms hop
    const lo = Math.floor(sr / 400); // highest pitch we look for
    const hi = Math.floor(sr / 80); // lowest
    const f0s = [];
    for (let s = 0; s + W <= n; s += H) {
      let mean = 0;
      for (let i = 0; i < W; i++) mean += x[s + i];
      mean /= W;
      let e = 0;
      for (let i = 0; i < W; i++) { const v = x[s + i] - mean; e += v * v; }
      if (e < W * 200) continue; // unvoiced / too quiet
      let best = 0, bl = 0;
      for (let lag = lo; lag < hi; lag++) {
        let acc = 0;
        for (let i = 0; i + lag < W; i += 2) acc += (x[s + i] - mean) * (x[s + i + lag] - mean);
        if (acc > best) { best = acc; bl = lag; }
      }
      if (bl && best > 0.3 * e) { const f = sr / bl; if (f > 80 && f < 400) f0s.push(f); }
    }
    if (f0s.length < 3) return null;
    f0s.sort((a, b) => a - b);
    return f0s[f0s.length >> 1]; // median
  }

  /**
   * Shift pitch by `factor` (target/current) WITHOUT changing duration, via the
   * asetrate→atempo trick (asetrate resamples = pitch & speed up together; atempo
   * restores the speed, leaving only the pitch change). For small corrections
   * (±10%) the coupled formant shift is inaudible. factor>1 raises, <1 lowers.
   */
  async function pitchShift(inPath, outPath, factor, opts = {}) {
    const R = opts.sampleRate || 44100;
    const k = Math.max(0.5, Math.min(2, Number(factor) || 1));
    if (Math.abs(k - 1) < 0.005) { // negligible — just normalize format
      await ffmpeg(['-y', '-i', inPath, '-ar', String(R), '-ac', '2', outPath]);
      return outPath;
    }
    const tempo = atempoChain(1 / k); // undo the speed change asetrate introduced
    const af = `aresample=${R},asetrate=${Math.round(R * k)},${tempo},aresample=${R}`;
    await ffmpeg(['-y', '-i', inPath, '-af', af, '-ar', String(R), '-ac', '2', outPath]);
    return outPath;
  }

  /** Mean RMS level (dB) of a file over [start,end] — used to score reference cleanliness. */
  async function meanRms(file, start, end) {
    try {
      const { stderr } = await ffmpeg(['-ss', String(Math.max(start, 0)), '-to', String(end), '-i', file, '-af', 'astats=metadata=1:reset=0', '-f', 'null', '-']);
      const vals = [...stderr.matchAll(/RMS level dB:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1])).filter((x) => Number.isFinite(x));
      return vals.length ? vals[vals.length - 1] : 0;
    } catch { return 0; }
  }

  /**
   * Detect silent intervals in an audio file (used to gate the dub to the
   * original's speech/silence envelope). Returns [[start,end], ...] seconds.
   */
  async function detectSilence(audioPath, opts = {}) {
    const thresh = opts.threshold ?? '-30dB';
    const minDur = opts.minDur ?? 0.5;
    const { stderr } = await ffmpeg(['-i', audioPath, '-af', `silencedetect=noise=${thresh}:d=${minDur}`, '-f', 'null', '-']).catch((e) => ({ stderr: String(e.message || '') }));
    const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
    const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
    const iv = [];
    for (let i = 0; i < starts.length; i++) {
      const s = Math.max(starts[i], 0);
      const e = i < ends.length ? ends[i] : null;
      if (e != null && e > s) iv.push([s, e]);
    }
    return iv;
  }

  /**
   * Mute the dub during the given silence intervals (where the ORIGINAL had no
   * speech) so the dub never plays over a silent mouth. Each interval is shrunk
   * inward (guard) so word tails at the edges aren't clipped, and a short fade
   * avoids clicks.
   */
  async function gateSilence(inWav, intervals, outWav, opts = {}) {
    const guard = opts.guard ?? 0.12; // keep this much speech at each edge
    const mutes = intervals
      .map(([s, e]) => [s + guard, e - guard])
      .filter(([s, e]) => e - s > 0.15);
    if (!mutes.length) {
      await ffmpeg(['-y', '-i', inWav, '-c', 'copy', outWav]);
      return outWav;
    }
    const enable = mutes.map(([s, e]) => `between(t,${s.toFixed(3)},${e.toFixed(3)})`).join('+');
    // volume=0 active only inside the silence windows; bypassed elsewhere.
    await ffmpeg(['-y', '-i', inWav, '-af', `volume=0:enable='${enable}'`, '-ar', '44100', '-ac', '2', outWav]);
    return outWav;
  }

  /** Concatenate several audio clips end-to-end into one wav (for --whole mode). */
  async function concatAudio(paths, outWav) {
    if (paths.length === 1) {
      await ffmpeg(['-y', '-i', paths[0], '-ar', '44100', '-ac', '2', outWav]);
      return outWav;
    }
    const inputs = [];
    const labels = [];
    paths.forEach((p, i) => {
      inputs.push('-i', p);
      labels.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo[c${i}]`);
    });
    const chain = paths.map((_, i) => `[c${i}]`).join('');
    const fc = `${labels.join(';')};${chain}concat=n=${paths.length}:v=0:a=1[out]`;
    await ffmpeg(['-y', ...inputs, '-filter_complex', fc, '-map', '[out]', '-ar', '44100', '-ac', '2', outWav]);
    return outWav;
  }

  return {
    FFMPEG: ffmpegBin,
    FFPROBE: ffprobeBin,
    ffmpeg,
    ffprobe,
    probeDuration,
    probeJson,
    extractAudio,
    atempoChain,
    fitAudioToDuration,
    assembleTimeline,
    muxReplaceAudio,
    burnSubtitles,
    concatAudio,
    extractSpeakerSample,
    normalizeLoudness,
    detectSilence,
    gateSilence,
    separateBackground,
    meanRms,
    estimateF0,
    pitchShift,
  };
}

// Convenience standalone export (uses env-resolved binaries).
const _default = makeFf();
export const {
  probeDuration,
  probeJson,
  extractAudio,
  atempoChain,
  fitAudioToDuration,
  assembleTimeline,
  muxReplaceAudio,
  concatAudio,
} = _default;

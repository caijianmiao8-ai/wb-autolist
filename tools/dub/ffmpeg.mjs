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
import { homedir } from 'node:os';
import { join } from 'node:path';

export const FFMPEG = process.env.FFMPEG_PATH || join(homedir(), '.local/bin/ffmpeg');
export const FFPROBE = process.env.FFPROBE_PATH || join(homedir(), '.local/bin/ffprobe');

/** Run a binary with args; resolve {stdout,stderr} on rc 0, reject otherwise. */
export function run(bin, args, { onLog } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.stderr.on('data', (d) => {
      err += d;
      if (onLog) onLog(d.toString());
    });
    p.on('error', reject); // e.g. ENOENT if binary missing
    p.on('close', (code) =>
      code === 0
        ? resolve({ stdout: out, stderr: err })
        : reject(new Error(`${bin} exited ${code}\n${err.slice(-1500)}`))
    );
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
    const { maxSpeedup = 1.5, minSlowdown = 0.85, srcDur: knownSrc } = opts;
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

    const chain = atempoChain(factor);
    // After tempo change, apad to fill any remaining gap, then hard-cut at target.
    const filter = `${chain},apad`;
    await ffmpeg(['-y', '-i', inWav, '-filter:a', filter, '-t', String(targetDur), '-ar', '44100', '-ac', '2', outWav]);
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
   *  - default: REPLACE the original audio entirely (-c:v copy, fast, no re-encode).
   *  - keepOriginal in (0,1]: DUCK the original under the dub at that gain via amix.
   */
  async function muxReplaceAudio(inputVideo, dubWav, outMp4, opts = {}) {
    const { keepOriginal = 0, audioBitrate = '192k' } = opts;
    if (keepOriginal && keepOriginal > 0) {
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
    concatAudio,
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

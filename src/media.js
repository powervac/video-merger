// Вся работа с ffmpeg. Не зависит от Electron, поэтому проверяется обычным node.
'use strict';

const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VIDEO_EXT = new Set([
  '.mp4', '.mov', '.mkv', '.avi', '.m4v', '.mts', '.m2ts', '.webm', '.wmv', '.mpg', '.mpeg', '.3gp',
]);

// ---------- поиск ffmpeg ----------

function findInPath(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const dirs = (process.env.PATH || '').split(path.delimiter);
  // У приложения, запущенного из Finder, PATH урезан — проверяем и типичные места.
  if (process.platform !== 'win32') dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir, exe);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function bundled(name) {
  try {
    const p = name === 'ffmpeg' ? require('ffmpeg-static') : require('ffprobe-static').path;
    // Внутри собранного приложения бинарники лежат вне asar-архива.
    const real = p && p.replace('app.asar', 'app.asar.unpacked');
    return real && fs.existsSync(real) ? real : null;
  } catch {
    return null;
  }
}

/** Файл может существовать, но быть битым или не той архитектуры — поэтому запускаем. */
function works(file) {
  if (!file) return false;
  const r = spawnSync(file, ['-version'], { windowsHide: true, timeout: 20000 });
  return r.status === 0;
}

// Папка, куда приложение само докачивает ffmpeg при первом запуске.
let toolsDir = null;
function setToolsDir(dir) {
  toolsDir = dir;
}

const binCache = {};
/** Порядок: переменная окружения, системный ffmpeg, зависимость приложения. */
function locate(name) {
  if (!binCache[name]) {
    const candidates = [
      ['env', () => process.env[`${name.toUpperCase()}_PATH`]],
      ['system', () => findInPath(name)],
      ['bundled', () => bundled(name)],
      ['downloaded', () => toolsDir && path.join(toolsDir, process.platform === 'win32' ? `${name}.exe` : name)],
    ];
    for (const [source, get] of candidates) {
      const file = get();
      if (works(file)) {
        binCache[name] = { path: file, source };
        break;
      }
    }
  }
  return binCache[name] || null;
}

function bin(name) {
  const found = locate(name);
  if (!found) throw new Error(`${name} not found. Restart the app to install it.`);
  return found.path;
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr);
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

// ---------- чтение папки и файлов ----------

function listVideos(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('._') && !/\.part-\d+\.\w+$/.test(e.name) && VIDEO_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dir, e.name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function parseRate(rate) {
  const [num, den] = String(rate || '').split('/').map(Number);
  return num && den ? num / den : 0;
}

async function probe(file) {
  const base = { path: file, name: path.basename(file), size: 0 };
  try {
    const stat = fs.statSync(file);
    base.size = stat.size;
    // Дата файла — запасной вариант: при копировании birthtime становится новым, mtime обычно сохраняется.
    base.created = Math.min(stat.mtimeMs, stat.birthtimeMs || stat.mtimeMs);
    const out = await run(bin('ffprobe'), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
    const data = JSON.parse(out);
    const video = data.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    if (!video) throw new Error('no video track in this file');
    const audio = data.streams.find((s) => s.codec_type === 'audio');
    const rotation = Number(video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0);
    const sideways = Math.abs(rotation) % 180 === 90;
    return {
      ...base,
      duration: Number(data.format.duration) || Number(video.duration) || 0,
      startTime: Number(data.format.start_time) || 0,
      // Дата съёмки из самого видео надёжнее даты файла.
      created: Date.parse(data.format.tags?.creation_time || video.tags?.creation_time || '') || base.created,
      width: sideways ? video.height : video.width,
      height: sideways ? video.width : video.height,
      rotation,
      fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate),
      vcodec: video.codec_name,
      profile: video.profile || '',
      pixfmt: video.pix_fmt || '',
      acodec: audio ? audio.codec_name : null,
      sampleRate: audio ? Number(audio.sample_rate) : 0,
      channels: audio ? audio.channels : 0,
    };
  } catch (err) {
    const text = String(err.stderr || err.message);
    const reason = /permission denied|EPERM|EACCES|EBUSY/i.test(text)
      ? 'No access: the file is in use or still being copied'
      : `Cannot read: ${text.trim().split('\n').pop().slice(0, 160)}`;
    return { ...base, error: reason };
  }
}

async function thumbnail(file, duration, from) {
  // Для обрезанного куска берём кадр из его начала.
  const at = from > 0 ? from : Math.min(1, (duration || 0) / 2);
  const out = await run(
    bin('ffmpeg'),
    ['-v', 'error', '-ss', String(at), '-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=640:-2', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'],
    { encoding: 'buffer', timeout: 60000 },
  );
  return `data:image/jpeg;base64,${out.toString('base64')}`;
}

/** Пики громкости (0..1) для отрисовки волны. Возвращает { promise, cancel }. */
function waveform(file, duration, buckets = 600) {
  const child = spawn(
    bin('ffmpeg'),
    ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '2000', '-f', 's16le', 'pipe:1'],
    { windowsHide: true },
  );
  const perBucket = Math.max(1, Math.floor((duration * 2000) / buckets));
  const peaks = [];
  let peak = 0;
  let count = 0;
  let rest = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const usable = data.length - (data.length % 2);
    for (let i = 0; i < usable; i += 2) {
      peak = Math.max(peak, Math.abs(data.readInt16LE(i)));
      if (++count === perBucket) {
        peaks.push(peak / 32768);
        peak = 0;
        count = 0;
      }
    }
    rest = data.subarray(usable);
  });
  child.stderr.resume();
  const promise = new Promise((resolve) => {
    child.on('error', () => resolve([]));
    child.on('close', (code) => resolve(code === 0 ? peaks : []));
  });
  return { promise, cancel: () => child.kill('SIGKILL') };
}

/** Свободное имя в папке: name.mp4, name (2).mp4 … — существующее не перезаписываем. */
function uniqueOutput(dir, base, ext) {
  let file = path.join(dir, `${base}.${ext}`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base} (${i}).${ext}`);
  return file;
}

// ---------- совместимость и кодировщики ----------

/** Можно ли склеить без перекодирования. Возвращает список отличий (пустой — можно). */
function copyProblems(clips) {
  const fields = [
    ['vcodec', 'video codec'],
    ['profile', 'video profile'],
    ['width', 'width'],
    ['height', 'height'],
    ['rotation', 'rotation'],
    ['pixfmt', 'pixel format'],
    ['fps', 'frame rate'],
    ['acodec', 'audio codec'],
    ['sampleRate', 'sample rate'],
    ['channels', 'channels'],
  ];
  const norm = (clip, key) => (key === 'fps' ? Math.round(clip.fps * 100) : clip[key]);
  return fields.filter(([key]) => clips.some((c) => norm(c, key) !== norm(clips[0], key))).map(([, label]) => label);
}

const HW_CANDIDATES = {
  h264: ['h264_nvenc', 'h264_videotoolbox', 'h264_qsv', 'h264_amf'],
  hevc: ['hevc_nvenc', 'hevc_videotoolbox', 'hevc_qsv', 'hevc_amf'],
};

/** Проверяет пробным кодированием, какой аппаратный кодировщик реально работает. */
async function detectHardware() {
  const result = { h264: null, hevc: null };
  for (const codec of Object.keys(HW_CANDIDATES)) {
    for (const encoder of HW_CANDIDATES[codec]) {
      try {
        await run(
          bin('ffmpeg'),
          ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=640x360:d=0.2', '-pix_fmt', 'yuv420p', '-c:v', encoder, '-f', 'null', '-'],
          { timeout: 20000 },
        );
        result[codec] = encoder;
        break;
      } catch {
        // не поддерживается на этой машине
      }
    }
  }
  return result;
}

function videoArgs(encoder, quality) {
  const q = (high, medium, small) => String({ high, medium, small }[quality] ?? medium);
  switch (encoder) {
    case 'libx264':
      return ['-c:v', encoder, '-preset', 'medium', '-crf', q(18, 21, 26)];
    case 'libx265':
      return ['-c:v', encoder, '-preset', 'medium', '-crf', q(20, 24, 29)];
    case 'h264_nvenc':
    case 'hevc_nvenc':
      return ['-c:v', encoder, '-preset', 'p5', '-rc', 'vbr', '-cq', q(19, 23, 29), '-b:v', '0'];
    case 'h264_videotoolbox':
    case 'hevc_videotoolbox':
      return ['-c:v', encoder, '-q:v', q(70, 55, 40)];
    case 'h264_qsv':
    case 'hevc_qsv':
      return ['-c:v', encoder, '-global_quality', q(19, 23, 29)];
    case 'h264_amf':
    case 'hevc_amf':
      return ['-c:v', encoder, '-rc', 'cqp', '-qp_i', q(19, 23, 29), '-qp_p', q(21, 25, 31)];
    default:
      throw new Error(`Unknown encoder ${encoder}`);
  }
}

// ---------- обрезка ----------

// clip.in / clip.out — границы куска в секундах от начала файла; без них берётся весь файл.
const startOf = (c) => c.in || 0;
const endOf = (c) => c.out ?? c.duration;
const lengthOf = (c) => endOf(c) - startOf(c);
const isTrimmed = (c) => startOf(c) > 0.001 || endOf(c) < c.duration - 0.001;

/** Без перекодирования резать можно только по ключевым кадрам: ищем ближайший к моменту t. */
async function nearestKeyframe(clip, t) {
  if (t <= 0.001) return 0;
  if (t >= clip.duration - 0.05) return clip.duration;
  const offset = clip.startTime || 0;
  for (const reach of [6, 30, 120]) {
    const from = Math.max(0, t + offset - reach);
    const out = await run(bin('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', `${from}%${t + offset + reach}`,
      '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', clip.path]);
    const keys = String(out)
      .split('\n')
      .map((line) => line.split(','))
      .filter(([pts, flags]) => flags?.includes('K') && Number.isFinite(Number(pts)))
      .map(([pts]) => Number(pts) - offset);
    if (keys.length) return Math.max(0, keys.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a)));
  }
  return t;
}

/** Команда, вырезающая кусок [a, b) без перекодирования. */
function pieceArgs(clip, a, b, target) {
  const toEnd = b >= clip.duration - 0.001;
  return [
    ...(a > 0 ? ['-ss', (a + 0.001).toFixed(6)] : []),
    '-i', clip.path,
    ...(toEnd ? [] : ['-t', (b - a).toFixed(6)]),
    '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
    // Точное число кадров: иначе из-за B-кадров прихватываются лишние за границей реза.
    ...(toEnd || !clip.fps ? [] : ['-frames:v', String(Math.round((b - a) * clip.fps))]),
    '-avoid_negative_ts', 'make_zero',
    target,
  ];
}

// ---------- сборка команды ----------

function concatListLine(file) {
  // Правила кавычек concat-демультиплексора: ' заменяется на '\''
  return `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

function containerArgs(format) {
  return format === 'mkv' ? [] : ['-movflags', '+faststart'];
}

/**
 * Два видео в одном кадре: clips = [первое, второе]. Короткое замирает на последнем кадре.
 * options.direction: 'row' (слева и справа) | 'column' (сверху и снизу)
 * options.audio: 'both' | 'left' | 'right' | 'none'
 * options.fit: 'whole' (видео целиком, возможны полосы) | 'fill' (заполнить половину, края обрезаются)
 * Любые исходные разрешения приводятся к размеру половины кадра.
 */
function sideBySideArgs(clips, options) {
  const { width, height, fps } = options;
  const column = options.direction === 'column';
  const cellWidth = column ? width : width / 2;
  const cellHeight = column ? height / 2 : height;
  const longest = Math.max(...clips.map(lengthOf));
  const inputs = [];
  const filters = [];

  clips.forEach((clip, i) => {
    if (isTrimmed(clip)) inputs.push('-ss', startOf(clip).toFixed(6), '-t', lengthOf(clip).toFixed(6));
    inputs.push('-i', clip.path);
    filters.push(
      `[${i}:v:0]` +
        (options.fit === 'fill'
          ? `scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${cellWidth}:${cellHeight},`
          : `scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2,`) +
        `setsar=1,setpts=PTS-STARTPTS,fps=${fps},format=yuv420p,` +
        `tpad=stop_mode=clone:stop_duration=${(longest - lengthOf(clip) + 1).toFixed(3)}[v${i}]`,
    );
  });
  filters.push(`[v0][v1]${column ? 'vstack' : 'hstack'}=inputs=2[v]`);

  const wanted = { both: [0, 1], left: [0], right: [1], none: [] }[options.audio || 'both'];
  const audible = wanted.filter((i) => clips[i].acodec);
  audible.forEach((i) => {
    filters.push(`[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad[a${i}]`);
  });
  if (audible.length === 2) filters.push('[a0][a1]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[a]');
  else if (audible.length === 1) filters.push(`[a${audible[0]}]anull[a]`);

  return [
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[v]',
    ...(audible.length ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '192k'] : []),
    ...videoArgs(options.encoder || (options.codec === 'hevc' ? 'libx265' : 'libx264'), options.quality),
    ...(options.codec === 'hevc' && options.format !== 'mkv' ? ['-tag:v', 'hvc1'] : []),
    // Дорожки дополнены «с запасом», поэтому длину задаём явно.
    '-t', longest.toFixed(3),
    ...containerArgs(options.format),
  ];
}

/**
 * options: { mode: 'copy'|'encode', format: 'mp4'|'mov'|'mkv', width, height, fps,
 *            codec: 'h264'|'hevc', quality: 'high'|'medium'|'small', encoder }
 */
function buildArgs(clips, options, listFile) {
  if (options.mode === 'sidebyside') return sideBySideArgs(clips, options);
  if (options.mode === 'copy') {
    // PCM-звук в MP4 многие плееры не играют, поэтому для MP4 переводим только звук в AAC.
    const needAac = options.format === 'mp4' && clips[0].acodec && !['aac', 'mp3', 'ac3'].includes(clips[0].acodec);
    return [
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'copy',
      ...(needAac ? ['-c:a', 'aac', '-b:a', '320k'] : ['-c:a', 'copy']),
      ...(clips[0].vcodec === 'hevc' && options.format !== 'mkv' ? ['-tag:v', 'hvc1'] : []),
      ...containerArgs(options.format),
    ];
  }

  const { width, height, fps } = options;
  const inputs = [];
  const filters = [];
  const pads = [];
  const hasAudio = clips.some((c) => c.acodec);

  clips.forEach((clip, i) => {
    // При перекодировании перемотка на входе точна до кадра.
    if (isTrimmed(clip)) inputs.push('-ss', startOf(clip).toFixed(6), '-t', lengthOf(clip).toFixed(6));
    inputs.push('-i', clip.path);
    filters.push(
      `[${i}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`,
    );
    pads.push(`[v${i}]`);
    if (!hasAudio) return;
    const common = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
    if (clip.acodec) {
      filters.push(`[${i}:a:0]aresample=48000,${common},asetpts=PTS-STARTPTS[a${i}]`);
    } else {
      // Клип без звука заполняем тишиной той же длины.
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${lengthOf(clip)},${common}[a${i}]`);
    }
    pads.push(`[a${i}]`);
  });

  filters.push(`${pads.join('')}concat=n=${clips.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`);

  return [
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[v]',
    ...(hasAudio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '192k'] : []),
    ...videoArgs(options.encoder || (options.codec === 'hevc' ? 'libx265' : 'libx264'), options.quality),
    ...(options.codec === 'hevc' && options.format !== 'mkv' ? ['-tag:v', 'hvc1'] : []),
    ...containerArgs(options.format),
  ];
}

// ---------- экспорт ----------

function samePath(a, b) {
  const norm = (p) => (process.platform === 'linux' ? path.resolve(p) : path.resolve(p).toLowerCase());
  return norm(a) === norm(b);
}

/** Запускает экспорт. Возвращает { promise, cancel }. */
function exportVideo(clips, options, output, onProgress = () => {}) {
  if (!clips.length) throw new Error('The timeline is empty');
  if (clips.some((c) => samePath(c.path, output))) throw new Error('The result cannot overwrite a source file');
  if (clips.some((c) => lengthOf(c) <= 0)) throw new Error('The timeline has an empty piece');
  if (options.mode === 'sidebyside' && clips.length !== 2) throw new Error('Side by side needs exactly two videos');
  if (options.mode === 'copy') {
    const problems = copyProblems(clips);
    if (problems.length) throw new Error(`Lossless merge is impossible, clips differ in: ${problems.join(', ')}`);
  }

  const ext = path.extname(output);
  // Пишем во временный файл: при отмене или ошибке не останется битого результата.
  const partial = path.join(path.dirname(output), `${path.basename(output, ext)}.part-${process.pid}${ext}`);
  let child = null;
  let cancelled = false;
  const temporary = [];

  const checkCancelled = () => {
    if (cancelled) throw new Error('Cancelled');
  };

  const ffmpeg = (args, onTime) =>
    new Promise((resolve, reject) => {
      checkCancelled();
      child = spawn(bin('ffmpeg'), ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-progress', 'pipe:1', '-nostats', ...args], { windowsHide: true });
      let log = '';
      let buffer = '';
      let speed = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const [key, value = ''] = line.trim().split('=');
          if (key === 'speed') speed = value.trim();
          if (key === 'out_time_us' && Number(value) >= 0) onTime?.(Number(value) / 1e6, speed);
        }
      });
      child.stderr.on('data', (chunk) => {
        log = (log + chunk).slice(-4000);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (cancelled || code !== 0) reject(new Error(cancelled ? 'Cancelled' : log.trim() || `ffmpeg exited with code ${code}`));
        else resolve();
      });
    });

  async function work() {
    let parts = clips;
    let listFile = null;
    let base = 0; // доля прогресса, занятая вырезанием кусков

    if (options.mode === 'copy') {
      let files = clips.map((c) => c.path);
      if (clips.some(isTrimmed)) {
        // Куски кладём рядом с результатом: на этом диске для него и так нужно место.
        const dir = fs.mkdtempSync(path.join(path.dirname(output), '.videomerger-'));
        temporary.push(dir);
        base = 50;
        parts = [];
        files = [];
        for (const [i, clip] of clips.entries()) {
          checkCancelled();
          if (!isTrimmed(clip)) {
            parts.push(clip);
            files.push(clip.path);
          } else {
            const a = await nearestKeyframe(clip, startOf(clip));
            const b = await nearestKeyframe(clip, endOf(clip));
            if (b - a < 0.02) {
              throw new Error(`A piece of ${clip.name} is too short to cut without re-encoding. Make it longer or set Quality below Original.`);
            }
            const target = path.join(dir, `piece-${i}.${['h264', 'hevc', 'prores'].includes(clip.vcodec) ? 'mov' : 'mkv'}`);
            await ffmpeg(pieceArgs(clip, a, b, target));
            parts.push({ ...clip, in: a, out: b });
            files.push(target);
          }
          onProgress({ percent: ((i + 1) / clips.length) * base, done: 0, total: 0, speed: '' });
        }
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'videomerger-'));
      temporary.push(dir);
      listFile = path.join(dir, 'list.txt');
      fs.writeFileSync(listFile, files.map(concatListLine).join('\n'), 'utf8');
    }

    // Рядом видео идут одновременно, друг за другом — по очереди.
    const total = options.mode === 'sidebyside' ? Math.max(...parts.map(lengthOf)) : parts.reduce((sum, c) => sum + lengthOf(c), 0);
    // В режиме copy список файлов уже учитывает обрезку, в encode её задают входы ffmpeg.
    await ffmpeg([...buildArgs(clips, options, listFile), partial], (done, speed) => {
      if (total > 0) onProgress({ percent: Math.min(99.9, base + (done / total) * (100 - base)), done, total, speed });
    });
    fs.renameSync(partial, output);
    onProgress({ percent: 100, done: total, total, speed: '' });
    return output;
  }

  const promise = work()
    .catch((err) => {
      fs.rmSync(partial, { force: true });
      throw cancelled ? new Error('Cancelled') : err;
    })
    .finally(() => {
      for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
    });

  return {
    promise,
    cancel() {
      cancelled = true;
      child?.kill('SIGKILL');
    },
  };
}

module.exports = { nearestKeyframe, setToolsDir, bin, locate, listVideos, probe, thumbnail, copyProblems, detectHardware, buildArgs, exportVideo, waveform, uniqueOutput };

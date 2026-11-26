'use strict';

const $ = (id) => document.getElementById(id);

// Один упорядоченный список: он же «Video Files» и он же таймлайн.
// Нечитаемые файлы видны в списке, но на таймлайн не попадают.
let files = [];
let selected = null;
let drag = null; // { clip }
let outputDir = null; // null — рядом с первым видео
let qualityTouched = false;
let canCopy = false;
let copyBlocker = '';
let hardware = { h264: null, hevc: null };
let lastOutput = null;
let nextId = 1;

const QUALITY = [
  { key: 'small', name: 'Small' },
  { key: 'medium', name: 'Medium' },
  { key: 'high', name: 'High' },
  { key: 'original', name: 'Original' },
];

const clips = () => files.filter((f) => !f.error);
const totalDuration = () => clips().reduce((s, c) => s + c.duration, 0);

const pad = (n) => String(Math.floor(n)).padStart(2, '0');
const hms = (s) => {
  s = Math.round(s);
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
};
const short = (s) => {
  s = Math.floor(s || 0);
  return s >= 3600 ? hms(s) : `${pad(s / 60)}:${pad(s % 60)}`;
};
const bytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function thumbNode(clip) {
  if (!clip.thumb) return el('div', 'thumb', clip.error ? '⚠' : '…');
  const img = el('img', 'thumb');
  img.src = clip.thumb;
  img.draggable = false;
  return img;
}

// ---------- добавление и удаление ----------

async function addPaths(paths) {
  if (!paths.length) return;
  $('count').textContent = '…';
  let found = [];
  try {
    found = await window.api.probe(paths);
  } catch (err) {
    showError('Could not add files', err.message);
  }
  const fresh = [];
  for (const info of found) {
    const index = files.findIndex((f) => f.path === info.path);
    const clip = { ...info, id: nextId++ };
    if (index === -1) files.push(clip);
    else if (files[index].error) files[index] = clip; // повторная попытка после ошибки
    else continue;
    fresh.push(clip);
  }
  if (!selected) select(clips()[0] || null);
  update();
  loadPreviews(fresh.filter((c) => !c.error));
}

async function loadPreviews(list) {
  for (const clip of list) {
    clip.thumb = await window.api.thumbnail(clip.path, clip.duration);
    if (clip === selected) $('video').poster = clip.thumb || '';
    render();
  }
  for (const clip of list) {
    if (!files.includes(clip)) continue;
    clip.peaks = clip.acodec ? await window.api.waveform(clip.path, clip.duration) : [];
    drawAudio();
  }
}

function remove(clip) {
  files = files.filter((f) => f !== clip);
  if (selected === clip) select(clips()[0] || null);
  update();
}

/** Переставляет clip перед target (или в конец, если target нет). */
function move(clip, target) {
  if (clip === target) return;
  files.splice(files.indexOf(clip), 1);
  const at = target ? files.indexOf(target) : files.length;
  files.splice(at, 0, clip);
  update();
}

// ---------- перетаскивание для смены порядка ----------

function draggable(node, clip, horizontal, nodes) {
  const after = (e) => {
    const r = node.getBoundingClientRect();
    return horizontal ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
  };
  const unmark = () => node.classList.remove('before', 'after');
  node.draggable = true;
  node.ondragstart = (e) => {
    drag = { clip };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(clip.id));
    node.classList.add('dragging');
  };
  node.ondragend = () => {
    drag = null;
    node.classList.remove('dragging');
    for (const n of nodes()) n.classList.remove('before', 'after');
  };
  node.ondragover = (e) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    unmark();
    node.classList.add(after(e) ? 'after' : 'before');
  };
  node.ondragleave = unmark;
  node.ondrop = (e) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const next = after(e) ? files[files.indexOf(clip) + 1] : clip;
    move(drag.clip, next);
    drag = null;
  };
}

// Бросок на пустое место таймлайна или списка — в конец.
for (const id of ['scroller', 'list']) {
  $(id).addEventListener('dragover', (e) => drag && e.preventDefault());
  $(id).addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    move(drag.clip, null);
    drag = null;
  });
}

// ---------- файлы, брошенные из проводника / Finder ----------

const external = (e) => !drag && e.dataTransfer.types.includes('Files');
window.addEventListener('dragover', (e) => {
  if (!external(e)) return;
  e.preventDefault();
  $('dropzone').classList.add('over');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) $('dropzone').classList.remove('over');
});
window.addEventListener('drop', (e) => {
  $('dropzone').classList.remove('over');
  if (!external(e)) return;
  e.preventDefault();
  addPaths([...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean));
});

$('dropzone').onclick = async () => addPaths(await window.api.chooseFiles());
$('dropzone').onkeydown = (e) => {
  if (e.target === $('dropzone') && (e.key === 'Enter' || e.key === ' ')) $('dropzone').click();
};
$('addFolder').onclick = async (e) => {
  e.stopPropagation();
  const dir = await window.api.chooseFolder();
  if (dir) addPaths([dir]);
};
$('clear').onclick = () => {
  files = [];
  select(null);
  update();
};

// ---------- список и таймлайн ----------

function listItem(clip) {
  const node = el('div', `item${clip === selected ? ' selected' : ''}`);
  node.title = clip.path;
  const text = el('div', 'text');
  text.append(
    el('div', 'name', clip.name),
    clip.error
      ? el('div', 'meta error', clip.error)
      : el('div', 'meta', `${clip.width}×${clip.height}  •  ${Math.round(clip.fps * 100) / 100} fps  •  ${bytes(clip.size)}`),
  );
  const close = el('button', 'remove');
  close.title = 'Remove';
  close.append(icon('x'));
  close.onclick = (e) => {
    e.stopPropagation();
    remove(clip);
  };
  node.append(el('div', 'grip'), thumbNode(clip), text);
  if (!clip.error) node.append(el('div', 'pill', hms(clip.duration)));
  node.append(close);
  if (!clip.error) node.onclick = () => select(clip);
  draggable(node, clip, false, () => $('list').children);
  return node;
}

/**
 * Масштаб таймлайна: каждому клипу минимум, чтобы читалось название,
 * а свободное место делится по длительности. Прокрутка — только когда минимумы не помещаются.
 */
function clipWidths() {
  const list = clips();
  const min = 220;
  const available = $('scroller').clientWidth - 24 - 40 * Math.max(0, list.length - 1) - 12;
  const spare = Math.max(0, available - min * list.length);
  const total = totalDuration() || 1;
  return list.map((c) => min + Math.floor((spare * c.duration) / total));
}

function renderTimeline() {
  const widths = clipWidths();
  const nodes = [];
  clips().forEach((clip, i) => {
    if (i) {
      const gap = el('div', 'gap', '➜');
      nodes.push(gap);
    }
    const node = el('div', `clip${clip === selected ? ' selected' : ''}`);
    node.title = clip.path;
    node.style.width = `${widths[i]}px`;
    const text = el('div');
    text.append(el('div', 'name', clip.name), el('div', 'time', hms(clip.duration)));
    node.append(thumbNode(clip), text);
    node.onclick = (e) => {
      const r = node.getBoundingClientRect();
      select(clip, ((e.clientX - r.left) / r.width) * clip.duration);
    };
    draggable(node, clip, true, () => $('videoTrack').children);
    nodes.push(node);
  });
  $('videoTrack').replaceChildren(...nodes);
  drawRuler();
  drawAudio();
  movePlayhead();
}

/** Положение каждого клипа на дорожке в пикселях. */
function layout() {
  const list = clips();
  const nodes = [...$('videoTrack').querySelectorAll('.clip')];
  return nodes.map((n, i) => ({ clip: list[i], left: n.offsetLeft - $('videoTrack').offsetLeft, width: n.offsetWidth }));
}

function canvasFor(id) {
  const canvas = $(id);
  const width = Math.max($('scroller').clientWidth - 24, $('videoTrack').scrollWidth);
  const height = canvas.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  canvas.style.width = `${width}px`;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const g = canvas.getContext('2d');
  g.scale(ratio, ratio);
  return { g, width, height };
}

function drawRuler() {
  const { g, width, height } = canvasFor('ruler');
  g.fillStyle = '#4a5366';
  for (let x = 0, i = 0; x < width; x += 20, i++) g.fillRect(x, height - (i % 5 ? 5 : 13), 1, i % 5 ? 5 : 13);
}

function drawAudio() {
  const { g, width, height } = canvasFor('audioTrack');
  g.fillStyle = '#2a303d';
  g.fillRect(0, 0, width, height);
  g.fillStyle = '#4c8fe0';
  const mid = height / 2;
  for (const { clip, left, width: w } of layout()) {
    const peaks = clip.peaks;
    if (!peaks?.length) {
      g.fillRect(left, mid, w, 1); // тишина или волна ещё считается
      continue;
    }
    for (let x = 0; x < w; x += 2) {
      const from = Math.floor((x / w) * peaks.length);
      const to = Math.max(from + 1, Math.floor(((x + 2) / w) * peaks.length));
      let peak = 0;
      for (let i = from; i < to && i < peaks.length; i++) peak = Math.max(peak, peaks[i]);
      const h = Math.max(1, Math.sqrt(peak) * (height - 8));
      g.fillRect(left + x, mid - h / 2, 1.4, h);
    }
  }
}

function movePlayhead() {
  const spot = layout().find((s) => s.clip === selected);
  $('playhead').hidden = !spot;
  if (!spot) return;
  const part = Math.min(1, ($('video').currentTime || 0) / (selected.duration || 1));
  $('playhead').style.left = `${24 + spot.left + spot.width * part}px`;
}

for (const id of ['ruler', 'audioTrack']) {
  $(id).onclick = (e) => {
    const x = e.clientX - $(id).getBoundingClientRect().left;
    const spot = layout().find((s) => x >= s.left && x <= s.left + s.width);
    if (spot) select(spot.clip, ((x - spot.left) / spot.width) * spot.clip.duration);
  };
}

function render() {
  $('list').replaceChildren(...files.map(listItem));
  $('count').textContent = files.length;
  $('clear').disabled = !files.length;
  $('merge').disabled = !clips().length;
  $('total').textContent = hms(totalDuration());
  renderTimeline();
  if (!outputDir) $('outputDir').textContent = clips()[0]?.dir || 'Same as first video';
  $('outputDir').title = $('outputDir').textContent;
}

function update() {
  render();
  updateSettings();
}

new ResizeObserver(() => renderTimeline()).observe($('scroller'));

// ---------- плеер ----------

const video = $('video');
let pendingSeek = 0;

function select(clip, at = 0) {
  if (clip && clip === selected) {
    video.currentTime = at;
    return;
  }
  selected = clip;
  pendingSeek = at;
  if (clip) {
    video.poster = clip.thumb || '';
    video.src = clip.url;
    $('playerNote').textContent = '';
  } else {
    video.removeAttribute('src');
    video.removeAttribute('poster');
    video.load();
    $('playerNote').textContent = 'No video selected';
  }
  render();
  updatePlayer();
}

function updatePlayer() {
  const duration = selected?.duration || 0;
  const time = Math.min(video.currentTime || 0, duration);
  $('clock').textContent = `${short(time)} / ${short(duration)}`;
  const part = duration ? time / duration : 0;
  $('seek').value = Math.round(part * 1000);
  $('seek').style.setProperty('--fill', `${part * 100}%`);
  $('play').replaceChildren(icon(video.paused ? 'play' : 'pause'));
  $('bigPlay').hidden = !selected || !video.paused;
  movePlayhead();
}

const toggle = () => {
  if (!selected) return;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
};
$('play').onclick = toggle;
$('bigPlay').onclick = toggle;
video.onclick = toggle;
for (const name of ['timeupdate', 'play', 'pause', 'seeked', 'emptied']) video.addEventListener(name, updatePlayer);
video.addEventListener('loadedmetadata', () => {
  if (pendingSeek) video.currentTime = pendingSeek;
  pendingSeek = 0;
});
// Клипы проигрываются друг за другом, как в готовом ролике.
video.addEventListener('ended', () => {
  const list = clips();
  const next = list[list.indexOf(selected) + 1];
  if (!next) return;
  select(next);
  video.play().catch(() => {});
});
video.addEventListener('error', () => {
  if (video.getAttribute('src')) $('playerNote').textContent = 'No preview for this format — it can still be merged';
});
$('seek').oninput = () => {
  if (selected) video.currentTime = ($('seek').value / 1000) * selected.duration;
};
$('mute').onclick = () => {
  video.muted = !video.muted;
  $('mute').replaceChildren(icon(video.muted ? 'mute' : 'volume'));
};
$('full').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('playerBox').requestFullscreen();
};

// ---------- настройки вывода ----------

function outputChoice() {
  const [format, codec] = $('format').value.split(':');
  return { format, codec };
}

function targetSize() {
  const first = clips()[0];
  const even = (n) => Math.round(n / 2) * 2;
  if ($('resolution').value !== 'source') return $('resolution').value.split('x').map(Number);
  return first ? [even(first.width), even(first.height)] : [1920, 1080];
}

const targetFps = () => ($('fps').value === 'source' ? Math.round((clips()[0]?.fps || 30) * 1000) / 1000 : Number($('fps').value));

let settingsCheck = 0;
async function updateSettings() {
  const id = ++settingsCheck;
  const list = clips();
  const problems = list.length ? await window.api.copyProblems(list) : [];
  if (id !== settingsCheck) return;
  const { codec } = outputChoice();

  copyBlocker = '';
  if (problems.length) copyBlocker = `clips differ in ${problems.join(', ')}`;
  else if ($('resolution').value !== 'source' || $('fps').value !== 'source') copyBlocker = 'resolution or frame rate is changed';
  else if (list.length && list[0].vcodec !== codec) copyBlocker = `source video is ${list[0].vcodec}, not ${codec}`;
  canCopy = !copyBlocker;

  // Пока пользователь не трогал ползунок, выбираем лучшее из возможного.
  const slider = $('quality');
  if (!qualityTouched) slider.value = canCopy && list.length ? 3 : 2;
  if (!canCopy && slider.value === '3') slider.value = 2;
  showSettings();
}

function showSettings() {
  const slider = $('quality');
  const quality = QUALITY[slider.value];
  $('qualityName').textContent = quality.name;
  slider.style.setProperty('--fill', `${(slider.value / 3) * 100}%`);

  const hint = $('hint');
  const list = clips();
  hint.className = '';
  if (quality.key === 'original') {
    const pcm = list[0]?.acodec?.startsWith('pcm') && outputChoice().format === 'mp4';
    hint.textContent = `No re-encoding, picture stays untouched.${pcm ? ' Audio becomes AAC; pick MOV to keep it.' : ''}`;
  } else if (!canCopy && list.length) {
    hint.className = 'warn';
    hint.textContent = `Will be re-encoded: ${copyBlocker}.`;
  } else {
    hint.textContent = 'Will be re-encoded. Move the slider to Original to keep source quality.';
  }

  // Прикидка размера результата.
  let size = list.reduce((s, c) => s + c.size, 0);
  if (quality.key !== 'original') {
    const [w, h] = targetSize();
    const bitsPerPixel = { small: 0.045, medium: 0.09, high: 0.15 }[quality.key] * (outputChoice().codec === 'hevc' ? 0.65 : 1);
    size = ((w * h * targetFps() * bitsPerPixel + 192000) * totalDuration()) / 8;
  }
  $('estimate').textContent = list.length ? `~ ${bytes(size)}` : '~ 0 MB';
}

$('quality').oninput = () => {
  qualityTouched = true;
  if ($('quality').value === '3' && !canCopy) $('quality').value = 2;
  showSettings();
};
for (const id of ['format', 'resolution', 'fps']) $(id).onchange = updateSettings;

function setOutputDir(dir) {
  outputDir = dir;
  render();
  if (dir) $('outputDir').textContent = dir;
  $('outputDir').title = $('outputDir').textContent;
}
$('browse').onclick = async () => {
  const dir = await window.api.chooseFolder();
  if (dir) setOutputDir(dir);
};

function exportOptions() {
  const { format, codec } = outputChoice();
  const quality = QUALITY[$('quality').value].key;
  const [width, height] = targetSize();
  return {
    mode: quality === 'original' ? 'copy' : 'encode',
    format,
    codec,
    quality,
    width,
    height,
    fps: targetFps(),
    encoder: $('hw').checked ? hardware[codec] : null,
    outputDir: outputDir || clips()[0].dir,
  };
}

// ---------- склейка ----------

function openDialog(title) {
  $('jobTitle').textContent = title;
  $('jobInfo').textContent = '';
  $('progress').value = 0;
  $('progress').hidden = false;
  $('jobError').hidden = true;
  $('cancel').hidden = false;
  $('done').hidden = true;
  $('reveal').hidden = true;
  $('overlay').hidden = false;
}

function finishDialog(title) {
  $('jobTitle').textContent = title;
  $('cancel').hidden = true;
  $('done').hidden = false;
  $('reveal').hidden = !lastOutput;
}

function showError(title, message) {
  lastOutput = null;
  openDialog(title);
  $('progress').hidden = true;
  $('jobError').hidden = false;
  $('jobError').textContent = message;
  finishDialog(title);
}

window.api.onProgress(({ percent, done, total, speed }) => {
  $('progress').value = percent;
  $('jobInfo').textContent = `${percent.toFixed(0)}% · ${short(done)} of ${short(total)}${speed && speed !== 'N/A' ? ` · speed ${speed}` : ''}`;
});

$('merge').onclick = async () => {
  video.pause();
  lastOutput = null;
  openDialog('Merging…');
  try {
    const result = await window.api.exportVideo(clips(), exportOptions());
    lastOutput = result.output;
    $('jobInfo').textContent = result.output;
    finishDialog('Done');
  } catch (err) {
    const message = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    if (message === 'Cancelled') $('overlay').hidden = true;
    else showError('Merge failed', message);
  }
};
$('cancel').onclick = () => window.api.cancelExport();
$('done').onclick = () => ($('overlay').hidden = true);
$('reveal').onclick = () => window.api.showInFolder(lastOutput);

// ---------- меню, окно, запуск ----------

for (const button of document.querySelectorAll('nav button')) {
  button.onclick = () => {
    video.pause();
    for (const b of document.querySelectorAll('nav button')) b.classList.toggle('active', b === button);
    for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== `view-${button.dataset.view}`;
  };
}
for (const button of document.querySelectorAll('[data-win]')) button.onclick = () => window.api.window(button.dataset.win);

update();
updatePlayer();

// ---------- проверка компонентов при запуске ----------

window.api.onSetupProgress(({ name, index, count, percent }) => {
  $('setupText').textContent = `Downloading ${name} (${index + 1} of ${count}) · ${percent}%`;
  $('setupProgress').value = (index * 100 + percent) / count;
});

async function start() {
  let info = await window.api.info();
  document.body.classList.toggle('mac', info.platform === 'darwin');
  $('version').textContent = info.version;

  if (!info.ffmpeg || !info.ffprobe) {
    $('setup').hidden = false;
    $('setupRetry').hidden = true;
    $('setupProgress').value = 0;
    $('setupText').textContent = 'FFmpeg is not installed. Downloading it now (about 60 MB, only once)…';
    try {
      await window.api.installFfmpeg();
      info = await window.api.info();
      if (!info.ffmpeg || !info.ffprobe) throw new Error('FFmpeg was downloaded but does not start.');
    } catch (err) {
      const message = err.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
      $('setupText').textContent = `Could not install FFmpeg: ${message}\nCheck the internet connection and try again.`;
      $('setupRetry').hidden = false;
      return;
    }
  }
  $('setup').hidden = true;

  const sources = {
    env: 'set by environment variable',
    system: 'installed in the system',
    bundled: 'bundled with the app',
    downloaded: 'downloaded by the app',
  };
  $('ffmpegInfo').textContent = `Using the one ${sources[info.ffmpeg.source]}\n${info.ffmpeg.path}\n${info.ffprobe.path}`;

  hardware = await window.api.detectHardware();
  const found = [hardware.h264, hardware.hevc].filter(Boolean);
  $('hw').disabled = !found.length;
  $('hw').checked = found.length > 0;
  $('hwLabel').textContent = found.length ? `Hardware acceleration (${found.join(', ')})` : 'Hardware acceleration is not available';
}

$('setupRetry').onclick = start;
start();

'use strict';

const $ = (id) => document.getElementById(id);

// Один упорядоченный список кусков: он же «Video Files» и он же таймлайн.
// Кусок — это файл с границами in/out; разрезание даёт два куска одного файла.
// Нечитаемые файлы видны в списке, но на таймлайн не попадают.
let files = [];
let selected = null;
let drag = null; // { clip }
let filter = 'all'; // all | horizontal | vertical — скрытое в склейку не идёт
let zoom = 0; // 0..100
let outputDir = null; // null — рядом с первым видео
let qualityTouched = false;
let canCopy = false;
let copyBlocker = '';
let hardware = { h264: null, hevc: null };
let lastOutput = null;
let nextId = 1;
const peaksByPath = new Map();

const MIN_PIECE = 0.1; // секунд
const GAP = 40; // ширина стрелки между клипами
const MIN_WIDTH = 90;
const QUALITY = [
  { key: 'small', name: 'Small' },
  { key: 'medium', name: 'Medium' },
  { key: 'high', name: 'High' },
  { key: 'original', name: 'Original' },
];

const orientation = (c) => (c.height > c.width ? 'vertical' : 'horizontal');
const shown = (f) => f.error || filter === 'all' || orientation(f) === filter;
const clips = () => files.filter((f) => !f.error && shown(f));
const mixed = () => new Set(clips().map(orientation)).size > 1;
const len = (c) => c.out - c.in;
const trimmed = (c) => c.in > 0.001 || c.out < c.duration - 0.001;
const totalDuration = () => clips().reduce((s, c) => s + len(c), 0);

const pad = (n) => String(Math.floor(n)).padStart(2, '0');
const hms = (s) => {
  s = Math.round(s);
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
};
const short = (s) => {
  s = Math.floor(s || 0);
  return s >= 3600 ? hms(s) : `${pad(s / 60)}:${pad(s % 60)}`;
};
// С десятыми долями — чтобы точно ставить место разреза.
const precise = (s) => `${short(s)}.${Math.floor(((s || 0) % 1) * 10)}`;
const bytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const day = (ms) => (ms ? new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

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

// ---------- отмена и повтор ----------

const undoStack = [];
const redoStack = [];
const snapshot = () => files.map((f) => [f, f.in, f.out]);

function remember(state = snapshot()) {
  undoStack.push(state);
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}

function travel(from, to) {
  const state = from.pop();
  if (!state) return;
  to.push(snapshot());
  files = state.map(([f, start, end]) => Object.assign(f, { in: start, out: end }));
  $('sort').value = 'manual';
  const keep = clips().includes(selected) ? selected : clips()[0] || null;
  selected = null;
  select(keep);
  update();
  refreshThumbs();
}
const undo = () => travel(undoStack, redoStack);
const redo = () => travel(redoStack, undoStack);

// ---------- добавление, удаление, порядок ----------

async function addPaths(paths) {
  if (!paths.length) return;
  $('count').textContent = '…';
  let found = [];
  try {
    found = await window.api.probe(paths);
  } catch (err) {
    showError('Could not add files', err.message);
  }
  const before = snapshot();
  let added = 0;
  for (const info of found) {
    const index = files.findIndex((f) => f.path === info.path);
    const clip = { ...info, id: nextId++, in: 0, out: info.duration || 0 };
    if (index === -1) files.push(clip);
    else if (files[index].error) files[index] = clip; // повторная попытка после ошибки
    else continue;
    added += 1;
  }
  if (added && before.length) remember(before);
  applySort();
  if (!selected) select(clips()[0] || null);
  update();
  refreshThumbs();
}

let loading = false;
/** Догружает кадры и волны, которых ещё нет. */
async function refreshThumbs() {
  if (loading) return;
  loading = true;
  const needed = () => files.find((f) => !f.error && f.thumbAt !== f.in);
  for (let clip = needed(); clip; clip = needed()) {
    const at = clip.in;
    clip.thumb = await window.api.thumbnail(clip.path, clip.duration, at);
    clip.thumbAt = at;
    if (clip === selected && video.paused) video.poster = clip.thumb || '';
    render();
  }
  const silent = () => files.find((f) => !f.error && !peaksByPath.has(f.path));
  for (let clip = silent(); clip; clip = silent()) {
    peaksByPath.set(clip.path, null);
    peaksByPath.set(clip.path, clip.acodec ? await window.api.waveform(clip.path, clip.duration) : []);
    drawAudio();
  }
  loading = false;
  if (needed()) refreshThumbs();
}

function remove(clip) {
  remember();
  const list = clips();
  const index = list.indexOf(clip);
  files = files.filter((f) => f !== clip);
  if (selected === clip) {
    selected = null;
    select(clips()[Math.min(index, clips().length - 1)] || null);
  }
  update();
}

/** Переставляет clip перед target (или в конец, если target нет). */
function move(clip, target) {
  if (clip === target) return;
  remember();
  files.splice(files.indexOf(clip), 1);
  const at = target ? files.indexOf(target) : files.length;
  files.splice(at, 0, clip);
  $('sort').value = 'manual';
  update();
}

function split() {
  if (!selected) return;
  const at = video.currentTime;
  if (at < selected.in + MIN_PIECE || at > selected.out - MIN_PIECE) return;
  remember();
  video.pause();
  const second = { ...selected, id: nextId++, in: at, thumb: selected.thumb, thumbAt: null };
  selected.out = at;
  files.splice(files.indexOf(selected) + 1, 0, second);
  selected = second;
  update();
  updatePlayer();
  refreshThumbs();
}

function applySort() {
  const mode = $('sort').value;
  if (mode === 'manual') return;
  const compare = {
    oldest: (a, b) => a.created - b.created,
    newest: (a, b) => b.created - a.created,
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
  }[mode];
  // Куски одного файла остаются по порядку времени.
  files.sort((a, b) => !!a.error - !!b.error || compare(a, b) || a.path.localeCompare(b.path) || a.in - b.in);
}
$('sort').onchange = () => {
  if ($('sort').value === 'manual') return;
  remember();
  applySort();
  update();
};

function setFilter(value) {
  filter = value;
  if (!clips().includes(selected)) {
    video.pause();
    selected = null;
    select(clips()[0] || null);
  }
  update();
}
for (const button of document.querySelectorAll('[data-filter]')) button.onclick = () => setFilter(button.dataset.filter);
$('keepHorizontal').onclick = () => setFilter('horizontal');
$('keepVertical').onclick = () => setFilter('vertical');

function renderFilter() {
  const good = files.filter((f) => !f.error);
  const count = { all: good.length, horizontal: 0, vertical: 0 };
  for (const f of good) count[orientation(f)] += 1;
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.classList.toggle('active', button.dataset.filter === filter);
    button.querySelector('b').textContent = count[button.dataset.filter];
  }
  const hidden = count.all - clips().length;
  const warn = filter === 'all' && mixed();
  $('orientationNote').hidden = !warn && !hidden;
  $('orientationNote').className = warn ? 'warn' : '';
  $('orientationText').textContent = warn
    ? 'Horizontal and vertical videos are mixed.'
    : `${hidden} ${filter === 'horizontal' ? 'vertical' : 'horizontal'} piece${hidden === 1 ? ' is' : 's are'} hidden and will not be merged.`;
  $('keepHorizontal').hidden = !warn;
  $('keepVertical').hidden = !warn;
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
  if (e.target === $('dropzone') && e.key === 'Enter') $('dropzone').click();
};
$('addFolder').onclick = async (e) => {
  e.stopPropagation();
  const dir = await window.api.chooseFolder();
  if (dir) addPaths([dir]);
};
$('clear').onclick = () => {
  remember();
  files = [];
  filter = 'all';
  select(null);
  update();
};

// ---------- список ----------

function listItem(clip) {
  const node = el('div', `item${clip === selected ? ' selected' : ''}`);
  node.title = clip.path;
  const text = el('div', 'text');
  text.append(el('div', 'name', clip.name));
  if (clip.error) {
    text.append(el('div', 'meta error', clip.error));
  } else {
    text.append(el('div', 'meta', `${clip.width}×${clip.height}  •  ${Math.round(clip.fps * 100) / 100} fps  •  ${bytes(clip.size)}`));
    text.append(
      trimmed(clip)
        ? el('div', 'meta cut', `✂ ${precise(clip.in)} – ${precise(clip.out)}`)
        : el('div', 'meta', day(clip.created)),
    );
  }
  const close = el('button', 'remove');
  close.title = 'Remove';
  close.append(icon('x'));
  close.onclick = (e) => {
    e.stopPropagation();
    remove(clip);
  };
  node.append(el('div', 'grip'), thumbNode(clip), text);
  if (!clip.error) node.append(el('div', 'pill', hms(len(clip))));
  node.append(close);
  if (!clip.error) node.onclick = () => select(clip);
  draggable(node, clip, false, () => $('list').children);
  return node;
}

// ---------- таймлайн ----------

/** Пикселей на секунду: при zoom = 0 всё помещается в окно, при 100 — 80 px на секунду. */
function pixelsPerSecond() {
  const list = clips();
  const total = totalDuration() || 1;
  const available = $('scroller').clientWidth - GAP * Math.max(0, list.length - 1) - 12;
  // Клипам, которым не хватает минимальной ширины, она отдаётся заранее.
  let fit = Math.max(0.01, available / total);
  for (let pass = 0; pass < 3; pass++) {
    const small = list.filter((c) => len(c) * fit < MIN_WIDTH);
    const rest = total - small.reduce((s, c) => s + len(c), 0);
    if (rest > 0) fit = Math.max(0.01, (available - small.length * MIN_WIDTH) / rest);
  }
  return fit * Math.pow(Math.max(1, 80 / fit), zoom / 100);
}

let scale = 1;
let justTrimmed = false;

function renderTimeline() {
  scale = pixelsPerSecond();
  const nodes = [];
  clips().forEach((clip, i) => {
    if (i) nodes.push(el('div', 'gap', '➜'));
    const node = el('div', `clip${clip === selected ? ' selected' : ''}`);
    node.title = `${clip.path}\n${precise(clip.in)} – ${precise(clip.out)}`;
    const text = el('div', 'label');
    const time = el('div', 'time', hms(len(clip)));
    text.append(el('div', 'name', `${trimmed(clip) ? '✂ ' : ''}${clip.name}`), time);
    node.append(thumbNode(clip), text);
    for (const side of ['left', 'right']) {
      const handle = el('div', `handle ${side}`);
      handle.title = side === 'left' ? 'Drag to trim the start' : 'Drag to trim the end';
      handle.onpointerdown = (e) => startTrim(e, clip, side, node, time);
      handle.onclick = (e) => e.stopPropagation();
      node.append(handle);
    }
    sizeNode(node, clip);
    node.onclick = (e) => {
      if (justTrimmed) return;
      const r = node.getBoundingClientRect();
      select(clip, ((e.clientX - r.left) / r.width) * len(clip));
    };
    draggable(node, clip, true, () => $('videoTrack').children);
    nodes.push(node);
  });
  $('videoTrack').replaceChildren(...nodes);
  drawTracks();
}

function sizeNode(node, clip) {
  const width = Math.max(MIN_WIDTH, Math.round(len(clip) * scale));
  node.style.width = `${width}px`;
  node.classList.toggle('narrow', width < 210);
}

/** Тянем край клипа мышью: плеер показывает кадр в месте реза. */
function startTrim(event, clip, side, node, time) {
  event.preventDefault();
  event.stopPropagation();
  node.draggable = false;
  video.pause();
  select(clip, side === 'left' ? 0 : len(clip));
  const live = $('videoTrack').querySelectorAll('.clip')[clips().indexOf(clip)];
  const target = live || node;
  const label = live ? live.querySelector('.time') : time;
  const before = snapshot();
  const from = { x: event.clientX, in: clip.in, out: clip.out };
  const pps = scale;
  const onMove = (e) => {
    const delta = (e.clientX - from.x) / pps;
    if (side === 'left') clip.in = Math.min(Math.max(0, from.in + delta), clip.out - MIN_PIECE);
    else clip.out = Math.max(Math.min(clip.duration, from.out + delta), clip.in + MIN_PIECE);
    sizeNode(target, clip);
    label.textContent = hms(len(clip));
    video.currentTime = side === 'left' ? clip.in : clip.out;
    updatePlayer();
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    justTrimmed = true;
    setTimeout(() => (justTrimmed = false), 50);
    if (clip.in !== from.in || clip.out !== from.out) remember(before);
    update();
    updatePlayer();
    refreshThumbs();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/** Положение каждого клипа на дорожке в пикселях. */
function layout() {
  const list = clips();
  const nodes = [...$('videoTrack').querySelectorAll('.clip')];
  return nodes.map((n, i) => ({ clip: list[i], left: n.offsetLeft - $('videoTrack').offsetLeft, width: n.offsetWidth }));
}

// Холсты размером с видимую область: при сильном увеличении дорожка шириной в десятки тысяч пикселей.
function canvasFor(id) {
  const canvas = $(id);
  const width = $('scroller').clientWidth;
  const height = canvas.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  canvas.style.width = `${width}px`;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const g = canvas.getContext('2d');
  g.scale(ratio, ratio);
  return { g, width, height, origin: $('scroller').scrollLeft };
}

function drawRuler() {
  const { g, width, height, origin } = canvasFor('ruler');
  g.fillStyle = '#4a5366';
  for (let i = Math.floor(origin / 20); i * 20 < origin + width; i++) {
    g.fillRect(i * 20 - origin, height - (i % 5 ? 5 : 13), 1, i % 5 ? 5 : 13);
  }
}

function drawAudio() {
  const { g, width, height, origin } = canvasFor('audioTrack');
  g.fillStyle = '#2a303d';
  g.fillRect(0, 0, width, height);
  g.fillStyle = '#4c8fe0';
  const mid = height / 2;
  for (const { clip, left, width: w } of layout()) {
    const first = Math.max(0, Math.floor(origin - left));
    const last = Math.min(w, origin + width - left);
    if (last <= first) continue;
    const peaks = peaksByPath.get(clip.path);
    if (!peaks?.length) {
      g.fillRect(left + first - origin, mid, last - first, 1); // тишина или волна ещё считается
      continue;
    }
    const at = (x) => Math.floor(((clip.in + (x / w) * len(clip)) / clip.duration) * peaks.length);
    for (let x = first - (first % 2); x < last; x += 2) {
      const from = at(x);
      const to = Math.max(from + 1, at(x + 2));
      let peak = 0;
      for (let i = from; i < to && i < peaks.length; i++) peak = Math.max(peak, peaks[i]);
      g.fillRect(left + x - origin, mid - Math.max(1, Math.sqrt(peak) * (height - 8)) / 2, 1.4, Math.max(1, Math.sqrt(peak) * (height - 8)));
    }
  }
}

function drawTracks() {
  drawRuler();
  drawAudio();
  movePlayhead();
}

function movePlayhead() {
  const spot = layout().find((s) => s.clip === selected);
  $('playhead').hidden = !spot;
  if (!spot) return;
  const part = Math.min(1, Math.max(0, (video.currentTime - selected.in) / (len(selected) || 1)));
  const x = spot.left + spot.width * part;
  $('playhead').style.left = `${x}px`;
  const scroller = $('scroller');
  if (!video.paused && (x < scroller.scrollLeft || x > scroller.scrollLeft + scroller.clientWidth - 30)) {
    scroller.scrollLeft = x - 40;
  }
}

// Щелчок и протяжка по линейке или волне — перемотка.
function seekAt(clientX) {
  const x = clientX - $('scroller').getBoundingClientRect().left + $('scroller').scrollLeft;
  const spot = layout().find((s) => x >= s.left && x <= s.left + s.width);
  if (spot) select(spot.clip, ((x - spot.left) / spot.width) * len(spot.clip));
}
for (const id of ['ruler', 'audioTrack']) {
  $(id).onpointerdown = (event) => {
    video.pause();
    seekAt(event.clientX);
    const onMove = (e) => seekAt(e.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
}
$('scroller').addEventListener('scroll', drawTracks);

function setZoom(value) {
  zoom = Math.min(100, Math.max(0, value));
  $('zoom').value = zoom;
  $('zoom').style.setProperty('--fill', `${zoom}%`);
  renderTimeline();
  // Место курсора остаётся на виду.
  const spot = layout().find((s) => s.clip === selected);
  if (spot) {
    const x = spot.left + (spot.width * (video.currentTime - selected.in)) / (len(selected) || 1);
    $('scroller').scrollLeft = x - $('scroller').clientWidth / 2;
    drawTracks();
  }
}
$('zoom').oninput = () => setZoom(Number($('zoom').value));
$('scroller').addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) setZoom(zoom - Math.sign(e.deltaY) * 8);
  else $('scroller').scrollLeft += e.deltaY || e.deltaX;
}, { passive: false });

function render() {
  const visible = files.filter(shown);
  $('list').replaceChildren(...visible.map(listItem));
  $('count').textContent = visible.length;
  $('clear').disabled = !files.length;
  $('merge').disabled = !clips().length;
  $('total').textContent = hms(totalDuration());
  renderFilter();
  renderTimeline();
  $('split').disabled = !selected;
  $('delete').disabled = !selected;
  $('undo').disabled = !undoStack.length;
  $('redo').disabled = !redoStack.length;
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
let pendingSeek = null;

/** at — секунды от начала куска. */
function select(clip, at = 0) {
  if (!clip) {
    selected = null;
    video.removeAttribute('src');
    video.removeAttribute('poster');
    video.load();
    $('playerNote').textContent = 'No video selected';
    render();
    updatePlayer();
    return;
  }
  const changed = clip !== selected;
  selected = clip;
  const time = clip.in + at;
  if (video.getAttribute('src') !== clip.url) {
    pendingSeek = time;
    video.poster = clip.thumb || '';
    video.src = clip.url;
    $('playerNote').textContent = '';
  } else {
    video.currentTime = time;
  }
  if (changed) render();
  updatePlayer();
}

function updatePlayer() {
  const duration = selected ? len(selected) : 0;
  const current = pendingSeek ?? video.currentTime;
  const time = selected ? Math.min(duration, Math.max(0, current - selected.in)) : 0;
  $('clock').textContent = `${precise(time)} / ${precise(duration)}`;
  const part = duration ? time / duration : 0;
  $('seek').value = Math.round(part * 1000);
  $('seek').style.setProperty('--fill', `${part * 100}%`);
  $('play').replaceChildren(icon(video.paused ? 'play' : 'pause'));
  $('bigPlay').hidden = !selected || !video.paused;
  movePlayhead();
}

/** Куски проигрываются друг за другом, как в готовом ролике. */
function advance() {
  const list = clips();
  const next = list[list.indexOf(selected) + 1];
  if (!next) {
    video.pause();
    return;
  }
  if (next.path === selected.path && Math.abs(next.in - selected.out) < 0.05) {
    selected = next; // тот же файл без разрыва — играем дальше без перемотки
    render();
    return;
  }
  select(next);
  video.play().catch(() => {});
}

function checkEnd() {
  if (!video.paused && selected && pendingSeek === null && !video.seeking && video.currentTime >= selected.out - 0.02) advance();
}

// Покадровая проверка точна, но в свёрнутом окне не работает — поэтому ещё и timeupdate.
let frame = 0;
function watchEnd() {
  if (video.paused || !selected) return;
  checkEnd();
  movePlayhead();
  frame = requestAnimationFrame(watchEnd);
}

const toggle = () => {
  if (!selected) return;
  if (!video.paused) {
    video.pause();
    return;
  }
  if (video.currentTime >= selected.out - 0.05 || video.currentTime < selected.in - 0.05) video.currentTime = selected.in;
  video.play().catch(() => {});
};
$('play').onclick = toggle;
$('bigPlay').onclick = toggle;
video.onclick = toggle;
video.addEventListener('play', () => {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(watchEnd);
});
video.addEventListener('timeupdate', checkEnd);
for (const name of ['timeupdate', 'play', 'pause', 'seeked', 'emptied']) video.addEventListener(name, updatePlayer);
video.addEventListener('loadedmetadata', () => {
  if (pendingSeek !== null) video.currentTime = pendingSeek;
  pendingSeek = null;
});
video.addEventListener('ended', () => selected && advance());
video.addEventListener('error', () => {
  if (video.getAttribute('src')) $('playerNote').textContent = 'No preview for this format — it can still be merged';
});
$('seek').oninput = () => {
  if (selected) video.currentTime = selected.in + ($('seek').value / 1000) * len(selected);
};
$('mute').onclick = () => {
  video.muted = !video.muted;
  $('mute').replaceChildren(icon(video.muted ? 'mute' : 'volume'));
};
$('full').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('playerBox').requestFullscreen();
};

// ---------- кнопки редактирования и клавиши ----------

$('split').onclick = split;
$('delete').onclick = () => selected && remove(selected);
$('undo').onclick = undo;
$('redo').onclick = redo;

function step(seconds) {
  if (!selected) return;
  video.pause();
  video.currentTime = Math.min(selected.out, Math.max(selected.in, video.currentTime + seconds));
}

window.addEventListener('keydown', (e) => {
  if (!$('overlay').hidden || !$('setup').hidden || $('view-merge').hidden) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) && e.target.id !== 'zoom') return;
  const command = e.ctrlKey || e.metaKey;
  let action = null;
  if (command && e.code === 'KeyZ') action = e.shiftKey ? redo : undo;
  else if (command && e.code === 'KeyY') action = redo;
  else if (command || e.altKey) return;
  else if (e.code === 'KeyS') action = split;
  else if (e.key === 'Delete' || e.key === 'Backspace') action = () => selected && remove(selected);
  else if (e.code === 'Space') action = toggle;
  else if (e.key === 'ArrowLeft') action = () => step(e.shiftKey ? -1 : -1 / (selected?.fps || 30));
  else if (e.key === 'ArrowRight') action = () => step(e.shiftKey ? 1 : 1 / (selected?.fps || 30));
  if (!action) return;
  e.preventDefault();
  if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur();
  action();
});

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

// В главный процесс картинки не отправляем.
const plain = (list) => list.map(({ thumb, thumbAt, url, ...rest }) => rest);

let settingsCheck = 0;
async function updateSettings() {
  const id = ++settingsCheck;
  const list = clips();
  const problems = list.length ? await window.api.copyProblems(plain(list)) : [];
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
  const cuts = list.some(trimmed);
  hint.className = '';
  if (quality.key === 'original') {
    const pcm = list[0]?.acodec?.startsWith('pcm') && outputChoice().format === 'mp4';
    hint.textContent = cuts
      ? 'No re-encoding: cuts move to the nearest keyframe. For frame-exact cuts choose High.'
      : `No re-encoding, picture stays untouched.${pcm ? ' Audio becomes AAC; pick MOV to keep it.' : ''}`;
  } else if (!canCopy && list.length) {
    hint.className = 'warn';
    hint.textContent = `Will be re-encoded: ${copyBlocker}.`;
  } else {
    hint.textContent = `Will be re-encoded${cuts ? ', cuts are frame-exact' : ''}. Move the slider to Original to keep source quality.`;
  }

  // Прикидка размера результата.
  let size = list.reduce((s, c) => s + (c.size * len(c)) / (c.duration || 1), 0);
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
  const detail = total ? ` · ${short(done)} of ${short(total)}` : ' · cutting pieces';
  $('jobInfo').textContent = `${percent.toFixed(0)}%${detail}${speed && speed !== 'N/A' ? ` · speed ${speed}` : ''}`;
});

$('merge').onclick = async () => {
  video.pause();
  if (mixed() && !window.confirm('Horizontal and vertical videos are mixed: some will get black bars.\nMerge anyway?')) return;
  lastOutput = null;
  openDialog('Merging…');
  try {
    const result = await window.api.exportVideo(plain(clips()), exportOptions());
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

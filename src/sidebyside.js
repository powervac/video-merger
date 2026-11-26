'use strict';
// Раздел «Split Screen»: два видео в одном кадре — вертикальные рядом или горизонтальные друг под другом.

(() => {
  const LAYOUTS = {
    row: {
      names: ['Left', 'Right'],
      want: 'vertical',
      fits: (c) => c.height > c.width,
      bars: 'above and below',
      cut: 'sides',
      suffix: 'side_by_side',
      sizes: [['2160x1920', '2160×1920 (9:8)'], ['1080x960', '1080×960 (9:8)'], ['1080x1080', '1080×1080 (square)'], ['2160x2160', '2160×2160 (square)']],
    },
    column: {
      names: ['Top', 'Bottom'],
      want: 'horizontal',
      fits: (c) => c.width > c.height,
      bars: 'on the sides',
      cut: 'top and bottom',
      suffix: 'top_bottom',
      sizes: [['1920x2160', '1920×2160 (8:9)'], ['1280x1440', '1280×1440 (8:9)'], ['1080x1080', '1080×1080 (square)'], ['2160x2160', '2160×2160 (square)']],
    },
  };
  const layout = () => LAYOUTS[$('sbsLayout').value];
  const slots = [...document.querySelectorAll('.slot')];
  const players = slots.map((s) => s.querySelector('video'));
  const chosen = [null, null];
  let playing = false;
  let position = 0; // общее время обоих видео
  let startedAt = 0;
  let frame = 0;

  const length = () => Math.max(0, ...chosen.map((c) => c?.duration || 0));

  // ---------- выбор файлов ----------

  async function put(paths, side) {
    if (!paths.length) return;
    let found;
    try {
      found = await window.api.probe(paths.slice(0, 2));
    } catch (err) {
      showError('Could not open the video', err.message);
      return;
    }
    const good = found.filter((f) => !f.error);
    if (!good.length) {
      showError('Could not open the video', found[0]?.error || 'No video found');
      return;
    }
    if (good.length >= 2) {
      [chosen[0], chosen[1]] = good;
    } else {
      chosen[side ?? (chosen[0] ? 1 : 0)] = good[0];
    }
    suggestLayout();
    refresh();
  }

  /** Если все выбранные видео подходят только другой раскладке, переключаемся на неё. */
  function suggestLayout() {
    const picked = chosen.filter(Boolean);
    const other = $('sbsLayout').value === 'row' ? 'column' : 'row';
    if (picked.length && picked.every((c) => LAYOUTS[other].fits(c))) {
      $('sbsLayout').value = other;
      applyLayout();
    }
  }

  function applyLayout() {
    const { names, want, sizes } = layout();
    $('sbsSize').replaceChildren(...sizes.map(([value, text]) => new Option(text, value)));
    slots.forEach((slot, i) => {
      slot.querySelector('.slot-empty b').textContent = `${names[i]} video`;
      slot.querySelector('.slot-empty span').textContent = `Drop a ${want} video here or click`;
    });
    $('sbsAudio').options[1].textContent = `${names[0]} only`;
    $('sbsAudio').options[2].textContent = `${names[1]} only`;
    applyShape();
  }

  /** Обновляет окно после любой смены файлов. */
  function refresh() {
    stop();
    position = 0;
    slots.forEach((slot, i) => {
      const clip = chosen[i];
      const player = players[i];
      slot.classList.toggle('filled', Boolean(clip));
      slot.querySelector('.slot-empty').hidden = Boolean(clip);
      slot.querySelector('.slot-remove').hidden = !clip;
      const info = slot.querySelector('.slot-info');
      info.hidden = !clip;
      info.textContent = clip ? `${clip.name} · ${clip.width}×${clip.height} · ${short(clip.duration)}` : '';
      slot.title = clip ? clip.path : '';
      if (!clip) {
        player.removeAttribute('src');
        player.load();
      } else if (player.getAttribute('src') !== clip.url) {
        player.src = clip.url;
      } else {
        player.currentTime = 0;
      }
    });
    applySound();
    updateHint();
    updateClock();
  }

  function updateHint() {
    const hint = $('sbsHint');
    const both = chosen[0] && chosen[1];
    const { names, want, fits, bars, cut } = layout();
    const odd = chosen.filter((c) => c && !fits(c));
    const filled = $('sbsFit').value === 'fill';
    $('sbsRender').disabled = !both;
    hint.className = odd.length ? 'warn' : 'muted';
    if (odd.length) {
      hint.textContent = `${odd.map((c) => c.name).join(', ')}: not ${want}, ${filled ? `the ${cut} will be cut off` : `there will be black bars ${bars}`}.`;
    } else if (both) {
      const shorter = chosen[0].duration <= chosen[1].duration ? 0 : 1;
      const same = Math.abs(chosen[0].duration - chosen[1].duration) < 0.1;
      hint.textContent = `Length ${short(length())}.${same ? '' : ` The ${names[shorter].toLowerCase()} video is shorter: its last frame stays on screen.`}`;
    } else {
      hint.textContent = 'Add a video to each half.';
    }
  }

  slots.forEach((slot, side) => {
    const choose = async () => put(await window.api.chooseFiles(), side);
    // Пустая половина открывает выбор файла, заполненная — пуск и паузу.
    slot.onclick = () => (chosen[side] ? toggleBoth() : choose());
    slot.onkeydown = (e) => e.key === 'Enter' && choose();
    slot.querySelector('.slot-remove').onclick = (e) => {
      e.stopPropagation();
      chosen[side] = null;
      refresh();
    };
    slot.ondragover = (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      slot.classList.add('over');
    };
    slot.ondragleave = () => slot.classList.remove('over');
    slot.ondrop = (e) => {
      e.preventDefault();
      slot.classList.remove('over');
      put([...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean), side);
    };
  });
  // Бросок мимо половин: заполняем свободные.
  $('view-sbs').addEventListener('dragover', (e) => e.dataTransfer.types.includes('Files') && e.preventDefault());
  $('view-sbs').addEventListener('drop', (e) => {
    if (e.target.closest('.slot')) return;
    e.preventDefault();
    put([...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean));
  });

  $('sbsSwap').onclick = () => {
    [chosen[0], chosen[1]] = [chosen[1], chosen[0]];
    refresh();
  };

  // ---------- вид кадра ----------

  /** Просмотр повторяет будущий кадр: те же пропорции, раскладка и заполнение половин. */
  function applyShape() {
    const [width, height] = $('sbsSize').value.split('x').map(Number);
    const box = document.querySelector('.sbs-frame');
    box.style.setProperty('--sbs-ratio', width / height);
    box.classList.toggle('fill', $('sbsFit').value === 'fill');
    box.classList.toggle('column', $('sbsLayout').value === 'column');
    updateHint();
  }
  $('sbsLayout').onchange = applyLayout;
  $('sbsSize').onchange = applyShape;
  $('sbsFit').onchange = applyShape;

  // ---------- общий просмотр ----------

  function applySound() {
    const mode = $('sbsAudio').value;
    players[0].muted = !(mode === 'both' || mode === 'left');
    players[1].muted = !(mode === 'both' || mode === 'right');
  }
  $('sbsAudio').onchange = applySound;

  function updateClock() {
    const total = length();
    const part = total ? Math.min(1, position / total) : 0;
    $('sbsClock').textContent = `${short(position)} / ${short(total)}`;
    $('sbsSeek').value = Math.round(part * 1000);
    $('sbsSeek').style.setProperty('--fill', `${part * 100}%`);
    setIcon($('sbsPlay'), playing ? 'pause' : 'play');
  }

  function seek(time) {
    position = Math.min(length(), Math.max(0, time));
    players.forEach((player, i) => {
      if (chosen[i]) player.currentTime = Math.min(position, Math.max(0, chosen[i].duration - 0.05));
    });
    startedAt = performance.now() - position * 1000;
    updateClock();
  }

  function stop() {
    playing = false;
    cancelAnimationFrame(frame);
    players.forEach((p) => p.pause());
    updateClock();
  }

  function tick() {
    if (!playing) return;
    position = (performance.now() - startedAt) / 1000;
    if (position >= length()) {
      position = length();
      stop();
      return;
    }
    // Короткое видео доиграло — стоит на последнем кадре, как в результате.
    players.forEach((player, i) => {
      if (chosen[i] && position >= chosen[i].duration - 0.05) player.pause();
    });
    updateClock();
    frame = requestAnimationFrame(tick);
  }

  function toggleBoth() {
    if (playing) return stop();
    if (!length()) return;
    if (position >= length() - 0.05) position = 0;
    seek(position);
    playing = true;
    players.forEach((player, i) => {
      if (chosen[i] && position < chosen[i].duration - 0.05) player.play().catch(() => {});
    });
    frame = requestAnimationFrame(tick);
    updateClock();
  }
  $('sbsPlay').onclick = toggleBoth;
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || $('view-sbs').hidden || !$('overlay').hidden) return;
    if (['INPUT', 'SELECT'].includes(e.target.tagName)) return;
    e.preventDefault();
    if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur();
    toggleBoth();
  });
  $('sbsSeek').oninput = () => {
    // Сначала читаем ползунок: stop() перерисовывает его по старой позиции.
    const target = ($('sbsSeek').value / 1000) * length();
    stop();
    seek(target);
  };
  // Уходя из раздела, останавливаем звук.
  for (const button of document.querySelectorAll('nav button')) button.addEventListener('click', stop);

  // ---------- рендер ----------

  let asking = false;
  $('sbsRender').onclick = async () => {
    if (asking || !chosen[0] || !chosen[1]) return;
    stop();
    const [format, codec] = $('sbsFormat').value.split(':');
    const [width, height] = $('sbsSize').value.split('x').map(Number);
    const options = {
      mode: 'sidebyside',
      direction: $('sbsLayout').value,
      suffix: layout().suffix,
      format,
      codec,
      width,
      height,
      fps: Math.min(60, Math.round(Math.max(chosen[0].fps, chosen[1].fps) * 1000) / 1000 || 30),
      quality: $('sbsQuality').value,
      audio: $('sbsAudio').value,
      fit: $('sbsFit').value,
      encoder: $('hw').checked ? hardware[codec] : null,
    };
    asking = true;
    let output;
    try {
      output = await askSideOutput(chosen[0], options);
    } catch (err) {
      showError('Render failed', err.message);
      return;
    } finally {
      asking = false;
    }
    if (!output) return;
    lastOutput = null;
    openDialog('Rendering…');
    try {
      const clips = plain(chosen).map((c) => ({ ...c, in: 0, out: c.duration }));
      const result = await window.api.exportVideo(clips, { ...options, output });
      lastOutput = result.output;
      $('jobInfo').textContent = result.output;
      finishDialog('Done');
    } catch (err) {
      const message = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      if (message === 'Cancelled') $('overlay').hidden = true;
      else showError('Render failed', message);
    }
  };

  applyLayout();
  refresh();
})();

// Отдельная функция, чтобы автотест мог задать имя без системного окна.
async function askSideOutput(first, options) {
  return window.api.chooseOutput(first.name, first.dir, options.format, options.suffix);
}

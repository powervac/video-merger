'use strict';
// Разделители панелей: ширина правой колонки (превью) и высота таймлайна. Размеры запоминаются.

(() => {
  const root = document.documentElement;
  const right = document.querySelector('.right');

  const load = (key) => {
    try {
      return Number(localStorage.getItem(key)) || null;
    } catch {
      return null;
    }
  };
  const save = (key, value) => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
    } catch {
      // без хранилища размеры просто не переживут перезапуск
    }
  };

  /**
   * handle — разделитель; axis — 'x' или 'y'; current() — размер сейчас;
   * limits() — [мин, макс]; direction = -1, если панель растёт при движении влево/вверх.
   */
  function splitter({ handle, axis, variable, key, current, limits, direction, step }) {
    let value = load(key);
    const apply = () => {
      if (value === null) root.style.removeProperty(variable);
      else root.style.setProperty(variable, `${value}px`);
    };
    const set = (next) => {
      const [min, max] = limits();
      value = next === null ? null : Math.round(Math.min(Math.max(next, min), Math.max(min, max)));
      apply();
    };
    apply();

    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const from = axis === 'x' ? event.clientX : event.clientY;
      const size = current();
      handle.classList.add('active');
      document.body.classList.add(`resizing-${axis}`);
      const move = (e) => set(size + direction * ((axis === 'x' ? e.clientX : e.clientY) - from));
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        handle.classList.remove('active');
        document.body.classList.remove(`resizing-${axis}`);
        save(key, value);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    // Двойной щелчок возвращает размер по умолчанию.
    handle.addEventListener('dblclick', () => {
      set(null);
      save(key, null);
    });
    handle.addEventListener('keydown', (e) => {
      const keys = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      const index = keys.indexOf(e.key);
      if (index === -1) return;
      e.preventDefault();
      e.stopPropagation(); // те же стрелки в окне двигают курсор по кадрам
      set(current() + direction * (index ? step : -step));
      save(key, value);
    });
  }

  splitter({
    handle: document.getElementById('splitSide'),
    axis: 'x',
    variable: '--right-width',
    key: 'rightWidth',
    current: () => right.getBoundingClientRect().width,
    limits: () => [360, document.querySelector('.top').clientWidth - 420],
    direction: -1,
    step: 30,
  });

  splitter({
    handle: document.getElementById('splitTimeline'),
    axis: 'y',
    variable: '--track-height',
    key: 'trackHeight',
    current: () => document.getElementById('videoTrack').getBoundingClientRect().height,
    limits: () => [56, 170],
    direction: -1,
    step: 10,
  });
})();

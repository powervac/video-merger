// End-to-end check of a built application: first start downloads FFmpeg, then two merges and two split screens.
// Usage: node test/smoke.js <path to the application binary>   (Node 22 or newer)
'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const binary = process.argv[2];
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-smoke-'));
const profile = path.join(work, 'profile');
const out = path.join(work, 'out');
const shots = path.resolve('smoke-shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(shots, { recursive: true });
  // Если сам тест запущен через Electron как node, приложению эту переменную передавать нельзя.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(binary, ['--remote-debugging-port=9333', `--user-data-dir=${profile}`], { stdio: 'inherit', env });
  try {
    let page;
    for (let i = 0; i < 120 && !page; i++) {
      await sleep(500);
      try {
        page = (await (await fetch('http://127.0.0.1:9333/json')).json()).find((t) => t.type === 'page');
      } catch {}
    }
    if (!page) throw new Error('the application did not start');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
    let id = 0;
    const waiting = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      waiting.get(m.id)?.(m);
    };
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        waiting.set(++id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const js = async (expression) => {
      const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (m.result.exceptionDetails) throw new Error(m.result.exceptionDetails.exception.description);
      return m.result.result.value;
    };
    const until = async (expression, seconds, what) => {
      for (let i = 0; i < seconds * 4; i++) {
        if (await js(expression)) return;
        await sleep(250);
      }
      throw new Error(`timeout: ${what}`);
    };

    await until(`typeof $ === 'function' && ($('ffmpegInfo').textContent.startsWith('Using') || !$('setupRetry').hidden)`, 300, 'first start');
    const info = await js(`$('ffmpegInfo').textContent || $('setupText').textContent`);
    console.log(info);
    const [ffmpeg] = info.split('\n').filter((line) => /ffmpeg(.exe)?$/.test(line));
    if (!ffmpeg) throw new Error('FFmpeg is not ready');

    const clips = ['one.mp4', 'two.mp4'].map((name) => path.join(work, name));
    for (const clip of clips) {
      execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=2', '-f', 'lavfi', '-i', 'sine=d=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
    }
    await js(`addPaths(${JSON.stringify(clips)})`);
    await until(`document.querySelectorAll('#videoTrack .clip img').length === 2`, 60, 'thumbnails');
    await js(`setOutputDir(${JSON.stringify(out)})`);

    for (const resolution of ['source', '1280x720']) {
      await js(`$('resolution').value = '${resolution}'; $('resolution').onchange()`);
      await sleep(500);
      // Системное окно «Сохранить как» в автотесте заменяем заданным именем.
      await js(`askOutput = async () => ${JSON.stringify(path.join(out, `result-${resolution}.mp4`))}`);
      await js(`$('merge').click()`);
      await until(`!$('done').hidden`, 120, `merge ${resolution}`);
      const result = await js(`$('jobTitle').textContent + ($('jobError').hidden ? '' : ': ' + $('jobError').textContent)`);
      console.log(resolution, '->', result);
      if (result !== 'Done') throw new Error(result);
      await js(`$('done').click()`);
    }
    // Split Screen: обе раскладки через тот же вызов, что и кнопка Render Video.
    for (const [direction, width, height] of [['row', 1080, 960], ['column', 1280, 1440]]) {
      const output = path.join(out, `split-${direction}.mp4`);
      const size = await js(`(async () => {
        const found = await window.api.probe(${JSON.stringify(clips)});
        const pair = found.map(({ url, ...c }) => ({ ...c, in: 0, out: c.duration }));
        const options = { mode: 'sidebyside', direction: '${direction}', fit: 'whole', audio: 'both', format: 'mp4', codec: 'h264',
          quality: 'medium', width: ${width}, height: ${height}, fps: 25, encoder: null, output: ${JSON.stringify(output)} };
        await window.api.exportVideo(pair, options);
        const [result] = await window.api.probe([options.output]);
        return result.width + 'x' + result.height;
      })()`);
      console.log('split screen', direction, '->', size);
      if (size !== `${width}x${height}`) throw new Error('wrong split screen size');
    }

    const files = fs.readdirSync(out);
    console.log('results:', files);
    if (files.length !== 4) throw new Error('expected four result files');

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, `${process.platform}-${process.arch}.png`), Buffer.from(shot.result.data, 'base64'));
    console.log('SMOKE TEST PASSED');
  } finally {
    app.kill();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('SMOKE TEST FAILED:', err.message);
    process.exit(1);
  },
);

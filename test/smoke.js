// End-to-end check of a built application: first start downloads FFmpeg, then two merges.
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
      await js(`$('merge').click()`);
      await until(`!$('done').hidden`, 120, `merge ${resolution}`);
      const result = await js(`$('jobTitle').textContent + ($('jobError').hidden ? '' : ': ' + $('jobError').textContent)`);
      console.log(resolution, '->', result);
      if (result !== 'Done') throw new Error(result);
      await js(`$('done').click()`);
    }
    const files = fs.readdirSync(out);
    console.log('results:', files);
    if (files.length !== 2) throw new Error('expected two result files');

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

// Первый запуск: докачивает FFmpeg, если его нет ни в системе, ни рядом с приложением.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const BASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';

// size и sha256 — для распакованного файла; скачивается сжатый .gz.
const TOOLS = {
  'win32-x64': {
    ffmpeg: { size: 82797568, sha256: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00' },
    ffprobe: { size: 82668032, sha256: '3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4' },
  },
};

const fileName = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

/** Скачивает перечисленные программы в dir. onProgress({ name, index, count, percent }). */
async function install(names, dir, onProgress = () => {}) {
  const platform = `${process.platform}-${process.arch}`;
  const known = TOOLS[platform];
  if (!known) throw new Error(`Automatic download is not available for ${platform}. Please install FFmpeg yourself.`);
  fs.mkdirSync(dir, { recursive: true });

  for (const [index, name] of names.entries()) {
    const tool = known[name];
    const target = path.join(dir, fileName(name));
    const partial = `${target}.part`;
    const hash = crypto.createHash('sha256');
    let done = 0;
    let shown = -1;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        done += chunk.length;
        const percent = Math.min(99, Math.floor((done / tool.size) * 100));
        if (percent !== shown) onProgress({ name, index, count: names.length, percent: (shown = percent) });
        callback(null, chunk);
      },
    });
    try {
      onProgress({ name, index, count: names.length, percent: 0 });
      const response = await fetch(`${BASE}/${name}-${platform}.gz`);
      if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), zlib.createGunzip(), meter, fs.createWriteStream(partial));
      if (hash.digest('hex') !== tool.sha256) throw new Error(`Checksum mismatch for ${name}: the file was not installed.`);
      fs.chmodSync(partial, 0o755);
      fs.renameSync(partial, target);
    } finally {
      fs.rmSync(partial, { force: true });
    }
  }
}

module.exports = { install };

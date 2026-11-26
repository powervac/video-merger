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
  'darwin-arm64': {
    ffmpeg: { size: 45568216, sha256: 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584' },
    ffprobe: { size: 45528808, sha256: 'bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64' },
  },
  'darwin-x64': {
    ffmpeg: { size: 78862176, sha256: 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894' },
    ffprobe: { size: 78780408, sha256: 'fa3add0ce901f7241abe0dfc0155d958fc834aca3f8ce61f87cc712ae669c1e0' },
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

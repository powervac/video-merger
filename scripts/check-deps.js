// Запускается перед "npm start": проверяет FFmpeg и при необходимости ставит его как зависимость.
'use strict';

const { execSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const npm = (command) => execSync(`npm ${command} --no-audit --no-fund`, { cwd: root, stdio: 'inherit' });

function missing() {
  // Каждый раз в новом процессе, чтобы увидеть только что установленное.
  const code = "const m=require('./src/media');console.log(JSON.stringify(['ffmpeg','ffprobe'].filter(n=>!m.locate(n))))";
  return JSON.parse(execSync(`"${process.execPath}" -e "${code}"`, { cwd: root }).toString());
}

function hasPackage(name) {
  try {
    require.resolve(name, { paths: [root] });
    return true;
  } catch {
    return false;
  }
}

if (!['electron', 'ffmpeg-static', 'ffprobe-static'].every(hasPackage)) {
  console.log('Устанавливаю зависимости…');
  npm('install');
}

if (missing().length) {
  console.log(`Не найдено: ${missing().join(', ')}. Докачиваю…`);
  npm('rebuild ffmpeg-static ffprobe-static');
}

const left = missing();
if (left.length) {
  console.error(`Не удалось установить: ${left.join(', ')}. Проверьте интернет и повторите, либо установите ffmpeg в систему.`);
  process.exit(1);
}

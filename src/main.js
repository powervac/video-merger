'use strict';

const { app, BrowserWindow, dialog, ipcMain, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const media = require('./media');

const isMac = process.platform === 'darwin';
let win = null;
let job = null;
let hardware = null;

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1536, area.width),
    height: Math.min(1024, area.height),
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#1b202a',
    title: 'Video Merger',
    // Шапка своя, как на макете; на macOS оставляем системные «светофоры».
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  // Файл, брошенный мимо зоны, не должен открываться вместо интерфейса.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (!job) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      message: 'A merge is in progress. Stop it and close the app?',
      buttons: ['Keep merging', 'Stop and close'],
      cancelId: 0,
      defaultId: 0,
    });
    if (choice === 0) e.preventDefault();
    else job.cancel();
  });
}

ipcMain.handle('window', (_e, action) => {
  if (action === 'minimize') win.minimize();
  if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  if (action === 'close') win.close();
});

// Проверка при запуске: какой ffmpeg будет использоваться и есть ли он вообще.
ipcMain.handle('info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  ffmpeg: media.locate('ffmpeg'),
  ffprobe: media.locate('ffprobe'),
}));

ipcMain.handle('choose-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'avi', 'm4v', 'mts', 'm2ts', 'webm', 'wmv', 'mpg', 'mpeg', '3gp'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

/** Принимает файлы и папки, возвращает сведения о каждом видео. */
ipcMain.handle('probe', async (_e, paths) => {
  const files = paths.flatMap((p) => {
    try {
      return fs.statSync(p).isDirectory() ? media.listVideos(p) : [p];
    } catch {
      return [p];
    }
  });
  const result = new Array(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      result[i] = await media.probe(files[i]);
      result[i].dir = path.dirname(files[i]);
      if (!result[i].error) result[i].url = pathToFileURL(files[i]).href;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return result;
});

ipcMain.handle('thumbnail', (_e, file, duration) => media.thumbnail(file, duration).catch(() => null));

// Волну считаем по одному файлу: для этого читается весь ролик.
let waveQueue = Promise.resolve();
let waveJob = null;
ipcMain.handle('waveform', (_e, file, duration) => {
  const result = waveQueue.then(() => {
    waveJob = media.waveform(file, duration);
    return waveJob.promise;
  });
  waveQueue = result.catch(() => {});
  return result;
});

ipcMain.handle('copy-problems', (_e, clips) => media.copyProblems(clips));

ipcMain.handle('detect-hardware', () => {
  hardware = hardware || media.detectHardware();
  return hardware;
});

ipcMain.handle('export', async (_e, clips, options) => {
  if (job) throw new Error('A merge is already running');
  fs.mkdirSync(options.outputDir, { recursive: true });
  const output = media.uniqueOutput(options.outputDir, `${path.parse(clips[0].name).name}_merged`, options.format);
  job = media.exportVideo(clips, options, output, (p) => {
    if (win.isDestroyed()) return;
    win.webContents.send('progress', p);
    win.setProgressBar(p.percent / 100);
  });
  try {
    await job.promise;
    return { output };
  } finally {
    job = null;
    if (!win.isDestroyed()) win.setProgressBar(-1);
  }
});

ipcMain.handle('cancel-export', () => job?.cancel());
ipcMain.handle('show-in-folder', (_e, file) => shell.showItemInFolder(file));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  job?.cancel();
  waveJob?.cancel();
});

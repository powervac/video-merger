'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  window: call('window'),
  info: call('info'),
  installFfmpeg: call('install-ffmpeg'),
  onSetupProgress: (cb) => ipcRenderer.on('setup-progress', (_e, p) => cb(p)),
  chooseFiles: call('choose-files'),
  chooseFolder: call('choose-folder'),
  probe: call('probe'),
  thumbnail: call('thumbnail'),
  waveform: call('waveform'),
  copyProblems: call('copy-problems'),
  detectHardware: call('detect-hardware'),
  chooseOutput: call('choose-output'),
  exportVideo: call('export'),
  cancelExport: call('cancel-export'),
  showInFolder: call('show-in-folder'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, p) => cb(p)),
});

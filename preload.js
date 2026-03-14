'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ダイアログ
  pickFolder:        ()      => ipcRenderer.invoke('pick-folder'),
  pickMdFile:        ()      => ipcRenderer.invoke('pick-md-file'),
  pickImageFile:     ()      => ipcRenderer.invoke('pick-image-file'),
  pickAnyFile:       ()      => ipcRenderer.invoke('pick-any-file'),
  // 設定
  getCfg:            ()      => ipcRenderer.invoke('get-cfg'),
  saveCfg:           d       => ipcRenderer.invoke('save-cfg', d),
  getStatus:         ()      => ipcRenderer.invoke('get-status'),
  // プロジェクト
  listProjects:      ()      => ipcRenderer.invoke('list-projects'),
  getProject:        id      => ipcRenderer.invoke('get-project', id),
  createProject:     d       => ipcRenderer.invoke('create-project', d),
  updateProject:     (id,d)  => ipcRenderer.invoke('update-project', id, d),
  deleteProject:     id      => ipcRenderer.invoke('delete-project', id),
  // チャット
  startChat:         o       => ipcRenderer.invoke('start-chat', o),
  stopChat:          sid     => ipcRenderer.invoke('stop-chat', sid),
  clearHistory:      sid     => ipcRenderer.invoke('clear-history', sid),
  setHistory:        o       => ipcRenderer.invoke('set-history', o),
  editMessage:       o       => ipcRenderer.invoke('edit-message', o),
  // 再開ファイル
  loadResume:        wd      => ipcRenderer.invoke('load-resume', wd),
  saveResume:        o       => ipcRenderer.invoke('save-resume', o),
  deleteResume:      wd      => ipcRenderer.invoke('delete-resume', wd),
  // ログ
  getLogs:           days    => ipcRenderer.invoke('get-logs', days),
  deleteLogs:        ()      => ipcRenderer.invoke('delete-logs'),
  // ウォッチャーエージェント
  getWatcherCfg:     ()      => ipcRenderer.invoke('get-watcher-cfg'),
  saveWatcherCfg:    d       => ipcRenderer.invoke('save-watcher-cfg', d),
  watcherTrigger:    ()      => ipcRenderer.invoke('watcher-trigger'),
  watcherStart:      ()      => ipcRenderer.invoke('watcher-start'),
  watcherStop:       ()      => ipcRenderer.invoke('watcher-stop'),
  watcherStatus:     ()      => ipcRenderer.invoke('watcher-status'),
  getWatcherModels:  (h,p)   => ipcRenderer.invoke('get-watcher-models', {host:h, port:p}),
  // イベント受信
  onChunk:           cb      => ipcRenderer.on('chat-chunk', (_, d) => cb(d)),
  offChunk:          ()      => ipcRenderer.removeAllListeners('chat-chunk'),
  onWatcherEvent:    cb      => ipcRenderer.on('watcher-event', (_, d) => cb(d)),
  offWatcherEvent:   ()      => ipcRenderer.removeAllListeners('watcher-event'),
  onWillQuit:        cb      => ipcRenderer.on('app-will-quit', cb),
});

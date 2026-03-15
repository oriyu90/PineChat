'use strict';
const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = require('electron');
const path  = require('path');
const fs    = require('fs');
const agent = require('./agent');

nativeTheme.themeSource = 'dark';
let win = null;

// ⑭ 各sessIdごとの処理状態 (devモードで他PJへ切替中も継続)
// { sessId → { workDir, mode, lastText, pausedForInput, projId } }
const activeSessions = new Map();

// ── ウィンドウ ──────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width:1300, height:840, minWidth:820, minHeight:600,
    title:'Pine Chat', backgroundColor:'#111111',
    webPreferences:{ preload:path.join(__dirname,'preload.js'), contextIsolation:true, nodeIntegration:false, sandbox:false },
    show:false
  });
  win.loadFile(path.join(__dirname,'index.html'));
  win.once('ready-to-show', ()=>{ win.show(); win.focus(); });
  win.webContents.on('console-message',(_,lv,msg,line)=>{
    agent.logWrite('renderer',['VERB','INFO','WARN','ERROR'][lv]||'INFO',`${msg}(L${line})`);
  });
  win.on('close', e=>{
    if (!app.isQuitting) {
      e.preventDefault();
      for (const [sessId, info] of activeSessions) {
        if (info.workDir && info.mode==='dev') {
          const sess = agent.getSession(sessId);
          agent.saveResumeFile(sessId, info.workDir, sess.history,
            info.lastText ? '最後の出力: '+info.lastText.slice(-200) : 'アプリ終了', '終了');
        }
      }
      win.webContents.send('app-will-quit');
      setTimeout(()=>{ app.isQuitting=true; app.quit(); }, 1500);
    }
  });
  win.on('closed',()=>{ win=null; });
}

// ── ダイアログ ──────────────────────────────────────────
ipcMain.handle('pick-folder', async()=>{
  if(!win) return null;
  const r=await dialog.showOpenDialog(win,{properties:['openDirectory','createDirectory'],title:'作業フォルダを選択'});
  return r.canceled ? null : (r.filePaths[0]||null);
});
ipcMain.handle('pick-md-file', async()=>{
  if(!win) return null;
  const r=await dialog.showOpenDialog(win,{properties:['openFile'],title:'Markdownファイルを選択',filters:[{name:'Markdown',extensions:['md','markdown']}]});
  if(r.canceled||!r.filePaths[0]) return null;
  try{ return {path:r.filePaths[0],content:fs.readFileSync(r.filePaths[0],'utf-8')}; }catch(e){ return {error:e.message}; }
});
ipcMain.handle('pick-image-file', async()=>{
  if(!win) return null;
  const r=await dialog.showOpenDialog(win,{properties:['openFile'],title:'画像を選択',filters:[{name:'Images',extensions:['jpg','jpeg','png','gif','webp']}]});
  if(r.canceled||!r.filePaths[0]) return null;
  try{ return {path:r.filePaths[0], name:path.basename(r.filePaths[0])}; }catch(e){ return {error:e.message}; }
});
ipcMain.handle('pick-any-file', async()=>{
  if(!win) return null;
  const r=await dialog.showOpenDialog(win,{properties:['openFile'],title:'ファイルを選択'});
  if(r.canceled||!r.filePaths[0]) return null;
  try{ return {path:r.filePaths[0],name:path.basename(r.filePaths[0]),content:fs.readFileSync(r.filePaths[0],'utf-8')}; }catch(e){ return {error:e.message}; }
});

// ── 設定 ────────────────────────────────────────────────
ipcMain.handle('get-cfg', ()=>agent.getCfg());
ipcMain.handle('save-cfg', async(_,data)=>{ agent.updateCfg(data); return agent.getCfg(); });
ipcMain.handle('get-status', async()=>{
  const modelId=await agent.detectModel(); const c=agent.getCfg();
  return {
    online:!!modelId, modelId,
    aiHost:c.aiHost, aiPort:c.aiPort,
    searxngUrl:c.searxngUrl, handsOff:c.handsOff,
    chatAiHost:c.chatAiHost, chatAiPort:c.chatAiPort, chatModelId:c.chatModelId,
    agentAiHost:c.agentAiHost, agentAiPort:c.agentAiPort, agentModelId:c.agentModelId,
    uiLanguage:c.uiLanguage||'ja', aiResponseLanguage:c.aiResponseLanguage||'ja'
  };
});
// ④ 任意ホスト/ポートのモデル一覧
ipcMain.handle('get-models-at', async(_,{host,port})=>agent.detectModelsAt(host,port));
// 後方互換
ipcMain.handle('get-chat-models', async(_,{host,port})=>agent.detectModelsAt(host,port));

// チャット名自動生成
ipcMain.handle('generate-project-name', async(_,{message})=>{
  const cfg=agent.getCfg();
  const host=cfg.chatAiHost||cfg.aiHost||'127.0.0.1';
  const port=cfg.chatAiPort||cfg.aiPort;
  let useModel=cfg.chatModelId;
  if(!useModel) useModel=await agent.detectModel();
  if(!useModel) return {name:'新規チャット'};
  try{
    const http=require('http');
    const body=JSON.stringify({model:useModel,messages:[{role:'system',content:'ユーザーのメッセージを見て、チャットのタイトルを10文字以内の日本語で1つだけ答えてください。タイトルのみ出力し、説明や記号は不要です。'},{role:'user',content:message.slice(0,200)}],temperature:0.3,max_tokens:30,stream:false});
    const name=await new Promise(resolve=>{
      const req=http.request({hostname:host,port,path:'/v1/chat/completions',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},timeout:10000},
        res=>{let r='';res.on('data',c=>r+=c);res.on('end',()=>{try{resolve(JSON.parse(r).choices?.[0]?.message?.content?.trim()||'新規チャット');}catch{resolve('新規チャット');}});});
      req.on('error',()=>resolve('新規チャット'));req.on('timeout',()=>{req.destroy();resolve('新規チャット');});req.write(body);req.end();
    });
    return {name:name.slice(0,20)||'新規チャット'};
  }catch{return{name:'新規チャット'};}
});

// ── プロジェクト CRUD ────────────────────────────────────
ipcMain.handle('list-projects',()=>agent.loadIndex().sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)));
ipcMain.handle('get-project',(_,id)=>agent.loadProj(id));
ipcMain.handle('create-project',(_,{name,type,workDir,systemPrompt})=>{
  const id='p'+Date.now(), now=Date.now();
  const proj={id,name,type,workDir,systemPrompt:systemPrompt||'',messages:[],createdAt:now,updatedAt:now};
  const idx=agent.loadIndex(); idx.push({id,name,type,workDir,createdAt:now,updatedAt:now});
  agent.saveIndex(idx); agent.saveProj(proj); return proj;
});
ipcMain.handle('update-project',(_,id,data)=>{
  data.updatedAt=Date.now(); agent.saveProj(data);
  const idx=agent.loadIndex(), i=idx.findIndex(x=>x.id===id);
  if(i>=0){idx[i].name=data.name;idx[i].updatedAt=data.updatedAt;agent.saveIndex(idx);}
  return {ok:true};
});
ipcMain.handle('delete-project',(_,id)=>{
  // プロジェクトファイルを読んでworkDirを取得し、resumeFileも削除
  try {
    const proj = agent.loadProj(id);
    if(proj && proj.workDir) {
      agent.deleteResumeFile(proj.workDir); // 再開ファイルも必ず削除
    }
  } catch {}
  const p=agent.projPath(id); try{if(fs.existsSync(p))fs.unlinkSync(p);}catch{}
  agent.saveIndex(agent.loadIndex().filter(x=>x.id!==id));
  return {ok:true};
});

// ── チャット ─────────────────────────────────────────────
ipcMain.handle('start-chat', async(event,{sessId,message,projectId,mode,attachments,deepSearch,langs})=>{
  const proj   = projectId ? agent.loadProj(projectId) : null;
  const workDir= proj?.workDir||null;
  const sess   = agent.getSession(sessId);
  const cfg    = agent.getCfg();

  if(sess.history.length>40) sess.history=sess.history.slice(-40);

  let fullMessage=message;
  if(attachments&&attachments.length>0){
    const texts=attachments.map(a=>{
      if(a.type==='image') return `--- 画像添付: ${a.name} (パス: ${a.path||'不明'}) ---`;
      return `--- ${a.name} ---\n${(a.content||'').slice(0,8000)}`;
    });
    fullMessage+='\n\n【添付】\n'+texts.join('\n\n');
  }
  sess.history.push({role:'user',content:fullMessage});

  if(deepSearch){
    safeChunk(event,sessId,{type:'system',data:'𓅱 検索中...'});
    try{
      const results=await Promise.race([agent.searxSearch(message,5),new Promise(r=>setTimeout(()=>r([]),8000))]);
      if(results.length>0){
        const ctx=results.map((r,i)=>`${i+1}. ${r.title}\n${r.snippet}\nURL:${r.url}`).join('\n\n');
        const last=sess.history[sess.history.length-1];
        if(last&&last.role==='user') last.content+=`\n\n【𓅱 検索結果(${results.length}件)】\n${ctx}\n\n上記を参考に回答してください。`;
        safeChunk(event,sessId,{type:'system',data:`𓅱 ${results.length}件取得`});
      }else safeChunk(event,sessId,{type:'system',data:'𓅱 結果なし—SearXNG設定を確認してください'});
    }catch{ safeChunk(event,sessId,{type:'system',data:'𓅱 検索タイムアウト—AIのみで回答'}); }
  }

  let sysPrompt;
  if(mode==='dev')       sysPrompt=agent.makeDevSysPrompt(workDir,proj?.systemPrompt,langs||'');
  else if(mode==='debug')   sysPrompt=agent.buildDebugSysPrompt(workDir,proj?.systemPrompt);
  else if(mode==='analysis') sysPrompt=agent.buildAnalysisSysPrompt(workDir,proj?.systemPrompt);
  else                   sysPrompt=agent.buildChatSysPrompt(workDir,proj?.systemPrompt);

  let fullText='', wasAborted=false;
  activeSessions.set(sessId,{workDir,mode,lastText:'',projId:projectId});

  try{
    await agent.runAgent(sessId, sess.history, sysPrompt, workDir,
      (ev)=>{
        if(ev.type==='text'){ fullText+=ev.data; const info=activeSessions.get(sessId); if(info) info.lastText=fullText; }
        safeChunk(event,sessId,ev);
      }
    );
    wasAborted=agent.isAborted(sessId);
  }finally{
    activeSessions.delete(sessId);
    if(mode==='dev'&&workDir&&!wasAborted) agent.deleteResumeFile(workDir);
  }

  sess.history.push({role:'assistant',content:fullText});
  if(sess.history.length>60) sess.history=sess.history.slice(-60);
  return {ok:true,length:fullText.length};
});

function safeChunk(event,sessId,data){
  try{ if(!event.sender.isDestroyed()) event.sender.send('chat-chunk',{...data,sessId}); }catch{}
}

ipcMain.handle('stop-chat',   (_,sid)=>{ agent.stopAgent(sid); return {ok:true}; });
ipcMain.handle('clear-history',(_,sid)=>{ const s=agent.getSession(sid); s.history=[]; return {ok:true}; });
ipcMain.handle('edit-message',(_,{sessId,msgIndex,newContent})=>{
  const sess=agent.getSession(sessId);
  if(msgIndex>=0&&msgIndex<sess.history.length){
    sess.history[msgIndex].content=newContent;
    sess.history=sess.history.slice(0,msgIndex+1);
  }
  return {ok:true};
});
ipcMain.handle('set-history',(_,{sessId,history})=>{
  const sess=agent.getSession(sessId);
  sess.history=(history||[]).slice(-40);
  return {ok:true};
});

// ⑭ ほったらかしOFFで別PJ切替時: devセッションの"待機中"状態を通知
ipcMain.handle('get-active-sessions', ()=>{
  const result=[];
  for(const [sessId,info] of activeSessions){
    result.push({sessId, projId:info.projId, mode:info.mode, workDir:info.workDir});
  }
  return result;
});

// ── 再開ファイル ─────────────────────────────────────────
ipcMain.handle('load-resume',(_,workDir)=>agent.loadResumeFile(workDir));
ipcMain.handle('save-resume',(_,{sessId,workDir,history,checkpoint,state})=>
  agent.saveResumeFile(sessId,workDir,history||[],checkpoint||'処理中',state||'一時停止')
);
ipcMain.handle('delete-resume',(_,workDir)=>{ agent.deleteResumeFile(workDir); return {ok:true}; });

// ── ログ ─────────────────────────────────────────────────
ipcMain.handle('get-logs',  (_,days)=>agent.getLogs(days||7));
ipcMain.handle('delete-logs',()=>{ agent.deleteOldLogs(); return {ok:true}; });

// ── 起動 ─────────────────────────────────────────────────
app.whenReady().then(async()=>{
  await agent.detectModel();
  createWindow();
  app.on('activate',()=>{ if(BrowserWindow.getAllWindows().length===0) createWindow(); else win?.show(); });
  // ウォッチャー自動起動
  setTimeout(()=>{
    const wcfg=agent.getWatcherCfg();
    if(wcfg.discordEnabled||wcfg.telegramEnabled||wcfg.searxEnabled||wcfg.calendarEnabled)
      agent.startWatcher();
  }, 2500);
});
app.on('window-all-closed',()=>{});
app.on('before-quit',()=>{ app.isQuitting=true; });
process.on('uncaughtException',e=>{ console.error('[main]',e); agent.logWrite('main','ERROR',e.message); });

// ── ウォッチャーエージェント v3 IPC ─────────────────────
agent.setWatcherCallback((ev)=>{
  if(win&&!win.isDestroyed()&&win.webContents&&!win.webContents.isDestroyed()){
    try{ win.webContents.send('watcher-event',ev); }catch{}
  }
});

ipcMain.handle('get-watcher-cfg',  ()=>agent.getWatcherCfg());
ipcMain.handle('save-watcher-cfg', async(_,data)=>{
  agent.saveWatcherCfg(data);
  if(agent.isWatcherRunning()){ agent.stopWatcher(); agent.startWatcher(); }
  return agent.getWatcherCfg();
});
ipcMain.handle('watcher-start',   async()=>{ agent.startWatcher(); return {ok:true}; });
ipcMain.handle('watcher-stop',    async()=>{ agent.stopWatcher();  return {ok:true}; });
// SearXNG定期タスクのみ停止/開始（スライドスイッチ用）
ipcMain.handle('searx-stop',   async()=>{ agent.stopSearxOnly(); return {ok:true,searxRunning:false}; });
ipcMain.handle('searx-start',  async()=>{ agent.startSearxOnly(); return {ok:true,searxRunning:true}; });
ipcMain.handle('searx-status', ()=>({ searxRunning:agent.isSearxRunning(), watcherRunning:agent.isWatcherRunning() }));
// フィード履歴保存
ipcMain.handle('save-agent-feed', async(_,feedData)=>{ agent.saveAgentFeedToHistory(feedData); return {ok:true}; });
ipcMain.handle('watcher-run-now', async()=>{ await agent.runWatcherNow(); return {ok:true}; });
ipcMain.handle('watcher-status',  ()=>({
  running: agent.isWatcherRunning(),
  nextTime: agent.getWatcherNextTime(),
  cfg: agent.getWatcherCfg()
}));
// ④ エージェントAI含む全ホストのモデル取得
ipcMain.handle('get-watcher-models', async(_,{host,port})=>agent.detectModelsAt(host,port));

// ⑧ エージェントチャット送信
ipcMain.handle('agent-chat', async(event,{message})=>{
  await agent.runAgentChat(message, (ev)=>{
    if(win&&!win.isDestroyed()&&win.webContents&&!win.webContents.isDestroyed()){
      try{ win.webContents.send('agent-chat-event',ev); }catch{}
    }
  });
  return {ok:true};
});

// ⑧ エージェントチャット履歴取得 ⑫
ipcMain.handle('get-agent-history', ()=>agent.loadAgentHistory());
ipcMain.handle('clear-agent-history', ()=>{ agent.clearAgentHistory(); return {ok:true}; });

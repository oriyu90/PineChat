'use strict';
const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = require('electron');
const path  = require('path');
const fs    = require('fs');
const agent = require('./agent');

nativeTheme.themeSource = 'dark';
let win = null;

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
      win.webContents.send('app-will-quit');
      // アプリ終了時のみ再開ファイル生成はrenderer側でやる
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
  try{
    // 画像はパスのみ返す(base64転送しない→IPC軽量化)
    return {path:r.filePaths[0], name:path.basename(r.filePaths[0])};
  }catch(e){ return {error:e.message}; }
});
ipcMain.handle('pick-any-file', async()=>{
  if(!win) return null;
  const r=await dialog.showOpenDialog(win,{properties:['openFile'],title:'ファイルを選択'});
  if(r.canceled||!r.filePaths[0]) return null;
  try{ return {path:r.filePaths[0],name:path.basename(r.filePaths[0]),content:fs.readFileSync(r.filePaths[0],'utf-8')}; }catch(e){ return {error:e.message}; }
});

// ── 設定 ────────────────────────────────────────────────
ipcMain.handle('get-cfg', ()=>agent.getCfg());
ipcMain.handle('save-cfg',async(_,data)=>{ agent.updateCfg(data); return agent.getCfg(); });
ipcMain.handle('get-status',async()=>{
  const modelId=await agent.detectModel(); const c=agent.getCfg();
  return {online:!!modelId,modelId,aiHost:c.aiHost,aiPort:c.aiPort,searxngUrl:c.searxngUrl,handsOff:c.handsOff};
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
  const p=agent.projPath(id); try{if(fs.existsSync(p))fs.unlinkSync(p);}catch{}
  agent.saveIndex(agent.loadIndex().filter(x=>x.id!==id)); return {ok:true};
});

// ── チャット ─────────────────────────────────────────────
// sessIdはプロジェクトIDベース → チャンクはsessId付きで送信
ipcMain.handle('start-chat', async(event,{sessId,message,projectId,mode,attachments,deepSearch,langs})=>{
  const proj   = projectId ? agent.loadProj(projectId) : null;
  const workDir= proj?.workDir||null;
  const sess   = agent.getSession(sessId);
  const cfg    = agent.getCfg();

  // コンテキスト圧縮
  if(sess.history.length>40) sess.history=sess.history.slice(-40);

  // 添付ファイル処理(画像はパスのみ)
  let fullMessage=message;
  if(attachments&&attachments.length>0){
    const texts=attachments.map(a=>{
      if(a.type==='image') return `--- 画像添付: ${a.name} (パス: ${a.path||'不明'}) ---`;
      return `--- ${a.name} ---\n${(a.content||'').slice(0,8000)}`;
    });
    fullMessage+='\n\n【添付】\n'+texts.join('\n\n');
  }

  sess.history.push({role:'user',content:fullMessage});

  // めっちゃ調べるモード: 独立タイムアウト8秒
  if(deepSearch){
    safeChunk(event,sessId,{type:'system',data:'𓅱 検索中...'});
    try{
      const results=await Promise.race([
        agent.searxSearch(message,5),
        new Promise(r=>setTimeout(()=>r([]),8000))
      ]);
      if(results.length>0){
        const ctx=results.map((r,i)=>`${i+1}. ${r.title}\n${r.snippet}\nURL:${r.url}`).join('\n\n');
        const last=sess.history[sess.history.length-1];
        if(last&&last.role==='user') last.content+=`\n\n【𓅱 検索結果(${results.length}件)】\n${ctx}\n\n上記を参考に回答してください。`;
        safeChunk(event,sessId,{type:'system',data:`𓅱 ${results.length}件取得`});
      }else{ safeChunk(event,sessId,{type:'system',data:'𓅱 結果なし—SearXNG設定を確認してください'}); }
    }catch{ safeChunk(event,sessId,{type:'system',data:'𓅱 検索タイムアウト—AIのみで回答'}); }
  }

  // システムプロンプト選択
  let sysPrompt;
  if(mode==='dev'){
    sysPrompt=agent.makeDevSysPrompt(workDir, proj?.systemPrompt, langs||'');
  }else if(mode==='debug'){
    sysPrompt=agent.buildDebugSysPrompt(workDir, proj?.systemPrompt);
  }else{
    sysPrompt=agent.buildChatSysPrompt(workDir, proj?.systemPrompt);
  }

  let fullText='', stepCount=0;

  await agent.runAgent(sessId, sess.history, sysPrompt, workDir,
    (ev)=>{
      if(ev.type==='text') fullText+=ev.data;
      if(ev.type==='tool') stepCount++;
      safeChunk(event,sessId,ev);
    },
    {isHandsOff:cfg.handsOff}
  );

  // 再開ファイルは使ったら削除
  if(mode==='dev'&&workDir) agent.deleteResumeFile(workDir);

  sess.history.push({role:'assistant',content:fullText});
  if(sess.history.length>60) sess.history=sess.history.slice(-60);
  return {ok:true,length:fullText.length};
});

function safeChunk(event,sessId,data){
  try{
    if(!event.sender.isDestroyed())
      event.sender.send('chat-chunk',{...data,sessId});
  }catch{}
}

ipcMain.handle('stop-chat',   (_,sid)=>{ agent.stopAgent(sid);   return {ok:true}; });
ipcMain.handle('clear-history',(_,sid)=>{ const s=agent.getSession(sid); s.history=[]; return {ok:true}; });
ipcMain.handle('edit-message',(_,{sessId,msgIndex,newContent})=>{
  const sess=agent.getSession(sessId);
  if(msgIndex>=0&&msgIndex<sess.history.length){
    sess.history[msgIndex].content=newContent;
    sess.history=sess.history.slice(0,msgIndex+1);
  }
  return {ok:true};
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
});
app.on('window-all-closed',()=>{});
app.on('before-quit',()=>{ app.isQuitting=true; });
process.on('uncaughtException',e=>{ console.error('[main]',e); agent.logWrite('main','ERROR',e.message); });

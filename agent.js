'use strict';
// agent.js — Pine Chat v4 final
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const { exec } = require('child_process');

// ── データディレクトリ ─────────────────────────────────────
const DATA_DIR = path.join(os.homedir(), '.pinechat');
const LOG_DIR  = path.join(DATA_DIR, 'logs');
[DATA_DIR, LOG_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive:true }); });

// ── 設定 ──────────────────────────────────────────────────
const CFG_FILE = path.join(DATA_DIR, 'config.json');
const DEFAULT_CFG = {
  aiHost: 'localhost', aiPort: 1234,
  searxngUrl: 'http://localhost:8080',
  timeout: 300, logEnabled: true, logMaxDays: 7,
  handsOff: false,
  chatAiHost: '', chatAiPort: 0, chatModelId: '',    // チャット専用AI ④
  agentAiHost: '', agentAiPort: 0, agentModelId: '', // エージェント専用AI ④
  uiLanguage: 'ja', // UI言語: 'ja' | 'en'
  aiResponseLanguage: 'ja', // AI応答言語: 'ja' | 'en'
};

function loadCfg() {
  try { return Object.assign({}, DEFAULT_CFG, JSON.parse(fs.readFileSync(CFG_FILE,'utf-8'))); }
  catch { return { ...DEFAULT_CFG }; }
}
function saveCfg(c) { fs.writeFileSync(CFG_FILE, JSON.stringify(Object.assign({}, DEFAULT_CFG, c), null, 2)); }

let cfg = loadCfg();
let MODEL_ID = null;
function getCfg() { return { ...cfg }; }
function updateCfg(partial) {
  cfg = Object.assign(cfg, partial);
  saveCfg(cfg);
  MODEL_ID = null; // 設定変更時はモデルリセット
}

// ── ログ ──────────────────────────────────────────────────
function logWrite(sessId, level, msg) {
  if (!cfg.logEnabled) return;
  const date = new Date();
  const line = `[${date.toISOString()}][${level}][${sessId}] ${msg}\n`;
  try { fs.appendFileSync(path.join(LOG_DIR, `${date.toISOString().slice(0,10)}.log`), line); } catch {}
}
function getLogs(days=7) {
  try {
    return fs.readdirSync(LOG_DIR).filter(f=>f.endsWith('.log')).sort().reverse().slice(0,days)
      .map(f => { try { return { name:f, content:fs.readFileSync(path.join(LOG_DIR,f),'utf-8') }; } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
function deleteOldLogs() {
  try {
    const cut = Date.now() - cfg.logMaxDays * 86400000;
    fs.readdirSync(LOG_DIR).forEach(f => {
      const fp = path.join(LOG_DIR,f);
      try { if (fs.statSync(fp).mtimeMs < cut) fs.unlinkSync(fp); } catch {}
    });
  } catch {}
}

// ── HTTP ──────────────────────────────────────────────────
function httpPost(host, port, p, body, tms) {
  return new Promise((resolve, reject) => {
    const bs = JSON.stringify(body);
    const req = http.request({
      hostname:host, port, path:p, method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(bs)},
      timeout: tms || cfg.timeout * 1000
    }, res => {
      let raw=''; res.on('data', c => raw+=c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error('JSON失敗:'+raw.slice(0,100))); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`タイムアウト(${Math.round((tms||cfg.timeout*1000)/1000)}s)`)); });
    req.write(bs); req.end();
  });
}
function httpGet(host, port, p, tms=5000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname:host, port, path:p, method:'GET', timeout:tms }, res => {
      let raw=''; res.on('data', c => raw+=c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error('JSON失敗')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── モデル検出 ────────────────────────────────────────────
async function detectModel() {
  for (const host of [cfg.aiHost, '127.0.0.1', 'localhost'].filter((v,i,a)=>a.indexOf(v)===i)) {
    try {
      const d = await httpGet(host, cfg.aiPort, '/v1/models', 4000);
      const list = d.data || [];
      if (list.length > 0) { MODEL_ID = list[0].id; return MODEL_ID; }
    } catch {}
  }
  MODEL_ID = null; return null;
}
async function detectModelsAt(host, port) {
  try {
    const d = await httpGet(host||'localhost', port||1234, '/v1/models', 5000);
    return (d.data||[]).map(m=>({ id:m.id, name:m.id }));
  } catch { return []; }
}
// 後方互換エイリアス ④
async function detectChatModels(h,p) { return detectModelsAt(h,p); }
async function detectWatcherModels(h,p) { return detectModelsAt(h,p); }

// ── SearXNG ───────────────────────────────────────────────
function searxSearch(query, max=5) {
  return new Promise(resolve => {
    if (!cfg.searxngUrl) { resolve([]); return; }
    let url; try { url = new URL(cfg.searxngUrl); } catch { resolve([]); return; }
    const proto = url.protocol==='https:' ? https : http;
    const req = proto.request({
      hostname:url.hostname, port:url.port||(url.protocol==='https:'?443:80),
      path:`/search?q=${encodeURIComponent(query)}&format=json&categories=general`,
      method:'GET', timeout:12000,
      headers:{'Accept':'application/json','User-Agent':'PineChat/1.0'}
    }, res => {
      let raw=''; res.on('data', c=>raw+=c);
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          resolve((j.results||[]).slice(0,max).map(r=>({
            title:r.title||'', url:r.url||'', snippet:r.content||r.snippet||'',
            publishedDate: r.publishedDate||r.published_date||''
          })));
        } catch { resolve([]); }
      });
      res.on('error', ()=>resolve([]));
    });
    req.on('timeout', ()=>{ req.destroy(); resolve([]); });
    req.on('error',   ()=>resolve([]));
    req.end();
  });
}

// ── ツール定義 ────────────────────────────────────────────
const TOOLS = [
  { type:'function', function:{ name:'execute_shell', description:'シェルコマンドを実行する',
    parameters:{ type:'object', properties:{ command:{type:'string'}, reason:{type:'string'} }, required:['command','reason'] }}},
  { type:'function', function:{ name:'read_file', description:'ファイルを読み込む',
    parameters:{ type:'object', properties:{ path:{type:'string'} }, required:['path'] }}},
  { type:'function', function:{ name:'write_file', description:'ファイルを書き込む',
    parameters:{ type:'object', properties:{ path:{type:'string'}, content:{type:'string'} }, required:['path','content'] }}},
  { type:'function', function:{ name:'list_directory', description:'ディレクトリ一覧を取得する',
    parameters:{ type:'object', properties:{ path:{type:'string'} }, required:['path'] }}},
  { type:'function', function:{ name:'fetch_url', description:'URLの内容を取得する',
    parameters:{ type:'object', properties:{ url:{type:'string'} }, required:['url'] }}},
  { type:'function', function:{ name:'web_search', description:'SearXNG経由でWebを検索する',
    parameters:{ type:'object', properties:{ query:{type:'string'}, reason:{type:'string'} }, required:['query','reason'] }}}
];

// ── ツール実行 ────────────────────────────────────────────
function resolvePath(p, workDir) {
  if (!p) throw new Error('パスなし');
  if (p.startsWith('~')) return p.replace('~', os.homedir());
  if (!path.isAbsolute(p) && workDir) return path.join(workDir, p);
  return p;
}
function fetchUrlInner(urlStr, depth) {
  return new Promise(resolve => {
    if (depth > 5) { resolve({ error:'リダイレクト上限超過' }); return; }
    let u = (urlStr||'').trim();
    if (!u.startsWith('http')) u = 'https://' + u;
    let parsed; try { parsed = new URL(u); } catch { resolve({ error:'無効URL' }); return; }
    const proto = parsed.protocol==='https:' ? https : http;
    let settled=false; const done=v=>{if(!settled){settled=true;resolve(v);}};
    const req = proto.request({
      hostname:parsed.hostname, port:parsed.port||(parsed.protocol==='https:'?443:80),
      path:parsed.pathname+parsed.search, method:'GET', timeout:10000,
      headers:{'User-Agent':'Mozilla/5.0','Accept':'text/html,*/*'}
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode)&&res.headers.location) {
        res.resume();
        const loc=res.headers.location;
        fetchUrlInner(loc.startsWith('http')?loc:`${parsed.protocol}//${parsed.host}${loc}`, depth+1).then(done);
        return;
      }
      let data=''; res.setEncoding('utf-8');
      res.on('data', c=>{ data+=c; if(data.length>50000){res.destroy();done({url:u,content:stripHtml(data).slice(0,10000)+'\n[切り捨て]'});} });
      res.on('end',  ()=>done({url:u,content:stripHtml(data).slice(0,10000)}));
      res.on('error',()=>done({url:u,content:stripHtml(data).slice(0,10000)||'[エラー]'}));
      res.on('close',()=>done({url:u,content:stripHtml(data).slice(0,10000)||'[接続終了]'}));
    });
    req.on('timeout',()=>{req.destroy();done({error:`fetch timeout: ${u}`});});
    req.on('error', e=>done({error:e.message}));
    req.end();
  });
}
function stripHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'')
    .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
}
function fetchUrl(urlStr) {
  return Promise.race([fetchUrlInner(urlStr,0), new Promise(r=>setTimeout(()=>r({error:'fetch hard timeout (20s)'}),20000))]);
}
async function runTool(name, args, workDir, sessId) {
  logWrite(sessId,'TOOL',`${name} ${JSON.stringify(args).slice(0,150)}`);
  switch(name) {
    case 'execute_shell': return new Promise(resolve=>{
      if(['sudo ','rm -rf /','mkfs'].some(b=>(args.command||'').includes(b))) return resolve({error:'ブロック:'+args.command});
      exec(args.command,{timeout:30000,maxBuffer:5*1024*1024,shell:'/bin/bash',cwd:workDir||process.cwd(),env:{...process.env}},
        (err,out,err2)=>resolve({stdout:(out||'').slice(0,8000),stderr:(err2||'').slice(0,2000),exitCode:err?1:0}));
    });
    case 'read_file': try {
      const fp=resolvePath(args.path,workDir),st=fs.statSync(fp);
      return {content:st.size>1024*1024?fs.readFileSync(fp,'utf-8').slice(0,50000):fs.readFileSync(fp,'utf-8'),truncated:st.size>1024*1024};
    }catch(e){return{error:e.message};}
    case 'write_file': try {
      const fp=resolvePath(args.path,workDir); fs.mkdirSync(path.dirname(fp),{recursive:true}); fs.writeFileSync(fp,args.content||'','utf-8'); return{success:true,path:fp};
    }catch(e){return{error:e.message};}
    case 'list_directory': try {
      const dp=resolvePath(args.path,workDir);
      return{path:dp,items:fs.readdirSync(dp,{withFileTypes:true}).slice(0,200).map(it=>({name:it.name,type:it.isDirectory()?'directory':'file',size:it.isFile()?(()=>{try{return fs.statSync(path.join(dp,it.name)).size;}catch{return null;}})():null}))};
    }catch(e){return{error:e.message};}
    case 'fetch_url': return fetchUrl(args.url);
    case 'web_search': { const r=await searxSearch(args.query,5); return r.length?{results:r}:{error:'SearXNG未設定または結果なし'}; }
    default: return{error:`不明:${name}`};
  }
}

// ── ループ検知 ────────────────────────────────────────────
function detectLoop(msgs, win=8) {
  if (msgs.length<win*2) return false;
  const r=msgs.slice(-win).map(m=>m.content||'').join('|'), p=msgs.slice(-win*2,-win).map(m=>m.content||'').join('|');
  if(r===p) return true;
  const rs=new Set(r.split(/\s+/).slice(0,80)),ps=new Set(p.split(/\s+/).slice(0,80));
  const inter=[...rs].filter(w=>ps.has(w)).length,uni=new Set([...rs,...ps]).size;
  return uni>0&&inter/uni>0.88;
}

// ── ほったらかし: ループ打開 ──────────────────────────────
async function handsOffBreakLoop(sessId, msgs, workDir, onEvent) {
  logWrite(sessId,'WARN','ループ検知 → 打開開始');
  onEvent({type:'system',data:'△ ループ検知。自動的に打開します...'});
  const host=cfg.chatAiHost||cfg.aiHost||'127.0.0.1',port=cfg.chatAiPort||cfg.aiPort,model=cfg.chatModelId||MODEL_ID;
  const recentText=msgs.slice(-8).map(m=>`[${m.role}]:${(m.content||'').slice(0,300)}`).join('\n');
  let problem='';
  try{const d=await httpPost(host,port,'/v1/chat/completions',{model,messages:[{role:'user',content:`以下の繰り返し処理から問題点を3点以内で簡潔に説明:\n${recentText}`}],temperature:0.3,max_tokens:400,stream:false},25000);problem=d.choices?.[0]?.message?.content||'';}catch{}
  let searchSuggestion='';
  if(problem&&cfg.searxngUrl){
    const q=problem.split('\n')[0].slice(0,70)+' solution';
    const results=await Promise.race([searxSearch(q,3),new Promise(r=>setTimeout(()=>r([]),8000))]);
    if(results.length>0){const ctx=results.map((r,i)=>`${i+1}. ${r.title}: ${r.snippet}`).join('\n');try{const d2=await httpPost(host,port,'/v1/chat/completions',{model,messages:[{role:'user',content:`問題:\n${problem}\n\n検索:\n${ctx}\n\n解決策を1つ提案:`}],temperature:0.4,max_tokens:500,stream:false},25000);searchSuggestion=d2.choices?.[0]?.message?.content||'';}catch{}}
  }
  if(workDir){try{fs.writeFileSync(path.join(workDir,'_pinechat_loop_report.json'),JSON.stringify({at:new Date().toISOString(),sessId,problem,searchSuggestion},null,2));}catch{}}
  if(searchSuggestion){onEvent({type:'system',data:`𓂀 打開案: ${searchSuggestion.slice(0,120)}...`});return{resolved:true,suggestion:searchSuggestion};}
  onEvent({type:'system',data:'𓅭 スキップして次へ進みます。'});
  return{resolved:true,suggestion:'このステップをスキップして次のタスクに進んでください。'};
}

// ── システムプロンプト ────────────────────────────────────
function makeDevSysPrompt(workDir, customSys, langs) {
  const langNote=langs&&langs.length>0?`\n優先言語: ${langs}\n※ 設計図の要件に応じて他の言語・ライブラリも適宜使用して良い。`:'';
  const custom=customSys?`\n\n【プロジェクト指示】\n${customSys}`:'';
  return `あなたはアプリ開発専門AIエージェントです。設計図に従い、タスクを1つずつ実行して開発を完成させます。\n\n【必須ルール】\n1. 最初に「=== タスクリスト ===」として全タスクを番号付きで表示する\n2. 各タスク開始前に「--- タスクN/合計: [タスク名] ---」と宣言してから作業開始\n3. 各タスク完了後に「[完] タスクN 完了 (進捗: N/合計)」と報告する\n4. エラー時は必ずweb_searchツールで解決策を調べてから修正する\n5. 全タスク完了時に「=== 開発完了 ===」と報告する\n6. ファイルは作業フォルダに作成。sudo・パッケージインストール系は不可${langNote}\n\n現在時刻: ${new Date().toLocaleString('ja-JP')}\n作業フォルダ: ${workDir||os.homedir()}${custom}`;
}
function buildChatSysPrompt(workDir, customSys) {
  const custom=customSys?`\n\n【プロジェクト指示】\n${customSys}`:'';
  return `あなたは有能なAIアシスタントです。ユーザーの質問に丁寧に回答し、必要に応じてツールを使います。制約: sudo・インストール系コマンドは不可。\n現在時刻: ${new Date().toLocaleString('ja-JP')}\n作業フォルダ: ${workDir||os.homedir()}${custom}`;
}
function buildDebugSysPrompt(workDir, customSys) {
  const custom=customSys?`\n\n【プロジェクト指示】\n${customSys}`:'';
  return `あなたはデバッグ・機能追加の専門AIエージェントです。既存コードを分析し、バグ修正・テスト・機能追加を行います。\n現在時刻: ${new Date().toLocaleString('ja-JP')}\n作業フォルダ: ${workDir||os.homedir()}${custom}`;
}
function buildAgentChatSysPrompt(calContext) {
  const lang = cfg.aiResponseLanguage || 'ja';
  const langInstr = lang === 'en'
    ? 'Always respond in English.'
    : '必ず日本語で回答してください。';
  const timeStr = new Date().toLocaleString(lang==='en'?'en-US':'ja-JP');
  return `You are Pine Chat's agent assistant. You excel at calendar queries, web searches, and summarization.\nCurrent time: ${timeStr}${calContext||''}\n\n${langInstr}\nImportant: Return only the result, do not include processing status in your response.`;
}

// ── エージェントループ ────────────────────────────────────
const abortMap=new Map(), retryCountMap=new Map();
function stopAgent(sessId){abortMap.get(sessId)?.abort();abortMap.delete(sessId);retryCountMap.delete(sessId);}
function isAborted(sessId){const ac=abortMap.get(sessId);return !ac||ac.signal.aborted;}

async function runAgent(sessId, messages, sysPrompt, workDir, onEvent) {
  const host=cfg.chatAiHost||cfg.aiHost||'127.0.0.1',port=cfg.chatAiPort||cfg.aiPort;
  let useModelId=cfg.chatModelId;
  if(!useModelId){if(!MODEL_ID)await detectModel();useModelId=MODEL_ID;}
  if(!useModelId){onEvent({type:'text',data:'× AIに接続できません。設定を確認してください。'});logWrite(sessId,'ERROR','モデル未検出');return;}
  const ac=new AbortController();abortMap.set(sessId,ac);
  const devMode=sysPrompt.includes('タスクリスト');
  const msgs=[{role:'system',content:sysPrompt},...messages];
  let loopCount=0,sameCount=0,lastContent='';
  for(let turn=0;turn<60;turn++){
    if(ac.signal.aborted){onEvent({type:'text',data:'\n■ 停止しました。'});break;}
    const isHandsOff=cfg.handsOff;
    let data;
    try{
      logWrite(sessId,'INFO',`Turn${turn+1}`);
      data=await httpPost(host,port,'/v1/chat/completions',{model:useModelId,messages:msgs,tools:TOOLS,tool_choice:'auto',temperature:0.6,max_tokens:4096,stream:false});
      retryCountMap.delete(sessId);
    }catch(e){
      logWrite(sessId,'ERROR',`APIエラー:${e.message}`);
      if(ac.signal.aborted){onEvent({type:'text',data:'\n■ 停止'});break;}
      if(isHandsOff&&e.message.includes('タイムアウト')){
        const retries=(retryCountMap.get(sessId)||0)+1;retryCountMap.set(sessId,retries);
        if(retries<=3){onEvent({type:'system',data:`⏳ タイムアウト — ${retries}/3回目の自動再試行を30秒後に実行...`});await new Promise(r=>setTimeout(r,30000));if(ac.signal.aborted){onEvent({type:'text',data:'\n■ 停止'});break;}await detectModel();if(!MODEL_ID){onEvent({type:'timeout',data:'AI接続できず'});break;}onEvent({type:'system',data:`↺ 再試行中 (${retries}/3)...`});continue;}
      }
      onEvent({type:'text',data:`\n× 通信エラー: ${e.message}`});onEvent({type:'timeout',data:e.message});break;
    }
    const msg=data.choices?.[0]?.message;
    if(!msg){onEvent({type:'text',data:'\n× 空の応答'});break;}
    msgs.push(msg);
    if(msg.content){
      logWrite(sessId,'AI',msg.content.slice(0,200));onEvent({type:'text',data:msg.content});
      if(devMode){
        const totMatch=msg.content.match(/タスクリスト[\s\S]*?(\d+)\./g);
        if(totMatch&&!msgs._totalTasksSet){msgs._totalTasksSet=true;onEvent({type:'progress',data:`タスクリスト: ${totMatch.length}件のタスクを確認`});}
        const sm=msg.content.match(/---\s*タスク(\d+)\/(\d+)[:\s]+(.+?)\s*---/);
        if(sm)onEvent({type:'task_start',data:{n:parseInt(sm[1]),total:parseInt(sm[2]),name:sm[3].trim()}});
        const dm=msg.content.match(/\[完\]\s*タスク(\d+)\s*完了.*?(\d+)\/(\d+)/);
        if(dm)onEvent({type:'task_done',data:{n:parseInt(dm[1]),total:parseInt(dm[3])}});
        if(msg.content.includes('=== 開発完了 ==='))onEvent({type:'dev_complete',data:''});
      }
      if(msg.content===lastContent){sameCount++;}else{sameCount=0;lastContent=msg.content;}
      if(detectLoop(msgs))loopCount++;
      if(sameCount>=3||loopCount>=2){
        const br=await handsOffBreakLoop(sessId,msgs,workDir,onEvent);sameCount=0;loopCount=0;
        if(br.resolved&&br.suggestion)msgs.push({role:'user',content:`【ループ打開指示】\n${br.suggestion}\n\n別のアプローチで続行してください。`});
        else if(!isHandsOff){onEvent({type:'user_input_required',data:'× 別の指示を入力するか「スキップ」と入力してください。'});break;}
        continue;
      }
    }
    if(!msg.tool_calls?.length)break;
    for(const tc of msg.tool_calls){
      if(ac.signal.aborted)break;
      let args={};try{args=JSON.parse(tc.function?.arguments||'{}');}catch{}
      onEvent({type:'tool',data:{id:tc.id,name:tc.function?.name||'',args}});
      const result=await runTool(tc.function?.name||'',args,workDir,sessId).catch(e=>({error:e.message}));
      msgs.push({role:'tool',tool_call_id:tc.id,content:JSON.stringify(result)});
    }
  }
  abortMap.delete(sessId);retryCountMap.delete(sessId);deleteOldLogs();
}

// ── 再開ファイル ──────────────────────────────────────────
function saveResumeFile(sessId,workDir,history,checkpoint,state){
  if(!workDir)return null;
  const fp=path.join(workDir,'_pinechat_resume.json');
  try{fs.writeFileSync(fp,JSON.stringify({savedAt:new Date().toISOString(),sessId,checkpoint,state,historyTail:history.slice(-6).map(m=>({role:m.role,content:(m.content||'').slice(0,500)}))},null,2));return fp;}catch{return null;}
}
function loadResumeFile(workDir){if(!workDir)return null;try{const fp=path.join(workDir,'_pinechat_resume.json');if(fs.existsSync(fp))return JSON.parse(fs.readFileSync(fp,'utf-8'));}catch{}return null;}
function deleteResumeFile(workDir){if(!workDir)return;try{const fp=path.join(workDir,'_pinechat_resume.json');if(fs.existsSync(fp))fs.unlinkSync(fp);}catch{}}

// ── プロジェクト永続化 ────────────────────────────────────
const IDX_FILE=path.join(DATA_DIR,'index.json');
function loadIndex(){try{return JSON.parse(fs.readFileSync(IDX_FILE,'utf-8'));}catch{return[];}}
function saveIndex(l){try{fs.writeFileSync(IDX_FILE,JSON.stringify(l,null,2));}catch{}}
function projPath(id){return path.join(DATA_DIR,`p_${id}.json`);}
function loadProj(id){try{return JSON.parse(fs.readFileSync(projPath(id),'utf-8'));}catch{return null;}}
function saveProj(p){try{fs.writeFileSync(projPath(p.id),JSON.stringify(p,null,2));}catch{}}

// ── セッション管理 ────────────────────────────────────────
const sessions=new Map();
function getSession(id){if(!sessions.has(id))sessions.set(id,{history:[]});return sessions.get(id);}

// ════════════════════════════════════════════════════════════
// ── ウォッチャーエージェント v3 ──────────────────────────
// ════════════════════════════════════════════════════════════
const WATCHER_CFG_DEFAULT = {
  agentAiHost:'', agentAiPort:0, agentModelId:'',   // ④ 空=全体設定を参照
  discordEnabled:false, discordToken:'', discordChannels:[],
  telegramEnabled:false, telegramToken:'', telegramChats:[],
  searxEnabled:false, searxIntervalMin:5, searxMaxResults:15, searxTasks:[], // ③
  calendarEnabled:false,           // ⑥
  googleCalendarEnabled:false, googleCalClientId:'', googleCalClientSecret:'', googleCalRefreshToken:'',
  iCloudCalendarEnabled:false, iCloudAppleId:'', iCloudAppPassword:'',
};
function getWatcherCfg(){const c=loadCfg();return Object.assign({},WATCHER_CFG_DEFAULT,c.watcher||{});}
function saveWatcherCfg(w){
  const c=loadCfg();
  c.watcher=Object.assign({},WATCHER_CFG_DEFAULT,w);
  // ④ エージェントAI設定を全体設定にも反映
  if(w.agentAiHost!==undefined)c.agentAiHost=w.agentAiHost;
  if(w.agentAiPort!==undefined)c.agentAiPort=w.agentAiPort;
  if(w.agentModelId!==undefined)c.agentModelId=w.agentModelId;
  saveCfg(c);
}
function getAgentAI(){
  const w=getWatcherCfg();
  return {
    host: w.agentAiHost||cfg.agentAiHost||cfg.aiHost||'localhost',
    port: w.agentAiPort||cfg.agentAiPort||cfg.aiPort||1234,
    model: w.agentModelId||cfg.agentModelId||MODEL_ID
  };
}

// 信頼URLパターン ⑩
const TRUSTED_DOMAIN_PATTERNS=[/\.gov(\.jp)?$/,/\.ac\.(jp|uk|au)$/,/\.edu$/,/nhk\.or\.jp/,/reuters\.com/,/ap\.org/,/afpbb\.com/,/asahi\.com/,/mainichi\.jp/,/yomiuri\.co\.jp/,/nikkei\.com/,/bbc\.com/,/cnn\.com/,/theguardian\.com/,/nytimes\.com/,/wired\.com/,/techcrunch\.com/,/arstechnica\.com/,/github\.com/,/wikipedia\.org/,/nature\.com/,/mozilla\.org/,/python\.org/,/rust-lang\.org/];
function isTrustedUrl(url){try{const h=new URL(url).hostname.toLowerCase();if(TRUSTED_DOMAIN_PATTERNS.some(p=>p.test(h)))return true;if(url.startsWith('https://')&&(h.match(/\./g)||[]).length>=2)return true;return url.startsWith('https://');}catch{return false;}}
function isWithin24h(dateStr){if(!dateStr)return true;try{return(Date.now()-new Date(dateStr).getTime())<86400000;}catch{return true;}}

// AI要約 ⑩⑪ (タイムアウト対策済み)
async function summarizeWithAI(texts, customSystemPrompt) {
  const {host,port,model}=getAgentAI();
  if(!model){await detectModel();}
  const useModel=getAgentAI().model||MODEL_ID;
  if(!useModel||!texts.length)return null;
  const content=texts.join('\n\n').slice(0,4000);
  const lang = cfg.aiResponseLanguage || 'ja';
  const langInstr = lang === 'en'
    ? 'Summarize in English in news format. List 3-5 key points as bullet points, then add a one-line summary at the end.'
    : '必ず日本語でニュース形式に要約してください。重要ポイントを箇条書き3〜5項目でまとめ、最後に1文でまとめを書いてください。';
  // customSystemPromptが空の場合はデフォルト+言語指定を使用
  // customSystemPromptが設定されている場合も言語指定を末尾に追加
  const basePrompt = customSystemPrompt || 'You are a news summarization AI.';
  const sysPrompt = basePrompt + '\n\n' + langInstr;
  try{
    const d=await Promise.race([
      httpPost(host,port,'/v1/chat/completions',{model:useModel,messages:[{role:'system',content:sysPrompt},{role:'user',content}],temperature:0.4,max_tokens:900,stream:false},40000),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('AI要約タイムアウト')),45000))
    ]);
    return d.choices?.[0]?.message?.content||null;
  }catch(e){logWrite('watcher','WARN',`summarize failed: ${e.message}`);return null;}
}

// Google Calendar ⑥
async function fetchGoogleCalendarEvents(wcfg) {
  if(!wcfg.googleCalRefreshToken||!wcfg.googleCalClientId||!wcfg.googleCalClientSecret)return[];
  try{
    const body=`grant_type=refresh_token&refresh_token=${encodeURIComponent(wcfg.googleCalRefreshToken)}&client_id=${encodeURIComponent(wcfg.googleCalClientId)}&client_secret=${encodeURIComponent(wcfg.googleCalClientSecret)}`;
    const tokenData=await new Promise((resolve,reject)=>{
      const req=https.request({hostname:'oauth2.googleapis.com',port:443,path:'/token',method:'POST',timeout:10000,headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}},res=>{let r='';res.on('data',c=>r+=c);res.on('end',()=>{try{resolve(JSON.parse(r));}catch{reject(new Error('token parse'));}});});
      req.on('error',reject);req.on('timeout',()=>{req.destroy();reject(new Error('token timeout'));});req.write(body);req.end();
    });
    if(!tokenData.access_token)return[];
    const now=new Date(),end=new Date(now.getTime()+7*86400000);
    const params=`timeMin=${encodeURIComponent(now.toISOString())}&timeMax=${encodeURIComponent(end.toISOString())}&singleEvents=true&orderBy=startTime&maxResults=20`;
    const eventsData=await new Promise((resolve,reject)=>{
      const req=https.request({hostname:'www.googleapis.com',port:443,path:`/calendar/v3/calendars/primary/events?${params}`,method:'GET',timeout:12000,headers:{'Authorization':`Bearer ${tokenData.access_token}`}},res=>{let r='';res.on('data',c=>r+=c);res.on('end',()=>{try{resolve(JSON.parse(r));}catch{reject(new Error('events parse'));}});});
      req.on('error',reject);req.on('timeout',()=>{req.destroy();reject(new Error('events timeout'));});req.end();
    });
    return(eventsData.items||[]).map(e=>({title:e.summary||'(無題)',start:e.start?.dateTime||e.start?.date||'',end:e.end?.dateTime||e.end?.date||'',location:e.location||'',description:(e.description||'').slice(0,200),source:'google'}));
  }catch(e){logWrite('watcher','ERROR',`gcal: ${e.message}`);return[];}
}

// iCloud Calendar ⑥ (CalDAV)
async function fetchICloudCalendarEvents(wcfg) {
  if(!wcfg.iCloudAppleId||!wcfg.iCloudAppPassword)return[];
  const auth=Buffer.from(`${wcfg.iCloudAppleId}:${wcfg.iCloudAppPassword}`).toString('base64');
  try{
    const ppBody='<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
    const ppResp=await new Promise((resolve,reject)=>{
      const req=https.request({hostname:'caldav.icloud.com',port:443,path:'/',method:'PROPFIND',timeout:12000,headers:{'Authorization':`Basic ${auth}`,'Depth':'0','Content-Type':'application/xml','Content-Length':Buffer.byteLength(ppBody)}},res=>{let r='';res.on('data',c=>r+=c);res.on('end',()=>resolve(r));});
      req.on('error',reject);req.on('timeout',()=>{req.destroy();reject(new Error('icloud timeout'));});req.write(ppBody);req.end();
    });
    const hrefM=ppResp.match(/<current-user-principal[^>]*>[\s\S]*?<href[^>]*>([\s\S]*?)<\/href>/i);
    if(!hrefM)return[];
    const principalPath=hrefM[1].trim();
    const hmBody='<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>';
    const hmResp=await new Promise((resolve,reject)=>{
      const req=https.request({hostname:'caldav.icloud.com',port:443,path:principalPath,method:'PROPFIND',timeout:12000,headers:{'Authorization':`Basic ${auth}`,'Depth':'0','Content-Type':'application/xml','Content-Length':Buffer.byteLength(hmBody)}},res=>{let r='';res.on('data',c=>r+=c);res.on('end',()=>resolve(r));});
      req.on('error',reject);req.on('timeout',()=>{req.destroy();reject(new Error('home timeout'));});req.write(hmBody);req.end();
    });
    const hmM=hmResp.match(/<calendar-home-set[^>]*>[\s\S]*?<href[^>]*>([\s\S]*?)<\/href>/i);
    if(!hmM)return[];
    const homePath=hmM[1].trim();
    const now=new Date(),end=new Date(now.getTime()+7*86400000);
    const fmt=d=>d.toISOString().replace(/[-:]/g,'').replace('.000','');
    const rqBody=`<?xml version="1.0" encoding="UTF-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${fmt(now)}Z" end="${fmt(end)}Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const rqResp=await new Promise((resolve,reject)=>{
      const req=https.request({hostname:'caldav.icloud.com',port:443,path:homePath,method:'REPORT',timeout:15000,headers:{'Authorization':`Basic ${auth}`,'Depth':'1','Content-Type':'application/xml','Content-Length':Buffer.byteLength(rqBody)}},res=>{let r='';res.on('data',c=>r+=c);res.on('end',()=>resolve(r));});
      req.on('error',reject);req.on('timeout',()=>{req.destroy();reject(new Error('report timeout'));});req.write(rqBody);req.end();
    });
    const events=[];
    for(const m of rqResp.matchAll(/<calendar-data[^>]*>([\s\S]*?)<\/calendar-data>/gi)){
      const ical=m[1];
      const sm=ical.match(/SUMMARY:(.+)/),dsm=ical.match(/DTSTART[^:]*:(.+)/),dem=ical.match(/DTEND[^:]*:(.+)/),lm=ical.match(/LOCATION:(.+)/);
      if(sm)events.push({title:sm[1].trim(),start:dsm?.[1]?.trim()||'',end:dem?.[1]?.trim()||'',location:lm?.[1]?.trim()||'',description:'',source:'icloud'});
    }
    return events;
  }catch(e){logWrite('watcher','ERROR',`icloud: ${e.message}`);return[];}
}

async function calendarTick(wcfg) {
  if(!wcfg.calendarEnabled)return;
  const events=[];
  if(wcfg.googleCalendarEnabled)events.push(...await fetchGoogleCalendarEvents(wcfg));
  if(wcfg.iCloudCalendarEnabled)events.push(...await fetchICloudCalendarEvents(wcfg));
  if(!events.length)return;
  const lines=events.map(e=>`📅 ${e.title}\n   開始: ${e.start}${e.end?' / 終了: '+e.end:''}${e.location?' / 場所: '+e.location:''}`).join('\n');
  watcherEmit('watcher_feed',{source:'calendar',label:'カレンダー予定',summary:`今後7日間の予定 (${events.length}件)\n\n${lines}`,count:events.length,raw:false,ts:new Date().toISOString()});
}

// Discord/Telegram fetch (前述と同じ実装)
async function fetchDiscordMessages(token,channelId,lastMsgId){
  if(!token||!channelId)return{messages:[],lastId:lastMsgId};
  return new Promise(resolve=>{
    let p=`/api/v10/channels/${channelId}/messages?limit=20`;if(lastMsgId)p+=`&after=${lastMsgId}`;
    let settled=false;const done=v=>{if(!settled){settled=true;resolve(v);}};
    const req=https.request({hostname:'discord.com',port:443,path:p,method:'GET',timeout:12000,headers:{'Authorization':`Bot ${token}`,'Content-Type':'application/json','User-Agent':'PineChat/1.0'}},res=>{
      let raw='';res.on('data',c=>raw+=c);res.on('end',()=>{try{const msgs=JSON.parse(raw);if(!Array.isArray(msgs)){done({messages:[],lastId:lastMsgId,error:msgs.message||'取得失敗'});return;}const sorted=msgs.sort((a,b)=>a.id>b.id?1:-1);done({messages:sorted.map(m=>({author:m.author?.username||'?',content:m.content||'',ts:m.timestamp})),lastId:sorted.length>0?sorted[sorted.length-1].id:lastMsgId});}catch{done({messages:[],lastId:lastMsgId});}});res.on('error',()=>done({messages:[],lastId:lastMsgId}));
    });req.on('timeout',()=>{req.destroy();done({messages:[],lastId:lastMsgId});});req.on('error',()=>done({messages:[],lastId:lastMsgId}));req.end();
  });
}
async function fetchTelegramMessages(token,chatId,lastUpdateId){
  if(!token)return{messages:[],lastUpdateId};
  return new Promise(resolve=>{
    const offset=lastUpdateId?lastUpdateId+1:0;
    let settled=false;const done=v=>{if(!settled){settled=true;resolve(v);}};
    const req=https.request({hostname:'api.telegram.org',port:443,path:`/bot${token}/getUpdates?timeout=0&offset=${offset}&limit=20`,method:'GET',timeout:15000,headers:{'Content-Type':'application/json'}},res=>{
      let raw='';res.on('data',c=>raw+=c);res.on('end',()=>{try{const j=JSON.parse(raw);if(!j.ok){done({messages:[],lastUpdateId,error:j.description});return;}const updates=(j.result||[]).filter(u=>{if(!chatId)return true;const m=u.message||u.channel_post;return m&&String(m.chat?.id)===String(chatId);});const newLast=updates.length>0?updates[updates.length-1].update_id:lastUpdateId;done({messages:updates.map(u=>{const m=u.message||u.channel_post;return{author:m?.from?.username||m?.chat?.title||'?',content:m?.text||'',ts:new Date((m?.date||0)*1000).toISOString()};}),lastUpdateId:newLast});}catch{done({messages:[],lastUpdateId});}});res.on('error',()=>done({messages:[],lastUpdateId}));
    });req.on('timeout',()=>{req.destroy();done({messages:[],lastUpdateId});});req.on('error',()=>done({messages:[],lastUpdateId}));req.end();
  });
}
async function fetchPageContent(url){return fetchUrl(url).then(r=>r.content||r.error||'').catch(()=>'');}

// ウォッチャー状態
const watcherDiscordState=new Map(),watcherTelegramState=new Map();
let watcherCallback=null,watcherTimers={},watcherRunState={discord:false,telegram:false,searx:false,calendar:false},watcherCommand='stop';
let watcherNextSearxTime=null; // ⑬
let watcherUserBusy=false,watcherSkippedCount=0; // ⑧
let watcherWatchdogTimer=null; // ⑪

// エージェントチャット履歴永続化 ⑧⑫
const AGENT_HISTORY_FILE=path.join(DATA_DIR,'agent_chat.json');
function loadAgentHistory(){try{return JSON.parse(fs.readFileSync(AGENT_HISTORY_FILE,'utf-8'));}catch{return[];}}
function saveAgentHistory(h){try{fs.writeFileSync(AGENT_HISTORY_FILE,JSON.stringify(h.slice(-200),null,2));}catch{}}
function clearAgentHistory(){try{if(fs.existsSync(AGENT_HISTORY_FILE))fs.unlinkSync(AGENT_HISTORY_FILE);}catch{}return[];}

function setWatcherCallback(cb){watcherCallback=cb;}
function watcherEmit(type,data){if(watcherCallback){try{watcherCallback({type,data});}catch{}}}
function isWatcherRunning(){return watcherRunState.discord||watcherRunState.telegram||watcherRunState.searx||watcherRunState.calendar;}
function getWatcherNextTime(){return watcherNextSearxTime;}

async function discordPollTick(wcfg){
  if(!wcfg.discordEnabled||!wcfg.discordToken||!wcfg.discordChannels?.length)return;
  for(const ch of wcfg.discordChannels){
    if(!ch.channelId)continue;
    try{const lastId=watcherDiscordState.get(ch.channelId)||null;const res=await fetchDiscordMessages(wcfg.discordToken,ch.channelId,lastId);if(res.error){watcherEmit('watcher_error',`Discord[${ch.label||ch.channelId}]: ${res.error}`);continue;}watcherDiscordState.set(ch.channelId,res.lastId);if(!res.messages.length)continue;const texts=res.messages.map(m=>`[${m.author}] ${m.content}`).join('\n');watcherEmit('watcher_feed',{source:'discord',label:ch.label||ch.channelId,summary:texts,count:res.messages.length,raw:true,ts:new Date().toISOString()});}
    catch(e){logWrite('watcher','ERROR',`discord: ${e.message}`);}
  }
}
async function telegramPollTick(wcfg){
  if(!wcfg.telegramEnabled||!wcfg.telegramToken)return;
  const chats=wcfg.telegramChats?.length?wcfg.telegramChats:[{id:'_all',chatId:'',label:'全チャット'}];
  for(const chat of chats){
    try{const lastUpd=watcherTelegramState.get(chat.chatId||'_all')??null;const res=await fetchTelegramMessages(wcfg.telegramToken,chat.chatId,lastUpd);if(res.error){watcherEmit('watcher_error',`Telegram[${chat.label||'all'}]: ${res.error}`);continue;}watcherTelegramState.set(chat.chatId||'_all',res.lastUpdateId);if(!res.messages.length)continue;const texts=res.messages.map(m=>`[${m.author}] ${m.content}`).join('\n');watcherEmit('watcher_feed',{source:'telegram',label:chat.label||chat.chatId||'全チャット',summary:texts,count:res.messages.length,raw:true,ts:new Date().toISOString()});}
    catch(e){logWrite('watcher','ERROR',`telegram: ${e.message}`);}
  }
}

async function searxTaskTick(task,wcfg){
  if(!task.enabled)return;
  watcherEmit('watcher_status',`𓅱 [${task.label||'タスク'}] 処理中...`);
  const maxRes=Math.min(30,Math.max(10,wcfg.searxMaxResults||15)); // ③
  let texts=[],sourceDesc='';
  if(task.type==='search'){
    if(!task.query)return;
    watcherEmit('watcher_status',`𓅱 「${task.query}」を検索中 (最大${maxRes}件)...`);
    const allR=await Promise.race([searxSearch(task.query,maxRes),new Promise(r=>setTimeout(()=>r([]),20000))]);
    if(!allR.length){watcherEmit('watcher_status',`[${task.label}] 検索結果なし`);return;}
    // ⑩ 24h以内+信頼URLフィルタ
    let filtered=allR.filter(r=>isWithin24h(r.publishedDate)&&isTrustedUrl(r.url));
    if(!filtered.length)filtered=allR.filter(r=>isTrustedUrl(r.url));
    if(!filtered.length)filtered=allR;
    texts=filtered.map(r=>`【${r.title}】\n${r.snippet}\nURL: ${r.url}`);
    sourceDesc=`検索: ${task.query} (${filtered.length}/${allR.length}件)`;
  }else if(task.type==='url'){
    if(!task.url)return;
    watcherEmit('watcher_status',`𓅱 [${task.label}] URLを取得中...`);
    const pageText=await fetchPageContent(task.url);
    if(!pageText||pageText.length<50){watcherEmit('watcher_status',`[${task.label}] ページ取得失敗`);return;}
    texts=[pageText.slice(0,2500)+(task.topic?`\nトピック「${task.topic}」に関する情報のみ抽出してください。`:'')];
    sourceDesc=`URL監視: ${task.url}${task.topic?' / '+task.topic:''}`;
  }
  if(!texts.length)return;
  watcherEmit('watcher_status',`[${task.label}] AI要約中...`);
  const summary=await summarizeWithAI(texts,task.systemPrompt||'');
  watcherEmit('watcher_feed',{source:'searx',label:task.label||sourceDesc,taskType:task.type,query:task.query||'',url:task.url||'',topic:task.topic||'',summary:summary||texts.slice(0,2).join('\n\n'),raw:!summary,count:texts.length,ts:new Date().toISOString()});
}

async function searxAllTasksTick(wcfg){
  if(watcherUserBusy){watcherSkippedCount++;logWrite('watcher','INFO','SearXNG skipped (user busy)');return;} // ⑧
  if(!wcfg.searxEnabled||!wcfg.searxTasks?.length)return;
  for(const task of wcfg.searxTasks){
    if(!task.enabled)continue;
    try{await searxTaskTick(task,wcfg);}catch(e){logWrite('watcher','ERROR',`searx ${task.id}: ${e.message}`);}
    await new Promise(r=>setTimeout(r,1000)); // ⑪ タスク間待機
  }
}

function startWatcher(){
  const wcfg=getWatcherCfg();watcherCommand='schedule';stopWatcher();
  if(wcfg.discordEnabled&&wcfg.discordToken){watcherRunState.discord=true;discordPollTick(wcfg).catch(()=>{});watcherTimers.discord=setInterval(()=>{if(watcherCommand==='stop')return;discordPollTick(getWatcherCfg()).catch(()=>{});},30000);}
  if(wcfg.telegramEnabled&&wcfg.telegramToken){watcherRunState.telegram=true;telegramPollTick(wcfg).catch(()=>{});watcherTimers.telegram=setInterval(()=>{if(watcherCommand==='stop')return;telegramPollTick(getWatcherCfg()).catch(()=>{});},30000);}
  if(wcfg.searxEnabled&&wcfg.searxTasks?.some(t=>t.enabled)){
    watcherRunState.searx=true;const ms=Math.max(1,Math.min(60,wcfg.searxIntervalMin||5))*60000;
    watcherNextSearxTime=Date.now()+ms;
    searxAllTasksTick(wcfg).then(()=>{watcherNextSearxTime=Date.now()+ms;}).catch(()=>{});
    watcherTimers.searx=setInterval(()=>{if(watcherCommand==='stop')return;watcherNextSearxTime=Date.now()+ms;searxAllTasksTick(getWatcherCfg()).catch(()=>{});},ms);
  }
  if(wcfg.calendarEnabled){watcherRunState.calendar=true;calendarTick(wcfg).catch(()=>{});watcherTimers.calendar=setInterval(()=>{if(watcherCommand==='stop')return;calendarTick(getWatcherCfg()).catch(()=>{});},600000);}
  // ⑪ ウォッチドッグ
  watcherWatchdogTimer=setInterval(()=>{
    if(watcherCommand==='stop')return;const wc=getWatcherCfg();
    if(wc.discordEnabled&&wc.discordToken&&!watcherTimers.discord){watcherRunState.discord=true;watcherTimers.discord=setInterval(()=>{if(watcherCommand!=='stop')discordPollTick(getWatcherCfg()).catch(()=>{});},30000);logWrite('watcher','WARN','Discord watchdog restart');}
    if(wc.telegramEnabled&&wc.telegramToken&&!watcherTimers.telegram){watcherRunState.telegram=true;watcherTimers.telegram=setInterval(()=>{if(watcherCommand!=='stop')telegramPollTick(getWatcherCfg()).catch(()=>{});},30000);logWrite('watcher','WARN','Telegram watchdog restart');}
    if(wc.searxEnabled&&!watcherTimers.searx){const ms2=Math.max(1,Math.min(60,wc.searxIntervalMin||5))*60000;watcherRunState.searx=true;watcherNextSearxTime=Date.now()+ms2;watcherTimers.searx=setInterval(()=>{if(watcherCommand!=='stop'){watcherNextSearxTime=Date.now()+ms2;searxAllTasksTick(getWatcherCfg()).catch(()=>{});}},ms2);logWrite('watcher','WARN','SearXNG watchdog restart');}
  },60000);
  logWrite('watcher','INFO','startWatcher v3');
}
function stopWatcher(){Object.values(watcherTimers).forEach(t=>{if(t)clearInterval(t);});watcherTimers={};watcherRunState={discord:false,telegram:false,searx:false,calendar:false};watcherCommand='stop';watcherNextSearxTime=null;if(watcherWatchdogTimer){clearInterval(watcherWatchdogTimer);watcherWatchdogTimer=null;}logWrite('watcher','INFO','stopWatcher');}
// SearXNG定期タスクのみ停止 (Discord/Telegram/Calendarは継続) - スライドスイッチ用
function stopSearxOnly(){
  if(watcherTimers.searx){clearInterval(watcherTimers.searx);watcherTimers.searx=null;}
  watcherRunState.searx=false;watcherNextSearxTime=null;
  logWrite('watcher','INFO','stopSearxOnly');
}
// SearXNG定期タスクのみ開始
function startSearxOnly(){
  const wcfg=getWatcherCfg();
  if(!wcfg.searxEnabled||!wcfg.searxTasks?.some(t=>t.enabled))return;
  const ms=Math.max(1,Math.min(60,wcfg.searxIntervalMin||5))*60000;
  watcherRunState.searx=true;watcherNextSearxTime=Date.now()+ms;
  if(watcherTimers.searx)clearInterval(watcherTimers.searx);
  searxAllTasksTick(wcfg).then(()=>{watcherNextSearxTime=Date.now()+ms;}).catch(()=>{});
  watcherTimers.searx=setInterval(()=>{
    if(watcherCommand==='stop')return;
    watcherNextSearxTime=Date.now()+ms;
    searxAllTasksTick(getWatcherCfg()).catch(()=>{});
  },ms);
  logWrite('watcher','INFO','startSearxOnly');
}
function isSearxRunning(){return watcherRunState.searx;}
async function runWatcherNow(){
  const wcfg=getWatcherCfg();watcherEmit('watcher_status','今すぐ実行中...');
  const proms=[];
  if(wcfg.discordEnabled&&wcfg.discordToken)proms.push(discordPollTick(wcfg));
  if(wcfg.telegramEnabled&&wcfg.telegramToken)proms.push(telegramPollTick(wcfg));
  if(wcfg.searxEnabled)proms.push(searxAllTasksTick(wcfg));
  if(wcfg.calendarEnabled)proms.push(calendarTick(wcfg));
  await Promise.allSettled(proms);watcherEmit('watcher_status','実行完了');
}

// エージェントチャット ⑧⑨
async function runAgentChat(userMessage, onEvent) {
  watcherUserBusy=true;watcherSkippedCount=0;
  const {host,port,model}=getAgentAI();
  if(!model){await detectModel();}const useModel=getAgentAI().model||MODEL_ID;
  const wcfg=getWatcherCfg();
  // カレンダーコンテキスト ⑥
  let calContext='';
  if(wcfg.calendarEnabled){
    try{const evs=[];if(wcfg.googleCalendarEnabled)evs.push(...await fetchGoogleCalendarEvents(wcfg));if(wcfg.iCloudCalendarEnabled)evs.push(...await fetchICloudCalendarEvents(wcfg));if(evs.length>0)calContext='\n\n【カレンダー予定（今後7日間）】\n'+evs.map(e=>`・${e.title} (${e.start})`).join('\n');}catch{}
  }
  // 検索コンテキスト
  const needsSearch=/検索|調べ|search|news|最新|ニュース/i.test(userMessage);
  let searchContext='';
  if(needsSearch&&cfg.searxngUrl){
    onEvent({type:'agent_status',data:'𓅱 検索中...'});
    try{const results=await Promise.race([searxSearch(userMessage,10),new Promise(r=>setTimeout(()=>r([]),12000))]);if(results.length)searchContext='\n\n【検索結果】\n'+results.map(r=>`・${r.title}\n  ${r.snippet}\n  ${r.url}`).join('\n');}catch{}
  }
  const history=loadAgentHistory();
  const sysPrompt=buildAgentChatSysPrompt(calContext);
  const msgs=[{role:'system',content:sysPrompt},...history.slice(-20),{role:'user',content:userMessage+searchContext}];
  if(!useModel){onEvent({type:'agent_text',data:'× AIに接続できません。'});watcherUserBusy=false;return;}
  onEvent({type:'agent_status',data:'AIが回答中...'});
  try{
    const d=await Promise.race([httpPost(host,port,'/v1/chat/completions',{model:useModel,messages:msgs,temperature:0.5,max_tokens:1200,stream:false},45000),new Promise((_,rej)=>setTimeout(()=>rej(new Error('タイムアウト')),50000))]);
    const reply=d.choices?.[0]?.message?.content||'（応答なし）';
    onEvent({type:'agent_text',data:reply});
    history.push({role:'user',content:userMessage},{role:'assistant',content:reply});
    saveAgentHistory(history);
  }catch(e){onEvent({type:'agent_text',data:`× エラー: ${e.message}`});}
  watcherUserBusy=false;
  if(watcherSkippedCount>0){watcherSkippedCount=0;setTimeout(()=>runWatcherNow().catch(()=>{}),2000);}
}

// フィード結果をエージェントチャット履歴に追記する
function saveAgentFeedToHistory(feedData){
  try{
    const hist=loadAgentHistory();
    const srcLabels={discord:'Discord',telegram:'Telegram',searx:feedData.taskType==='url'?'URL監視':'SearXNG検索',calendar:'カレンダー'};
    const src=srcLabels[feedData.source]||feedData.source;
    const summary=`[${src}フィード: ${feedData.label||''}]\n${feedData.summary||''}`;
    hist.push({role:'assistant',content:summary,isFeed:true,feedData});
    saveAgentHistory(hist);
  }catch{}
}

module.exports = {
  getCfg, updateCfg, detectModel, detectModelsAt, detectChatModels, detectWatcherModels, searxSearch,
  runAgent, stopAgent, isAborted,
  saveResumeFile, loadResumeFile, deleteResumeFile,
  makeDevSysPrompt, buildChatSysPrompt, buildDebugSysPrompt, buildAgentChatSysPrompt,
  getSession, loadIndex, saveIndex, loadProj, saveProj, projPath,
  getLogs, logWrite, deleteOldLogs,
  getWatcherCfg, saveWatcherCfg, getAgentAI,
  startWatcher, stopWatcher, stopSearxOnly, startSearxOnly, isSearxRunning,
  isWatcherRunning, runWatcherNow, getWatcherNextTime,
  setWatcherCallback, runAgentChat, saveAgentFeedToHistory,
  loadAgentHistory, saveAgentHistory, clearAgentHistory,
  fetchDiscordMessages, fetchTelegramMessages,
  fetchGoogleCalendarEvents, fetchICloudCalendarEvents,
};

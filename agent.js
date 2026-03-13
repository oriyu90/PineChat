'use strict';
// agent.js — Pine Chat AI通信・ツール実行・ループ検知・ほったらかしモード
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
  handsOff: false
};

function loadCfg() {
  try { return Object.assign({}, DEFAULT_CFG, JSON.parse(fs.readFileSync(CFG_FILE,'utf-8'))); }
  catch { return { ...DEFAULT_CFG }; }
}
function saveCfg(c) { fs.writeFileSync(CFG_FILE, JSON.stringify(Object.assign({}, DEFAULT_CFG, c), null, 2)); }

let cfg = loadCfg();
let MODEL_ID = null;
function getCfg()   { return { ...cfg }; }
function getModel() { return MODEL_ID; }
function updateCfg(partial) { cfg = Object.assign(cfg, partial); saveCfg(cfg); MODEL_ID = null; }

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
      let raw='';
      res.on('data', c => raw+=c);
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
      let raw='';
      res.on('data', c => raw+=c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error('JSON失敗')); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
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

// ── SearXNG ───────────────────────────────────────────────
function searxSearch(query, max=5) {
  return new Promise(resolve => {
    if (!cfg.searxngUrl) { resolve([]); return; }
    let url; try { url = new URL(cfg.searxngUrl); } catch { resolve([]); return; }
    const proto = url.protocol==='https:' ? https : http;
    const req = proto.request({
      hostname:url.hostname, port:url.port||(url.protocol==='https:'?443:80),
      path:`/search?q=${encodeURIComponent(query)}&format=json&categories=general`,
      method:'GET', timeout:9000,
      headers:{'Accept':'application/json','User-Agent':'PineChat/1.0'}
    }, res => {
      let raw='';
      res.on('data', c=>raw+=c);
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          resolve((j.results||[]).slice(0,max).map(r=>({ title:r.title||'', url:r.url||'', snippet:r.content||r.snippet||'' })));
        } catch { resolve([]); }
      });
      res.on('error', ()=>resolve([]));
    });
    req.on('timeout', ()=>{ req.destroy(); resolve([]); });
    req.on('error', ()=>resolve([]));
    req.end();
  });
}

// ── ツール定義 ────────────────────────────────────────────
const TOOLS = [
  { type:'function', function:{ name:'execute_shell',
    description:'シェルコマンドを実行する',
    parameters:{ type:'object', properties:{ command:{type:'string'}, reason:{type:'string'} }, required:['command','reason'] }
  }},
  { type:'function', function:{ name:'read_file',
    description:'ファイルを読み込む',
    parameters:{ type:'object', properties:{ path:{type:'string'} }, required:['path'] }
  }},
  { type:'function', function:{ name:'write_file',
    description:'ファイルを書き込む',
    parameters:{ type:'object', properties:{ path:{type:'string'}, content:{type:'string'} }, required:['path','content'] }
  }},
  { type:'function', function:{ name:'list_directory',
    description:'ディレクトリ一覧を取得する',
    parameters:{ type:'object', properties:{ path:{type:'string'} }, required:['path'] }
  }},
  { type:'function', function:{ name:'fetch_url',
    description:'URLの内容を取得する',
    parameters:{ type:'object', properties:{ url:{type:'string'} }, required:['url'] }
  }},
  { type:'function', function:{ name:'web_search',
    description:'SearXNG経由でWebを検索する',
    parameters:{ type:'object', properties:{ query:{type:'string'}, reason:{type:'string'} }, required:['query','reason'] }
  }}
];

// ── ツール実行 ────────────────────────────────────────────
function resolvePath(p, workDir) {
  if (!p) throw new Error('パスなし');
  if (p.startsWith('~')) return p.replace('~', os.homedir());
  if (!path.isAbsolute(p) && workDir) return path.join(workDir, p);
  return p;
}

// fetch_url: リダイレクト無限ループを防ぐためdepth管理
async function fetchUrl(urlStr, workDir, sessId, depth=0) {
  if (depth > 5) return { error: 'リダイレクト上限超過' };
  let u = (urlStr||'').trim();
  if (!u.startsWith('http')) u = 'https://' + u;
  let parsed;
  try { parsed = new URL(u); } catch { return { error: '無効URL' }; }
  const proto = parsed.protocol === 'https:' ? https : http;
  return new Promise(resolve => {
    const req = proto.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET', timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,*/*' }
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume(); // bodyを消費してから
        const loc = res.headers.location;
        const nextUrl = loc.startsWith('http') ? loc : `${parsed.protocol}//${parsed.host}${loc}`;
        resolve(fetchUrl(nextUrl, workDir, sessId, depth+1));
        return;
      }
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', c => { data += c; if (data.length > 50000) res.destroy(); });
      res.on('end', () => resolve({
        url: u,
        content: data
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 10000)
      }));
      res.on('error', e => resolve({ error: e.message }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', e => resolve({ error: e.message }));
    req.end();
  });
}

async function runTool(name, args, workDir, sessId) {
  logWrite(sessId,'TOOL',`${name} ${JSON.stringify(args).slice(0,150)}`);
  switch(name) {
    case 'execute_shell': return new Promise(resolve => {
      const BLOCKED = ['sudo ','rm -rf /','mkfs'];
      if (BLOCKED.some(b=>(args.command||'').includes(b))) return resolve({ error:'ブロック:'+args.command });
      exec(args.command, { timeout:30000, maxBuffer:5*1024*1024, shell:'/bin/bash', cwd:workDir||process.cwd(), env:{...process.env} },
        (err,out,err2) => resolve({ stdout:(out||'').slice(0,8000), stderr:(err2||'').slice(0,2000), exitCode:err?1:0 }));
    });
    case 'read_file': try {
      const fp=resolvePath(args.path,workDir), st=fs.statSync(fp);
      return { content: st.size>1024*1024 ? fs.readFileSync(fp,'utf-8').slice(0,50000) : fs.readFileSync(fp,'utf-8'), truncated:st.size>1024*1024 };
    } catch(e) { return { error:e.message }; }
    case 'write_file': try {
      const fp=resolvePath(args.path,workDir);
      fs.mkdirSync(path.dirname(fp),{recursive:true}); fs.writeFileSync(fp,args.content||'','utf-8');
      return { success:true, path:fp };
    } catch(e) { return { error:e.message }; }
    case 'list_directory': try {
      const dp=resolvePath(args.path,workDir);
      return { path:dp, items:fs.readdirSync(dp,{withFileTypes:true}).slice(0,200).map(it=>({
        name:it.name, type:it.isDirectory()?'directory':'file',
        size:it.isFile()?(()=>{try{return fs.statSync(path.join(dp,it.name)).size;}catch{return null;}})():null
      }))};
    } catch(e) { return { error:e.message }; }
    case 'fetch_url':
      return fetchUrl(args.url, workDir, sessId);
    case 'web_search': {
      const r = await searxSearch(args.query,5);
      return r.length ? { results:r } : { error:'SearXNG未設定または結果なし' };
    }
    default: return { error:`不明:${name}` };
  }
}

// ── ループ検知 ────────────────────────────────────────────
// win=8: ウィンドウを大きくして誤検知を低減
function detectLoop(msgs, win=8) {
  if (msgs.length < win*2) return false;
  const r = msgs.slice(-win).map(m=>m.content||'').join('|');
  const p = msgs.slice(-win*2,-win).map(m=>m.content||'').join('|');
  if (r===p) return true;
  const rs=new Set(r.split(/\s+/).slice(0,80)), ps=new Set(p.split(/\s+/).slice(0,80));
  const inter=[...rs].filter(w=>ps.has(w)).length, uni=new Set([...rs,...ps]).size;
  return uni>0 && inter/uni>0.88;
}

// ── ほったらかし: ループ打開 ──────────────────────────────
async function handsOffBreakLoop(sessId, msgs, workDir, onEvent) {
  logWrite(sessId,'WARN','ループ検知 → ほったらかし打開開始');
  onEvent({ type:'system', data:'△ ループ検知。自動的に打開します...' });

  const recentText = msgs.slice(-8).map(m=>`[${m.role}]:${(m.content||'').slice(0,300)}`).join('\n');
  let problem = '';
  try {
    const d = await httpPost(cfg.aiHost||'127.0.0.1', cfg.aiPort, '/v1/chat/completions', {
      model:MODEL_ID,
      messages:[{role:'user',content:`以下の繰り返し処理から問題点を3点以内で簡潔に説明:\n${recentText}`}],
      temperature:0.3, max_tokens:400, stream:false
    }, 25000);
    problem = d.choices?.[0]?.message?.content || '';
  } catch {}

  let searchSuggestion = '';
  if (problem && cfg.searxngUrl) {
    const q = problem.split('\n')[0].slice(0,70)+' solution';
    const results = await Promise.race([searxSearch(q,3), new Promise(r=>setTimeout(()=>r([]),8000))]);
    if (results.length>0) {
      const ctx = results.map((r,i)=>`${i+1}. ${r.title}: ${r.snippet}`).join('\n');
      try {
        const d2 = await httpPost(cfg.aiHost||'127.0.0.1', cfg.aiPort, '/v1/chat/completions', {
          model:MODEL_ID,
          messages:[{role:'user',content:`問題:\n${problem}\n\n検索結果:\n${ctx}\n\n具体的な解決策を1つ提案:`}],
          temperature:0.4, max_tokens:500, stream:false
        }, 25000);
        searchSuggestion = d2.choices?.[0]?.message?.content || '';
      } catch {}
    }
  }

  if (workDir) {
    try {
      fs.writeFileSync(path.join(workDir,'_pinechat_loop_report.json'),
        JSON.stringify({ at:new Date().toISOString(), sessId, problem, searchSuggestion,
          history:msgs.slice(-6).map(m=>({role:m.role,content:(m.content||'').slice(0,400)})) }, null, 2));
    } catch {}
  }

  if (searchSuggestion) {
    onEvent({ type:'system', data:`𓂀 打開案: ${searchSuggestion.slice(0,120)}...` });
    return { resolved:true, suggestion:searchSuggestion };
  }

  onEvent({ type:'system', data:'𓅭 打開策が見つかりませんでした。このステップをスキップして続行します。' });
  return { resolved:true, suggestion:'このステップをスキップして次のタスクに進んでください。' };
}

// ── 開発モード用システムプロンプト ───────────────────────
function makeDevSysPrompt(workDir, customSys, langs) {
  const langNote = langs && langs.length > 0
    ? `\n優先言語: ${langs}\n※ 設計図の要件に応じて他の言語・ライブラリも適宜使用して良い。`
    : '';
  const custom = customSys ? `\n\n【プロジェクト指示】\n${customSys}` : '';
  return `あなたはアプリ開発専門AIエージェントです。
設計図に従い、タスクを1つずつ実行して開発を完成させます。

【必須ルール】
1. 最初に「=== タスクリスト ===」として全タスクを番号付きで表示する
2. 各タスク開始前に「--- タスクN/合計: [タスク名] ---」と宣言してから作業開始
3. 各タスク完了後に「[完] タスクN 完了 (進捗: N/合計)」と報告する
4. エラー時は必ずweb_searchツールで解決策を調べてから修正する
5. 全タスク完了時に「=== 開発完了 ===」と報告する
6. ファイルは作業フォルダに作成。sudo・パッケージインストール系は不可${langNote}

現在時刻: ${new Date().toLocaleString('ja-JP')}
作業フォルダ: ${workDir||os.homedir()}${custom}`;
}

// ── エージェントループ ────────────────────────────────────
const abortMap = new Map();

function stopAgent(sessId) { abortMap.get(sessId)?.abort(); abortMap.delete(sessId); }

async function runAgent(sessId, messages, sysPrompt, workDir, onEvent, opts={}) {
  if (!MODEL_ID) await detectModel();
  if (!MODEL_ID) {
    onEvent({ type:'text', data:'× AIに接続できません。設定を確認してください。' });
    logWrite(sessId,'ERROR','モデル未検出');
    return;
  }

  const ac = new AbortController();
  abortMap.set(sessId, ac);

  const devMode = sysPrompt.includes('タスクリスト');
  const msgs = [{ role:'system', content:sysPrompt }, ...messages];
  let loopCount = 0, sameCount = 0, lastContent = '';

  for (let turn = 0; turn < 60; turn++) {
    if (ac.signal.aborted) { onEvent({ type:'text', data:'\n■ 停止しました。' }); break; }
    // handsOffは毎ターン最新cfgから読む（途中トグルに対応）
    const isHandsOff = cfg.handsOff;

    let data;
    try {
      logWrite(sessId,'INFO',`Turn${turn+1} API送信`);
      data = await httpPost(cfg.aiHost||'127.0.0.1', cfg.aiPort, '/v1/chat/completions', {
        model:MODEL_ID, messages:msgs,
        tools:TOOLS, tool_choice:'auto',
        temperature:0.6, max_tokens:4096, stream:false
      });
    } catch(e) {
      logWrite(sessId,'ERROR',`APIエラー:${e.message}`);
      if(ac.signal.aborted){ onEvent({type:'text',data:'\n■ 停止'}); break; }
      onEvent({ type:'text', data:`\n× 通信エラー: ${e.message}` });
      onEvent({ type:'timeout', data:e.message });
      break;
    }

    const msg = data.choices?.[0]?.message;
    if (!msg) { onEvent({ type:'text', data:'\n× 空の応答' }); break; }
    msgs.push(msg);

    if (msg.content) {
      logWrite(sessId,'AI', msg.content.slice(0,200));
      onEvent({ type:'text', data:msg.content });

      if (devMode) {
        const totMatch = msg.content.match(/タスクリスト[\s\S]*?(\d+)\./g);
        if (totMatch && !msgs._totalTasksSet) {
          msgs._totalTasksSet = true;
          onEvent({ type:'progress', data:`タスクリスト: ${totMatch.length}件のタスクを確認` });
        }
        const startMatch = msg.content.match(/---\s*タスク(\d+)\/(\d+)[:\s]+(.+?)\s*---/);
        if (startMatch) {
          onEvent({ type:'task_start', data:{ n:parseInt(startMatch[1]), total:parseInt(startMatch[2]), name:startMatch[3].trim() } });
        }
        const doneMatch = msg.content.match(/\[完\]\s*タスク(\d+)\s*完了.*?(\d+)\/(\d+)/);
        if (doneMatch) {
          onEvent({ type:'task_done', data:{ n:parseInt(doneMatch[1]), total:parseInt(doneMatch[3]) } });
        }
        if (msg.content.includes('=== 開発完了 ===')) {
          onEvent({ type:'dev_complete', data:'' });
        }
      }

      // ループ検知
      if (msg.content === lastContent) { sameCount++; } else { sameCount=0; lastContent=msg.content; }
      if (detectLoop(msgs)) loopCount++;

      if (sameCount >= 3 || loopCount >= 2) {
        const breakResult = await handsOffBreakLoop(sessId, msgs, workDir, onEvent);
        sameCount=0; loopCount=0;
        if (breakResult.resolved && breakResult.suggestion) {
          msgs.push({ role:'user', content:`【ループ打開指示】\n${breakResult.suggestion}\n\n上記を参考に別のアプローチで続行してください。` });
        } else if (!isHandsOff) {
          onEvent({ type:'user_input_required', data:'× 自動打開に失敗しました。別の指示を入力するか「スキップ」と入力してください。' });
          break;
        }
        continue;
      }
    }

    if (!msg.tool_calls?.length) break;

    for (const tc of msg.tool_calls) {
      if (ac.signal.aborted) break;
      let args={}; try{args=JSON.parse(tc.function?.arguments||'{}');}catch{}
      onEvent({ type:'tool', data:{ id:tc.id, name:tc.function?.name||'', args } });
      const result = await runTool(tc.function?.name||'', args, workDir, sessId).catch(e=>({error:e.message}));
      msgs.push({ role:'tool', tool_call_id:tc.id, content:JSON.stringify(result) });
    }
  }

  abortMap.delete(sessId);
  deleteOldLogs();
}

// ── 再開ファイル ──────────────────────────────────────────
function saveResumeFile(sessId, workDir, history, checkpoint, state) {
  if (!workDir) return null;
  const data = {
    savedAt:new Date().toISOString(), sessId, checkpoint, state,
    historyTail:history.slice(-6).map(m=>({role:m.role,content:(m.content||'').slice(0,500)}))
  };
  const fp = path.join(workDir,'_pinechat_resume.json');
  try { fs.writeFileSync(fp, JSON.stringify(data,null,2)); return fp; } catch { return null; }
}
function loadResumeFile(workDir) {
  if (!workDir) return null;
  try {
    const fp=path.join(workDir,'_pinechat_resume.json');
    if(fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp,'utf-8'));
  } catch {}
  return null;
}
function deleteResumeFile(workDir) {
  if (!workDir) return;
  try { const fp=path.join(workDir,'_pinechat_resume.json'); if(fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
}

// ── プロジェクト永続化 ────────────────────────────────────
const IDX_FILE = path.join(DATA_DIR,'index.json');
function loadIndex() { try{return JSON.parse(fs.readFileSync(IDX_FILE,'utf-8'));}catch{return [];} }
function saveIndex(l){ try{fs.writeFileSync(IDX_FILE,JSON.stringify(l,null,2));}catch{} }
function projPath(id){ return path.join(DATA_DIR,`p_${id}.json`); }
function loadProj(id){ try{return JSON.parse(fs.readFileSync(projPath(id),'utf-8'));}catch{return null;} }
function saveProj(p) { try{fs.writeFileSync(projPath(p.id),JSON.stringify(p,null,2));}catch{} }

// ── セッション管理 ────────────────────────────────────────
const sessions = new Map();
function getSession(id) { if(!sessions.has(id)) sessions.set(id,{history:[]}); return sessions.get(id); }

// ── システムプロンプト ────────────────────────────────────
function buildChatSysPrompt(workDir, customSys) {
  const custom = customSys ? `\n\n【プロジェクト指示】\n${customSys}` : '';
  return `あなたは有能なAIアシスタントです。ユーザーの質問に丁寧に回答し、必要に応じてツールを使います。制約: sudo・インストール系コマンドは不可。\n現在時刻: ${new Date().toLocaleString('ja-JP')}\n作業フォルダ: ${workDir||os.homedir()}${custom}`;
}
function buildDebugSysPrompt(workDir, customSys) {
  const custom = customSys ? `\n\n【プロジェクト指示】\n${customSys}` : '';
  return `あなたはデバッグ・機能追加の専門AIエージェントです。既存コードを分析し、バグ修正・テスト・機能追加を行います。\n現在時刻: ${new Date().toLocaleString('ja-JP')}\n作業フォルダ: ${workDir||os.homedir()}${custom}`;
}

module.exports = {
  getCfg, updateCfg, getModel, detectModel, searxSearch,
  runAgent, stopAgent,
  saveResumeFile, loadResumeFile, deleteResumeFile,
  makeDevSysPrompt, buildChatSysPrompt, buildDebugSysPrompt,
  getSession, loadIndex, saveIndex, loadProj, saveProj, projPath,
  getLogs, logWrite, deleteOldLogs
};

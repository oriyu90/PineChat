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
const FILES_DIR = path.join(DATA_DIR, 'files'); // RAG/設計図の内部コピー先
[DATA_DIR, LOG_DIR, FILES_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive:true }); });

// ── 設定 ──────────────────────────────────────────────────
const CFG_FILE = path.join(DATA_DIR, 'config.json');
const DEFAULT_CFG = {
  aiHost: 'localhost', aiPort: 1234,
  searxngUrl: 'http://localhost:8080',
  timeout: 300, logEnabled: true, logMaxDays: 7,
  handsOff: false,
  chatAiHost: '', chatAiPort: 0, chatModelId: '',
  agentAiHost: '', agentAiPort: 0, agentModelId: '',
  uiLanguage: 'ja', aiResponseLanguage: 'ja',
  // 設計図作成AI
  blueprintAiType: 'local', blueprintAiHost: '', blueprintAiPort: 0, blueprintModelId: '',
  blueprintApiKey: '', blueprintThinking: false,
  // アプリ設計用外部AI（空=ローカルAI使用）
  designAiType: 'local', designAiHost: '', designAiPort: 0, designModelId: '', designApiKey: '',
  // 社内Wiki/ファイルサーバー（読み取り専用）
  wikiEnabled: false, wikiUrl: '', wikiUser: '', wikiPass: '',
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

// ── HTTPS POST（外部API用）──────────────────────────────
function httpsPost(hostname, port, p, body, tms, extraHeaders) {
  return new Promise((resolve, reject) => {
    const bs = JSON.stringify(body);
    const headers = Object.assign({'Content-Type':'application/json','Content-Length':Buffer.byteLength(bs)}, extraHeaders||{});
    const req = https.request({hostname, port:port||443, path:p, method:'POST', headers, timeout:tms||120000}, res => {
      let raw=''; res.on('data', c => raw+=c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error('JSON parse失敗:'+raw.slice(0,200))); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`HTTPS タイムアウト(${Math.round((tms||120000)/1000)}s)`)); });
    req.write(bs); req.end();
  });
}

// ── 設計図AI設定 ─────────────────────────────────────────
const BP_API_HOSTS = {deepseek:'api.deepseek.com', openai:'api.openai.com', anthropic:'api.anthropic.com'};
function getBlueprintAI() {
  return {
    type: cfg.blueprintAiType||'local',
    host: cfg.blueprintAiHost || BP_API_HOSTS[cfg.blueprintAiType] || cfg.chatAiHost || cfg.aiHost || 'localhost',
    port: cfg.blueprintAiPort || (cfg.blueprintAiType!=='local'?443:0) || cfg.chatAiPort || cfg.aiPort || 1234,
    model: cfg.blueprintModelId || cfg.chatModelId || MODEL_ID,
    apiKey: cfg.blueprintApiKey || '',
    thinking: !!cfg.blueprintThinking,
  };
}

// 外部API: OpenAI互換呼び出し (local / deepseek / openai)
async function callOpenAICompatBP(bpCfg, msgs, tms) {
  const isLocal = bpCfg.type==='local';
  const host = bpCfg.host;
  const port = bpCfg.port || (isLocal ? (cfg.aiPort||1234) : 443);
  const body = {model:bpCfg.model, messages:msgs, temperature:0.7, max_tokens:4096, stream:false};
  if(bpCfg.thinking) body.enable_thinking = true; // DeepSeek R1等
  const headers = {};
  if(bpCfg.apiKey) headers['Authorization'] = `Bearer ${bpCfg.apiKey}`;
  let data;
  if(isLocal) data = await httpPost(host, port, '/v1/chat/completions', body, tms||cfg.timeout*1000);
  else data = await httpsPost(host, port, '/v1/chat/completions', body, tms||120000, headers);
  const msg = data.choices?.[0]?.message;
  return {text: msg?.content||'', thinking: msg?.reasoning_content||''};
}

// 外部API: Anthropic呼び出し
async function callAnthropicBP(bpCfg, history, sysPrompt, tms) {
  if(!bpCfg.apiKey) throw new Error('Anthropic APIキーが未設定です');
  const aMsgs = history.filter(m=>m.role==='user'||m.role==='assistant').map(m=>({role:m.role,content:m.content}));
  if(!aMsgs.length || aMsgs[0].role!=='user') aMsgs.unshift({role:'user',content:'よろしくお願いします。'});
  const body = {model:bpCfg.model||'claude-sonnet-4-20250514', max_tokens:8096, system:sysPrompt, messages:aMsgs};
  if(bpCfg.thinking) { body.thinking={type:'enabled',budget_tokens:10000}; body.max_tokens=16000; }
  const headers = {'Content-Type':'application/json','x-api-key':bpCfg.apiKey,'anthropic-version':'2023-06-01'};
  if(bpCfg.thinking) headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
  const data = await httpsPost('api.anthropic.com', 443, '/v1/messages', body, tms||120000, headers);
  if(data.error) throw new Error(data.error.message||JSON.stringify(data.error));
  let thinking='', text='';
  for(const b of (data.content||[])){if(b.type==='thinking')thinking+=b.thinking;if(b.type==='text')text+=b.text;}
  return {thinking, text};
}

// 設計図AI統合呼び出し
async function callBlueprintAI(history, sysPrompt) {
  const bp = getBlueprintAI();
  if(!bp.model && bp.type==='local') { await detectModel(); bp.model = MODEL_ID; }
  if(!bp.model) throw new Error('AIモデルが未設定です');
  const msgs = [{role:'system',content:sysPrompt},...history];
  if(bp.type==='anthropic') return callAnthropicBP(bp, history, sysPrompt);
  return callOpenAICompatBP(bp, msgs);
}

// 設計図チャット1ターン実行（リトライ・abort対応）
async function runBlueprintChat(sessId, history, sysPrompt, onEvent) {
  const ac = new AbortController();
  abortMap.set(sessId, ac);
  let result = '', retries = 0;
  try {
    while(retries <= 3) {
      if(ac.signal.aborted) { onEvent({type:'text',data:'\n■ 停止しました。'}); break; }
      try {
        const resp = await callBlueprintAI(history, sysPrompt);
        if(resp.thinking) onEvent({type:'thinking', data:resp.thinking});
        if(resp.text) { onEvent({type:'text', data:resp.text}); result=resp.text; }
        if(!result) { retries++; onEvent({type:'system',data:`⚠ 応答が空でした。再試行中(${retries}/3)...`}); await new Promise(r=>setTimeout(r,5000)); continue; }
        break;
      } catch(e) {
        if(ac.signal.aborted) break;
        retries++;
        if(retries>3) { onEvent({type:'text',data:`\n× 通信エラー: ${e.message}`}); onEvent({type:'timeout',data:e.message}); break; }
        const wait = retries*10;
        onEvent({type:'system',data:`⚠ エラー(${e.message.slice(0,60)}) — ${retries}/3回 ${wait}秒後に再試行...`});
        await new Promise(r=>setTimeout(r,wait*1000));
      }
    }
  } finally { abortMap.delete(sessId); }
  return result;
}

// 設計図モデル一覧取得（外部API対応）
async function detectBlueprintModels() {
  const bp = getBlueprintAI();
  if(bp.type==='local') return detectModelsAt(bp.host, bp.port);
  if(bp.type==='anthropic') return [
    {id:'claude-sonnet-4-20250514',name:'Claude Sonnet 4'},
    {id:'claude-opus-4-20250514',name:'Claude Opus 4'},
    {id:'claude-haiku-4-20250414',name:'Claude Haiku 4'},
  ];
  // DeepSeek / OpenAI: /v1/models をHTTPS GET
  try {
    const headers = {};
    if(bp.apiKey) headers['Authorization'] = `Bearer ${bp.apiKey}`;
    const data = await new Promise((resolve,reject)=>{
      const host = bp.host || BP_API_HOSTS[bp.type];
      const req = https.request({hostname:host,port:443,path:'/v1/models',method:'GET',timeout:10000,headers}, res=>{
        let raw='';res.on('data',c=>raw+=c);res.on('end',()=>{try{resolve(JSON.parse(raw));}catch{reject(new Error('parse'));}});
      });
      req.on('error',reject);req.on('timeout',()=>{req.destroy();reject(new Error('timeout'));});req.end();
    });
    return (data.data||[]).map(m=>({id:m.id,name:m.id}));
  } catch { return []; }
}

// ── 設計図システムプロンプト ─────────────────────────────
function buildBlueprintSysPrompt(workDir, customSys) {
  const custom = customSys ? `\n\n【プロジェクト指示】\n${customSys}` : '';
  const lang = cfg.aiResponseLanguage || 'ja';
  const isJa = lang === 'ja';
  return `${isJa?'あなたはアプリケーション設計の専門家AIです。':'You are an expert application design AI.'}
${isJa?'ユーザーと対話しながら、Pine Chatの「アプリ設計」機能で使用する詳細な設計図(.mdファイル)を作成するための情報を収集します。':'You gather information through dialogue to create a detailed design document (.md) for use with Pine Chat\'s app design feature.'}

${isJa?'【絶対ルール】必ず日本語のみで回答してください。英語は使用禁止です。':'【Rule】Always respond in English only.'}

${isJa?'【あなたの役割】':'【Your Role】'}
${isJa?`1. ユーザーのアプリのアイデアや要件を深く理解する
2. 不足している情報を的確な質問で補完する
3. 各回答の末尾に、ユーザーが選びやすい選択肢を提示する
4. 十分な情報が集まったら設計図の生成を提案する
5. 生成される設計図はPine Chatのアプリ設計AIが読み込んで自動開発に使うため、曖昧さを排除し、ファイル構造・処理フロー・データ構造を具体的に決める`
:`1. Deeply understand the user's app idea and requirements
2. Ask targeted questions to fill in missing information
3. Present clear choices at the end of each response
4. Propose generating the design document when enough information is gathered
5. The design will be used by Pine Chat's auto-development AI, so eliminate ambiguity`}

${isJa?'【段階的に確認すべき項目】（一度に聞く質問は必ず1〜2個まで。3個以上は禁止）':'【Items to confirm step by step】(Ask only 1-2 questions at a time. Never 3+)'}
${isJa?`- アプリの目的・概要・ターゲットユーザー
- 対象プラットフォーム（Web / iOS / Android / デスクトップ / CLI）
- 主要機能の一覧と各機能の詳細な処理フロー
- データモデル（テーブル定義・リレーション・保存方式）
- 画面構成・画面遷移・UI/UXの方向性
- 外部APIやサービスの利用有無と連携方法
- 技術スタック（言語・フレームワーク・ライブラリ）の決定
- 認証・セキュリティ要件
- ファイル・ディレクトリ構造の設計
- エラーハンドリング・例外処理の方針`
:`- App purpose, overview, target users
- Target platform (Web / iOS / Android / Desktop / CLI)
- Key features with detailed processing flows
- Data model (table definitions, relations, storage)
- Screen layout, navigation, UI/UX direction
- External APIs/services and integration
- Tech stack decisions
- Auth/security requirements
- File/directory structure design
- Error handling policies`}

${isJa?'【選択肢の出力形式】（厳守すること）':'【Choice output format】(must follow)'}
${isJa?`- 1回の返答で聞く質問は最大2つまで（厳守）
- 各質問の直後に ---choices--- ブロックを1つ配置
- 選択肢は各質問につき2〜4個で短く明確に
- ユーザーはクリックまたは「その他」欄に自由入力で回答可能`
:`- Ask maximum 2 questions per response (strict)
- Place one ---choices--- block right after each question
- 2-4 short, clear choices per question
- Users can click or type freely in "Other" field`}

${isJa?'例：':'Example:'}

${isJa?'**Q1: データの保存形式はどうしますか？**':'**Q1: Storage format?**'}

---choices---
${isJa?'SQLiteでローカル保存':'SQLite local'}
${isJa?'Firebaseでクラウド保存':'Firebase cloud'}
---/choices---

${isJa?'**Q2: 認証機能は必要ですか？**':'**Q2: Need auth?**'}

---choices---
${isJa?'メール+パスワード認証':'Email+password'}
${isJa?'認証不要':'No auth'}
---/choices---

${isJa?'情報が十分に集まったら、選択肢に「🔨 設計図を生成する」を含めてください。':'When ready, include "🔨 Generate Design" in choices.'}

${isJa?'現在時刻':'Time'}: ${new Date().toLocaleString(isJa?'ja-JP':'en-US')}
${isJa?'作業フォルダ':'Folder'}: ${workDir||os.homedir()}${custom}`;
}

function buildBlueprintGenerateSysPrompt(workDir, customSys) {
  const custom = customSys ? `\n\n【プロジェクト指示】\n${customSys}` : '';
  const lang = cfg.aiResponseLanguage || 'ja';
  const isJa = lang === 'ja';
  return `${isJa?'あなたはアプリケーション設計の専門家AIです。':'You are an expert application design AI.'}
${isJa?'これまでの会話で決定した全仕様をもとに、AIが自動開発するための完全な設計書(.md)を出力してください。':'Based on all specifications decided in the conversation, output a complete design document (.md) for automated AI development.'}

${isJa?'【絶対ルール】':'【Rules】'}
${isJa?`- 必ず日本語のみで出力すること
- この設計書を読んだAIが「このアプリのソースコードを作成する」ために使う
- 開発期間やスケジュールは一切記載しない（AIが即時開発するため不要）
- 「〜を推奨」「〜または〜」のような曖昧な表現は絶対禁止。全て断定で書くこと
- 使用するライブラリは具体名を明記（例:「SMBライブラリ」ではなく「jcifs-ng 2.1.0」）
- アーキテクチャパターン（MVVM/MVI/MVP等）を明確に1つ選定し記載すること
- データの真のソース（Single Source of Truth）を明確にすること
- 設計書は途中で切れないこと。全セクションを完結させること
- 出力前に以下を自己検証: データモデルとAPIの整合性、画面遷移の完全性、タスク順序の矛盾`
:`- Output in specified language only
- An AI reads this to CREATE SOURCE CODE
- No timelines/schedules
- No ambiguity - be definitive, not suggestive
- Name specific libraries with versions
- Specify one architecture pattern explicitly
- Define Single Source of Truth for data
- Complete all sections - never cut off
- Self-verify consistency before output`}

${isJa?'【開発スコープの明記】設計書の冒頭に以下を必ず含めること：':'【Scope】Include at the top:'}
${isJa?`## 0. 開発スコープ
- AIが開発する範囲（ソースコード、設定ファイル、ビルド設定等）
- AIが開発しない範囲（サーバー構築、ストア申請、証明書取得等の手動作業）
- 対象プラットフォームと動作確認環境
- ビルド方法（コマンド1行で実行できる形で記載）`
:`## 0. Development Scope
- What AI builds (source code, config, build setup)
- What AI does NOT build (server setup, store submission, certificates)
- Target platform and test environment
- Build command (single command)`}

${isJa?'【出力形式】':'【Format】'}

# ${isJa?'[アプリ名] — 設計書':'[App Name] — Design Document'}

## 1. ${isJa?'プロジェクト概要':'Project Overview'}
${isJa?'- アプリの目的と解決する課題\n- ターゲットユーザー\n- 核となる価値提案':'- Purpose and problem solved\n- Target users\n- Core value proposition'}

## 2. ${isJa?'技術スタック':'Tech Stack'}
${isJa?'- 言語とバージョン\n- フレームワーク\n- 主要ライブラリ（名前とバージョン）\n- ビルドツール・パッケージマネージャー\n- データベース':'- Language and version\n- Framework\n- Key libraries\n- Build tools\n- Database'}

## 3. ${isJa?'プラットフォーム・動作環境':'Platform & Environment'}

## 4. ${isJa?'機能詳細':'Feature Details'}
${isJa?'各機能ごとに以下を記述：\n### 4.N [機能名]\n- 概要\n- 処理フロー（1. → 2. → 3. のステップ形式）\n- 入力データと出力データ\n- UI要素（ボタン、フォーム、リスト等）\n- バリデーション・エラー処理\n- 関連するデータモデル':'Detail each feature with: overview, step-by-step flow, I/O, UI elements, validation, related data models'}

## 5. ${isJa?'データ設計':'Data Design'}
${isJa?'### 5.1 データモデル\nテーブル/コレクションごとに：\n- テーブル名\n- 全カラム（名前、型、制約、デフォルト値）\n- リレーション（外部キー）\n- インデックス\n\n### 5.2 データフロー\nデータの生成→保存→取得→表示→更新→削除の流れ':'### 5.1 Data Model\nFor each table: name, columns, types, constraints, relations, indexes\n### 5.2 Data Flow'}

## 6. ${isJa?'API設計':'API Design'}
${isJa?'エンドポイントごとに：\n- メソッドとパス\n- リクエスト形式（ヘッダー、ボディ）\n- レスポンス形式（成功時、エラー時）\n- 認証要否':'For each endpoint: method, path, request format, response format, auth required'}

## 7. ${isJa?'画面設計':'Screen Design'}
${isJa?'### 7.1 画面一覧\n全画面のリストと各画面の役割\n### 7.2 画面遷移\n画面間の遷移フロー\n### 7.3 各画面のレイアウト\n画面ごとの構成要素とレイアウト方針':'### 7.1 Screen list\n### 7.2 Navigation flow\n### 7.3 Layout per screen'}

## 8. ${isJa?'ファイル・ディレクトリ構造':'File & Directory Structure'}
\`\`\`
${isJa?'プロジェクトルート/\n├── src/              # ソースコード\n│   ├── [ファイル名]  # [このファイルの役割]\n│   └── ...\n├── [設定ファイル]     # [役割]\n└── README.md':'project-root/\n├── src/\n│   ├── [filename] # [role]\n└── README.md'}
\`\`\`
${isJa?'各ファイルの役割と含むべき主要なクラス・関数を記述':'Describe role and key classes/functions per file'}

## 9. ${isJa?'セキュリティ設計':'Security Design'}

## 10. ${isJa?'開発セクション・タスクリスト（実装順序）':'Development Sections & Tasks (Implementation Order)'}
${isJa?'AIがセクション単位で順に実行する。各セクションの中にタスクを含める。\n\n形式：\nセクション1: [セクション名]\n  1.1 [タスク名] — 作成ファイル: [ファイル名], 内容: [詳細]\n  1.2 [タスク名] — 作成ファイル: [ファイル名], 内容: [詳細]\nセクション2: [セクション名]\n  2.1 [タスク名] — ...\n\n例：\nセクション1: プロジェクト初期化 (3タスク)\n  1.1 package.json作成 — 依存パッケージ定義\n  1.2 tsconfig.json設定 — TypeScript設定\n  1.3 ディレクトリ構造作成 — src/, public/, tests/\nセクション2: データモデル (2タスク)\n  2.1 Userモデル — src/models/user.ts\n  2.2 Postモデル — src/models/post.ts'
:'Sections with sub-tasks. Format: Section N: [name]\n  N.1 [task] - file, details\n  N.2 [task] - ...'}

## 11. ${isJa?'補足・注意事項':'Notes'}

${isJa?'現在時刻':'Time'}: ${new Date().toLocaleString(isJa?'ja-JP':'en-US')}
${isJa?'作業フォルダ':'Folder'}: ${workDir||os.homedir()}${custom}`;
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
// 広告・スパム・ハルシネーション源となるドメインパターン
const AD_SPAM_PATTERNS = [
  /\.doubleclick\.net/, /\.googlesyndication\.com/, /\.adnxs\.com/,
  /\.adsafeprotected\.com/, /\.amazon-adsystem\.com/, /affiliate/i,
  /\.clickbank\./, /\.cj\.com/, /\.shareasale\.com/,
  /pinterest\.com\/pin\//,  // Pinterestの画像ページ
  /\.tumblr\.com/, // 低品質コンテンツ多
];
// 広告/スパムURLを検出
function isAdOrSpamUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const full = url.toLowerCase();
    return AD_SPAM_PATTERNS.some(p => p.test(h) || p.test(full));
  } catch { return true; } // パース失敗は除外
}
// 結果の品質スコア（高いほど良い）
function scoreResult(r) {
  let score = 0;
  // snippetの長さ（短すぎは低品質）
  const snippetLen = (r.snippet || '').length;
  if (snippetLen > 100) score += 2;
  if (snippetLen > 200) score += 1;
  // エンジン数（複数のエンジンで引っかかるほど信頼性高い）
  const engines = r.engines || r.engine || [];
  const engineCount = Array.isArray(engines) ? engines.length : 1;
  score += Math.min(engineCount, 3);
  // HTTPSは信頼性が高い
  if ((r.url || '').startsWith('https://')) score += 1;
  // タイトルが存在する
  if ((r.title || '').length > 5) score += 1;
  return score;
}

function searxSearch(query, max=5) {
  return new Promise(resolve => {
    if (!cfg.searxngUrl) { resolve([]); return; }
    let url; try { url = new URL(cfg.searxngUrl); } catch { resolve([]); return; }
    const proto = url.protocol==='https:' ? https : http;
    // news + general の両カテゴリを取得し結合する
    const path = `/search?q=${encodeURIComponent(query)}&format=json&categories=general,news&language=auto`;
    const req = proto.request({
      hostname:url.hostname, port:url.port||(url.protocol==='https:'?443:80),
      path, method:'GET', timeout:15000,
      headers:{'Accept':'application/json','User-Agent':'PineChat/1.0'}
    }, res => {
      let raw=''; res.on('data', c=>raw+=c);
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          const rawResults = j.results || [];
          // フィルタリング: 広告・スパム除外、snippet最低長チェック
          const filtered = rawResults.filter(r => {
            if (!r.url || !r.title) return false;
            if (isAdOrSpamUrl(r.url)) return false;
            const snippet = r.content || r.snippet || '';
            if (snippet.length < 20) return false; // 内容が薄すぎる結果を除外
            return true;
          });
          // スコア順にソートして上位max件を返す
          const sorted = filtered
            .map(r => ({ r, score: scoreResult(r) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, max)
            .map(({ r }) => ({
              title: r.title || '',
              url: r.url || '',
              snippet: r.content || r.snippet || '',
              publishedDate: r.publishedDate || r.published_date || '',
              engines: r.engines || [],
            }));
          resolve(sorted);
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
    parameters:{ type:'object', properties:{ query:{type:'string'}, reason:{type:'string'} }, required:['query','reason'] }}},
  { type:'function', function:{ name:'fetch_wiki', description:'社内Wiki/ファイルサーバーからファイルを読み取る（読み取り専用）',
    parameters:{ type:'object', properties:{ path:{type:'string',description:'Wiki内のファイルパス'} }, required:['path'] }}}
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
    case 'fetch_wiki': {
      if(!cfg.wikiEnabled||!cfg.wikiUrl) return{error:'Wikiサーバー未設定'};
      try{
        const wikiPath = (args.path||'').replace(/^\/+/,'');
        const url = cfg.wikiUrl.replace(/\/+$/,'') + '/' + wikiPath;
        const headers = {};
        if(cfg.wikiUser && cfg.wikiPass) headers['Authorization'] = 'Basic ' + Buffer.from(`${cfg.wikiUser}:${cfg.wikiPass}`).toString('base64');
        const proto = url.startsWith('https') ? https : http;
        const parsed = new URL(url);
        const content = await new Promise((resolve,reject)=>{
          const req = proto.request({hostname:parsed.hostname,port:parsed.port||(parsed.protocol==='https:'?443:80),path:parsed.pathname+parsed.search,method:'GET',timeout:15000,headers:{...headers,'User-Agent':'PineChat/1.0'}},res=>{
            let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve(raw.slice(0,50000)));
          });
          req.on('error',e=>reject(e));req.on('timeout',()=>{req.destroy();reject(new Error('timeout'));});req.end();
        });
        return{content,path:wikiPath,readOnly:true};
      }catch(e){return{error:`Wiki取得失敗: ${e.message}`};}
    }
    default: return{error:`不明:${name}`};
  }
}

// 設計用AI設定取得
function getDesignAI(){
  return {
    type: cfg.designAiType||'local',
    host: cfg.designAiHost || cfg.chatAiHost || cfg.aiHost || 'localhost',
    port: cfg.designAiPort || cfg.chatAiPort || cfg.aiPort || 1234,
    model: cfg.designModelId || cfg.chatModelId || MODEL_ID,
    apiKey: cfg.designApiKey || '',
  };
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
  const lang = cfg.aiResponseLanguage || 'ja';
  const isJa = lang === 'ja';
  const langRule = isJa ? '日本語で説明・コメントを記述してください。' : 'Write explanations and comments in English.';
  return `${isJa?'あなたはアプリ開発専門AIエージェントです。':'You are an app development AI agent.'}
${isJa?'ユーザーから提供された設計図（.mdファイル）に記載されたアプリケーションを実際に開発します。':'Develop the application described in the provided design document (.md).'}${langNote}
${langRule}

【最重要】設計図は「あなたが作るべきアプリ」の仕様書です。設計図そのものを作成するのではなく、設計図に書かれたアプリのソースコードをファイルとして作成してください。

【絶対に守るルール — セクション・タスク階層構造】
1. 最初の返答で「=== セクションリスト ===」として全セクションとその中のタスクを列挙する
   例:
   セクション1: プロジェクト初期化 (3タスク)
     1.1 package.json作成
     1.2 依存パッケージ設定
     1.3 ディレクトリ構造作成
   セクション2: データモデル (4タスク)
     2.1 ...

2. セクション開始時に「<<< セクション N/合計: [セクション名] >>>」を出力する
3. タスク開始時に「--- タスク S.T/S.合計: [タスク名] ---」を出力する（S=セクション番号、T=タスク番号）
4. タスク完了時に「[完] タスク S.T 完了」を出力する
5. セクション内の全タスク完了時に「[完] セクション N 完了 (N/合計)」を出力する
6. 全セクション完了時に「=== 開発完了 ===」を出力する
7. エラーが発生したらweb_searchツールで解決策を調べて修正する（あきらめない）
8. ファイルは作業フォルダ内に作成する。sudo・パッケージインストール系コマンドは実行しない
9. 途中で止まらず最後まで実行する。ユーザーへの確認は最小限にする
10. 問題が発生しても自力で解決して続行する

現在時刻: ${new Date().toLocaleString('ja-JP')}
作業フォルダ: ${workDir||os.homedir()}${custom}`;
}
function buildChatSysPrompt(workDir, customSys) {
  const custom=customSys?`\n\n【プロジェクト指示】\n${customSys}`:'';
  const lang = cfg.aiResponseLanguage || 'ja';
  const isJa = lang === 'ja';
  const langRule = isJa ? '必ず日本語で回答してください。' : 'Always respond in English.';
  return `${isJa?'あなたは有能なAIアシスタントです。':'You are a helpful AI assistant.'}
${langRule}

${isJa?'【ツール使用ルール】':'【Tool Usage Rules】'}
${isJa?`- 通常の会話、挨拶、質問への回答にはツールを使わないでください
- ツールはユーザーが明示的にファイル操作、コード実行、Web検索を依頼した場合のみ使用してください
- 「調べて」「検索して」「ファイルを読んで」「実行して」等の指示がある場合のみツールを使用
- 雑談や知識に基づく質問にはツールなしで直接回答してください
- 社内Wikiの情報が必要な場合はfetch_wikiツールを使用してください
- 書類作成を依頼された場合はwrite_fileツールで作業フォルダにファイルを作成してください（.md/.txt/.docx等）`
:`- Do NOT use tools for casual conversation, greetings, or knowledge-based questions
- Only use tools when user explicitly requests file operations, code execution, or web search
- Respond directly without tools for chat, advice, and general questions
- Use fetch_wiki tool when internal wiki information is needed
- Use write_file tool when asked to create documents`}

${isJa?'制約':'Constraints'}: sudo${isJa?'・インストール系コマンドは不可':'and install commands are prohibited'}.
${isJa?'現在時刻':'Time'}: ${new Date().toLocaleString(isJa?'ja-JP':'en-US')}
${isJa?'作業フォルダ':'Folder'}: ${workDir||os.homedir()}${custom}`;
}
// 設計分析専用システムプロンプト（analysisモード）
function buildAnalysisSysPrompt(workDir, customSys) {
  const custom=customSys?`\n\n【プロジェクト指示】\n${customSys}`:'';
  const lang = cfg.aiResponseLanguage || 'ja';
  const isJa = lang === 'ja';
  const langRule = isJa ? '必ず日本語のみで回答してください。英語は使用禁止です。' : 'Always respond in English only.';
  return `${isJa?'あなたはアプリケーション設計の専門家AIです。提供された設計図・要件を分析し、詳細な開発計画を作成してください。':'You are an expert application design AI. Analyze the provided design document and create a detailed development plan.'}
${langRule}

${isJa?'【重要】必ず以下の形式で回答してください：':'【Important】Respond in this format:'}
1. ${isJa?'アプリ概要（2-3文）':'App overview (2-3 sentences)'}
2. ${isJa?'主要機能一覧':'Key features list'}
3. ${isJa?'開発タスクリスト（番号付き、具体的に）':'Development tasks (numbered, specific)'}
4. ${isJa?'技術スタック':'Tech stack'}
5. ${isJa?'ファイル構造':'File structure'}

${isJa?'現在時刻':'Time'}: ${new Date().toLocaleString(isJa?'ja-JP':'en-US')}
${isJa?'作業フォルダ':'Folder'}: ${workDir||os.homedir()}${custom}`;
}
function buildDebugSysPrompt(workDir, customSys) {
  const custom=customSys?`\n\n【プロジェクト指示】\n${customSys}`:'';
  const lang = cfg.aiResponseLanguage || 'ja';
  const isJa = lang === 'ja';
  return `${isJa?'あなたはデバッグ・機能追加の専門AIエージェントです。既存コードを分析し、バグ修正・テスト・機能追加を行います。':'You are a debug/feature AI agent. Analyze existing code, fix bugs, run tests, and add features.'}
${isJa?'必ず日本語で回答してください。':'Always respond in English.'}
${isJa?'現在時刻':'Time'}: ${new Date().toLocaleString(isJa?'ja-JP':'en-US')}
${isJa?'作業フォルダ':'Folder'}: ${workDir||os.homedir()}${custom}`;
}
function buildDocumentSysPrompt(workDir, customSys) {
  const custom=customSys?`\n\n【プロジェクト指示】\n${customSys}`:'';
  const lang = cfg.aiResponseLanguage || 'ja';
  const isJa = lang === 'ja';
  const author = cfg.docAuthor || '';
  const dept = cfg.docDepartment || '';
  const org = cfg.docOrganization || '';
  const authorInfo = [org, dept, author].filter(Boolean).join(' / ');
  const caps = isJa
    ? `- アップロードされたファイル（PDF, テキスト, Word等）を読み込んで内容を理解する
- 議事録、報告書、提案書、アイデア書などの.md/.txt書類を作成する
- 行政書類や社内フォーマットに情報を埋め込んで作成する
- 社内Wiki/サーバーからフォーマットや書き方のマニュアルを取得する（fetch_wikiツール）
- Web検索で公的機関の書類フォーマットや書き方を調べる（web_searchツール）
- 今後の運びや次のアクションの提案を行う`
    : `- Read uploaded files (PDF, text, Word, etc.)
- Create meeting minutes, reports, proposals in .md/.txt
- Fill in government/corporate document templates
- Fetch formats from internal wiki (fetch_wiki tool)
- Search for official document formats (web_search tool)
- Propose next steps and action items`;
  const rules = isJa
    ? `- 書類にはwrite_fileツールで作業フォルダに保存すること
- 日付は自動で本日の日付を記入する
- 公的書類の場合は必ずweb_searchで正しい書式を確認してから作成する
- 社内書類の場合はfetch_wikiでマニュアルを確認できる場合は確認する
- ファイルをアップロードされた場合はread_fileで読み込んで内容を確認する
- フォーマットが指定された場合はそのフォーマットに文字を追記する形で作成する（フォーマットを壊さない）
- 出力ファイル名は内容がわかる名前にする（例: 議事録_20260319.md）`
    : `- Save documents with write_file to work folder
- Auto-fill today\'s date
- For official docs, search for correct format first
- For internal docs, check wiki for manual if available
- Read uploaded files with read_file
- When filling templates, append text without breaking format
- Use descriptive filenames`;
  const title = isJa ? 'あなたは書類作成の専門AIアシスタントです。' : 'You are a professional document creation AI assistant.';
  const langRule = isJa ? '必ず日本語で回答・書類を作成してください。' : 'Always respond and create documents in English.';
  const capsLabel = isJa ? '【できること】' : '【Capabilities】';
  const rulesLabel = isJa ? '【書類作成ルール】' : '【Document Rules】';
  const authorLabel = authorInfo ? (isJa ? `\n【デフォルト作成者情報】\n${authorInfo}` : `\n【Default Author】\n${authorInfo}`) : '';
  const timeLabel = isJa ? '現在日時' : 'Date/Time';
  const folderLabel = isJa ? '作業フォルダ' : 'Folder';
  return `${title}\n${langRule}\n\n${capsLabel}\n${caps}\n\n${rulesLabel}\n${rules}${authorLabel}\n\n${timeLabel}: ${new Date().toLocaleString(isJa?'ja-JP':'en-US')}\n${folderLabel}: ${workDir||os.homedir()}${custom}`;
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
  // 設計用外部AI対応
  const dAI = getDesignAI();
  const useExternalDesignAI = dAI.type !== 'local' && dAI.apiKey;
  const getHost = () => useExternalDesignAI ? (dAI.host||'localhost') : (cfg.chatAiHost || cfg.aiHost || '127.0.0.1');
  const getPort = () => useExternalDesignAI ? (dAI.port||443) : (cfg.chatAiPort || cfg.aiPort);
  const getModel = () => useExternalDesignAI ? (dAI.model||'') : (cfg.chatModelId || MODEL_ID);

  // モデル確認
  if (!getModel()) { await detectModel(); }
  if (!getModel()) {
    onEvent({ type:'text', data:'× AIに接続できません。設定を確認してください。' });
    logWrite(sessId, 'ERROR', 'モデル未検出'); return;
  }

  const ac = new AbortController();
  abortMap.set(sessId, ac);
  const devMode = sysPrompt.includes('タスクリスト') || sysPrompt.includes('ソースコード');
  const msgs = [{ role:'system', content:sysPrompt }, ...messages];
  let loopCount = 0, sameCount = 0, lastContent = '';
  let consecutiveErrors = 0;
  let noToolTurns = 0; // ツール呼び出しなしのターン数（ストール検出）

  // ★ コンテキスト制御: msgs配列が大きくなりすぎないよう制御
  function trimContext() {
    let totalChars = 0;
    for(const m of msgs) totalChars += (m.content||'').length + JSON.stringify(m.tool_calls||'').length;
    // Stage 1: 40,000文字超 → 古いtool結果を短縮（早期圧縮）
    if(totalChars > 40000){
      for(let i = 1; i < msgs.length - 8; i++){
        if(msgs[i].role === 'tool' && msgs[i].content && msgs[i].content.length > 300){
          try {
            const parsed = JSON.parse(msgs[i].content);
            if(parsed.stdout) parsed.stdout = parsed.stdout.slice(0, 150) + '...[trimmed]';
            if(parsed.content) parsed.content = parsed.content.slice(0, 150) + '...[trimmed]';
            if(parsed.items) parsed.items = parsed.items.slice(0, 10);
            msgs[i].content = JSON.stringify(parsed);
          } catch { msgs[i].content = msgs[i].content.slice(0, 200) + '...[trimmed]'; }
        }
      }
    }
    // Stage 2: 60,000文字超 → assistant応答も短縮
    totalChars = 0;
    for(const m of msgs) totalChars += (m.content||'').length;
    if(totalChars > 60000){
      logWrite(sessId, 'INFO', 'コンテキスト圧縮Stage2: ' + totalChars + '文字');
      for(let i = 1; i < msgs.length - 6; i++){
        if(msgs[i].role === 'assistant' && msgs[i].content && msgs[i].content.length > 800){
          msgs[i].content = msgs[i].content.slice(0, 400) + '\n...[以降省略]';
        }
      }
    }
    // Stage 3: 80,000文字超 → 古いメッセージを削除して要約挿入
    totalChars = 0;
    for(const m of msgs) totalChars += (m.content||'').length;
    if(totalChars > 80000 && msgs.length > 15) {
      const keep = Math.max(10, Math.floor(msgs.length * 0.3));
      const removed = msgs.splice(1, msgs.length - keep - 1);
      logWrite(sessId, 'INFO', '古いメッセージ' + removed.length + '件を削除(Stage3)');
      msgs.splice(1, 0, {role:'user', content:'[前のやり取りは省略されました。現在のタスクを続行してください。作業フォルダ内のファイルを確認して続きから進めてください。]'});
    }
  }


  for (let turn = 0; turn < 150; turn++) {
    if (ac.signal.aborted) { onEvent({ type:'text', data:'\n■ 停止しました。' }); break; }

    trimContext(); // ★ 毎ターンのコンテキスト制御
    // ほったらかしモードは毎ターン最新を読む（ON/OFF切替に即対応）
    const isHandsOff = cfg.handsOff;

    let data;
    try {
      logWrite(sessId, 'INFO', `Turn${turn+1} handsOff=${isHandsOff} extAI=${useExternalDesignAI}`);
      const body = {model:getModel(), messages:msgs, tools:TOOLS, tool_choice:'auto', temperature:0.6, max_tokens:4096, stream:false};
      if(useExternalDesignAI){
        const headers = {'Authorization':`Bearer ${dAI.apiKey}`};
        data = await httpsPost(getHost(), getPort(), '/v1/chat/completions', body, cfg.timeout*1000, headers);
      } else {
        data = await httpPost(getHost(), getPort(), '/v1/chat/completions', body);
      }
      consecutiveErrors = 0; // 成功時リセット
      retryCountMap.delete(sessId);
    } catch(e) {
      logWrite(sessId, 'ERROR', `APIエラー:${e.message}`);
      if (ac.signal.aborted) { onEvent({ type:'text', data:'\n■ 停止' }); break; }

      consecutiveErrors++;
      const retries = (retryCountMap.get(sessId) || 0) + 1;
      retryCountMap.set(sessId, retries);

      // 問題①②⑤: handsOffに関わらず最大5回まで自動リトライ
      if (retries <= 5) {
        const wait = Math.min(retries * 15, 60); // 15s, 30s, 45s, 60s, 60s
        onEvent({ type:'system', data:`⚠ 通信エラー (${e.message.slice(0,60)}) — ${retries}/5回目 ${wait}秒後に自動再試行...` });
        await new Promise(r => setTimeout(r, wait * 1000));
        if (ac.signal.aborted) { onEvent({ type:'text', data:'\n■ 停止' }); break; }
        // モデルを再検出してリトライ
        await detectModel();
        if (!MODEL_ID) {
          onEvent({ type:'system', data:`⚠ AI再接続を試みています...` });
          await new Promise(r => setTimeout(r, 10000));
        }
        onEvent({ type:'system', data:`↺ 再試行中 (${retries}/5)...` });
        continue;
      }
      // 5回失敗: タイムアウトイベントでUI側に通知（自動再起動を促す）
      onEvent({ type:'text', data:`
× 通信エラー: ${e.message}` });
      onEvent({ type:'timeout', data: e.message });
      break;
    }

    const msg = data.choices?.[0]?.message;
    // 空の応答リトライ（問題③）
    if (!msg || (!msg.content && !msg.tool_calls?.length)) {
      const emptyRetry = (msgs['_emptyRetry'] || 0) + 1;
      msgs['_emptyRetry'] = emptyRetry;
      if (emptyRetry <= 3) {
        logWrite(sessId, 'WARN', `空の応答 - リトライ ${emptyRetry}/3`);
        onEvent({ type:'system', data:`⚠ 応答が空でした。再試行中 (${emptyRetry}/3)...` });
        await new Promise(r => setTimeout(r, 5000));
        if (ac.signal.aborted) { onEvent({ type:'text', data:'\n■ 停止' }); break; }
        continue;
      }
      onEvent({ type:'text', data:'× AIからの応答が空です。モデルを確認してください。' });
      onEvent({ type:'timeout', data: '空の応答' });
      break;
    }
    msgs['_emptyRetry'] = 0;
    msgs.push(msg);

    if (msg.content) {
      logWrite(sessId, 'AI', msg.content.slice(0, 200));
      onEvent({ type:'text', data: msg.content });

      if (devMode) {
        // セクションリスト検出
        if (!msgs._sectionsSet) {
          if (/===\s*セクションリスト\s*===|セクション\d+[:：]/.test(msg.content)) {
            const secMatches = msg.content.match(/セクション\s*(\d+)/g);
            if (secMatches && secMatches.length >= 2) {
              msgs._sectionsSet = true;
              onEvent({ type:'progress', data:`${secMatches.length}セクションの開発計画を確認` });
            }
          }
          // 旧形式のフラットタスクリストにも対応
          const listMatch = msg.content.match(/(?:^|\n)\s*(\d+)[.\s．]/gm);
          if (!msgs._sectionsSet && listMatch && listMatch.length >= 2) {
            msgs._sectionsSet = true;
            onEvent({ type:'progress', data:`タスクリスト: ${listMatch.length}件のタスクを確認` });
          }
        }
        // セクション開始検出: <<< セクション N/Total: Name >>>
        const secStart = msg.content.match(/<<<\s*セクション\s*(\d+)\s*[/／]\s*(\d+)\s*[:：]\s*(.+?)\s*>>>/);
        if (secStart) {
          onEvent({type:'section_start', data:{n:parseInt(secStart[1]), total:parseInt(secStart[2]), name:secStart[3].trim()}});
        }
        // セクション完了検出: [完] セクション N 完了
        const secDone = msg.content.match(/\[完\]\s*セクション\s*(\d+)\s*完了.*?(\d+)\s*[/／]\s*(\d+)/);
        if (secDone) {
          onEvent({type:'section_done', data:{n:parseInt(secDone[1]), total:parseInt(secDone[3]||secDone[2]||0)}});
        }
        // タスク開始検出: --- タスク S.T/S.Total: Name --- (階層) or --- タスクN/合計: Name --- (フラット)
        const hierTaskStart = msg.content.match(/---\s*タスク\s*(\d+)\.(\d+)\s*[/／]\s*\d+\.\d+\s*[:：]\s*(.+?)\s*---/);
        if (hierTaskStart) {
          onEvent({type:'task_start', data:{sec:parseInt(hierTaskStart[1]), n:parseInt(hierTaskStart[2]), name:hierTaskStart[3].trim()}});
        } else {
          // フラットタスク形式にもフォールバック
          const flatPatterns = [
            /---\s*タスク\s*(\d+)\s*[/／]\s*(\d+)\s*[:：\s]+(.+?)\s*---/,
            /タスク\s*(\d+)\s*[/／]\s*(\d+)\s*[:：]\s*(.+)/
          ];
          for(const p of flatPatterns){
            const sm = msg.content.match(p);
            if(sm){ onEvent({type:'task_start',data:{n:parseInt(sm[1]),total:parseInt(sm[2]),name:sm[3].trim()}}); break; }
          }
        }
        // タスク完了検出: [完] タスク S.T 完了 (階層) or [完] タスクN 完了 (フラット)
        const hierTaskDone = msg.content.match(/\[完\]\s*タスク\s*(\d+)\.(\d+)\s*完了/);
        if (hierTaskDone) {
          onEvent({type:'task_done', data:{sec:parseInt(hierTaskDone[1]), n:parseInt(hierTaskDone[2])}});
        } else {
          const flatDone = msg.content.match(/\[完\]\s*タスク\s*(\d+)\s*完了/);
          if(flatDone) onEvent({type:'task_done', data:{n:parseInt(flatDone[1])}});
        }
        // 開発完了検出（厳格）
        if (/===\s*(開発完了|デバッグ完了)\s*===/.test(msg.content)) {
          onEvent({ type:'dev_complete', data:'' });
        }
      }

      // ループ検知
      if (msg.content === lastContent) { sameCount++; } else { sameCount = 0; lastContent = msg.content; }
      if (detectLoop(msgs)) loopCount++;

      if (sameCount >= 3 || loopCount >= 2) {
        const br = await handsOffBreakLoop(sessId, msgs, workDir, onEvent);
        sameCount = 0; loopCount = 0;
        if (br.resolved && br.suggestion) {
          msgs.push({ role:'user', content:`【ループ打開指示】\n${br.suggestion}\n\n別のアプローチで続行してください。` });
        } else {
          if (!isHandsOff) {
            onEvent({ type:'user_input_required', data:'× 別の指示を入力するか「スキップ」と入力してください。' });
            break;
          } else {
            msgs.push({ role:'user', content:'このステップをスキップして次のタスクに進んでください。' });
            onEvent({ type:'system', data:'𓅭 ループを検知したためスキップして続行します。' });
          }
        }
        continue;
      }
    }

    if (!msg.tool_calls?.length) {
      // dev_complete済みなら即終了（noToolTurns自動継続を発火させない）
      const isDone = /===\s*(開発完了|デバッグ完了)\s*===/.test(msg.content||'');
      if(isDone) break;
      // devMode: 開発完了でなければ自動継続（ストール防止）
      if(devMode){
        noToolTurns++;
        if(noToolTurns <= 3){
          onEvent({type:'system',data:'↺ 次のタスクに進みます...'});
          msgs.push({role:'user',content:'続けてください。次のタスクを実行してください。'});
          continue;
        }
        onEvent({type:'system',data:'⚠ AIが停滞しています。再開ファイルを保存します。'});
        onEvent({type:'timeout',data:'ストール検出'});
      }
      break;
    }
    noToolTurns = 0; // ツール呼び出しがあったらリセット
    for (const tc of msg.tool_calls) {
      if (ac.signal.aborted) break;
      let args = {}; try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      onEvent({ type:'tool', data:{ id:tc.id, name:tc.function?.name||'', args } });
      const result = await runTool(tc.function?.name||'', args, workDir, sessId).catch(e => ({ error: e.message }));
      msgs.push({ role:'tool', tool_call_id:tc.id, content:JSON.stringify(result) });
    }
  }

  abortMap.delete(sessId);
  retryCountMap.delete(sessId);
  deleteOldLogs();
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
let watcherCallback=null,watcherTimers={},watcherRunState={discord:false,telegram:false,calendar:false},watcherCommand='stop';
let watcherUserBusy=false,watcherSkippedCount=0;
let watcherWatchdogTimer=null;

// エージェントチャット履歴永続化
const AGENT_HISTORY_FILE=path.join(DATA_DIR,'agent_chat.json');
function loadAgentHistory(){try{return JSON.parse(fs.readFileSync(AGENT_HISTORY_FILE,'utf-8'));}catch{return[];}}
function saveAgentHistory(h){try{fs.writeFileSync(AGENT_HISTORY_FILE,JSON.stringify(h.slice(-200),null,2));}catch{}}
function clearAgentHistory(){try{if(fs.existsSync(AGENT_HISTORY_FILE))fs.unlinkSync(AGENT_HISTORY_FILE);}catch{}return[];}

function setWatcherCallback(cb){watcherCallback=cb;}
function watcherEmit(type,data){if(watcherCallback){try{watcherCallback({type,data});}catch{}}}
function isWatcherRunning(){return watcherRunState.discord||watcherRunState.telegram||watcherRunState.calendar;}
function getWatcherNextTime(){return null;}

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

function startWatcher(){
  const wcfg=getWatcherCfg();watcherCommand='schedule';stopWatcher();
  if(wcfg.discordEnabled&&wcfg.discordToken){watcherRunState.discord=true;discordPollTick(wcfg).catch(()=>{});watcherTimers.discord=setInterval(()=>{if(watcherCommand==='stop')return;discordPollTick(getWatcherCfg()).catch(()=>{});},30000);}
  if(wcfg.telegramEnabled&&wcfg.telegramToken){watcherRunState.telegram=true;telegramPollTick(wcfg).catch(()=>{});watcherTimers.telegram=setInterval(()=>{if(watcherCommand==='stop')return;telegramPollTick(getWatcherCfg()).catch(()=>{});},30000);}
  if(wcfg.calendarEnabled){watcherRunState.calendar=true;calendarTick(wcfg).catch(()=>{});watcherTimers.calendar=setInterval(()=>{if(watcherCommand==='stop')return;calendarTick(getWatcherCfg()).catch(()=>{});},600000);}
  watcherWatchdogTimer=setInterval(()=>{
    if(watcherCommand==='stop')return;const wc=getWatcherCfg();
    if(wc.discordEnabled&&wc.discordToken&&!watcherTimers.discord){watcherRunState.discord=true;watcherTimers.discord=setInterval(()=>{if(watcherCommand!=='stop')discordPollTick(getWatcherCfg()).catch(()=>{});},30000);}
    if(wc.telegramEnabled&&wc.telegramToken&&!watcherTimers.telegram){watcherRunState.telegram=true;watcherTimers.telegram=setInterval(()=>{if(watcherCommand!=='stop')telegramPollTick(getWatcherCfg()).catch(()=>{});},30000);}
  },60000);
  logWrite('watcher','INFO','startWatcher');
}
function stopWatcher(){Object.values(watcherTimers).forEach(t=>{if(t)clearInterval(t);});watcherTimers={};watcherRunState={discord:false,telegram:false,calendar:false};watcherCommand='stop';if(watcherWatchdogTimer){clearInterval(watcherWatchdogTimer);watcherWatchdogTimer=null;}logWrite('watcher','INFO','stopWatcher');}
// SearXNG関連はエージェントから削除済み - スタブのみ残す(IPC互換)
function stopSearxOnly(){}
function startSearxOnly(){}
function isSearxRunning(){return false;}
async function runWatcherNow(){
  const wcfg=getWatcherCfg();watcherEmit('watcher_status','今すぐ実行中...');
  const proms=[];
  if(wcfg.discordEnabled&&wcfg.discordToken)proms.push(discordPollTick(wcfg));
  if(wcfg.telegramEnabled&&wcfg.telegramToken)proms.push(telegramPollTick(wcfg));
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

// ── 内部ファイルコピー（RAG/設計図を~/.pinechat/files/に保存）──
function copyFileInternal(srcPath, projId) {
  if(!srcPath || !fs.existsSync(srcPath)) return null;
  const projDir = path.join(FILES_DIR, projId);
  if(!fs.existsSync(projDir)) fs.mkdirSync(projDir, {recursive:true});
  const destPath = path.join(projDir, path.basename(srcPath));
  try { fs.copyFileSync(srcPath, destPath); return destPath; } catch(e) { logWrite('file','ERROR',`copy: ${e.message}`); return null; }
}
function getInternalFilePath(projId, fileName) {
  return path.join(FILES_DIR, projId, fileName);
}

module.exports = {
  getCfg, updateCfg, detectModel, detectModelsAt, detectChatModels, detectWatcherModels, searxSearch,
  runAgent, stopAgent, isAborted,
  saveResumeFile, loadResumeFile, deleteResumeFile,
  makeDevSysPrompt, buildChatSysPrompt, buildAnalysisSysPrompt, buildDebugSysPrompt, buildAgentChatSysPrompt,
  buildBlueprintSysPrompt, buildBlueprintGenerateSysPrompt, buildDocumentSysPrompt, runBlueprintChat, getBlueprintAI, detectBlueprintModels, getDesignAI,
  getSession, loadIndex, saveIndex, loadProj, saveProj, projPath,
  getLogs, logWrite, deleteOldLogs,
  getWatcherCfg, saveWatcherCfg, getAgentAI,
  startWatcher, stopWatcher, stopSearxOnly, startSearxOnly, isSearxRunning,
  isWatcherRunning, runWatcherNow, getWatcherNextTime,
  setWatcherCallback, runAgentChat, saveAgentFeedToHistory,
  loadAgentHistory, saveAgentHistory, clearAgentHistory,
  fetchDiscordMessages, fetchTelegramMessages,
  fetchGoogleCalendarEvents, fetchICloudCalendarEvents,
  copyFileInternal, getInternalFilePath, FILES_DIR,
};

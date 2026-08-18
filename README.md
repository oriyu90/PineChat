# Pine Chat

自立思考型AIエージェント — ローカルLLM(LM Studio等)と繋いで使う、macOS向けのElectron製AIチャット/開発エージェントアプリです。

こんにちは、折田です。
ローカルLLMについて知るにはそこそこ使えるアプリだと思い、v1.0.0としてオープンソース公開しました。

## 特徴

- LM Studio(またはOpenAI互換API)にポート`1234`で自動接続してチャットできます
- SearXNGと連携したWeb検索に対応しています(Macでバックグラウンド自動起動も可能)
- 「アプリ設計」機能: 設計図(.md)さえあれば、ほったらかしモードでビルド直前までアプリを自動生成します
- `.md`形式のファイルをRAG(辞書)として読み込めます
- エージェント機能(Discord/Telegram/カレンダー連携)も備えています

推奨モデルサイズは20Bクラス以上です(アプリ開発を任せる場合の目安)。

## 必要環境

- macOS 14.0 以降
- Node.js / npm
- ローカルLLMサーバー(例: [LM Studio](https://lmstudio.ai/))

## セットアップ

```bash
npm install
npm start
```

## ビルド(.dmg)

```bash
./build.sh
```

## ライセンス

このプロジェクトは [GNU General Public License v3.0 (or later)](LICENSE) の下で公開されています。

Copyright (C) 2026 Yuki_Orita

## リンク

- 開発者: Yuki_Orita(折田悠希 / おりたゆうき)
- 開発者公式サイト: https://oriyu90.github.io/official/
- X: https://x.com/InovateofRIZI
- Discord(バグ報告・告知): https://discord.gg/x7KXhNTD8M

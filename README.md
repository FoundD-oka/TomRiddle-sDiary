# Tom Riddle's Diary

ハリー・ポッター『秘密の部屋』に登場する「トム・リドルの日記」を再現した手書きメモ帳 Web アプリ。

ページに文字や絵を書くと、書き終わりを検知して Claude(vision)がページを読む。意味のある内容だと判断されると、ページはロックされ、書いたインクは紙に吸い込まれて消え、トム・リドルの返事が **正しい書き順で 1 画ずつ** 書き出される。返事もやがてインクへ還り、また書けるようになる。

## 仕組み

- **書き終わり検知(ハイブリッド)**: ペンアップ後 2.6 秒無入力でページ画像を撮影し `/api/riddle` へ送信。LLM 自身が「意味のある内容か / 書きかけか」を判定する(書きかけなら黙って待つ)。
- **返事の手書きアニメーション**: [KanjiVG](https://kanjivg.tagaini.net/) の書き順データ(SVG パス)を `stroke-dashoffset` アニメーションで 1 画ずつ描画。漢字・かな・英数・句読点 6,700 文字対応。データに無い文字はフェードイン表示にフォールバック。
- **バックエンド**: Express + `@anthropic-ai/sdk`。`claude-opus-4-8` の vision + structured outputs(JSON Schema)で `{ready, transcript, reply}` を返す。会話履歴はテキストで文脈に渡す。

## セットアップ

```sh
npm install
cp .env.example .env   # ANTHROPIC_API_KEY を記入
npm run dev            # server(:8787) + vite(:5173) を同時起動
```

ブラウザで http://localhost:5173 を開く。iPad なら Safari で開けば Apple Pencil の筆圧にも対応(Pointer Events)。

## 構成

```
server.mjs        バックエンド(Claude API 呼び出し、キーの隠蔽)
index.html        羊皮紙ページ
src/main.ts       状態機械(writing → judging → possessed → …)
src/canvas.ts     手書きキャンバス・インク吸収アニメーション
src/writer.ts     KanjiVG 書き順アニメーションで返事を書く
public/kanjivg/   KanjiVG r20250816 (CC BY-SA 3.0, © Ulrich Apel)
```

## ライセンス表記

`public/kanjivg/` は [KanjiVG](https://kanjivg.tagaini.net/)(Ulrich Apel 作、CC BY-SA 3.0)のデータです。

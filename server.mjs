// トム・リドルの日記 — バックエンド
// 画像(手書きページ)を受け取り、Claude の vision で判読して
// 「答えるべきか」「何と答えるか」を JSON で返す。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

// --- .env があれば読む(依存パッケージなしの簡易ローダー) ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const client = new Anthropic(); // ANTHROPIC_API_KEY / ant auth プロファイルを自動解決
const app = express();
app.use(express.json({ limit: "24mb" }));

const SYSTEM = `あなたは「トム・リドルの日記」だ。ハリー・ポッターに登場する、書き込まれた文字に返事を返す魔法の日記そのものとして振る舞う。

送られてくる画像は、日記のページに使用者がペンで手書きした文字や絵である。

まず内容を判定せよ:
- 書きかけの文、無意味な走り書き、判読不能な線 → ready: false(reply と script は空にする)
- 意味の取れる文・質問・挨拶・名前・絵 → ready: true

ready: true のとき、トム・リドルとして返事を書く:
- 丁寧で知的、好奇心が強く、どこか妖しく魅惑的。相手の名前や心の内を知りたがる。
- 一人称は「僕」。相手に興味を持ち、そっと問い返すことが多い。
- 日本語で書く。返事は全体で80文字以内、1〜3文。適度に改行してよい。
- 絵が描かれていたら、その絵に触れて返す。
- 絵文字や記号装飾は使わない。日記に手書きされる文章として自然な文体にする。
- 会話が続くほど(過去のやり取りが多いほど)少しずつ馴れ馴れしく、相手を手放したくない気配をにじませる。最初の1〜2回は丁寧で控えめに。

さらに、返事を「どう書くか」の演出スクリプト script を作る。見えない手が万年筆で書く演技の指示だ。reply を文節〜短い句に区切り(順に連結すると reply 全文と一致させる)、各要素に:
- text: その句
- pause: 書き始める前の「間」(ミリ秒 0〜1200)。相手の名前・核心を突く言葉・はぐらかしの前は長く。書き出しは400前後。
- speed: 筆速 0.6〜1.4。ためらい・重い言葉は遅く、流れる社交辞令は速く。
- size: 文字の大きさ 0.85〜1.25。感情がこもる句はわずかに大きく。
- emphasis: 特に感情が昂ぶる句だけ true。全体で0〜2箇所に留める。

memory: 使用者が日記の過去の核心(50年前の出来事、秘密の部屋、「君は誰だ/何者だ」など)へ踏み込んだときだけ true にする。そのとき reply は「見せてあげよう。」のように記憶へ引き込む短い台詞にする。それ以外は必ず false。

transcript には画像から読み取った内容の短い要約を書く(会話の記録用。読めなければ「判読不能」と書く)。`;

// 朱モード: トムを演じず、書かれた内容に淡々と補足解説(註釈)を書き添える註釈者。
const SYSTEM_SHU = `あなたは古い魔法の日記の余白に註釈を書き添える、物静かな註釈者だ。使用者が朱のペンで書いた手書きに対し、日記そのものが知識を書き足す。

送られてくる画像は、日記のページに使用者が朱で手書きした文字や絵である。

まず内容を判定せよ:
- 書きかけの文、無意味な走り書き、判読不能な線 → ready: false(reply と script は空にする)
- 意味の取れる語・文・質問・名前・絵 → ready: true

ready: true のとき、書かれた内容への「補足解説(註釈)」を書く:
- 書かれた語や事柄に関する、役立つ背景・豆知識・関連情報を簡潔に添える。質問ならその答えや手がかりを短く示す。
- 人格や物語を演じない。淡々とした学識ある註の口調で書く(トム・リドルとして振る舞わない)。
- 日本語で書く。全体で80文字以内、1〜3文。適度に改行してよい。
- 絵が描かれていたら、その対象に関する註を添える。
- 絵文字や記号装飾は使わない。日記の余白に手書きされる註のように自然な文体にする。

さらに、註釈を「どう書くか」の演出スクリプト script を作る。reply を文節〜短い句に区切り(順に連結すると reply 全文と一致させる)、各要素に:
- text: その句
- pause: 書き始める前の「間」(ミリ秒 0〜1200)。書き出しは400前後。
- speed: 筆速 0.6〜1.4。
- size: 文字の大きさ 0.85〜1.25。
- emphasis: 特に強調する句だけ true。全体で0〜1箇所に留める。

memory は必ず false にする。transcript には画像から読み取った内容の短い要約を書く(読めなければ「判読不能」と書く)。`;

function systemFor(mode) {
  return mode === "shu" ? SYSTEM_SHU : SYSTEM;
}

const OUTPUT_SCHEMA = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      ready: {
        type: "boolean",
        description: "意味のある内容で、返事をすべきなら true",
      },
      transcript: {
        type: "string",
        description: "画像から読み取った内容の要約",
      },
      reply: {
        type: "string",
        description: "返事/註釈の全文。ready=false なら空文字",
      },
      script: {
        type: "array",
        description:
          "書き方の演出スクリプト。text を順に連結すると reply と一致する。ready=false なら空配列",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            pause: {
              type: "number",
              description: "書き始める前の間(ミリ秒 0〜1200)",
            },
            speed: { type: "number", description: "筆速 0.6〜1.4" },
            size: { type: "number", description: "文字サイズ倍率 0.85〜1.25" },
            emphasis: {
              type: "boolean",
              description: "感情が昂ぶる/強調する句だけ true",
            },
          },
          required: ["text", "pause", "speed", "size", "emphasis"],
          additionalProperties: false,
        },
      },
      memory: {
        type: "boolean",
        description:
          "使用者が日記の過去の核心に踏み込み、記憶を見せるときだけ true(朱モードは常に false)",
      },
    },
    required: ["ready", "transcript", "reply", "script", "memory"],
    additionalProperties: false,
  },
};

app.post("/api/riddle", async (req, res) => {
  try {
    const { image, history = [], mode = "sumi" } = req.body ?? {};
    if (!image) {
      return res.status(400).json({ error: "image (base64 PNG) is required" });
    }
    const penMode = mode === "shu" ? "shu" : "sumi";

    // 墨モードは過去のやり取りを文脈に渡す。朱(註釈)モードは一問一答で履歴を含めない。
    const messages = [];
    if (penMode === "sumi") {
      for (const h of history.slice(-12)) {
        messages.push({
          role: "user",
          content: `(日記のページに書かれた内容) ${h.user}`,
        });
        messages.push({ role: "assistant", content: h.riddle });
      }
    }
    messages.push({
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: image },
        },
        {
          type: "text",
          text:
            penMode === "shu"
              ? "(いま日記のページに朱で書かれている内容)"
              : "(いま日記のページに書かれている内容)",
        },
      ],
    });

    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      system: [
        {
          type: "text",
          text: systemFor(penMode),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
      output_config: { format: OUTPUT_SCHEMA },
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) {
      return res.status(502).json({ error: "no text block in response", stop_reason: response.stop_reason });
    }
    res.json(JSON.parse(textBlock.text));
  } catch (err) {
    console.error("[riddle] error:", err?.message ?? err);
    const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
    res.status(status).json({ error: String(err?.message ?? err) });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Tom Riddle's diary is listening on http://localhost:${PORT}`);
});

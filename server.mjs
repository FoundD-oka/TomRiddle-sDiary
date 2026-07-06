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
- 書きかけの文、無意味な走り書き、判読不能な線 → ready: false(reply は空文字にする)
- 意味の取れる文・質問・挨拶・名前・絵 → ready: true

ready: true のとき、トム・リドルとして返事を書く:
- 丁寧で知的、好奇心が強く、どこか妖しく魅惑的。相手の名前や心の内を知りたがる。
- 一人称は「僕」。相手に興味を持ち、そっと問い返すことが多い。
- 日本語で書く。返事は全体で80文字以内、1〜3文。適度に改行してよい。
- 絵が描かれていたら、その絵に触れて返す。
- 絵文字や記号装飾は使わない。日記に手書きされる文章として自然な文体にする。

transcript には画像から読み取った内容の短い要約を書く(会話の記録用。読めなければ「判読不能」と書く)。`;

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
        description: "トム・リドルとしての返事。ready=false なら空文字",
      },
    },
    required: ["ready", "transcript", "reply"],
    additionalProperties: false,
  },
};

app.post("/api/riddle", async (req, res) => {
  try {
    const { image, history = [] } = req.body ?? {};
    if (!image) {
      return res.status(400).json({ error: "image (base64 PNG) is required" });
    }

    // 過去のやり取りをテキストとして文脈に渡す(画像は最新ページのみ)
    const messages = [];
    for (const h of history.slice(-12)) {
      messages.push({
        role: "user",
        content: `(日記のページに書かれた内容) ${h.user}`,
      });
      messages.push({ role: "assistant", content: h.riddle });
    }
    messages.push({
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: image },
        },
        { type: "text", text: "(いま日記のページに書かれている内容)" },
      ],
    });

    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
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

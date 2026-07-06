// トム・リドルの日記 — メインの状態機械
//
//   writing ── ペンアップ後 IDLE_MS 無入力 ──▶ judging (画像をLLMへ)
//     ▲                                          │ ready=false → writing に戻る
//     │                                          ▼ ready=true
//   unlock ◀── 返事がにじんで消える ◀── replying(入力ロック→インク吸収→1画ずつ返事)
//
import "./style.css";
import { InkCanvas } from "./canvas";
import { RiddleWriter } from "./writer";

const IDLE_MS = 2600; // ペンが離れてから「書き終わり」とみなすまで
const REPLY_LINGER_MS = 7000; // 返事を読ませる時間

interface Exchange {
  user: string;
  riddle: string;
}

const page = document.getElementById("page")!;
const presence = document.getElementById("presence")!;
const ink = new InkCanvas(document.getElementById("ink") as HTMLCanvasElement);
const writer = new RiddleWriter(document.getElementById("reply-layer")!);

const history: Exchange[] = [];
let idleTimer: number | null = null;
let judging = false; // LLM 判定リクエスト中
let possessed = false; // トムが答えている最中(入力ロック)

function scheduleJudge() {
  cancelJudge();
  idleTimer = window.setTimeout(onIdle, IDLE_MS);
}

function cancelJudge() {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

ink.onStrokeStart = () => cancelJudge();
ink.onStrokeEnd = () => {
  if (!possessed) scheduleJudge();
};

async function onIdle() {
  if (judging || possessed || ink.strokes.length === 0) return;
  judging = true;
  presence.classList.add("active"); // 「誰かが読んでいる」気配

  const strokeCountAtCapture = ink.strokes.length;
  try {
    const res = await fetch("/api/riddle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: ink.capture(), history }),
    });
    if (!res.ok) throw new Error(`server ${res.status}`);
    const result: { ready: boolean; transcript: string; reply: string } =
      await res.json();

    // 判定中にユーザーが書き足していたら、この判定は破棄してやり直す
    if (ink.strokes.length !== strokeCountAtCapture) {
      judging = false;
      presence.classList.remove("active");
      scheduleJudge();
      return;
    }

    if (!result.ready || !result.reply) {
      // まだ書きかけ。黙って待つ
      judging = false;
      presence.classList.remove("active");
      return;
    }

    await possess(result);
  } catch (err) {
    console.error("[diary]", err);
  } finally {
    judging = false;
    presence.classList.remove("active");
  }
}

/** トムがページを乗っ取る: ロック → インク吸収 → 1画ずつ返事 → 返事も消える */
async function possess(result: { transcript: string; reply: string }) {
  possessed = true;
  page.classList.add("locked");
  cancelJudge();

  await new Promise((r) => setTimeout(r, 500)); // 一拍の間
  await ink.fadeOut(); // 書いたものが紙に吸い込まれる
  await new Promise((r) => setTimeout(r, 700));

  await writer.write(result.reply); // 誰かがペンで書いているように

  history.push({ user: result.transcript, riddle: result.reply });
  if (history.length > 12) history.splice(0, history.length - 12);

  await new Promise((r) => setTimeout(r, REPLY_LINGER_MS));
  await writer.fadeOut(); // トムの文字もまたインクへ還る

  page.classList.remove("locked");
  possessed = false;
}

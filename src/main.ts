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
import { PresenceInk } from "./presence";

const IDLE_MS = 4200; // ペンが離れてから「書き終わり」とみなすまで。
// 短すぎると、書いてる途中で少し考えただけで AI 判定が走り、次のストローク開始と
// ぶつかって書き心地が乱れる。メモ.app 的な書き味を優先して長めにとる。
const REPLY_LINGER_MS = 7000; // 返事を読ませる時間

interface Exchange {
  user: string;
  riddle: string;
}

const page = document.getElementById("page")!;
const presence = document.getElementById("presence")!;
const presenceInk = new PresenceInk(
  document.getElementById("presence-ink") as HTMLCanvasElement,
);
const ink = new InkCanvas(document.getElementById("ink") as HTMLCanvasElement);

// 「誰かが読んでいる」気配を出す/消す。流体(渦)が使えればそれを、
// ダメな環境では従来の CSS の点にフォールバックする。
function showPresence() {
  if (presenceInk.available) presenceInk.start();
  else presence.classList.add("active");
}
function hidePresence() {
  if (presenceInk.available) presenceInk.stop();
  else presence.classList.remove("active");
}
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
  // ペンが接地している間は判定を始めない（キャプチャの割り込みで書き味が乱れる）
  if (ink.isDrawing) {
    scheduleJudge();
    return;
  }
  judging = true;
  showPresence(); // 「誰かが読んでいる」気配

  const strokeCountAtCapture = ink.strokes.length;
  const revisionAtCapture = ink.inputRevision;
  try {
    const image = await ink.captureAsync();

    // キャプチャ中にユーザーが書き始めた／書き足したら、この判定は破棄してやり直す
    if (
      ink.isDrawing ||
      ink.inputRevision !== revisionAtCapture ||
      ink.strokes.length !== strokeCountAtCapture
    ) {
      judging = false;
      hidePresence();
      scheduleJudge();
      return;
    }

    const res = await fetch("/api/riddle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, history }),
    });
    if (!res.ok) throw new Error(`server ${res.status}`);
    const result: { ready: boolean; transcript: string; reply: string } =
      await res.json();

    // 判定中にユーザーが書き足していたら、この判定は破棄してやり直す
    if (
      ink.inputRevision !== revisionAtCapture ||
      ink.strokes.length !== strokeCountAtCapture
    ) {
      judging = false;
      hidePresence();
      scheduleJudge();
      return;
    }

    if (!result.ready || !result.reply) {
      // まだ書きかけ。黙って待つ
      judging = false;
      hidePresence();
      return;
    }

    await possess(result);
  } catch (err) {
    console.error("[diary]", err);
  } finally {
    judging = false;
    hidePresence();
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

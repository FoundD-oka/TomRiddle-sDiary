// トム・リドルの日記 — メインの状態機械
//
//   writing ── ペンアップ後 IDLE_MS 無入力 ──▶ judging (画像をLLMへ)
//     ▲                                          │ ready=false → writing に戻る
//     │                                          ▼ ready=true
//   unlock ◀── 返事がにじんで消える ◀── replying(入力ロック→インク吸収→演出スクリプトで返事)
//                                          │ memory=true(1回だけ)
//                                          ▼
//                                        記憶シーン(闇の帳→大渦→蒼白いインクの返事)
//
// UI の原則: ダイアログもスピナーも出さない。通信中は「気配」、エラーは
// 「ページがインクを弾く」——すべて日記の中の出来事として伝える。
import "./style.css";
import { InkCanvas } from "./canvas";
import {
  RiddleWriter,
  fallbackScript,
  type ScriptSegment,
} from "./writer";
import { PresenceInk } from "./presence";
import { Signature } from "./signature";
import { SoundScape } from "./sound";

const IDLE_MS = 4200; // ペンが離れてから「書き終わり」とみなすまで。
// 短すぎると、書いてる途中で少し考えただけで AI 判定が走り、次のストローク開始と
// ぶつかって書き心地が乱れる。メモ.app 的な書き味を優先して長めにとる。
const REPLY_LINGER_MIN_MS = 7000; // 返事を読ませる最低時間(長文は文字数で伸びる)

interface Exchange {
  user: string;
  riddle: string;
}

interface RiddleResult {
  ready: boolean;
  transcript: string;
  reply: string;
  script?: ScriptSegment[];
  memory?: boolean;
}

const page = document.getElementById("page")!;
const presence = document.getElementById("presence")!;
const rejectFlash = document.getElementById("reject-flash")!;
const memoryVeil = document.getElementById("memory-veil")!;
const sound = new SoundScape();
const presenceInk = new PresenceInk(
  document.getElementById("presence-ink") as HTMLCanvasElement,
);
const memoryInk = new PresenceInk(
  document.getElementById("memory-ink") as HTMLCanvasElement,
  "memory",
);
const signature = new Signature(
  document.getElementById("presence-sign") as HTMLCanvasElement,
);
const ink = new InkCanvas(document.getElementById("ink") as HTMLCanvasElement);

// iOS の自動再生制限: 音はユーザーの最初のタッチで解錠する
page.addEventListener("pointerdown", () => sound.unlock());

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
const writer = new RiddleWriter(
  document.getElementById("reply-layer")!,
  sound,
);

const history: Exchange[] = [];
let idleTimer: number | null = null;
let judging = false; // LLM 判定リクエスト中
let possessed = false; // トムが答えている最中(入力ロック)
let memoryShown = false; // 記憶シーンはセッションに1度だけ

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

ink.onStrokeStart = () => {
  cancelJudge();
  sound.userScratchStart();
};
ink.onStrokeEnd = () => {
  sound.userScratchStop();
  if (!possessed) scheduleJudge();
};

/** 通信に失敗した=ページがインクを弾いた。冷たい明滅と低い脈動だけで伝える。 */
function diegeticReject() {
  sound.reject();
  rejectFlash.classList.remove("active");
  void (rejectFlash as HTMLElement).offsetWidth; // アニメーション再トリガーのための reflow
  rejectFlash.classList.add("active");
}

async function onIdle() {
  if (judging || possessed || ink.strokes.length === 0) return;
  // ペンが接地している間は判定を始めない(キャプチャの割り込みで書き味が乱れる)
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

    // キャプチャ中にユーザーが書き始めた/書き足したら、この判定は破棄してやり直す
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
    const result: RiddleResult = await res.json();

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
    diegeticReject();
  } finally {
    judging = false;
    hidePresence();
  }
}

/** トムがページを乗っ取る: ロック → インク吸収 → (記憶シーン) → 署名 → 演出スクリプトで返事 */
async function possess(result: RiddleResult) {
  possessed = true;
  page.classList.add("locked");
  cancelJudge();
  hidePresence(); // 気配(渦)は役目を終えて紙の奥へ引いていく

  await wait(500); // 一拍の間
  sound.absorb();
  await ink.fadeOut(); // 書いたものが紙に吸い込まれる
  await wait(600);

  // 会話が進むほどトムの筆は馴れ馴れしくなる(文字が大きく、間が詰まり、傾きが大胆に)
  const intimacy = Math.min(history.length / 8, 1);
  const script =
    result.script && result.script.length > 0
      ? result.script
      : fallbackScript(result.reply);

  // 隠しイベント: 使用者が日記の核心へ踏み込んだとき、1度だけ記憶を「見せる」
  const isMemory = result.memory === true && !memoryShown;
  if (isMemory) {
    memoryShown = true;
    memoryVeil.classList.add("full"); // ページが冷たい闇に沈む
    sound.droneStart();
    await wait(2200);
    if (memoryInk.available) memoryInk.start(); // 闇の中で大渦がページを呑む
    await wait(6000);
    if (memoryInk.available) memoryInk.stop();
    await wait(1400);
    memoryVeil.classList.remove("full");
    memoryVeil.classList.add("half"); // 半分だけ明けた薄闇の中でトムが書く
    sound.droneStop();
    await wait(900);
  }

  // 気配が消えた静けさの中で、トムが正体を明かすように署名する
  sound.sustainedScratch(2800);
  await signature.write();
  await wait(400);

  await writer.write(script, {
    intimacy,
    ink: isMemory ? "#b9c6ea" : undefined, // 記憶の中の文字は蒼白い
    sizeMul: isMemory ? 1.15 : 1,
  });

  history.push({ user: result.transcript, riddle: result.reply });
  if (history.length > 12) history.splice(0, history.length - 12);

  const linger = Math.max(REPLY_LINGER_MIN_MS, result.reply.length * 170);
  await wait(linger);
  // トムの文字も署名も、またインクへ還る
  sound.absorb();
  await Promise.all([writer.fadeOut(), signature.fadeOut()]);
  if (isMemory) memoryVeil.classList.remove("half");

  page.classList.remove("locked");
  possessed = false;
}

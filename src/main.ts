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
// ペンの色でモードが変わる:
//   墨(sumi): 上のとおり。書いた字は吸い込まれ、トムが返事する
//   朱(shu) : 書いた字は残り、余白に註釈(補足解説)が書き添えられる(消えない)
//
// ページの左右端をタップすると新しい白紙へ。めくり＝クリア(手書きも履歴も残さない)。
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
import { InkWell, PEN_COLORS, type PenMode } from "./inkwell";
import { PageTurn } from "./pageturn";

const IDLE_MS = 4200; // ペンが離れてから「書き終わり」とみなすまで。
// 短すぎると、書いてる途中で少し考えただけで AI 判定が走り、次のストローク開始と
// ぶつかって書き心地が乱れる。メモ.app 的な書き味を優先して長めにとる。
const REPLY_LINGER_MIN_MS = 7000; // 返事を読ませる最低時間(長文は文字数で伸びる)
const ANNOTATION_INK = "#1a2744"; // 朱モードで日記が書き添える註釈の色(紺)

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

// ペンの色＝モード。既定は墨。
let penMode: PenMode = "sumi";
ink.setColor(PEN_COLORS.sumi);
const inkwell = new InkWell(document.getElementById("inkwells")!);
inkwell.onChange = (mode, color) => {
  penMode = mode;
  ink.setColor(color);
};

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
let possessed = false; // トム/日記が書いている最中(入力ロック)
let memoryShown = false; // 記憶シーンはセッションに1度だけ

// ページめくり=クリア。トムが書いている/読んでいる間はめくれない。
const pageTurn = new PageTurn(
  page,
  document.getElementById("edge-left")!,
  document.getElementById("edge-right")!,
  () => ink.snapshot(),
);
pageTurn.canFlip = () => !possessed && !judging;
pageTurn.onFlip = () => {
  cancelJudge();
  hidePresence();
  ink.clear();
  writer.clear();
  signature.fadeOut();
  history.length = 0;
};

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
  if (judging || possessed || ink.strokeCount === 0) return;
  // ペンが接地している間は判定を始めない(キャプチャの割り込みで書き味が乱れる)
  if (ink.isDrawing) {
    scheduleJudge();
    return;
  }
  judging = true;
  showPresence(); // 「誰かが読んでいる」気配

  const mode = penMode; // この判定を始めた時点のモードで一貫して扱う
  const strokeCountAtCapture = ink.strokeCount;
  const revisionAtCapture = ink.inputRevision;
  try {
    const image = await ink.captureAsync();

    // キャプチャ中にユーザーが書き始めた/書き足したら、この判定は破棄してやり直す
    if (
      ink.isDrawing ||
      ink.inputRevision !== revisionAtCapture ||
      ink.strokeCount !== strokeCountAtCapture
    ) {
      judging = false;
      hidePresence();
      scheduleJudge();
      return;
    }

    const res = await fetch("/api/riddle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, history, mode }),
    });
    if (!res.ok) throw new Error(`server ${res.status}`);
    const result: RiddleResult = await res.json();

    // 判定中にユーザーが書き足していたら、この判定は破棄してやり直す
    if (
      ink.inputRevision !== revisionAtCapture ||
      ink.strokeCount !== strokeCountAtCapture
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

    await possess(result, mode);
  } catch (err) {
    console.error("[diary]", err);
    diegeticReject();
  } finally {
    judging = false;
    hidePresence();
  }
}

/**
 * 日記がページを乗っ取る。
 *   墨: ロック → インク吸収(字が消える) → (記憶シーン) → 署名 → 演出スクリプトで返事 → 返事も消える
 *   朱: ロック → 字は消さず、余白に註釈を朱筆のように書き添える(消えない) → 解除
 */
async function possess(result: RiddleResult, mode: PenMode) {
  possessed = true;
  page.classList.add("locked");
  cancelJudge();
  hidePresence(); // 気配(渦)は役目を終えて紙の奥へ引いていく

  await wait(500); // 一拍の間

  const script =
    result.script && result.script.length > 0
      ? result.script
      : fallbackScript(result.reply);

  if (mode === "shu") {
    // 朱モード: 書いた字は残す。署名も記憶シーンもなし。
    // 余白(下寄せ)に註釈を書き添え、そのまま残す(ページをめくるまで消えない)。
    sound.sustainedScratch(1600);
    await writer.write(script, { sizeMul: 0.82, startYFrac: 0.6 });
    // 朱モードの一問一答はトムの会話記憶(history)には積まない。
    page.classList.remove("locked");
    possessed = false;
    return;
  }

  // 墨モード（既存のトム・リドル）
  sound.absorb();
  await ink.fadeOut(); // 書いたものが紙に吸い込まれる
  await wait(600);

  // 会話が進むほどトムの筆は馴れ馴れしくなる(文字が大きく、間が詰まり、傾きが大胆に)
  const intimacy = Math.min(history.length / 8, 1);

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

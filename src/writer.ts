// トム・リドルの返事を「見えない誰かが万年筆で書いている」ように
// KanjiVG の書き順データを使って 1画ずつ描画する。
//
// 配置は「ペンの旅」— 文節はテレポートせず、仮想のペン先が
// ノイズでうねるベースラインに沿って進む。揺らぎは白色乱数ではなく
// 相関ノイズ(fBm)から取り、人間の手の「呼吸」を出す。
// 間・筆速・大きさ・強調は LLM が返す演出スクリプト(ScriptSegment)が決める。
// インクは書いた直後は濡れて濃く、時間とともに乾いて落ち着く。

import { Noise1D } from "./noise";
import type { SoundScape } from "./sound";

const KANJIVG_VIEWBOX = 109;
const INK_DRY = "#1a2744";
const INK_WET = "#0a1430"; // 書いた直後の濡れた色。DRY_MS かけて INK_DRY へ乾く
const DRY_MS = 1700;
const SVG_NS = "http://www.w3.org/2000/svg";

const STROKE_W_MIN = 1.0;
const STROKE_W_MAX = 5.2;
const INK_POOL_R = 1.4;

const strokeCache = new Map<string, string[] | null>();

/** LLM が返す演出スクリプトの 1 要素。トム自身が「どう書くか」を決める。 */
export interface ScriptSegment {
  text: string;
  pause: number; // この句を書き始める前の「間」(ms)
  speed: number; // 筆速 0.6(ためらい)〜1.4(流れる)
  size: number; // 文字サイズ倍率 0.85〜1.25
  emphasis: boolean; // 感情が昂ぶった句。大きく・傾いて・行から浮いて書かれる
}

export interface WriteOptions {
  intimacy?: number; // 0..1 会話が進むほど筆が馴れ馴れしくなる
  ink?: string; // インク色の上書き(記憶シーンでは蒼白く)
  sizeMul?: number;
  startYFrac?: number; // 書き出しの縦位置(高さ比 0..1)。註釈は下寄せにする
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

async function loadStrokePaths(ch: string): Promise<string[] | null> {
  const cached = strokeCache.get(ch);
  if (cached !== undefined) return cached;

  const hex = ch.codePointAt(0)!.toString(16).padStart(5, "0");
  let result: string[] | null = null;
  try {
    const res = await fetch(`/kanjivg/${hex}.svg`);
    if (res.ok) {
      const doc = new DOMParser().parseFromString(
        await res.text(),
        "image/svg+xml",
      );
      const group = doc.querySelector('g[id^="kvg:StrokePaths"]');
      const paths = Array.from((group ?? doc).querySelectorAll("path"))
        .map((p) => p.getAttribute("d"))
        .filter((d): d is string => !!d);
      if (paths.length > 0) result = paths;
    }
  } catch {
    result = null;
  }
  strokeCache.set(ch, result);
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function splitChunks(text: string): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (ch === "\n") {
      if (cur) chunks.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
    if ("、。？！?!…".includes(ch)) {
      chunks.push(cur);
      cur = "";
    }
  }
  if (cur) chunks.push(cur);
  return chunks.filter((c) => c.trim().length > 0);
}

/** LLM が script を返さなかったときの控えめな既定演出。 */
export function fallbackScript(text: string): ScriptSegment[] {
  return splitChunks(text).map((t, i) => ({
    text: t,
    pause: i === 0 ? 420 : 300,
    speed: 1,
    size: 1,
    emphasis: false,
  }));
}

interface CharStyle {
  inkWet: string;
  inkDry: string;
  poolMul: number; // 長い「間」の後はペン先にインクが溜まっている
  pressure: number; // 強調句は筆圧が上がり、画が太くなる
  speed: number;
}

export class RiddleWriter {
  private layer: HTMLElement;
  private elements: Element[] = [];
  private sound: SoundScape | null;
  // 揺らぎの源。用途ごとに別の種で、互いに相関しない呼吸を持たせる
  private drift = new Noise1D(11); // ベースラインの上下
  private wob = new Noise1D(37); // 文字サイズの揺れ
  private tilt = new Noise1D(71); // 文字の傾き

  constructor(layer: HTMLElement, sound: SoundScape | null = null) {
    this.layer = layer;
    this.sound = sound;
  }

  async write(
    segments: ScriptSegment[],
    opts: WriteOptions = {},
  ): Promise<void> {
    const W = this.layer.clientWidth || window.innerWidth;
    const H = this.layer.clientHeight || window.innerHeight;

    const intimacy = clamp(opts.intimacy ?? 0, 0, 1);
    const inkDry = opts.ink ?? INK_DRY;
    const inkWet = opts.ink ?? INK_WET;
    // 親密になるほど文字は大きく、間は詰まり、筆は大胆に傾く
    const baseSize =
      clamp(W * 0.044, 28, 50) * (1 + 0.14 * intimacy) * (opts.sizeMul ?? 1);
    const pauseMul = 1 - 0.35 * intimacy;
    const tiltAmp = 1 + 0.8 * intimacy;

    const left = W * 0.1;
    const right = W * 0.9;
    const topY = H * (opts.startYFrac ?? 0.16);

    // ノイズの読み出し位置。返事ごとに別の場所から読み、同じ呼吸を繰り返さない
    let nt = Math.random() * 500;

    let x = left + Math.abs(this.drift.fbm(nt)) * W * 0.05;
    let y = topY + this.drift.fbm(nt + 3.7) * H * 0.02;
    let lineH = baseSize * 1.62;

    const newline = () => {
      x = left + Math.abs(this.drift.fbm(nt + 9.1)) * W * 0.04;
      y += lineH;
      if (y + lineH > H * 0.92) y = topY; // あふれたら上へ戻る(80字制限内ではほぼ起きない)
    };

    for (const seg of segments) {
      const pause = clamp(seg.pause ?? 300, 0, 2000) * pauseMul;
      if (pause > 0) await sleep(pause);
      let poolMul = 1 + (Math.min(pause, 1200) / 1200) * 0.9;

      const speed = clamp(seg.speed ?? 1, 0.5, 1.6);
      const emph = seg.emphasis === true;
      const segSize =
        baseSize * clamp(seg.size ?? 1, 0.7, 1.4) * (emph ? 1.12 : 1);
      const segTilt = tiltAmp * (emph ? 2.4 : 1);
      const pressure = emph ? 1.18 : 1;
      lineH = Math.max(lineH, segSize * 1.62);

      for (const ch of seg.text) {
        if (ch === "\n") {
          newline();
          continue;
        }
        if (ch === " " || ch === "　") {
          x += segSize * (ch === " " ? 0.4 : 0.9);
          continue;
        }

        nt += 0.34;
        const sz = segSize * (1 + this.wob.fbm(nt) * 0.09);
        if (x + sz > right && x > left + sz * 0.5) newline();
        // ベースラインのうねり。強調された句は行から浮き上がる
        const dy = this.drift.fbm(nt * 0.6 + 50) * sz * (emph ? 0.42 : 0.16);
        const rot = this.tilt.fbm(nt * 0.8 + 100) * 4.5 * segTilt;

        const paths = await loadStrokePaths(ch);
        if (paths) {
          await this.writeChar(x, y + dy, sz, rot, paths, {
            inkWet,
            inkDry,
            poolMul,
            pressure,
            speed,
          });
        } else {
          this.writeFallbackChar(ch, x, y + dy, sz, rot, inkDry);
          await sleep(140 / speed);
        }
        poolMul = 1;
        x += sz * 1.04;

        if ("、。？！…?!".includes(ch)) {
          await sleep((280 * pauseMul) / speed);
        } else {
          await sleep(40 / speed);
        }
      }
      await sleep(90 * pauseMul);
    }
  }

  private async writeChar(
    x: number,
    y: number,
    size: number,
    rotate: number,
    pathDs: string[],
    style: CharStyle,
  ): Promise<void> {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${KANJIVG_VIEWBOX} ${KANJIVG_VIEWBOX}`);
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.style.left = `${x}px`;
    svg.style.top = `${y}px`;
    svg.style.transform = `rotate(${rotate}deg)`;
    this.layer.appendChild(svg);
    this.elements.push(svg);

    let first = true;
    for (const d of pathDs) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", style.inkWet);
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path);

      const len = path.getTotalLength();

      // 画の長さで太さを決める(長い画ほど太く、短い画は細い)。強調は筆圧増し
      const t = Math.min(len / 80, 1);
      const sw =
        (STROKE_W_MIN + t * (STROKE_W_MAX - STROKE_W_MIN)) * style.pressure;
      path.setAttribute("stroke-width", String(sw));

      // 万年筆のインク溜まり: 画の始点に小さな円。
      // 長い「間」の後の最初の画は、待っていたぶん溜まりが育っている
      const start = path.getPointAtLength(0);
      const pool = document.createElementNS(SVG_NS, "circle");
      pool.setAttribute("cx", String(start.x));
      pool.setAttribute("cy", String(start.y));
      pool.setAttribute(
        "r",
        String(INK_POOL_R * (0.6 + t * 0.6) * (first ? style.poolMul : 1)),
      );
      pool.setAttribute("fill", style.inkDry);
      pool.setAttribute("opacity", "0");
      svg.appendChild(pool);

      path.style.strokeDasharray = String(len);
      path.style.strokeDashoffset = String(len);

      const duration = Math.min(Math.max(len * 3.0, 80), 340) / style.speed;

      this.sound?.strokeScratch(duration, 0.5 + t * 0.7);

      pool.animate([{ opacity: 0 }, { opacity: 0.3 }], {
        duration: duration * 0.3,
        fill: "forwards",
      });

      // 入り→太く→抜き: stroke-width もアニメーション
      const swThin = sw * 0.35;
      const anim = path.animate(
        [
          { strokeDashoffset: len, strokeWidth: swThin },
          { strokeDashoffset: len * 0.6, strokeWidth: sw, offset: 0.3 },
          { strokeDashoffset: len * 0.2, strokeWidth: sw, offset: 0.75 },
          { strokeDashoffset: 0, strokeWidth: swThin },
        ],
        { duration, easing: "ease-in-out", fill: "forwards" },
      );
      await anim.finished;

      // 濡れたインクが乾いていく
      if (style.inkWet !== style.inkDry) {
        path.animate([{ stroke: style.inkWet }, { stroke: style.inkDry }], {
          duration: DRY_MS,
          easing: "ease-out",
          fill: "forwards",
        });
      }

      first = false;
      await sleep(24 / style.speed);
    }
  }

  private writeFallbackChar(
    ch: string,
    x: number,
    y: number,
    size: number,
    rotate: number,
    ink: string,
  ) {
    const div = document.createElement("div");
    div.className = "fallback-char";
    div.textContent = ch;
    div.style.left = `${x}px`;
    div.style.top = `${y}px`;
    div.style.fontSize = `${size * 0.92}px`;
    div.style.color = ink;
    div.style.transform = `rotate(${rotate}deg)`;
    this.layer.appendChild(div);
    this.elements.push(div);
    requestAnimationFrame(() => {
      div.style.opacity = "1";
    });
  }

  /** 書いた文字を即座に消す(ページめくり=クリア用。演出なし)。 */
  clear() {
    for (const el of this.elements) el.remove();
    this.elements = [];
  }

  async fadeOut(): Promise<void> {
    const els = this.elements;
    this.elements = [];
    els.forEach((el, i) => {
      const node = el as HTMLElement;
      node.style.transition = "opacity 1.4s ease, filter 1.4s ease";
      setTimeout(() => {
        node.style.opacity = "0";
        node.style.filter = "blur(2.5px)";
      }, i * 22);
    });
    await sleep(els.length * 22 + 1500);
    for (const el of els) el.remove();
  }
}

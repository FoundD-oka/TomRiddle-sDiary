// トム・リドルの返事を「見えない誰かが万年筆で書いている」ように
// KanjiVG の書き順データを使って 1画ずつ描画する。
// 文節ごとに位置・サイズ・角度がランダムに変わり、ページ上に浮かぶように現れる。

const KANJIVG_VIEWBOX = 109;
const INK_COLOR = "#1a2744";
const INK_POOL_COLOR = "rgba(26, 39, 68, 0.30)";
const SVG_NS = "http://www.w3.org/2000/svg";

const STROKE_W_MIN = 1.0;
const STROKE_W_MAX = 5.2;
const INK_POOL_R = 1.4;

const strokeCache = new Map<string, string[] | null>();

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
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

function splitChunks(text: string): string[] {
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

export class RiddleWriter {
  private layer: HTMLElement;
  private elements: Element[] = [];

  constructor(layer: HTMLElement) {
    this.layer = layer;
  }

  async write(text: string): Promise<void> {
    const W = this.layer.clientWidth || window.innerWidth;
    const H = this.layer.clientHeight || window.innerHeight;
    const baseSize = Math.min(Math.max(W * 0.044, 28), 50);

    const chunks = splitChunks(text);
    // 既に文字を置いた領域。新しい文節はここと重ならない場所を探して置く。
    const occupied: Rect[] = [];

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const sz = baseSize * (0.82 + Math.random() * 0.36);
      const angle = (Math.random() - 0.5) * 14;
      const lineH = sz * 1.5;
      // ブロック内の折り返し幅。文節が短ければ1行に収まる。
      const blockMaxW = Math.min(W * 0.6, sz * 1.04 * Math.max(chunk.length, 1));

      // 1) 文節内のグリフをローカル座標でレイアウトする。
      //    横方向にだけ進め、行末で折り返す（縦流れは起こさない）。
      const glyphs: { ch: string; lx: number; ly: number; rot: number }[] = [];
      let lx = 0;
      let ly = 0;
      for (const ch of chunk) {
        if (ch === " " || ch === "　") {
          lx += sz * (ch === " " ? 0.4 : 0.9);
          continue;
        }
        if (lx + sz > blockMaxW && lx > 0) {
          lx = 0;
          ly += lineH;
        }
        const rot = (Math.random() - 0.5) * 5;
        const jY = (Math.random() - 0.5) * sz * 0.06;
        glyphs.push({ ch, lx, ly: ly + jY, rot });
        lx += sz * 1.04;
      }
      if (glyphs.length === 0) continue;

      // 2) ブロックのローカル外接サイズ（回転ぶんの余白 m 込み）。
      const m = sz * 0.25;
      let rawW = 0;
      let rawH = 0;
      for (const g of glyphs) {
        rawW = Math.max(rawW, g.lx + sz);
        rawH = Math.max(rawH, g.ly + sz);
      }
      const bw = rawW + m;
      const bh = rawH + m;

      // 3) angle で回転させたときの軸並行外接矩形（AABB）。被り判定はこの矩形で行う。
      const rad = (angle * Math.PI) / 180;
      const aabbW = Math.abs(bw * Math.cos(rad)) + Math.abs(bh * Math.sin(rad));
      const aabbH = Math.abs(bw * Math.sin(rad)) + Math.abs(bh * Math.cos(rad));

      // 4) 既存の文字と重ならない置き場所を探す（散らし配置は保ちつつ被りだけ回避）。
      const spot = this.findSpot(aabbW, aabbH, W, H, occupied);
      occupied.push({ x: spot.x, y: spot.y, w: aabbW, h: aabbH });

      // 5) ブロック用コンテナを AABB の中心に置き、その中心まわりに angle 回転させる。
      const cx = spot.x + aabbW / 2;
      const cy = spot.y + aabbH / 2;
      const container = document.createElement("div");
      container.style.position = "absolute";
      container.style.left = `${cx - bw / 2}px`;
      container.style.top = `${cy - bh / 2}px`;
      container.style.width = `${bw}px`;
      container.style.height = `${bh}px`;
      container.style.transformOrigin = "center";
      container.style.transform = `rotate(${angle}deg)`;
      this.layer.appendChild(container);
      this.elements.push(container);

      // 6) コンテナ内に 1 画ずつ書いていく（見た目の演出は従来どおり）。
      for (const g of glyphs) {
        const paths = await loadStrokePaths(g.ch);
        if (paths) {
          await this.writeChar(container, paths, g.lx + m / 2, g.ly + m / 2, sz, g.rot);
        } else {
          this.writeFallbackChar(container, g.ch, g.lx + m / 2, g.ly + m / 2, sz, g.rot);
          await sleep(140);
        }

        if ("、。？！…?!".includes(g.ch)) {
          await sleep(280);
        } else {
          await sleep(40);
        }
      }

      if (ci < chunks.length - 1) {
        await sleep(320);
      }
    }
  }

  /**
   * w×h のブロックを、既存の occupied 矩形と重ならない位置に置くための左上座標を探す。
   * ランダムに候補を投げて、被りゼロの場所が見つかればそこ。
   * 見つからなければ既存の一番下に積み、それも無理なら最も被りの少ない候補を返す。
   */
  private findSpot(
    w: number,
    h: number,
    W: number,
    H: number,
    occupied: Rect[],
  ): { x: number; y: number } {
    const pad = Math.min(W, H) * 0.02;
    const minX = W * 0.04;
    const minY = H * 0.08;
    const maxX = Math.max(minX, W * 0.96 - w);
    const maxY = Math.max(minY, H * 0.94 - h);

    let best: { x: number; y: number } | null = null;
    let bestOverlap = Infinity;

    for (let i = 0; i < 60; i++) {
      const x = minX + Math.random() * (maxX - minX);
      const y = minY + Math.random() * (maxY - minY);
      const ov = this.overlapArea({ x, y, w, h }, occupied, pad);
      if (ov === 0) return { x, y };
      if (ov < bestOverlap) {
        bestOverlap = ov;
        best = { x, y };
      }
    }

    // 空きが見つからないときは既存の一番下より下に積む。
    let lowest = minY;
    for (const r of occupied) lowest = Math.max(lowest, r.y + r.h + pad);
    if (lowest + h <= H * 0.98) {
      return { x: minX + Math.random() * (maxX - minX), y: lowest };
    }
    return best ?? { x: minX, y: minY };
  }

  /** r と occupied 各矩形の重なり面積の合計（pad ぶん膨らませて余白も確保）。 */
  private overlapArea(r: Rect, occupied: Rect[], pad: number): number {
    let total = 0;
    for (const o of occupied) {
      const ix = Math.max(
        0,
        Math.min(r.x + r.w, o.x + o.w + pad) - Math.max(r.x, o.x - pad),
      );
      const iy = Math.max(
        0,
        Math.min(r.y + r.h, o.y + o.h + pad) - Math.max(r.y, o.y - pad),
      );
      total += ix * iy;
    }
    return total;
  }

  private async writeChar(
    parent: HTMLElement,
    pathDs: string[],
    x: number,
    y: number,
    size: number,
    rotate: number,
  ): Promise<void> {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute(
      "viewBox",
      `0 0 ${KANJIVG_VIEWBOX} ${KANJIVG_VIEWBOX}`,
    );
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.style.left = `${x}px`;
    svg.style.top = `${y}px`;
    svg.style.transform = `rotate(${rotate}deg)`;
    parent.appendChild(svg);

    for (const d of pathDs) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", INK_COLOR);
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path);

      const len = path.getTotalLength();

      // 画の長さで太さを決める（長い画ほど太く、短い画は細い）
      const t = Math.min(len / 80, 1);
      const sw = STROKE_W_MIN + t * (STROKE_W_MAX - STROKE_W_MIN);
      path.setAttribute("stroke-width", String(sw));

      // 万年筆のインク溜まり: 画の始点に小さな円
      const start = path.getPointAtLength(0);
      const pool = document.createElementNS(SVG_NS, "circle");
      pool.setAttribute("cx", String(start.x));
      pool.setAttribute("cy", String(start.y));
      pool.setAttribute("r", String(INK_POOL_R * (0.6 + t * 0.6)));
      pool.setAttribute("fill", INK_POOL_COLOR);
      pool.setAttribute("opacity", "0");
      svg.appendChild(pool);

      path.style.strokeDasharray = String(len);
      path.style.strokeDashoffset = String(len);

      const duration = Math.min(Math.max(len * 3.0, 80), 340);

      pool.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: duration * 0.3,
        fill: "forwards",
      });

      // 入り→太く→抜き: stroke-widthもアニメーション
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
      await sleep(24);
    }
  }

  private writeFallbackChar(
    parent: HTMLElement,
    ch: string,
    x: number,
    y: number,
    size: number,
    rotate: number,
  ) {
    const div = document.createElement("div");
    div.className = "fallback-char";
    div.textContent = ch;
    div.style.left = `${x}px`;
    div.style.top = `${y}px`;
    div.style.fontSize = `${size * 0.92}px`;
    div.style.transform = `rotate(${rotate}deg)`;
    parent.appendChild(div);
    requestAnimationFrame(() => {
      (div as HTMLElement).style.opacity = "1";
    });
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

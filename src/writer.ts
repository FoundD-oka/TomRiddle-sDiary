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
    let cursorY = H * 0.13;

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const sz = baseSize * (0.82 + Math.random() * 0.36);
      const angle = (Math.random() - 0.5) * 14;
      const rad = (angle * Math.PI) / 180;
      const cosA = Math.cos(rad);
      const sinA = Math.sin(rad);
      const lineH = sz * 1.55;

      let x = W * (0.06 + Math.random() * 0.32);
      let y = cursorY;
      const maxX = W * 0.91;

      for (const ch of chunk) {
        if (ch === " " || ch === "　") {
          const adv = sz * (ch === " " ? 0.4 : 0.9);
          x += adv * cosA;
          y += adv * sinA;
          continue;
        }

        if (x + sz > maxX) {
          x = W * (0.06 + Math.random() * 0.12);
          y += lineH;
        }

        const paths = await loadStrokePaths(ch);
        const rot = angle + (Math.random() - 0.5) * 2.5;
        const jY = (Math.random() - 0.5) * sz * 0.04;

        if (paths) {
          await this.writeChar(paths, x, y + jY, sz, rot);
        } else {
          this.writeFallbackChar(ch, x, y + jY, sz, rot);
          await sleep(140);
        }

        const adv = sz * 1.02;
        x += adv * cosA;
        y += adv * sinA;

        if ("、。？！…?!".includes(ch)) {
          await sleep(280);
        } else {
          await sleep(40);
        }
      }

      cursorY = y + lineH * (0.5 + Math.random() * 0.9);

      if (ci < chunks.length - 1) {
        await sleep(320);
      }
    }
  }

  private async writeChar(
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
    this.layer.appendChild(svg);
    this.elements.push(svg);

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
    this.layer.appendChild(div);
    this.elements.push(div);
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

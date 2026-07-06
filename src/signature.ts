// トムの署名「T. M. Riddle」。返事が確定した瞬間、右下に手書きで浮かぶ。
// 書体(フォント)ではなく筆記体の中心線を1画ずつ可変幅で描く——画の両端は細く、
// 中央は太い「タメ」で、万年筆の強弱と手書き感を出す。
// (本体アプリがトムの返事を KanjiVG の書き順・線幅で描くのと同じ思想)

const INK = (a: number) => `rgba(38, 53, 92, ${a})`;
const TAU = Math.PI * 2;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// 筆記体「T. M. Riddle」の中心線ストローク(書き順)。SVGパス d。
const SIG_STROKES = [
  "M16 42 C 30 22 56 16 82 25",
  "M55 21 C 52 37 49 52 48 63 C 48 69 53 68 59 63",
  "M88 57 c 3 -2 7 1 4 5",
  "M102 64 C 102 38 105 25 109 28 C 114 32 118 53 123 47 C 127 42 131 27 135 29 C 140 32 144 53 149 47 C 153 43 156 30 158 31 C 160 36 158 55 157 64",
  "M168 57 c 3 -2 7 1 4 5",
  "M184 27 C 182 43 180 55 179 64",
  "M184 27 C 201 22 207 35 194 43 C 189 46 186 45 183 44 C 194 49 202 57 210 65",
  "M216 44 C 217 52 217 58 218 64",
  "M238 45 C 233 41 226 43 225 50 C 224 57 230 62 236 60 C 240 58 241 52 240 47",
  "M240 22 C 239 38 239 52 240 64",
  "M262 45 C 257 41 250 43 249 50 C 248 57 254 62 260 60 C 264 58 265 52 264 47",
  "M264 22 C 263 38 263 52 264 64",
  "M280 22 C 279 40 279 54 281 64",
  "M287 56 C 293 51 301 53 300 58 C 299 63 291 63 289 57 C 288 51 295 48 301 50",
];
const SIG_DOTS = [{ x: 217, y: 35 }];

interface Pt { x: number; y: number; }
interface Stroke { pts: Pt[]; len: number; }

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const widthAt = (u: number) => 0.28 + 0.72 * Math.sin(Math.PI * clamp01(u));

// SVGパスを等間隔サンプリング
const _svgNS = "http://www.w3.org/2000/svg";
const _mSvg = document.createElementNS(_svgNS, "svg");
_mSvg.setAttribute("width", "0");
_mSvg.setAttribute("height", "0");
_mSvg.style.cssText = "position:absolute;left:-9999px;visibility:hidden";
function sample(d: string, step: number): Stroke {
  if (!_mSvg.isConnected) document.body.appendChild(_mSvg);
  const p = document.createElementNS(_svgNS, "path");
  p.setAttribute("d", d);
  _mSvg.appendChild(p);
  const L = p.getTotalLength();
  const pts: Pt[] = [];
  for (let s = 0; s <= L; s += step) { const q = p.getPointAtLength(s); pts.push({ x: q.x, y: q.y }); }
  const e = p.getPointAtLength(L); pts.push({ x: e.x, y: e.y });
  _mSvg.removeChild(p);
  return { pts, len: L };
}

const SIG: Stroke[] = SIG_STROKES.map((d) => sample(d, 1.4));
const SIG_TOTAL = SIG.reduce((a, s) => a + s.len, 0);
let mnX = 1e9, mnY = 1e9, mxX = -1e9, mxY = -1e9;
for (const st of SIG) for (const p of st.pts) {
  if (p.x < mnX) mnX = p.x; if (p.x > mxX) mxX = p.x;
  if (p.y < mnY) mnY = p.y; if (p.y > mxY) mxY = p.y;
}
const SIG_W = mxX - mnX, SIG_H = mxY - mnY;

const BASE_W = 3.4;
const WRITE_MS = 2800; // 書き上がるまで
const FADE_MS = 1500; // 沈んで消えるまで

export class Signature {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr: number;
  private W = 0; private H = 0; private sc = 1; private ox = 0; private oy = 0;
  private raf = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
  }

  private layout() {
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const w = Math.round(cw * this.dpr), h = Math.round(ch * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.W = cw; this.H = ch;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.sc = Math.min((this.W * 0.9) / SIG_W, (this.H * 0.72) / SIG_H);
    this.ox = (this.W - SIG_W * this.sc) / 2 - mnX * this.sc;
    this.oy = this.H / 2 - (mnY + SIG_H / 2) * this.sc;
  }

  /** reveal:0..1 書き進み / alpha:全体濃度 / sink:0..1 沈み */
  private drawFrame(reveal: number, alpha: number, sink: number, t: number) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);
    if (alpha <= 0.001 || reveal <= 0.001) return;
    const revealLen = SIG_TOTAL * reveal;
    const bodyA = alpha * (1 - sink * 0.9);
    ctx.save();
    ctx.translate(this.ox, this.oy);
    ctx.scale(this.sc, this.sc);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = INK(bodyA); ctx.fillStyle = INK(bodyA);
    ctx.shadowColor = INK(bodyA * 0.25); ctx.shadowBlur = (0.5 + sink * 9) / this.sc;
    let acc = 0; let frontier: Pt | null = null;
    for (let si = 0; si < SIG.length; si++) {
      if (acc >= revealLen) break;
      const pts = SIG[si].pts, n = pts.length;
      ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, BASE_W * 0.42, 0, TAU); ctx.fill();
      for (let i = 1; i < n; i++) {
        const segLen = dist(pts[i - 1], pts[i]);
        const u = i / (n - 1);
        if (acc + segLen > revealLen) {
          const f = (revealLen - acc) / segLen;
          const mid = { x: lerp(pts[i - 1].x, pts[i].x, f), y: lerp(pts[i - 1].y, pts[i].y, f) };
          ctx.lineWidth = BASE_W * widthAt(u);
          ctx.beginPath(); ctx.moveTo(pts[i - 1].x, pts[i - 1].y); ctx.lineTo(mid.x, mid.y); ctx.stroke();
          frontier = mid; acc = revealLen; break;
        }
        ctx.lineWidth = BASE_W * widthAt(u);
        ctx.beginPath(); ctx.moveTo(pts[i - 1].x, pts[i - 1].y); ctx.lineTo(pts[i].x, pts[i].y); ctx.stroke();
        acc += segLen; frontier = pts[i];
      }
    }
    if (reveal > 0.9) for (const d of SIG_DOTS) { ctx.beginPath(); ctx.arc(d.x, d.y, BASE_W * 0.5, 0, TAU); ctx.fill(); }
    ctx.restore();
    // ペン先: 書いている最中だけフロンティアで揺れるインク溜まり
    if (reveal < 0.995 && sink <= 0 && frontier) {
      const px = this.ox + frontier.x * this.sc;
      const py = this.oy + frontier.y * this.sc + Math.sin(t * 13) * 1.5 + Math.sin(t * 5.1) * 1.0;
      const pool = ctx.createRadialGradient(px, py, 0, px, py, 4.2);
      pool.addColorStop(0, INK(alpha * 0.85)); pool.addColorStop(0.5, INK(alpha * 0.3)); pool.addColorStop(1, INK(0));
      ctx.fillStyle = pool; ctx.beginPath(); ctx.arc(px, py, 4.2, 0, TAU); ctx.fill();
    }
  }

  /** 署名を1回書き上げる。書き終わったら解決する。 */
  write(): Promise<void> {
    this.layout();
    this.canvas.style.transition = "none";
    this.canvas.style.opacity = "1";
    this.canvas.style.visibility = "visible";
    cancelAnimationFrame(this.raf);
    const t0 = performance.now();
    return new Promise((resolve) => {
      const loop = (now: number) => {
        const t = (now - t0) / 1000;
        const p = clamp01((now - t0) / WRITE_MS);
        this.drawFrame(easeInOut(p), 1, 0, t);
        if (p >= 1) { resolve(); return; }
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    });
  }

  /** 署名を滲ませながら沈めて消す。 */
  async fadeOut(): Promise<void> {
    cancelAnimationFrame(this.raf);
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const loop = (now: number) => {
        const p = clamp01((now - t0) / FADE_MS);
        this.drawFrame(1, 1 - p, p, (now - t0) / 1000);
        if (p >= 1) { resolve(); return; }
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    });
    this.ctx.clearRect(0, 0, this.W, this.H);
    this.canvas.style.visibility = "hidden";
  }
}

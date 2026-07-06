// 手書きインクキャンバス。
// 中間点法ベジェ曲線 + 筆圧スムージングで Apple Pencil の書き心地を再現する。

export interface Point {
  x: number;
  y: number;
  p: number; // 筆圧 0..1
}

export type Stroke = Point[];

const INK_COLOR = "#26355c";
const BASE_WIDTH = 3.6;
const MIN_DIST_SQ = 2.25; // 1.5^2 — これより近いポイントは間引く
const P_SMOOTH = 0.2; // 筆圧 EMA 係数（低めで筆圧変化がダイレクトに出る）

export class InkCanvas {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  strokes: Stroke[] = [];
  private current: Stroke | null = null;
  private dpr = 1;
  private lastP = 0.5;

  onStrokeStart: (() => void) | null = null;
  onStrokeEnd: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.syncSize();

    new ResizeObserver(() => this.syncSize()).observe(canvas);

    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", (e) => this.up(e));
  }

  private syncSize() {
    this.dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.redraw();
  }

  private pOf(e: PointerEvent): number {
    return e.pointerType === "mouse" ? 0.5 : e.pressure || 0.5;
  }

  private down(e: PointerEvent) {
    if (!e.isPrimary) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.lastP = this.pOf(e);
    this.current = [{ x: e.offsetX, y: e.offsetY, p: this.lastP }];
    this.onStrokeStart?.();
  }

  private move(e: PointerEvent) {
    if (!this.current) return;
    e.preventDefault();
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      const rp = this.pOf(ev);
      this.lastP = this.lastP * P_SMOOTH + rp * (1 - P_SMOOTH);
      const pt: Point = { x: ev.offsetX, y: ev.offsetY, p: this.lastP };
      const prev = this.current[this.current.length - 1];
      const dx = pt.x - prev.x;
      const dy = pt.y - prev.y;
      if (dx * dx + dy * dy < MIN_DIST_SQ) continue;
      this.current.push(pt);
      this.drawLiveSegment(this.current);
    }
  }

  private up(_e: PointerEvent) {
    if (!this.current) return;
    if (this.current.length > 1) {
      this.strokes.push(this.current);
    }
    this.current = null;
    this.redraw();
    this.onStrokeEnd?.();
  }

  private wAt(p: number): number {
    return BASE_WIDTH * (0.25 + p * p * 1.8);
  }

  /** リアルタイム描画: 最新セグメントだけ曲線で追加 */
  private drawLiveSegment(s: Stroke) {
    const n = s.length;
    if (n < 2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.strokeStyle = INK_COLOR;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = 1;

    if (n === 2) {
      ctx.lineWidth = this.wAt(s[1].p);
      ctx.beginPath();
      ctx.moveTo(s[0].x, s[0].y);
      ctx.lineTo(s[1].x, s[1].y);
      ctx.stroke();
    } else {
      const a = s[n - 3], b = s[n - 2], c = s[n - 1];
      ctx.lineWidth = this.wAt(b.p);
      ctx.beginPath();
      ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
      ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** ストローク全体を中間点法ベジェ曲線で描画 */
  private drawStrokeCurve(
    ctx: CanvasRenderingContext2D,
    s: Stroke,
    alpha: number,
    blur = 0,
  ) {
    const n = s.length;
    if (n < 2) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (blur > 0) ctx.filter = `blur(${blur.toFixed(2)}px)`;
    ctx.strokeStyle = INK_COLOR;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (n === 2) {
      ctx.lineWidth = this.wAt(s[1].p);
      ctx.beginPath();
      ctx.moveTo(s[0].x, s[0].y);
      ctx.lineTo(s[1].x, s[1].y);
      ctx.stroke();
    } else {
      ctx.lineWidth = this.wAt(s[0].p);
      ctx.beginPath();
      ctx.moveTo(s[0].x, s[0].y);
      ctx.lineTo((s[0].x + s[1].x) / 2, (s[0].y + s[1].y) / 2);
      ctx.stroke();

      for (let i = 1; i < n - 1; i++) {
        ctx.lineWidth = this.wAt(s[i].p);
        ctx.beginPath();
        ctx.moveTo(
          (s[i - 1].x + s[i].x) / 2,
          (s[i - 1].y + s[i].y) / 2,
        );
        ctx.quadraticCurveTo(
          s[i].x,
          s[i].y,
          (s[i].x + s[i + 1].x) / 2,
          (s[i].y + s[i + 1].y) / 2,
        );
        ctx.stroke();
      }

      ctx.lineWidth = this.wAt(s[n - 1].p);
      ctx.beginPath();
      ctx.moveTo(
        (s[n - 2].x + s[n - 1].x) / 2,
        (s[n - 2].y + s[n - 1].y) / 2,
      );
      ctx.lineTo(s[n - 1].x, s[n - 1].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  redraw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    for (const s of this.strokes) this.drawStrokeCurve(ctx, s, 1);
    if (this.current && this.current.length > 1) {
      this.drawStrokeCurve(ctx, this.current, 1);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  clear() {
    this.strokes = [];
    this.redraw();
  }

  /** ストロークをずらしながら、にじんで薄れて消えていく */
  fadeOut(): Promise<void> {
    const strokes = this.strokes;
    const perStrokeDelay = Math.min(120, 1400 / Math.max(strokes.length, 1));
    const fadeDur = 1100;
    const total = perStrokeDelay * strokes.length + fadeDur;
    const start = performance.now();

    return new Promise((resolve) => {
      const frame = (now: number) => {
        const t = now - start;
        const ctx = this.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        let anyVisible = false;
        for (let i = 0; i < strokes.length; i++) {
          const local = (t - i * perStrokeDelay) / fadeDur;
          const alpha = 1 - Math.min(Math.max(local, 0), 1);
          if (alpha > 0.01) {
            anyVisible = true;
            this.drawStrokeCurve(ctx, strokes[i], alpha, (1 - alpha) * 3.5);
          }
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (anyVisible && t < total) {
          requestAnimationFrame(frame);
        } else {
          this.clear();
          resolve();
        }
      };
      requestAnimationFrame(frame);
    });
  }

  /** ストローク部分を白背景 PNG として書き出し、base64(プレフィックスなし)を返す */
  capture(): string {
    const pad = 24;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const s of this.strokes) {
      for (const pt of s) {
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
      }
    }
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;
    const w = Math.max(maxX - minX, 64);
    const h = Math.max(maxY - minY, 64);
    const scale = Math.min(1, 1100 / Math.max(w, h));

    const off = document.createElement("canvas");
    off.width = Math.round(w * scale);
    off.height = Math.round(h * scale);
    const ctx = off.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, off.width, off.height);
    ctx.scale(scale, scale);
    ctx.translate(-minX, -minY);
    for (const s of this.strokes) this.drawStrokeCurve(ctx, s, 1);

    return off.toDataURL("image/png").split(",")[1];
  }
}

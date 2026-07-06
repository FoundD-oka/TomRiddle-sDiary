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
  private activePointerId: number | null = null;
  private dpr = 1;
  private lastP = 0.5;
  // キャンバスの画面上の位置。点ごとに測り直すとレイアウト再計算が連発して
  // 描画がカクつくので、ストローク開始時とリサイズ時にだけ更新してキャッシュする。
  private rect: DOMRect | null = null;
  // ストローク開始のたびに増える。AI判定のキャプチャ中に新しい入力が
  // 始まったかどうかを main.ts 側が検知するための版数。
  inputRevision = 0;

  onStrokeStart: (() => void) | null = null;
  onStrokeEnd: (() => void) | null = null;

  /** いまペンが接地して描画中か（AI判定を割り込ませないための判定に使う） */
  get isDrawing(): boolean {
    return this.current !== null;
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.syncSize();

    new ResizeObserver(() => this.syncSize()).observe(canvas);

    const opts = { passive: false } as AddEventListenerOptions;
    canvas.addEventListener("pointerdown", (e) => this.down(e), opts);
    canvas.addEventListener("pointermove", (e) => this.move(e), opts);
    canvas.addEventListener("pointerup", (e) => this.up(e), opts);
    canvas.addEventListener("pointercancel", (e) => this.cancel(e), opts);
    canvas.addEventListener("lostpointercapture", (e) => this.cancel(e), opts);
  }

  private syncSize() {
    this.dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.rect = this.canvas.getBoundingClientRect();
    this.redraw();
  }

  private accepts(e: PointerEvent): boolean {
    return e.pointerType === "pen" || e.pointerType === "mouse" || e.pointerType === "";
  }

  private pOf(e: PointerEvent): number {
    if (e.pointerType === "mouse") return 0.5;
    if (e.pressure > 0) return e.pressure;
    if (e.buttons === 0) return 0.05;
    return 0.5;
  }

  private ptOf(e: PointerEvent): Point {
    // キャッシュ済みの rect を使う。点ごとに getBoundingClientRect を呼ぶと
    // レイアウト再計算が連発してストロークがカクつくため。
    const rect = this.rect ?? (this.rect = this.canvas.getBoundingClientRect());
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      p: this.pOf(e),
    };
  }

  private appendPoint(e: PointerEvent): boolean {
    if (!this.current) return false;
    const rp = this.pOf(e);
    this.lastP = this.lastP * P_SMOOTH + rp * (1 - P_SMOOTH);
    const pt = this.ptOf(e);
    pt.p = this.lastP;
    const prev = this.current[this.current.length - 1];
    const dx = pt.x - prev.x;
    const dy = pt.y - prev.y;
    if (dx * dx + dy * dy < MIN_DIST_SQ) return false;
    this.current.push(pt);
    return true;
  }

  private down(e: PointerEvent) {
    if (!this.accepts(e)) return;
    if (this.activePointerId !== null) return;
    e.preventDefault();
    // ストローク開始時に一度だけ位置を測り直す（以降は点ごとにキャッシュを使う）。
    this.rect = this.canvas.getBoundingClientRect();
    this.inputRevision++;
    this.activePointerId = e.pointerId;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // iPadOS Safari の境界条件で例外が出ても、描画自体は続ける。
    }
    this.lastP = this.pOf(e);
    this.current = [this.ptOf(e)];
    this.current[0].p = this.lastP;
    this.onStrokeStart?.();
  }

  private move(e: PointerEvent) {
    if (!this.current) return;
    if (e.pointerId !== this.activePointerId) return;
    e.preventDefault();
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      if (this.appendPoint(ev)) this.drawLiveSegment(this.current);
    }
  }

  private up(e: PointerEvent) {
    if (e.pointerId !== this.activePointerId) return;
    e.preventDefault();
    this.finish(e, true);
  }

  private cancel(e: PointerEvent) {
    if (e.pointerId !== this.activePointerId) return;
    this.finish(e, false);
  }

  private finish(e: PointerEvent, addFinalPoint: boolean) {
    if (!this.current) return;
    if (addFinalPoint && this.appendPoint(e)) {
      this.drawLiveSegment(this.current);
    }
    if (this.current.length > 1) {
      this.drawLastSegment(this.current);
      this.strokes.push(this.current);
    } else if (this.current.length === 1) {
      this.drawLiveDot(this.current[0]);
      this.strokes.push(this.current);
    }
    try {
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
    } catch {
      // pointerup 後は暗黙解放済みの場合がある。
    }
    this.current = null;
    this.activePointerId = null;
    this.onStrokeEnd?.();
  }

  private drawLiveDot(pt: Point) {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawDot(ctx, pt, 1);
    ctx.restore();
  }

  private drawDot(
    ctx: CanvasRenderingContext2D,
    pt: Point,
    alpha: number,
    blur = 0,
  ) {
    ctx.save();
    ctx.globalAlpha = alpha;
    if (blur > 0) ctx.filter = `blur(${blur.toFixed(2)}px)`;
    ctx.fillStyle = INK_COLOR;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, this.wAt(pt.p) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawLastSegment(s: Stroke) {
    const n = s.length;
    if (n < 3) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.strokeStyle = INK_COLOR;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = 1;
    ctx.lineWidth = this.wAt(s[n - 1].p);
    ctx.beginPath();
    ctx.moveTo(
      (s[n - 2].x + s[n - 1].x) / 2,
      (s[n - 2].y + s[n - 1].y) / 2,
    );
    ctx.lineTo(s[n - 1].x, s[n - 1].y);
    ctx.stroke();
    ctx.restore();
  }

  private wAt(p: number): number {
    return BASE_WIDTH * (0.25 + p * p * 1.8);
  }

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

  private drawStrokeCurve(
    ctx: CanvasRenderingContext2D,
    s: Stroke,
    alpha: number,
    blur = 0,
  ) {
    const n = s.length;
    if (n === 1) {
      this.drawDot(ctx, s[0], alpha, blur);
      return;
    }
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

  /** 書かれたインクを白背景のオフスクリーンキャンバスに焼き込む。 */
  private buildCaptureCanvas(): HTMLCanvasElement {
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
    return off;
  }

  /**
   * インクを PNG base64 で書き出す非同期版。
   * toDataURL は画像全体を同期でメモリ上の文字列にエンコードするため、
   * 書いている最中に走ると UI スレッドが固まってストロークがつっかえる。
   * toBlob + FileReader なら重いエンコードがメインスレッドをブロックしない。
   */
  captureAsync(): Promise<string> {
    const off = this.buildCaptureCanvas();
    return new Promise((resolve, reject) => {
      off.toBlob((blob) => {
        if (!blob) {
          reject(new Error("toBlob returned null"));
          return;
        }
        const fr = new FileReader();
        fr.onload = () =>
          resolve((fr.result as string).split(",")[1]);
        fr.onerror = () => reject(fr.error ?? new Error("FileReader failed"));
        fr.readAsDataURL(blob);
      }, "image/png");
    });
  }
}

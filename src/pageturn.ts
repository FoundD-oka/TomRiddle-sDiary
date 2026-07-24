// ページめくり — 紙の左右端をタップすると、今の紙がしなってめくれ、
// 新しい白紙になる。「めくり＝クリア」: 手書きも会話履歴も残さない。
// トムが返事を書いている最中(canFlip() が false)はめくれない。
//
// めくれる「葉」には、めくる直前の紙面(インクのスナップショット)を貼り、
// その裏から現れる紙は onFlip() で既にクリア済み——という順で見せる。

export class PageTurn {
  /** めくってよいか（possessed 中は false を返す）。 */
  canFlip: () => boolean = () => true;
  /** めくり開始時に一度だけ呼ばれる。ここで紙面と履歴をクリアする。 */
  onFlip: () => void = () => {};

  private page: HTMLElement;
  private snapshot: () => string;
  private animating = false;
  private reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(
    page: HTMLElement,
    edgeLeft: HTMLElement,
    edgeRight: HTMLElement,
    snapshot: () => string,
  ) {
    this.page = page;
    this.snapshot = snapshot;
    edgeRight.addEventListener("click", () => this.flip("fwd"));
    edgeLeft.addEventListener("click", () => this.flip("back"));
  }

  private flip(dir: "fwd" | "back") {
    if (this.animating || !this.canFlip()) return;
    this.animating = true;

    const img = this.snapshot(); // めくる前の紙面を焼き取る
    if (this.reduce) {
      this.onFlip();
      this.animating = false;
      return;
    }

    const leaf = document.createElement("div");
    leaf.className = `leaf leaf--${dir}`;
    leaf.innerHTML =
      `<div class="leaf__front"><img alt="" src="${img}" /><div class="leaf__sheen"></div></div>` +
      `<div class="leaf__back"></div>`;
    this.page.appendChild(leaf);

    // 葉の下の紙面は先にクリアしておく（めくり終わりで白紙が現れる）
    this.onFlip();

    leaf.addEventListener(
      "animationend",
      () => {
        leaf.remove();
        this.animating = false;
      },
      { once: true },
    );
  }
}

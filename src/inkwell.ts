// 上部の「対（つい）の溜まり」— ペンの色＝モードを選ぶインク溜まり。
//   墨(sumi): 書いた字は日記へ吸い込まれ、トムが返事する
//   朱(shu) : 書いた字は残り、余白に註釈(補足解説)が書き添えられる
// 浸けている色は「インクが引かれて」溜まりが小さくなる（使用中＝小さい）。
// にじみは SVG の feTurbulence で紙へ吸われたように荒らし、mix-blend:multiply で
// 紙に染み込ませる。質感は「かすれ」（乾いた筆の飛沫つき）。

export type PenMode = "sumi" | "shu";

export const PEN_COLORS: Record<PenMode, string> = {
  sumi: "#26355c", // 紺墨
  shu: "#9a3225", // 朱
};

const NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  return el;
}

/** 「かすれ」のインク溜まり: 濃い核＋にじむハロー＋周囲の飛沫。 */
function buildDryPool(color: string): SVGSVGElement {
  const svg = svgEl("svg", { viewBox: "0 0 200 200" });
  svg.setAttribute("class", "pool-svg");
  const ellipse = (rx: number, ry: number, op: number, filter: string) =>
    svgEl("ellipse", { cx: 100, cy: 104, rx, ry, fill: color, opacity: op, filter: `url(#${filter})` });

  svg.append(
    ellipse(70, 62, 0.13, "poolHalo"),
    ellipse(48, 44, 0.42, "poolDry"),
    ellipse(32, 30, 0.72, "poolDry"),
  );
  // 乾いた筆の飛沫（かすれ）
  for (let i = 0; i < 8; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 42 + Math.random() * 26;
    svg.append(
      svgEl("circle", {
        cx: (100 + Math.cos(a) * r).toFixed(1),
        cy: (104 + Math.sin(a) * r * 0.9).toFixed(1),
        r: (1 + Math.random() * 2.6).toFixed(1),
        fill: color,
        opacity: (0.28 + Math.random() * 0.4).toFixed(2),
        filter: "url(#poolDry)",
      }),
    );
  }
  return svg;
}

export class InkWell {
  mode: PenMode = "sumi";
  /** 浸け替えたとき呼ばれる。(モード, 色) を受け取る。 */
  onChange: (mode: PenMode, color: string) => void = () => {};
  private dips: HTMLElement[];

  constructor(root: HTMLElement) {
    this.dips = Array.from(root.querySelectorAll<HTMLElement>(".dip"));
    for (const dip of this.dips) {
      const key = dip.dataset.ink as PenMode;
      dip.querySelector(".pool")?.append(buildDryPool(PEN_COLORS[key]));
      dip.addEventListener("click", () => this.select(key));
    }
    this.reflect();
  }

  select(mode: PenMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.reflect();
    this.onChange(mode, PEN_COLORS[mode]);
  }

  private reflect() {
    for (const dip of this.dips) {
      dip.classList.toggle("in-use", dip.dataset.ink === this.mode);
    }
  }
}

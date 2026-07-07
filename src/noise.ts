// 相関ノイズ(1D の値ノイズ + fBm)。
// Math.random() の白色ノイズと違い、近い入力には近い値を返す——
// 手書き特有の「だんだん右上がりになって、ふっと戻る」連続的な揺らぎを作る。
// 自然界の 1/f ゆらぎの近似として、低い周波数のうねりに細かい震えを重ねる。

export class Noise1D {
  private table: Float32Array;

  constructor(seed = 1) {
    this.table = new Float32Array(256);
    let s = seed >>> 0 || 1;
    for (let i = 0; i < 256; i++) {
      // xorshift32
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      this.table[i] = (s / 0xffffffff) * 2 - 1;
    }
  }

  private v(i: number): number {
    return this.table[((i % 256) + 256) % 256];
  }

  /** なめらかな値ノイズ。-1..1 */
  at(x: number): number {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f); // smoothstep 補間
    return this.v(i) * (1 - u) + this.v(i + 1) * u;
  }

  /** fBm(オクターブ重ね合わせ)。-1..1 */
  fbm(x: number, octaves = 3): number {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += this.at(x * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.13; // 整数倍を避けて周期の重なりを防ぐ
    }
    return sum / norm;
  }
}

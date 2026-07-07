// 音の演出 — すべて Web Audio で合成する(音声ファイル無し)。
//   ・環境音: 低いブラウンノイズ = 静かな部屋の空気
//   ・ペンの走り: 帯域ノイズのバースト = トムが紙を引っ掻く音
//   ・吸収: 低域へ沈むスイープ = インクが紙へ還る音
//   ・拒絶: 低く鈍い脈動 = ページがインクを受け付けないとき
//   ・記憶の低鳴り: デチューンした正弦波 = 記憶シーンの底鳴り
// iOS/iPadOS の自動再生制限があるため、最初のタッチで unlock() を呼んで起動する。

export class SoundScape {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private white: AudioBuffer | null = null;
  private brown: AudioBuffer | null = null;
  private userScratchNodes: { src: AudioBufferSourceNode; g: GainNode } | null =
    null;
  private droneNodes: { oscs: OscillatorNode[]; g: GainNode } | null = null;

  /** 最初のユーザー操作で呼ぶ。以降の呼び出しは resume だけ行う。 */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
    this.white = this.makeNoise("white");
    this.brown = this.makeNoise("brown");
    this.startAmbient();
  }

  private makeNoise(type: "white" | "brown"): AudioBuffer {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    if (type === "white") {
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } else {
      // ブラウンノイズ: 白色ノイズの積分(低域が豊かで「部屋の空気」に近い)
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        data[i] = last * 3.5;
      }
    }
    return buf;
  }

  private noiseSource(buf: AudioBuffer, rate = 1): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate;
    return src;
  }

  /** 静かな部屋の空気。unlock 後ずっと極小音量で鳴り続ける。 */
  private startAmbient() {
    const ctx = this.ctx!;
    const src = this.noiseSource(this.brown!, 0.8);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 150;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(0.035, ctx.currentTime + 4);
    src.connect(lp).connect(g).connect(this.master!);
    src.start();
  }

  /** 1 画ぶんのペンの走り書き。durMs は画を書くのにかかる時間。 */
  strokeScratch(durMs: number, intensity = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const dur = durMs / 1000;
    const src = this.noiseSource(this.white!, 0.85 + Math.random() * 0.35);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1300 + Math.random() * 900;
    bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.03 * intensity, t0 + 0.015);
    g.gain.setValueAtTime(0.03 * intensity, t0 + Math.max(dur - 0.03, 0.02));
    g.gain.linearRampToValueAtTime(0, t0 + dur + 0.03);
    src.connect(bp).connect(g).connect(this.master!);
    src.start(t0);
    src.stop(t0 + dur + 0.08);
  }

  /** 署名など、続けて書いている間の持続的な走り書き(揺らぎ付き)。 */
  sustainedScratch(durMs: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const dur = durMs / 1000;
    const src = this.noiseSource(this.white!, 0.95);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1600;
    bp.Q.value = 1.0;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.024, t0 + 0.2);
    g.gain.setValueAtTime(0.024, t0 + dur - 0.3);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    // 筆の緩急を音量の揺らぎで表す
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.3;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.011;
    lfo.connect(lfoG).connect(g.gain);
    src.connect(bp).connect(g).connect(this.master!);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
    lfo.start(t0);
    lfo.stop(t0 + dur + 0.05);
  }

  /** 使用者のペンが接地している間の、ごく控えめな筆記音。 */
  userScratchStart() {
    if (!this.ctx || this.userScratchNodes) return;
    const ctx = this.ctx;
    const src = this.noiseSource(this.white!, 1.0);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1900;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.012, ctx.currentTime + 0.03);
    src.connect(bp).connect(g).connect(this.master!);
    src.start();
    this.userScratchNodes = { src, g };
  }

  userScratchStop() {
    if (!this.ctx || !this.userScratchNodes) return;
    const { src, g } = this.userScratchNodes;
    this.userScratchNodes = null;
    const t = this.ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(0, t + 0.06);
    src.stop(t + 0.1);
  }

  /** インクが紙へ吸い込まれる音。低域へ沈むスイープ。 */
  absorb() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const src = this.noiseSource(this.white!, 0.7);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(750, t0);
    lp.frequency.exponentialRampToValueAtTime(85, t0 + 1.15);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.055, t0 + 0.18);
    g.gain.linearRampToValueAtTime(0, t0 + 1.25);
    src.connect(lp).connect(g).connect(this.master!);
    src.start(t0);
    src.stop(t0 + 1.35);
  }

  /** ページがインクを弾いたときの、低く鈍い脈動。 */
  reject() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(88, t0);
    osc.frequency.exponentialRampToValueAtTime(52, t0 + 0.55);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.07, t0 + 0.06);
    g.gain.linearRampToValueAtTime(0, t0 + 0.7);
    osc.connect(g).connect(this.master!);
    osc.start(t0);
    osc.stop(t0 + 0.75);
  }

  /** 記憶シーンの底鳴り。droneStop まで鳴り続ける。 */
  droneStart() {
    if (!this.ctx || this.droneNodes) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.05, t0 + 2.5);
    g.connect(this.master!);
    const freqs = [52, 52.66, 104.3];
    const gains = [1, 0.8, 0.25];
    const oscs = freqs.map((f, i) => {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = gains[i];
      o.connect(og).connect(g);
      o.start(t0);
      return o;
    });
    this.droneNodes = { oscs, g };
  }

  droneStop() {
    if (!this.ctx || !this.droneNodes) return;
    const { oscs, g } = this.droneNodes;
    this.droneNodes = null;
    const t = this.ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(0, t + 2.2);
    for (const o of oscs) o.stop(t + 2.3);
  }
}

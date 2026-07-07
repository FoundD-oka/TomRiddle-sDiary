// トムが「読んでいる」気配 — 水に落ちた墨が渦を巻くインク(WebGL2 流体シミュ)。
// corner: 判定リクエスト中だけ、右下の隅で小さく渦巻く。
// memory: 記憶シーンでページ全体を呑む大渦(振り付け・解像度が変わる)。
// WebGL2 / 浮動小数レンダーターゲットが使えない環境では available=false になり、
// 呼び出し側は従来の CSS の点にフォールバックする。

const INK = [0.149, 0.208, 0.361]; // #26355c
// Beer–Lambert 的な吸収ベクトル(渦の内部の濃淡づけに使う)
const INK_ABSORB = [1.85, 1.47, 0.81];

interface SplatEvent {
  t: number; x: number; y: number; ang: number; fmul: number; r: number; ink?: number;
}
// 「渦」パターンの振り付け。cycle 秒ごとに再注入して気配を持続させる。
interface Choreo {
  cycle: number; // 秒: この間隔で渦へ墨を注ぎ足す(長め=落ち着いた気配)
  startDelay: number; // ミリ秒: start() からこの分だけ遅れて渦が出はじめる
  timeScale: number; // 流体の進み。小さいほどゆったり渦巻く
  events: SplatEvent[];
}
export type PresenceVariant = "corner" | "memory";

// corner: 判定中に右下の隅で小さく渦巻く「読んでいる」気配
const CORNER_CHOREO: Choreo = {
  cycle: 6.0,
  startDelay: 550,
  timeScale: 0.62,
  events: [
    { t: 0.25, x: 0.5, y: 0.55, ang: 0.0, fmul: 0.3, r: 1.4 },
    { t: 0.5, x: 0.43, y: 0.5, ang: Math.PI / 2, fmul: 0.3, r: 1.1 },
    { t: 0.75, x: 0.57, y: 0.6, ang: -Math.PI / 2, fmul: 0.3, r: 1.1 },
  ],
};
// memory: 記憶シーンでページ全体を呑む大渦
const MEMORY_CHOREO: Choreo = {
  cycle: 4.6,
  startDelay: 0,
  timeScale: 0.8,
  events: [
    { t: 0.2, x: 0.5, y: 0.5, ang: 0.0, fmul: 0.5, r: 2.6 },
    { t: 0.45, x: 0.42, y: 0.46, ang: Math.PI / 2, fmul: 0.45, r: 1.8 },
    { t: 0.7, x: 0.58, y: 0.55, ang: -Math.PI / 2, fmul: 0.45, r: 1.8 },
    { t: 1.1, x: 0.5, y: 0.6, ang: Math.PI, fmul: 0.35, r: 1.5 },
    { t: 1.6, x: 0.47, y: 0.42, ang: -Math.PI / 4, fmul: 0.3, r: 1.3, ink: 0.8 },
  ],
};

const baseVert = `#version 300 es
precision highp float;
in vec2 aPosition;
out vec2 vUv; out vec2 vL; out vec2 vR; out vec2 vT; out vec2 vB;
uniform vec2 texelSize;
void main(){
  vUv = aPosition * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;
const splatFrag = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D uTarget; uniform float aspectRatio; uniform vec3 color;
uniform vec2 point; uniform float radius;
void main(){
  vec2 p = vUv - point; p.x *= aspectRatio;
  vec3 splat = exp(-dot(p,p) / radius) * color;
  fragColor = vec4(texture(uTarget, vUv).xyz + splat, 1.0);
}`;
const advectionFrag = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D uVelocity; uniform sampler2D uSource;
uniform vec2 texelSize; uniform vec2 dyeTexelSize; uniform float dt; uniform float dissipation;
vec4 bilerp(sampler2D s, vec2 uv, vec2 ts){
  vec2 st = uv / ts - 0.5; vec2 iuv = floor(st); vec2 fuv = fract(st);
  vec4 a = texture(s, (iuv + vec2(0.5,0.5)) * ts);
  vec4 b = texture(s, (iuv + vec2(1.5,0.5)) * ts);
  vec4 c = texture(s, (iuv + vec2(0.5,1.5)) * ts);
  vec4 d = texture(s, (iuv + vec2(1.5,1.5)) * ts);
  return mix(mix(a,b,fuv.x), mix(c,d,fuv.x), fuv.y);
}
void main(){
  vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
  fragColor = bilerp(uSource, coord, dyeTexelSize) / (1.0 + dissipation * dt);
}`;
const divergenceFrag = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB; out vec4 fragColor;
uniform sampler2D uVelocity;
void main(){
  float L = texture(uVelocity, vL).x; float R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y; float B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if(vL.x < 0.0){ L = -C.x; } if(vR.x > 1.0){ R = -C.x; }
  if(vT.y > 1.0){ T = -C.y; } if(vB.y < 0.0){ B = -C.y; }
  fragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;
const curlFrag = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB; out vec4 fragColor;
uniform sampler2D uVelocity;
void main(){
  float L = texture(uVelocity, vL).y; float R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x; float B = texture(uVelocity, vB).x;
  fragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`;
const vorticityFrag = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB; out vec4 fragColor;
uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float curl; uniform float dt;
void main(){
  float L = texture(uCurl, vL).x; float R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x; float B = texture(uCurl, vB).x; float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001; force *= curl * C; force.y *= -1.0;
  vec2 vel = texture(uVelocity, vUv).xy + force * dt;
  fragColor = vec4(clamp(vel, -1000.0, 1000.0), 0.0, 1.0);
}`;
const pressureFrag = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB; out vec4 fragColor;
uniform sampler2D uPressure; uniform sampler2D uDivergence;
void main(){
  float L = texture(uPressure, vL).x; float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x; float B = texture(uPressure, vB).x;
  fragColor = vec4((L + R + B + T - texture(uDivergence, vUv).x) * 0.25, 0.0, 0.0, 1.0);
}`;
const gradientFrag = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB; out vec4 fragColor;
uniform sampler2D uPressure; uniform sampler2D uVelocity;
void main(){
  float L = texture(uPressure, vL).x; float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x; float B = texture(uPressure, vB).x;
  vec2 vel = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
  fragColor = vec4(vel, 0.0, 1.0);
}`;
const clearFrag = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D uTexture; uniform float value;
void main(){ fragColor = value * texture(uTexture, vUv); }`;
// 表示: 密度から不透明度を出し、インク色だけを紙の上に(乗算前提の premultiplied)
const displayFrag = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D uTexture; uniform vec3 ink; uniform float globalAlpha;
void main(){
  vec3 density = texture(uTexture, vUv).rgb;
  float d = (density.r + density.g + density.b) * 0.3333;
  float a = clamp(1.0 - exp(-d * 2.0), 0.0, 1.0);
  // 四角い縁で墨が切れないよう、枠の内側でしっかり消えるビネット
  // (拡大した枠の中に墨が収まり、縁で処理が切れて見えないようにする)
  vec2 m = abs(vUv - 0.5);
  float edge = (1.0 - smoothstep(0.15, 0.40, m.x)) * (1.0 - smoothstep(0.15, 0.40, m.y));
  edge *= 1.0 - smoothstep(0.30, 0.48, length(m)); // 角も丸く落とす
  a *= edge * globalAlpha;
  fragColor = vec4(ink * a, a);
}`;

interface Prog { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null>; }
interface FBO {
  texture: WebGLTexture; fbo: WebGLFramebuffer; width: number; height: number;
  texelSizeX: number; texelSizeY: number; attach(id: number): number;
}
interface DoubleFBO {
  width: number; height: number; texelSizeX: number; texelSizeY: number;
  read: FBO; write: FBO; swap(): void;
}

export class PresenceInk {
  available = false;
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private dpr: number;
  private progs!: Record<string, Prog>;
  private cur: Prog | null = null;
  private dye!: DoubleFBO;
  private velocity!: DoubleFBO;
  private divergence!: FBO;
  private curlFBO!: FBO;
  private pressure!: DoubleFBO;
  private linear = false;

  private config = {
    SIM_RES: 56, DYE_RES: 240, DENSITY_DISSIPATION: 0.34, VELOCITY_DISSIPATION: 0.25,
    PRESSURE: 0.8, PRESSURE_ITERATIONS: 20, CURL: 40, SPLAT_RADIUS: 0.0030,
    SPLAT_FORCE: 3800, INK: 1.15,
  };
  private choreo: Choreo = CORNER_CHOREO;
  private baseDissipation = 0.34;

  private state: "idle" | "active" | "fading" = "idle";
  private raf = 0;
  private last = 0;
  private cycleStart = 0;
  private fired = new Set<number>();
  private fadeUntil = 0;
  private globalAlpha = 0;
  private begun = false;   // 遅延後、実際に渦を出し始めたか
  private beginAt = 0;     // 渦を出し始める時刻

  constructor(canvas: HTMLCanvasElement, variant: PresenceVariant = "corner") {
    this.canvas = canvas;
    if (variant === "memory") {
      this.choreo = MEMORY_CHOREO;
      // フルスクリーンで見応えが出るよう、解像度と勢いを上げる
      Object.assign(this.config, {
        SIM_RES: 88, DYE_RES: 448, SPLAT_RADIUS: 0.004,
        SPLAT_FORCE: 4600, INK: 1.05, CURL: 44, DENSITY_DISSIPATION: 0.28,
      });
      this.baseDissipation = this.config.DENSITY_DISSIPATION;
    }
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const gl = canvas.getContext("webgl2", {
      alpha: true, depth: false, stencil: false, antialias: false,
      premultipliedAlpha: true, preserveDrawingBuffer: false,
    });
    if (!gl) return;
    if (!gl.getExtension("EXT_color_buffer_float")) return;
    this.linear = !!(gl.getExtension("OES_texture_half_float_linear") ||
      gl.getExtension("OES_texture_float_linear"));
    this.gl = gl;
    try {
      this.progs = {
        splat: this.program(baseVert, splatFrag),
        advection: this.program(baseVert, advectionFrag),
        divergence: this.program(baseVert, divergenceFrag),
        curl: this.program(baseVert, curlFrag),
        vorticity: this.program(baseVert, vorticityFrag),
        pressure: this.program(baseVert, pressureFrag),
        gradient: this.program(baseVert, gradientFrag),
        clear: this.program(baseVert, clearFrag),
        display: this.program(baseVert, displayFrag),
      };
    } catch {
      this.gl = null;
      return;
    }
    this.setupQuad();
    this.resize();
    this.initFramebuffers();
    window.addEventListener("resize", () => { if (this.resize()) this.initFramebuffers(); });
    this.available = true;
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl!;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || "shader");
    return sh;
  }
  private program(vs: string, fs: string): Prog {
    const gl = this.gl!;
    const p = gl.createProgram()!;
    gl.attachShader(p, this.compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this.compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "aPosition");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link");
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i)!.name;
      uniforms[name] = gl.getUniformLocation(p, name);
    }
    return { program: p, uniforms };
  }
  private setupQuad() {
    const gl = this.gl!;
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    const idx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
  }
  private use(p: Prog) { this.cur = p; this.gl!.useProgram(p.program); }
  private u1i(n: string, v: number) { this.gl!.uniform1i(this.cur!.uniforms[n]!, v); }
  private u1f(n: string, v: number) { this.gl!.uniform1f(this.cur!.uniforms[n]!, v); }
  private u2f(n: string, a: number, b: number) { this.gl!.uniform2f(this.cur!.uniforms[n]!, a, b); }
  private u3f(n: string, a: number, b: number, c: number) { this.gl!.uniform3f(this.cur!.uniforms[n]!, a, b, c); }
  private blit(t: FBO | null) {
    const gl = this.gl!;
    if (t == null) { gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
    else { gl.viewport(0, 0, t.width, t.height); gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }
  private createFBO(w: number, h: number, filter: number): FBO {
    const gl = this.gl!;
    gl.activeTexture(gl.TEXTURE0);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h); gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture: tex, fbo, width: w, height: h, texelSizeX: 1 / w, texelSizeY: 1 / h,
      attach: (id: number) => { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, tex); return id; },
    };
  }
  private createDoubleFBO(w: number, h: number, filter: number): DoubleFBO {
    let f1 = this.createFBO(w, h, filter), f2 = this.createFBO(w, h, filter);
    return {
      width: w, height: h, texelSizeX: 1 / w, texelSizeY: 1 / h,
      get read() { return f1; }, set read(v) { f1 = v; },
      get write() { return f2; }, set write(v) { f2 = v; },
      swap() { const t = f1; f1 = f2; f2 = t; },
    };
  }
  private getResolution(res: number) {
    const gl = this.gl!;
    let ar = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (ar < 1) ar = 1 / ar;
    const min = Math.round(res), max = Math.round(res * ar);
    return gl.drawingBufferWidth > gl.drawingBufferHeight ? { width: max, height: min } : { width: min, height: max };
  }
  private initFramebuffers() {
    const gl = this.gl!;
    const sim = this.getResolution(this.config.SIM_RES);
    const dr = this.getResolution(this.config.DYE_RES);
    const f = this.linear ? gl.LINEAR : gl.NEAREST;
    this.dye = this.createDoubleFBO(dr.width, dr.height, f);
    this.velocity = this.createDoubleFBO(sim.width, sim.height, gl.NEAREST);
    this.divergence = this.createFBO(sim.width, sim.height, gl.NEAREST);
    this.curlFBO = this.createFBO(sim.width, sim.height, gl.NEAREST);
    this.pressure = this.createDoubleFBO(sim.width, sim.height, gl.NEAREST);
  }
  private resize(): boolean {
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * this.dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; return true; }
    return false;
  }
  private splat(ev: SplatEvent) {
    const gl = this.gl!, c = this.config;
    let px = ev.x, py = ev.y;
    const f = c.SPLAT_FORCE * ev.fmul;
    const dx = Math.cos(ev.ang) * f, dy = Math.sin(ev.ang) * f;
    this.use(this.progs.splat);
    this.u1i("uTarget", this.velocity.read.attach(0));
    this.u1f("aspectRatio", this.canvas.width / this.canvas.height);
    this.u2f("point", px, py);
    this.u3f("color", dx, dy, 0);
    this.u1f("radius", c.SPLAT_RADIUS * ev.r);
    this.blit(this.velocity.write); this.velocity.swap();

    this.u1i("uTarget", this.dye.read.attach(0));
    const k = c.INK * (ev.ink ?? 1);
    this.u3f("color", INK_ABSORB[0] * k, INK_ABSORB[1] * k, INK_ABSORB[2] * k);
    this.blit(this.dye.write); this.dye.swap();
  }
  private step(dt: number) {
    const gl = this.gl!, c = this.config, v = this.velocity;
    gl.disable(gl.BLEND);
    this.use(this.progs.curl);
    this.u2f("texelSize", v.texelSizeX, v.texelSizeY);
    this.u1i("uVelocity", v.read.attach(0)); this.blit(this.curlFBO);

    this.use(this.progs.vorticity);
    this.u2f("texelSize", v.texelSizeX, v.texelSizeY);
    this.u1i("uVelocity", v.read.attach(0)); this.u1i("uCurl", this.curlFBO.attach(1));
    this.u1f("curl", c.CURL); this.u1f("dt", dt);
    this.blit(v.write); v.swap();

    this.use(this.progs.divergence);
    this.u2f("texelSize", v.texelSizeX, v.texelSizeY);
    this.u1i("uVelocity", v.read.attach(0)); this.blit(this.divergence);

    this.use(this.progs.clear);
    this.u1i("uTexture", this.pressure.read.attach(0)); this.u1f("value", c.PRESSURE);
    this.blit(this.pressure.write); this.pressure.swap();

    this.use(this.progs.pressure);
    this.u2f("texelSize", v.texelSizeX, v.texelSizeY);
    this.u1i("uDivergence", this.divergence.attach(0));
    for (let i = 0; i < c.PRESSURE_ITERATIONS; i++) {
      this.u1i("uPressure", this.pressure.read.attach(1)); this.blit(this.pressure.write); this.pressure.swap();
    }
    this.use(this.progs.gradient);
    this.u2f("texelSize", v.texelSizeX, v.texelSizeY);
    this.u1i("uPressure", this.pressure.read.attach(0)); this.u1i("uVelocity", v.read.attach(1));
    this.blit(v.write); v.swap();

    this.use(this.progs.advection);
    this.u2f("texelSize", v.texelSizeX, v.texelSizeY);
    this.u2f("dyeTexelSize", v.texelSizeX, v.texelSizeY);
    const vid = v.read.attach(0);
    this.u1i("uVelocity", vid); this.u1i("uSource", vid); this.u1f("dt", dt);
    this.u1f("dissipation", c.VELOCITY_DISSIPATION);
    this.blit(v.write); v.swap();

    this.u2f("dyeTexelSize", this.dye.texelSizeX, this.dye.texelSizeY);
    this.u1i("uVelocity", v.read.attach(0)); this.u1i("uSource", this.dye.read.attach(1));
    this.u1f("dissipation", c.DENSITY_DISSIPATION);
    this.blit(this.dye.write); this.dye.swap();
  }
  private render() {
    const gl = this.gl!;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied over transparent
    gl.clearColor(0, 0, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.use(this.progs.display);
    this.u1i("uTexture", this.dye.read.attach(0));
    this.u3f("ink", INK[0], INK[1], INK[2]);
    this.u1f("globalAlpha", this.globalAlpha);
    this.blit(null);
  }
  private rinse() {
    const gl = this.gl!;
    for (const f of [this.dye.read, this.dye.write, this.velocity.read, this.velocity.write]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  /** 気配を出す(判定リクエスト開始時)。少し遅れて渦が出はじめる。 */
  start() {
    if (!this.available) return;
    if (this.state === "idle") { this.rinse(); this.globalAlpha = 0; this.begun = false; }
    this.state = "active";
    this.beginAt = performance.now() + this.choreo.startDelay;
    this.fired.clear();
    if (!this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame(this.loop); }
  }
  /** 気配を消す(判定完了・返事開始時) */
  stop() {
    if (!this.available || this.state === "idle") return;
    if (!this.begun) {
      // まだ遅延中で渦を出していない → 何も見せずに終了(一瞬の判定でチラつかせない)
      this.state = "idle";
      this.canvas.style.visibility = "hidden";
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
      return;
    }
    this.state = "fading";
    this.fadeUntil = performance.now() + 1600;
    this.config.DENSITY_DISSIPATION = 2.6; // 墨を早く紙へ引かせる
  }

  private loop = (now: number) => {
    let dt = (now - this.last) / 1000; dt = Math.min(dt, 1 / 60); this.last = now;

    if (this.state === "active") {
      if (!this.begun) {
        if (now < this.beginAt) { this.raf = requestAnimationFrame(this.loop); return; }
        this.begun = true;
        this.cycleStart = now;
        this.canvas.style.visibility = "visible";
      }
      this.globalAlpha = Math.min(1, this.globalAlpha + dt / 1.1); // 1.1秒でゆっくり出現
      let lt = (now - this.cycleStart) / 1000;
      if (lt >= this.choreo.cycle) { this.cycleStart = now; this.fired.clear(); lt = 0; }
      const events = this.choreo.events;
      for (let i = 0; i < events.length; i++) {
        if (!this.fired.has(i) && lt >= events[i].t) { this.fired.add(i); this.splat(events[i]); }
      }
      this.step(dt * this.choreo.timeScale);
      this.render();
    } else if (this.state === "fading") {
      this.globalAlpha = Math.max(0, this.globalAlpha - dt / 0.9); // 0.9秒で消える
      this.step(dt * this.choreo.timeScale);
      this.render();
      if (now >= this.fadeUntil) {
        this.state = "idle";
        this.config.DENSITY_DISSIPATION = this.baseDissipation;
        this.rinse();
        this.globalAlpha = 0;
        this.begun = false;
        this.canvas.style.visibility = "hidden";
        cancelAnimationFrame(this.raf); this.raf = 0;
        return;
      }
    }
    this.raf = requestAnimationFrame(this.loop);
  };
}

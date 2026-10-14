// Motor de reconhecimento de Libras: câmera → pontos do MediaPipe → corte do sinal → palavra.
// As contas de características são idênticas às de preparo/construir.py (testado por paridade).
import { FilesetResolver, HandLandmarker, PoseLandmarker, DrawingUtils }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const PREFILTRO = 80;           // quantos candidatos da biblioteca passam para a comparação fina (DTW)
const FIM_INATIVO_MS = 300;     // mãos abaixadas por esse tempo = fim do sinal
const FIM_PARADO_MS = 350;      // mãos paradas por esse tempo = fim do sinal
const JANELA_MS = 300;          // janela para medir se a mão está se mexendo
const LIMIAR_MOVIMENTO = 0.12;  // deslocamento (larguras de ombro) na janela acima disso = mexendo
const SINAL_MIN_MS = 400, SINAL_MAX_MS = 3000;
const MOVIMENTO_MIN = 0.35;     // trajeto mínimo do pulso (em larguras de ombro) para valer como sinal
const MAOS_VISTAS_MIN = 0.5;    // dedos visíveis em pelo menos metade do movimento (coçar, celular, óculos costumam falhar)
const RAZAO_MAX = 0.95;         // 1º lugar precisa ganhar do 2º com folga; empate = provavelmente não é sinal
const TALVEZ = 1.3;             // até tolerância × 1.3 ainda mostra "Não tive certeza"; acima disso, ignora calado
const STORE_KEY = "maos-que-falam-v2";

export class MotorLibras {
  constructor({ video, canvas }) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas?.getContext("2d");
    this.cfg = { frames: 12, dim: 86, pesos: [2.0, 1.0, 1.5], alturaAtiva: 1.6 };
    this.lib = null;
    this.meus = carregarMeus();
    this.reconhecendo = false;
    this.tolerancia = 0.30;
    this.historico = [];           // últimos movimentos analisados (para ajuste e diagnóstico)
    this.vocabulario = "essencial"; // "essencial" (palavras do dia a dia, acerta mais) ou "completo"
    this.onSinal = () => {};       // ({palavra|null, dist, alternativas, seq}) a cada sinal percebido
    this.onEstado = () => {};      // ("longe" | "pronto" | "lendo") quando muda
    this._seg = null;
    this._espera = null;
    this._ultimoTempo = -1;
    this._rodando = false;
  }

  // ---------- carregamento ----------
  async carregar() {
    const [_, info] = await Promise.all([this._modelos(), this._biblioteca()]);
    return info;
  }

  async _modelos() {
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
    const base = "https://storage.googleapis.com/mediapipe-models/";
    const criar = async (delegate) => ({
      delegate,
      hands: await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: base + "hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", delegate },
        runningMode: "VIDEO", numHands: 2,
        minHandDetectionConfidence: 0.3, minHandPresenceConfidence: 0.3,
      }),
      pose: await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: base + "pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task", delegate },
        runningMode: "VIDEO", numPoses: 1,
      }),
    });
    // Mede quanto cada opção leva por imagem: em alguns computadores a placa de vídeo é bem mais lenta que o processador.
    const teste = document.createElement("canvas");
    teste.width = 640; teste.height = 480;
    const g = teste.getContext("2d");
    g.fillStyle = "#777"; g.fillRect(0, 0, 640, 480);
    const medir = (m) => {
      m.hands.detectForVideo(teste, performance.now()); m.pose.detectForVideo(teste, performance.now());
      const t = performance.now();
      for (let i = 0; i < 4; i++) { m.hands.detectForVideo(teste, performance.now()); m.pose.detectForVideo(teste, performance.now()); }
      return (performance.now() - t) / 4;
    };
    // A escolha fica guardada: a medição (principalmente da placa de vídeo) pode levar mais de um minuto.
    let lembrado = null;
    try { lembrado = localStorage.getItem("mqf-delegate"); } catch {}
    const ordem = lembrado === "GPU" || lembrado === "CPU" ? [lembrado] : ["GPU", "CPU"];
    const opcoes = [];
    for (const d of ordem) {
      try { const m = await criar(d); m.ms = medir(m); opcoes.push(m); } catch {}
    }
    if (!opcoes.length && lembrado) {
      try { const m = await criar(lembrado === "GPU" ? "CPU" : "GPU"); m.ms = medir(m); opcoes.push(m); } catch {}
    }
    if (!opcoes.length) throw new Error("não consegui iniciar o MediaPipe");
    opcoes.sort((a, b) => a.ms - b.ms);
    for (const m of opcoes.slice(1)) { m.hands.close(); m.pose.close(); }
    try { localStorage.setItem("mqf-delegate", opcoes[0].delegate); } catch {}
    ({ hands: this.hands, pose: this.pose } = opcoes[0]);
    this.desempenho = { delegate: opcoes[0].delegate, msPorImagem: Math.round(opcoes[0].ms),
                        testes: opcoes.map((m) => `${m.delegate} ${Math.round(m.ms)} ms`).join(", ") };
  }

  async _biblioteca() {
    try {
      const [meta, bin] = await Promise.all([
        fetch("biblioteca.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
        fetch("biblioteca.bin").then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
      ]);
      this.cfg = { frames: meta.frames, dim: meta.dim, pesos: meta.pesos, alturaAtiva: meta.alturaAtiva };
      const essencial = new Uint8Array(meta.palavras.length);
      for (const i of meta.essenciais || []) essencial[i] = 1;
      this.lib = {
        data: new Int8Array(bin), n: meta.rotulos.length, escala: meta.escala,
        rotulos: Int32Array.from(meta.rotulos), palavras: meta.palavras, essencial,
      };
      return { palavras: meta.palavras.length, videos: meta.rotulos.length, fonte: meta.fonte,
               essenciais: (meta.essenciais || []).length };
    } catch {
      return null;
    }
  }

  get palavras() { return this.lib?.palavras ?? []; }

  // ---------- laço da câmera ----------
  ligar() {
    if (this._rodando) return;
    this._rodando = true;
    const passo = () => {
      if (!this._rodando) return;
      const v = this.video;
      if (this.hands && v.readyState >= 2 && v.currentTime !== this._ultimoTempo) {
        this._ultimoTempo = v.currentTime;
        const agora = performance.now();
        const rp = this.pose.detectForVideo(v, agora);
        const rh = this.hands.detectForVideo(v, agora);
        this._desenhar(rh, rp);
        if (this.reconhecendo || this._espera) {
          const pose = rp.landmarks?.[0];
          const r = quadro(pose, rh.landmarks || [], v.videoWidth, v.videoHeight, this.cfg.alturaAtiva);
          this._segmentar(agora, r);
          // Ombros fora da imagem (ou pouco confiáveis) = pessoa perto demais da câmera.
          const ombros = pose && [11, 12].every((i) => (pose[i].visibility ?? 1) > 0.5 && pose[i].y < 0.98);
          this._avisar(!ombros ? "longe" : this._seg ? "lendo" : "pronto");
        }
      }
      requestAnimationFrame(passo);
    };
    requestAnimationFrame(passo);
  }

  desligar() { this._rodando = false; this._limpar(); }

  _avisar(estado) {
    if (estado === this._estado) return;
    this._estado = estado;
    this.onEstado(estado);
  }

  _limpar() { if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }

  _desenhar(rh, rp) {
    if (!this.ctx) return;
    const v = this.video;
    if (this.canvas.width !== v.videoWidth) { this.canvas.width = v.videoWidth; this.canvas.height = v.videoHeight; }
    this._limpar();
    if (!this.reconhecendo && !this._espera) return;
    const du = new DrawingUtils(this.ctx);
    for (const lm of rp.landmarks || []) {
      du.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: "rgba(255,255,255,.35)", lineWidth: 2 });
    }
    for (const lm of rh.landmarks || []) {
      du.drawConnectors(lm, HandLandmarker.HAND_CONNECTIONS, { color: "#4c8dff", lineWidth: 4 });
      du.drawLandmarks(lm, { color: "#ffffff", fillColor: "#1f6feb", radius: 4 });
    }
  }

  // ---------- corte automático por movimento ----------
  // O sinal começa quando a mão (levantada) começa a se mexer e termina quando ela abaixa
  // ou fica parada por um instante. Mão parada no começo e no fim é cortada fora.
  _movimento(seg, agora) {
    // Maior deslocamento de cada mão na janela recente (em larguras de ombro).
    // Câmera lenta (poucas imagens por segundo): usa as 3 últimas imagens, seja qual for o intervalo.
    let janela = seg.frames.filter((x) => agora - x.t <= JANELA_MS);
    if (janela.length < 3) janela = seg.frames.slice(-3);
    if (janela.length < 2) return { m: 0, desde: agora };
    let m = 0;
    for (let s = 0; s < 2; s++) {
      const ps = janela.map((x) => x.posicoes[s]).filter(Boolean);
      if (ps.length < 2) continue;
      for (const p of ps) m = Math.max(m, Math.hypot(p[0] - ps[0][0], p[1] - ps[0][1]));
    }
    return { m, desde: janela[0].t };
  }

  _segmentar(agora, r) {
    const ativo = !!r?.ativo;
    let seg = this._seg;
    if (!seg) {
      if (!ativo) return;
      seg = this._seg = { inicio: agora, frames: [], inativoDesde: 0, paradoDesde: 0, movendoDesde: 0,
                          trajeto: 0, ultimas: null };
    }
    if (r) seg.frames.push({ t: agora, pos: r.pos, forma: r.forma, ativo, posicoes: r.posicoes });

    if (r?.posicoes) {
      let passo = 0;
      if (seg.ultimas) for (let s = 0; s < 2; s++) {
        const a = r.posicoes[s], b = seg.ultimas[s];
        if (a && b) passo = Math.max(passo, Math.hypot(a[0] - b[0], a[1] - b[1]));
      }
      if (seg.movendoDesde) seg.trajeto += passo;
      seg.ultimas = r.posicoes;
    }
    const mov = this._movimento(seg, agora);
    if (mov.m >= LIMIAR_MOVIMENTO) {
      if (!seg.movendoDesde) seg.movendoDesde = mov.desde;   // o movimento começou no início da janela
      seg.paradoDesde = 0;
    } else if (!seg.paradoDesde) {
      seg.paradoDesde = agora;
      seg.paradoJanela = mov.desde;                          // a mão já estava parada desde o início da janela
    }
    if (!ativo) { if (!seg.inativoDesde) seg.inativoDesde = agora; } else seg.inativoDesde = 0;

    // Mão levantada mas parada desde o começo (ex.: apoiada): descarta e espera mexer.
    if (!seg.movendoDesde && seg.paradoDesde && agora - seg.inicio > 1500) { this._seg = null; return; }

    const dur = agora - (seg.movendoDesde || seg.inicio);
    const abaixou = seg.inativoDesde && agora - seg.inativoDesde > FIM_INATIVO_MS;
    const parou = seg.movendoDesde && seg.paradoDesde && agora - seg.paradoDesde > FIM_PARADO_MS && dur > 500;
    if (!abaixou && !parou && dur <= SINAL_MAX_MS) return;
    this._seg = null;
    if (!seg.movendoDesde) return;

    // Recorta: do começo do movimento até abaixar/parar (com uma folga curta de mão parada no fim).
    const fimT = parou ? Math.max(seg.paradoJanela + 200, seg.movendoDesde) : abaixou ? seg.inativoDesde : agora;
    const fr = seg.frames.filter((x) => x.t >= seg.movendoDesde - 100 && x.t <= fimT);
    const i0 = fr.findIndex((x) => x.ativo);
    let i1 = -1;
    for (let i = fr.length - 1; i >= 0; i--) if (fr[i].ativo) { i1 = i; break; }
    if (i0 < 0) return;
    const util = fr.slice(i0, i1 + 1);
    const durSinal = util.length ? util[util.length - 1].t - util[0].t : 0;
    const maosVistas = util.filter((x) => x.forma[0] || x.forma[1]).length / Math.max(1, util.length);
    const info = { fim: abaixou ? "abaixou" : parou ? "parou" : "limite", dur: Math.round(durSinal), maosVistas: +maosVistas.toFixed(2), trajeto: +seg.trajeto.toFixed(2) };
    let motivo = null;
    if (util.length < 3 || durSinal < SINAL_MIN_MS) motivo = "curto demais";
    else if (seg.trajeto < MOVIMENTO_MIN) motivo = "pouco movimento";
    else if (maosVistas < MAOS_VISTAS_MIN) motivo = "dedos pouco visíveis";
    if (motivo) { this._anotar({ ...info, ignorado: motivo }); return; }
    const paraSeq = (frames) => reamostrar(preencher(frames), this.cfg.frames).map((x) => vetorizar(x, this.cfg.pesos));
    const seq = paraSeq(util);

    if (this._espera) { const w = this._espera; this._espera = null; w(seq); return; }
    if (!this.reconhecendo) return;
    // Sinal com repetição feito por mais tempo que no dicionário: testa também só o começo.
    const seqs = [seq];
    for (const ms of [1200, 1800]) {
      const corte = util.filter((x) => x.t - util[0].t <= ms);
      if (durSinal > ms + 300 && corte.length >= 3) seqs.push(paraSeq(corte));
    }
    this._classificar(seqs, info);
  }

  _anotar(x) {
    this.historico.push({ hora: new Date().toLocaleTimeString("pt-BR"), ...x });
    if (this.historico.length > 50) this.historico.shift();
  }

  // ---------- comparação ----------
  _libSeq(i) {
    const { data, escala } = this.lib, { frames, dim } = this.cfg, off = i * frames * dim, out = [];
    for (let t = 0; t < frames; t++) {
      const fr = new Array(dim);
      for (let k = 0; k < dim; k++) fr[k] = data[off + t * dim + k] / escala;
      out.push(fr);
    }
    return out;
  }

  ranking(seq) {
    const melhor = new Map();
    const anota = (p, d) => { if (!melhor.has(p) || d < melhor.get(p)) melhor.set(p, d); };
    const { frames, dim } = this.cfg, tam = frames * dim;
    for (const consulta of [seq, espelhar(seq, dim)]) {
      if (this.lib) {
        // 1º passo rápido contra todos os vídeos; 2º passo fino (DTW) só nos mais parecidos.
        const { data, n, escala, rotulos, essencial } = this.lib;
        const soEssencial = this.vocabulario === "essencial" && essencial.some((x) => x);
        const q = new Float32Array(tam);
        for (let t = 0; t < frames; t++) for (let k = 0; k < dim; k++) q[t * dim + k] = consulta[t][k] * escala;
        const d = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          if (soEssencial && !essencial[rotulos[i]]) { d[i] = Infinity; continue; }
          let s = 0;
          const off = i * tam;
          for (let k = 0; k < tam; k++) { const x = q[k] - data[off + k]; s += x * x; }
          d[i] = s;
        }
        const idx = Array.from(d.keys()).filter((i) => d[i] !== Infinity).sort((a, b) => d[a] - d[b]).slice(0, PREFILTRO);
        for (const i of idx) anota(this.lib.palavras[this.lib.rotulos[i]], dtw(consulta, this._libSeq(i)));
      }
      for (const s of this.meus) anota(s.label, dtw(consulta, s.seq));
    }
    return [...melhor].sort((a, b) => a[1] - b[1]);
  }

  _classificar(seqs, info = {}) {
    // Vários recortes do mesmo movimento (inteiro e só o começo): fica com o que mais se parece com um sinal.
    let r = [], seq = null, recorte = 0;
    seqs.forEach((s, i) => {
      const ri = this.ranking(s);
      if (ri.length && (!r.length || ri[0][1] < r[0][1])) { r = ri; seq = s; recorte = i; }
    });
    if (!r.length) return;
    info = { ...info, recorte: ["inteiro", "1,2 s", "1,8 s"][recorte] };
    const [palavra, dist] = r[0];
    const razao = r.length > 1 ? dist / r[1][1] : 0;
    const aceito = dist <= this.tolerancia && razao <= RAZAO_MAX;
    const talvez = !aceito && dist <= this.tolerancia * TALVEZ && razao <= 0.99;
    this._anotar({ ...info, melhor: palavra, dist: +dist.toFixed(3), razao: +razao.toFixed(3),
                   resultado: aceito ? "aceito" : talvez ? "talvez" : "ignorado" });
    if (!aceito && !talvez) return;     // longe de qualquer sinal conhecido: provavelmente não é Libras
    this.onSinal({
      palavra: aceito ? palavra : null, dist, seq,
      alternativas: r.slice(aceito ? 1 : 0, aceito ? 5 : 4).map(([p]) => p),
    });
  }

  // ---------- sinais próprios ----------
  proximoSinal(timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this._espera = null; this._seg = null; resolve(null); }, timeoutMs);
      this._seg = null;
      this._espera = (seq) => { clearTimeout(timer); resolve(seq); };
    });
  }

  aprender(palavra, seq) {
    this.meus.push({ label: palavra, seq });
    salvarMeus(this.meus);
  }

  removerMeus(palavra) { this.meus = this.meus.filter((s) => s.label !== palavra); salvarMeus(this.meus); }
  apagarMeus() { this.meus = []; salvarMeus(this.meus); }
  importar(samples) { this.meus.push(...samples); salvarMeus(this.meus); }
  exportar() { return JSON.stringify({ samples: this.meus }); }
}

// ---------- características (idêntico a quadro/preencher/vetorizar em preparo/construir.py) ----------
export function quadro(pose, hands, W, H, alturaAtiva) {
  if (!pose) return null;
  const px = (p) => [p.x * W, p.y * H];
  const vis = (p) => (p.visibility ?? 1);
  const oe = px(pose[11]), od = px(pose[12]);
  const centro = [(oe[0] + od[0]) / 2, (oe[1] + od[1]) / 2];
  const larg = Math.hypot(oe[0] - od[0], oe[1] - od[1]);
  if (larg < 1e-6) return null;
  const pulsos = [px(pose[15]), px(pose[16])];   // 15 = pulso esquerdo da pessoa, 16 = direito
  const visib = [vis(pose[15]), vis(pose[16])];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  const maos = hands.map((lm) => lm.map(px));
  let lados = [null, null];
  if (maos.length === 1) {
    lados[dist(maos[0][0], pulsos[0]) <= dist(maos[0][0], pulsos[1]) ? 0 : 1] = maos[0];
  } else if (maos.length >= 2) {
    const [a, b] = maos;
    const direto = dist(a[0], pulsos[0]) + dist(b[0], pulsos[1]);
    const trocado = dist(a[0], pulsos[1]) + dist(b[0], pulsos[0]);
    lados = direto <= trocado ? [a, b] : [b, a];
  }

  const pos = [], forma = [], posicoes = [];
  let ativo = false;
  for (let s = 0; s < 2; s++) {
    const mao = lados[s];
    let p;
    if (mao) p = [(mao[0][0] - centro[0]) / larg, (mao[0][1] - centro[1]) / larg];
    else if (visib[s] > 0.5) p = [(pulsos[s][0] - centro[0]) / larg, (pulsos[s][1] - centro[1]) / larg];
    else p = [0, 3];
    const levantada = p[1] < alturaAtiva && (mao || visib[s] > 0.5);
    if (levantada) ativo = true;
    posicoes.push(levantada ? p : null);
    pos.push(p);
    if (mao) {
      const palma = dist(mao[9], mao[0]) || 1e-6;
      const fm = [];
      for (let j = 1; j < 21; j++) fm.push((mao[j][0] - mao[0][0]) / palma, (mao[j][1] - mao[0][1]) / palma);
      forma.push(fm);
    } else forma.push(null);
  }
  return { pos, forma, ativo, posicoes };
}

// Mão perdida em alguns quadros: copia a forma do quadro mais próximo em que ela foi vista.
export function preencher(frames) {
  const out = frames.map((x) => ({ ...x, forma: [...x.forma] }));
  for (let s = 0; s < 2; s++) {
    const vistos = [];
    frames.forEach((x, i) => { if (x.forma[s]) vistos.push(i); });
    if (!vistos.length) continue;
    out.forEach((x, i) => {
      if (x.forma[s]) return;
      let melhor = vistos[0];
      for (const v of vistos) if (Math.abs(v - i) < Math.abs(melhor - i)) melhor = v;
      x.forma[s] = frames[melhor].forma[s];
    });
  }
  return out;
}

export function vetorizar(x, [wPos, wForma, wPres]) {
  const f = [];
  for (let s = 0; s < 2; s++) {
    f.push(x.pos[s][0] * wPos, x.pos[s][1] * wPos);
    if (x.forma[s]) { for (const v of x.forma[s]) f.push(v * wForma); f.push(wPres); }
    else { for (let j = 0; j < 40; j++) f.push(0); f.push(0); }
  }
  return f;
}

export function reamostrar(frames, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(frames[Math.round((i * (frames.length - 1)) / (n - 1))]);
  return out;
}

// Versão espelhada (troca as mãos e inverte o eixo x): reconhece canhotos e destros.
function espelhar(seq, dim) {
  const L = dim / 2;
  return seq.map((f) => {
    const out = new Array(dim);
    for (let s = 0; s < 2; s++) {
      const de = (1 - s) * L, para = s * L;
      for (let k = 0; k < L; k++) {
        const negativo = k === 0 || (k >= 2 && k < 42 && k % 2 === 0);
        out[para + k] = negativo ? -f[de + k] : f[de + k];
      }
    }
    return out;
  });
}

function distQuadro(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s / a.length);
}

// Dynamic Time Warping: tolera sinais feitos um pouco mais rápido ou devagar.
function dtw(a, b) {
  const n = a.length, m = b.length;
  let prev = new Float64Array(m + 1).fill(Infinity), cur = new Float64Array(m + 1);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity);
    for (let j = 1; j <= m; j++) {
      cur[j] = distQuadro(a[i - 1], b[j - 1]) + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m] / (n + m);
}

function carregarMeus() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY))?.samples ?? []; }
  catch { return []; }
}

function salvarMeus(meus) {
  const r = (x) => Math.round(x * 1000) / 1000;
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ samples: meus.map((s) => ({ label: s.label, seq: s.seq.map((f) => f.map(r)) })) })); }
  catch {}
}

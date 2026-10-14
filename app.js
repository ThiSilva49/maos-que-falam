// Reunião por vídeo com legendas: Libras → texto/voz e voz → texto.
// Conexão direta entre os navegadores (WebRTC via PeerJS). Quem cria a sala organiza a lista de participantes.
import { MotorLibras } from "./libras.js";

const PREFIXO = "maos-que-falam-v1-";
const AUTO_ENVIO_MS = 3000;
const LEGENDA_SOME_MS = 5000;

const $ = (id) => document.getElementById(id);

const eu = { nome: "", libras: false, id: null };
const st = {
  peer: null,
  anfitriao: false,
  codigo: "",
  stream: null,
  pessoas: new Map(),      // id → {nome, libras, dados, chamada, bloco}
  motor: null,
  motorPronto: null,
  frase: [],
  fraseId: null,
  ultimaPalavra: 0,
  selecionada: null,
  pendente: null,
  legendando: false,
};

// =============== ENTRADA ===============
const params = new URLSearchParams(location.search);
const convite = (params.get("sala") || "").toLowerCase().replace(/[^a-z0-9]/g, "");
try { $("nome").value = localStorage.getItem("mqf-nome") || ""; } catch {}
try {
  const modo = localStorage.getItem("mqf-modo");
  if (modo) document.querySelector(`input[name=modo][value=${modo}]`).checked = true;
} catch {}
if (convite) {
  $("entrar-sala").hidden = false;
  $("criar-sala").hidden = true;
  $("codigo-convite").textContent = convite;
}

$("btn-criar").onclick = () => entrar(novoCodigo());
$("btn-entrar").onclick = () => entrar(convite);
$("btn-codigo").onclick = () => {
  const c = $("codigo").value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (c) entrar(c); else $("codigo").focus();
};
$("codigo").onkeydown = (e) => { if (e.key === "Enter") $("btn-codigo").click(); };

function novoCodigo() {
  const letras = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => letras[b % letras.length]).join("");
}

function erroLobby(msg) { $("erro-lobby").textContent = msg; $("erro-lobby").hidden = !msg; }

async function entrar(codigo) {
  eu.nome = $("nome").value.trim() || "Participante";
  eu.libras = document.querySelector("input[name=modo]:checked").value === "libras";
  try { localStorage.setItem("mqf-nome", eu.nome); localStorage.setItem("mqf-modo", eu.libras ? "libras" : "voz"); } catch {}
  erroLobby("");
  for (const b of document.querySelectorAll("#lobby button")) b.disabled = true;

  try {
    st.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    erroLobby({
      NotAllowedError: "O navegador está bloqueando câmera e microfone. Clique no ícone 🔒 (ou 🎥) à esquerda do endereço, "
        + "mude Câmera e Microfone para “Permitir” e recarregue a página.",
      NotReadableError: "A câmera está sendo usada por outro programa (Teams, Zoom, outra aba…). Feche-o e tente de novo.",
      NotFoundError: "Não encontrei câmera ou microfone neste computador.",
    }[e.name] || "Não consegui acessar câmera e microfone: " + e.message);
    for (const b of document.querySelectorAll("#lobby button")) b.disabled = false;
    return;
  }

  st.codigo = codigo;
  history.replaceState(null, "", `?sala=${codigo}`);
  $("lobby").hidden = true;
  $("sala").hidden = false;
  $("sala-codigo").textContent = codigo;

  const meu = criarBloco("eu", eu.nome + " (você)", true);
  meu.video.srcObject = st.stream;
  meu.video.muted = true;

  try {
    await conectarSala(codigo);
  } catch (e) {
    status("Não consegui conectar à reunião: " + (e.type || e.message) + ". Recarregue a página para tentar de novo.");
    return;
  }
  atualizarPessoas();

  if (eu.libras) {
    setMic(false);
    await setLibras(true);
  } else {
    setLegendando(true);
  }
  carregarVozes();
}

// =============== CONEXÃO ===============
function abrirPeer(id) {
  return new Promise((resolve, reject) => {
    const p = id ? new Peer(id) : new Peer();
    const falhou = (e) => { p.destroy(); reject(e); };
    p.once("open", () => { p.off("error", falhou); resolve(p); });
    p.once("error", falhou);
  });
}

async function conectarSala(codigo) {
  status("Conectando…");
  try {
    st.peer = await abrirPeer(PREFIXO + codigo);
    st.anfitriao = true;
  } catch (e) {
    if (e.type !== "unavailable-id") throw e;
    st.peer = await abrirPeer();       // a sala já existe: entro como convidado
    st.anfitriao = false;
  }
  eu.id = st.peer.id;
  st.peer.on("connection", (conn) => prepararDados(conn));
  st.peer.on("call", (call) => { call.answer(st.stream); prepararChamada(call); });
  st.peer.on("error", (e) => {
    if (e.type === "peer-unavailable") {
      // A sala ficou "presa" (quem criou saiu): assumo como anfitrião se ainda estou sozinho.
      if (!st.anfitriao && String(e.message).includes(PREFIXO + codigo)) sair(PREFIXO + codigo);
      if (!st.anfitriao && !st.pessoas.size && String(e.message).includes(PREFIXO + codigo)) {
        status("Quem criou a reunião saiu. Reabrindo a sala…");
        st.peer.destroy();
        setTimeout(() => conectarSala(codigo).catch((x) => status("Não consegui reabrir: " + (x.type || x.message))), 3000);
      }
      return;
    }
    status("Problema de conexão: " + e.type);
  });
  st.peer.on("disconnected", () => { try { st.peer.reconnect(); } catch {} });

  if (st.anfitriao) status("Reunião criada. Copie o convite e mande para os outros.");
  else { ligarPara(PREFIXO + codigo); status("Entrando…"); }
}

// Quem chega liga para todo mundo que já está na sala; quem já está só atende.
function ligarPara(id) {
  if (id === eu.id || st.pessoas.get(id)?.dados) return;
  prepararDados(st.peer.connect(id, { reliable: true }));
  prepararChamada(st.peer.call(id, st.stream));
}

function pessoa(id) {
  let p = st.pessoas.get(id);
  if (!p) {
    p = { nome: "Conectando…", libras: false, dados: null, chamada: null, bloco: criarBloco(id, "Conectando…", false) };
    st.pessoas.set(id, p);
    atualizarPessoas();
  }
  return p;
}

function prepararDados(conn) {
  const p = pessoa(conn.peer);
  p.dados = conn;
  conn.on("open", () => {
    conn.send({ t: "oi", nome: eu.nome, libras: eu.libras });
    if (st.anfitriao) {
      conn.send({ t: "pares", lista: [...st.pessoas.keys()].filter((id) => id !== conn.peer && st.pessoas.get(id).dados?.open) });
    }
    if (!st.anfitriao) status("");
  });
  conn.on("data", (m) => receber(conn.peer, m));
  conn.on("close", () => sair(conn.peer));
  conn.on("error", () => sair(conn.peer));
}

function prepararChamada(call) {
  const p = pessoa(call.peer);
  p.chamada = call;
  call.on("stream", (s) => { p.bloco.video.srcObject = s; });
  call.on("close", () => sair(call.peer));
}

function sair(id) {
  const p = st.pessoas.get(id);
  if (!p) return;
  st.pessoas.delete(id);
  p.bloco.el.remove();
  try { p.dados?.close(); p.chamada?.close(); } catch {}
  if (p.nome !== "Conectando…") anotar({ quem: p.nome, texto: "saiu da reunião", sistema: true });
  atualizarPessoas();
}

function enviarTodos(msg) {
  for (const p of st.pessoas.values()) if (p.dados?.open) p.dados.send(msg);
}

function receber(id, m) {
  const p = pessoa(id);
  if (!m || typeof m !== "object") return;
  if (m.t === "oi") {
    p.nome = String(m.nome || "Participante").slice(0, 40);
    p.libras = !!m.libras;
    p.bloco.nome.textContent = p.nome + (p.libras ? " 🤟" : "");
    anotar({ quem: p.nome, texto: "entrou na reunião", sistema: true });
    atualizarPessoas();
  } else if (m.t === "pares" && Array.isArray(m.lista)) {
    m.lista.forEach((outro) => typeof outro === "string" && ligarPara(outro));
  } else if (m.t === "legenda") {
    const texto = String(m.texto || "").slice(0, 500);
    mostrarLegenda(p.bloco, texto, !m.final);
    if (m.final && texto) {
      anotar({ quem: p.nome, texto, tipo: m.tipo });
      if (m.tipo === "libras" && $("ler-libras").checked) falar(texto);
    }
  } else if (m.t === "chat") {
    anotar({ quem: p.nome, texto: String(m.texto || "").slice(0, 500), tipo: "chat" });
  }
}

// =============== VÍDEOS E LEGENDAS ===============
function criarBloco(id, nome, souEu) {
  const el = $("modelo-video").content.firstElementChild.cloneNode(true);
  if (souEu) el.classList.add("eu");
  el.dataset.id = id;
  const bloco = {
    el, video: el.querySelector("video"), canvas: el.querySelector("canvas"),
    nome: el.querySelector(".nome"), legenda: el.querySelector(".legenda"), contagem: el.querySelector(".contagem"),
    timer: null,
  };
  bloco.nome.textContent = nome;
  $("grade").appendChild(el);
  if (souEu) st.meuBloco = bloco;
  return bloco;
}

function mostrarLegenda(bloco, texto, parcial) {
  clearTimeout(bloco.timer);
  bloco.legenda.textContent = texto;
  bloco.legenda.hidden = !texto;
  bloco.legenda.classList.toggle("parcial", parcial);
  bloco.el.classList.toggle("falando", !!texto);
  if (!parcial) bloco.timer = setTimeout(() => { bloco.legenda.hidden = true; bloco.el.classList.remove("falando"); }, LEGENDA_SOME_MS);
}

function anotar({ quem, texto, tipo, sistema = false, minha = false }) {
  if (!texto) return;
  const li = document.createElement("li");
  if (minha) li.classList.add("minha");
  const q = document.createElement("span");
  q.className = "quem";
  const hora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const icone = { libras: "🤟 ", voz: "🗣️ ", chat: "💬 " }[tipo] || "";
  q.textContent = `${icone}${quem} · ${hora}`;
  li.append(q, document.createTextNode(texto));
  if (sistema) li.classList.add("muted");
  const lista = $("transcricao");
  const noFim = lista.scrollTop + lista.clientHeight >= lista.scrollHeight - 30;
  lista.appendChild(li);
  if (noFim) lista.scrollTop = lista.scrollHeight;
}

function atualizarPessoas() {
  const n = st.pessoas.size + 1;
  $("sala-pessoas").textContent = `${n} ${n === 1 ? "pessoa" : "pessoas"}`;
}

function status(t) { $("status").textContent = t; }

// =============== CONTROLES ===============
function marcar(botao, ligado) {
  botao.classList.toggle("ligado", ligado);
  botao.classList.toggle("desligado", !ligado);
}

function setMic(ligado) {
  st.stream.getAudioTracks().forEach((t) => { t.enabled = ligado; });
  marcar($("btn-mic"), ligado);
  if (!ligado && st.legendando) setLegendando(false);
}

function setCam(ligada) {
  st.stream.getVideoTracks().forEach((t) => { t.enabled = ligada; });
  marcar($("btn-cam"), ligada);
  if (!ligada && st.motor?.reconhecendo) setLibras(false);
}

$("btn-mic").onclick = () => setMic(!st.stream.getAudioTracks()[0]?.enabled);
$("btn-cam").onclick = () => setCam(!st.stream.getVideoTracks()[0]?.enabled);
$("btn-libras").onclick = () => setLibras(!st.motor?.reconhecendo);
$("btn-legenda").onclick = () => setLegendando(!st.legendando);
$("btn-sair").onclick = () => {
  try { st.peer?.destroy(); } catch {}
  st.stream?.getTracks().forEach((t) => t.stop());
  location.href = location.pathname;
};
$("btn-link").onclick = async () => {
  const url = `${location.origin}${location.pathname}?sala=${st.codigo}`;
  try { await navigator.clipboard.writeText(url); status("Convite copiado: " + url); }
  catch { status("Convite: " + url); }
};
$("vocabulario").onchange = (e) => { if (st.motor) st.motor.vocabulario = e.target.value; };
$("letra-grande").onchange = (e) => document.body.classList.toggle("letra-grande", e.target.checked);
$("tolerancia").oninput = (e) => {
  $("tolerancia-valor").textContent = parseFloat(e.target.value).toFixed(2);
  if (st.motor) st.motor.tolerancia = parseFloat(e.target.value);
};
$("form-chat").onsubmit = (e) => {
  e.preventDefault();
  const texto = $("chat-texto").value.trim();
  if (!texto) return;
  enviarTodos({ t: "chat", texto });
  anotar({ quem: "Você", texto, tipo: "chat", minha: true });
  $("chat-texto").value = "";
};

// =============== LIBRAS (meus sinais) ===============
async function prepararMotor() {
  if (!st.motorPronto) {
    st.motor = new MotorLibras({ video: st.meuBloco.video, canvas: st.meuBloco.canvas });
    st.motor.tolerancia = parseFloat($("tolerancia").value);
    st.motor.vocabulario = $("vocabulario").value;
    st.motor.onSinal = aoSinal;
    st.motor.onEstado = (e) => {
      const a = st.meuBloco.el.querySelector(".aviso");
      a.className = "aviso " + e;
      a.textContent = { longe: "↔ Afaste-se: mostre ombros e peito", pronto: "✓ Pronto para sinalizar", lendo: "● Lendo sinal…" }[e];
      a.hidden = !st.motor.reconhecendo;
    };
    status("Carregando reconhecimento de Libras (só na primeira vez demora um pouco)…");
    st.motorPronto = st.motor.carregar().then((info) => {
      $("credito").textContent = info
        ? `Biblioteca de Libras: ${info.palavras.toLocaleString("pt-BR")} palavras (${info.essenciais} essenciais) em ${info.videos.toLocaleString("pt-BR")} vídeos. Fonte: ${info.fonte}.`
        : "Biblioteca de sinais não encontrada: só os sinais que você ensinar serão reconhecidos.";
      const dl = $("lista-palavras");
      for (const p of st.motor.palavras) { const o = document.createElement("option"); o.value = p; dl.appendChild(o); }
      const d = st.motor.desempenho;
      if (d) $("credito").textContent += ` Velocidade: ~${Math.round(1000 / d.msPorImagem)} imagens/s (${d.delegate === "GPU" ? "placa de vídeo" : "processador"}).`;
      st.motor.ligar();
      listarMeus();
    });
  }
  await st.motorPronto;
}

async function setLibras(ligado) {
  marcar($("btn-libras"), ligado);
  $("cartao-frase").hidden = !ligado;
  if (!ligado) {
    if (st.motor) st.motor.reconhecendo = false;
    $("alternativas").hidden = true;
    st.meuBloco.el.querySelector(".aviso").hidden = true;
    return;
  }
  try {
    await prepararMotor();
  } catch (e) {
    status("Não consegui carregar o reconhecimento de Libras: " + e.message);
    marcar($("btn-libras"), false);
    return;
  }
  st.motor.reconhecendo = true;
  status("Libras ligado: comece com as mãos abaixadas, faça o sinal e abaixe as mãos.");
}

// A frase é uma lista de palavras; cada uma guarda as alternativas e o sinal feito, para corrigir depois.
// st.frase: [{palavra, alternativas, seq}]   st.selecionada: índice sendo corrigido (pausa o envio automático)
function aoSinal({ palavra, alternativas, seq }) {
  if (palavra) {
    st.frase.push({ palavra, alternativas, seq });
    st.selecionada = null;
    st.pendente = null;
    tocarFrase();
    mostrarOpcoes(st.frase.length - 1, true);
  } else if (alternativas.length) {
    st.pendente = { alternativas, seq };     // sinal percebido, mas sem certeza
    mostrarOpcoes(null, true);
  }
}

function mostrarOpcoes(i, automatico = false) {
  const box = $("alternativas");
  box.innerHTML = "";
  const item = i == null ? null : st.frase[i];
  const alts = item ? item.alternativas.filter((p) => p !== item.palavra) : st.pendente?.alternativas || [];
  const rot = document.createElement("span");
  rot.className = "muted pequeno";
  rot.textContent = !item ? "Não tive certeza. Era:"
    : automatico ? `Entendi “${item.palavra}”. Errado? Troque por:` : `Trocar “${item.palavra}” por:`;
  box.appendChild(rot);
  for (const p of alts) {
    const b = document.createElement("button");
    b.textContent = p;
    b.onclick = () => (item ? trocar(i, p) : escolherPendente(p));
    box.appendChild(b);
  }
  const campo = document.createElement("input");
  campo.type = "text";
  campo.placeholder = "ou digite a certa";
  campo.setAttribute("list", "lista-palavras");
  campo.className = "digitar";
  campo.onfocus = () => { if (item) st.selecionada = i; };
  campo.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    const p = campo.value.trim().toLowerCase();
    if (p) (item ? trocar(i, p) : escolherPendente(p));
  };
  box.appendChild(campo);
  if (item) {
    const rm = document.createElement("button");
    rm.textContent = "✕ Remover";
    rm.className = "danger";
    rm.onclick = () => remover(i);
    box.appendChild(rm);
  }
  const fechar = document.createElement("button");
  fechar.textContent = item ? "Está certo" : "Ignorar";
  fechar.onclick = fecharOpcoes;
  box.appendChild(fechar);
  box.hidden = false;
  renderFrase();
}

function fecharOpcoes() {
  $("alternativas").hidden = true;
  st.selecionada = null;
  st.pendente = null;
  st.ultimaPalavra = performance.now();
  renderFrase();
}

// Toda correção ensina o programa: o sinal feito passa a valer para a palavra certa.
function trocar(i, nova) {
  const w = st.frase[i];
  if (w.seq && nova !== w.palavra) { st.motor.aprender(nova, w.seq); listarMeus(); }
  w.palavra = nova;
  fecharOpcoes();
  tocarFrase();
}

function remover(i) {
  st.frase.splice(i, 1);
  fecharOpcoes();
  tocarFrase();
}

function escolherPendente(p) {
  const u = st.pendente;
  if (!u) return;
  st.motor.aprender(p, u.seq);
  listarMeus();
  st.frase.push({ palavra: p, alternativas: u.alternativas, seq: u.seq });
  fecharOpcoes();
  tocarFrase();
}

function textoFrase() { return st.frase.map((w) => w.palavra).join(" "); }

function renderFrase() {
  const box = $("frase");
  box.innerHTML = "";
  if (!st.frase.length) {
    box.innerHTML = '<span class="muted pequeno">Faça um sinal: as palavras aparecem aqui. Clique numa palavra para corrigir.</span>';
    return;
  }
  st.frase.forEach((w, i) => {
    const b = document.createElement("button");
    b.className = "palavra" + (st.selecionada === i ? " selecionada" : "");
    b.textContent = w.palavra;
    b.title = "Clique para corrigir";
    b.onclick = () => { st.selecionada = i; st.pendente = null; mostrarOpcoes(i); };
    box.appendChild(b);
  });
}

function tocarFrase() {
  st.ultimaPalavra = performance.now();
  renderFrase();
  const texto = textoFrase();
  if (!st.fraseId) st.fraseId = crypto.randomUUID();
  mostrarLegenda(st.meuBloco, texto, true);
  enviarTodos({ t: "legenda", tipo: "libras", id: st.fraseId, texto, final: false });
}

function enviarFrase() {
  if (!st.frase.length) return;
  const texto = textoFrase();
  enviarTodos({ t: "legenda", tipo: "libras", id: st.fraseId, texto, final: true });
  mostrarLegenda(st.meuBloco, texto, false);
  anotar({ quem: "Você", texto, tipo: "libras", minha: true });
  st.frase = []; st.fraseId = null;
  fecharOpcoes();
}

// Envia sozinho depois de um tempo parado, menos enquanto a pessoa está corrigindo.
setInterval(() => {
  const corrigindo = st.selecionada != null || document.activeElement?.classList.contains("digitar")
    || document.activeElement?.id === "adicionar-palavra";
  if (st.frase.length && !corrigindo && $("auto-enviar").checked
      && performance.now() - st.ultimaPalavra > AUTO_ENVIO_MS) enviarFrase();
}, 250);

$("btn-enviar").onclick = enviarFrase;
$("btn-desfazer").onclick = () => { st.frase.pop(); fecharOpcoes(); tocarFrase(); };
$("btn-limpar").onclick = () => { st.frase = []; fecharOpcoes(); tocarFrase(); };
$("adicionar-palavra").onkeydown = (e) => {
  if (e.key !== "Enter") return;
  const p = e.target.value.trim().toLowerCase();
  if (!p) return;
  st.frase.push({ palavra: p, alternativas: [], seq: null });
  e.target.value = "";
  tocarFrase();
};
renderFrase();

// ---------- ensinar sinais ----------
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

$("btn-gravar").onclick = async () => {
  const palavra = $("palavra-nova").value.trim().toLowerCase();
  if (!palavra) { $("palavra-nova").focus(); return; }
  if (!st.motor?.reconhecendo) await setLibras(true);
  if (!st.motor) return;
  const reps = parseInt($("repeticoes").value, 10);
  const estava = st.motor.reconhecendo;
  st.motor.reconhecendo = false;
  $("btn-gravar").disabled = true;
  let salvos = 0;
  for (let r = 1; r <= reps; r++) {
    status(`“${palavra}” ${r}/${reps}: mãos abaixadas…`);
    for (let i = 3; i > 0; i--) { st.meuBloco.contagem.textContent = i; await espera(700); }
    st.meuBloco.contagem.textContent = "";
    status(`“${palavra}” ${r}/${reps}: faça o sinal e abaixe as mãos.`);
    const seq = await st.motor.proximoSinal(6000);
    if (!seq) { status("Não percebi o sinal. Tente de novo."); await espera(1200); continue; }
    st.motor.aprender(palavra, seq);
    salvos++;
  }
  st.motor.reconhecendo = estava;
  $("btn-gravar").disabled = false;
  listarMeus();
  status(`${salvos} exemplo(s) de “${palavra}” salvos.`);
};

function listarMeus() {
  if (!st.motor) return;
  const cont = new Map();
  for (const s of st.motor.meus) cont.set(s.label, (cont.get(s.label) || 0) + 1);
  const ul = $("meus-sinais");
  ul.innerHTML = "";
  for (const [p, n] of [...cont].sort((a, b) => a[0].localeCompare(b[0]))) {
    const li = document.createElement("li");
    const s = document.createElement("span");
    s.textContent = `${p} (${n})`;
    const b = document.createElement("button");
    b.textContent = "Remover";
    b.onclick = () => { st.motor.removerMeus(p); listarMeus(); };
    li.append(s, b);
    ul.appendChild(li);
  }
}

$("btn-exportar").onclick = () => {
  if (!st.motor) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([st.motor.exportar()], { type: "application/json" }));
  a.download = "meus-sinais.json";
  a.click();
  URL.revokeObjectURL(a.href);
};
$("btn-importar").onclick = () => $("arquivo").click();
$("arquivo").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    await prepararMotor();
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.samples)) throw new Error("formato inválido");
    st.motor.importar(d.samples);
    listarMeus();
    status(`${d.samples.length} exemplo(s) importados.`);
  } catch (err) { status("Não consegui importar: " + err.message); }
  e.target.value = "";
};

// =============== VOZ → LEGENDA (minha fala) ===============
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, pausadoPorFala = false;

function setLegendando(ligado) {
  if (ligado && !SR) { status("Este navegador não transforma voz em texto. Use Chrome ou Edge."); ligado = false; }
  if (ligado && !st.stream.getAudioTracks()[0]?.enabled) setMic(true);
  st.legendando = ligado;
  marcar($("btn-legenda"), ligado);
  if (ligado) iniciarRec(); else rec?.stop();
}

let uttId = crypto.randomUUID();
function iniciarRec() {
  if (!rec) {
    rec = new SR();
    rec.lang = "pt-BR";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let parcial = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const texto = r[0].transcript.trim();
          if (!texto) continue;
          enviarTodos({ t: "legenda", tipo: "voz", id: uttId, texto, final: true });
          mostrarLegenda(st.meuBloco, texto, false);
          anotar({ quem: "Você", texto, tipo: "voz", minha: true });
          uttId = crypto.randomUUID();
        } else parcial += r[0].transcript;
      }
      parcial = parcial.trim();
      if (parcial) {
        enviarTodos({ t: "legenda", tipo: "voz", id: uttId, texto: parcial, final: false });
        mostrarLegenda(st.meuBloco, parcial, true);
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        status("O navegador bloqueou o reconhecimento de voz. Permita o microfone no cadeado da barra de endereço.");
        st.legendando = false; marcar($("btn-legenda"), false);
      }
    };
    // O navegador encerra a escuta de tempos em tempos: reinicia enquanto estiver ligada.
    rec.onend = () => { if (st.legendando && !pausadoPorFala) { try { rec.start(); } catch {} } };
  }
  try { rec.start(); } catch {}
}

// =============== VOZ SINTÉTICA (ler o que foi sinalizado) ===============
function falar(texto) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(texto);
  u.lang = "pt-BR";
  const v = speechSynthesis.getVoices().find((x) => x.name === $("voz").value);
  if (v) u.voice = v;
  // Pausa minha legenda enquanto o computador fala, para não transcrever a voz sintética.
  u.onstart = () => { if (st.legendando) { pausadoPorFala = true; rec?.stop(); } };
  u.onend = u.onerror = () => setTimeout(() => {
    if (speechSynthesis.speaking || !pausadoPorFala) return;
    pausadoPorFala = false;
    if (st.legendando) { try { rec.start(); } catch {} }
  }, 300);
  speechSynthesis.speak(u);
}

function carregarVozes() {
  if (!("speechSynthesis" in window)) return;
  const preencher = () => {
    const vozes = speechSynthesis.getVoices();
    const sel = $("voz"), atual = sel.value;
    sel.innerHTML = "";
    const ord = [...vozes].sort((a, b) => (b.lang.startsWith("pt") - a.lang.startsWith("pt")) || a.name.localeCompare(b.name));
    for (const v of ord) { const o = document.createElement("option"); o.value = v.name; o.textContent = `${v.name} (${v.lang})`; sel.appendChild(o); }
    const pt = ord.find((v) => v.lang === "pt-BR") || ord.find((v) => v.lang.startsWith("pt"));
    sel.value = atual || pt?.name || "";
  };
  preencher();
  speechSynthesis.onvoiceschanged = preencher;
}

// estado inicial dos botões
marcar($("btn-mic"), true);
marcar($("btn-cam"), true);
marcar($("btn-libras"), false);
marcar($("btn-legenda"), false);

// Gancho de teste (só no computador local): simula sinais reconhecidos.
if (location.hostname === "localhost") window.mqfTeste = { aoSinal, get historico() { return st.motor?.historico; }, get motor() { return st.motor; } };

"""Transforma os pontos extraídos na biblioteca que o navegador carrega.

Gera ../biblioteca.bin (int8) e ../biblioteca.json (palavras e parâmetros).
As contas aqui precisam ser idênticas às de index.html (frameRaw, preencher, vetorizar).

Uso: uv run python -I construir.py [--avaliar]
"""
import json
import os
import sys
import unicodedata

import numpy as np

AQUI = os.path.dirname(os.path.abspath(__file__))
PONTOS = os.path.join(AQUI, "..", "..", "libras-voz-dados", "pontos")
SAIDA = os.path.join(AQUI, "..")

FRAMES = 12
PARAMS = {"pos": 2.0, "forma": 1.0, "pres": 1.5}
ESCALA_Q = 20.0          # int8 = round(valor * ESCALA_Q)
ALTURA_ATIVA = 1.6       # pulso acima de (centro dos ombros + 1.6 larguras de ombro) = mão "levantada"
DIM_LADO = 2 + 40 + 1
DIM = 2 * DIM_LADO


def quadro(pose, maos, largura, altura):
    """Um quadro → (pos[2,2], forma[2,40] com NaN se a mão não foi vista, ativo). None sem pose."""
    if pose is None or np.isnan(pose[11, 0]) or np.isnan(pose[12, 0]):
        return None
    px = lambda p: np.array([p[0] * largura, p[1] * altura], np.float64)
    ombro_e, ombro_d = px(pose[11]), px(pose[12])
    centro = (ombro_e + ombro_d) / 2
    larg = np.linalg.norm(ombro_e - ombro_d)
    if larg < 1e-6:
        return None
    pulsos = [px(pose[15]), px(pose[16])]          # 15 = pulso esquerdo da pessoa, 16 = direito
    vis = [pose[15, 3], pose[16, 3]]

    lados = [None, None]
    maos_px = [np.stack([lm[:, 0] * largura, lm[:, 1] * altura], 1) for lm in maos]
    if len(maos_px) == 1:
        d = [np.linalg.norm(maos_px[0][0] - p) for p in pulsos]
        lados[0 if d[0] <= d[1] else 1] = maos_px[0]
    elif len(maos_px) >= 2:
        a, b = maos_px[0], maos_px[1]
        direto = np.linalg.norm(a[0] - pulsos[0]) + np.linalg.norm(b[0] - pulsos[1])
        trocado = np.linalg.norm(a[0] - pulsos[1]) + np.linalg.norm(b[0] - pulsos[0])
        lados = [a, b] if direto <= trocado else [b, a]

    pos = np.zeros((2, 2)); forma = np.full((2, 40), np.nan); ativo = False
    for s in range(2):
        mao = lados[s]
        if mao is not None:
            pos[s] = (mao[0] - centro) / larg
        elif vis[s] > 0.5:
            pos[s] = (pulsos[s] - centro) / larg
        else:
            pos[s] = [0.0, 3.0]
        if pos[s, 1] < ALTURA_ATIVA and (mao is not None or vis[s] > 0.5):
            ativo = True
        if mao is not None:
            palma = np.linalg.norm(mao[9] - mao[0]) or 1e-6
            forma[s] = ((mao[1:] - mao[0]) / palma).reshape(-1)
    return pos, forma, ativo


def preencher(formas):
    """Mão perdida em alguns quadros: copia a forma do quadro mais próximo em que ela foi vista."""
    formas = formas.copy()
    t = len(formas)
    for s in range(2):
        vistos = np.where(~np.isnan(formas[:, s, 0]))[0]
        if len(vistos) == 0:
            continue
        for i in range(t):
            if np.isnan(formas[i, s, 0]):
                formas[i, s] = formas[vistos[np.argmin(np.abs(vistos - i))], s]
    return formas


def vetorizar(pos, forma, p=PARAMS):
    """(T,2,2) + (T,2,40) → (T, DIM)."""
    t = len(pos)
    out = np.zeros((t, 2, DIM_LADO), np.float32)
    out[:, :, :2] = pos * p["pos"]
    tem = ~np.isnan(forma[:, :, 0])
    out[:, :, 2:42] = np.where(tem[..., None], forma, 0) * p["forma"]
    out[:, :, 42] = tem * p["pres"]
    return out.reshape(t, DIM)


def reamostrar(n_total, n=FRAMES):
    # floor(x + 0.5) = Math.round do JavaScript (np.round arredonda .5 para o par)
    return np.floor(np.linspace(0, n_total - 1, n) + 0.5).astype(int)


def sequencia_bruta(arq):
    """Lê um vídeo processado → (pos, forma) já cortados nos quadros ativos, preenchidos e reamostrados."""
    z = np.load(arq)
    pose, maos = z["pose"].astype(np.float32), z["maos"].astype(np.float32)
    largura, altura = float(z["largura"]), float(z["altura"])
    poss, formas, ativos = [], [], []
    for t in range(len(pose)):
        ms = [maos[t, k, :, :2] for k in range(2) if not np.isnan(maos[t, k, 0, 0])]
        r = quadro(None if np.isnan(pose[t, 0, 0]) else pose[t], ms, largura, altura)
        if r is None:
            continue
        poss.append(r[0]); formas.append(r[1]); ativos.append(r[2])
    ativos = np.array(ativos)
    if ativos.sum() < 3:
        return None
    i0, i1 = np.argmax(ativos), len(ativos) - np.argmax(ativos[::-1])
    pos, forma = np.stack(poss[i0:i1]), preencher(np.stack(formas[i0:i1]))
    idx = reamostrar(len(pos))
    return pos[idx], forma[idx]


def normalizar_palavra(p):
    p = unicodedata.normalize("NFC", p.strip().lower())
    return " ".join(p.split())


def carregar():
    sys.path.insert(0, AQUI)
    from extrair import id_do_arquivo
    lista = json.load(open(os.path.join(AQUI, "lista_videos.json"), encoding="utf-8"))
    extras = os.path.join(AQUI, "lista_extras.json")
    if os.path.exists(extras):
        lista += json.load(open(extras, encoding="utf-8"))
    brutos, y, palavras, idx_palavra, sem, vistos = [], [], [], {}, 0, set()
    for it in lista:
        if it["arquivo"] in vistos:
            continue
        vistos.add(it["arquivo"])
        arq = os.path.join(PONTOS, id_do_arquivo(it["arquivo"]) + ".npz")
        if not os.path.exists(arq):
            continue
        b = sequencia_bruta(arq)
        if b is None:
            sem += 1
            continue
        p = normalizar_palavra(it["palavra"])
        if p not in idx_palavra:
            idx_palavra[p] = len(palavras); palavras.append(p)
        brutos.append(b); y.append(idx_palavra[p])
    print(f"{len(brutos)} vídeos válidos, {len(palavras)} palavras ({sem} sem mãos visíveis descartados)")
    return brutos, np.array(y), palavras


def montar(brutos, p=PARAMS):
    return np.stack([vetorizar(pos, forma, p) for pos, forma in brutos])


def dtw(a, b):
    custo = np.sqrt(((a[:, None, :] - b[None, :, :]) ** 2).mean(-1))
    n, m = custo.shape
    D = np.full((n + 1, m + 1), np.inf); D[0, 0] = 0
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            D[i, j] = custo[i - 1, j - 1] + min(D[i - 1, j], D[i, j - 1], D[i - 1, j - 1])
    return D[n, m] / (n + m)


def espelhar(X):
    """Igual a espelhar() do index.html: troca as mãos e inverte o eixo x."""
    Xm = X.reshape(*X.shape[:-1], 2, DIM_LADO)[..., ::-1, :].copy()
    Xm[..., 0] *= -1
    Xm[..., 2:42:2] *= -1
    return Xm.reshape(X.shape)


def avaliar(X, y, consultas=600, prefiltro=60, silencioso=False):
    """Deixa-um-de-fora: cada vídeo é comparado com todos os outros (outras pessoas/dicionários)."""
    rng = np.random.default_rng(0)
    contagem = np.bincount(y)
    candidatos = np.where(contagem[y] >= 2)[0]
    escolhidos = rng.choice(candidatos, min(consultas, len(candidatos)), replace=False)
    Xm = espelhar(X)
    planos = X.reshape(len(X), -1)
    top1 = top5 = 0
    dist_certa, dist_errada = [], []
    for q in escolhidos:
        melhor = {}
        for consulta in (X[q], Xm[q]):
            d = np.sqrt(((planos - consulta.reshape(-1)) ** 2).mean(1)); d[q] = np.inf
            for c in np.argsort(d)[:prefiltro]:
                dd = dtw(consulta, X[c])
                if dd < melhor.get(y[c], np.inf):
                    melhor[y[c]] = dd
        ranking = sorted(melhor, key=melhor.get)
        top1 += ranking[0] == y[q]
        top5 += y[q] in ranking[:5]
        (dist_certa if ranking[0] == y[q] else dist_errada).append(melhor[ranking[0]])
    n = len(escolhidos)
    if not silencioso:
        print(f"Consultas: {n} | acerto 1ª opção: {top1 / n:.1%} | certa entre as 5 primeiras: {top5 / n:.1%}")
        todas = np.array(dist_certa + dist_errada)
        print("Distância do 1º lugar — percentis 50/75/90:", np.round(np.percentile(todas, [50, 75, 90]), 3))
    return top1 / n, top5 / n


def main():
    brutos, y, palavras = carregar()
    X = montar(brutos)
    if "--avaliar" in sys.argv:
        avaliar(X, y)
    q = np.clip(np.round(X * ESCALA_Q), -127, 127).astype(np.int8)
    q.tofile(os.path.join(SAIDA, "biblioteca.bin"))
    essenciais = {normalizar_palavra(l) for l in open(os.path.join(AQUI, "essenciais.txt"), encoding="utf-8")
                  if l.strip() and not l.startswith("#")}
    meta = {"fonte": "MALTA-LIBRAS (licença MIT): INES, UFSC, Spread the Sign, USP, UFV e YouTube",
            "essenciais": [i for i, p in enumerate(palavras) if p in essenciais],
            "frames": FRAMES, "dim": DIM, "escala": ESCALA_Q,
            "pesos": [PARAMS["pos"], PARAMS["forma"], PARAMS["pres"]],
            "alturaAtiva": ALTURA_ATIVA, "palavras": palavras, "rotulos": y.tolist()}
    json.dump(meta, open(os.path.join(SAIDA, "biblioteca.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(f"biblioteca.bin: {q.nbytes / 1e6:.1f} MB")


if __name__ == "__main__":
    main()

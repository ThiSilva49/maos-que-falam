"""Testa comparar também a versão espelhada (sinalizante canhoto)."""
import os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import construir as c

def espelhar(pos, forma):
    pos = pos[:, ::-1].copy(); pos[..., 0] *= -1
    forma = forma[:, ::-1].copy(); forma[..., 0::2] *= -1
    return pos, forma

brutos, y, _ = c.carregar()
X = c.montar(brutos)
Xm = np.stack([c.vetorizar(*espelhar(p, f)) for p, f in brutos])
rng = np.random.default_rng(0)
cont = np.bincount(y); cand_q = np.where(cont[y] >= 2)[0]
esc = rng.choice(cand_q, min(300, len(cand_q)), replace=False)
P, Pm = X.reshape(len(X), -1), Xm.reshape(len(X), -1)
for modo in ("normal", "normal+espelho"):
    t1 = t5 = 0
    for q in esc:
        d = np.sqrt(((P - P[q]) ** 2).mean(1)); d[q] = np.inf
        cand = list(np.argsort(d)[:60])
        ds = [c.dtw(X[q], X[k]) for k in cand]
        if modo != "normal":
            dm = np.sqrt(((P - Pm[q]) ** 2).mean(1)); dm[q] = np.inf
            cm = list(np.argsort(dm)[:60])
            cand += cm; ds += [c.dtw(Xm[q], X[k]) for k in cm]
        melhor = {}
        for k, dd in sorted(zip(cand, ds), key=lambda t: t[1]): melhor.setdefault(y[k], dd)
        r = list(melhor); t1 += r[0] == y[q]; t5 += y[q] in r[:5]
    print(f"{modo}: 1ª {t1/len(esc):.1%}  top5 {t5/len(esc):.1%}", flush=True)

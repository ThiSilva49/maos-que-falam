"""Mede como separar sinais conhecidos de movimentos que não estão na biblioteca.

Para cada vídeo de teste compara:
  - "conhecido": a palavra dele está na biblioteca (com outro vídeo dela)
  - "desconhecido": todos os vídeos dessa palavra são retirados (simula um gesto que não é sinal da biblioteca)
Mede d1 (distância do 1º lugar) e razão d1/d2 (1º lugar ÷ 2º lugar de outra palavra).
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import construir as c


def ranking(Xq_lista, X, y, planos, excluir, prefiltro=60):
    melhor = {}
    for consulta in Xq_lista:
        d = np.sqrt(((planos - consulta.reshape(-1)) ** 2).mean(1))
        d[excluir] = np.inf
        for k in np.argsort(d)[:prefiltro]:
            if not np.isfinite(d[k]):
                break
            dd = c.dtw(consulta, X[k])
            if dd < melhor.get(y[k], np.inf):
                melhor[y[k]] = dd
    return sorted(melhor.items(), key=lambda t: t[1])


def main(n=300):
    brutos, y, _ = c.carregar()
    X = c.montar(brutos)
    Xm = c.espelhar(X)
    planos = X.reshape(len(X), -1)
    rng = np.random.default_rng(1)
    cont = np.bincount(y)
    cand = np.where(cont[y] >= 2)[0]
    esc = rng.choice(cand, min(n, len(cand)), replace=False)
    conhecido, desconhecido = [], []
    for q in esc:
        r = ranking([X[q], Xm[q]], X, y, planos, excluir=[q])
        conhecido.append((r[0][1], r[0][1] / r[1][1], r[0][0] == y[q]))
        r = ranking([X[q], Xm[q]], X, y, planos, excluir=np.where(y == y[q])[0])
        desconhecido.append((r[0][1], r[0][1] / r[1][1]))
    k = np.array(conhecido); u = np.array(desconhecido)
    certos = k[k[:, 2] == 1]
    print(f"{len(esc)} consultas; acerto 1ª opção {k[:, 2].mean():.1%}")
    for nome, arr in (("conhecido e certo", certos), ("desconhecido", u)):
        print(f"{nome:18s} d1 p25/50/75: {np.round(np.percentile(arr[:, 0], [25, 50, 75]), 3)}"
              f"   razão p25/50/75: {np.round(np.percentile(arr[:, 1], [25, 50, 75]), 3)}")
    print("\nlimiar d1 | razão máx | aceita certos | aceita desconhecidos")
    for lim in (0.15, 0.18, 0.2, 0.22, 0.25, 0.3):
        for rz in (1.0, 0.95, 0.9, 0.85):
            a = ((certos[:, 0] <= lim) & (certos[:, 1] <= rz)).mean()
            b = ((u[:, 0] <= lim) & (u[:, 1] <= rz)).mean()
            print(f"  {lim:.2f}    |   {rz:.2f}    |    {a:6.1%}     |   {b:6.1%}")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 300)

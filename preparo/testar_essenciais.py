"""Compara o acerto usando a biblioteca inteira x só o vocabulário essencial."""
import os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import construir as c

ess = {c.normalizar_palavra(l) for l in open(os.path.join(os.path.dirname(__file__), "essenciais.txt"), encoding="utf-8")
       if l.strip() and not l.startswith("#")}
brutos, y, palavras = c.carregar()
X = c.montar(brutos)
manter = np.array([palavras[i] in ess for i in y])
print(f"essenciais na biblioteca (até agora): {len({palavras[i] for i in y[manter]})} palavras, {manter.sum()} vídeos")
Xe, ye = X[manter], y[manter]
_, ye = np.unique(ye, return_inverse=True)
print("Só essenciais:"); c.avaliar(Xe, ye, consultas=300)

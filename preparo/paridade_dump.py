"""Gera um caso de teste: pontos brutos de alguns vídeos + vetor final calculado pelo Python."""
import glob, json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import construir as c
casos = []
for arq in sorted(glob.glob(os.path.join(c.PONTOS, "*.npz")))[:15]:
    z = np.load(arq)
    pose, maos = z["pose"].astype(np.float32), z["maos"].astype(np.float32)
    quadros = []
    for t in range(len(pose)):
        p = None if np.isnan(pose[t, 0, 0]) else [{"x": float(a), "y": float(b), "visibility": float(v)} for a, b, _, v in pose[t]]
        hs = [[{"x": float(a), "y": float(b)} for a, b, _ in maos[t, k]] for k in range(2) if not np.isnan(maos[t, k, 0, 0])]
        quadros.append({"pose": p, "maos": hs})
    b = c.sequencia_bruta(arq)
    v = None if b is None else c.vetorizar(*b)
    casos.append({"quadros": quadros, "esperado": None if v is None else v.tolist(), "espelhado": None if v is None else c.espelhar(v).tolist()})
json.dump(casos, open(sys.argv[1], "w"))
print(len(casos), "casos")

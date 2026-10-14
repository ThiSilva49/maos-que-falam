"""Compara variações de pesos para escolher a que mais acerta."""
import sys

import numpy as np

sys.path.insert(0, __import__("os").path.dirname(__file__))
import construir as c

brutos, y, _ = c.carregar()

grade = [
    {"pos": 2.0, "forma": 1.0, "pres": 1.5},
    {"pos": 4.0, "forma": 1.0, "pres": 1.0},
    {"pos": 6.0, "forma": 1.0, "pres": 0.5},
    {"pos": 8.0, "forma": 1.0, "pres": 0.0},
    {"pos": 4.0, "forma": 0.5, "pres": 0.5},
    {"pos": 4.0, "forma": 2.0, "pres": 0.5},
]
for p in grade:
    X = c.montar(brutos, p)
    t1, t5 = c.avaliar(X, y, consultas=int(sys.argv[1]) if len(sys.argv) > 1 else 300, silencioso=True)
    print(f"{p}  →  1ª: {t1:.1%}   top5: {t5:.1%}", flush=True)

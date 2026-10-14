"""Baixa os vídeos (tensores) do MALTA-LIBRAS e guarda só os pontos do MediaPipe.

Uso: uv run python -I extrair.py [processos]
Pode ser interrompido e rodado de novo: pula o que já foi feito.
"""
import hashlib
import io
import json
import os
import sys
import time
import zipfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from urllib.parse import quote

import numpy as np

AQUI = os.path.dirname(os.path.abspath(__file__))
SAIDA = os.path.join(AQUI, "..", "..", "libras-voz-dados", "pontos")
REPO_URL = "https://huggingface.co/datasets/MALTA-Lab/MALTA_LIBRAS/resolve/main/"

_hands = _pose = _sessao = None


def _prioridade_baixa():
    """Deixa o computador livre para o usuário: só usa o processador quando sobra (Windows)."""
    if os.name == "nt":
        import ctypes
        k32 = ctypes.windll.kernel32
        k32.GetCurrentProcess.restype = ctypes.c_void_p       # sem isso o "handle" -1 é truncado em 64 bits
        k32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint]
        IDLE_PRIORITY_CLASS = 0x40
        k32.SetPriorityClass(k32.GetCurrentProcess(), IDLE_PRIORITY_CLASS)


def _iniciar():
    global _hands, _pose, _sessao
    _prioridade_baixa()
    import requests
    from mediapipe.tasks.python import BaseOptions
    from mediapipe.tasks.python.vision import (HandLandmarker, HandLandmarkerOptions,
                                              PoseLandmarker, PoseLandmarkerOptions, RunningMode)
    _hands = HandLandmarker.create_from_options(HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=os.path.join(AQUI, "modelos", "hand_landmarker.task")),
        running_mode=RunningMode.IMAGE, num_hands=2,
        min_hand_detection_confidence=0.3, min_hand_presence_confidence=0.3))
    _pose = PoseLandmarker.create_from_options(PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=os.path.join(AQUI, "modelos", "pose_landmarker_lite.task")),
        running_mode=RunningMode.IMAGE))
    _sessao = requests.Session()


def id_do_arquivo(arquivo):
    return hashlib.sha1(arquivo.encode("utf-8")).hexdigest()[:16]


def baixar(arquivo):
    url = REPO_URL + quote(arquivo, safe="/")
    for tentativa in range(5):
        try:
            r = _sessao.get(url, timeout=120)
            if r.status_code == 200:
                return r.content
            if r.status_code == 404:
                return None
        except Exception:
            pass
        time.sleep(2 ** tentativa)
    raise RuntimeError(f"falhou download: {arquivo}")


def ler_quadros(bruto):
    with zipfile.ZipFile(io.BytesIO(bruto)) as z:
        nome = next(n for n in z.namelist() if n.endswith("/data/0"))
        dados = np.frombuffer(z.read(nome), dtype=np.uint8)
    t = dados.size // (3 * 224 * 224)
    return dados.reshape(t, 3, 224, 224).transpose(0, 2, 3, 1)


def processar(item):
    import mediapipe as mp
    destino = os.path.join(SAIDA, id_do_arquivo(item["arquivo"]) + ".npz")
    if os.path.exists(destino):
        return "pulado"
    bruto = baixar(item["arquivo"])
    if bruto is None:
        return "404"
    quadros = ler_quadros(bruto)[::2]                     # 16 quadros bastam (depois vira 12)
    t = len(quadros)
    pose = np.full((t, 33, 4), np.nan, np.float32)        # x, y, z, visibilidade
    maos = np.full((t, 2, 21, 3), np.nan, np.float32)     # até 2 mãos
    for i, q in enumerate(quadros):
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(q))
        rp = _pose.detect(img)
        if rp.pose_landmarks:
            pose[i] = [[p.x, p.y, p.z, p.visibility] for p in rp.pose_landmarks[0]]
            # Mãos em repouso (abaixadas) não interessam: pula a detecção, que é cara.
            centro_y = (pose[i, 11, 1] + pose[i, 12, 1]) / 2
            larg = abs(pose[i, 11, 0] - pose[i, 12, 0]) or 1e-6
            if min(pose[i, 15, 1], pose[i, 16, 1]) > centro_y + 2.0 * larg:
                continue
        rh = _hands.detect(img)
        for k, lm in enumerate(rh.hand_landmarks[:2]):
            maos[i, k] = [[p.x, p.y, p.z] for p in lm]
    tmp = destino + ".tmp.npz"
    np.savez_compressed(tmp, pose=pose.astype(np.float16), maos=maos.astype(np.float16),
                        largura=224, altura=224)
    os.replace(tmp, destino)
    return "ok"


def main():
    _prioridade_baixa()
    procs = int(sys.argv[1]) if len(sys.argv) > 1 else max(1, (os.cpu_count() or 2) - 2)
    os.makedirs(SAIDA, exist_ok=True)
    itens = json.load(open(os.path.join(AQUI, "lista_videos.json"), encoding="utf-8"))
    extras = os.path.join(AQUI, "lista_extras.json")
    if os.path.exists(extras):
        # Primeiro os vídeos de palavras essenciais, depois a tabela, depois o resto.
        ext = json.load(open(extras, encoding="utf-8"))
        ess = {" ".join(l.strip().lower().split()) for l in open(os.path.join(AQUI, "essenciais.txt"), encoding="utf-8")
               if l.strip() and not l.startswith("#")}
        da_tabela = lambda essencial: [x for x in itens if (" ".join(x["palavra"].lower().split()) in ess) == essencial]
        itens = ([x for x in ext if x["prioridade"] == 0] + da_tabela(True)
                 + da_tabela(False) + [x for x in ext if x["prioridade"] != 0])
    vistos, fila = set(), []
    for it in itens:
        if it["arquivo"] in vistos:
            continue
        vistos.add(it["arquivo"])
        if not os.path.exists(os.path.join(SAIDA, id_do_arquivo(it["arquivo"]) + ".npz")):
            fila.append(it)
    print(f"{len(vistos)} vídeos no total, {len(fila)} faltando, {procs} processos", flush=True)
    inicio, feitos, erros = time.time(), 0, 0
    with ProcessPoolExecutor(procs, initializer=_iniciar) as ex:
        # Envia aos poucos (poucas tarefas na fila) para seguir a ordem de prioridade.
        futuros, pos = {}, 0
        def abastecer():
            nonlocal pos
            while len(futuros) < procs * 4 and pos < len(fila):
                futuros[ex.submit(processar, fila[pos])] = fila[pos]
                pos += 1
        abastecer()
        while futuros:
            pronto = next(as_completed(futuros))
            item = futuros.pop(pronto)
            abastecer()
            f = pronto
            feitos += 1
            try:
                f.result()
            except Exception as e:
                erros += 1
                print("ERRO", item["arquivo"], e, flush=True)
            if feitos % 50 == 0 or feitos == len(fila):
                ritmo = feitos / (time.time() - inicio)
                resta = (len(fila) - feitos) / ritmo / 60 if ritmo else 0
                print(f"{feitos}/{len(fila)}  erros {erros}  {ritmo:.2f} vídeos/s  faltam ~{resta:.0f} min", flush=True)


if __name__ == "__main__":
    main()

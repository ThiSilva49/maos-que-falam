"""Teste: lê um tensor .pt do MALTA-LIBRAS sem PyTorch e mede se o MediaPipe acha as mãos."""
import sys
import zipfile

import mediapipe as mp
import numpy as np
from PIL import Image

from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import (HandLandmarker, HandLandmarkerOptions,
                                          PoseLandmarker, PoseLandmarkerOptions, RunningMode)


def ler_tensor(caminho):
    with zipfile.ZipFile(caminho) as z:
        nome = next(n for n in z.namelist() if n.endswith("/data/0"))
        bruto = z.read(nome)
    return np.frombuffer(bruto, dtype=np.uint8).reshape(32, 3, 224, 224).transpose(0, 2, 3, 1)


def main(caminho, folha):
    quadros = ler_tensor(caminho)
    Image.fromarray(np.vstack([np.hstack(list(quadros[i:i + 8])) for i in range(0, 32, 8)])).save(folha)

    for escala in (1, 2, 3):
        hands = HandLandmarker.create_from_options(HandLandmarkerOptions(
            base_options=BaseOptions(model_asset_path="modelos/hand_landmarker.task"),
            running_mode=RunningMode.IMAGE, num_hands=2,
            min_hand_detection_confidence=0.3, min_hand_presence_confidence=0.3))
        pose = PoseLandmarker.create_from_options(PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path="modelos/pose_landmarker_full.task"),
            running_mode=RunningMode.IMAGE))
        com_mao = maos = com_pose = 0
        for q in quadros:
            img = Image.fromarray(q)
            if escala > 1:
                img = img.resize((224 * escala, 224 * escala), Image.BICUBIC)
            mimg = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(img))
            r = hands.detect(mimg)
            com_mao += bool(r.hand_landmarks)
            maos += len(r.hand_landmarks)
            com_pose += bool(pose.detect(mimg).pose_landmarks)
        print(f"escala {escala}x: quadros com mão {com_mao}/32, mãos totais {maos}, pose {com_pose}/32")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

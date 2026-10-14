# 🤟 Mãos que Falam

Reunião por vídeo no navegador onde **Libras vira legenda e voz** e **a fala vira legenda** para quem não ouve.

- Salas por link, vídeo entre os participantes (WebRTC via [PeerJS](https://peerjs.com/)), chat e transcrição da conversa.
- **Quem usa Libras:** a câmera lê mãos e corpo ([MediaPipe](https://ai.google.dev/edge/mediapipe)), o sinal é comparado com uma biblioteca de vídeos de dicionários e a frase aparece como legenda para todos e é falada em voz alta para quem ouve. Dá para corrigir cada palavra com um clique, e a correção ensina o programa.
- **Quem fala:** a voz vira legenda em tempo real (reconhecimento de voz do Chrome/Edge).

Tudo roda no navegador de cada pessoa: vídeo, voz e sinais não passam por nenhum servidor nosso.

## Usar

Abra o site no **Chrome ou Edge**, crie uma reunião e mande o convite. Quem usa Libras: fique com ombros e peito na imagem, comece com as mãos abaixadas, faça o sinal e pare ou abaixe as mãos.

Limitações honestas: o reconhecimento compara com vídeos de outras pessoas e dicionários, então acerta parte das vezes (≈36% de primeira e ≈49% entre as 5 opções no vocabulário essencial, medido entre dicionários diferentes). Por isso as correções com clique e o “Ensinar um sinal” são importantes. Expressões faciais ainda não são consideradas.

## Rodar no computador

```
node servidor.js        # abre em http://localhost:8090
```

## Biblioteca de sinais

`biblioteca.bin` / `biblioteca.json` são gerados por `preparo/` a partir do
[MALTA-LIBRAS](https://huggingface.co/datasets/MALTA-Lab/MALTA_LIBRAS) (licença MIT, [Malta Lab](https://github.com/Malta-Lab/ISLR_LIBRAS)),
que reúne vídeos de INES, UFSC (Corpus Libras e SignBank), Spread the Sign, USP, UFV e YouTube.
Só os pontos das mãos e do corpo são guardados, não os vídeos.

```
cd preparo
uv run python -I listar.py && uv run python -I listar_extras.py   # lista vídeos e palavras
uv run python -I extrair.py 5                                     # baixa e extrai os pontos (retomável)
uv run python -I construir.py --avaliar                           # gera a biblioteca e mede o acerto
```

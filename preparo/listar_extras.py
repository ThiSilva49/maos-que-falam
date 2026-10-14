"""Vídeos do MALTA-LIBRAS que não estão na tabela de palavras: a palavra vem do nome do arquivo.

Gera lista_extras.json no mesmo formato de lista_videos.json (+ "prioridade": 0 = essencial, 1 = resto).
"""
import json
import os
import re
import unicodedata
import urllib.parse
from collections import Counter

AQUI = os.path.dirname(os.path.abspath(__file__))


def sem_acento(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def norm(s):
    return " ".join(unicodedata.normalize("NFC", s).strip().lower().split())


def palavra_do_arquivo(caminho):
    """(palavra, dicionário) a partir do caminho no repositório, ou None se não der para saber."""
    partes = caminho.split("/")
    if partes[0] == "malta_libras_MINDS_subset":
        return norm(partes[1].replace("_", " ")), "MINDS"
    pasta = partes[1]
    nome = urllib.parse.unquote(os.path.splitext(partes[-1])[0])
    if pasta in ("youtube", "youtube_v2"):
        m = re.match(r"Libras\s*-\s*(.+?)\s*\(", nome) or re.match(r"Libras\s*-\s*(.+)", nome)
        if not m:
            return None
        nome = m.group(1).split(" - ")[0]          # "Alegre - Contente" → "Alegre"
        dic = "Youtube"
    elif pasta == "acessibilidade_3":
        nome = re.sub(r"Sm_Prog\d+$", "", nome)
        dic = "Acessibilidades3"
    elif pasta == "acessibilidade_2":
        dic = "Acessibilidades2"
    elif pasta == "ufv":
        nome = re.sub(r"^\d+-", "", nome)
        dic = "UFV"
    elif pasta in ("ufsc", "ufsc_v2"):
        nome = nome.replace("-", " ")
        dic = "UFSC" if pasta == "ufsc" else "UFSC_V2"
    elif pasta == "spread_the_sign":
        nome = nome.replace("_interrogacao_", "?").replace("_exclamacao_", "!")
        dic = "SpreadTheSign"
    elif pasta == "usp":
        dic = "USP"
    else:
        return None
    nome = nome.replace("_", " ")
    nome = re.sub(r"(?<=[^\d\s])\d+$", "", nome.strip())   # variantes: "ajudar1", "BOBO2" (não mexe em "10")
    nome = norm(nome)
    if not nome or len(nome.split()) > 6:
        return None
    return nome, dic


def main():
    todos = json.load(open(os.path.join(AQUI, "todos_arquivos.json"), encoding="utf-8"))
    tabela = json.load(open(os.path.join(AQUI, "lista_videos.json"), encoding="utf-8"))
    usados = {x["arquivo"] for x in tabela}
    ess = {norm(l) for l in open(os.path.join(AQUI, "essenciais.txt"), encoding="utf-8")
           if l.strip() and not l.startswith("#")}

    # Recupera acentos: nomes como "familia" ganham a grafia acentuada conhecida ("família").
    acentuadas = {}
    for p in [norm(x["palavra"]) for x in tabela] + sorted(ess):
        if sem_acento(p) != p:
            acentuadas.setdefault(sem_acento(p), p)

    extras, ignorados = [], 0
    for f in todos:
        if f in usados or not f.startswith("malta_libras_complete/"):   # MINDS_subset repete vídeos dos dicionários
            continue
        r = palavra_do_arquivo(f)
        if not r:
            ignorados += 1
            continue
        p, dic = r
        if sem_acento(p) == p and p in acentuadas:
            p = acentuadas[p]
        elif sem_acento(p) == p and sem_acento(p) in acentuadas:
            p = acentuadas[sem_acento(p)]
        extras.append({"palavra": p, "dicionario": dic, "arquivo": f, "prioridade": 0 if p in ess else 1})

    json.dump(extras, open(os.path.join(AQUI, "lista_extras.json"), "w", encoding="utf-8"), ensure_ascii=False)
    pri = Counter(x["prioridade"] for x in extras)
    print(f"extras: {len(extras)} (essenciais: {pri[0]}, resto: {pri[1]}), sem palavra: {ignorados}")
    todos_rot = Counter(norm(x["palavra"]) for x in tabela) + Counter(x["palavra"] for x in extras)
    cob = [(p, todos_rot.get(p, 0)) for p in sorted(ess)]
    print(f"essenciais cobertos agora: {sum(1 for _, n in cob if n)} de {len(ess)}; com 2+ vídeos: {sum(1 for _, n in cob if n >= 2)}")
    print("ainda faltam:", ", ".join(p for p, n in cob if not n))


if __name__ == "__main__":
    main()

"""Lista os arquivos do MALTA-LIBRAS e cruza com o CSV de palavras."""
import ast, csv, json, os, urllib.parse
from huggingface_hub import HfApi, hf_hub_download

REPO = "MALTA-Lab/MALTA_LIBRAS"
api = HfApi()
arquivos = [f for f in api.list_repo_files(REPO, repo_type="dataset")
            if f.startswith("malta_libras_complete/") and f.endswith(".pt")]
print("arquivos .pt:", len(arquivos))
por_nome = {}
for f in arquivos:
    por_nome.setdefault(urllib.parse.unquote(os.path.basename(f)), []).append(f)

csv_path = hf_hub_download(REPO, "malta_libras_complete/malta_libras_complete.csv", repo_type="dataset")
itens, faltando = [], 0
with open(csv_path, encoding="utf-8") as fh:
    for row in csv.DictReader(fh):
        for p in ast.literal_eval(row["path"]):
            nome = os.path.basename(p)
            pasta = p.split("/")[1]
            cand = por_nome.get(nome, [])
            if not cand:
                faltando += 1
                continue
            # "checked" = palavra com grafia corrigida; "lemma" é uma raiz automática cheia de erros ("amig", "dinamarque")
            itens.append({"palavra": row["checked"], "lema": row["lemma"], "dicionario": row["dictionary"],
                          "arquivo": cand[0] if len(cand) == 1 else next((c for c in cand if pasta.lower()[:4] in c.lower()), cand[0])})
print("itens com arquivo:", len(itens), "sem arquivo:", faltando)
json.dump(itens, open("lista_videos.json", "w", encoding="utf-8"), ensure_ascii=False)
import random
random.seed(0)
for it in random.sample(itens, 25): print(it["palavra"], "|", it["dicionario"], "|", it["arquivo"])

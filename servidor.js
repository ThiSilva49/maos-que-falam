// Servidor local mínimo: a câmera e o microfone só funcionam em http://localhost ou https.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8090;
const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".bin": "application/octet-stream",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const PERMITIDOS = new Set(["index.html", "app.js", "libras.js", "estilo.css", "biblioteca.json", "biblioteca.bin"]);

http.createServer((req, res) => {
  let nome = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
  if (!PERMITIDOS.has(nome)) { res.writeHead(404); res.end("não encontrado"); return; }
  const arquivo = path.join(__dirname, nome);
  fs.stat(arquivo, (err) => {
    if (err) { res.writeHead(404); res.end("não encontrado"); return; }
    res.writeHead(200, { "Content-Type": TIPOS[path.extname(nome)], "Cache-Control": "no-cache" });
    fs.createReadStream(arquivo).pipe(res);
  });
}).listen(PORT, () => console.log(`Abra http://localhost:${PORT} no Chrome ou Edge`));

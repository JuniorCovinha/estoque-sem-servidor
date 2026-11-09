// Servidor estático mínimo SÓ PARA TESTE/VISUALIZAÇÃO no navegador embutido (que não roda o app via file://).
// Somente leitura, somente localhost. O uso real do app continua sendo abrir o index.html direto (file://).
// Uso: node tools/servidor-teste.js   →   http://localhost:8765
const http = require('http'), fs = require('fs'), path = require('path');
const raiz = path.resolve(__dirname, '..');
const porta = Number(process.env.PORTA) || 8765;
const tipos = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.xlsx': 'application/octet-stream',
};
http.createServer((req, res) => {
  let caminho;
  try { caminho = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  const arq = path.normalize(path.join(raiz, caminho === '/' ? '/index.html' : caminho));
  if (!arq.startsWith(raiz + path.sep) || arq.includes(path.sep + 'dados' + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(arq, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': tipos[path.extname(arq)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(porta, '127.0.0.1', () => console.log(`Estoque TI (teste): http://localhost:${porta}`));

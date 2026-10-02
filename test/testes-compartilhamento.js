/* Testes do compartilhamento pela pasta do SharePoint: versão do aplicativo no arquivo, planilha de consulta
   e arquivo derivado / teste de gravação na pasta. Uso: node test/testes-compartilhamento.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const raiz = path.join(__dirname, '..');
globalThis.window = globalThis;
for (const f of ['vendor/xlsx.full.min.js', 'js/util.js', 'js/ledger.js', 'js/exporter.js', 'js/sync.js', 'js/remoto.js', 'js/sessao.js', 'js/store.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(raiz, f), 'utf8'), { filename: f });
}
const { ledger: L, exporter: E, sync: Y, remoto: R, store: S } = globalThis.App;

let ok = 0, falhas = 0;
const fila = [];
const teste = (nome, fn) => fila.push([nome, fn]);
const secao = titulo => fila.push([titulo, null]);
async function rodar() {
  for (const [nome, fn] of fila) {
    if (!fn) { console.log('\n' + nome); continue; }
    try { await fn(); ok++; console.log('  ✓ ' + nome); }
    catch (e) { falhas++; console.log('  ✗ ' + nome + '\n      ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n      ')); }
  }
  console.log(`\n${ok} ok, ${falhas} falha(s)`);
  process.exit(falhas ? 1 : 0);
}

// Pasta falsa mínima no formato da File System Access API. falharEscrita: nome do erro a lançar ao gravar.
function pastaFalsa(falharEscrita) {
  const arquivos = new Map();
  const erro = nome => { const e = new Error(nome); e.name = nome; return e; };
  const dir = {
    arquivos,
    async getFileHandle(nome, op) {
      if (!arquivos.has(nome) && !(op && op.create)) throw erro('NotFoundError');
      return {
        async getFile() { const c = arquivos.get(nome); return { text: async () => (typeof c === 'string' ? c : '[binário]') }; },
        async createWritable() {
          if (falharEscrita) throw erro(falharEscrita);
          let buf = null;
          return { async write(c) { buf = c; }, async close() { arquivos.set(nome, buf); } };
        },
      };
    },
    async getDirectoryHandle() { return dir; },
    async removeEntry(nome) { arquivos.delete(nome); },
    async *values() { for (const nome of arquivos.keys()) yield { kind: 'file', name: nome }; },
  };
  return dir;
}
const remotoPasta = dir => R.pasta({ obterPasta: () => dir, ultimoBackup: { ler: async () => null, gravar: async () => {} } });

secao('Versão do aplicativo');

teste('comparação de versões', () => {
  assert.strictEqual(Y.compararVersoes('2.2.0', '2.10.0'), -1);
  assert.strictEqual(Y.compararVersoes('3.0', '2.9.9'), 1);
  assert.strictEqual(Y.compararVersoes('2.2.0', '2.2'), 0);
});

teste('o arquivo gravado leva a versão de quem gravou; arquivo de versão maior deixa este computador desatualizado', () => {
  const db = L.novoBanco();
  const texto = Y.serializarRemoto(db, new Map());
  const obj = JSON.parse(texto);
  assert.strictEqual(obj.versaoApp, Y.VERSAO_APP);
  assert.strictEqual(obj.versaoMaxima, Y.VERSAO_APP);
  Y.abrirRemoto(texto, S.validarBanco);
  assert.strictEqual(Y.situacaoVersao().desatualizado, false);
  // Outro computador, com versão mais nova, gravou o arquivo.
  obj.versaoApp = '9.0.0'; obj.versaoMaxima = '9.0.0';
  Y.abrirRemoto(JSON.stringify(obj), S.validarBanco);
  const v = Y.situacaoVersao();
  assert.strictEqual(v.desatualizado, true);
  assert.strictEqual(v.maxima, '9.0.0');
  // A versão máxima vista não diminui ao gravar de novo com a versão antiga.
  assert.strictEqual(JSON.parse(Y.serializarRemoto(db, new Map())).versaoMaxima, '9.0.0');
});

teste('versão em formato inválido no arquivo é ignorada', () => {
  const obj = JSON.parse(Y.serializarRemoto(L.novoBanco(), new Map()));
  obj.versaoMaxima = '<script>'; obj.versaoApp = { x: 1 };
  Y.abrirRemoto(JSON.stringify(obj), S.validarBanco);
  assert.ok(Y.situacaoVersao().maxima !== '<script>');
});

secao('Planilha de consulta');

teste('planilha de consulta tem a aba LEIA-ME no início e as abas de dados', () => {
  const db = L.novoBanco();
  L.cadastrarItem(db, { categoria: 'Mouse', descricao: 'M90', controle: 'quantidade', quantidade: 3, local: 'MATRIZ' });
  const bin = E.planilhaConsultaBinaria(db, { autor: 'Operador Teste', versao: Y.VERSAO_APP });
  const wb = XLSX.read(bin, { type: 'array' });
  assert.strictEqual(wb.SheetNames[0], 'LEIA-ME');
  for (const aba of ['Estoque', 'Movimentações', 'Descarte', 'Toner', 'Lixeira']) assert.ok(wb.SheetNames.includes(aba), aba);
  const leia = XLSX.utils.sheet_to_json(wb.Sheets['LEIA-ME'], { header: 1 }).map(l => l.join(' ')).join('\n');
  assert.ok(/NÃO EDITE/.test(leia) && /Operador Teste/.test(leia));
  assert.strictEqual(XLSX.utils.sheet_to_json(wb.Sheets.Estoque).length, 1);
});

teste('arquivo derivado: grava .xlsx ao lado do estoque.json e recusa nomes perigosos', async () => {
  const dir = pastaFalsa();
  const rem = remotoPasta(dir);
  await rem.gravarArquivoDerivado('estoque-consulta.xlsx', 'conteudo');
  assert.ok(dir.arquivos.has('estoque-consulta.xlsx'));
  for (const ruim of ['estoque.json', '../x.xlsx', 'a/b.xlsx', 'planilha.json', 'x.xlsx.exe']) {
    await assert.rejects(rem.gravarArquivoDerivado(ruim, 'x'), /inválido/, ruim);
  }
});

secao('Gravação na pasta');

teste('teste de gravação: true quando grava, false em pasta só de leitura, sem deixar arquivo de teste', async () => {
  const dir = pastaFalsa();
  assert.strictEqual(await remotoPasta(dir).testarEscrita(), true);
  assert.ok(!dir.arquivos.has('.estoque-teste-escrita'), 'arquivo de teste removido');
  for (const nome of ['NoModificationAllowedError', 'InvalidModificationError', 'NotAllowedError']) {
    assert.strictEqual(await remotoPasta(pastaFalsa(nome)).testarEscrita(), false, nome);
  }
});

teste('cópias de conflito do OneDrive: só estoque*.json entram no aviso (a planilha de consulta não)', async () => {
  const dir = pastaFalsa();
  dir.arquivos.set('estoque.json', '{}');
  dir.arquivos.set('estoque-consulta.xlsx', 'x');
  dir.arquivos.set('estoque-PC-INFRA.json', '{}');
  assert.deepStrictEqual(await remotoPasta(dir).copiasExtras(), ['estoque-PC-INFRA.json']);
});

rodar();

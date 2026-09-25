/* Testes da edição em lote (Node, sem navegador).
   Uso: node test/testes-lote.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const raiz = path.join(__dirname, '..');
globalThis.window = globalThis;
for (const f of ['vendor/xlsx.full.min.js', 'js/util.js', 'js/ledger.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(raiz, f), 'utf8'), { filename: f });
}
const { ledger: L } = globalThis.App;

let ok = 0, falhas = 0;
function teste(nome, fn) {
  try { fn(); ok++; console.log('  ✓ ' + nome); }
  catch (e) { falhas++; console.log('  ✗ ' + nome + '\n      ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n      ')); }
}
const hoje = globalThis.App.util.hojeISO();
const lanca = (fn, re) => assert.throws(fn, e => re.test(e.message));
const edicoes = db => db.movimentos.filter(m => m.tipo === 'EDICAO');

function bancoTablets(n) {
  const db = L.novoBanco();
  for (let i = 1; i <= n; i++) {
    L.cadastrarItem(db, { categoria: 'Samsung Galaxy Tab A9', descricao: 'Tab A9', controle: 'unidade', serie: 'T' + i, local: 'MATRIZ', data: hoje, posicao: 'A P1' });
  }
  return db;
}

console.log('\nEdição em lote de itens');

teste('altera todos e gera um EDICAO por item, ligados pelo mesmo lote', () => {
  const db = bancoTablets(11);
  const ids = db.itens.map(i => i.id);
  const n = L.editarItensEmLote(db, ids, { categoria: 'Tablet Samsung', descricao: '', posicao: '  ', obs: undefined });
  assert.strictEqual(n, 11);
  assert.ok(db.itens.every(i => i.categoria === 'Tablet Samsung' && i.descricao === 'Tab A9' && i.posicao === 'A P1'));
  const eds = edicoes(db);
  assert.strictEqual(eds.length, 11);
  assert.deepStrictEqual(new Set(eds.map(m => m.itemId)), new Set(ids));
  assert.strictEqual(new Set(eds.map(m => m.lote)).size, 1);
  assert.ok(eds.every(m => /^Edição em lote \(11 itens\)/.test(m.obs) && m.alteracoes.length === 1 && m.alteracoes[0].campo === 'categoria'));
  assert.ok(eds.every(m => m.item.categoria === 'Tablet Samsung'));
  assert.deepStrictEqual(L.verificarConsistencia(db), []);
});

teste('se um item falhar na validação, nenhum é alterado', () => {
  const db = bancoTablets(3);
  const antes = JSON.stringify(db);
  const ids = db.itens.map(i => i.id).concat('inexistente');
  lanca(() => L.editarItensEmLote(db, ids, { categoria: 'Tablet Samsung' }), /não encontrado/);
  assert.strictEqual(JSON.stringify(db), antes);
});

teste('série e patrimônio não podem ser editados em lote', () => {
  const db = bancoTablets(2);
  const antes = JSON.stringify(db);
  const ids = db.itens.map(i => i.id);
  lanca(() => L.editarItensEmLote(db, ids, { categoria: 'X', serie: 'S9' }), /série não pode ser alterado em lote/);
  lanca(() => L.editarItensEmLote(db, ids, { patrimonio: '123' }), /Patrimônio não pode ser alterado em lote/);
  assert.strictEqual(JSON.stringify(db), antes);
  // Vazios nesses campos são simplesmente ignorados.
  assert.strictEqual(L.editarItensEmLote(db, ids, { serie: '', patrimonio: '', posicao: 'B P2' }), 2);
});

teste('campos vazios não alteram e ao menos um campo é exigido', () => {
  const db = bancoTablets(2);
  const ids = db.itens.map(i => i.id);
  lanca(() => L.editarItensEmLote(db, ids, { categoria: '', descricao: '   ', obs: null }), /ao menos um campo/);
  lanca(() => L.editarItensEmLote(db, [], { categoria: 'X' }), /Nenhum registro/);
  L.editarItensEmLote(db, ids, { proprietario: 'Locadora X' });
  assert.ok(db.itens.every(i => i.proprietario === 'Locadora X' && i.categoria === 'Samsung Galaxy Tab A9'));
});

teste('itens sem mudança real não geram movimento', () => {
  const db = bancoTablets(4);
  const [a, b] = db.itens;
  L.editarItem(db, a.id, { posicao: 'C P9' });
  const antes = db.movimentos.length;
  const n = L.editarItensEmLote(db, db.itens.map(i => i.id), { posicao: 'C P9' });
  assert.strictEqual(n, 3);
  assert.strictEqual(db.movimentos.length, antes + 3);
  assert.ok(!db.movimentos.slice(antes).some(m => m.itemId === a.id));
  assert.strictEqual(L.editarItensEmLote(db, [a.id, b.id, a.id], { posicao: 'C P9' }), 0);
  assert.strictEqual(db.movimentos.length, antes + 3);
});

console.log('\nEdição em lote de descartes');

function bancoDescartes() {
  const db = L.novoBanco();
  const cad = (categoria, serie) => L.cadastrarItem(db, { categoria, descricao: 'Modelo', controle: 'unidade', serie, local: 'MATRIZ', data: hoje });
  const itens = [cad('Teclado', 'K1'), cad('Mouse', 'M1'), cad('Headset', 'H1'), cad('Notebook', 'N1')];
  for (const it of itens) L.descartar(db, it.id, { justificativa: 'Quebrado', data: hoje });
  return db;
}
const descartes = db => db.movimentos.filter(m => m.tipo === 'DESCARTE');

teste('marca "Não se aplica" nos periféricos e registra EDICAO por registro', () => {
  const db = bancoDescartes();
  const perif = descartes(db).filter(m => !L.guardaDados(m.item.categoria));
  assert.strictEqual(perif.length, 3);
  const n = L.editarDescartesEmLote(db, perif.map(m => m.id), { dadosApagados: 'NAO_SE_APLICA', metodo: '', certificado: 'Lote 42', justificativa: '' });
  assert.strictEqual(n, 3);
  assert.ok(perif.every(m => m.descarte.dadosApagados === 'NAO_SE_APLICA' && m.descarte.certificado === 'Lote 42' && m.descarte.justificativa === 'Quebrado'));
  const nb = descartes(db).find(m => m.item.categoria === 'Notebook');
  assert.strictEqual(nb.descarte.dadosApagados, 'NAO_INFORMADO');
  const eds = edicoes(db);
  assert.strictEqual(eds.length, 3);
  assert.ok(eds.every(m => m.refMovimento && /^Edição em lote \(3 registros\) — Descarte:/.test(m.obs)));
  assert.strictEqual(new Set(eds.map(m => m.lote)).size, 1);
  // Repetir não gera novos movimentos.
  assert.strictEqual(L.editarDescartesEmLote(db, perif.map(m => m.id), { dadosApagados: 'NAO_SE_APLICA' }), 0);
  assert.strictEqual(edicoes(db).length, 3);
  assert.deepStrictEqual(L.verificarConsistencia(db), []);
});

teste('descarte: registro inválido ou opção inválida não altera nada', () => {
  const db = bancoDescartes();
  const antes = JSON.stringify(db);
  const ids = descartes(db).map(m => m.id);
  const naoDescarte = db.movimentos.find(m => m.tipo === 'ENTRADA').id;
  lanca(() => L.editarDescartesEmLote(db, ids.concat(naoDescarte), { dadosApagados: 'SIM' }), /não encontrado/);
  lanca(() => L.editarDescartesEmLote(db, ids, { dadosApagados: 'TALVEZ' }), /inválida/);
  lanca(() => L.editarDescartesEmLote(db, ids, { dadosApagados: 'constructor' }), /inválida/);
  lanca(() => L.editarDescartesEmLote(db, ids, { valorUnit: '10' }), /não pode ser alterado em lote/);
  lanca(() => L.editarDescartesEmLote(db, ids, { dadosApagados: '' }), /ao menos um campo/);
  assert.strictEqual(JSON.stringify(db), antes);
});

teste('simulação numa cópia não altera o banco original', () => {
  const db = bancoTablets(3);
  const antes = JSON.stringify(db);
  const n = L.editarItensEmLote(structuredClone(db), db.itens.map(i => i.id), { descricao: 'Galaxy Tab A9' });
  assert.strictEqual(n, 3);
  assert.strictEqual(JSON.stringify(db), antes);
});

console.log(`\n${ok} ok, ${falhas} falha(s)`);
process.exit(falhas ? 1 : 0);

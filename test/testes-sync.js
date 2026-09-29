/* Testes da sincronização por operações (Node, sem navegador).
   Uso: node test/testes-sync.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const raiz = path.join(__dirname, '..');
globalThis.window = globalThis;
for (const f of ['vendor/xlsx.full.min.js', 'js/util.js', 'js/ledger.js', 'js/exporter.js', 'js/sync.js', 'js/remoto.js', 'js/store.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(raiz, f), 'utf8'), { filename: f });
}
const { ledger: L, sync: Y, remoto: R, store: ST, util: U } = globalThis.App;

let ok = 0, falhas = 0;
const fila = [];
function teste(nome, fn) { fila.push([nome, fn]); }
function secao(titulo) { fila.push([titulo, null]); }
async function rodar() {
  for (const [nome, fn] of fila) {
    if (!fn) { console.log('\n' + nome); continue; }
    try { await fn(); ok++; console.log('  ✓ ' + nome); }
    catch (e) { falhas++; console.log('  ✗ ' + nome + '\n      ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n      ')); }
  }
  console.log(`\n${ok} ok, ${falhas} falha(s)`);
  process.exit(falhas ? 1 : 0);
}
const DIA = '2026-09-01';
const rejeita = async (p, re) => assert.rejects(p, e => re.test(e.message));

// Um "PC": motor com remoto compartilhado e estado local guardado em memória.
function pc(remoto, nome) {
  const salvos = [];
  const m = Y.criarMotor({ remoto, validar: ST.validarBanco, persistir: async s => { salvos.push(structuredClone(s)); } });
  m.autor = { nome, email: nome.toLowerCase() + '@exemplo.test' };
  m.salvos = salvos;
  m.exec = async (n, a) => (await m.executar(n, a, m.autor)).resultado;
  return m;
}
// Sincroniza e confere a consistência do banco exibido e do remoto.
async function sync(m, remoto) {
  const r = await m.sincronizar();
  assert.deepStrictEqual(L.verificarConsistencia(m.db), [], 'banco local consistente');
  if (remoto && remoto.texto) assert.deepStrictEqual(L.verificarConsistencia(Y.abrirRemoto(remoto.texto, ST.validarBanco).db), [], 'remoto consistente');
  return r;
}
const remotoDb = rem => Y.abrirRemoto(rem.texto, ST.validarBanco);
const notebook = serie => ({ categoria: 'Notebook Dell', descricao: 'Latitude 3420', controle: 'unidade', serie, local: 'MATRIZ', data: DIA });

secao('Determinismo');

teste('dentro da operação: ids derivados de op.id e horário = op.criadoEm; fora, comportamento normal', () => {
  const op = { id: 'aaaaaaaa-0000-4000-8000-000000000001', criadoEm: '2026-09-01T13:00:00.000Z', autor: { nome: 'Ana', email: null } };
  const r = U.comContexto(op, () => [U.uid(), U.uid(), U.agoraISO(), U.autorAtual()]);
  assert.deepStrictEqual(r, [op.id + '-1', op.id + '-2', op.criadoEm, { nome: 'Ana', email: null }]);
  assert.notStrictEqual(U.uid(), op.id + '-3');
  assert.strictEqual(U.autorAtual(), null);
  assert.ok(Math.abs(Date.parse(U.agoraISO()) - Date.now()) < 5000);
});

teste('reaplicar a mesma operação em cópias gera exatamente o mesmo resultado', () => {
  const op = Y.novaOperacao('cadastrarItem', [notebook('DET1')], { nome: 'Ana' });
  const a = L.novoBanco(), b = structuredClone(a);
  Y.aplicar(a, op); Y.aplicar(b, op);
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  assert.strictEqual(a.itens[0].id, op.id + '-1');
  assert.strictEqual(a.movimentos[0].criadoEm, op.criadoEm);
  assert.deepStrictEqual(a.movimentos[0].autor, { nome: 'Ana', email: null });
});

teste('cadastrar offline + entregar o mesmo item → rebase num remoto que mudou → ok', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana'), B = pc(rem, 'Bruno');
  await B.exec('cadastrarItem', [{ categoria: 'Mouse', descricao: 'M90', controle: 'quantidade', quantidade: 5, local: 'MATRIZ', data: DIA }]);
  await sync(B, rem);
  await sync(A, rem);
  rem.offline = true;
  const it = await A.exec('cadastrarItem', [notebook('OFF1')]);
  await A.exec('entregar', [it.id, { usuario: 'Fulana', data: DIA }]);
  assert.strictEqual((await A.sincronizar()).semConexao, true);
  rem.offline = false;
  const mouse = B.db.itens[0];
  await B.exec('entregar', [mouse.id, { usuario: 'Beltrano', local: 'MATRIZ', quantidade: 2, data: DIA }]);
  await sync(B, rem); // remoto mudou depois que A ficou offline
  const r = await sync(A, rem);
  assert.strictEqual(r.aplicadas, 2);
  assert.strictEqual(A.conflitos.length, 0);
  assert.strictEqual(A.pendentes.length, 0);
  const nb = A.db.itens.find(i => i.serie === 'OFF1');
  assert.strictEqual(nb.id, it.id, 'mesmo id da primeira aplicação');
  assert.strictEqual(nb.status, 'ENTREGUE');
  assert.strictEqual(A.db.itens.find(i => i.id === mouse.id).saldo.MATRIZ, 3, 'alteração do outro PC preservada');
  const entrega = A.db.movimentos.find(m => m.tipo === 'ENTREGA' && m.itemId === it.id);
  assert.deepStrictEqual(entrega.autor, A.autor);
  await sync(B, rem);
  assert.strictEqual(JSON.stringify(B.db), JSON.stringify(A.db), 'os dois PCs convergem');
});

secao('Conflitos');

teste('dois PCs offline entregam o MESMO notebook: um aplica, o outro vira conflito', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana'), B = pc(rem, 'Bruno');
  const nb = await A.exec('cadastrarItem', [notebook('NB-1')]);
  await sync(A, rem); await sync(B, rem);
  rem.offline = true;
  await A.exec('entregar', [nb.id, { usuario: 'Fulana', data: DIA }]);
  await B.exec('entregar', [nb.id, { usuario: 'Beltrano', data: DIA }]);
  rem.offline = false;
  await sync(A, rem);
  const r = await sync(B, rem);
  assert.strictEqual(r.conflitos, 1);
  assert.strictEqual(B.pendentes.length, 0, 'sai da fila');
  const [c] = B.conflitos;
  assert.ok(/não pode ser entregue/.test(c.erro), c.erro);
  assert.strictEqual(c.op.nome, 'entregar');
  assert.deepStrictEqual(c.op.autor, B.autor);
  assert.strictEqual(B.db.itens[0].responsavelAtual, 'Fulana');
  assert.strictEqual(remotoDb(rem).db.movimentos.filter(m => m.tipo === 'ENTREGA').length, 1);
  // Nada é descartado sozinho: tentar de novo falha e mantém; descartar remove.
  await rejeita(B.tentarDeNovo(c.id), /não pode ser entregue/);
  assert.strictEqual(B.conflitos.length, 1);
  await B.descartarConflito(c.id);
  assert.strictEqual(B.conflitos.length, 0);
});

teste('"Tentar de novo" devolve a operação para a fila quando ela volta a ser possível', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana'), B = pc(rem, 'Bruno');
  const nb = await A.exec('cadastrarItem', [notebook('NB-2')]);
  await sync(A, rem); await sync(B, rem);
  rem.offline = true;
  await A.exec('entregar', [nb.id, { usuario: 'Fulana', data: DIA }]);
  await B.exec('entregar', [nb.id, { usuario: 'Beltrano', data: DIA }]);
  rem.offline = false;
  await sync(A, rem); await sync(B, rem);
  const [c] = B.conflitos;
  await A.exec('devolver', [nb.id, { local: 'MATRIZ', data: DIA }]);
  await sync(A, rem); await sync(B, rem);
  await B.tentarDeNovo(c.id);
  assert.strictEqual(B.conflitos.length, 0);
  assert.strictEqual(B.pendentes.length, 1);
  await sync(B, rem);
  assert.strictEqual(remotoDb(rem).db.itens[0].responsavelAtual, 'Beltrano');
});

secao('Idempotência e concorrência');

teste('gravação aceita mas resposta perdida → reenvio não duplica', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  await A.exec('cadastrarItem', [{ categoria: 'Cabo', descricao: 'HDMI', controle: 'quantidade', quantidade: 10, local: 'MATRIZ', data: DIA }]);
  await sync(A, rem);
  const cabo = A.db.itens[0];
  await A.exec('entregar', [cabo.id, { usuario: 'Fulana', local: 'MATRIZ', quantidade: 3, data: DIA }]);
  rem.perderResposta = 1;
  await rejeita(A.sincronizar(), /Resposta perdida/);
  assert.strictEqual(A.pendentes.length, 1, 'continua na fila');
  const gravacoes = rem.gravacoes;
  await sync(A, rem);
  assert.strictEqual(A.pendentes.length, 0);
  assert.strictEqual(rem.gravacoes, gravacoes, 'nada a regravar');
  const db = remotoDb(rem).db;
  assert.strictEqual(db.movimentos.filter(m => m.tipo === 'ENTREGA').length, 1);
  assert.strictEqual(db.itens[0].saldo.MATRIZ, 7);
  assert.strictEqual(A.db.itens[0].saldo.MATRIZ, 7);
});

teste('precondição falha no meio (outro PC gravou) → nova leitura, rebase e sucesso', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana'), B = pc(rem, 'Bruno');
  const teclado = await A.exec('cadastrarItem', [{ categoria: 'Teclado', descricao: 'K120', controle: 'quantidade', quantidade: 5, local: 'MATRIZ', data: DIA }]);
  await sync(A, rem); await sync(B, rem);
  await A.exec('entregar', [teclado.id, { usuario: 'Fulana', local: 'MATRIZ', quantidade: 1, data: DIA }]);
  await B.exec('entregar', [teclado.id, { usuario: 'Beltrano', local: 'MATRIZ', quantidade: 2, data: DIA }]);
  let chamadas = 0;
  rem.antesDeGravar = async () => { chamadas++; await sync(B, rem); };
  const r = await sync(A, rem);
  assert.strictEqual(chamadas, 1);
  assert.strictEqual(r.aplicadas, 1);
  const db = remotoDb(rem).db;
  assert.strictEqual(db.itens[0].saldo.MATRIZ, 2);
  assert.deepStrictEqual(db.movimentos.filter(m => m.tipo === 'ENTREGA').map(m => m.usuario).sort(), ['Beltrano', 'Fulana']);
});

teste('precondição falhando sempre → desiste após o limite e mantém a fila', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  await A.exec('adicionarToner', [{ modelo: 'W9008', status: 'NOVO', quantidade: 1, data: DIA }]);
  const outro = async m => { m.substituir(m.texto || Y.serializarRemoto(L.novoBanco(), new Map())); m.antesDeGravar = outro; };
  rem.antesDeGravar = outro;
  await rejeita(A.sincronizar(), /várias vezes/);
  assert.strictEqual(A.pendentes.length, 1);
  rem.antesDeGravar = null;
  await sync(A, rem);
  assert.strictEqual(A.pendentes.length, 0);
});

teste('operação feita durante a sincronização continua na fila e é enviada', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  const it = await A.exec('cadastrarItem', [{ categoria: 'Mouse', descricao: 'M90', controle: 'quantidade', quantidade: 4, local: 'MATRIZ', data: DIA }]);
  rem.antesDeGravar = async () => { await A.exec('entrada', [it.id, { local: 'MATRIZ', quantidade: 1, data: DIA }]); };
  const p = A.sincronizar();
  await p;
  await sync(A, rem);
  assert.strictEqual(A.pendentes.length, 0);
  assert.strictEqual(remotoDb(rem).db.itens[0].saldo.MATRIZ, 5);
});

secao('Segurança');

teste('operação fora da lista branca é rejeitada (não executa nada)', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  for (const nome of ['verificarConsistencia', 'novoBanco', '__proto__', 'constructor', 'toString', 'eval', 'registrar', 42, null]) {
    await rejeita(A.executar(nome, [], A.autor), /não permitida/);
    assert.throws(() => Y.aplicar(L.novoBanco(), { id: 'aaaaaaaa-1', nome, args: [], criadoEm: new Date().toISOString(), autor: null }), /não permitida/);
  }
  assert.strictEqual(A.pendentes.length, 0);
  // Fila adulterada no armazenamento local: vira conflito, não é executada.
  const B = pc(rem, 'Bruno');
  B.carregar({ base: { db: L.novoBanco(), etag: null, aplicadas: [] }, pendentes: [{ id: 'bbbbbbbb-1', nome: 'constructor', args: [], criadoEm: new Date().toISOString() }] });
  assert.strictEqual(B.pendentes.length, 0);
  assert.strictEqual(B.conflitos.length, 1);
  assert.ok(/não permitida/.test(B.conflitos[0].erro));
});

teste('argumentos não serializáveis são recusados; alterar o objeto depois não muda a operação', async () => {
  const A = pc(R.memoria(), 'Ana');
  const ciclo = {}; ciclo.eu = ciclo;
  await rejeita(A.executar('cadastrarItem', [ciclo], A.autor), /serializáveis/);
  await rejeita(A.executar('cadastrarItem', { categoria: 'x' }, A.autor), /lista/);
  const d = notebook('SER-1');
  const { op } = await A.executar('cadastrarItem', [d], A.autor);
  d.serie = 'OUTRA';
  assert.strictEqual(op.args[0].serie, 'SER-1');
});

teste('erro de regra: nada muda e nada entra na fila', async () => {
  const A = pc(R.memoria(), 'Ana');
  await A.exec('cadastrarItem', [notebook('DUP-1')]);
  const antes = JSON.stringify(A.db);
  await rejeita(A.executar('cadastrarItem', [notebook('dup-1')], A.autor), /Já existe/);
  assert.strictEqual(JSON.stringify(A.db), antes);
  assert.strictEqual(A.pendentes.length, 1);
});

teste('lista branca pode ser estendida (convenção L.fn(db, argsObj))', async () => {
  L.testeMarcar = (db, d) => { db.marca = d.valor; return d.valor; };
  Y.registrarOperacao('testeMarcar', 'Teste');
  const A = pc(R.memoria(), 'Ana');
  assert.strictEqual(await A.exec('testeMarcar', [{ valor: 7 }]), 7);
  assert.strictEqual(A.db.marca, 7);
  assert.strictEqual(Y.rotuloOperacao('testeMarcar'), 'Teste');
  assert.throws(() => Y.registrarOperacao('x y', 'ruim'), /inválido/);
  delete L.testeMarcar;
});

secao('Migração e formato');

teste('estoque.json antigo (schema 1): migra para o novo formato sem perder dados', async () => {
  const antigo = L.novoBanco();
  L.cadastrarItem(antigo, notebook('LEG-1'));
  const rem = R.memoria(JSON.stringify(antigo, null, 1));
  const A = pc(rem, 'Ana');
  A.carregar({ base: { db: structuredClone(antigo), etag: null, aplicadas: [] } }); // 'db' antigo do IndexedDB
  await A.exec('entregar', [antigo.itens[0].id, { usuario: 'Fulana', data: DIA }]);
  await sync(A, rem);
  const obj = JSON.parse(rem.texto);
  assert.strictEqual(obj.formato, 'estoque-ti');
  assert.strictEqual(obj.schema, 2);
  assert.strictEqual(obj.db.schema, 1);
  assert.strictEqual(obj.db.itens[0].status, 'ENTREGUE');
  assert.strictEqual(Object.keys(obj.operacoesAplicadas).length, 1);
  assert.strictEqual(obj.db.movimentos.length, 2);
  // Um PC novo (sem dados) adota o remoto.
  const B = pc(rem, 'Bruno');
  await sync(B, rem);
  assert.strictEqual(JSON.stringify(B.db), JSON.stringify(A.db));
});

teste('schema 1 sem alterações locais também é migrado (uma gravação)', async () => {
  const antigo = L.novoBanco();
  L.cadastrarItem(antigo, notebook('LEG-2'));
  const rem = R.memoria(JSON.stringify(antigo));
  const A = pc(rem, 'Ana');
  A.carregar({ base: { db: structuredClone(antigo), etag: null, aplicadas: [] } });
  const r = await sync(A, rem);
  assert.ok(r.gravou);
  assert.strictEqual(JSON.parse(rem.texto).schema, 2);
  assert.strictEqual((await sync(A, rem)).gravou, false, 'depois disso, nada a gravar');
});

teste('versões diferentes na primeira ligação: o usuário escolhe (arquivo ou navegador)', async () => {
  const doArquivo = L.novoBanco(); L.cadastrarItem(doArquivo, notebook('ARQ-1'));
  const doNavegador = L.novoBanco(); L.cadastrarItem(doNavegador, notebook('NAV-1'));
  doNavegador.atualizadoEm = '2000-01-01T00:00:00.000Z';
  for (const usar of ['arquivo', 'navegador']) {
    const rem = R.memoria(JSON.stringify(doArquivo));
    const A = pc(rem, 'Ana');
    A.carregar({ base: { db: structuredClone(doNavegador), etag: null, aplicadas: [] } });
    const r = await A.sincronizar();
    assert.ok(r.conflito, 'pede decisão');
    assert.ok(/ARQ-1/.test(rem.texto) && !/"schema": 2/.test(rem.texto), 'arquivo intacto até decidir');
    await A.resolverVersoes(usar);
    await sync(A, rem);
    const serie = remotoDb(rem).db.itens[0].serie;
    assert.strictEqual(serie, usar === 'arquivo' ? 'ARQ-1' : 'NAV-1');
    assert.strictEqual(A.db.itens[0].serie, serie);
    assert.strictEqual(JSON.parse(rem.texto).schema, 2);
  }
});

teste('RemotoPasta: backup do arquivo antigo e backup diário em backup/; etag detecta alteração', async () => {
  const dir = pastaFalsa();
  const antigo = L.novoBanco(); L.cadastrarItem(antigo, notebook('PAS-1'));
  dir.arquivos.set('estoque.json', JSON.stringify(antigo, null, 1));
  let ultimo = null;
  const rem = R.pasta({ obterPasta: () => dir, ultimoBackup: { ler: async () => ultimo, gravar: async d => { ultimo = d; } }, planilha: db => E.planilhaBinaria(db) });
  const A = pc(rem, 'Ana');
  A.carregar({ base: { db: structuredClone(antigo), etag: null, aplicadas: [] } });
  await A.exec('entregar', [antigo.itens[0].id, { usuario: 'Fulana', data: DIA }]);
  await sync(A);
  const bk = [...dir.dirs.get('backup').arquivos.keys()];
  assert.ok(bk.some(n => /^estoque-schema1-antes-da-migracao-.*\.json$/.test(n)), bk.join());
  assert.ok(bk.some(n => /^estoque-schema1-antes-da-migracao-.*\.xlsx$/.test(n)), bk.join());
  assert.ok(bk.some(n => /^estoque-\d{4}-.*\.json$/.test(n)), 'backup diário');
  const velho = dir.dirs.get('backup').arquivos.get(bk.find(n => /schema1.*\.json$/.test(n)));
  assert.strictEqual(JSON.parse(velho).schema, 1, 'cópia fiel do arquivo antigo');
  assert.strictEqual(JSON.parse(dir.arquivos.get('estoque.json')).schema, 2);
  assert.strictEqual(ultimo, U.hojeISO());
  // Alteração por fora (outro PC via OneDrive) muda o etag: gravar com o etag velho falha por precondição.
  const { etag } = await rem.ler();
  dir.arquivos.set('estoque.json', dir.arquivos.get('estoque.json') + ' ');
  await assert.rejects(rem.gravar('{}', etag), e => Y.ehPrecondicao(e));
  // Pasta desconectada = sem conexão.
  const off = R.pasta({ obterPasta: () => null, ultimoBackup: { ler: async () => null, gravar: async () => {} } });
  assert.strictEqual(off.disponivel(), false);
});

teste('substituição total (importação/restauração) exige fila vazia e vira a nova base', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana'), B = pc(rem, 'Bruno');
  await A.exec('cadastrarItem', [notebook('SUB-1')]);
  const novo = L.novoBanco(); L.cadastrarItem(novo, notebook('IMP-1'));
  await rejeita(A.substituirBase(novo), /aguardando sincronização/);
  await sync(A, rem);
  await A.substituirBase(novo);
  assert.strictEqual(remotoDb(rem).db.itens[0].serie, 'IMP-1');
  assert.ok(remotoDb(rem).aplicadas.size >= 1, 'ids aplicados preservados');
  await sync(B, rem);
  assert.strictEqual(B.db.itens[0].serie, 'IMP-1');
});

teste('estado local persistido recarrega igual (base + fila + conflitos)', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  await A.exec('cadastrarItem', [notebook('PER-1')]);
  await sync(A, rem);
  rem.offline = true;
  await A.exec('editarItem', [A.db.itens[0].id, { posicao: 'A P1' }]);
  const B = pc(rem, 'Ana');
  B.carregar(A.salvos.at(-1));
  assert.strictEqual(JSON.stringify(B.db), JSON.stringify(A.db));
  assert.strictEqual(B.pendentes.length, 1);
  assert.strictEqual(B.base.etag, A.base.etag);
});

teste('dados só no navegador: pendentes consolidam na base local', async () => {
  const A = pc(R.memoria(), 'Ana');
  await A.exec('adicionarToner', [{ modelo: 'CF258', status: 'NOVO', quantidade: 2, data: DIA }]);
  await A.consolidarLocal();
  assert.strictEqual(A.pendentes.length, 0);
  assert.strictEqual(A.base.db.toners.length, 2);
  assert.strictEqual(A.base.etag, null);
});

teste('atualizarCoresToners: uma operação, não sobrescreve cor preenchida nem mexe na Lixeira', async () => {
  const A = pc(R.memoria(), 'Ana');
  const [t1, t2, t3] = await A.exec('adicionarToner', [{ modelo: 'W9008', status: 'NOVO', quantidade: 3, data: DIA }]);
  await A.exec('editarToner', [t2.id, { cor: 'Manual' }]);
  await A.exec('excluirToner', [t3.id]);
  const n = await A.exec('atualizarCoresToners', [{ arquivo: 'p.xlsx', cores: [t1, t2, t3].map((t, i) => ({ id: t.id, cor: 'Preto', linha: 17 + i, rgb: '000000' })) }]);
  assert.strictEqual(n, 1);
  const cor = id => A.db.toners.find(t => t.id === id).cor;
  assert.deepStrictEqual([cor(t1.id), cor(t2.id), cor(t3.id)], ['Preto', 'Manual', null]);
  assert.ok(/pela planilha "p\.xlsx" \(linha 17, preenchimento #000000\)/.test(A.db.movimentos.at(-1).obs));
  await rejeita(A.executar('atualizarCoresToners', [{ cores: [] }], A.autor), /Nenhuma cor/);
});

// Pasta falsa (File System Access API) em memória.
const E = globalThis.App.exporter;
secao('Integração com Pessoas');

const pessoa = (nome, email) => ({ tipo: 'PESSOA', nome, email: email || null, departamento: 'Financeiro', unidade: 'MATRIZ' });

teste('offline: cadastrar pessoa + entregar a ela → rebase com outro PC mexendo → mesmos ids e convergência', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana'), B = pc(rem, 'Bruno');
  const nb = await B.exec('cadastrarItem', [notebook('PX-1')]);
  await sync(B, rem); await sync(A, rem);
  rem.offline = true;
  const p = await A.exec('criarPessoa', [pessoa('Pessoa Teste Um', 'um@exemplo.test')]);
  await A.exec('entregar', [nb.id, { pessoaId: p.id, data: DIA }]);
  rem.offline = false;
  await B.exec('criarPessoa', [pessoa('Pessoa Teste Dois', 'dois@exemplo.test')]);
  await sync(B, rem);
  const r = await sync(A, rem);
  assert.strictEqual(r.conflitos, 0);
  const pA = A.db.pessoas.find(x => x.email === 'um@exemplo.test');
  assert.strictEqual(pA.id, p.id, 'id da pessoa preservado no rebase');
  const it = A.db.itens.find(i => i.id === nb.id);
  assert.strictEqual(it.responsavelId, p.id);
  assert.strictEqual(it.responsavelAtual, 'Pessoa Teste Um');
  assert.strictEqual(A.db.pessoas.length, 2, 'cadastro do outro PC preservado');
  assert.deepStrictEqual(L.itensComPessoa(A.db, p.id).map(x => x.item.id), [nb.id]);
  await sync(B, rem);
  assert.strictEqual(JSON.stringify(B.db), JSON.stringify(A.db), 'os dois PCs convergem');
});

teste('offline: dois PCs cadastram o mesmo e-mail → o segundo e a entrega que depende dele viram conflito', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana'), B = pc(rem, 'Bruno');
  const nb = await A.exec('cadastrarItem', [notebook('PX-2')]);
  await sync(A, rem); await sync(B, rem);
  rem.offline = true;
  await A.exec('criarPessoa', [pessoa('Pessoa Repetida', 'rep@exemplo.test')]);
  const pB = await B.exec('criarPessoa', [pessoa('Pessoa Repetida B', 'rep@exemplo.test')]);
  await B.exec('entregar', [nb.id, { pessoaId: pB.id, data: DIA }]);
  rem.offline = false;
  await sync(A, rem);
  const r = await sync(B, rem);
  assert.strictEqual(r.conflitos, 2);
  assert.ok(/já pertence/.test(B.conflitos[0].erro), B.conflitos[0].erro);
  assert.ok(/não encontrada/.test(B.conflitos[1].erro), B.conflitos[1].erro);
  assert.strictEqual(B.db.pessoas.length, 1);
  assert.strictEqual(B.db.itens[0].status, 'EM_ESTOQUE', 'entrega dependente não foi aplicada pela metade');
});

teste('vincular nomes antigos como operação é reaplicável e idempotente', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  const nb = await A.exec('cadastrarItem', [notebook('PX-3')]);
  await A.exec('entregar', [nb.id, { usuario: 'Nome Antigo (Setor X)', data: DIA }]);
  await sync(A, rem);
  const res = await A.exec('vincularNomesAntigos', [{ decisoes: [{ acao: 'criar', nomes: ['Nome Antigo (Setor X)'], pessoa: { nome: 'Nome Antigo', departamento: 'Setor X' } }] }]);
  assert.strictEqual(res.pessoasCriadas, 1);
  await sync(A, rem);
  const B = pc(rem, 'Bruno');
  await sync(B, rem);
  assert.strictEqual(B.db.pessoas.length, 1);
  assert.strictEqual(B.db.itens[0].responsavelId, B.db.pessoas[0].id);
  await sync(A, rem);
  assert.strictEqual(remotoDb(rem).db.pessoas.length, 1, 'não duplica ao sincronizar de novo');
});

function pastaFalsa() {
  const arquivos = new Map(), dirs = new Map();
  const naoAchou = () => { const e = new Error('não encontrado'); e.name = 'NotFoundError'; return e; };
  return {
    arquivos, dirs,
    async getFileHandle(nome, o = {}) {
      if (!arquivos.has(nome)) { if (!o.create) throw naoAchou(); arquivos.set(nome, ''); }
      return {
        async getFile() { const c = arquivos.get(nome); return { text: async () => (typeof c === 'string' ? c : '') }; },
        async createWritable() { let buf; return { async write(x) { buf = x; }, async close() { arquivos.set(nome, buf); } }; },
      };
    },
    async getDirectoryHandle(nome, o = {}) {
      if (!dirs.has(nome)) { if (!o.create) throw naoAchou(); dirs.set(nome, pastaFalsa()); }
      return dirs.get(nome);
    },
  };
}

rodar();

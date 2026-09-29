/* Testes de regressão dos achados da revisão adversarial (itens 1–13). Node, sem navegador.
   Uso: node test/testes-revisao.js */
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
const { ledger: L, sync: Y, remoto: R, store: ST } = globalThis.App;

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
const DIA_MS = 86400000;
const rejeita = async (p, re) => assert.rejects(p, e => re.test(e.message));

// Um "PC": motor com remoto compartilhado, estado local e backups guardados em memória.
function pc(remoto, nome, extra) {
  const salvos = [], backups = [];
  const m = Y.criarMotor(Object.assign({
    remoto, validar: ST.validarBanco,
    persistir: async s => { salvos.push(structuredClone(s)); },
    backup: async (prefixo, texto) => { backups.push({ prefixo, texto }); return true; },
  }, extra || {}));
  m.autor = { nome, email: null };
  m.salvos = salvos;
  m.backups = backups;
  m.exec = async (n, a) => (await m.executar(n, a, m.autor)).resultado;
  return m;
}
const remDb = rem => Y.abrirRemoto(rem.texto, ST.validarBanco);
const mouse = (q = 10) => ({ categoria: 'Mouse', descricao: 'M90', controle: 'quantidade', quantidade: q, local: 'MATRIZ', data: DIA });
const nb = serie => ({ categoria: 'Notebook', descricao: 'Lat', controle: 'unidade', serie, local: 'MATRIZ', data: DIA });
const entregas = db => db.movimentos.filter(m => m.tipo === 'ENTREGA');
const consistente = db => assert.deepStrictEqual(L.verificarConsistencia(db), []);

function pastaFalsa() {
  const arquivos = new Map(), dirs = new Map();
  const naoAchou = () => { const e = new Error('não encontrado'); e.name = 'NotFoundError'; return e; };
  const dir = {
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
    async *values() {
      for (const nome of arquivos.keys()) yield { kind: 'file', name: nome };
      for (const nome of dirs.keys()) yield { kind: 'directory', name: nome };
    },
  };
  return dir;
}

function travasFalsas() {
  const presas = new Set();
  return {
    async request(nome, opcoes, cb) {
      if (presas.has(nome)) return cb(null);
      presas.add(nome);
      try { return await cb({ name: nome }); } finally { presas.delete(nome); }
    },
  };
}

// ---------------------------------------------------------------------------------------------
secao('1. Regressão do arquivo remoto (diário local de operações confirmadas)');

teste('arquivo volta para versão antiga → operação confirmada é reaplicada, com aviso e backup do arquivo lido', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana'), B = pc(rem, 'Bruno');
  const it = await A.exec('cadastrarItem', [mouse(10)]);
  await A.sincronizar(); await B.sincronizar();
  const versaoAntiga = rem.texto;
  await A.exec('entregar', [it.id, { usuario: 'Fulana', local: 'MATRIZ', quantidade: 3, data: DIA }]);
  await A.sincronizar();
  assert.strictEqual(A.pendentes.length, 0);
  assert.strictEqual(A.diario.length, 2, 'diário guarda as confirmadas');
  rem.substituir(versaoAntiga);
  const r = await A.sincronizar();
  assert.ok(r.ok && r.regressao);
  assert.strictEqual(r.reaplicadas, 1);
  assert.strictEqual(entregas(A.db).length, 1);
  assert.strictEqual(remDb(rem).db.itens[0].saldo.MATRIZ, 7);
  assert.strictEqual(entregas(remDb(rem).db).length, 1);
  assert.strictEqual(remDb(rem).db.itens.length, 1, 'cadastro não duplicado');
  const al = A.alertas.find(a => a.id === 'regressao');
  assert.ok(al && /voltou para uma versão anterior; 1 lançamento deste computador foi reaplicado/.test(al.mensagem), al && al.mensagem);
  assert.ok(A.backups.some(b => b.prefixo === 'arquivo-regrediu' && b.texto === versaoAntiga), 'backup do arquivo lido');
  consistente(A.db);
  // Idempotente: nova sincronização não reaplica de novo.
  const r2 = await A.sincronizar();
  assert.strictEqual(r2.gravou, false);
  assert.strictEqual(entregas(remDb(rem).db).length, 1);
  // B enxerga a correção.
  await B.sincronizar();
  assert.strictEqual(B.db.itens[0].saldo.MATRIZ, 7);
  await A.dispensarAlerta('regressao');
  assert.strictEqual(A.alertas.length, 0);
});

teste('reaplicação que não cabe mais na versão do arquivo vira conflito (nunca some em silêncio)', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  const n = await A.exec('cadastrarItem', [nb('REG-1')]);
  await A.sincronizar();
  const depoisCadastro = rem.texto;
  await A.exec('entregar', [n.id, { usuario: 'Fulana', data: DIA }]);
  await A.sincronizar();
  // Outro PC, com a versão antiga, entregou o mesmo notebook a outra pessoa e o arquivo dele "ganhou".
  const outro = R.memoria(depoisCadastro);
  const C = pc(outro, 'Carla');
  await C.sincronizar();
  await C.exec('entregar', [n.id, { usuario: 'Beltrano', data: DIA }]);
  await C.sincronizar();
  rem.substituir(outro.texto);
  const r = await A.sincronizar();
  assert.ok(r.regressao);
  assert.strictEqual(A.conflitos.length, 1);
  assert.strictEqual(A.conflitos[0].op.nome, 'entregar');
  assert.strictEqual(A.db.itens[0].responsavelAtual, 'Beltrano');
  assert.ok(/não pôde ser reaplicado/.test(A.alertas.find(a => a.id === 'regressao').mensagem));
  assert.strictEqual(A.diario.some(e => e.op.id === A.conflitos[0].id), false, 'sai do diário (não vira conflito de novo a cada sincronização)');
  await A.sincronizar();
  assert.strictEqual(A.conflitos.length, 1);
});

teste('o diário sobrevive a recarregar a página (estado persistido)', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  const it = await A.exec('cadastrarItem', [mouse(10)]);
  await A.sincronizar();
  const velho = rem.texto;
  await A.exec('entrada', [it.id, { local: 'MATRIZ', quantidade: 5, data: DIA }]);
  await A.sincronizar();
  const A2 = pc(rem, 'Ana');
  A2.carregar(A.salvos.at(-1));
  assert.strictEqual(A2.diario.length, 2);
  rem.substituir(velho);
  await A2.sincronizar();
  assert.strictEqual(remDb(rem).db.itens[0].saldo.MATRIZ, 15);
});

teste('arquivo apagado da pasta → recriado com a versão deste computador e aviso', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  await A.exec('cadastrarItem', [mouse(4)]);
  await A.sincronizar();
  rem.texto = null; rem.versao++;
  const r = await A.sincronizar();
  assert.ok(r.gravou);
  assert.strictEqual(remDb(rem).db.itens.length, 1);
  assert.ok(A.alertas.some(a => a.id === 'recriado'));
});

teste('trocar de pasta esquece o diário (não reaplica lançamentos de uma pasta em outra)', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  await A.exec('cadastrarItem', [mouse(4)]);
  await A.sincronizar();
  await A.desvincular();
  assert.strictEqual(A.diario.length, 0);
});

teste('cópias de conflito do OneDrive (estoque-NOMEPC.json) são listadas, não mescladas', async () => {
  const dir = pastaFalsa();
  dir.arquivos.set('estoque.json', Y.serializarRemoto(L.novoBanco(), new Map()));
  dir.arquivos.set('estoque-NOTE-ANA.json', '{}');
  dir.arquivos.set('Estoque (1).json', '{}');
  dir.arquivos.set('outro.json', '{}');
  await dir.getDirectoryHandle('backup', { create: true });
  const rem = R.pasta({ obterPasta: () => dir, ultimoBackup: { ler: async () => null, gravar: async () => {} } });
  assert.deepStrictEqual(await rem.copiasExtras(), ['Estoque (1).json', 'estoque-NOTE-ANA.json']);
  assert.deepStrictEqual(await R.pasta({ obterPasta: () => null, ultimoBackup: {} }).copiasExtras(), []);
});

// ---------------------------------------------------------------------------------------------
secao('2. Arquivo no formato antigo gravado depois da migração');

teste('schema 1 por cima de arquivo já migrado: não migra em silêncio; avisa, guarda backup e reaplica o diário', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  const it = await A.exec('cadastrarItem', [mouse(10)]);
  await A.sincronizar();
  const velho = structuredClone(A.db);
  await A.exec('entregar', [it.id, { usuario: 'Fulana', local: 'MATRIZ', quantidade: 3, data: DIA }]);
  await A.sincronizar();
  velho.atualizadoEm = new Date().toISOString();
  const textoVelho = JSON.stringify(velho, null, 1);
  rem.substituir(textoVelho);
  const r = await A.sincronizar();
  assert.ok(r.regressao);
  const obj = JSON.parse(rem.texto);
  assert.strictEqual(obj.schema, 2);
  assert.strictEqual(Object.keys(obj.operacoesAplicadas).length, 2, 'ids preservados (cadastro já presente + entrega reaplicada)');
  assert.strictEqual(entregas(obj.db).length, 1);
  assert.strictEqual(obj.db.itens.length, 1, 'cadastro presente não é reaplicado');
  assert.strictEqual(obj.db.itens[0].saldo.MATRIZ, 7);
  const al = A.alertas.find(a => a.id === 'versao-antiga');
  assert.ok(al && /versão antiga da aplicação gravando nesta pasta/.test(al.mensagem));
  assert.ok(A.backups.some(b => b.prefixo === 'arquivo-versao-antiga' && b.texto === textoVelho));
});

teste('primeira migração legítima (sem etag e sem aplicadas) continua automática e sem aviso', async () => {
  const antigo = L.novoBanco(); L.cadastrarItem(antigo, nb('LEG-9'));
  const rem = R.memoria(JSON.stringify(antigo));
  const A = pc(rem, 'Ana');
  A.carregar({ base: { db: structuredClone(antigo), etag: null, aplicadas: [] } });
  const r = await A.sincronizar();
  assert.ok(r.gravou && !r.regressao);
  assert.strictEqual(A.alertas.length, 0);
  assert.strictEqual(JSON.parse(rem.texto).schema, 2);
});

// ---------------------------------------------------------------------------------------------
secao('3. Uma aba por vez');

teste('segunda aba fica bloqueada: não executa, não grava o estado local', async () => {
  const rem = R.memoria();
  let gravacoes = 0;
  const travas = travasFalsas();
  const aba1 = pc(rem, 'Ana'), aba2 = pc(rem, 'Ana', { persistir: async () => { gravacoes++; } });
  assert.strictEqual(await ST.garantirAbaUnica(aba1, travas), true);
  assert.strictEqual(await ST.garantirAbaUnica(aba2, travas), false);
  assert.strictEqual(aba2.estado.bloqueio.codigo, 'outra-aba');
  assert.ok(/outra aba/.test(aba2.estado.bloqueio.mensagem));
  await rejeita(aba2.exec('cadastrarItem', [mouse(1)]), /outra aba/);
  await rejeita(aba2.sincronizar(), /outra aba/);
  await rejeita(aba2.substituirBase(L.novoBanco()), /outra aba/);
  assert.strictEqual(gravacoes, 0);
  assert.strictEqual(aba2.pendentes.length, 0);
  await aba1.exec('cadastrarItem', [mouse(1)]);
  assert.strictEqual(aba1.pendentes.length, 1);
});

teste('sem Web Locks: BroadcastChannel; sem nenhum dos dois (Node): segue funcionando', async () => {
  assert.strictEqual(await ST.travarAba(null, null), true);
  if (typeof BroadcastChannel === 'function') {
    assert.strictEqual(await ST.travarAba(null, BroadcastChannel), true);
    assert.strictEqual(await ST.travarAba(null, BroadcastChannel), false);
  }
});

// ---------------------------------------------------------------------------------------------
secao('4. RemotoPasta: confere o etag logo antes de escrever');

teste('duas gravações com o mesmo etag: a que ficou presa no backup falha por precondição (sem lost update)', async () => {
  const dir = pastaFalsa();
  dir.arquivos.set('estoque.json', Y.serializarRemoto(L.novoBanco(), new Map()));
  let liberar;
  const trava = new Promise(r => { liberar = r; });
  let chamadas = 0;
  const rem = R.pasta({ obterPasta: () => dir, ultimoBackup: { ler: async () => { if (chamadas++ === 0) await trava; return null; }, gravar: async () => {} } });
  const { etag } = await rem.ler();
  const p1 = rem.gravar('{"escritor":1}', etag);
  await new Promise(r => setImmediate(r));
  await rem.gravar('{"escritor":2}', etag);
  liberar();
  await assert.rejects(p1, e => Y.ehPrecondicao(e));
  assert.strictEqual(dir.arquivos.get('estoque.json'), '{"escritor":2}');
});

teste('arquivo alterado por fora durante o backup diário → precondição, nada sobrescrito', async () => {
  const dir = pastaFalsa();
  dir.arquivos.set('estoque.json', Y.serializarRemoto(L.novoBanco(), new Map()));
  const rem = R.pasta({ obterPasta: () => dir, ultimoBackup: { ler: async () => null, gravar: async () => { dir.arquivos.set('estoque.json', 'OUTRO PC'); } } });
  const { etag } = await rem.ler();
  await assert.rejects(rem.gravar('{"meu":1}', etag), e => Y.ehPrecondicao(e));
  assert.strictEqual(dir.arquivos.get('estoque.json'), 'OUTRO PC');
  assert.ok([...dir.dirs.get('backup').arquivos.keys()].some(n => /^estoque-.*\.json$/.test(n)), 'backup feito antes');
});

// ---------------------------------------------------------------------------------------------
secao('5. Idempotência: poda pela data de aplicação e datas absurdas');

teste('operacoesAplicadas guarda a data da APLICAÇÃO; a poda (365 dias) usa essa data', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  const it = await A.exec('cadastrarItem', [mouse(10)]);
  await A.sincronizar();
  const antiga = new Date(Date.now() - 300 * DIA_MS).toISOString(); // PC ficou 300 dias offline
  const op = { id: 'cccccccc-0000-4000-8000-000000000002', nome: 'entregar', args: [it.id, { usuario: 'Fulana', local: 'MATRIZ', quantidade: 3, data: DIA }], autor: null, criadoEm: antiga };
  A.carregar(Object.assign(structuredClone(A.salvos.at(-1)), { pendentes: [op] }));
  rem.perderResposta = 1;
  await assert.rejects(A.sincronizar());
  const em = JSON.parse(rem.texto).operacoesAplicadas[op.id];
  assert.ok(em && Math.abs(Date.parse(em) - Date.now()) < 60000, 'data da aplicação: ' + em);
  await A.sincronizar();
  assert.strictEqual(entregas(remDb(rem).db).length, 1);
  assert.strictEqual(remDb(rem).db.itens[0].saldo.MATRIZ, 7);
  // Entrada aplicada há mais de 365 dias sai do arquivo; a recente fica.
  const aplicadas = new Map([['dddddddd-0000-4000-8000-000000000001', new Date(Date.now() - 366 * DIA_MS).toISOString()], [op.id, new Date().toISOString()]]);
  const podado = JSON.parse(Y.serializarRemoto(L.novoBanco(), aplicadas)).operacoesAplicadas;
  assert.deepStrictEqual(Object.keys(podado), [op.id]);
});

teste('operação cujos registros já estão no banco não é aplicada de novo, mesmo sem o id em operacoesAplicadas', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  const it = await A.exec('cadastrarItem', [mouse(10)]);
  await A.sincronizar();
  const op = Y.novaOperacao('entregar', [it.id, { usuario: 'Fulana', local: 'MATRIZ', quantidade: 3, data: DIA }], null);
  A.carregar(Object.assign(structuredClone(A.salvos.at(-1)), { pendentes: [op] }));
  rem.perderResposta = 1;
  await assert.rejects(A.sincronizar());
  const obj = JSON.parse(rem.texto); obj.operacoesAplicadas = {}; rem.substituir(JSON.stringify(obj)); // ids perdidos
  await A.sincronizar();
  assert.strictEqual(entregas(remDb(rem).db).length, 1);
  assert.ok(op.id in JSON.parse(rem.texto).operacoesAplicadas, 'id volta a constar do arquivo');
});

teste('criadoEm absurdo (> 1 dia no futuro ou > 400 dias no passado) vira conflito "data inválida"', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  const it = await A.exec('cadastrarItem', [mouse(10)]);
  await A.sincronizar();
  const mk = (id, dt) => ({ id, nome: 'entrada', args: [it.id, { local: 'MATRIZ', quantidade: 1, data: DIA }], autor: null, criadoEm: new Date(dt).toISOString() });
  const futuro = mk('eeeeeeee-0000-4000-8000-000000000001', Date.now() + 2 * DIA_MS);
  const passado = mk('eeeeeeee-0000-4000-8000-000000000002', Date.now() - 401 * DIA_MS);
  assert.throws(() => Y.validarOperacao(futuro), /Data inválida/);
  assert.throws(() => Y.validarOperacao(passado), /Data inválida/);
  A.carregar(Object.assign(structuredClone(A.salvos.at(-1)), { pendentes: [futuro, passado] }));
  assert.strictEqual(A.pendentes.length, 0);
  assert.strictEqual(A.conflitos.length, 2);
  assert.ok(A.conflitos.every(c => /Data inválida/.test(c.erro)));
  await A.sincronizar();
  assert.strictEqual(remDb(rem).db.itens[0].saldo.MATRIZ, 10);
});

// ---------------------------------------------------------------------------------------------
secao('6 e 13. Conflito de versões');

function comConflitoDeVersoes() {
  const doArquivo = L.novoBanco(); L.cadastrarItem(doArquivo, nb('ARQ-1'));
  const doNav = L.novoBanco(); const item = L.cadastrarItem(doNav, mouse(10)); doNav.atualizadoEm = '2000-01-01T00:00:00.000Z';
  const rem = R.memoria(Y.serializarRemoto(doArquivo, new Map()));
  const A = pc(rem, 'Ana');
  A.carregar({ base: { db: structuredClone(doNav), etag: null, aplicadas: [] } });
  return { rem, A, item };
}

teste('resolverVersoes("navegador"): operação feita durante a gravação continua na fila e é enviada', async () => {
  const { rem, A, item } = comConflitoDeVersoes();
  assert.ok((await A.sincronizar()).conflito);
  rem.antesDeGravar = async () => { await A.exec('entregar', [item.id, { usuario: 'Fulana', local: 'MATRIZ', quantidade: 1, data: DIA }]); };
  await A.resolverVersoes('navegador');
  assert.strictEqual(A.pendentes.length, 1, 'continua na fila');
  assert.strictEqual(entregas(A.db).length, 1);
  await A.sincronizar();
  assert.strictEqual(A.pendentes.length, 0);
  assert.strictEqual(entregas(remDb(rem).db).length, 1);
  assert.strictEqual(remDb(rem).db.itens[0].saldo.MATRIZ, 9);
});

teste('resolverVersoes sem escolha válida (diálogo fechado) não decide nada', async () => {
  const { rem, A } = comConflitoDeVersoes();
  await A.sincronizar();
  const antes = rem.texto;
  await rejeita(A.resolverVersoes(null), /Escolha/);
  assert.ok(A.estado.conflitoVersoes, 'a pergunta continua pendente');
  assert.strictEqual(rem.texto, antes);
});

// ---------------------------------------------------------------------------------------------
secao('7. Substituição total guarda o arquivo remoto antes');

teste('importação/restauração num PC desatualizado: cópia do arquivo remoto (com as alterações do outro PC) em backup/', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana'), B = pc(rem, 'Bruno');
  await A.exec('cadastrarItem', [mouse(10)]); await A.sincronizar(); await B.sincronizar();
  await B.exec('cadastrarItem', [nb('SO-NO-REMOTO')]); await B.sincronizar();
  const novo = L.novoBanco(); L.cadastrarItem(novo, nb('IMP-1'));
  await A.substituirBase(novo);
  const bk = A.backups.find(b => b.prefixo === 'arquivo-antes-de-substituir');
  assert.ok(bk && /SO-NO-REMOTO/.test(bk.texto), 'o que B cadastrou fica recuperável');
  assert.strictEqual(remDb(rem).db.itens[0].serie, 'IMP-1');
});

teste('sem conseguir guardar a cópia do arquivo remoto, a substituição não acontece', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana', { backup: async () => false });
  await A.exec('cadastrarItem', [mouse(10)]); await A.sincronizar();
  const antes = rem.texto;
  const novo = L.novoBanco(); L.cadastrarItem(novo, nb('IMP-2'));
  await rejeita(A.substituirBase(novo), /cópia do arquivo/);
  assert.strictEqual(rem.texto, antes);
});

// ---------------------------------------------------------------------------------------------
secao('8. Validação profunda do banco');

teste('bancos malformados são recusados com mensagem clara', () => {
  const bom = () => {
    const db = L.novoBanco();
    const it = L.cadastrarItem(db, mouse(5));
    L.adicionarToner(db, { modelo: 'X', quantidade: 1, data: DIA });
    L.criarPessoa(db, { nome: 'Ana Teste' });
    L.entregar(db, it.id, { usuario: 'Fulana', local: 'MATRIZ', quantidade: 1, data: DIA });
    return JSON.parse(JSON.stringify(db));
  };
  ST.validarBanco(bom());
  const casos = [
    ['item nulo', d => { d.itens.push(null); }, /item nº 2 malformado/],
    ['movimento nulo', d => { d.movimentos.push(null); }, /movimentação nº \d+ malformada/],
    ['toner nulo', d => { d.toners.unshift(null); }, /toner nº 1 malformado/],
    ['sem saldo SAO_CRISTOVAO', d => { delete d.itens[0].saldo.SAO_CRISTOVAO; }, /saldo em São Cristóvão/],
    ['saldo negativo', d => { d.itens[0].saldo.MATRIZ = -1; }, /saldo em Matriz/],
    ['saldo fracionário', d => { d.itens[0].saldo.MATRIZ = 1.5; }, /saldo em Matriz/],
    ['saldo texto', d => { d.itens[0].saldo.MATRIZ = '4'; }, /saldo em Matriz/],
    ['controle inválido', d => { d.itens[0].controle = 'x'; }, /controle/],
    ['status herdado', d => { d.itens[0].status = 'constructor'; }, /situação/],
    ['local herdado', d => { d.itens[0].local = '__proto__'; }, /local/],
    ['id repetido', d => { d.itens.push(structuredClone(d.itens[0])); }, /repetido/],
    ['tipo de movimento desconhecido', d => { d.movimentos[0].tipo = 'toString'; }, /tipo desconhecido/],
    ['delta não numérico', d => { d.movimentos[0].delta = '3'; }, /delta/],
    ['delta infinito', d => { d.movimentos[0].delta = Infinity; }, /delta/],
    ['movimento sem id', d => { delete d.movimentos[0].id; }, /sem identificador/],
    ['local do movimento herdado', d => { d.movimentos[0].local = 'toString'; }, /local/],
    ['toner com status inválido', d => { d.toners[0].status = 'constructor'; }, /toner nº 1: situação/],
    ['pessoa sem "ativo"', d => { delete d.pessoas[0].ativo; }, /pessoas.*ativo/],
    ['pessoa sem id', d => { delete d.pessoas[0].id; }, /pessoas/],
    ['itens não é lista', d => { d.itens = {}; }, /"itens" ausente/],
  ];
  for (const [nome, estraga, re] of casos) {
    const d = bom(); estraga(d);
    assert.throws(() => ST.validarBanco(d), e => re.test(e.message), nome);
  }
});

teste('remoto inválido é recusado ANTES de ser usado: base e fila mantidas, cópia em backup/ uma vez', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  const [t] = await A.exec('adicionarToner', [{ modelo: 'X', quantidade: 1, data: DIA }]);
  await A.sincronizar();
  const baseAntes = JSON.stringify(A.base.db);
  const obj = JSON.parse(rem.texto); obj.db.movimentos.push(null); rem.substituir(JSON.stringify(obj));
  await A.exec('mudarStatusToner', [t.id, 'EM_USO']);
  await rejeita(A.sincronizar(), /recusado e não foi usado.*movimentação/);
  await rejeita(A.sincronizar(), /recusado/);
  assert.strictEqual(JSON.stringify(A.base.db), baseAntes);
  assert.strictEqual(A.pendentes.length, 1);
  assert.strictEqual(A.conflitos.length, 0);
  assert.strictEqual(A.backups.filter(b => b.prefixo === 'arquivo-invalido').length, 1);
});

teste('arquivo grande demais é recusado sem ser interpretado', () => {
  assert.throws(() => Y.abrirRemoto('x'.repeat(Y.LIMITE_TEXTO + 1), ST.validarBanco), /grande demais/);
});

// ---------------------------------------------------------------------------------------------
secao('9. Vincular nomes antigos em dois PCs');

teste('o segundo PC não cria cadastro duplicado: a operação vira conflito visível', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana'), B = pc(rem, 'Bruno');
  const n = await A.exec('cadastrarItem', [nb('V-1')]);
  await A.exec('entregar', [n.id, { usuario: 'Joao Silva', data: DIA }]);
  await A.sincronizar(); await B.sincronizar();
  const dec = { decisoes: [{ acao: 'criar', nomes: ['Joao Silva'], pessoa: { nome: 'João Silva' } }] };
  rem.offline = true;
  await A.exec('vincularNomesAntigos', [dec]); await B.exec('vincularNomesAntigos', [dec]);
  rem.offline = false;
  await A.sincronizar(); await B.sincronizar();
  assert.strictEqual(remDb(rem).db.pessoas.length, 1);
  assert.strictEqual(B.conflitos.length, 1);
  assert.ok(/já foram vinculados/.test(B.conflitos[0].erro));
  consistente(B.db);
});

teste('grupo já vinculado é pulado; os demais grupos da mesma decisão são aplicados', () => {
  const db = L.novoBanco();
  const a = L.cadastrarItem(db, nb('G-1')), b = L.cadastrarItem(db, nb('G-2'));
  L.entregar(db, a.id, { usuario: 'Maria Souza', data: DIA });
  L.entregar(db, b.id, { usuario: 'Pedro Lima', data: DIA });
  L.vincularNomesAntigos(db, { decisoes: [{ acao: 'criar', nomes: ['Maria Souza'], pessoa: { nome: 'Maria Souza' } }] });
  const r = L.vincularNomesAntigos(db, { decisoes: [
    { acao: 'criar', nomes: ['Maria Souza'], pessoa: { nome: 'Maria Souza' } },
    { acao: 'criar', nomes: ['Pedro Lima'], pessoa: { nome: 'Pedro Lima' } },
  ] });
  assert.strictEqual(r.pessoasCriadas, 1);
  assert.deepStrictEqual(r.gruposJaVinculados, [['Maria Souza']]);
  assert.deepStrictEqual(db.pessoas.map(p => p.nome).sort(), ['Maria Souza', 'Pedro Lima']);
  consistente(db);
});

// ---------------------------------------------------------------------------------------------
secao('10. Estado local inválido');

teste('carregar falha → motor bloqueado: nada é executado nem gravado por cima do estado salvo', async () => {
  let gravacoes = 0;
  const A = pc(R.memoria(), 'Ana', { persistir: async () => { gravacoes++; } });
  const salvo = { base: { db: Object.assign(L.novoBanco(), { pessoas: [{ nome: 'sem id' }] }), etag: null, aplicadas: [] }, pendentes: [] };
  assert.throws(() => A.carregar(salvo), /pessoas/);
  assert.strictEqual(A.estado.bloqueio.codigo, 'estado-invalido');
  assert.ok(/Restaurar backup/.test(A.estado.bloqueio.mensagem));
  await rejeita(A.exec('adicionarToner', [{ modelo: 'Y', quantidade: 1, data: DIA }]), /inválidos/);
  await rejeita(A.sincronizar(), /inválidos/);
  await rejeita(A.consolidarLocal(), /inválidos/);
  assert.strictEqual(gravacoes, 0);
  // Restaurar um backup (substituição total) é permitido e desbloqueia.
  const novo = L.novoBanco(); L.cadastrarItem(novo, mouse(2));
  await A.substituirBase(novo);
  assert.strictEqual(A.estado.bloqueio, null);
  assert.strictEqual(A.db.itens.length, 1);
  await A.exec('adicionarToner', [{ modelo: 'Y', quantidade: 1, data: DIA }]);
});

teste('estado inválido: "carregar do arquivo da pasta" recomeça e adota o arquivo', async () => {
  const rem = R.memoria();
  const B = pc(rem, 'Bruno');
  await B.exec('cadastrarItem', [mouse(3)]); await B.sincronizar();
  const A = pc(rem, 'Ana');
  assert.throws(() => A.carregar({ base: { db: { schema: 1, itens: 'x' } } }));
  await A.recomecarDoArquivo();
  await A.sincronizar();
  assert.strictEqual(A.db.itens.length, 1);
  assert.strictEqual(A.estado.bloqueio, null);
});

// ---------------------------------------------------------------------------------------------
secao('11. Listas fixas só por chaves próprias');

teste('"toString", "constructor", "__proto__" não passam como local/status/campo', () => {
  const db = L.novoBanco();
  const it = L.cadastrarItem(db, mouse(5));
  assert.throws(() => L.entrada(db, it.id, { local: 'toString', quantidade: 1, data: DIA }), /local/);
  assert.throws(() => L.cadastrarItem(db, Object.assign(mouse(1), { local: 'constructor' })), /local/);
  const [t] = L.adicionarToner(db, { modelo: 'X', status: 'constructor', quantidade: 1, data: DIA });
  assert.strictEqual(t.status, 'NOVO');
  assert.throws(() => L.mudarStatusToner(db, t.id, 'constructor'), /Status inválido/);
  const u = L.cadastrarItem(db, nb('P-1'));
  L.entregar(db, u.id, { usuario: 'X', data: DIA });
  assert.throws(() => L.devolver(db, u.id, { local: '__proto__', data: DIA }), /local/);
  assert.strictEqual(L.editarItem(db, it.id, JSON.parse('{"__proto__": "x", "constructor": "y", "toString": "z"}')), null);
  assert.strictEqual(L.editarToner(db, t.id, Object.create({ modelo: 'herdado' })), null);
  consistente(db);
});

// ---------------------------------------------------------------------------------------------
secao('12. Sincronização periódica');

teste('a cada 5 min com a aba visível, ao voltar para a aba e ao focar a janela', () => {
  const ouvintes = {};
  const alvo = () => ({ addEventListener: (ev, f) => { (ouvintes[ev] = ouvintes[ev] || []).push(f); } });
  const documento = Object.assign(alvo(), { visibilityState: 'visible' });
  const janela = alvo();
  let tick = null, intervalo = null, chamadas = 0;
  ST.ligarSincronizacaoPeriodica({ documento, janela, sincronizar: () => { chamadas++; }, definirIntervalo: (f, ms) => { tick = f; intervalo = ms; return 1; } });
  assert.strictEqual(intervalo, 5 * 60000);
  tick(); assert.strictEqual(chamadas, 1);
  documento.visibilityState = 'hidden';
  tick(); ouvintes.visibilitychange[0](); assert.strictEqual(chamadas, 1, 'aba escondida: não sincroniza');
  documento.visibilityState = 'visible';
  ouvintes.visibilitychange[0](); assert.strictEqual(chamadas, 2);
  ouvintes.focus[0](); assert.strictEqual(chamadas, 3);
});

// ---------------------------------------------------------------------------------------------
secao('13. Limites');

teste('quantidade por lançamento limitada a 100.000', () => {
  const db = L.novoBanco();
  const it = L.cadastrarItem(db, mouse(1));
  assert.throws(() => L.entrada(db, it.id, { local: 'MATRIZ', quantidade: 100001, data: DIA }), /grande demais/);
  assert.throws(() => L.cadastrarItem(db, mouse(1e9)), /grande demais/);
  assert.throws(() => L.ajustar(db, it.id, { local: 'MATRIZ', novaQuantidade: 100001, motivo: 'x', data: DIA }), /grande demais/);
  L.entrada(db, it.id, { local: 'MATRIZ', quantidade: 100000, data: DIA });
  assert.strictEqual(it.saldo.MATRIZ, 100001);
});

setImmediate(rodar);

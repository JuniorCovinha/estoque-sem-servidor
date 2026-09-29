/* PoCs da revisão adversarial (não faz parte da suíte). Cada teste PASSA quando o defeito é reproduzido.
   Uso: node test/poc-revisao.js */
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

const fila = [];
const teste = (n, fn) => fila.push([n, fn]);
setImmediate(async () => {
  let ok = 0, nao = 0;
  for (const [n, fn] of fila) {
    try { const info = await fn(); ok++; console.log('  REPRODUZIDO  ' + n + (info ? '\n      ' + info : '')); }
    catch (e) { nao++; console.log('  NÃO reproduz ' + n + '\n      ' + String(e.stack || e).split('\n').slice(0, 3).join('\n      ')); }
  }
  console.log(`\n${ok} reproduzido(s), ${nao} não`);
});

const DIA = '2026-09-01';
function pc(remoto, nome, persistir) {
  const salvos = [];
  const m = Y.criarMotor({ remoto, validar: ST.validarBanco, persistir: persistir || (async s => { salvos.push(structuredClone(s)); }) });
  m.autor = { nome, email: null };
  m.salvos = salvos;
  m.exec = async (n, a) => (await m.executar(n, a, m.autor)).resultado;
  return m;
}
const mouse = (q = 10) => ({ categoria: 'Mouse', descricao: 'M90', controle: 'quantidade', quantidade: q, local: 'MATRIZ', data: DIA });
const nb = serie => ({ categoria: 'Notebook', descricao: 'Lat', controle: 'unidade', serie, local: 'MATRIZ', data: DIA });
const remDb = rem => Y.abrirRemoto(rem.texto, ST.validarBanco);

// 1. Arquivo remoto "volta no tempo" (OneDrive last-writer-wins, cópia restaurada, PC com versão antiga):
//    operação já confirmada some sem conflito nem aviso.
teste('regressão do remoto apaga operação confirmada (sem conflito/aviso)', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana'), B = pc(rem, 'Bruno');
  const it = await A.exec('cadastrarItem', [mouse(10)]);
  await A.sincronizar(); await B.sincronizar();
  const versaoAntiga = rem.texto;                 // o que B tem no disco dele
  await A.exec('entregar', [it.id, { usuario: 'Fulana', local: 'MATRIZ', quantidade: 3, data: DIA }]);
  await A.sincronizar();                          // confirmada: sai da fila
  assert.strictEqual(A.pendentes.length, 0);
  rem.substituir(versaoAntiga);                   // OneDrive fica com a versão do outro PC
  const r = await A.sincronizar();
  assert.ok(r.ok);
  assert.strictEqual(A.conflitos.length, 0);
  assert.strictEqual(A.db.movimentos.filter(m => m.tipo === 'ENTREGA').length, 0, 'entrega sumiu');
  assert.strictEqual(A.db.itens[0].saldo.MATRIZ, 10);
  return `A.sincronizar() => ${JSON.stringify(r)}; entrega perdida, 0 conflitos, 0 pendentes`;
});

// 2. Aba antiga (versão schema 1 ainda aberta) grava o formato antigo por cima: migra de novo e zera operacoesAplicadas.
teste('arquivo schema 1 gravado por versão antiga depois da migração: re-migra, perde ops e zera operacoesAplicadas', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  const it = await A.exec('cadastrarItem', [mouse(10)]);
  await A.sincronizar();
  const velho = structuredClone(A.db);            // o que a aba antiga tem em memória
  await A.exec('entregar', [it.id, { usuario: 'Fulana', local: 'MATRIZ', quantidade: 3, data: DIA }]);
  await A.sincronizar();
  const idsAntes = Object.keys(JSON.parse(rem.texto).operacoesAplicadas).length;
  velho.atualizadoEm = new Date().toISOString();
  rem.substituir(JSON.stringify(velho, null, 1)); // gravarArquivoAgora() da versão antiga
  const r = await A.sincronizar();
  const obj = JSON.parse(rem.texto);
  assert.ok(r.gravou, 'migrou de novo sem perguntar');
  assert.strictEqual(Object.keys(obj.operacoesAplicadas).length, 0);
  assert.strictEqual(obj.db.movimentos.filter(m => m.tipo === 'ENTREGA').length, 0);
  return `operacoesAplicadas ${idsAntes} -> 0; entrega confirmada perdida; nenhum conflito (${A.conflitos.length})`;
});

// 3. Duas abas do mesmo navegador: mesmo IndexedDB('sync'), motores independentes → a fila de uma apaga a da outra.
//    (Ajuste pós-correção: cada "aba" passa pela mesma checagem de exclusividade que store.iniciar() faz ao abrir,
//    com uma trava que imita navigator.locks. Se a checagem não existir, o PoC se comporta como antes.)
teste('duas abas: a fila persistida de uma sobrescreve a da outra (operação offline perdida ao recarregar)', async () => {
  const rem = R.memoria();
  let idb = null;
  const persist = async s => { idb = structuredClone(s); };
  const travas = travasFalsas();
  const abrirAba = async () => { const m = pc(rem, 'Ana', persist); if (ST.garantirAbaUnica) await ST.garantirAbaUnica(m, travas); return m; };
  const aba1 = await abrirAba(), aba2 = await abrirAba();
  const it = await aba1.exec('cadastrarItem', [mouse(10)]);
  await aba1.sincronizar(); await aba2.sincronizar();
  rem.offline = true;                              // pasta desconectada / sem permissão
  await aba1.exec('entregar', [it.id, { usuario: 'Fulana', local: 'MATRIZ', quantidade: 1, data: DIA }]);
  await aba2.exec('entregar', [it.id, { usuario: 'Beltrano', local: 'MATRIZ', quantidade: 2, data: DIA }]);
  const reaberta = pc(rem, 'Ana', persist);
  reaberta.carregar(idb);                         // fecha tudo e reabre
  rem.offline = false;
  await reaberta.sincronizar();
  const usuarios = remDb(rem).db.movimentos.filter(m => m.tipo === 'ENTREGA').map(m => m.usuario);
  assert.deepStrictEqual(usuarios, ['Beltrano']);
  return `entregas no remoto: ${JSON.stringify(usuarios)} (a de "Fulana" sumiu)`;
});

// 4. TOCTOU em RemotoPasta.gravar: etag conferido ANTES dos backups (await longo); dois escritores passam na checagem.
teste('RemotoPasta.gravar: checagem de etag e escrita não são atômicas (backup no meio) → lost update', async () => {
  const dir = pastaFalsa();
  const base = L.novoBanco();
  dir.arquivos.set('estoque.json', Y.serializarRemoto(base, new Map()));
  let liberar;
  const trava = new Promise(r => { liberar = r; });
  let chamadas = 0;
  const ultimo = { ler: async () => { if (chamadas++ === 0) await trava; return null; }, gravar: async () => {} };
  const rem = R.pasta({ obterPasta: () => dir, ultimoBackup: ultimo });
  const { etag } = await rem.ler();
  const p1 = rem.gravar('{"escritor":1}', etag);  // fica preso no backup diário
  await new Promise(r => setImmediate(r));
  const r2 = await rem.gravar('{"escritor":2}', etag); // passa na checagem e grava
  liberar();
  const r1 = await p1;                            // também "sucesso", sobrescreve o 2
  assert.ok(r1.etag && r2.etag);
  assert.strictEqual(dir.arquivos.get('estoque.json'), '{"escritor":1}');
  return 'os dois gravar() retornaram sucesso com o mesmo etagEsperado; o escritor 2 foi sobrescrito';
});

// 5. Poda por criadoEm (relógio do PC que criou): id sai do arquivo na mesma gravação → reenvio aplica duas vezes.
teste('poda de operacoesAplicadas por criadoEm antigo (relógio atrasado) + resposta perdida → aplicação dupla', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  const it = await A.exec('cadastrarItem', [mouse(10)]);
  await A.sincronizar();
  const velha = new Date(Date.now() - 400 * 86400000).toISOString(); // BIOS/relógio atrasado ou PC >1 ano offline
  const op = { id: 'cccccccc-0000-4000-8000-00000000000' + '1', nome: 'entregar', args: [it.id, { usuario: 'Fulana', local: 'MATRIZ', quantidade: 3, data: DIA }], autor: null, criadoEm: velha };
  A.carregar(Object.assign(structuredClone(A.salvos.at(-1)), { pendentes: [op] }));
  rem.perderResposta = 1;
  await assert.rejects(A.sincronizar());
  assert.ok(!(op.id in JSON.parse(rem.texto).operacoesAplicadas), 'id já podado na gravação');
  await A.sincronizar();
  const entregas = remDb(rem).db.movimentos.filter(m => m.tipo === 'ENTREGA');
  assert.strictEqual(entregas.length, 2);
  return `ENTREGA aplicada ${entregas.length}x; saldo MATRIZ = ${remDb(rem).db.itens[0].saldo.MATRIZ} (esperado 7); ids duplicados: ${entregas.map(m => m.id).join(', ')}`;
});

// 6. resolverVersoes('navegador'): pendentes.slice() lido DEPOIS dos awaits → operação feita no meio sai da fila sem ser aplicada.
teste('resolverVersoes("navegador"): operação feita durante o backup/gravação é descartada em silêncio', async () => {
  const doArquivo = L.novoBanco(); L.cadastrarItem(doArquivo, nb('ARQ-1'));
  const doNav = L.novoBanco(); const item = L.cadastrarItem(doNav, mouse(10)); doNav.atualizadoEm = '2000-01-01T00:00:00.000Z';
  const rem = R.memoria(Y.serializarRemoto(doArquivo, new Map()));
  const A = pc(rem, 'Ana');
  A.carregar({ base: { db: structuredClone(doNav), etag: null, aplicadas: [] } });
  const r = await A.sincronizar();
  assert.ok(r.conflito);
  rem.antesDeGravar = async () => { await A.exec('entregar', [item.id, { usuario: 'Fulana', local: 'MATRIZ', quantidade: 1, data: DIA }]); };
  await A.resolverVersoes('navegador');
  await A.sincronizar();
  const ent = n => n.movimentos.filter(m => m.tipo === 'ENTREGA').length;
  assert.strictEqual(A.pendentes.length, 0);
  assert.strictEqual(A.conflitos.length, 0);
  assert.strictEqual(ent(A.db) + ent(remDb(rem).db), 0);
  return 'entrega executada durante a resolução: 0 no banco local, 0 no remoto, 0 na fila, 0 conflitos';
});

// 7. substituirBase (importação/restauração) sobrescreve alterações de outro PC que este PC ainda não viu, sem backup do arquivo.
teste('importação/restauração num PC desatualizado apaga alterações recentes de outro PC sem backup do arquivo remoto', async () => {
  const rem = R.memoria();
  const backups = [];
  const A = Y.criarMotor({ remoto: rem, validar: ST.validarBanco, backup: async (p) => { backups.push(p); } });
  const B = pc(rem, 'Bruno');
  await A.executar('cadastrarItem', [mouse(10)], null); await A.sincronizar(); await B.sincronizar();
  await B.exec('cadastrarItem', [nb('SO-NO-REMOTO')]); await B.sincronizar();
  const novo = L.novoBanco(); L.cadastrarItem(novo, nb('IMP-1'));
  await A.substituirBase(novo);                   // A tem fila vazia: prepararSubstituicao nem sincroniza
  assert.ok(!/SO-NO-REMOTO/.test(rem.texto));
  assert.deepStrictEqual(backups, []);
  return 'item cadastrado por B sumiu; motor não chamou backup do texto remoto (store só copia o banco LOCAL desatualizado)';
});

// 8. Remoto malformado aceito por validarBanco: toda operação pendente vira conflito (TypeError) e o banco quebrado vira base.
teste('remoto malformado (movimentos:[null]) passa na validação e transforma a fila inteira em conflitos', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  const [t] = await A.exec('adicionarToner', [{ modelo: 'X', quantidade: 1, data: DIA }]);
  const p = await A.exec('criarPessoa', [{ nome: 'Pessoa X' }]);
  await A.sincronizar();
  const obj = JSON.parse(rem.texto); obj.db.movimentos.push(null); obj.db.toners.unshift(null); rem.substituir(JSON.stringify(obj));
  await A.exec('mudarStatusToner', [t.id, 'EM_USO']);
  await A.exec('desativarPessoa', [{ id: p.id }]);
  await A.sincronizar();
  assert.strictEqual(A.conflitos.length, 2);
  const quebra = f => { try { f(); return 'ok'; } catch (e) { return e.constructor.name + ': ' + e.message; } };
  return `conflitos: ${A.conflitos.map(c => c.erro).join(' | ')}; verificarConsistencia: ${quebra(() => L.verificarConsistencia(A.db))}; exporter.linhasMovimentos: ${quebra(() => globalThis.App.exporter.linhasMovimentos(A.db))}`;
});

teste('item remoto sem saldo.SAO_CRISTOVAO passa na validação e gera saldo NaN', async () => {
  const rem = R.memoria();
  const A = pc(rem, 'Ana');
  const it = await A.exec('cadastrarItem', [mouse(10)]);
  await A.sincronizar();
  const obj = JSON.parse(rem.texto); delete obj.db.itens[0].saldo.SAO_CRISTOVAO; rem.substituir(JSON.stringify(obj));
  await A.exec('devolver', [it.id, { local: 'SAO_CRISTOVAO', quantidade: 2, data: DIA }]);
  await A.sincronizar();
  const s = remDb(rem).db.itens[0].saldo;
  assert.ok(s.SAO_CRISTOVAO === null || Number.isNaN(s.SAO_CRISTOVAO)); // NaN vira null no JSON
  return `saldo gravado no remoto: ${JSON.stringify(s)}`;
});

// 9. Listas brancas por "obj[chave]" aceitam propriedades herdadas (CWE-1321 / CWE-20).
teste('checaLocal/STATUS_TONER aceitam chaves herdadas ("toString", "constructor", "__proto__")', async () => {
  const db = L.novoBanco();
  const it = L.cadastrarItem(db, mouse(5));
  L.entrada(db, it.id, { local: 'toString', quantidade: 1, data: DIA });
  const [t] = L.adicionarToner(db, { modelo: 'X', status: 'constructor', quantidade: 1, data: DIA });
  const u = L.cadastrarItem(db, nb('P-1'));
  L.entregar(db, u.id, { usuario: 'X', data: DIA });
  L.devolver(db, u.id, { local: '__proto__', data: DIA });
  assert.strictEqual(typeof it.saldo.toString, 'string');
  return `saldo.toString=${JSON.stringify(it.saldo.toString).slice(0, 40)}…; toner.status=${t.status}; item devolvido: local=${u.local}, status=${u.status}, total=${L.total(u)}; consistência: ${L.verificarConsistencia(db).length} problema(s)`;
});

// 10. vincularNomesAntigos concorrente (sem e-mail): o segundo PC cria cadastro duplicado vazio, sem conflito.
teste('vincularNomesAntigos em dois PCs: cria pessoa duplicada (0 vínculos) sem conflito', async () => {
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
  const pessoas = remDb(rem).db.pessoas;
  assert.strictEqual(pessoas.length, 2);
  assert.strictEqual(B.conflitos.length, 0);
  return `pessoas no remoto: ${pessoas.map(p => p.nome).join(', ')}; conflitos em B: 0`;
});

// 11. Estado salvo que não passa em validarBanco: carregar lança, motor segue com banco vazio e a próxima gravação local sobrescreve a fila.
teste('carregar() falhando → motor fica vazio e a primeira ação sobrescreve o estado salvo (fila perdida)', async () => {
  let idb = null;
  const persist = async s => { idb = structuredClone(s); };
  const A = pc(R.memoria(), 'Ana', persist);
  A.carregar({ base: { db: L.novoBanco(), etag: null, aplicadas: [] } });
  await A.exec('cadastrarItem', [mouse(3)]);      // pendente
  idb.base.db.pessoas = [{ nome: 'sem id' }];      // um registro inválido qualquer
  const salvo = structuredClone(idb);
  const B = pc(R.memoria(), 'Ana', persist);
  assert.throws(() => B.carregar(salvo));
  await B.exec('adicionarToner', [{ modelo: 'Y', quantidade: 1, data: DIA }]);
  assert.strictEqual(idb.pendentes.length, 1);
  assert.strictEqual(idb.pendentes[0].nome, 'adicionarToner');
  return 'fila salva (cadastrarItem) substituída pela nova (adicionarToner)';
});

// Imita navigator.locks.request(nome, { ifAvailable: true }, cb) numa única "janela" do navegador.
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

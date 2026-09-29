/* Testes do cadastro de pessoas, entregas por pessoa e migração dos nomes antigos (Node, sem navegador).
   Uso: node test/testes-pessoas.js
   Só nomes fictícios: nenhum dado real de colaborador neste arquivo (LGPD). */
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
const { ledger: L, exporter: E, store: S } = globalThis.App;

let ok = 0, falhas = 0;
function teste(nome, fn) {
  try { fn(); ok++; console.log('  ✓ ' + nome); }
  catch (e) { falhas++; console.log('  ✗ ' + nome + '\n      ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n      ')); }
}
const hoje = globalThis.App.util.hojeISO();
const lanca = (fn, re) => assert.throws(fn, e => re.test(e.message));
const json = o => JSON.parse(JSON.stringify(o)); // os argumentos precisam ser serializáveis
const consistente = db => assert.deepStrictEqual(L.verificarConsistencia(db), [], L.verificarConsistencia(db).map(p => p.msg).join('\n'));

function notebook(db, serie) {
  return L.cadastrarItem(db, { categoria: 'Notebook', descricao: 'Modelo X', controle: 'unidade', serie, local: 'MATRIZ', data: hoje });
}
function mouse(db, qtd) {
  return L.cadastrarItem(db, { categoria: 'Mouse', descricao: 'M100', controle: 'quantidade', quantidade: qtd, local: 'MATRIZ', data: hoje });
}

console.log('\nCadastro de pessoas');

teste('cria pessoa com o modelo completo e registra no histórico', () => {
  const db = L.novoBanco();
  assert.deepStrictEqual(db.pessoas, []);
  const p = L.criarPessoa(db, json({ nome: '  Ana   Teste ', email: 'Ana.Teste@Exemplo.com', departamento: 'Financeiro', unidade: 'MATRIZ' }));
  assert.strictEqual(p.nome, 'Ana Teste');
  assert.strictEqual(p.tipo, 'PESSOA'); assert.strictEqual(p.ativo, true);
  assert.strictEqual(p.email, 'ana.teste@exemplo.com');
  assert.strictEqual(p.origem, 'manual'); assert.strictEqual(p.entraId, null);
  assert.ok(p.id && p.criadoEm && p.atualizadoEm);
  assert.strictEqual(db.movimentos.at(-1).tipo, 'PESSOA');
  assert.strictEqual(db.movimentos.at(-1).pessoaId, p.id);
  consistente(db);
});

teste('valida nome, tipo, unidade e formato do e-mail', () => {
  const db = L.novoBanco();
  lanca(() => L.criarPessoa(db, { nome: '  ' }), /nome/i);
  lanca(() => L.criarPessoa(db, { nome: 'X', tipo: 'ROBO' }), /Tipo inválido/);
  lanca(() => L.criarPessoa(db, { nome: 'X', tipo: 'constructor' }), /Tipo inválido/);
  lanca(() => L.criarPessoa(db, { nome: 'X', unidade: 'LUA' }), /Unidade inválida/);
  lanca(() => L.criarPessoa(db, { nome: 'X', email: 'sem-arroba' }), /E-mail inválido/);
  assert.strictEqual(db.pessoas.length, 0);
});

teste('e-mail é único entre pessoas (sem diferenciar maiúsculas), mas pode ficar em branco em várias', () => {
  const db = L.novoBanco();
  const a = L.criarPessoa(db, { nome: 'Ana Teste', email: 'ana@exemplo.com' });
  lanca(() => L.criarPessoa(db, { nome: 'Outra', email: 'ANA@exemplo.com' }), /já pertence a Ana Teste/);
  L.criarPessoa(db, { nome: 'Sem Email 1' }); L.criarPessoa(db, { nome: 'Sem Email 2', email: '' });
  const b = L.criarPessoa(db, { nome: 'Beto Teste', email: 'beto@exemplo.com' });
  lanca(() => L.editarPessoa(db, { id: b.id, email: 'ana@exemplo.com' }), /já pertence a Ana Teste/);
  assert.strictEqual(b.email, 'beto@exemplo.com');
  assert.strictEqual(L.editarPessoa(db, { id: a.id, email: 'ANA@exemplo.com' }), null, 'mesmo e-mail dela não é conflito nem alteração');
  consistente(db);
});

teste('edita só o que veio, gera movimento com as alterações e não faz nada sem mudança', () => {
  const db = L.novoBanco();
  const p = L.criarPessoa(db, { nome: 'Ana Teste', departamento: 'Financeiro', obs: 'ok' });
  const antes = db.movimentos.length;
  const m = L.editarPessoa(db, json({ id: p.id, departamento: 'Compras', unidade: 'SAO_CRISTOVAO' }));
  assert.deepStrictEqual(m.alteracoes.map(a => a.campo), ['departamento', 'unidade']);
  assert.strictEqual(p.departamento, 'Compras'); assert.strictEqual(p.unidade, 'SAO_CRISTOVAO'); assert.strictEqual(p.obs, 'ok');
  assert.strictEqual(L.editarPessoa(db, { id: p.id, departamento: 'Compras' }), null);
  assert.strictEqual(db.movimentos.length, antes + 1);
  L.editarPessoa(db, { id: p.id, departamento: '' });
  assert.strictEqual(p.departamento, null);
  lanca(() => L.editarPessoa(db, { id: p.id, nome: '' }), /nome/i);
  lanca(() => L.editarPessoa(db, { id: 'nao-existe', nome: 'X' }), /não encontrada/);
});

teste('renomear atualiza o responsável exibido dos itens que estão com ela', () => {
  const db = L.novoBanco();
  const p = L.criarPessoa(db, { nome: 'Ana Teste' });
  const nb = notebook(db, 'S1');
  L.entregar(db, nb.id, { pessoaId: p.id, data: hoje });
  L.editarPessoa(db, { id: p.id, nome: 'Ana Teste Souza' });
  assert.strictEqual(nb.responsavelAtual, 'Ana Teste Souza');
  assert.strictEqual(nb.responsavelId, p.id);
  consistente(db);
});

teste('desativar e reativar mantêm o cadastro e o histórico (não há exclusão)', () => {
  const db = L.novoBanco();
  const p = L.criarPessoa(db, { nome: 'Ana Teste' });
  L.desativarPessoa(db, { id: p.id });
  assert.strictEqual(p.ativo, false);
  lanca(() => L.desativarPessoa(db, { id: p.id }), /já está inativa/);
  L.reativarPessoa(db, { id: p.id });
  assert.strictEqual(p.ativo, true);
  lanca(() => L.reativarPessoa(db, { id: p.id }), /já está ativa/);
  assert.strictEqual(db.pessoas.length, 1);
  assert.ok(db.movimentos.filter(m => m.pessoaId === p.id).length >= 3);
  assert.strictEqual(L.excluirPessoa, undefined);
});

console.log('\nEntrega e devolução por pessoa');

teste('entrega com pessoaId preenche usuário, responsável e vínculo (item por unidade)', () => {
  const db = L.novoBanco();
  const p = L.criarPessoa(db, { nome: 'Ana Teste', departamento: 'Financeiro' });
  const nb = notebook(db, 'S1');
  const m = L.entregar(db, nb.id, { pessoaId: p.id, usuario: 'texto ignorado', data: hoje });
  assert.strictEqual(m.usuario, 'Ana Teste'); assert.strictEqual(m.pessoaId, p.id);
  assert.strictEqual(nb.responsavelAtual, 'Ana Teste'); assert.strictEqual(nb.responsavelId, p.id);
  assert.strictEqual(nb.status, 'ENTREGUE');
  const d = L.devolver(db, nb.id, { local: 'MATRIZ', data: hoje, pessoaId: p.id });
  assert.strictEqual(d.usuario, 'Ana Teste'); assert.strictEqual(d.pessoaId, p.id);
  assert.strictEqual(nb.responsavelAtual, null); assert.strictEqual(nb.responsavelId, null);
  consistente(db);
});

teste('pessoa inexistente ou inativa não recebe entrega; nada muda', () => {
  const db = L.novoBanco();
  const p = L.criarPessoa(db, { nome: 'Ana Teste' });
  const nb = notebook(db, 'S1');
  const antes = JSON.stringify(db);
  lanca(() => L.entregar(db, nb.id, { pessoaId: 'nao-existe', data: hoje }), /não encontrada/);
  L.desativarPessoa(db, { id: p.id });
  const depois = JSON.stringify(db);
  lanca(() => L.entregar(db, nb.id, { pessoaId: p.id, data: hoje }), /inativa/);
  assert.strictEqual(JSON.stringify(db), depois);
  assert.strictEqual(nb.status, 'EM_ESTOQUE');
  assert.notStrictEqual(antes, depois);
});

teste('pessoa inativa ainda pode devolver (ex-colaborador)', () => {
  const db = L.novoBanco();
  const p = L.criarPessoa(db, { nome: 'Ana Teste' });
  const nb = notebook(db, 'S1');
  L.entregar(db, nb.id, { pessoaId: p.id, data: hoje });
  L.desativarPessoa(db, { id: p.id });
  L.devolver(db, nb.id, { local: 'MATRIZ', data: hoje, pessoaId: p.id });
  assert.strictEqual(nb.status, 'EM_ESTOQUE');
  lanca(() => L.devolver(db, nb.id, { local: 'MATRIZ', data: hoje, pessoaId: 'nao-existe' }), /não encontrada|só itens entregues/);
});

teste('continua aceitando só texto (compatibilidade): sem vínculo com pessoa', () => {
  const db = L.novoBanco();
  const nb = notebook(db, 'S1');
  const m = L.entregar(db, nb.id, { usuario: 'Fulana de Tal', data: hoje });
  assert.strictEqual(m.usuario, 'Fulana de Tal'); assert.strictEqual(m.pessoaId, null);
  assert.strictEqual(nb.responsavelAtual, 'Fulana de Tal'); assert.strictEqual(nb.responsavelId, null);
  lanca(() => L.entregar(db, mouse(db, 2).id, { local: 'MATRIZ', quantidade: 1, data: hoje }), /para quem/);
  consistente(db);
});

console.log('\nItens com a pessoa');

teste('lista itens por unidade e por quantidade (entregas menos devoluções da pessoa)', () => {
  const db = L.novoBanco();
  const ana = L.criarPessoa(db, { nome: 'Ana Teste' });
  const beto = L.criarPessoa(db, { nome: 'Beto Teste' });
  const nb = notebook(db, 'S1'), nb2 = notebook(db, 'S2');
  const mo = mouse(db, 10);
  L.entregar(db, nb.id, { pessoaId: ana.id, data: '2026-03-01' });
  L.entregar(db, nb2.id, { pessoaId: beto.id, data: '2026-03-02' });
  L.entregar(db, mo.id, { pessoaId: ana.id, local: 'MATRIZ', quantidade: 3, data: '2026-03-03' });
  L.entregar(db, mo.id, { pessoaId: beto.id, local: 'MATRIZ', quantidade: 2, data: '2026-03-04' });
  L.devolver(db, mo.id, { pessoaId: ana.id, local: 'MATRIZ', quantidade: 1, data: '2026-03-05' });

  const daAna = L.itensComPessoa(db, ana.id);
  assert.strictEqual(daAna.length, 2);
  const nAna = daAna.find(x => x.item.id === nb.id), mAna = daAna.find(x => x.item.id === mo.id);
  assert.strictEqual(nAna.controle, 'unidade'); assert.strictEqual(nAna.quantidade, 1); assert.strictEqual(nAna.desde, '2026-03-01');
  assert.strictEqual(mAna.controle, 'quantidade'); assert.strictEqual(mAna.quantidade, 2); assert.strictEqual(mAna.desde, '2026-03-03');
  assert.strictEqual(L.itensComPessoa(db, beto.id).reduce((s, x) => s + x.quantidade, 0), 3);

  const hist = L.historicoPessoa(db, ana.id);
  assert.deepStrictEqual(hist.map(m => m.tipo), ['DEVOLUCAO', 'ENTREGA', 'ENTREGA']);
  assert.ok(hist.every(m => m.pessoaId === ana.id));

  // Devolução total: o item por quantidade sai da lista; devolução do notebook também.
  L.devolver(db, mo.id, { pessoaId: ana.id, local: 'MATRIZ', quantidade: 2, data: hoje });
  L.devolver(db, nb.id, { pessoaId: ana.id, local: 'MATRIZ', data: hoje });
  assert.deepStrictEqual(L.itensComPessoa(db, ana.id), []);
  consistente(db);
});

teste('devolução por quantidade sem pessoa não abate; devolver mais que o entregue nunca fica negativo', () => {
  const db = L.novoBanco();
  const ana = L.criarPessoa(db, { nome: 'Ana Teste' });
  const mo = mouse(db, 5);
  L.entregar(db, mo.id, { pessoaId: ana.id, local: 'MATRIZ', quantidade: 2, data: hoje });
  L.devolver(db, mo.id, { local: 'MATRIZ', quantidade: 1, data: hoje, usuario: 'alguém' });
  assert.strictEqual(L.itensComPessoa(db, ana.id)[0].quantidade, 2);
  L.devolver(db, mo.id, { pessoaId: ana.id, local: 'MATRIZ', quantidade: 3, data: hoje });
  assert.deepStrictEqual(L.itensComPessoa(db, ana.id), []);
});

teste('itens na Lixeira não entram na lista; pessoa inativa com itens continua listada', () => {
  const db = L.novoBanco();
  const ana = L.criarPessoa(db, { nome: 'Ana Teste' });
  const nb = notebook(db, 'S1'), nb2 = notebook(db, 'S2');
  L.entregar(db, nb.id, { pessoaId: ana.id, data: hoje });
  L.entregar(db, nb2.id, { pessoaId: ana.id, data: hoje });
  L.excluirItem(db, nb2.id);
  L.desativarPessoa(db, { id: ana.id });
  const lista = L.itensComPessoa(db, ana.id);
  assert.strictEqual(lista.length, 1); assert.strictEqual(lista[0].item.id, nb.id);
  assert.ok(/ainda com 1 item/.test(db.movimentos.at(-1).obs), 'aviso registrado no histórico');
  consistente(db);
});

console.log('\nMigração dos nomes antigos');

// Banco com nomes em texto livre (todos fictícios), como o das entregas da planilha.
function bancoAntigo() {
  const db = L.novoBanco();
  const nb1 = notebook(db, 'S1'), nb2 = notebook(db, 'S2'), nb3 = notebook(db, 'S3'), nb4 = notebook(db, 'S4');
  const mo = mouse(db, 20);
  L.entregar(db, nb1.id, { usuario: 'Ana Teste (Operação)', data: hoje });
  L.entregar(db, mo.id, { usuario: 'ANA  TESTE', local: 'MATRIZ', quantidade: 2, data: hoje });
  L.entregar(db, mo.id, { usuario: 'ana teste', local: 'MATRIZ', quantidade: 1, data: hoje });
  L.entregar(db, nb2.id, { usuario: 'Bruno Ávila', data: hoje });
  L.devolver(db, nb2.id, { local: 'MATRIZ', data: hoje, usuario: 'bruno avila' });
  L.entregar(db, nb3.id, { usuario: 'CRC', data: hoje });
  L.entregar(db, mo.id, { usuario: 'Filial SP', local: 'MATRIZ', quantidade: 4, data: hoje });
  L.entregar(db, nb4.id, { usuario: 'Carla Exemplo', data: hoje });
  L.devolver(db, mo.id, { local: 'MATRIZ', quantidade: 1, data: hoje, usuario: 'Carla Exemplo' });
  return { db, nb1, nb2, nb3, nb4, mo };
}

teste('agrupa variações (acento, caixa, espaços, "Nome (Setor)") e conta o que falta vincular', () => {
  const { db } = bancoAntigo();
  const gs = L.gruposNomesAntigos(db);
  assert.deepStrictEqual(gs.map(g => g.nome), ['Ana Teste', 'Bruno Ávila', 'Carla Exemplo', 'CRC', 'Filial SP']);
  const ana = gs.find(g => g.id === 'ana teste');
  assert.strictEqual(ana.variantes.length, 2, '"ANA  TESTE" e "ana teste" são a mesma grafia normalizada');
  assert.strictEqual(ana.movimentos, 3); assert.strictEqual(ana.itens, 1);
  assert.strictEqual(ana.departamento, 'Operação');
  assert.strictEqual(ana.tipoSugerido, 'PESSOA');
  const bruno = gs.find(g => g.id === 'bruno avila');
  assert.strictEqual(bruno.movimentos, 2); assert.strictEqual(bruno.itens, 0);
  assert.strictEqual(bruno.nome, 'Bruno Ávila', 'usa a grafia com caixa mista, não a minúscula');
});

teste('sugere SETOR para siglas em maiúsculas sem espaço e palavras de setor; pessoas ficam como pessoa', () => {
  const { db } = bancoAntigo();
  const gs = L.gruposNomesAntigos(db);
  const por = n => gs.find(g => g.nome === n);
  assert.strictEqual(por('CRC').tipoSugerido, 'SETOR');
  assert.ok(por('CRC').motivoSetor);
  assert.strictEqual(por('Filial SP').tipoSugerido, 'SETOR');
  assert.strictEqual(por('Filial SP').nome, 'Filial SP', 'setor mantém a grafia original');
  assert.strictEqual(por('Ana Teste').tipoSugerido, 'PESSOA');
  assert.strictEqual(por('Carla Exemplo').tipoSugerido, 'PESSOA');
  assert.strictEqual(por('Carla Exemplo').motivoSetor, null);
});

teste('nome todo em maiúsculas/minúsculas vira Nome Próprio, com partículas em minúsculas', () => {
  const db = L.novoBanco();
  const nb = notebook(db, 'S1');
  L.entregar(db, nb.id, { usuario: 'MARIA DA SILVA TESTE', data: hoje });
  assert.strictEqual(L.gruposNomesAntigos(db)[0].nome, 'Maria da Silva Teste');
});

teste('aponta o cadastro existente com o mesmo nome normalizado', () => {
  const { db } = bancoAntigo();
  const p = L.criarPessoa(db, { nome: 'Bruno  Avila' });
  const g = L.gruposNomesAntigos(db).find(x => x.id === 'bruno avila');
  assert.strictEqual(g.existenteId, p.id);
});

teste('nada é criado ao só consultar os grupos', () => {
  const { db } = bancoAntigo();
  const antes = JSON.stringify(db);
  L.gruposNomesAntigos(db);
  assert.strictEqual(JSON.stringify(db), antes);
  assert.strictEqual(db.pessoas.length, 0);
});

teste('aplica as decisões: criar, vincular a existente, setor e ignorar', () => {
  const { db, nb1, nb2, nb3, nb4, mo } = bancoAntigo();
  const bruno = L.criarPessoa(db, { nome: 'Bruno Ávila', email: 'bruno@exemplo.com' });
  const gs = L.gruposNomesAntigos(db);
  const nomes = id => gs.find(g => g.id === id).variantes.map(v => v.texto);
  const decisoes = json([
    { acao: 'criar', nomes: nomes('ana teste'), pessoa: { nome: 'Ana Teste', departamento: 'Operação' } },
    { acao: 'vincular', nomes: nomes('bruno avila'), pessoaId: bruno.id },
    { acao: 'setor', nomes: nomes('crc'), pessoa: { nome: 'CRC' } },
    { acao: 'ignorar', nomes: nomes('filial sp') },
  ]);
  const r = L.vincularNomesAntigos(db, { decisoes });
  assert.deepStrictEqual(r, { pessoasCriadas: 2, movimentosVinculados: 3 + 2 + 1, itensVinculados: 1 + 0 + 1 });

  const ana = db.pessoas.find(p => p.nome === 'Ana Teste');
  assert.strictEqual(ana.tipo, 'PESSOA'); assert.strictEqual(ana.departamento, 'Operação'); assert.strictEqual(ana.origem, 'migracao');
  const crc = db.pessoas.find(p => p.nome === 'CRC');
  assert.strictEqual(crc.tipo, 'SETOR'); assert.strictEqual(crc.origem, 'migracao');

  assert.strictEqual(nb1.responsavelId, ana.id); assert.strictEqual(nb1.responsavelAtual, 'Ana Teste');
  assert.strictEqual(nb3.responsavelId, crc.id);
  assert.strictEqual(nb2.responsavelId, null, 'já devolvido: sem responsável atual');
  const movsDe = pid => db.movimentos.filter(m => m.pessoaId === pid && m.tipo !== 'PESSOA');
  assert.strictEqual(movsDe(ana.id).length, 3);
  assert.strictEqual(movsDe(bruno.id).length, 2);
  assert.strictEqual(movsDe(crc.id).length, 1);
  // O texto original das movimentações é preservado.
  assert.ok(movsDe(ana.id).some(m => m.usuario === 'Ana Teste (Operação)') && movsDe(ana.id).some(m => m.usuario === 'ANA  TESTE'.replace(/ +/g, ' ')));
  // Ignorado e não listado continuam sem vínculo.
  assert.ok(db.movimentos.filter(m => m.usuario === 'Filial SP').every(m => !m.pessoaId));
  assert.ok(db.movimentos.filter(m => m.usuario === 'Carla Exemplo').every(m => !m.pessoaId));
  assert.strictEqual(nb4.responsavelId, null);

  // Histórico: um registro por grupo vinculado, ligados pelo mesmo lote.
  const logs = db.movimentos.filter(m => m.tipo === 'PESSOA' && m.lote);
  assert.strictEqual(logs.length, 3);
  assert.strictEqual(new Set(logs.map(m => m.lote)).size, 1);
  assert.ok(logs.every(m => /Nomes antigos vinculados/.test(m.obs)));

  // Itens por quantidade agora aparecem "com a pessoa"; saldo e consistência intactos.
  assert.strictEqual(L.itensComPessoa(db, ana.id).find(x => x.item.id === mo.id).quantidade, 3);
  consistente(db);
  assert.deepStrictEqual(L.gruposNomesAntigos(db).map(g => g.nome), ['Carla Exemplo', 'Filial SP']);
});

teste('validação prévia: e-mail duplicado, pessoa inexistente e nome repetido não alteram nada', () => {
  const { db } = bancoAntigo();
  L.criarPessoa(db, { nome: 'Fulano Existente', email: 'fulano@exemplo.com' });
  const antes = JSON.stringify(db);
  const cria = (nomes, pessoa) => ({ acao: 'criar', nomes, pessoa });
  lanca(() => L.vincularNomesAntigos(db, { decisoes: [cria(['Bruno Ávila'], { nome: 'Bruno', email: 'x@exemplo.com' }), cria(['CRC'], { nome: 'Outro', email: 'fulano@exemplo.com' })] }), /já pertence/);
  lanca(() => L.vincularNomesAntigos(db, { decisoes: [cria(['Bruno Ávila'], { nome: 'A', email: 'igual@exemplo.com' }), cria(['CRC'], { nome: 'B', email: 'IGUAL@exemplo.com' })] }), /mais de uma pessoa nova/);
  lanca(() => L.vincularNomesAntigos(db, { decisoes: [{ acao: 'vincular', nomes: ['CRC'], pessoaId: 'nao-existe' }] }), /não encontrada/);
  lanca(() => L.vincularNomesAntigos(db, { decisoes: [cria(['CRC'], { nome: 'A' }), cria(['crc'], { nome: 'B' })] }), /mais de uma decisão/);
  lanca(() => L.vincularNomesAntigos(db, { decisoes: [cria(['CRC'], { nome: '' })] }), /nome/i);
  lanca(() => L.vincularNomesAntigos(db, { decisoes: [{ acao: 'apagar', nomes: ['CRC'] }] }), /Ação inválida/);
  lanca(() => L.vincularNomesAntigos(db, { decisoes: [{ acao: 'ignorar', nomes: ['CRC'] }] }), /Nenhum vínculo/);
  lanca(() => L.vincularNomesAntigos(db, { decisoes: [] }), /Nenhuma decisão/);
  assert.strictEqual(JSON.stringify(db), antes);
});

teste('vincular é idempotente: repetir a decisão não duplica nem re-vincula', () => {
  const { db } = bancoAntigo();
  const decisoes = [{ acao: 'setor', nomes: ['CRC'], pessoa: { nome: 'CRC' } }];
  L.vincularNomesAntigos(db, { decisoes });
  const r = L.vincularNomesAntigos(db, { decisoes: [{ acao: 'vincular', nomes: ['CRC'], pessoaId: db.pessoas[0].id }] });
  assert.strictEqual(r.movimentosVinculados, 0); assert.strictEqual(r.itensVinculados, 0);
  consistente(db);
});

console.log('\nBanco antigo e exportação');

teste('banco antigo sem "pessoas": tudo funciona e o carregamento normaliza', () => {
  const { db } = bancoAntigo();
  const antigo = json(db); delete antigo.pessoas;
  for (const it of antigo.itens) delete it.responsavelId;
  for (const m of antigo.movimentos) delete m.pessoaId;
  const validado = S.validarBanco(antigo);
  assert.deepStrictEqual(validado.pessoas, []);
  assert.strictEqual(L.gruposNomesAntigos(validado).length, 5);
  consistente(validado);
  // Sem passar pela validação, as consultas tratam a ausência como lista vazia e a criação cria a lista.
  const cru = json(db); delete cru.pessoas;
  assert.deepStrictEqual(L.listaPessoas(cru), []);
  assert.deepStrictEqual([...L.posicoesPessoas(cru).keys()], []);
  const p = L.criarPessoa(cru, { nome: 'Ana Teste' });
  assert.strictEqual(cru.pessoas.length, 1);
  L.entregar(cru, cru.itens[0].id.length ? cru.itens.find(i => i.status === 'EM_ESTOQUE').id : null, { pessoaId: p.id, data: hoje });
  consistente(cru);
  // Arquivos com "pessoas" inválido são recusados.
  lanca(() => S.validarBanco(Object.assign(json(db), { pessoas: [{ nome: 'sem id' }] })), /pessoas/);
  lanca(() => S.validarBanco(Object.assign(json(db), { pessoas: 'x' })), /pessoas/);
});

teste('consistência acusa vínculo com pessoa inexistente e e-mail repetido', () => {
  const db = L.novoBanco();
  const p = L.criarPessoa(db, { nome: 'Ana Teste', email: 'a@exemplo.com' });
  const nb = notebook(db, 'S1');
  L.entregar(db, nb.id, { pessoaId: p.id, data: hoje });
  consistente(db);
  db.pessoas.push(Object.assign({}, p, { id: 'copia', nome: 'Cópia' }));
  assert.ok(L.verificarConsistencia(db).some(x => /E-mail a@exemplo.com repetido/.test(x.msg)));
  db.pessoas = db.pessoas.filter(x => x.id === 'copia');
  const msgs = L.verificarConsistencia(db).map(x => x.msg).join('\n');
  assert.ok(/pessoa que não existe/.test(msgs));
});

teste('planilha de backup tem a aba Pessoas e o Estoque mostra o nome cadastrado', () => {
  const db = L.novoBanco();
  const ana = L.criarPessoa(db, { nome: 'Ana Teste', email: 'ana@exemplo.com', departamento: 'Financeiro', unidade: 'MATRIZ' });
  const setor = L.criarPessoa(db, { nome: 'CRC', tipo: 'SETOR' });
  const nb = notebook(db, 'S1');
  L.entregar(db, nb.id, { pessoaId: ana.id, data: hoje });
  nb.responsavelAtual = 'texto antigo diferente'; // simula texto desatualizado: vale o cadastro
  const wb = E.montarPlanilha(db);
  assert.ok(wb.SheetNames.includes('Pessoas'));
  const bin = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const volta = XLSX.read(bin, { type: 'array' });
  const pessoas = XLSX.utils.sheet_to_json(volta.Sheets['Pessoas']);
  assert.strictEqual(pessoas.length, 2);
  const linhaAna = pessoas.find(x => x['Nome'] === 'Ana Teste');
  assert.strictEqual(linhaAna['Itens com a pessoa'], 1); assert.strictEqual(linhaAna['Tipo'], 'Pessoa'); assert.strictEqual(linhaAna['Unidade'], 'Matriz');
  assert.strictEqual(pessoas.find(x => x['Nome'] === 'CRC')['Tipo'], 'Setor');
  const estoque = XLSX.utils.sheet_to_json(volta.Sheets['Estoque']);
  assert.strictEqual(estoque.find(x => x['Nº de série'] === 'S1')['Com (responsável)'], 'Ana Teste');
  assert.ok(setor.id);
});

teste('exportação dos itens de uma pessoa: itens atuais + histórico', () => {
  const db = L.novoBanco();
  const ana = L.criarPessoa(db, { nome: 'Ana Teste' });
  const nb = notebook(db, 'S1');
  const mo = mouse(db, 5);
  L.entregar(db, nb.id, { pessoaId: ana.id, data: '2026-04-01' });
  L.entregar(db, mo.id, { pessoaId: ana.id, local: 'MATRIZ', quantidade: 2, data: '2026-04-02' });
  const wb = E.montarPlanilhaPessoa(db, ana.id);
  assert.deepStrictEqual(wb.SheetNames, ['Itens com a pessoa', 'Histórico']);
  const itens = XLSX.utils.sheet_to_json(wb.Sheets['Itens com a pessoa']);
  assert.strictEqual(itens.length, 2);
  assert.strictEqual(itens.reduce((s, x) => s + x['Quantidade'], 0), 3);
  assert.strictEqual(itens.find(x => x['Categoria'] === 'Notebook')['Nº de série'], 'S1');
  assert.strictEqual(XLSX.utils.sheet_to_json(wb.Sheets['Histórico']).length, 2);
  lanca(() => E.montarPlanilhaPessoa(db, 'nao-existe'), /não encontrada/);
});

console.log(`\n${ok} ok, ${falhas} falha(s)`);
process.exit(falhas ? 1 : 0);

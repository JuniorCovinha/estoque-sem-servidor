/* Testes de regra de negócio e importação (Node, sem navegador).
   Uso: node test/testes.js [caminho-da-planilha.xlsx]
   A planilha é apenas lida; nada é gravado nela. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const raiz = path.join(__dirname, '..');
globalThis.window = globalThis;
for (const f of ['vendor/xlsx.full.min.js', 'js/util.js', 'js/ledger.js', 'js/importer.js', 'js/exporter.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(raiz, f), 'utf8'), { filename: f });
}
const { ledger: L, importer: I, exporter: E } = globalThis.App;

let ok = 0, falhas = 0;
function teste(nome, fn) {
  try { fn(); ok++; console.log('  ✓ ' + nome); }
  catch (e) { falhas++; console.log('  ✗ ' + nome + '\n      ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n      ')); }
}
const hoje = globalThis.App.util.hojeISO();
const lanca = (fn, re) => assert.throws(fn, e => re.test(e.message));

console.log('\nRegras de movimentação');

teste('cadastro por quantidade gera ENTRADA e saldo', () => {
  const db = L.novoBanco();
  const it = L.cadastrarItem(db, { categoria: 'Mouse Logitech', descricao: 'M90', controle: 'quantidade', quantidade: 5, local: 'MATRIZ', data: hoje });
  assert.strictEqual(it.saldo.MATRIZ, 5);
  assert.strictEqual(db.movimentos.length, 1);
  assert.strictEqual(db.movimentos[0].delta, 5);
  assert.deepStrictEqual(L.verificarConsistencia(db), []);
});

teste('série duplicada é bloqueada (sem diferenciar maiúsculas)', () => {
  const db = L.novoBanco();
  L.cadastrarItem(db, { categoria: 'Notebook Dell', descricao: 'Latitude', controle: 'unidade', serie: 'ABC123', local: 'MATRIZ', data: hoje });
  lanca(() => L.cadastrarItem(db, { categoria: 'Notebook Dell', descricao: 'X', controle: 'unidade', serie: 'abc123 ', local: 'MATRIZ', data: hoje }), /Já existe/);
});

teste('entrega → devolução → manutenção → retorno → descarte de item com série', () => {
  const db = L.novoBanco();
  const it = L.cadastrarItem(db, { categoria: 'Notebook Dell', descricao: 'Latitude 3420', controle: 'unidade', serie: 'S1', local: 'MATRIZ', data: hoje });
  L.entregar(db, it.id, { usuario: 'Fulana', chamado: '0626-000001', data: hoje });
  assert.strictEqual(it.status, 'ENTREGUE'); assert.strictEqual(L.total(it), 0); assert.strictEqual(it.responsavelAtual, 'Fulana');
  assert.strictEqual(db.movimentos.at(-1).chamado, '#0626-000001');
  lanca(() => L.entregar(db, it.id, { usuario: 'Outra', data: hoje }), /não pode ser entregue/);
  lanca(() => L.descartar(db, it.id, { justificativa: 'x', data: hoje }), /devolução/);
  L.devolver(db, it.id, { local: 'SAO_CRISTOVAO', data: hoje, manutencao: true });
  assert.strictEqual(it.status, 'MANUTENCAO'); assert.strictEqual(it.saldo.SAO_CRISTOVAO, 1); assert.strictEqual(it.local, 'SAO_CRISTOVAO');
  L.retornarManutencao(db, it.id, { data: hoje, posicao: 'A P2' });
  assert.strictEqual(it.status, 'EM_ESTOQUE'); assert.strictEqual(it.posicao, 'A P2');
  L.descartar(db, it.id, { justificativa: 'Tela quebrada', data: hoje, valorUnit: '350,50', dadosApagados: 'SIM' });
  assert.strictEqual(it.status, 'DESCARTADO'); assert.strictEqual(L.total(it), 0);
  assert.strictEqual(db.movimentos.at(-1).descarte.valorUnit, 350.5);
  assert.deepStrictEqual(L.verificarConsistencia(db), []);
});

teste('saldo insuficiente e quantidades inválidas são bloqueados', () => {
  const db = L.novoBanco();
  const it = L.cadastrarItem(db, { categoria: 'Teclado', descricao: 'K120', controle: 'quantidade', quantidade: 2, local: 'MATRIZ', data: hoje });
  lanca(() => L.entregar(db, it.id, { usuario: 'A', local: 'MATRIZ', quantidade: 3, data: hoje }), /insuficiente/);
  lanca(() => L.entregar(db, it.id, { usuario: 'A', local: 'SAO_CRISTOVAO', quantidade: 1, data: hoje }), /insuficiente/);
  lanca(() => L.entregar(db, it.id, { usuario: 'A', local: 'MATRIZ', quantidade: 1.5, data: hoje }), /inteira/);
  lanca(() => L.entregar(db, it.id, { usuario: '', local: 'MATRIZ', quantidade: 1, data: hoje }), /para quem/);
  L.entregar(db, it.id, { usuario: 'A', local: 'MATRIZ', quantidade: 2, data: hoje });
  assert.strictEqual(it.saldo.MATRIZ, 0);
  L.ajustar(db, it.id, { local: 'MATRIZ', novaQuantidade: 4, motivo: 'Contagem' });
  assert.strictEqual(it.saldo.MATRIZ, 4);
  assert.strictEqual(db.movimentos.at(-1).delta, 4);
  assert.deepStrictEqual(L.verificarConsistencia(db), []);
});

teste('edição valida antes de alterar (nada muda se um campo falhar)', () => {
  const db = L.novoBanco();
  L.cadastrarItem(db, { categoria: 'Notebook', descricao: 'A', controle: 'unidade', serie: 'X1', local: 'MATRIZ', data: hoje });
  const b = L.cadastrarItem(db, { categoria: 'Notebook', descricao: 'B', controle: 'unidade', serie: 'X2', local: 'MATRIZ', data: hoje });
  lanca(() => L.editarItem(db, b.id, { descricao: 'B2', serie: 'x1' }), /já pertence/);
  assert.strictEqual(b.descricao, 'B');
  const m = L.editarItem(db, b.id, { descricao: 'B2', posicao: 'A P3' });
  assert.strictEqual(m.alteracoes.length, 2);
  assert.strictEqual(L.editarItem(db, b.id, { descricao: 'B2' }), null);
});

teste('Lixeira: excluir e restaurar item preserva saldo, situação e histórico', () => {
  const db = L.novoBanco();
  const cabo = L.cadastrarItem(db, { categoria: 'Cabo', descricao: 'HDMI', controle: 'quantidade', quantidade: 3, local: 'MATRIZ', data: hoje });
  L.entregar(db, cabo.id, { usuario: 'A', local: 'MATRIZ', quantidade: 1, data: hoje });
  const nb = L.cadastrarItem(db, { categoria: 'Notebook', descricao: 'Latitude', controle: 'unidade', serie: 'LX1', local: 'MATRIZ', data: hoje });
  L.entregar(db, nb.id, { usuario: 'Fulana', data: hoje });
  assert.ok(L.avisosExclusao(db, cabo.id).some(a => /2 unidade/.test(a)));
  assert.ok(L.avisosExclusao(db, nb.id).some(a => /entregue a Fulana/.test(a)));
  L.excluirItem(db, cabo.id); L.excluirItem(db, nb.id);
  assert.strictEqual(L.itensAtivos(db).length, 0);
  assert.ok(!L.listas.categorias(db).length, 'categorias só dos ativos');
  lanca(() => L.entregar(db, cabo.id, { usuario: 'B', local: 'MATRIZ', quantidade: 1, data: hoje }), /Lixeira/);
  lanca(() => L.editarItem(db, nb.id, { descricao: 'X' }), /Lixeira/);
  lanca(() => L.cadastrarItem(db, { categoria: 'Notebook', descricao: 'Y', controle: 'unidade', serie: 'lx1', local: 'MATRIZ', data: hoje }), /Lixeira/);
  assert.deepStrictEqual(L.verificarConsistencia(db), []);
  L.restaurarItem(db, cabo.id); L.restaurarItem(db, nb.id);
  assert.strictEqual(cabo.saldo.MATRIZ, 2); assert.strictEqual(nb.status, 'ENTREGUE'); assert.strictEqual(nb.responsavelAtual, 'Fulana');
  assert.ok(db.movimentos.some(m => m.tipo === 'EXCLUSAO') && db.movimentos.some(m => m.tipo === 'RESTAURACAO'));
  lanca(() => L.restaurarItem(db, cabo.id), /não está na Lixeira/);
  assert.deepStrictEqual(L.verificarConsistencia(db), []);
});

teste('Lixeira: toner excluído some das contagens e pode ser restaurado', () => {
  const db = L.novoBanco();
  const [t] = L.adicionarToner(db, { modelo: 'W9008-EVP', status: 'NOVO', quantidade: 1 });
  L.excluirToner(db, t.id);
  assert.strictEqual(L.tonersAtivos(db).length, 0);
  lanca(() => L.mudarStatusToner(db, t.id, 'EM_USO'), /Lixeira/);
  L.restaurarToner(db, t.id);
  assert.strictEqual(L.tonersAtivos(db).length, 1);
  const wb = E.montarPlanilha(db);
  assert.ok(wb.SheetNames.includes('Lixeira'));
});

teste('"Tem série": item por quantidade com 1 unidade passa a ter nº de série', () => {
  const db = L.novoBanco();
  const it = L.cadastrarItem(db, { categoria: 'Celular Samsung', descricao: 'Galaxy A17', controle: 'quantidade', quantidade: 1, local: 'SAO_CRISTOVAO', data: hoje });
  L.cadastrarItem(db, { categoria: 'Notebook', descricao: 'X', controle: 'unidade', serie: 'JA-EXISTE', local: 'MATRIZ', data: hoje });
  lanca(() => L.editarItem(db, it.id, { controle: 'unidade', serie: '' }), /Informe o nº de série/);
  lanca(() => L.editarItem(db, it.id, { controle: 'unidade', serie: 'ja-existe' }), /já pertence/);
  assert.strictEqual(it.controle, 'quantidade', 'nada muda quando a validação falha');
  const m = L.editarItem(db, it.id, { controle: 'unidade', serie: 'R9ABC123', patrimonio: 'PAT-1', descricao: 'Galaxy A17' });
  assert.strictEqual(it.controle, 'unidade'); assert.strictEqual(it.serie, 'R9ABC123'); assert.strictEqual(it.patrimonio, 'PAT-1');
  assert.strictEqual(it.local, 'SAO_CRISTOVAO'); assert.strictEqual(it.status, 'EM_ESTOQUE');
  assert.ok(/Controle/.test(m.obs) && /R9ABC123/.test(m.obs));
  assert.deepStrictEqual(L.verificarConsistencia(db), []);
  // Depois de convertido, segue o fluxo normal de item com série
  L.entregar(db, it.id, { usuario: 'Fulana', data: hoje });
  assert.strictEqual(it.status, 'ENTREGUE');
  assert.deepStrictEqual(L.verificarConsistencia(db), []);
});

teste('"Tem série" é bloqueado para item com 0 ou várias unidades', () => {
  const db = L.novoBanco();
  const varios = L.cadastrarItem(db, { categoria: 'Celular', descricao: 'A17', controle: 'quantidade', quantidade: 2, local: 'MATRIZ', data: hoje });
  lanca(() => L.editarItem(db, varios.id, { controle: 'unidade', serie: 'S1' }), /2 unidades/);
  L.entregar(db, varios.id, { usuario: 'A', local: 'MATRIZ', quantidade: 2, data: hoje });
  lanca(() => L.editarItem(db, varios.id, { controle: 'unidade', serie: 'S1' }), /sem saldo/);
  assert.strictEqual(varios.controle, 'quantidade');
});

teste('CSV: fórmulas neutralizadas, "-" preservado', () => {
  assert.strictEqual(E.celulaSeguraCSV('=HYPERLINK("x")'), '\'=HYPERLINK("x")');
  assert.strictEqual(E.celulaSeguraCSV('-'), '-');
  assert.strictEqual(E.celulaSeguraCSV('-2+3'), "'-2+3");
  assert.strictEqual(E.celulaSeguraCSV('@SUM(A1)'), "'@SUM(A1)");
  assert.strictEqual(E.celulaSeguraCSV('Notebook'), 'Notebook');
});

teste('nome da cor pelo RGB do preenchimento', () => {
  const n = hex => I.nomeDaCor(hex).nome;
  assert.strictEqual(n('000000'), 'Preto');
  assert.strictEqual(n('FF262626'), 'Preto');
  assert.strictEqual(n('00FFFF'), 'Ciano');
  assert.strictEqual(n('05F7E3'), 'Ciano');
  assert.strictEqual(n('FF00FF'), 'Magenta');
  assert.strictEqual(n('E59EDD'), 'Magenta');
  assert.strictEqual(n('FFFF00'), 'Amarelo');
  assert.strictEqual(n('FFC000'), 'Amarelo');
  assert.strictEqual(n('FF0000'), 'Vermelho');
  assert.strictEqual(n('0070C0'), 'Azul');
  assert.strictEqual(n('00B050'), 'Verde');
  assert.strictEqual(n('A6A6A6'), 'Cinza');
  assert.strictEqual(n('FFFFFF'), 'Branco');
  assert.ok(I.nomeDaCor('FFFF00').usual && !I.nomeDaCor('FF0000').usual);
  assert.strictEqual(n('xyz'), '');
});

teste('RGB do preenchimento: rgb, tema + tint, indexado e sem preenchimento', () => {
  const wb = { Themes: { themeElements: { clrScheme: [{ rgb: 'FFFFFF' }, { rgb: '000000' }, { rgb: 'E8E8E8' }, { rgb: '0E2841' }, {}, {}, {}, {}, { rgb: 'A02B93' }] } } };
  const cel = fg => ({ s: { patternType: 'solid', fgColor: fg } });
  assert.strictEqual(I.rgbDoPreenchimento(wb, cel({ rgb: 'FFFFFF00' })), 'FFFF00');
  assert.strictEqual(I.rgbDoPreenchimento(wb, cel({ theme: 1 })), '000000');
  assert.strictEqual(I.rgbDoPreenchimento(wb, cel({ theme: 0 })), 'FFFFFF');
  const tint = I.rgbDoPreenchimento(wb, cel({ theme: 8, tint: 0.5999938962981048 }));
  assert.strictEqual(I.nomeDaCor(tint).nome, 'Magenta', tint);
  assert.strictEqual(I.rgbDoPreenchimento(wb, cel({ indexed: 13 })), 'FFFF00');
  assert.strictEqual(I.rgbDoPreenchimento(wb, { s: { patternType: 'none' } }), null);
  assert.strictEqual(I.rgbDoPreenchimento(wb, { v: 'x' }), null);
  assert.strictEqual(I.rgbDoPreenchimento(wb, undefined), null);
});

teste('lerCoresToner: texto prevalece, pintura vira nome, sem preenchimento fica vazio', () => {
  const ws = XLSX.utils.aoa_to_sheet([['Quantidade', 'Modelo', 'Cor', 'IMPRESSORA', 'STATUS'], [1, 'T1', null, 'X', 'NOVO'], [1, 'T2', 'Preto fosco', 'X', 'NOVO'], [1, 'T3', null, 'X', 'NOVO']]);
  ws.C2 = { t: 'z', s: { patternType: 'solid', fgColor: { rgb: 'FF05F7E3' } } };
  ws.C3.s = { patternType: 'solid', fgColor: { rgb: 'FFFFFF00' } };
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Controle de toner');
  // Round-trip pelo xlsx para exercitar a leitura real de estilos (se o SheetJS gravar estilos);
  // a lógica de linha/texto é conferida de qualquer forma.
  const bin = XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true });
  const cores = I.lerCoresToner(bin);
  assert.deepStrictEqual(cores.map(c => [c.linha, c.modelo]), [[2, 'T1'], [3, 'T2'], [4, 'T3']]);
  assert.strictEqual(cores[1].cor, 'Preto fosco');
  assert.strictEqual(cores[1].fonte, 'texto');
  assert.strictEqual(cores[2].cor, null);
  assert.ok(cores[0].cor === null || cores[0].cor === 'Ciano', String(cores[0].cor));
  lanca(() => I.lerCoresToner(XLSX.write((() => { const w = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet([['a']]), 'Outra'); return w; })(), { bookType: 'xlsx', type: 'array' })), /toner/);
});

const planilha = process.argv[2] || path.join(raiz, 'Planilha Ativos e Passivos Estoque e Descartes.xlsx');
if (fs.existsSync(planilha)) {
  console.log('\nImportação da planilha real: ' + path.basename(planilha));
  const buf = fs.readFileSync(planilha);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const r = I.lerPlanilha(ab, path.basename(planilha));
  const vis = r.pendencias.filter(p => p.grupo !== 'oculto');
  console.log('    resumo:', JSON.stringify(r.resumo));
  for (const p of vis) console.log(`    [${p.grupo}] ${p.titulo}\n        ${p.detalhe}${p.valor ? '  → padrão: ' + p.valor : ''}`);

  teste('lê as 5 abas com as contagens esperadas', () => {
    assert.strictEqual(r.resumo.estoque, 48);
    assert.strictEqual(r.resumo.celulares, 3);
    assert.strictEqual(r.resumo.entregas, 63);
    assert.strictEqual(r.resumo.descartes, 98);
    assert.strictEqual(r.resumo.valorDescarte, 22390);
    assert.strictEqual(r.resumo.toners, 15);
  });

  teste('detecta os casos da análise', () => {
    const t = vis.map(p => p.titulo + ' ' + p.detalhe).join('\n');
    assert.ok(/R9WX3093QGT/.test(t), 'série duplicada R9WX3093QGT');
    assert.ok(/4K7BR14/.test(t), 'conflito 4K7BR14');
    assert.ok(/354468912242543/.test(t), 'tablet entregue 2x');
    assert.ok(/2L307V3/.test(t), 'notebook entregue 2x');
    assert.ok(/16\/06\/2016/.test(t), 'data de 2016');
    assert.ok(/MANUTENÇÃO/.test(t), 'status na descrição');
  });

  teste('toners importados com a cor lida do preenchimento', () => {
    console.log('      modelo → cor (linha, RGB):');
    for (const t of r.draft.toners) console.log(`        ${t.modelo} → ${t.cor || '(vazia)'}  (linha ${t.origem.linha}, ${t.origem.corRGB || 'sem preenchimento'})`);
    assert.strictEqual(r.draft.toners.length, 15);
    assert.ok(r.draft.toners.every(t => t.cor), 'todos os toners têm cor');
    const por = l => r.draft.toners.find(t => t.origem.linha === l).cor;
    assert.deepStrictEqual([17, 18, 19, 20].map(por), ['Amarelo', 'Ciano', 'Preto', 'Magenta']);
    assert.ok(r.draft.toners.filter(t => t.modelo === 'W9008-EVP').every(t => t.cor === 'Preto'));
    assert.ok(vis.some(p => /Cores dos toners lidas/.test(p.titulo)), 'relatório mostra as cores lidas');
  });

  teste('lerCoresToner na planilha real bate com a importação', () => {
    const cores = I.lerCoresToner(ab);
    for (const c of cores) console.log(`        linha ${c.linha}: ${c.modelo} → #${c.rgb} → ${c.cor}`);
    assert.strictEqual(cores.length, 15);
    assert.deepStrictEqual(cores.map(c => c.linha), Array.from({ length: 15 }, (_, i) => 17 + i));
    for (const c of cores) assert.strictEqual(c.cor, r.draft.toners.find(t => t.origem.linha === c.linha).cor);
    const cont = cores.reduce((m, c) => (m[c.cor] = (m[c.cor] || 0) + 1, m), {});
    assert.deepStrictEqual(cont, { Amarelo: 2, Ciano: 2, Preto: 9, Magenta: 2 });
  });

  teste('atualização só das cores: casa por origem.linha e não sobrescreve cor manual', () => {
    // Simula o banco já importado antes da correção (cores vazias) e a lógica do botão em Dados e backup.
    const db = L.novoBanco();
    db.toners = r.draft.toners.map(t => Object.assign({}, t, { cor: null, origem: Object.assign({}, t.origem) }));
    db.toners[0].cor = 'Manual';
    const porLinha = new Map(I.lerCoresToner(ab).map(c => [c.linha, c]));
    let n = 0;
    for (const t of db.toners) {
      const c = porLinha.get(t.origem.linha);
      if (!t.cor && c && c.cor) { assert.ok(L.editarToner(db, t.id, { cor: c.cor })); n++; }
    }
    assert.strictEqual(n, 14);
    assert.strictEqual(db.toners[0].cor, 'Manual');
    assert.ok(db.toners.every(t => t.cor));
    assert.strictEqual(db.movimentos.filter(m => m.tipo === 'EDICAO' && m.tonerId).length, 14);
  });

  teste('não aplica sem as decisões obrigatórias', () => {
    assert.ok(I.pendentes(r).length > 0);
    assert.throws(() => I.aplicar(r), /obrigatórias/);
  });

  teste('aplica decisões e o resultado é consistente', () => {
    for (const p of I.pendentes(r)) {
      if (p.tipoCampo === 'data') p.valor = hoje;
      else p.valor = p.opcoes.find(o => o.valor === 'baixar' || o.valor === 'primeiro' || o.valor === 'EM_ESTOQUE' || o.valor === 'importar').valor;
    }
    const db = I.aplicar(r);
    const probs = L.verificarConsistencia(db);
    assert.deepStrictEqual(probs, [], probs.map(p => p.msg).join('\n'));
    const nb = db.itens.find(i => i.serie === '4K7BR14');
    assert.strictEqual(nb.status, 'ENTREGUE');
    // Responsável = usuário da entrega registrada na planilha (sem nomes fixos no código).
    const entregaNb = db.movimentos.find(m => m.tipo === 'ENTREGA' && m.itemId === nb.id);
    assert.ok(nb.responsavelAtual && nb.responsavelAtual === entregaNb.usuario);
    const r9 = db.itens.filter(i => i.serie === 'R9WX3093QGT');
    assert.strictEqual(r9.length, 1);
    const tab = db.itens.find(i => i.serie === '354468912242543');
    assert.strictEqual(tab.status, 'ENTREGUE');
    const manut = db.itens.find(i => i.serie === '350290617919314');
    assert.strictEqual(manut.status, 'MANUTENCAO');
    assert.ok(!/manuten/i.test(manut.descricao));
    const k120 = db.itens.filter(i => i.descricao === 'Logitech K120');
    assert.strictEqual(k120.length, 1, 'linhas repetidas do K120 foram juntadas');
    assert.strictEqual(L.total(k120[0]), 13);
    assert.ok(db.movimentos.filter(m => m.tipo === 'ENTREGA' && m.itemId === k120[0].id).length >= 7, 'entregas de teclado vinculadas ao item');
    const unidades = db.itens.reduce((s, i) => s + L.total(i), 0);
    console.log(`      itens: ${db.itens.length}, unidades em estoque: ${unidades}, movimentos: ${db.movimentos.length}, toners: ${db.toners.length}`);
    // Exportação roda sem erro e mantém as abas
    const wb = E.montarPlanilha(db);
    assert.deepStrictEqual(wb.SheetNames, ['Estoque', 'Movimentações', 'Descarte', 'Toner', 'Lixeira', 'Pessoas']);
    const bin = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const volta = XLSX.read(bin, { type: 'array' });
    assert.strictEqual(XLSX.utils.sheet_to_json(volta.Sheets['Estoque']).length, db.itens.length);
    // Operação real após importação continua consistente
    const teclado = db.itens.find(i => i.categoria === 'Teclado Logitech' && i.saldo.MATRIZ >= 1);
    L.entregar(db, teclado.id, { usuario: 'Teste', local: 'MATRIZ', quantidade: 1, data: hoje });
    const devolvido = db.itens.find(i => i.serie === '2L307V3');
    L.devolver(db, devolvido.id, { local: 'MATRIZ', data: hoje, usuario: devolvido.responsavelAtual });
    assert.deepStrictEqual(L.verificarConsistencia(db), []);
  });
} else {
  console.log('\n(planilha não encontrada; testes de importação ignorados)');
}

console.log(`\n${ok} ok, ${falhas} falha(s)`);
process.exit(falhas ? 1 : 0);

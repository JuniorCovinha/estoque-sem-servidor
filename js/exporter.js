/* Exportação: planilha de backup (.xlsx), CSV do estoque e backup completo (.json). */
(function (App) {
  'use strict';
  const { fmtData, fmtDataHora, hojeISO } = App.util;
  const L = App.ledger;

  function linhasEstoque(db) {
    const cab = ['Categoria', 'Descrição', 'Controle', 'Nº de série', 'Patrimônio', 'Proprietário', 'Posição', 'Situação', 'Com (responsável)', 'Matriz', 'São Cristóvão', 'Total', 'Saldo mínimo', 'Observação', 'ID'];
    const itens = L.itensAtivos(db).slice().sort((a, b) => a.categoria.localeCompare(b.categoria, 'pt-BR') || a.descricao.localeCompare(b.descricao, 'pt-BR'));
    const pessoas = new Map(L.listaPessoas(db).map(p => [p.id, p]));
    return [cab].concat(itens.map(i => [
      i.categoria, i.descricao, i.controle === 'unidade' ? 'Unidade' : 'Quantidade', i.serie || '', i.patrimonio || '',
      i.proprietario || '', i.posicao || '', i.controle === 'unidade' ? L.STATUS[i.status] : (L.total(i) > 0 ? 'Em estoque' : 'Sem saldo'),
      L.nomeResponsavel(db, i, pessoas), i.saldo.MATRIZ, i.saldo.SAO_CRISTOVAO, L.total(i), i.saldoMinimo ?? '', i.obs || '', i.id,
    ]));
  }

  function efeito(m) {
    if (m.delta) return m.delta;
    return '';
  }

  function linhasMovimentos(db) {
    const cab = ['Data', 'Tipo', 'Categoria', 'Descrição', 'Nº de série', 'Local', 'Quantidade', 'Efeito no saldo', 'Usuário', 'Chamado', 'Observação', 'Registrado em', 'Registrado por', 'Origem', 'ID item'];
    const movs = db.movimentos.slice().sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')) || String(b.criadoEm).localeCompare(String(a.criadoEm)));
    return [cab].concat(movs.map(m => [
      fmtData(m.data), L.TIPOS[m.tipo] || m.tipo, m.item?.categoria || '', m.item?.descricao || '', m.item?.serie || '',
      m.local ? L.LOCAIS[m.local] : '', m.quantidade || '', efeito(m), m.usuario || '', m.chamado || '', m.obs || '',
      fmtDataHora(m.criadoEm), m.autor?.nome || '', m.importado ? `Planilha${m.origem ? ` (${m.origem.aba}, linha ${m.origem.linha})` : ''}` : 'Aplicação', m.itemId || '',
    ]));
  }

  function linhasDescarte(db) {
    const cab = ['Data', 'Item', 'Modelo', 'Nº de série', 'Qtd.', 'Ano de fabricação', 'Justificativa', 'Valor estimado (unit.)', 'Valor estimado (total)', 'Dados apagados', 'Método', 'Certificado', 'Observação'];
    const movs = db.movimentos.filter(m => m.tipo === 'DESCARTE');
    return [cab].concat(movs.map(m => {
      const d = m.descarte || {};
      const vu = d.valorUnit ?? '';
      return [fmtData(m.data), m.item?.categoria || '', m.item?.descricao || '', m.item?.serie || '', m.quantidade, d.anoFabricacao || '',
        d.justificativa || '', vu, vu === '' ? '' : vu * m.quantidade, L.DADOS_APAGADOS[d.dadosApagados] || '', d.metodo || '', d.certificado || '', m.obs || ''];
    }));
  }

  function linhasToner(db) {
    return [['Modelo', 'Cor', 'Impressora', 'Status', 'Observação']].concat(
      L.tonersAtivos(db).map(t => [t.modelo, t.cor || '', t.impressora || '', L.STATUS_TONER[t.status], t.obs || '']));
  }

  function linhasLixeira(db) {
    const cab = ['Tipo', 'Categoria / modelo', 'Descrição', 'Nº de série', 'Situação ao excluir', 'Excluído em', 'Motivo', 'ID'];
    const itens = db.itens.filter(i => i.excluido).map(i => ['Item', i.categoria, i.descricao, i.serie || '', i.excluido.situacao || '', fmtDataHora(i.excluido.em), i.excluido.motivo || '', i.id]);
    const toners = db.toners.filter(t => t.excluido).map(t => ['Toner', t.modelo, [t.cor, t.impressora].filter(Boolean).join(' · '), '', t.excluido.situacao || '', fmtDataHora(t.excluido.em), t.excluido.motivo || '', t.id]);
    return [cab].concat(itens, toners);
  }

  function linhasPessoas(db) {
    const cab = ['Nome', 'Tipo', 'Departamento', 'Unidade', 'E-mail', 'Situação', 'Itens com a pessoa', 'Origem', 'Observação', 'ID no diretório (Entra ID)', 'ID'];
    const pos = L.posicoesPessoas(db);
    const pecas = p => (pos.get(p.id) || []).reduce((s, x) => s + x.quantidade, 0);
    const lista = L.listaPessoas(db).slice().sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    return [cab].concat(lista.map(p => [
      p.nome, L.TIPOS_PESSOA[p.tipo] || p.tipo, p.departamento || '', p.unidade ? L.LOCAIS[p.unidade] : '', p.email || '',
      p.ativo ? 'Ativa' : 'Inativa', pecas(p), L.ORIGENS_PESSOA[p.origem] || p.origem || '', p.obs || '', p.entraId || '', p.id,
    ]));
  }

  // Inventário de uma pessoa: o que está com ela agora e o histórico de entregas/devoluções.
  function linhasItensPessoa(db, pessoaId) {
    const cab = ['Categoria', 'Descrição', 'Nº de série', 'Patrimônio', 'Controle', 'Quantidade', 'Com a pessoa desde', 'Posição', 'ID'];
    return [cab].concat(L.itensComPessoa(db, pessoaId).map(x => [
      x.item.categoria, x.item.descricao, x.item.serie || '', x.item.patrimonio || '', x.controle === 'unidade' ? 'Unidade' : 'Quantidade',
      x.quantidade, x.desde ? fmtData(x.desde) : '', x.item.posicao || '', x.item.id,
    ]));
  }

  function linhasHistoricoPessoa(db, pessoaId) {
    const cab = ['Data', 'Tipo', 'Categoria', 'Descrição', 'Nº de série', 'Quantidade', 'Chamado', 'Observação'];
    return [cab].concat(L.historicoPessoa(db, pessoaId).map(m => [
      fmtData(m.data), L.TIPOS[m.tipo] || m.tipo, m.item?.categoria || '', m.item?.descricao || '', m.item?.serie || '', m.quantidade || '', m.chamado || '', m.obs || '',
    ]));
  }

  function folha(aoa, larguras) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = (larguras || aoa[0].map(() => 16)).map(w => ({ wch: w }));
    if (aoa.length > 1) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } }) };
    return ws;
  }

  function montarPlanilha(db) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, folha(linhasEstoque(db), [22, 30, 11, 24, 12, 16, 9, 12, 26, 8, 13, 7, 12, 30, 38]), 'Estoque');
    XLSX.utils.book_append_sheet(wb, folha(linhasMovimentos(db), [11, 20, 22, 30, 22, 13, 10, 13, 28, 15, 40, 16, 22, 30, 38]), 'Movimentações');
    XLSX.utils.book_append_sheet(wb, folha(linhasDescarte(db), [11, 20, 28, 20, 6, 10, 36, 12, 12, 14, 16, 16, 30]), 'Descarte');
    XLSX.utils.book_append_sheet(wb, folha(linhasToner(db), [16, 10, 18, 10, 30]), 'Toner');
    XLSX.utils.book_append_sheet(wb, folha(linhasLixeira(db), [8, 22, 30, 22, 18, 16, 30, 38]), 'Lixeira');
    XLSX.utils.book_append_sheet(wb, folha(linhasPessoas(db), [28, 8, 20, 13, 30, 9, 10, 18, 30, 26, 38]), 'Pessoas');
    wb.Props = { Title: 'Backup do estoque de TI', Author: 'Estoque Infra (aplicação local)', CreatedDate: new Date() };
    return wb;
  }

  function planilhaBinaria(db) {
    return XLSX.write(montarPlanilha(db), { bookType: 'xlsx', type: 'array', compression: true });
  }

  function montarPlanilhaPessoa(db, pessoaId) {
    const p = L.getPessoa(db, pessoaId);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, folha(linhasItensPessoa(db, pessoaId), [22, 30, 24, 12, 11, 10, 16, 12, 38]), 'Itens com a pessoa');
    XLSX.utils.book_append_sheet(wb, folha(linhasHistoricoPessoa(db, pessoaId), [11, 12, 22, 30, 22, 10, 15, 40]), 'Histórico');
    wb.Props = { Title: 'Itens com ' + p.nome, Author: 'Estoque Infra (aplicação local)', CreatedDate: new Date() };
    return wb;
  }

  function baixar(blob, nome) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nome;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function baixarPlanilha(db) {
    baixar(new Blob([planilhaBinaria(db)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `estoque-backup-${hojeISO()}.xlsx`);
  }

  function baixarItensPessoa(db, pessoaId) {
    const p = L.getPessoa(db, pessoaId);
    const slug = App.util.chave(p.nome).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pessoa';
    const bin = XLSX.write(montarPlanilhaPessoa(db, pessoaId), { bookType: 'xlsx', type: 'array', compression: true });
    baixar(new Blob([bin], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `itens-${slug}-${hojeISO()}.xlsx`);
  }

  // Proteção contra injeção de fórmula em CSV (CWE-1236). "-" sozinho (marcador de vazio) é preservado.
  function celulaSeguraCSV(v) {
    if (typeof v !== 'string' || !v) return v;
    if (/^[=+@\t\r]/.test(v) || (/^-/.test(v) && v.length > 1 && !/^-\d+([.,]\d+)?$/.test(v))) return "'" + v;
    return v;
  }

  function baixarCSVEstoque(db) {
    const aoa = linhasEstoque(db).map(l => l.map(celulaSeguraCSV));
    const csv = XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(aoa), { FS: ';', RS: '\r\n' });
    baixar(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `estoque-${hojeISO()}.csv`);
  }

  function baixarJSON(db, prefixo) {
    baixar(new Blob([JSON.stringify(db, null, 1)], { type: 'application/json' }), `${prefixo || 'estoque-backup'}-${hojeISO()}.json`);
  }

  App.exporter = { montarPlanilha, planilhaBinaria, baixarPlanilha, baixarCSVEstoque, baixarJSON, celulaSeguraCSV, linhasEstoque, linhasMovimentos, linhasDescarte,
    linhasPessoas, linhasItensPessoa, linhasHistoricoPessoa, montarPlanilhaPessoa, baixarItensPessoa };
})(globalThis.App = globalThis.App || {});

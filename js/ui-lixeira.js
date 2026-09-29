/* Lixeira: itens e toners excluídos, para consultar e restaurar. Nada é apagado de verdade. */
(function (App) {
  'use strict';
  const { h, clear, preencher, debounce, fmtDataHora } = App.util;
  const L = App.ledger;
  const UI = App.ui;

  const st = UI.prefs('lixeira', { tipo: '' });
  st.busca = '';
  let raiz, corpo, cartoes;

  function montar(el) {
    raiz = el; clear(raiz);
    const input = h('input', { type: 'search', placeholder: 'Buscar por item, modelo, série ou situação…  ( / )', 'aria-label': 'Buscar na Lixeira',
      oninput: debounce(() => { st.busca = input.value; atualizar(); }, 80) });
    montar.busca = input;
    cartoes = h('div', { class: 'cartoes' });
    corpo = h('tbody');
    raiz.append(
      cartoes,
      h('div', { class: 'barra' },
        h('div', { class: 'busca' }, input),
        UI.select([{ valor: '', rotulo: 'Itens e toners' }, { valor: 'item', rotulo: 'Só itens' }, { valor: 'toner', rotulo: 'Só toners' }], st.tipo, v => { st.tipo = v; st.salvar(); atualizar(); }, 'Tipo')),
      h('p', { class: 'resumo' }, 'Itens excluídos saem das listas e dos totais, mas continuam guardados aqui com todo o histórico. Restaurar devolve o item exatamente como estava.'),
      h('div', { class: 'tabela-wrap' }, h('table', { class: 'tab' },
        h('thead', null, h('tr', null, ['Tipo', 'Categoria / modelo', 'Descrição', 'Nº de série', 'Situação ao excluir', 'Excluído em', ''].map(t => h('th', null, t)))),
        corpo)));
    atualizar();
  }

  function registros(db) {
    const itens = db.itens.filter(i => i.excluido).map(i => ({
      tipo: 'item', id: i.id, rotuloTipo: 'Item', nome: i.categoria, descricao: i.descricao, serie: i.serie,
      situacao: i.excluido.situacao || '', em: i.excluido.em, motivo: i.excluido.motivo,
    }));
    const toners = db.toners.filter(t => t.excluido).map(t => ({
      tipo: 'toner', id: t.id, rotuloTipo: 'Toner', nome: t.modelo, descricao: [t.cor, t.impressora].filter(Boolean).join(' · '), serie: null,
      situacao: t.excluido.situacao || '', em: t.excluido.em, motivo: t.excluido.motivo,
    }));
    return itens.concat(toners);
  }

  function atualizar() {
    const db = App.store.db;
    if (!corpo || !db) return;
    const todos = registros(db);
    preencher(cartoes,
      h('div', { class: 'cartao' }, h('div', { class: 'rotulo' }, 'Itens na Lixeira'), h('div', { class: 'valor' }, todos.filter(r => r.tipo === 'item').length)),
      h('div', { class: 'cartao' }, h('div', { class: 'rotulo' }, 'Toners na Lixeira'), h('div', { class: 'valor' }, todos.filter(r => r.tipo === 'toner').length)));

    const busca = UI.filtroTexto(st.busca);
    const lista = todos.filter(r => (!st.tipo || r.tipo === st.tipo) && busca([r.nome, r.descricao, r.serie, r.situacao, r.motivo, r.rotuloTipo]))
      .sort((a, b) => String(b.em).localeCompare(String(a.em)));

    clear(corpo);
    if (!lista.length) {
      corpo.appendChild(h('tr', null, h('td', { colspan: 7, class: 'vazio' }, todos.length ? 'Nada encontrado com esses filtros.' : 'A Lixeira está vazia.')));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const r of lista) {
      frag.appendChild(h('tr', null,
        h('td', null, h('span', { class: 'badge neutro' }, r.rotuloTipo)),
        h('td', null, r.nome),
        h('td', { class: 'quebra' }, r.descricao || '—'),
        h('td', { class: 'mono' }, r.serie || '—'),
        h('td', null, r.situacao || '—'),
        h('td', { class: 'fraco' }, fmtDataHora(r.em)),
        h('td', { class: 'acoes' },
          h('button', { type: 'button', class: 'btn pequeno', onclick: () => App.acoes.confirmarRestauracao(r.tipo, r.id) }, 'Restaurar'),
          r.tipo === 'item' ? h('button', { type: 'button', class: 'btn pequeno fantasma', onclick: () => App.acoes.abrirHistorico(r.id) }, 'Histórico') : null)));
    }
    corpo.appendChild(frag);
  }

  App.views = App.views || {};
  App.views.lixeira = { montar, atualizar, focarBusca: () => montar.busca && montar.busca.focus() };
})(globalThis.App = globalThis.App || {});

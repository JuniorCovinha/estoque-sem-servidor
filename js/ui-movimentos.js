/* Histórico completo de movimentações (substitui a aba Disponibilização). */
(function (App) {
  'use strict';
  const { h, clear, preencher, debounce, fmtData, fmtDataHora } = App.util;
  const L = App.ledger;
  const UI = App.ui;

  const st = UI.prefs('movimentos', { tipo: '', de: '', ate: '', origem: '' });
  st.busca = '';
  const LIMITE = 1000;

  let raiz, corpo, resumoEl;

  function montar(el) {
    raiz = el; clear(raiz);
    const input = h('input', { type: 'search', placeholder: 'Buscar por item, série, usuário, chamado ou observação…  ( / )', 'aria-label': 'Buscar movimentações',
      oninput: debounce(() => { st.busca = input.value; atualizar(); }, 80) });
    montar.busca = input;
    const data = (campo, rotulo) => h('input', { type: 'date', value: st[campo], 'aria-label': rotulo, title: rotulo, onchange: e => { st[campo] = e.target.value; st.salvar(); atualizar(); } });
    raiz.appendChild(h('div', { class: 'barra' },
      h('div', { class: 'busca' }, input),
      UI.select([{ valor: '', rotulo: 'Todos os tipos' }].concat(Object.entries(L.TIPOS).map(([valor, rotulo]) => ({ valor, rotulo }))), st.tipo, v => { st.tipo = v; st.salvar(); atualizar(); }, 'Tipo'),
      UI.select([{ valor: '', rotulo: 'Planilha e aplicação' }, { valor: 'app', rotulo: 'Só aplicação' }, { valor: 'planilha', rotulo: 'Só importados da planilha' }], st.origem, v => { st.origem = v; st.salvar(); atualizar(); }, 'Origem'),
      h('span', { class: 'fraco' }, 'de'), data('de', 'Data inicial'), h('span', { class: 'fraco' }, 'até'), data('ate', 'Data final'),
      h('div', { class: 'espaco' }),
      h('button', { class: 'btn', type: 'button', onclick: () => App.acoes.abrirDevolucao() }, 'Devolução'),
      h('button', { class: 'btn primario', type: 'button', onclick: () => App.acoes.abrirEntrega() }, 'Nova entrega')));
    resumoEl = h('div', { class: 'resumo' });
    corpo = h('tbody');
    raiz.append(resumoEl, h('div', { class: 'tabela-wrap' }, h('table', { class: 'tab' },
      h('thead', null, h('tr', null, ['Data', 'Tipo', 'Item', 'Nº de série', 'Local', 'Qtd.', 'Usuário', 'Chamado', 'Observação', 'Registrado em']
        .map(t => h('th', { class: t === 'Qtd.' ? 'num' : null }, t)))),
      corpo)));
    atualizar();
  }

  function atualizar() {
    const db = App.store.db;
    if (!corpo || !db) return;
    const busca = UI.filtroTexto(st.busca);
    const lista = db.movimentos.filter(m =>
      (!st.tipo || m.tipo === st.tipo) &&
      (!st.origem || (st.origem === 'app' ? !m.importado : m.importado)) &&
      (!st.de || (m.data && m.data >= st.de)) && (!st.ate || (m.data && m.data <= st.ate)) &&
      busca([m.item?.categoria, m.item?.descricao, m.item?.serie, m.usuario, m.chamado, m.obs, L.TIPOS[m.tipo]]))
      .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')) || String(b.criadoEm).localeCompare(String(a.criadoEm)));

    const entregas = lista.filter(m => m.tipo === 'ENTREGA').reduce((s, m) => s + (m.quantidade || 0), 0);
    preencher(resumoEl, 
      h('span', null, h('strong', null, lista.length), ' movimentações'),
      h('span', null, h('strong', null, entregas), ' unidades entregues no filtro'),
      lista.length > LIMITE ? h('span', null, `Mostrando as ${LIMITE} mais recentes — refine a busca.`) : '');

    clear(corpo);
    if (!lista.length) { corpo.appendChild(h('tr', null, h('td', { colspan: 10, class: 'vazio' }, 'Nenhuma movimentação encontrada.'))); return; }
    const frag = document.createDocumentFragment();
    for (const m of lista.slice(0, LIMITE)) {
      const sinal = m.delta > 0 ? '+' : '';
      const qtd = m.delta ? sinal + m.delta : (m.quantidade || '—');
      frag.appendChild(h('tr', null,
        h('td', null, fmtData(m.data)),
        h('td', null, L.TIPOS[m.tipo] || m.tipo, m.importado ? h('span', { class: 'tag', title: m.origem ? `${m.origem.aba}, linha ${m.origem.linha}` : 'Importado' }, 'planilha') : null),
        h('td', { class: 'quebra' },
          m.itemId ? h('a', { href: '#', onclick: e => { e.preventDefault(); App.acoes.abrirHistorico(m.itemId); } }, `${m.item?.categoria || ''} — ${m.item?.descricao || ''}`)
            : `${m.item?.categoria || ''} — ${m.item?.descricao || ''}`),
        h('td', { class: 'mono' }, m.item?.serie || '—'),
        h('td', null, m.local ? L.LOCAIS[m.local] : '—'),
        h('td', { class: 'num ' + (m.delta > 0 ? 'delta-pos' : m.delta < 0 ? 'delta-neg' : '') }, qtd),
        h('td', null, m.usuario || '—'),
        h('td', { class: 'mono' }, m.chamado || '—'),
        h('td', { class: 'quebra' }, m.obs || ''),
        h('td', { class: 'fraco' }, fmtDataHora(m.criadoEm))));
    }
    corpo.appendChild(frag);
  }

  App.views = App.views || {};
  App.views.movimentos = { montar, atualizar, focarBusca: () => montar.busca && montar.busca.focus() };
})(globalThis.App = globalThis.App || {});

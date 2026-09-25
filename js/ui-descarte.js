/* Lista de descarte (lixo eletrônico), com valor total calculado e controle de sanitização de dados. */
(function (App) {
  'use strict';
  const { h, clear, preencher, debounce, fmtData, fmtMoeda } = App.util;
  const L = App.ledger;
  const UI = App.ui;

  const st = UI.prefs('descarte', { pendentesDados: false });
  st.busca = '';
  let raiz, corpo, cartoes, sel;

  function montar(el) {
    raiz = el; clear(raiz);
    const input = h('input', { type: 'search', placeholder: 'Buscar por item, modelo, série, justificativa…  ( / )', 'aria-label': 'Buscar descartes',
      oninput: debounce(() => { st.busca = input.value; atualizar(); }, 80) });
    montar.busca = input;
    const chk = h('input', { type: 'checkbox', checked: st.pendentesDados, onchange: e => { st.pendentesDados = e.target.checked; st.salvar(); atualizar(); } });
    cartoes = h('div', { class: 'cartoes' });
    corpo = h('tbody');
    sel = UI.selecao({ corpo, aoEditar: (ids, fora) => App.acoes.abrirEditarDescartesLote(ids, { fora, aoConcluir: () => sel.limpar() }) });
    raiz.append(
      cartoes,
      h('div', { class: 'barra' },
        h('div', { class: 'busca' }, input),
        h('label', { class: 'check', style: 'display:flex;gap:6px;align-items:center' }, chk, 'Só equipamentos sem confirmação de dados apagados'),
        h('div', { class: 'espaco' }),
        h('button', { class: 'btn primario', type: 'button', onclick: () => App.acoes.abrirDescarte() }, 'Registrar descarte')),
      sel.barra,
      h('div', { class: 'tabela-wrap' }, h('table', { class: 'tab' },
        h('thead', null, h('tr', null, sel.th(), ['Data', 'Item', 'Modelo', 'Nº de série', 'Qtd.', 'Ano', 'Justificativa', 'Valor unit.', 'Valor total', 'Dados apagados', 'Certificado', '']
          .map(t => h('th', { class: ['Qtd.', 'Valor unit.', 'Valor total', 'Ano'].includes(t) ? 'num' : null }, t)))),
        corpo)));
    atualizar();
  }

  const semConfirmacao = m => L.guardaDados(m.item?.categoria || '') && !['SIM', 'NAO_SE_APLICA'].includes(m.descarte?.dadosApagados);

  function atualizar() {
    const db = App.store.db;
    if (!corpo || !db) return;
    const todos = db.movimentos.filter(m => m.tipo === 'DESCARTE');
    const busca = UI.filtroTexto(st.busca);
    const lista = todos.filter(m => (!st.pendentesDados || semConfirmacao(m)) &&
      busca([m.item?.categoria, m.item?.descricao, m.item?.serie, m.descarte?.justificativa, m.descarte?.certificado, m.obs]))
      .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')) || String(a.criadoEm).localeCompare(String(b.criadoEm)));
    const valorDe = m => (m.descarte?.valorUnit || 0) * (m.quantidade || 0);
    const soma = arr => arr.reduce((s, m) => s + valorDe(m), 0);
    const pend = todos.filter(semConfirmacao).length;

    preencher(cartoes, 
      h('div', { class: 'cartao' }, h('div', { class: 'rotulo' }, 'Registros'), h('div', { class: 'valor' }, todos.length)),
      h('div', { class: 'cartao' }, h('div', { class: 'rotulo' }, 'Unidades'), h('div', { class: 'valor' }, todos.reduce((s, m) => s + (m.quantidade || 0), 0))),
      h('div', { class: 'cartao' }, h('div', { class: 'rotulo' }, 'Valor estimado total'), h('div', { class: 'valor' }, fmtMoeda(soma(todos)))),
      h('div', { class: 'cartao' }, h('div', { class: 'rotulo' }, 'Sem confirmação de dados apagados'), h('div', { class: 'valor', style: pend ? 'color:var(--warn)' : null }, pend)),
      lista.length !== todos.length ? h('div', { class: 'cartao' }, h('div', { class: 'rotulo' }, 'Valor no filtro'), h('div', { class: 'valor' }, fmtMoeda(soma(lista)))) : null);

    sel.exibidos(lista.map(m => m.id), new Set(todos.map(m => m.id)));
    clear(corpo);
    if (!lista.length) { corpo.appendChild(h('tr', null, h('td', { colspan: 13, class: 'vazio' }, 'Nenhum descarte encontrado.'))); sel.refletir(); return; }
    const frag = document.createDocumentFragment();
    for (const m of lista) {
      const d = m.descarte || {};
      const alerta = semConfirmacao(m);
      frag.appendChild(h('tr', null,
        sel.td(m.id, `${m.item?.categoria || ''} — ${m.item?.descricao || ''}${m.item?.serie ? ' · ' + m.item.serie : ''}`),
        h('td', null, fmtData(m.data), m.importado ? h('span', { class: 'tag', title: m.origem ? `${m.origem.aba}, linha ${m.origem.linha}` : '' }, 'planilha') : null),
        h('td', null, m.item?.categoria || ''),
        h('td', { class: 'quebra' }, m.item?.descricao || ''),
        h('td', { class: 'mono' }, m.item?.serie || '—'),
        h('td', { class: 'num' }, m.quantidade),
        h('td', { class: 'num' }, d.anoFabricacao || '—'),
        h('td', { class: 'quebra' }, d.justificativa || ''),
        h('td', { class: 'num' }, fmtMoeda(d.valorUnit)),
        h('td', { class: 'num' }, d.valorUnit === null || d.valorUnit === undefined ? '—' : fmtMoeda(valorDe(m))),
        h('td', null, h('span', { class: 'badge ' + (d.dadosApagados === 'SIM' ? 'ok' : alerta ? 'warn' : 'neutro'), title: d.metodo || null }, L.DADOS_APAGADOS[d.dadosApagados] || '—')),
        h('td', { class: 'curto', title: d.certificado || null }, d.certificado || '—'),
        h('td', { class: 'acoes' }, h('button', { type: 'button', class: 'btn pequeno', onclick: () => App.acoes.abrirEditarDescarte(m.id) }, 'Editar'))));
    }
    corpo.appendChild(frag);
    sel.refletir();
  }

  App.views = App.views || {};
  App.views.descarte = { montar, atualizar, focarBusca: () => montar.busca && montar.busca.focus() };
})(globalThis.App = globalThis.App || {});

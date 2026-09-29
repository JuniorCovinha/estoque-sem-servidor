/* Controle de toner: só os NOVOS contam como estoque; "Em uso" e "Descarte" aparecem separados. */
(function (App) {
  'use strict';
  const { h, clear, preencher, debounce } = App.util;
  const L = App.ledger;
  const UI = App.ui;

  const st = UI.prefs('toner', { status: '' });
  st.busca = '';
  let raiz, corpo, cartoes;

  function montar(el) {
    raiz = el; clear(raiz);
    const input = h('input', { type: 'search', placeholder: 'Buscar por modelo, cor ou impressora…  ( / )', 'aria-label': 'Buscar toners',
      oninput: debounce(() => { st.busca = input.value; atualizar(); }, 80) });
    montar.busca = input;
    cartoes = h('div', { class: 'cartoes' });
    corpo = h('tbody');
    raiz.append(
      cartoes,
      h('div', { class: 'barra' },
        h('div', { class: 'busca' }, input),
        UI.select([{ valor: '', rotulo: 'Todos os status' }].concat(Object.entries(L.STATUS_TONER).map(([valor, rotulo]) => ({ valor, rotulo }))), st.status, v => { st.status = v; st.salvar(); atualizar(); }, 'Status'),
        h('div', { class: 'espaco' }),
        h('button', { class: 'btn primario', type: 'button', onclick: () => App.acoes.abrirNovoToner() }, '+ Adicionar toner')),
      h('div', { class: 'tabela-wrap' }, h('table', { class: 'tab' },
        h('thead', null, h('tr', null, ['Modelo', 'Cor', 'Impressora', 'Status', ''].map(t => h('th', null, t)))),
        corpo)));
    atualizar();
  }

  function atualizar() {
    const db = App.store.db;
    if (!corpo || !db) return;
    const ativos = L.tonersAtivos(db);
    const conta = s => ativos.filter(t => t.status === s).length;

    // Estoque de novos por modelo, para saber o que tem para trocar.
    const porModelo = new Map();
    for (const t of ativos) if (t.status === 'NOVO') porModelo.set(t.modelo, (porModelo.get(t.modelo) || 0) + 1);

    preencher(cartoes, 
      h('div', { class: 'cartao' }, h('div', { class: 'rotulo' }, 'Em estoque (novos)'), h('div', { class: 'valor' }, conta('NOVO'))),
      h('div', { class: 'cartao' }, h('div', { class: 'rotulo' }, 'Em uso'), h('div', { class: 'valor' }, conta('EM_USO'))),
      h('div', { class: 'cartao' }, h('div', { class: 'rotulo' }, 'Para descarte'), h('div', { class: 'valor' }, conta('DESCARTE'))),
      porModelo.size ? h('div', { class: 'cartao' }, h('div', { class: 'rotulo' }, 'Novos por modelo'),
        h('div', { style: 'font-size:13px;margin-top:4px' }, [...porModelo].map(([m, n]) => h('div', null, h('b', null, n), ' × ' + m)))) : null);

    const busca = UI.filtroTexto(st.busca);
    const ordem = { NOVO: 0, EM_USO: 1, DESCARTE: 2 };
    const lista = ativos.filter(t => (!st.status || t.status === st.status) && busca([t.modelo, t.cor, t.impressora, t.obs]))
      .sort((a, b) => ordem[a.status] - ordem[b.status] || UI.comparar(a.modelo, b.modelo));

    clear(corpo);
    if (!lista.length) { corpo.appendChild(h('tr', null, h('td', { colspan: 5, class: 'vazio' }, 'Nenhum toner encontrado.'))); return; }
    const frag = document.createDocumentFragment();
    for (const t of lista) {
      const sel = UI.select(Object.entries(L.STATUS_TONER).map(([valor, rotulo]) => ({ valor, rotulo })), t.status, async v => {
        try { await App.acao(d => L.mudarStatusToner(d, t.id, v), `Toner ${t.modelo}: ${L.STATUS_TONER[v]}.`); }
        catch (e) { UI.toast(e.message, 'erro'); atualizar(); }
      }, 'Status do toner ' + t.modelo);
      frag.appendChild(h('tr', null,
        h('td', { class: 'mono' }, t.modelo),
        h('td', null, bolinhaCor(t.cor), t.cor || '—'),
        h('td', null, t.impressora || '—'),
        h('td', null, sel),
        h('td', { class: 'acoes' },
          h('button', { type: 'button', class: 'btn pequeno', onclick: () => App.acoes.abrirEditarToner(t.id) }, 'Editar'),
          h('button', { type: 'button', class: 'btn pequeno fantasma icone', 'aria-label': 'Mais ações', title: 'Mais ações', onclick: e => UI.menu(e.currentTarget, App.acoes.acoesDoToner(t).filter(a => a !== '-' && a.rotulo !== 'Editar')) }, '⋯'))));
    }
    corpo.appendChild(frag);
  }

  // Amostra de cor ao lado do nome (só para nomes conhecidos; texto livre fica sem bolinha).
  const AMOSTRAS = {
    preto: '#1a1a1a', ciano: '#00aeef', magenta: '#ec008c', amarelo: '#ffe600',
    azul: '#1f5fd1', vermelho: '#d62828', verde: '#2e9e44', laranja: '#f28c28', roxo: '#7b3fb5', rosa: '#f06fa8', cinza: '#8c8c8c', branco: '#ffffff',
  };
  function bolinhaCor(cor) {
    const fundo = AMOSTRAS[App.util.chave(cor)];
    if (!fundo) return null;
    return h('span', { 'aria-hidden': 'true', style: `display:inline-block;width:10px;height:10px;border-radius:50%;background:${fundo};border:1px solid rgba(127,127,127,.6);margin-right:6px;vertical-align:-1px` });
  }

  App.views = App.views || {};
  App.views.toner = { montar, atualizar, focarBusca: () => montar.busca && montar.busca.focus() };
})(globalThis.App = globalThis.App || {});

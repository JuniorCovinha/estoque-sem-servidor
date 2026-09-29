/* Tela principal: lista de itens com busca, filtros, ordenação, edição direta e ações por linha. */
(function (App) {
  'use strict';
  const { h, clear, preencher, debounce } = App.util;
  const L = App.ledger;
  const UI = App.ui;

  const st = UI.prefs('estoque', { busca: '', situacao: 'estoque', categoria: '', local: '', posicao: '', ord: 'categoria', dir: 1 });
  st.busca = ''; // a busca não é lembrada entre sessões

  const SITUACOES = [
    { valor: 'estoque', rotulo: 'Em estoque' },
    { valor: 'manutencao', rotulo: 'Em manutenção' },
    { valor: 'entregue', rotulo: 'Entregues' },
    { valor: 'semsaldo', rotulo: 'Sem saldo' },
    { valor: 'descartado', rotulo: 'Descartados' },
    { valor: 'todos', rotulo: 'Todas as situações' },
  ];
  const filtroSituacao = {
    estoque: i => i.controle === 'unidade' ? (i.status === 'EM_ESTOQUE' || i.status === 'MANUTENCAO') : L.total(i) > 0,
    manutencao: i => i.status === 'MANUTENCAO',
    entregue: i => i.controle === 'unidade' && i.status === 'ENTREGUE',
    semsaldo: i => i.controle === 'quantidade' && L.total(i) === 0,
    descartado: i => i.controle === 'unidade' && i.status === 'DESCARTADO',
    todos: () => true,
  };

  const EDITAVEIS = ['categoria', 'descricao', 'serie', 'patrimonio', 'posicao'];

  const COLS = [
    { chave: 'categoria', rotulo: 'Categoria', val: i => i.categoria },
    { chave: 'descricao', rotulo: 'Descrição', val: i => i.descricao },
    { chave: 'serie', rotulo: 'Nº de série', val: i => i.serie || '' },
    { chave: 'patrimonio', rotulo: 'Patrimônio', val: i => i.patrimonio || '' },
    { chave: 'posicao', rotulo: 'Posição', val: i => i.posicao || '' },
    { chave: 'situacao', rotulo: 'Situação', val: i => App.uiSituacao(i).txt },
    { chave: 'com', rotulo: 'Com', val: i => i.responsavelAtual || '' },
    { chave: 'matriz', rotulo: 'Matriz', classe: 'num', val: i => i.saldo.MATRIZ },
    { chave: 'sc', rotulo: 'S. Cristóvão', classe: 'num', val: i => i.saldo.SAO_CRISTOVAO },
    { chave: 'total', rotulo: 'Total', classe: 'num', val: i => L.total(i) },
    { rotulo: '', classe: 'acoes' },
  ];

  let raiz, corpo, resumoEl, selCategoria, selPosicao, inputBusca, sel, visiveis = [];

  function montar(el) {
    raiz = el;
    clear(raiz);
    const db = App.store.db;
    if (!db || !L.itensAtivos(db).length) return montarVazio();

    inputBusca = h('input', {
      type: 'search', placeholder: 'Buscar por item, modelo, série, patrimônio, posição ou pessoa…  ( / )', value: st.busca,
      'aria-label': 'Buscar itens',
      oninput: debounce(() => { st.busca = inputBusca.value; atualizar(); }, 80),
      onkeydown: e => {
        if (e.key === 'Enter' && visiveis.length === 1) {
          // Leitura de série + Enter abre a ação principal do item encontrado.
          e.preventDefault();
          const p = App.acoes.acoesDoItem(visiveis[0]).find(a => a.primaria);
          if (p) p.fn();
        }
        if (e.key === 'Escape') { inputBusca.value = ''; st.busca = ''; atualizar(); }
      },
    });
    selCategoria = UI.select([], st.categoria, v => { st.categoria = v; st.salvar(); atualizar(); }, 'Categoria');
    selPosicao = UI.select([], st.posicao, v => { st.posicao = v; st.salvar(); atualizar(); }, 'Posição');

    raiz.appendChild(h('div', { class: 'barra' },
      h('div', { class: 'busca' }, inputBusca),
      UI.select(SITUACOES, st.situacao, v => { st.situacao = v; st.salvar(); atualizar(); }, 'Situação'),
      selCategoria,
      UI.select([{ valor: '', rotulo: 'Todos os locais' }].concat(Object.entries(L.LOCAIS).map(([valor, rotulo]) => ({ valor, rotulo }))), st.local, v => { st.local = v; st.salvar(); atualizar(); }, 'Local'),
      selPosicao,
      h('div', { class: 'espaco' }),
      h('button', { class: 'btn', type: 'button', onclick: () => App.acoes.abrirNovoItem() }, '+ Novo item'),
      h('button', { class: 'btn', type: 'button', onclick: () => App.acoes.abrirDevolucao() }, 'Devolução'),
      h('button', { class: 'btn primario', type: 'button', onclick: () => App.acoes.abrirEntrega() }, 'Nova entrega')));

    resumoEl = h('div', { class: 'resumo' });
    raiz.appendChild(resumoEl);
    corpo = h('tbody');
    sel = UI.selecao({ corpo, aoEditar: (ids, fora) => App.acoes.abrirEditarItensLote(ids, { fora, aoConcluir: () => sel.limpar() }) });
    raiz.appendChild(sel.barra);
    const thead = h('thead');
    raiz.appendChild(h('div', { class: 'tabela-wrap' }, h('table', { class: 'tab' }, thead, corpo)));
    montar.thead = thead;
    atualizar();
  }

  function montarVazio() {
    raiz.appendChild(h('div', { class: 'vazio' },
      h('img', { class: 'grafismo', src: 'img/grafismo-orbital.png', alt: '', width: 2245, height: 1587 }),
      h('h2', null, 'Nenhum item cadastrado ainda'),
      h('p', null, 'Comece importando a planilha atual. Depois, escolha a pasta onde o arquivo de dados (estoque.json) será salvo.'),
      h('div', { class: 'acoes-vazio' },
        h('a', { class: 'btn primario', href: '#dados' }, 'Importar planilha atual'),
        h('button', { class: 'btn', type: 'button', onclick: () => App.acoes.abrirNovoItem() }, 'Cadastrar item manualmente'))));
  }

  function opcoesSelect(sel, lista, rotuloTodos, valor) {
    clear(sel);
    sel.appendChild(h('option', { value: '' }, rotuloTodos));
    for (const v of lista) sel.appendChild(h('option', { value: v }, v));
    sel.value = lista.includes(valor) ? valor : '';
    return sel.value;
  }

  function atualizar() {
    const db = App.store.db;
    if (!db || !L.itensAtivos(db).length || !corpo) return montar(raiz);
    st.categoria = opcoesSelect(selCategoria, L.listas.categorias(db), 'Todas as categorias', st.categoria);
    st.posicao = opcoesSelect(selPosicao, L.listas.posicoes(db), 'Todas as posições', st.posicao);

    const busca = UI.filtroTexto(st.busca);
    const fSit = filtroSituacao[st.situacao] || filtroSituacao.estoque;
    visiveis = L.itensAtivos(db).filter(i =>
      fSit(i) &&
      (!st.categoria || i.categoria === st.categoria) &&
      (!st.posicao || i.posicao === st.posicao) &&
      (!st.local || (i.controle === 'unidade' ? i.local === st.local : i.saldo[st.local] > 0)) &&
      busca([i.categoria, i.descricao, i.serie, i.patrimonio, i.posicao, i.responsavelAtual, i.obs, i.proprietario]));

    const col = COLS.find(c => c.chave === st.ord) || COLS[0];
    visiveis.sort((a, b) => UI.comparar(col.val(a), col.val(b)) * st.dir || UI.comparar(a.descricao, b.descricao));

    const cab = UI.cabecalhoOrdenavel(COLS, st, chaveCol => {
      st.dir = st.ord === chaveCol ? -st.dir : 1; st.ord = chaveCol; st.salvar(); atualizar();
    });
    cab.prepend(sel.th());
    clear(montar.thead).appendChild(cab);
    sel.exibidos(visiveis.map(i => i.id), new Set(L.itensAtivos(db).map(i => i.id)));

    const unidades = visiveis.reduce((s, i) => s + L.total(i), 0);
    const manut = visiveis.filter(i => i.status === 'MANUTENCAO').length;
    preencher(resumoEl, 
      h('span', null, h('strong', null, visiveis.length), ` ${visiveis.length === 1 ? 'item' : 'itens'} exibidos`),
      h('span', null, h('strong', null, unidades), ' unidades em estoque'),
      manut ? h('span', null, h('strong', null, manut), ' em manutenção') : '',
      h('span', null, 'Dê dois cliques numa célula de texto para editar. Marque várias linhas para editar em lote (Shift+clique marca um intervalo).'));

    clear(corpo);
    if (!visiveis.length) {
      corpo.appendChild(h('tr', null, h('td', { colspan: COLS.length + 1, class: 'vazio' }, 'Nenhum item encontrado com esses filtros.')));
      sel.refletir();
      return;
    }
    const frag = document.createDocumentFragment();
    for (const it of visiveis) frag.appendChild(linha(it));
    corpo.appendChild(frag);
    sel.refletir();
  }

  function linha(it) {
    const s = App.uiSituacao(it);
    const acoes = App.acoes.acoesDoItem(it);
    const primaria = acoes.find(a => a.primaria);
    const celTxt = (campo, extraClasse) => {
      const editavel = EDITAVEIS.includes(campo) && !(campo === 'serie' || campo === 'patrimonio') || ((campo === 'serie' || campo === 'patrimonio') && it.controle === 'unidade');
      return h('td', {
        class: [extraClasse, editavel ? 'editavel' : null].filter(Boolean).join(' ') || null,
        dataset: editavel ? { campo } : null,
        title: editavel ? 'Dois cliques para editar' : null,
      }, it[campo] || (editavel ? '' : '—'));
    };
    const tr = h('tr', { class: L.total(it) === 0 ? 'zero' : null, dataset: { id: it.id } },
      sel.td(it.id, App.uiRotuloItem(it)),
      celTxt('categoria'),
      celTxt('descricao', 'quebra'),
      celTxt('serie', 'mono'),
      celTxt('patrimonio'),
      celTxt('posicao'),
      h('td', null, h('span', { class: 'badge ' + s.cls }, s.txt)),
      h('td', { class: 'curto', title: it.responsavelAtual || null }, it.responsavelAtual || ''),
      h('td', { class: 'num' }, it.saldo.MATRIZ),
      h('td', { class: 'num' }, it.saldo.SAO_CRISTOVAO),
      h('td', { class: 'num total' }, h('strong', null, L.total(it))),
      h('td', { class: 'acoes' },
        primaria ? h('button', { type: 'button', class: 'btn pequeno', onclick: primaria.fn }, primaria.rotulo) : null,
        h('button', { type: 'button', class: 'btn pequeno fantasma icone', 'aria-label': 'Mais ações', title: 'Mais ações',
          onclick: e => UI.menu(e.currentTarget, acoes.filter(a => a === '-' || !a.primaria)) }, '⋯')));
    return tr;
  }

  // ---------- Edição direta ----------
  document.addEventListener('dblclick', e => {
    const td = e.target.closest && e.target.closest('td.editavel');
    if (!td || !raiz || !raiz.contains(td)) return;
    editarCelula(td);
  });

  function editarCelula(td) {
    if (td.classList.contains('editando')) return;
    const id = td.closest('tr').dataset.id;
    const campo = td.dataset.campo;
    const item = App.store.db.itens.find(i => i.id === id);
    if (!item) return;
    const original = item[campo] || '';
    const listas = { categoria: L.listas.categorias, posicao: L.listas.posicoes };
    const input = h('input', { type: 'text', value: original, 'aria-label': L.CAMPOS_EDITAVEIS[campo] });
    let dl = null;
    if (listas[campo]) {
      const idl = 'dl-inline-' + campo;
      input.setAttribute('list', idl);
      dl = h('datalist', { id: idl }, listas[campo](App.store.db).map(v => h('option', { value: v })));
    }
    td.classList.add('editando');
    preencher(td, input, ...(dl ? [dl] : []));
    input.focus(); input.select();
    let feito = false;
    const terminar = async (salvar, proximo) => {
      if (feito) return; feito = true;
      const valor = input.value;
      if (salvar && valor.trim() !== String(original).trim()) {
        try { await App.executar('editarItem', [id, { [campo]: valor }], `${L.CAMPOS_EDITAVEIS[campo]} atualizado.`); }
        catch (err) { UI.toast(err.message, 'erro'); atualizar(); }
      } else atualizar();
      if (proximo) {
        const tr = corpo.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
        const cels = tr ? [...tr.querySelectorAll('td.editavel')] : [];
        const i = cels.findIndex(c => c.dataset.campo === campo);
        const alvo = cels[i + proximo];
        if (alvo) editarCelula(alvo);
      }
    };
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); terminar(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); terminar(false); }
      else if (ev.key === 'Tab') { ev.preventDefault(); terminar(true, ev.shiftKey ? -1 : 1); }
    });
    input.addEventListener('blur', () => setTimeout(() => terminar(true), 0));
  }

  function focarBusca() { if (inputBusca) { inputBusca.focus(); inputBusca.select(); } }

  App.views = App.views || {};
  App.views.estoque = { montar, atualizar, focarBusca };
})(globalThis.App = globalThis.App || {});

/* Pessoas: cadastro de colaboradores e setores que recebem itens (não usam a aplicação), itens com cada pessoa
   e migração dos nomes antigos (texto livre) para o cadastro. Dados pessoais: nome, e-mail e departamento. */
(function (App) {
  'use strict';
  const { h, clear, preencher, debounce, fmtData, chave, limpa } = App.util;
  const L = App.ledger;
  const UI = App.ui;
  const db = () => App.store.db;

  const st = UI.prefs('pessoas', { tipo: '', unidade: '', situacao: 'ativas', ord: 'nome', dir: 1 });
  st.busca = '';

  const opTipos = [{ valor: '', rotulo: 'Pessoas e setores' }, { valor: 'PESSOA', rotulo: 'Só pessoas' }, { valor: 'SETOR', rotulo: 'Só setores' }];
  const opUnidades = [{ valor: '', rotulo: 'Todas as unidades' }].concat(Object.entries(L.LOCAIS).map(([valor, rotulo]) => ({ valor, rotulo })));
  const opSituacoes = [{ valor: 'ativas', rotulo: 'Ativas' }, { valor: 'inativas', rotulo: 'Inativas' }, { valor: 'todas', rotulo: 'Ativas e inativas' }];

  let raiz, corpo, thead, resumoEl, avisosEl, inputBusca;
  let migracao = null; // { grupos } enquanto o relatório de nomes antigos está em revisão

  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

  // ---------- Lista ----------
  function montar(el) {
    raiz = el;
    clear(raiz);
    corpo = null;
    if (migracao) return desenharMigracao();
    inputBusca = h('input', {
      type: 'search', placeholder: 'Buscar por nome, departamento ou e-mail…  ( / )', 'aria-label': 'Buscar pessoas', value: st.busca,
      oninput: debounce(() => { st.busca = inputBusca.value; atualizar(); }, 80),
      onkeydown: e => { if (e.key === 'Escape') { inputBusca.value = ''; st.busca = ''; atualizar(); } },
    });
    avisosEl = h('div');
    resumoEl = h('div', { class: 'resumo' });
    thead = h('thead');
    corpo = h('tbody');
    raiz.append(
      h('div', { class: 'barra' },
        h('div', { class: 'busca' }, inputBusca),
        UI.select(opTipos, st.tipo, v => { st.tipo = v; st.salvar(); atualizar(); }, 'Tipo'),
        UI.select(opUnidades, st.unidade, v => { st.unidade = v; st.salvar(); atualizar(); }, 'Unidade'),
        UI.select(opSituacoes, st.situacao, v => { st.situacao = v; st.salvar(); atualizar(); }, 'Situação'),
        h('div', { class: 'espaco' }),
        h('button', { class: 'btn', type: 'button', onclick: abrirMigracao }, 'Vincular nomes antigos…'),
        h('button', { class: 'btn primario', type: 'button', onclick: () => abrirNova() }, '+ Nova pessoa')),
      avisosEl, resumoEl,
      h('div', { class: 'tabela-wrap' }, h('table', { class: 'tab' }, thead, corpo)));
    atualizar();
  }

  const COLS = [
    { chave: 'nome', rotulo: 'Nome', val: p => p.nome },
    { chave: 'tipo', rotulo: 'Tipo', val: p => L.TIPOS_PESSOA[p.tipo] },
    { chave: 'departamento', rotulo: 'Departamento', val: p => p.departamento || '' },
    { chave: 'unidade', rotulo: 'Unidade', val: p => p.unidade ? L.LOCAIS[p.unidade] : '' },
    { chave: 'email', rotulo: 'E-mail', val: p => p.email || '' },
    { chave: 'itens', rotulo: 'Itens com a pessoa', classe: 'num', val: (p, n) => n(p) },
    { rotulo: '', classe: 'acoes' },
  ];

  function atualizar() {
    const d = db();
    if (!d || !raiz) return;
    if (migracao) return desenharMigracao();
    if (!corpo) return montar(raiz);

    const pos = L.posicoesPessoas(d);
    const nItens = p => (pos.get(p.id) || []).reduce((s, x) => s + x.quantidade, 0);
    const todas = L.listaPessoas(d);
    const busca = UI.filtroTexto(st.busca);
    const lista = todas.filter(p =>
      (!st.tipo || p.tipo === st.tipo) && (!st.unidade || p.unidade === st.unidade) &&
      // "Ativas" também mostra as inativas que ainda têm itens (destacadas em vermelho): não podem passar despercebidas.
      (st.situacao === 'todas' || (st.situacao === 'inativas' ? !p.ativo : (p.ativo || nItens(p) > 0))) &&
      busca([p.nome, p.departamento, p.email, L.TIPOS_PESSOA[p.tipo], p.unidade && L.LOCAIS[p.unidade]]));
    const col = COLS.find(c => c.chave === st.ord) || COLS[0];
    lista.sort((a, b) => UI.comparar(col.val(a, nItens), col.val(b, nItens)) * st.dir || UI.comparar(a.nome, b.nome));

    clear(thead).appendChild(UI.cabecalhoOrdenavel(COLS, st, k => { st.dir = st.ord === k ? -st.dir : 1; st.ord = k; st.salvar(); atualizar(); }));

    // Avisos: inativas que ainda têm itens e nomes antigos sem vínculo.
    const inativasComItens = todas.filter(p => !p.ativo && nItens(p) > 0);
    const antigos = L.gruposNomesAntigos(d);
    preencher(avisosEl,
      inativasComItens.length ? h('div', { class: 'aviso danger' },
        `${plural(inativasComItens.length, 'pessoa inativa ainda tem', 'pessoas inativas ainda têm')} itens: ${inativasComItens.slice(0, 5).map(p => p.nome).join(', ')}${inativasComItens.length > 5 ? '…' : ''}. `,
        st.situacao !== 'inativas' ? h('button', { type: 'button', class: 'btn pequeno', onclick: () => { st.situacao = 'inativas'; st.salvar(); montar(raiz); } }, 'Mostrar inativas') : null) : null,
      antigos.length ? h('div', { class: 'aviso info' },
        `${plural(antigos.length, 'nome antigo', 'nomes antigos')} (texto livre das entregas) ainda sem vínculo com o cadastro. `,
        h('button', { type: 'button', class: 'btn pequeno', onclick: abrirMigracao }, 'Vincular nomes antigos…')) : null);

    const comItens = lista.filter(p => nItens(p) > 0).length;
    preencher(resumoEl,
      h('span', null, h('strong', null, lista.length), lista.length === 1 ? ' cadastro exibido' : ' cadastros exibidos'),
      h('span', null, h('strong', null, comItens), ' com itens'),
      h('span', null, 'Colaboradores não acessam a aplicação: o cadastro serve para saber com quem está cada item.'));

    clear(corpo);
    if (!lista.length) {
      corpo.appendChild(h('tr', null, h('td', { colspan: COLS.length, class: 'vazio' },
        todas.length ? 'Nenhum cadastro encontrado com esses filtros.' : 'Nenhuma pessoa cadastrada ainda. Use "+ Nova pessoa" ou "Vincular nomes antigos…" para aproveitar os nomes das entregas já registradas.')));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const p of lista) frag.appendChild(linha(p, nItens(p)));
    corpo.appendChild(frag);
  }

  function linha(p, n) {
    const acoes = [
      { rotulo: 'Editar', fn: () => abrirEditar(p.id) },
      { rotulo: 'Ver itens', fn: () => abrirItens(p.id) },
      '-',
      p.ativo ? { rotulo: 'Desativar…', fn: () => desativar(p.id), perigo: true } : { rotulo: 'Reativar', fn: () => reativar(p.id) },
    ];
    return h('tr', { class: !p.ativo ? (n ? 'pessoa-alerta' : 'pessoa-inativa') : null },
      h('td', { class: 'pessoa-nome' }, p.nome,
        !p.ativo ? h('span', { class: 'badge ' + (n ? 'danger' : 'neutro') }, n ? 'Inativa com itens' : 'Inativa') : null,
        p.origem === 'migracao' ? h('span', { class: 'tag', title: 'Criada a partir dos nomes antigos das entregas' }, 'migração') : null),
      h('td', null, h('span', { class: 'badge ' + (p.tipo === 'SETOR' ? 'info' : 'neutro') }, L.TIPOS_PESSOA[p.tipo])),
      h('td', null, p.departamento || '—'),
      h('td', null, p.unidade ? L.LOCAIS[p.unidade] : '—'),
      h('td', { class: 'curto', title: p.email || null }, p.email || '—'),
      h('td', { class: 'num' }, n ? h('button', { type: 'button', class: 'link-itens', title: 'Ver os itens com esta pessoa', onclick: () => abrirItens(p.id) }, n) : h('span', { class: 'fraco' }, '0')),
      h('td', { class: 'acoes' },
        h('button', { type: 'button', class: 'btn pequeno fantasma icone', 'aria-label': 'Mais ações', title: 'Mais ações', onclick: e => UI.menu(e.currentTarget, acoes) }, '⋯')));
  }

  // ---------- Cadastro ----------
  function departamentos() {
    const m = new Map();
    for (const p of L.listaPessoas(db())) { const s = limpa(p.departamento); if (s && !m.has(chave(s))) m.set(chave(s), s); }
    return [...m.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  function camposPessoa(p, nomeInicial) {
    const outroEmail = v => { const e = limpa(v.email).toLowerCase(); return e && L.listaPessoas(db()).find(x => (!p || x.id !== p.id) && x.email && x.email.toLowerCase() === e); };
    return [
      { nome: 'tipo', rotulo: 'Tipo', tipo: 'radio', valor: p ? p.tipo : 'PESSOA', largo: true,
        opcoes: [{ valor: 'PESSOA', rotulo: 'Pessoa' }, { valor: 'SETOR', rotulo: 'Setor / unidade' }] },
      { nome: 'nome', rotulo: 'Nome', obrigatorio: true, largo: true, valor: p ? p.nome : (nomeInicial || ''),
        dicaDinamica: v => {
          const k = L.chaveNome(v.nome);
          const igual = k && L.listaPessoas(db()).find(x => (!p || x.id !== p.id) && L.chaveNome(x.nome) === k);
          return igual ? { texto: `Já existe cadastro com este nome${igual.departamento ? ' (' + igual.departamento + ')' : ''}. Se for outra pessoa, siga em frente.`, warn: true } : null;
        } },
      { nome: 'email', rotulo: 'E-mail', valor: p ? p.email || '' : '', placeholder: 'nome@empresa.com.br',
        dica: 'Opcional. Será a chave para ligar ao diretório Microsoft (Entra ID) no futuro.',
        dicaDinamica: v => { const o = outroEmail(v); return o ? { texto: `Este e-mail já é de ${o.nome}.`, warn: true } : null; } },
      { nome: 'departamento', rotulo: 'Departamento', valor: p ? p.departamento || '' : '', lista: departamentos },
      { nome: 'unidade', rotulo: 'Unidade', tipo: 'select', valor: p ? p.unidade || '' : '',
        opcoes: [{ valor: '', rotulo: '— não informada —' }].concat(Object.entries(L.LOCAIS).map(([valor, rotulo]) => ({ valor, rotulo }))) },
      { nome: 'obs', rotulo: 'Observação', tipo: 'textarea', valor: p ? p.obs || '' : '' },
    ];
  }

  // opcoes.aoCriar(pessoa) é chamado depois de salvar (usado pelas telas de entrega e devolução).
  function abrirNova(opcoes) {
    const { nome, aoCriar } = opcoes || {};
    UI.formulario({
      titulo: 'Nova pessoa',
      subtitulo: 'Colaborador ou setor que recebe itens. Não precisa ter acesso à aplicação.',
      campos: camposPessoa(null, nome),
      aoEnviar: async v => {
        const args = { tipo: v.tipo, nome: v.nome, email: v.email, departamento: v.departamento, unidade: v.unidade, obs: v.obs };
        const r = await App.acao(d => L.criarPessoa(d, args), 'Pessoa cadastrada.');
        // Se a operação não devolver o cadastro, procura o mais recente com o mesmo nome.
        const criada = r && r.id ? r : L.listaPessoas(db()).filter(p => p.nome === limpa(v.nome)).pop();
        if (aoCriar && criada) aoCriar(criada);
      },
    });
  }

  function abrirEditar(id) {
    const p = L.getPessoa(db(), id);
    UI.formulario({
      titulo: 'Editar pessoa', subtitulo: p.origem === 'diretorio' ? 'Cadastro vindo do diretório.' : null,
      campos: camposPessoa(p),
      aoEnviar: async v => {
        const args = { id, tipo: v.tipo, nome: v.nome, email: v.email, departamento: v.departamento, unidade: v.unidade, obs: v.obs };
        await App.acao(d => L.editarPessoa(d, args), 'Cadastro atualizado.');
      },
    });
  }

  async function desativar(id) {
    const p = L.getPessoa(db(), id);
    const n = L.itensComPessoa(db(), id).reduce((s, x) => s + x.quantidade, 0);
    const ok = await UI.confirmar({
      titulo: 'Desativar cadastro?', ok: 'Desativar',
      mensagem: `${p.nome} deixa de aparecer nas novas entregas. O cadastro e o histórico são mantidos e podem ser reativados.`,
      detalhes: n ? [`Atenção: ainda há ${plural(n, 'item', 'itens')} com esta pessoa. Ela ficará destacada na lista até a devolução.`] : [],
    });
    if (!ok) return;
    try { await App.acao(d => L.desativarPessoa(d, { id }), 'Cadastro desativado.'); } catch (e) { UI.toast(e.message, 'erro'); }
  }

  async function reativar(id) {
    try { await App.acao(d => L.reativarPessoa(d, { id }), 'Cadastro reativado.'); } catch (e) { UI.toast(e.message, 'erro'); }
  }

  // ---------- Itens com a pessoa ----------
  function abrirItens(id) {
    const d = db();
    const p = L.getPessoa(d, id);
    const itens = L.itensComPessoa(d, id);
    const hist = L.historicoPessoa(d, id);
    const pecas = itens.reduce((s, x) => s + x.quantidade, 0);
    const porQtd = itens.some(x => x.controle === 'quantidade') || hist.some(m => m.item && d.itens.some(i => i.id === m.itemId && i.controle === 'quantidade'));
    const dlg = h('dialog', { class: 'dlg largo' },
      h('div', { class: 'corpo-wrap' },
        h('div', { class: 'dlg-cab' },
          h('h2', null, p.nome),
          h('p', null, [L.TIPOS_PESSOA[p.tipo], p.departamento, p.unidade && L.LOCAIS[p.unidade], p.email].filter(Boolean).join(' · ') + (p.ativo ? '' : ' · INATIVA'))),
        h('div', { class: 'dlg-corpo' },
          !p.ativo && pecas ? h('div', { class: 'aviso danger' }, `Cadastro inativo, mas ainda há ${plural(pecas, 'item', 'itens')} com esta pessoa. Registre a devolução ou reative o cadastro.`) : null,
          h('h3', { class: 'sub' }, `Itens com a pessoa agora (${pecas})`),
          itens.length ? h('div', { class: 'tabela-wrap' }, h('table', { class: 'tab' },
            h('thead', null, h('tr', null, ['Item', 'Nº de série', 'Patrimônio', 'Qtd.', 'Desde', ''].map(t => h('th', { class: t === 'Qtd.' ? 'num' : null }, t)))),
            h('tbody', null, itens.map(x => h('tr', null,
              h('td', { class: 'quebra' }, `${x.item.categoria} — ${x.item.descricao}`),
              h('td', { class: 'mono' }, x.item.serie || '—'),
              h('td', null, x.item.patrimonio || '—'),
              h('td', { class: 'num' }, x.quantidade),
              h('td', null, fmtData(x.desde)),
              h('td', { class: 'acoes' }, h('button', { type: 'button', class: 'btn pequeno fantasma', onclick: () => App.acoes.abrirHistorico(x.item.id) }, 'Histórico'))))))) : h('p', { class: 'fraco' }, 'Nenhum item com esta pessoa.'),
          porQtd ? h('p', { class: 'fraco nota' }, 'Itens controlados por quantidade: mostra o que foi entregue a esta pessoa menos o que voltou registrado no nome dela. Devoluções lançadas sem informar a pessoa não são abatidas; confira com ela em caso de dúvida.') : null,
          h('h3', { class: 'sub' }, `Histórico de entregas e devoluções (${hist.length})`),
          hist.length ? h('div', { class: 'tabela-wrap' }, h('table', { class: 'tab' },
            h('thead', null, h('tr', null, ['Data', 'Tipo', 'Item', 'Nº de série', 'Qtd.', 'Chamado', 'Observação'].map(t => h('th', { class: t === 'Qtd.' ? 'num' : null }, t)))),
            h('tbody', null, hist.map(m => h('tr', null,
              h('td', null, fmtData(m.data)),
              h('td', null, L.TIPOS[m.tipo]),
              h('td', { class: 'quebra' }, `${m.item?.categoria || ''} — ${m.item?.descricao || ''}`),
              h('td', { class: 'mono' }, m.item?.serie || '—'),
              h('td', { class: 'num' }, m.quantidade || ''),
              h('td', { class: 'mono' }, m.chamado || '—'),
              h('td', { class: 'quebra' }, m.obs || '')))))) : h('p', { class: 'fraco' }, 'Sem entregas ou devoluções registradas no nome desta pessoa.')),
        h('div', { class: 'dlg-rodape' },
          h('div', { class: 'esq' }, h('button', { type: 'button', class: 'btn', disabled: !itens.length && !hist.length,
            title: 'Planilha com os itens atuais e o histórico, útil para o inventário por colaborador',
            onclick: () => { try { App.exporter.baixarItensPessoa(db(), id); } catch (e) { UI.toast(e.message, 'erro'); } } }, 'Exportar lista (.xlsx)')),
          h('button', { type: 'button', class: 'btn primario', onclick: () => dlg.close() }, 'Fechar'))));
    UI.abrirDialogo(dlg);
  }

  // ---------- Migração dos nomes antigos ----------
  const ACOES = [
    { valor: 'criar', rotulo: 'Criar pessoa nova' },
    { valor: 'vincular', rotulo: 'Vincular a pessoa já cadastrada' },
    { valor: 'setor', rotulo: 'Criar como setor' },
    { valor: 'ignorar', rotulo: 'Ignorar (manter só como texto)' },
  ];

  const sugestao = g => g.existenteId ? 'vincular' : (g.tipoSugerido === 'SETOR' ? 'setor' : 'criar');

  function abrirMigracao() {
    const grupos = L.gruposNomesAntigos(db());
    if (!grupos.length) return UI.toast('Não há nomes antigos sem vínculo com o cadastro.');
    migracao = { grupos: grupos.map(g => Object.assign({}, g, { acao: '', pessoaId: g.existenteId || '', nomeFinal: g.nome, deptoFinal: g.departamento || '' })) };
    montar(raiz);
    window.scrollTo(0, 0);
  }

  function sair() { migracao = null; montar(raiz); }

  function desenharMigracao() {
    const grupos = migracao.grupos;
    const contador = h('span', { class: 'fraco' });
    const btnOk = h('button', { class: 'btn primario', type: 'button', onclick: confirmarMigracao }, 'Confirmar vínculos');
    const cartoes = [];
    const refletir = () => {
      const decididos = grupos.filter(g => g.acao && g.acao !== 'ignorar').length;
      const sem = grupos.filter(g => !g.acao).length;
      contador.textContent = `${plural(decididos, 'grupo será vinculado', 'grupos serão vinculados')}` + (sem ? ` · ${plural(sem, 'sem decisão (fica como texto)', 'sem decisão (ficam como texto)')}` : '');
      btnOk.disabled = !decididos;
      for (const c of cartoes) c.box.className = 'pend ' + (c.g.acao ? 'decisao resolvida' : 'revisar');
    };
    const aceitar = () => { for (const g of grupos) if (!g.acao) g.acao = sugestao(g); desenharMigracao(); };
    const totalMov = grupos.reduce((s, g) => s + g.movimentos, 0), totalIt = grupos.reduce((s, g) => s + g.itens, 0);

    preencher(raiz, h('div', null,
      h('section', { class: 'secao' },
        h('h2', null, 'Vincular nomes antigos'),
        h('p', null, `Textos digitados em "Entregue para"/"Devolvido por" antes do cadastro, agrupados por nome (sem diferenciar acentos, maiúsculas e espaços; "Nome (Setor)" junta com "Nome"). Escolha o que fazer com cada grupo. Nada é criado sem a sua confirmação, e o texto original continua no histórico.`),
        h('div', { class: 'cartoes', style: 'margin:10px 0 0' },
          h('div', { class: 'cartao' }, h('div', { class: 'rotulo' }, 'Grupos de nomes'), h('div', { class: 'valor', style: 'font-size:18px' }, grupos.length)),
          h('div', { class: 'cartao' }, h('div', { class: 'rotulo' }, 'Movimentações sem vínculo'), h('div', { class: 'valor', style: 'font-size:18px' }, totalMov)),
          h('div', { class: 'cartao' }, h('div', { class: 'rotulo' }, 'Itens com responsável em texto'), h('div', { class: 'valor', style: 'font-size:18px' }, totalIt)))),
      h('div', { class: 'pend-grupo', style: 'max-width:980px' },
        grupos.map(g => { const c = cartaoGrupo(g, refletir); cartoes.push(c); return c.box; })),
      h('div', { class: 'rodape-fixo', style: 'max-width:980px' },
        h('button', { class: 'btn', type: 'button', onclick: sair }, 'Cancelar'),
        h('button', { class: 'btn', type: 'button', title: 'Aplica a sugestão de cada grupo que ainda está sem decisão (você ainda revisa antes de confirmar)', onclick: aceitar }, 'Aceitar sugestões dos que faltam'),
        btnOk, contador)));
    refletir();
  }

  function cartaoGrupo(g, aoMudar) {
    const box = h('div', { class: 'pend' });
    const extra = h('div', { class: 'pessoa-extra' });
    const sug = sugestao(g);
    const ex = g.existenteId ? L.getPessoa(db(), g.existenteId) : null;
    const textoSug = ex ? `já existe cadastro "${ex.nome}"` : (g.motivoSetor ? `parece setor (${g.motivoSetor})` : 'nome de pessoa');
    const desenharExtra = () => {
      if (g.acao === 'criar' || g.acao === 'setor') {
        preencher(extra,
          h('label', null, g.acao === 'setor' ? 'Nome do setor' : 'Nome', h('input', { type: 'text', value: g.nomeFinal, oninput: e => { g.nomeFinal = e.target.value; } })),
          h('label', null, 'Departamento', h('input', { type: 'text', value: g.deptoFinal, oninput: e => { g.deptoFinal = e.target.value; } })));
      } else if (g.acao === 'vincular') {
        const todas = L.listaPessoas(db()).slice().sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
        const sel = h('select', { 'aria-label': 'Pessoa cadastrada', onchange: () => { g.pessoaId = sel.value; } },
          h('option', { value: '' }, todas.length ? '— escolha a pessoa —' : '— nenhuma pessoa cadastrada —'),
          todas.map(p => h('option', { value: p.id }, App.uiRotuloPessoa(p))));
        sel.value = g.pessoaId || '';
        preencher(extra, h('label', null, 'Vincular a', sel));
      } else clear(extra);
    };
    preencher(box,
      h('div', { class: 'pend-titulo' }, g.nome, g.departamento ? h('span', { class: 'tag' }, g.departamento) : null),
      h('div', { class: 'pend-detalhe' },
        `Sugestão: ${ACOES.find(a => a.valor === sug).rotulo.toLowerCase()} — ${textoSug}. Aparece como:`,
        h('ul', { class: 'lista-simples variantes' }, g.variantes.map(v => h('li', null, `"${v.texto}" — ${[v.movimentos ? plural(v.movimentos, 'movimentação', 'movimentações') : null, v.itens ? plural(v.itens, 'item', 'itens') : null].filter(Boolean).join(', ')}`)))),
      h('div', { class: 'pend-opcoes', role: 'radiogroup' }, ACOES.map(o =>
        h('label', null, h('input', { type: 'radio', name: 'mig-' + g.id, value: o.valor, checked: g.acao === o.valor,
          onchange: () => { g.acao = o.valor; desenharExtra(); aoMudar(); } }), o.rotulo + (o.valor === sug ? ' (sugerido)' : '')))),
      extra);
    desenharExtra();
    return { box, g };
  }

  async function confirmarMigracao() {
    const grupos = migracao.grupos.filter(g => g.acao && g.acao !== 'ignorar');
    for (const g of grupos) {
      if (g.acao === 'vincular' && !g.pessoaId) return UI.toast(`Escolha a pessoa para vincular "${g.nome}".`, 'erro');
      if (g.acao !== 'vincular' && !limpa(g.nomeFinal)) return UI.toast(`Informe o nome do cadastro de "${g.variantes[0].texto}".`, 'erro');
    }
    const novas = grupos.filter(g => g.acao === 'criar').length, setores = grupos.filter(g => g.acao === 'setor').length;
    const vinc = grupos.filter(g => g.acao === 'vincular').length;
    const movs = grupos.reduce((s, g) => s + g.movimentos, 0), its = grupos.reduce((s, g) => s + g.itens, 0);
    const ok = await UI.confirmar({
      titulo: 'Confirmar vínculos?', ok: 'Vincular',
      mensagem: 'Os registros abaixo passam a apontar para o cadastro. O texto original das movimentações é mantido.',
      detalhes: [
        novas ? `${plural(novas, 'pessoa nova será criada', 'pessoas novas serão criadas')}` : null,
        setores ? `${plural(setores, 'setor novo será criado', 'setores novos serão criados')}` : null,
        vinc ? `${plural(vinc, 'grupo será vinculado', 'grupos serão vinculados')} a cadastro existente` : null,
        `${plural(movs, 'movimentação recebe', 'movimentações recebem')} o vínculo e ${plural(its, 'item passa', 'itens passam')} a ter o responsável do cadastro`,
        `${plural(migracao.grupos.length - grupos.length, 'grupo continua', 'grupos continuam')} como texto`,
      ].filter(Boolean),
    });
    if (!ok) return;
    const decisoes = grupos.map(g => g.acao === 'vincular'
      ? { acao: 'vincular', nomes: g.variantes.map(v => v.texto), pessoaId: g.pessoaId }
      : { acao: g.acao, nomes: g.variantes.map(v => v.texto), pessoa: { nome: g.nomeFinal, departamento: g.deptoFinal } });
    try {
      await App.acao(d => L.vincularNomesAntigos(d, { decisoes }), 'Nomes antigos vinculados ao cadastro.');
      migracao = null;
      montar(raiz);
    } catch (e) {
      UI.toast(e.message || String(e), 'erro');
      if (!e.negocio) console.error(e);
    }
  }

  function focarBusca() { if (inputBusca) { inputBusca.focus(); inputBusca.select(); } }

  App.pessoasUI = { abrirNova, abrirEditar, abrirItens, abrirMigracao };
  App.views = App.views || {};
  App.views.pessoas = { montar, atualizar, focarBusca };
})(globalThis.App = globalThis.App || {});

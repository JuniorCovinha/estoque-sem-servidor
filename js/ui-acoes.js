/* Diálogos de operação. Todos passam por App.acao, que grava e desfaz em caso de erro. */
(function (App) {
  'use strict';
  const { h, hojeISO, fmtData, fmtDataHora, fmtMoeda, normalizaChamado, chamadoValido, limpa } = App.util;
  const L = App.ledger;
  const UI = App.ui;
  const db = () => App.store.db;

  const opLocais = Object.entries(L.LOCAIS).map(([valor, rotulo]) => ({ valor, rotulo }));

  function rotuloItem(it) {
    let r = `${it.categoria} — ${it.descricao}`;
    if (it.serie) r += ` · ${it.serie}`;
    if (it.controle === 'quantidade') r += ` · saldo ${L.total(it)}`;
    return r;
  }
  App.uiRotuloItem = rotuloItem;

  function situacao(it) {
    if (it.controle === 'quantidade') return L.total(it) > 0 ? { txt: 'Em estoque', cls: 'ok' } : { txt: 'Sem saldo', cls: 'neutro' };
    return {
      EM_ESTOQUE: { txt: 'Em estoque', cls: 'ok' }, ENTREGUE: { txt: 'Entregue', cls: 'info' },
      MANUTENCAO: { txt: 'Manutenção', cls: 'warn' }, DESCARTADO: { txt: 'Descartado', cls: 'neutro' },
    }[it.status];
  }
  App.uiSituacao = situacao;

  function infoItem(it) {
    if (!it) return null;
    const s = situacao(it);
    return h('div', null,
      h('div', { class: 'linha' },
        h('span', null, 'Situação: ', h('span', { class: 'badge ' + s.cls }, s.txt)),
        it.controle === 'unidade'
          ? h('span', null, 'Local: ', h('b', null, L.LOCAIS[it.local] || '—'))
          : [h('span', null, 'Matriz: ', h('b', null, it.saldo.MATRIZ)), h('span', null, 'São Cristóvão: ', h('b', null, it.saldo.SAO_CRISTOVAO))],
        it.posicao ? h('span', null, 'Posição: ', h('b', null, it.posicao)) : null,
        it.responsavelAtual ? h('span', null, 'Com: ', h('b', null, it.responsavelAtual)) : null),
      it.obs ? h('div', { class: 'linha', style: 'margin-top:4px' }, h('span', null, 'Obs.: ' + it.obs)) : null);
  }

  const campoData = (extra) => Object.assign({ nome: 'data', rotulo: 'Data', tipo: 'date', valor: hojeISO, obrigatorio: true, manterAoContinuar: true }, extra);
  const campoChamado = (extra) => Object.assign({
    nome: 'chamado', rotulo: 'Chamado', placeholder: '#0926-000123', dica: 'Opcional',
    dicaDinamica: v => (v.chamado && !chamadoValido(normalizaChamado(v.chamado))) ? { texto: 'Fora do padrão #MMAA-NNNNNN usado na planilha.', warn: true } : null,
  }, extra);
  const campoObs = (extra) => Object.assign({ nome: 'obs', rotulo: 'Observação', tipo: 'textarea' }, extra);

  // Avisos que não bloqueiam, mas pedem confirmação.
  async function confirmarAvisos(v, extras) {
    const avisos = [].concat(extras || []);
    const ch = normalizaChamado(v.chamado);
    if (ch && !chamadoValido(ch)) avisos.push(`Chamado "${ch}" fora do padrão #MMAA-NNNNNN.`);
    if (v.data) {
      const hoje = hojeISO();
      const umAno = (Number(hoje.slice(0, 4)) - 1) + hoje.slice(4);
      if (v.data > hoje) avisos.push(`A data ${fmtData(v.data)} está no futuro.`);
      else if (v.data < umAno) avisos.push(`A data ${fmtData(v.data)} tem mais de um ano.`);
    }
    if (!avisos.length) return true;
    return UI.confirmar({ titulo: 'Confira antes de salvar', mensagem: 'Encontrei o seguinte:', detalhes: avisos, ok: 'Salvar mesmo assim' });
  }

  function localPadrao(it) {
    if (!it) return 'MATRIZ';
    if (it.controle === 'unidade') return it.local || 'MATRIZ';
    return it.saldo.MATRIZ > 0 || it.saldo.SAO_CRISTOVAO === 0 ? 'MATRIZ' : 'SAO_CRISTOVAO';
  }

  const itemDe = id => id ? db().itens.find(i => i.id === id) : null;
  const ehQtd = v => { const it = itemDe(v.itemId); return !!it && it.controle === 'quantidade'; };
  const ehUnid = v => { const it = itemDe(v.itemId); return !!it && it.controle === 'unidade'; };

  function campoItem(filtro, extra) {
    return Object.assign({
      nome: 'itemId', rotulo: 'Item', tipo: 'item', obrigatorio: true,
      itens: () => L.itensAtivos(db()).filter(filtro).sort((a, b) => rotuloItem(a).localeCompare(rotuloItem(b), 'pt-BR')),
      dica: 'Digite ou leia o nº de série, ou escolha pelo nome.',
    }, extra);
  }
  const campoInfo = () => ({ nome: '_info', tipo: 'info', conteudo: v => infoItem(itemDe(v.itemId)) });

  // ---------- Entrega ----------
  const disponivelEntrega = it => (it.controle === 'unidade' && it.status === 'EM_ESTOQUE') || (it.controle === 'quantidade' && L.total(it) > 0);

  function abrirEntrega(itemId) {
    UI.formulario({
      titulo: 'Registrar entrega',
      subtitulo: 'Baixa o item do estoque e registra para quem foi entregue.',
      campos: [
        campoItem(disponivelEntrega, { valor: itemId || '', aoMudar: (v, api) => { const it = itemDe(v.itemId); api.set('local', localPadrao(it)); }, chamarAoAbrir: true }),
        campoInfo(),
        { nome: 'local', rotulo: 'Sai de', tipo: 'select', opcoes: opLocais, valor: 'MATRIZ', visivel: ehQtd },
        { nome: 'quantidade', rotulo: 'Quantidade', tipo: 'number', valor: '1', min: 1, passo: 1, obrigatorio: true, visivel: ehQtd,
          dicaDinamica: v => { const it = itemDe(v.itemId); return it && it.controle === 'quantidade' ? { texto: `Disponível em ${L.LOCAIS[v.local]}: ${it.saldo[v.local]}` } : null; } },
        { nome: 'usuario', rotulo: 'Entregue para', obrigatorio: true, lista: () => L.listas.usuarios(db()), manterAoContinuar: true, placeholder: 'Nome (setor)' },
        campoChamado({ manterAoContinuar: true }),
        campoData(),
        campoObs(),
      ],
      botoes: [{ rotulo: 'Registrar e lançar outro', acao: 'outro' }, { rotulo: 'Registrar entrega', acao: 'salvar', primario: true }],
      aoEnviar: async (v, acao) => {
        if (!(await confirmarAvisos(v))) return false;
        await App.acao(d => L.entregar(d, v.itemId, v), 'Entrega registrada.');
        return acao === 'outro' ? 'continuar' : true;
      },
    });
  }

  // ---------- Devolução ----------
  const disponivelDevolucao = it => (it.controle === 'unidade' && it.status === 'ENTREGUE') || it.controle === 'quantidade';

  function abrirDevolucao(itemId) {
    UI.formulario({
      titulo: 'Registrar devolução',
      subtitulo: 'Item volta ao estoque (ou para manutenção, se voltou com defeito).',
      campos: [
        campoItem(disponivelDevolucao, {
          valor: itemId || '', chamarAoAbrir: true,
          aoMudar: (v, api) => { const it = itemDe(v.itemId); api.set('local', localPadrao(it)); if (it && it.responsavelAtual) api.set('usuario', it.responsavelAtual); },
        }),
        campoInfo(),
        { nome: 'local', rotulo: 'Volta para', tipo: 'select', opcoes: opLocais, valor: 'MATRIZ' },
        { nome: 'quantidade', rotulo: 'Quantidade', tipo: 'number', valor: '1', min: 1, passo: 1, obrigatorio: true, visivel: ehQtd },
        { nome: 'posicao', rotulo: 'Guardar na posição', lista: () => L.listas.posicoes(db()), visivel: ehUnid, dica: 'Opcional. Ex.: A P3' },
        { nome: 'usuario', rotulo: 'Devolvido por', lista: () => L.listas.usuarios(db()) },
        campoChamado(),
        campoData(),
        { nome: 'manutencao', rotulo: 'Voltou com defeito: enviar para manutenção', tipo: 'checkbox', visivel: ehUnid, largo: true },
        campoObs(),
      ],
      botoes: [{ rotulo: 'Registrar e lançar outro', acao: 'outro' }, { rotulo: 'Registrar devolução', acao: 'salvar', primario: true }],
      aoEnviar: async (v, acao) => {
        if (!(await confirmarAvisos(v))) return false;
        await App.acao(d => L.devolver(d, v.itemId, v), 'Devolução registrada.');
        return acao === 'outro' ? 'continuar' : true;
      },
    });
  }

  // ---------- Novo item ----------
  function abrirNovoItem() {
    UI.formulario({
      titulo: 'Cadastrar item',
      subtitulo: 'Use "Unidade" para equipamentos com nº de série (notebook, celular…) e "Quantidade" para periféricos e consumíveis.',
      campos: [
        { nome: 'categoria', rotulo: 'Categoria', obrigatorio: true, lista: () => L.listas.categorias(db()), manterAoContinuar: true, placeholder: 'Ex.: Notebook Dell',
          aoMudar: (v, api) => { const s = L.categoriaUsaSerie(db(), v.categoria); if (s !== null) api.set('controle', s ? 'unidade' : 'quantidade'); } },
        { nome: 'descricao', rotulo: 'Descrição / modelo', obrigatorio: true, manterAoContinuar: true, placeholder: 'Ex.: Latitude 3420' },
        { nome: 'controle', rotulo: 'Controle', tipo: 'radio', valor: 'quantidade', manterAoContinuar: true, largo: true,
          opcoes: [{ valor: 'unidade', rotulo: 'Unidade (com nº de série)' }, { valor: 'quantidade', rotulo: 'Quantidade' }] },
        { nome: 'serie', rotulo: 'Nº de série', visivel: v => v.controle === 'unidade', mono: true,
          dicaDinamica: v => { const o = v.serie && L.itemPorSerie(db(), v.serie); return o ? { texto: `Já cadastrado: ${o.categoria} — ${o.descricao}`, warn: true } : null; } },
        { nome: 'patrimonio', rotulo: 'Patrimônio', visivel: v => v.controle === 'unidade', dica: 'Opcional' },
        { nome: 'quantidade', rotulo: 'Quantidade', tipo: 'number', valor: '1', min: 1, passo: 1, obrigatorio: true, visivel: v => v.controle === 'quantidade' },
        { nome: 'local', rotulo: 'Local', tipo: 'select', opcoes: opLocais, valor: 'MATRIZ', manterAoContinuar: true },
        { nome: 'posicao', rotulo: 'Posição', lista: () => L.listas.posicoes(db()), manterAoContinuar: true, placeholder: 'Ex.: A P3' },
        { nome: 'proprietario', rotulo: 'Proprietário', valor: 'Solar Cuidados', lista: () => L.listas.proprietarios(db()), manterAoContinuar: true },
        campoChamado(),
        campoData(),
        campoObs(),
      ],
      botoes: [{ rotulo: 'Cadastrar e lançar outro', acao: 'outro' }, { rotulo: 'Cadastrar', acao: 'salvar', primario: true }],
      aoEnviar: async (v, acao) => {
        const extras = v.controle === 'unidade' && !limpa(v.serie) ? ['Item por unidade sem nº de série: ficará difícil identificá-lo depois.'] : [];
        if (!(await confirmarAvisos(v, extras))) return false;
        await App.acao(d => L.cadastrarItem(d, v), 'Item cadastrado.');
        return acao === 'outro' ? 'continuar' : true;
      },
    });
  }

  // ---------- Entrada (itens por quantidade) ----------
  function abrirEntrada(itemId) {
    const it = itemDe(itemId);
    UI.formulario({
      titulo: 'Entrada de estoque', subtitulo: rotuloItem(it),
      campos: [
        { nome: '_info', tipo: 'info', conteudo: () => infoItem(itemDe(itemId)) },
        { nome: 'local', rotulo: 'Entra em', tipo: 'select', opcoes: opLocais, valor: localPadrao(it) },
        { nome: 'quantidade', rotulo: 'Quantidade', tipo: 'number', valor: '', min: 1, passo: 1, obrigatorio: true },
        campoChamado(), campoData(), campoObs({ placeholder: 'Ex.: compra, NF, fornecedor' }),
      ],
      botoes: [{ rotulo: 'Registrar entrada', acao: 'salvar', primario: true }],
      aoEnviar: async v => {
        if (!(await confirmarAvisos(v))) return false;
        await App.acao(d => L.entrada(d, itemId, v), 'Entrada registrada.');
      },
    });
  }

  // ---------- Ajuste (contagem) ----------
  function abrirAjuste(itemId) {
    const it = itemDe(itemId);
    UI.formulario({
      titulo: 'Ajustar saldo', subtitulo: `${rotuloItem(it)} — informe a quantidade contada fisicamente.`,
      campos: [
        { nome: '_info', tipo: 'info', conteudo: () => infoItem(itemDe(itemId)) },
        { nome: 'local', rotulo: 'Local', tipo: 'select', opcoes: opLocais, valor: localPadrao(it), aoMudar: (v, api) => api.set('novaQuantidade', String(it.saldo[v.local])) },
        { nome: 'novaQuantidade', rotulo: 'Quantidade contada', tipo: 'number', valor: String(it.saldo[localPadrao(it)]), min: 0, passo: 1, obrigatorio: true,
          dicaDinamica: v => { const n = Number(v.novaQuantidade); if (v.novaQuantidade === '' || !isFinite(n)) return null; const d = n - it.saldo[v.local]; return { texto: d === 0 ? 'Sem diferença.' : `Diferença: ${d > 0 ? '+' : ''}${d}`, warn: d !== 0 }; } },
        { nome: 'motivo', rotulo: 'Motivo', obrigatorio: true, largo: true, placeholder: 'Ex.: contagem de inventário, item extraviado' },
        campoData(),
      ],
      botoes: [{ rotulo: 'Ajustar', acao: 'salvar', primario: true }],
      aoEnviar: async v => { await App.acao(d => L.ajustar(d, itemId, v), 'Saldo ajustado.'); },
    });
  }

  // ---------- Manutenção ----------
  function abrirManutencao(itemId) {
    UI.formulario({
      titulo: 'Enviar para manutenção', subtitulo: rotuloItem(itemDe(itemId)),
      campos: [
        { nome: '_info', tipo: 'info', conteudo: () => infoItem(itemDe(itemId)) },
        campoChamado(), campoData(), campoObs({ rotulo: 'Defeito / motivo', obrigatorio: true }),
      ],
      botoes: [{ rotulo: 'Enviar para manutenção', acao: 'salvar', primario: true }],
      aoEnviar: async v => { await App.acao(d => L.enviarManutencao(d, itemId, v), 'Item marcado em manutenção.'); },
    });
  }

  function abrirRetornoManutencao(itemId) {
    UI.formulario({
      titulo: 'Retorno da manutenção', subtitulo: rotuloItem(itemDe(itemId)),
      campos: [
        { nome: '_info', tipo: 'info', conteudo: () => infoItem(itemDe(itemId)) },
        { nome: 'posicao', rotulo: 'Guardar na posição', lista: () => L.listas.posicoes(db()), valor: itemDe(itemId).posicao || '' },
        campoData(), campoObs({ placeholder: 'Ex.: trocado microfone' }),
      ],
      botoes: [{ rotulo: 'Voltar ao estoque', acao: 'salvar', primario: true }],
      aoEnviar: async v => { await App.acao(d => L.retornarManutencao(d, itemId, v), 'Item voltou ao estoque.'); },
    });
  }

  // ---------- Descarte ----------
  const disponivelDescarte = it => (it.controle === 'unidade' && (it.status === 'EM_ESTOQUE' || it.status === 'MANUTENCAO')) || (it.controle === 'quantidade' && L.total(it) > 0);
  const opDadosApagados = Object.entries(L.DADOS_APAGADOS).map(([valor, rotulo]) => ({ valor, rotulo }));

  function camposDescarte(categoriaDe) {
    return [
      { nome: 'justificativa', rotulo: 'Justificativa', obrigatorio: true, largo: true, lista: () => L.listas.justificativas(db()), placeholder: 'Ex.: Tela quebrada/Não liga' },
      { nome: 'anoFabricacao', rotulo: 'Ano de fabricação', tipo: 'number', min: 1990, max: 2100, placeholder: 'AAAA' },
      { nome: 'valorUnit', rotulo: 'Valor estimado (unitário, R$)', tipo: 'text', placeholder: '0,00' },
      { nome: 'dadosApagados', rotulo: 'Dados apagados?', tipo: 'select', opcoes: opDadosApagados, valor: 'NAO_INFORMADO',
        dicaDinamica: v => (L.guardaDados(categoriaDe(v)) && (v.dadosApagados === 'NAO_INFORMADO' || v.dadosApagados === 'NAO'))
          ? { texto: 'Este tipo de equipamento pode conter dados pessoais (LGPD). Recomendado apagar/destruir a mídia antes do descarte.', warn: true } : null },
      { nome: 'metodo', rotulo: 'Método', placeholder: 'Ex.: formatação segura, destruição física', visivel: v => v.dadosApagados === 'SIM' },
      { nome: 'certificado', rotulo: 'Certificado / nº do lote da recicladora', largo: true, placeholder: 'Opcional' },
    ];
  }

  function abrirDescarte(itemId) {
    UI.formulario({
      titulo: 'Registrar descarte',
      subtitulo: 'Tira o item do estoque definitivamente e registra na lista de descarte.',
      campos: [
        campoItem(disponivelDescarte, { valor: itemId || '', chamarAoAbrir: true, aoMudar: (v, api) => api.set('local', localPadrao(itemDe(v.itemId))) }),
        campoInfo(),
        { nome: 'local', rotulo: 'Sai de', tipo: 'select', opcoes: opLocais, valor: 'MATRIZ', visivel: ehQtd },
        { nome: 'quantidade', rotulo: 'Quantidade', tipo: 'number', valor: '1', min: 1, passo: 1, obrigatorio: true, visivel: ehQtd },
        campoData(),
      ].concat(camposDescarte(v => { const it = itemDe(v.itemId); return it ? it.categoria : ''; }), [campoObs()]),
      botoes: [{ rotulo: 'Registrar descarte', acao: 'salvar', primario: true }],
      aoEnviar: async v => {
        const it = itemDe(v.itemId);
        const qtd = it.controle === 'unidade' ? 1 : Number(v.quantidade);
        const detalhes = [`${rotuloItem(it)} — ${qtd} unidade(s)`, `Justificativa: ${v.justificativa}`];
        if (L.guardaDados(it.categoria) && v.dadosApagados !== 'SIM' && v.dadosApagados !== 'NAO_SE_APLICA') detalhes.push(`Atenção: dados apagados = "${L.DADOS_APAGADOS[v.dadosApagados]}".`);
        const ok = await UI.confirmar({ titulo: 'Confirmar descarte', mensagem: 'O descarte tira o item do estoque e não pode ser desfeito.', detalhes, ok: 'Descartar', perigo: true });
        if (!ok) return false;
        await App.acao(d => L.descartar(d, v.itemId, v), 'Descarte registrado.');
      },
    });
  }

  function abrirEditarDescarte(movId) {
    const m = db().movimentos.find(x => x.id === movId);
    const d0 = m.descarte || {};
    const campos = camposDescarte(() => m.item?.categoria || '');
    for (const c of campos) {
      const v = d0[c.nome];
      c.valor = v === null || v === undefined ? (c.nome === 'dadosApagados' ? 'NAO_INFORMADO' : '') : String(v).replace('.', c.nome === 'valorUnit' ? ',' : '.');
    }
    UI.formulario({
      titulo: 'Editar registro de descarte',
      subtitulo: `${m.item?.categoria || ''} — ${m.item?.descricao || ''}${m.item?.serie ? ' · ' + m.item.serie : ''} (${m.quantidade} un.)`,
      campos,
      aoEnviar: async v => { await App.acao(d => L.editarDescarte(d, movId, v), 'Descarte atualizado.'); },
    });
  }

  // ---------- Edição do item ----------
  function abrirEditarItem(itemId) {
    const it = itemDe(itemId);
    const campos = [
      { nome: 'categoria', rotulo: 'Categoria', obrigatorio: true, lista: () => L.listas.categorias(db()), valor: it.categoria },
      { nome: 'descricao', rotulo: 'Descrição / modelo', obrigatorio: true, valor: it.descricao },
    ];
    if (it.controle === 'unidade') campos.push(
      { nome: 'serie', rotulo: 'Nº de série', valor: it.serie || '' },
      { nome: 'patrimonio', rotulo: 'Patrimônio', valor: it.patrimonio || '' });
    else campos.push(
      { nome: 'temSerie', rotulo: 'Tem série', tipo: 'checkbox', largo: true,
        dicaDinamica: v => v.temSerie && L.total(it) !== 1
          ? { texto: `Só é possível em item com 1 unidade (este tem ${L.total(it)}).`, warn: true }
          : { texto: 'Marque se esta peça tem nº de série. Ela passa a ser controlada individualmente.' } },
      { nome: 'serie', rotulo: 'Nº de série', obrigatorio: true, visivel: v => v.temSerie,
        dicaDinamica: v => { const o = v.serie && L.itemPorSerie(db(), v.serie, itemId); return o ? { texto: `Já cadastrado: ${o.categoria} — ${o.descricao}`, warn: true } : null; } },
      { nome: 'patrimonio', rotulo: 'Patrimônio', visivel: v => v.temSerie, dica: 'Opcional' });
    campos.push(
      { nome: 'posicao', rotulo: 'Posição', lista: () => L.listas.posicoes(db()), valor: it.posicao || '' },
      { nome: 'proprietario', rotulo: 'Proprietário', lista: () => L.listas.proprietarios(db()), valor: it.proprietario || '' },
      campoObs({ valor: it.obs || '' }));
    UI.formulario({
      titulo: 'Editar item', subtitulo: 'O saldo não é editado aqui: use Entrada, Entrega, Ajuste ou Descarte.',
      campos,
      aoEnviar: async v => {
        const campos = Object.assign({}, v);
        if (it.controle === 'quantidade') {
          if (v.temSerie) campos.controle = 'unidade';
          else { delete campos.serie; delete campos.patrimonio; }
        }
        await App.acao(d => L.editarItem(d, itemId, campos), v.temSerie ? 'Item passou a ter nº de série.' : 'Item atualizado.');
      },
    });
  }

  // ---------- Edição em lote ----------
  function erroNegocio(msg) { const e = new Error(msg); e.negocio = true; return e; }
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

  // Valor atual do campo nos selecionados, usado como dica.
  function valorAtual(lista, ler) {
    const vals = new Set(lista.map(x => limpa(ler(x))));
    if (vals.size > 1) return `Hoje: ${vals.size} valores diferentes`;
    const v = [...vals][0];
    return v ? `Hoje: ${v}` : 'Hoje: em branco';
  }

  function preenchidos(v, nomes) {
    const r = {};
    for (const n of nomes) if (limpa(v[n])) r[n] = v[n];
    if (!Object.keys(r).length) throw erroNegocio('Preencha ao menos um campo para alterar.');
    return r;
  }

  // Simula cada campo numa cópia do banco para mostrar quantos registros realmente mudam.
  function previaLote(editar, ids, campos, rotuloDe, valorDe, nomes) {
    const total = editar(structuredClone(db()), ids, campos); // também valida tudo antes da confirmação
    const detalhes = Object.keys(campos).map(k => {
      const n = editar(structuredClone(db()), ids, { [k]: campos[k] });
      const resto = ids.length - n;
      return `Alterar ${rotuloDe(k)} para "${valorDe(k)}" em ${plural(n, nomes[0], nomes[1])}` + (resto ? ` (${resto} já ${resto === 1 ? 'está' : 'estão'} assim)` : '');
    });
    return { total, detalhes };
  }

  function abrirEditarItensLote(ids, { fora = 0, aoConcluir } = {}) {
    const itens = ids.map(itemDe).filter(Boolean);
    const alvo = itens.map(i => i.id);
    const campo = (nome, rotulo, extra) => Object.assign({ nome, rotulo, placeholder: 'Não alterar', dica: valorAtual(itens, it => it[nome]) }, extra);
    UI.formulario({
      titulo: 'Editar em lote',
      subtitulo: `${plural(itens.length, 'item selecionado', 'itens selecionados')}${fora ? ` (${fora} fora do filtro atual)` : ''}. Deixe em branco o que não quiser alterar.`,
      campos: [
        campo('categoria', 'Categoria', { lista: () => L.listas.categorias(db()) }),
        campo('descricao', 'Descrição / modelo'),
        campo('posicao', 'Posição', { lista: () => L.listas.posicoes(db()) }),
        campo('proprietario', 'Proprietário', { lista: () => L.listas.proprietarios(db()) }),
        campoObs({ placeholder: 'Não alterar', dica: 'Substitui a observação de todos os selecionados. ' + valorAtual(itens, it => it.obs) }),
      ],
      botoes: [{ rotulo: 'Revisar alterações', acao: 'salvar', primario: true }],
      aoEnviar: async v => {
        const campos = preenchidos(v, L.CAMPOS_LOTE_ITEM);
        const { total, detalhes } = previaLote(L.editarItensEmLote, alvo, campos,
          k => L.CAMPOS_EDITAVEIS[k].toLowerCase(), k => limpa(campos[k]), ['item', 'itens']);
        if (!total) throw erroNegocio('Todos os selecionados já têm esses valores; nada a alterar.');
        if (fora) detalhes.push(`A seleção inclui ${plural(fora, 'item', 'itens')} fora do filtro atual.`);
        const ok = await UI.confirmar({
          titulo: 'Confirmar edição em lote',
          mensagem: `${plural(total, 'item será alterado', 'itens serão alterados')}. Cada um ganha um registro de edição no histórico.`,
          detalhes, ok: `Aplicar em ${plural(total, 'item', 'itens')}`,
        });
        if (!ok) return false;
        await App.acao(d => L.editarItensEmLote(d, alvo, campos), `${plural(total, 'item atualizado', 'itens atualizados')}.`);
        if (aoConcluir) aoConcluir();
      },
    });
  }

  function abrirEditarDescartesLote(movIds, { fora = 0, aoConcluir } = {}) {
    const movs = movIds.map(id => db().movimentos.find(m => m.id === id && m.tipo === 'DESCARTE')).filter(Boolean);
    const alvo = movs.map(m => m.id);
    const comDados = movs.filter(m => L.guardaDados(m.item?.categoria || '')).length;
    const campo = (nome, rotulo, extra) => Object.assign({ nome, rotulo, placeholder: 'Não alterar', dica: valorAtual(movs, m => m.descarte?.[nome]) }, extra);
    const avisoDados = `${plural(comDados, 'registro é', 'registros são')} de equipamento que pode guardar dados pessoais (LGPD)`;
    UI.formulario({
      titulo: 'Editar descartes em lote',
      subtitulo: `${plural(movs.length, 'registro selecionado', 'registros selecionados')}${fora ? ` (${fora} fora do filtro atual)` : ''}. Deixe em branco o que não quiser alterar.`,
      campos: [
        { nome: 'dadosApagados', rotulo: 'Dados apagados?', tipo: 'select', valor: '', opcoes: [{ valor: '', rotulo: '— não alterar —' }].concat(opDadosApagados),
          dica: valorAtual(movs, m => L.DADOS_APAGADOS[m.descarte?.dadosApagados]),
          dicaDinamica: v => comDados && v.dadosApagados && v.dadosApagados !== 'SIM' ? { texto: `Atenção: ${avisoDados}.`, warn: true } : null },
        campo('metodo', 'Método', { placeholder: 'Não alterar — ex.: formatação segura' }),
        campo('certificado', 'Certificado / nº do lote da recicladora', { largo: true }),
        campo('justificativa', 'Justificativa', { largo: true, lista: () => L.listas.justificativas(db()) }),
      ],
      botoes: [{ rotulo: 'Revisar alterações', acao: 'salvar', primario: true }],
      aoEnviar: async v => {
        const campos = preenchidos(v, L.CAMPOS_LOTE_DESCARTE);
        const rot = { dadosApagados: 'dados apagados', metodo: 'método', certificado: 'certificado', justificativa: 'justificativa' };
        const { total, detalhes } = previaLote(L.editarDescartesEmLote, alvo, campos,
          k => rot[k], k => k === 'dadosApagados' ? L.DADOS_APAGADOS[campos[k]] : limpa(campos[k]), ['registro', 'registros']);
        if (!total) throw erroNegocio('Todos os selecionados já têm esses valores; nada a alterar.');
        if (fora) detalhes.push(`A seleção inclui ${plural(fora, 'registro', 'registros')} fora do filtro atual.`);
        const escondeAlerta = comDados && campos.dadosApagados === 'NAO_SE_APLICA';
        if (escondeAlerta) detalhes.push(`Atenção: ${avisoDados}. Marcar "Não se aplica" tira esses equipamentos do alerta de sanitização.`);
        const ok = await UI.confirmar({
          titulo: 'Confirmar edição em lote',
          mensagem: `${plural(total, 'registro será alterado', 'registros serão alterados')}. Cada um ganha um registro de edição no histórico.`,
          detalhes, ok: `Aplicar em ${plural(total, 'registro', 'registros')}`, perigo: escondeAlerta,
        });
        if (!ok) return false;
        await App.acao(d => L.editarDescartesEmLote(d, alvo, campos), `${plural(total, 'descarte atualizado', 'descartes atualizados')}.`);
        if (aoConcluir) aoConcluir();
      },
    });
  }

  // ---------- Histórico ----------
  function linhaMov(m) {
    const q = m.delta ? m.delta : (m.quantidade || '');
    return h('tr', null,
      h('td', null, fmtData(m.data)),
      h('td', null, L.TIPOS[m.tipo] || m.tipo, m.importado ? h('span', { class: 'tag', title: m.origem ? `${m.origem.aba}, linha ${m.origem.linha}` : '' }, 'planilha') : null),
      h('td', null, m.local ? L.LOCAIS[m.local] : '—'),
      h('td', { class: 'num ' + (m.delta > 0 ? 'delta-pos' : m.delta < 0 ? 'delta-neg' : '') }, m.delta > 0 ? '+' + q : q),
      h('td', null, m.usuario || '—'),
      h('td', { class: 'mono' }, m.chamado || '—'),
      h('td', { class: 'quebra' }, m.obs || ''),
      h('td', { class: 'fraco' }, fmtDataHora(m.criadoEm)));
  }

  function abrirHistorico(itemId) {
    const it = itemDe(itemId);
    const movs = db().movimentos.filter(m => m.itemId === itemId).sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')) || String(b.criadoEm).localeCompare(String(a.criadoEm)));
    const dlg = h('dialog', { class: 'dlg largo' },
      h('div', { class: 'corpo-wrap' },
        h('div', { class: 'dlg-cab' }, h('h2', null, 'Histórico'), h('p', null, rotuloItem(it))),
        h('div', { class: 'dlg-corpo' },
          h('div', { class: 'info-item', style: 'margin-bottom:10px' }, infoItem(it)),
          movs.length ? h('div', { class: 'tabela-wrap' }, h('table', { class: 'tab' },
            h('thead', null, h('tr', null, ['Data', 'Tipo', 'Local', 'Qtd.', 'Usuário', 'Chamado', 'Observação', 'Registrado em'].map(t => h('th', { class: t === 'Qtd.' ? 'num' : null }, t)))),
            h('tbody', null, movs.map(linhaMov)))) : h('p', { class: 'fraco' }, 'Sem movimentações.')),
        h('div', { class: 'dlg-rodape' }, h('button', { type: 'button', class: 'btn primario', onclick: () => dlg.close() }, 'Fechar'))));
    UI.abrirDialogo(dlg);
  }

  // ---------- Toner ----------
  const opStatusToner = Object.entries(L.STATUS_TONER).map(([valor, rotulo]) => ({ valor, rotulo }));
  function abrirNovoToner() {
    UI.formulario({
      titulo: 'Adicionar toner',
      campos: [
        { nome: 'modelo', rotulo: 'Modelo', obrigatorio: true, lista: () => L.listas.modelosToner(db()), manterAoContinuar: true, placeholder: 'Ex.: W9008-EVP' },
        { nome: 'cor', rotulo: 'Cor', lista: ['Preto', 'Ciano', 'Magenta', 'Amarelo'], manterAoContinuar: true },
        { nome: 'impressora', rotulo: 'Impressora', lista: () => L.listas.impressoras(db()), manterAoContinuar: true },
        { nome: 'status', rotulo: 'Status', tipo: 'select', opcoes: opStatusToner, valor: 'NOVO', manterAoContinuar: true },
        { nome: 'quantidade', rotulo: 'Quantidade', tipo: 'number', valor: '1', min: 1, passo: 1, obrigatorio: true },
        campoData(),
      ],
      botoes: [{ rotulo: 'Adicionar e lançar outro', acao: 'outro' }, { rotulo: 'Adicionar', acao: 'salvar', primario: true }],
      aoEnviar: async (v, acao) => { await App.acao(d => L.adicionarToner(d, v), 'Toner adicionado.'); return acao === 'outro' ? 'continuar' : true; },
    });
  }
  function abrirEditarToner(id) {
    const t = db().toners.find(x => x.id === id);
    UI.formulario({
      titulo: 'Editar toner',
      campos: [
        { nome: 'modelo', rotulo: 'Modelo', obrigatorio: true, lista: () => L.listas.modelosToner(db()), valor: t.modelo },
        { nome: 'cor', rotulo: 'Cor', lista: ['Preto', 'Ciano', 'Magenta', 'Amarelo'], valor: t.cor || '' },
        { nome: 'impressora', rotulo: 'Impressora', lista: () => L.listas.impressoras(db()), valor: t.impressora || '' },
      ],
      aoEnviar: async v => { await App.acao(d => L.editarToner(d, id, v), 'Toner atualizado.'); },
    });
  }

  // ---------- Ações disponíveis por item ----------
  function acoesDoItem(it) {
    const a = [];
    if (it.controle === 'quantidade') {
      if (L.total(it) > 0) a.push({ rotulo: 'Entregar', fn: () => abrirEntrega(it.id), primaria: true });
      a.push({ rotulo: 'Entrada', fn: () => abrirEntrada(it.id), primaria: L.total(it) === 0 });
      a.push({ rotulo: 'Devolução', fn: () => abrirDevolucao(it.id) });
      a.push({ rotulo: 'Ajustar saldo (contagem)', fn: () => abrirAjuste(it.id) });
      if (L.total(it) > 0) a.push({ rotulo: 'Descartar…', fn: () => abrirDescarte(it.id), perigo: true });
    } else if (it.status === 'EM_ESTOQUE') {
      a.push({ rotulo: 'Entregar', fn: () => abrirEntrega(it.id), primaria: true });
      a.push({ rotulo: 'Enviar para manutenção', fn: () => abrirManutencao(it.id) });
      a.push({ rotulo: 'Descartar…', fn: () => abrirDescarte(it.id), perigo: true });
    } else if (it.status === 'ENTREGUE') {
      a.push({ rotulo: 'Devolver', fn: () => abrirDevolucao(it.id), primaria: true });
    } else if (it.status === 'MANUTENCAO') {
      a.push({ rotulo: 'Retornar', fn: () => abrirRetornoManutencao(it.id), primaria: true });
      a.push({ rotulo: 'Descartar…', fn: () => abrirDescarte(it.id), perigo: true });
    }
    a.push('-');
    a.push({ rotulo: 'Editar dados', fn: () => abrirEditarItem(it.id) });
    a.push({ rotulo: 'Histórico', fn: () => abrirHistorico(it.id) });
    a.push('-');
    a.push({ rotulo: 'Excluir…', fn: () => confirmarExclusaoItem(it.id), perigo: true });
    return a;
  }

  // ---------- Lixeira (exclusão reversível) ----------
  async function confirmarExclusaoItem(itemId) {
    const it = itemDe(itemId);
    let avisos;
    try { avisos = L.avisosExclusao(db(), itemId); } catch (e) { return UI.toast(e.message, 'erro'); }
    const ok = await UI.confirmar({
      titulo: 'Tem certeza que deseja excluir?', perigo: true, ok: 'Excluir',
      mensagem: `${rotuloItem(it)} vai para a Lixeira, de onde pode ser recuperado depois.`,
      detalhes: avisos,
    });
    if (!ok) return;
    try { await App.acao(d => L.excluirItem(d, itemId), 'Item enviado para a Lixeira.'); } catch (e) { UI.toast(e.message, 'erro'); }
  }

  async function confirmarExclusaoToner(id) {
    const t = db().toners.find(x => x.id === id);
    const ok = await UI.confirmar({
      titulo: 'Tem certeza que deseja excluir?', perigo: true, ok: 'Excluir',
      mensagem: `Toner ${t.modelo}${t.cor ? ' (' + t.cor + ')' : ''} — ${L.STATUS_TONER[t.status]} vai para a Lixeira, de onde pode ser recuperado depois.`,
    });
    if (!ok) return;
    try { await App.acao(d => L.excluirToner(d, id), 'Toner enviado para a Lixeira.'); } catch (e) { UI.toast(e.message, 'erro'); }
  }

  async function confirmarRestauracao(tipo, id) {
    const alvo = tipo === 'toner' ? db().toners.find(x => x.id === id) : itemDe(id);
    const nome = tipo === 'toner' ? `Toner ${alvo.modelo}` : rotuloItem(alvo);
    const ok = await UI.confirmar({ titulo: 'Restaurar da Lixeira?', mensagem: `${nome} volta para as listas com a mesma situação e saldo de quando foi excluído.`, ok: 'Restaurar' });
    if (!ok) return;
    try {
      await App.acao(d => tipo === 'toner' ? L.restaurarToner(d, id) : L.restaurarItem(d, id), 'Restaurado da Lixeira.');
    } catch (e) { UI.toast(e.message, 'erro'); }
  }

  function acoesDoToner(t) {
    return [
      { rotulo: 'Editar', fn: () => abrirEditarToner(t.id) },
      '-',
      { rotulo: 'Excluir…', fn: () => confirmarExclusaoToner(t.id), perigo: true },
    ];
  }

  App.acoes = {
    abrirEntrega, abrirDevolucao, abrirNovoItem, abrirEntrada, abrirAjuste, abrirManutencao, abrirRetornoManutencao,
    abrirDescarte, abrirEditarDescarte, abrirEditarItem, abrirEditarItensLote, abrirEditarDescartesLote, abrirHistorico, abrirNovoToner, abrirEditarToner,
    confirmarExclusaoItem, confirmarExclusaoToner, confirmarRestauracao, acoesDoToner,
    acoesDoItem, rotuloItem, situacao, linhaMov, fmtMoeda,
  };
})(globalThis.App = globalThis.App || {});

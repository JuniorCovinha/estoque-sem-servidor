/* Regras de negócio: todo saldo muda somente por meio de um movimento registrado. */
(function (App) {
  'use strict';
  const { uid, agoraISO, hojeISO, limpa, valorOuNulo, chave, normalizaChamado, numero } = App.util;

  const LOCAIS = { MATRIZ: 'Matriz', SAO_CRISTOVAO: 'São Cristóvão' };
  const STATUS = { EM_ESTOQUE: 'Em estoque', ENTREGUE: 'Entregue', MANUTENCAO: 'Manutenção', DESCARTADO: 'Descartado' };
  const TIPOS = {
    SALDO_INICIAL: 'Saldo inicial', ENTRADA: 'Entrada', ENTREGA: 'Entrega', DEVOLUCAO: 'Devolução',
    MANUTENCAO: 'Envio p/ manutenção', RETORNO_MANUTENCAO: 'Retorno da manutenção',
    DESCARTE: 'Descarte', AJUSTE: 'Ajuste', EDICAO: 'Edição', TONER: 'Toner',
  };
  const STATUS_TONER = { NOVO: 'Novo', EM_USO: 'Em uso', DESCARTE: 'Descarte' };
  const DADOS_APAGADOS = { NAO_INFORMADO: 'Não informado', SIM: 'Sim', NAO: 'Não', NAO_SE_APLICA: 'Não se aplica' };
  // Categorias que normalmente guardam dados (alerta de sanitização no descarte).
  const RE_ARMAZENAMENTO = /notebook|netbook|desktop|computador|\bhd\b|ssd|celular|tablet|servidor|smartphone|pen ?drive|\bpoco\b/;

  function novoBanco() {
    const t = agoraISO();
    return { schema: 1, criadoEm: t, atualizadoEm: t, itens: [], movimentos: [], toners: [] };
  }

  function erro(msg) { const e = new Error(msg); e.negocio = true; return e; }

  function total(item) { return (item.saldo.MATRIZ || 0) + (item.saldo.SAO_CRISTOVAO || 0); }

  function snap(item) {
    return item ? { categoria: item.categoria, descricao: item.descricao, serie: item.serie } : null;
  }

  function getItem(db, id) {
    const it = db.itens.find(i => i.id === id);
    if (!it) throw erro('Item não encontrado.');
    return it;
  }

  function checaLocal(local) {
    if (!LOCAIS[local]) throw erro('Selecione o local (Matriz ou São Cristóvão).');
  }

  function checaQtd(q) {
    const n = numero(q, NaN);
    if (!Number.isInteger(n) || n <= 0) throw erro('Informe uma quantidade inteira maior que zero.');
    return n;
  }

  function checaData(d) {
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw erro('Informe uma data válida.');
    return d;
  }

  function itemPorSerie(db, serie, excetoId) {
    const k = chave(serie);
    if (!k) return null;
    return db.itens.find(i => i.id !== excetoId && i.serie && chave(i.serie) === k) || null;
  }

  function registrar(db, mov) {
    const m = Object.assign({
      id: uid(), tipo: null, itemId: null, item: null, local: null, delta: 0, quantidade: 0,
      usuario: null, chamado: null, data: hojeISO(), obs: null, importado: false, criadoEm: agoraISO(),
    }, mov);
    db.movimentos.push(m);
    db.atualizadoEm = m.criadoEm;
    return m;
  }

  function toque(db, item) { item.atualizadoEm = agoraISO(); db.atualizadoEm = item.atualizadoEm; }

  // ---------- Itens ----------

  function cadastrarItem(db, d) {
    const categoria = limpa(d.categoria);
    const descricao = limpa(d.descricao);
    if (!categoria) throw erro('Informe a categoria.');
    if (!descricao) throw erro('Informe a descrição/modelo.');
    const controle = d.controle === 'unidade' ? 'unidade' : 'quantidade';
    const serie = valorOuNulo(d.serie);
    if (serie) {
      const outro = itemPorSerie(db, serie);
      if (outro) throw erro(`Já existe um item com o nº de série ${serie}: ${outro.categoria} — ${outro.descricao}.`);
    }
    checaLocal(d.local);
    const data = checaData(d.data || hojeISO());
    const qtd = controle === 'unidade' ? 1 : checaQtd(d.quantidade);
    const t = agoraISO();
    const item = {
      id: uid(), controle, categoria, descricao, serie: controle === 'unidade' ? serie : null,
      patrimonio: valorOuNulo(d.patrimonio), proprietario: limpa(d.proprietario) || 'Solar Cuidados',
      posicao: valorOuNulo(d.posicao), status: 'EM_ESTOQUE', local: d.local,
      saldo: { MATRIZ: 0, SAO_CRISTOVAO: 0 }, responsavelAtual: null, saldoMinimo: null,
      obs: valorOuNulo(d.obs), criadoEm: t, atualizadoEm: t, origem: null,
    };
    item.saldo[d.local] = qtd;
    db.itens.push(item);
    registrar(db, {
      tipo: 'ENTRADA', itemId: item.id, item: snap(item), local: d.local, delta: qtd, quantidade: qtd,
      chamado: normalizaChamado(d.chamado), data, obs: valorOuNulo(d.obs) || 'Cadastro do item',
    });
    return item;
  }

  const CAMPOS_EDITAVEIS = { categoria: 'Categoria', descricao: 'Descrição', serie: 'Nº de série', patrimonio: 'Patrimônio', proprietario: 'Proprietário', posicao: 'Posição', obs: 'Observação' };

  // Calcula (e valida) as alterações sem mexer no item.
  function alteracoesItem(db, item, campos) {
    const alteracoes = [];
    for (const [campo, valor] of Object.entries(campos)) {
      if (!CAMPOS_EDITAVEIS[campo]) continue;
      const novo = ((campo === 'categoria' || campo === 'descricao' || campo === 'proprietario') ? limpa(valor) : valorOuNulo(valor)) || null;
      if ((campo === 'categoria' || campo === 'descricao') && !novo) throw erro(`${CAMPOS_EDITAVEIS[campo]} não pode ficar vazio.`);
      if (campo === 'serie') {
        if (item.controle !== 'unidade' && novo) throw erro('Itens controlados por quantidade não têm nº de série.');
        const outro = novo && itemPorSerie(db, novo, item.id);
        if (outro) throw erro(`Nº de série ${novo} já pertence a: ${outro.categoria} — ${outro.descricao}.`);
      }
      const antigo = item[campo] ?? null;
      if (antigo === novo) continue;
      alteracoes.push({ campo, rotulo: CAMPOS_EDITAVEIS[campo], de: antigo, para: novo });
    }
    return alteracoes;
  }

  // Item por quantidade que na verdade tem nº de série: só é possível com exatamente 1 unidade,
  // porque a série identifica uma única peça.
  function validarConversaoParaUnidade(db, item, serie) {
    const t = total(item);
    if (t === 0) throw erro('Item sem saldo: não há unidade para identificar com nº de série.');
    if (t > 1) throw erro(`Este item tem ${t} unidades. O nº de série identifica uma única peça: use "Ajustar saldo" para tirar 1 unidade e cadastre-a em "+ Novo item" com a série.`);
    if (!valorOuNulo(serie)) throw erro('Informe o nº de série.');
  }

  function editarItem(db, id, campos) {
    const item = getItem(db, id);
    const converter = campos.controle === 'unidade' && item.controle === 'quantidade';
    if (converter) validarConversaoParaUnidade(db, item, campos.serie);
    // Valida tudo antes de alterar qualquer campo (na conversão, valida já como item com série).
    const alteracoes = alteracoesItem(db, converter ? Object.assign({}, item, { controle: 'unidade' }) : item, campos);
    if (converter) {
      alteracoes.unshift({ campo: 'controle', rotulo: 'Controle', de: 'Quantidade', para: 'Unidade (com nº de série)' });
      item.controle = 'unidade';
      item.local = item.saldo.MATRIZ > 0 ? 'MATRIZ' : 'SAO_CRISTOVAO';
      item.status = 'EM_ESTOQUE';
    }
    if (!alteracoes.length) return null;
    for (const a of alteracoes) if (a.campo !== 'controle') item[a.campo] = a.para;
    toque(db, item);
    return registrar(db, {
      tipo: 'EDICAO', itemId: id, item: snap(item), alteracoes,
      obs: alteracoes.map(a => `${a.rotulo}: "${a.de ?? ''}" → "${a.para ?? ''}"`).join('; '),
    });
  }

  function podeExcluir(db, id) {
    const movs = db.movimentos.filter(m => m.itemId === id);
    return movs.every(m => m.tipo === 'ENTRADA' || m.tipo === 'SALDO_INICIAL' || m.tipo === 'EDICAO') &&
      movs.filter(m => m.tipo === 'ENTRADA' || m.tipo === 'SALDO_INICIAL').length <= 1;
  }

  function excluirItem(db, id) {
    getItem(db, id);
    if (!podeExcluir(db, id)) throw erro('Este item já tem movimentações. Use Ajuste ou Descarte em vez de excluir.');
    db.itens = db.itens.filter(i => i.id !== id);
    db.movimentos = db.movimentos.filter(m => m.itemId !== id);
    db.atualizadoEm = agoraISO();
  }

  // ---------- Movimentações ----------

  function entrada(db, id, d) {
    const item = getItem(db, id);
    if (item.controle !== 'quantidade') throw erro('Itens com nº de série entram por cadastro ou devolução.');
    checaLocal(d.local);
    const q = checaQtd(d.quantidade);
    item.saldo[d.local] += q;
    toque(db, item);
    return registrar(db, {
      tipo: 'ENTRADA', itemId: id, item: snap(item), local: d.local, delta: q, quantidade: q,
      chamado: normalizaChamado(d.chamado), data: checaData(d.data), obs: valorOuNulo(d.obs),
    });
  }

  function entregar(db, id, d) {
    const item = getItem(db, id);
    const usuario = limpa(d.usuario);
    if (!usuario) throw erro('Informe para quem o item foi entregue.');
    const data = checaData(d.data);
    let local, q;
    if (item.controle === 'unidade') {
      if (item.status !== 'EM_ESTOQUE') throw erro(`Item está "${STATUS[item.status]}" e não pode ser entregue.`);
      local = item.local; q = 1;
      if (item.saldo[local] < 1) throw erro('Item sem saldo no local registrado. Rode a verificação de consistência.');
      item.saldo[local] -= 1;
      item.status = 'ENTREGUE';
      item.responsavelAtual = usuario;
    } else {
      checaLocal(d.local); local = d.local; q = checaQtd(d.quantidade);
      if (item.saldo[local] < q) throw erro(`Saldo insuficiente em ${LOCAIS[local]}: disponível ${item.saldo[local]}.`);
      item.saldo[local] -= q;
    }
    toque(db, item);
    return registrar(db, {
      tipo: 'ENTREGA', itemId: id, item: snap(item), local, delta: -q, quantidade: q, usuario,
      chamado: normalizaChamado(d.chamado), data, obs: valorOuNulo(d.obs),
    });
  }

  function devolver(db, id, d) {
    const item = getItem(db, id);
    checaLocal(d.local);
    const data = checaData(d.data);
    let q;
    if (item.controle === 'unidade') {
      if (item.status !== 'ENTREGUE') throw erro(`Item está "${STATUS[item.status]}"; só itens entregues podem ser devolvidos.`);
      q = 1;
      item.local = d.local;
      item.saldo[d.local] += 1;
      item.status = d.manutencao ? 'MANUTENCAO' : 'EM_ESTOQUE';
      item.responsavelAtual = null;
      if (valorOuNulo(d.posicao)) item.posicao = valorOuNulo(d.posicao);
    } else {
      q = checaQtd(d.quantidade);
      item.saldo[d.local] += q;
    }
    toque(db, item);
    return registrar(db, {
      tipo: 'DEVOLUCAO', itemId: id, item: snap(item), local: d.local, delta: q, quantidade: q,
      usuario: valorOuNulo(d.usuario), chamado: normalizaChamado(d.chamado), data,
      obs: [valorOuNulo(d.obs), d.manutencao ? 'Devolvido com defeito: enviado para manutenção' : null].filter(Boolean).join(' — ') || null,
    });
  }

  function enviarManutencao(db, id, d) {
    const item = getItem(db, id);
    if (item.controle !== 'unidade') throw erro('Manutenção está disponível apenas para itens com controle individual.');
    if (item.status !== 'EM_ESTOQUE') throw erro(`Item está "${STATUS[item.status]}".`);
    item.status = 'MANUTENCAO';
    toque(db, item);
    return registrar(db, {
      tipo: 'MANUTENCAO', itemId: id, item: snap(item), local: item.local,
      chamado: normalizaChamado(d.chamado), data: checaData(d.data), obs: valorOuNulo(d.obs),
    });
  }

  function retornarManutencao(db, id, d) {
    const item = getItem(db, id);
    if (item.status !== 'MANUTENCAO') throw erro('Item não está em manutenção.');
    item.status = 'EM_ESTOQUE';
    if (valorOuNulo(d.posicao)) item.posicao = valorOuNulo(d.posicao);
    toque(db, item);
    return registrar(db, {
      tipo: 'RETORNO_MANUTENCAO', itemId: id, item: snap(item), local: item.local,
      data: checaData(d.data), obs: valorOuNulo(d.obs),
    });
  }

  function dadosDescarte(d) {
    const valorUnit = d.valorUnit === '' || d.valorUnit === null || d.valorUnit === undefined ? null : numero(d.valorUnit, NaN);
    if (valorUnit !== null && (!isFinite(valorUnit) || valorUnit < 0)) throw erro('Valor estimado inválido.');
    const ano = valorOuNulo(d.anoFabricacao);
    if (ano && !/^\d{4}$/.test(ano)) throw erro('Ano de fabricação deve ter 4 dígitos.');
    const dadosApagados = Object.hasOwn(DADOS_APAGADOS, d.dadosApagados ?? '') ? d.dadosApagados : 'NAO_INFORMADO';
    return {
      justificativa: valorOuNulo(d.justificativa), anoFabricacao: ano, valorUnit,
      dadosApagados, metodo: valorOuNulo(d.metodo), certificado: valorOuNulo(d.certificado),
    };
  }

  function descartar(db, id, d) {
    const item = getItem(db, id);
    if (!valorOuNulo(d.justificativa)) throw erro('Informe a justificativa do descarte.');
    const data = checaData(d.data);
    const info = dadosDescarte(d);
    let local, q;
    if (item.controle === 'unidade') {
      if (item.status === 'ENTREGUE') throw erro('Item está entregue. Registre a devolução antes de descartar.');
      if (item.status === 'DESCARTADO') throw erro('Item já descartado.');
      local = item.local; q = 1;
      const tinhaSaldo = item.saldo[local] > 0;
      if (tinhaSaldo) item.saldo[local] -= 1;
      item.status = 'DESCARTADO';
      toque(db, item);
      return registrar(db, {
        tipo: 'DESCARTE', itemId: id, item: snap(item), local, delta: tinhaSaldo ? -1 : 0, quantidade: q,
        data, obs: valorOuNulo(d.obs), descarte: info,
      });
    }
    checaLocal(d.local); local = d.local; q = checaQtd(d.quantidade);
    if (item.saldo[local] < q) throw erro(`Saldo insuficiente em ${LOCAIS[local]}: disponível ${item.saldo[local]}.`);
    item.saldo[local] -= q;
    toque(db, item);
    return registrar(db, {
      tipo: 'DESCARTE', itemId: id, item: snap(item), local, delta: -q, quantidade: q,
      data, obs: valorOuNulo(d.obs), descarte: info,
    });
  }

  const ROTULOS_DESCARTE = { justificativa: 'Justificativa', anoFabricacao: 'Ano', valorUnit: 'Valor unitário', dadosApagados: 'Dados apagados', metodo: 'Método', certificado: 'Certificado' };

  function getDescarte(db, movId) {
    const mov = db.movimentos.find(m => m.id === movId && m.tipo === 'DESCARTE');
    if (!mov) throw erro('Registro de descarte não encontrado.');
    return mov;
  }

  // Calcula (e valida) o novo registro sem alterar o movimento.
  function alteracoesDescarte(mov, campos) {
    const atual = mov.descarte || {};
    const novo = dadosDescarte(Object.assign({}, atual, campos));
    const alteracoes = [];
    for (const k of Object.keys(ROTULOS_DESCARTE)) {
      if ((atual[k] ?? null) !== (novo[k] ?? null)) alteracoes.push({ campo: k, rotulo: ROTULOS_DESCARTE[k], de: atual[k] ?? null, para: novo[k] ?? null });
    }
    return { novo, alteracoes };
  }

  function editarDescarte(db, movId, campos) {
    const mov = getDescarte(db, movId);
    const { novo, alteracoes } = alteracoesDescarte(mov, campos);
    if (!alteracoes.length) return null;
    mov.descarte = novo;
    const fmt = (k, v) => k === 'dadosApagados' ? DADOS_APAGADOS[v] : (v ?? '');
    return registrar(db, {
      tipo: 'EDICAO', itemId: mov.itemId, item: mov.item, alteracoes, refMovimento: mov.id,
      obs: 'Descarte: ' + alteracoes.map(a => `${a.rotulo}: "${fmt(a.campo, a.de)}" → "${fmt(a.campo, a.para)}"`).join('; '),
    });
  }

  // ---------- Edição em lote ----------
  // Campo vazio ou ausente = não alterar. Tudo é validado antes da primeira alteração;
  // cada registro alterado ganha seu próprio movimento EDICAO (ligados pelo mesmo "lote").
  const CAMPOS_LOTE_ITEM = ['categoria', 'descricao', 'posicao', 'proprietario', 'obs'];
  const CAMPOS_LOTE_DESCARTE = ['justificativa', 'dadosApagados', 'metodo', 'certificado'];

  function idsLote(ids) {
    const lista = [...new Set(ids || [])];
    if (!lista.length) throw erro('Nenhum registro selecionado.');
    return lista;
  }

  function camposLote(campos, permitidos, rotulos) {
    const r = {};
    for (const [k, v] of Object.entries(campos || {})) {
      if (!limpa(v)) continue;
      if (!permitidos.includes(k)) throw erro(`${rotulos[k] || k} não pode ser alterado em lote.`);
      r[k] = v;
    }
    if (!Object.keys(r).length) throw erro('Preencha ao menos um campo para alterar.');
    return r;
  }

  function editarItensEmLote(db, ids, campos) {
    const lista = idsLote(ids);
    const c = camposLote(campos, CAMPOS_LOTE_ITEM, CAMPOS_EDITAVEIS);
    const mudam = lista.map(id => getItem(db, id)).filter(it => alteracoesItem(db, it, c).length);
    const lote = uid();
    for (const it of mudam) {
      const m = editarItem(db, it.id, c);
      m.lote = lote;
      m.obs = `Edição em lote (${mudam.length} ${mudam.length === 1 ? 'item' : 'itens'}) — ${m.obs}`;
    }
    return mudam.length;
  }

  function editarDescartesEmLote(db, movIds, campos) {
    const lista = idsLote(movIds);
    const c = camposLote(campos, CAMPOS_LOTE_DESCARTE, ROTULOS_DESCARTE);
    if (c.dadosApagados && !Object.hasOwn(DADOS_APAGADOS, c.dadosApagados)) throw erro('Opção de "Dados apagados" inválida.');
    const mudam = lista.map(id => getDescarte(db, id)).filter(m => alteracoesDescarte(m, c).alteracoes.length);
    const lote = uid();
    for (const mov of mudam) {
      const m = editarDescarte(db, mov.id, c);
      m.lote = lote;
      m.obs = `Edição em lote (${mudam.length} ${mudam.length === 1 ? 'registro' : 'registros'}) — ${m.obs}`;
    }
    return mudam.length;
  }

  function ajustar(db, id, d) {
    const item = getItem(db, id);
    if (item.controle !== 'quantidade') throw erro('Ajuste de quantidade vale apenas para itens controlados por quantidade.');
    checaLocal(d.local);
    const nova = numero(d.novaQuantidade, NaN);
    if (!Number.isInteger(nova) || nova < 0) throw erro('Informe a quantidade contada (inteiro ≥ 0).');
    const motivo = valorOuNulo(d.motivo);
    if (!motivo) throw erro('Informe o motivo do ajuste.');
    const delta = nova - item.saldo[d.local];
    if (delta === 0) throw erro('A quantidade informada é igual ao saldo atual.');
    item.saldo[d.local] = nova;
    toque(db, item);
    return registrar(db, {
      tipo: 'AJUSTE', itemId: id, item: snap(item), local: d.local, delta, quantidade: Math.abs(delta),
      data: checaData(d.data || hojeISO()), obs: motivo,
    });
  }

  // ---------- Toner ----------

  function snapToner(t) { return { categoria: 'Toner', descricao: t.modelo, serie: null }; }

  function adicionarToner(db, d) {
    const modelo = limpa(d.modelo);
    if (!modelo) throw erro('Informe o modelo do toner.');
    const status = STATUS_TONER[d.status] ? d.status : 'NOVO';
    const q = checaQtd(d.quantidade || 1);
    const criados = [];
    for (let i = 0; i < q; i++) {
      const t = { id: uid(), modelo, cor: valorOuNulo(d.cor), impressora: valorOuNulo(d.impressora), status, obs: valorOuNulo(d.obs), origem: null };
      db.toners.push(t);
      criados.push(t);
    }
    registrar(db, {
      tipo: 'TONER', tonerId: criados[0].id, item: snapToner(criados[0]), quantidade: q,
      data: checaData(d.data || hojeISO()), obs: `Cadastro de ${q} toner(s) — ${STATUS_TONER[status]}`,
    });
    return criados;
  }

  function mudarStatusToner(db, id, status, obs) {
    const t = db.toners.find(x => x.id === id);
    if (!t) throw erro('Toner não encontrado.');
    if (!STATUS_TONER[status]) throw erro('Status inválido.');
    if (t.status === status) return null;
    const de = t.status;
    t.status = status;
    return registrar(db, {
      tipo: 'TONER', tonerId: id, item: snapToner(t), quantidade: 1,
      obs: `${STATUS_TONER[de]} → ${STATUS_TONER[status]}${obs ? ' — ' + obs : ''}`,
    });
  }

  function editarToner(db, id, campos) {
    const t = db.toners.find(x => x.id === id);
    if (!t) throw erro('Toner não encontrado.');
    const rot = { modelo: 'Modelo', cor: 'Cor', impressora: 'Impressora' };
    const alteracoes = [];
    for (const k of Object.keys(rot)) {
      if (!(k in campos)) continue;
      const novo = k === 'modelo' ? limpa(campos[k]) : valorOuNulo(campos[k]);
      if (k === 'modelo' && !novo) throw erro('Modelo não pode ficar vazio.');
      if ((t[k] ?? null) !== (novo ?? null)) { alteracoes.push({ campo: k, rotulo: rot[k], de: t[k] ?? null, para: novo ?? null }); t[k] = novo; }
    }
    if (!alteracoes.length) return null;
    return registrar(db, {
      tipo: 'EDICAO', tonerId: id, item: snapToner(t), alteracoes,
      obs: alteracoes.map(a => `${a.rotulo}: "${a.de ?? ''}" → "${a.para ?? ''}"`).join('; '),
    });
  }

  // ---------- Consultas ----------

  function uniq(arr) {
    const m = new Map();
    for (const v of arr) { const s = limpa(v); if (s && !m.has(chave(s))) m.set(chave(s), s); }
    return [...m.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  const listas = {
    categorias: db => uniq(db.itens.map(i => i.categoria)),
    posicoes: db => uniq(db.itens.map(i => i.posicao)),
    usuarios: db => uniq(db.movimentos.map(m => m.usuario).concat(db.itens.map(i => i.responsavelAtual))),
    proprietarios: db => uniq(['Solar Cuidados'].concat(db.itens.map(i => i.proprietario))),
    impressoras: db => uniq(db.toners.map(t => t.impressora)),
    modelosToner: db => uniq(db.toners.map(t => t.modelo)),
    justificativas: db => uniq(db.movimentos.filter(m => m.descarte).map(m => m.descarte.justificativa)),
  };

  function categoriaUsaSerie(db, categoria) {
    const k = chave(categoria);
    const doGrupo = db.itens.filter(i => chave(i.categoria) === k);
    if (!doGrupo.length) return null;
    return doGrupo.filter(i => i.controle === 'unidade').length >= doGrupo.length / 2;
  }

  function guardaDados(categoria) { return RE_ARMAZENAMENTO.test(chave(categoria)); }

  function verificarConsistencia(db) {
    const problemas = [];
    const soma = new Map();
    for (const m of db.movimentos) {
      if (!m.itemId || !m.local || !m.delta) continue;
      const k = m.itemId + '|' + m.local;
      soma.set(k, (soma.get(k) || 0) + m.delta);
    }
    const series = new Map();
    for (const it of db.itens) {
      const nome = `${it.categoria} — ${it.descricao}${it.serie ? ' (' + it.serie + ')' : ''}`;
      for (const loc of Object.keys(LOCAIS)) {
        const esperado = soma.get(it.id + '|' + loc) || 0;
        if (esperado !== it.saldo[loc]) problemas.push({ itemId: it.id, msg: `${nome}: saldo em ${LOCAIS[loc]} é ${it.saldo[loc]}, mas o histórico soma ${esperado}.` });
        if (it.saldo[loc] < 0) problemas.push({ itemId: it.id, msg: `${nome}: saldo negativo em ${LOCAIS[loc]}.` });
      }
      if (it.controle === 'unidade') {
        const t = total(it);
        const deveTer = (it.status === 'EM_ESTOQUE' || it.status === 'MANUTENCAO') ? 1 : 0;
        if (t !== deveTer) problemas.push({ itemId: it.id, msg: `${nome}: situação "${STATUS[it.status]}" com saldo ${t}.` });
        if (it.serie) {
          const k = chave(it.serie);
          if (series.has(k)) problemas.push({ itemId: it.id, msg: `Nº de série ${it.serie} repetido em mais de um item.` });
          series.set(k, it.id);
        }
      }
    }
    return problemas;
  }

  App.ledger = {
    LOCAIS, STATUS, TIPOS, STATUS_TONER, DADOS_APAGADOS, CAMPOS_EDITAVEIS, CAMPOS_LOTE_ITEM, CAMPOS_LOTE_DESCARTE,
    novoBanco, total, snap, getItem, itemPorSerie, registrar,
    cadastrarItem, editarItem, editarItensEmLote, podeExcluir, excluirItem,
    entrada, entregar, devolver, enviarManutencao, retornarManutencao, descartar, editarDescarte, editarDescartesEmLote, ajustar,
    adicionarToner, mudarStatusToner, editarToner,
    listas, categoriaUsaSerie, guardaDados, verificarConsistencia,
  };
})(globalThis.App = globalThis.App || {});

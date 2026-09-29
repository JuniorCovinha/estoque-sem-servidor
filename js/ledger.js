/* Regras de negócio: todo saldo muda somente por meio de um movimento registrado. */
(function (App) {
  'use strict';
  const { uid, agoraISO, hojeISO, limpa, valorOuNulo, chave, normalizaChamado, numero, autorAtual } = App.util;

  const LOCAIS = { MATRIZ: 'Matriz', SAO_CRISTOVAO: 'São Cristóvão' };
  const STATUS = { EM_ESTOQUE: 'Em estoque', ENTREGUE: 'Entregue', MANUTENCAO: 'Manutenção', DESCARTADO: 'Descartado' };
  const TIPOS = {
    SALDO_INICIAL: 'Saldo inicial', ENTRADA: 'Entrada', ENTREGA: 'Entrega', DEVOLUCAO: 'Devolução',
    MANUTENCAO: 'Envio p/ manutenção', RETORNO_MANUTENCAO: 'Retorno da manutenção',
    DESCARTE: 'Descarte', AJUSTE: 'Ajuste', EDICAO: 'Edição', TONER: 'Toner',
    EXCLUSAO: 'Exclusão (lixeira)', RESTAURACAO: 'Restauração da lixeira', PESSOA: 'Cadastro de pessoas',
  };
  const STATUS_TONER = { NOVO: 'Novo', EM_USO: 'Em uso', DESCARTE: 'Descarte' };
  const DADOS_APAGADOS = { NAO_INFORMADO: 'Não informado', SIM: 'Sim', NAO: 'Não', NAO_SE_APLICA: 'Não se aplica' };
  // Categorias que normalmente guardam dados (alerta de sanitização no descarte).
  const RE_ARMAZENAMENTO = /notebook|netbook|desktop|computador|\bhd\b|ssd|celular|tablet|servidor|smartphone|pen ?drive|\bpoco\b/;

  function novoBanco() {
    const t = agoraISO();
    return { schema: 1, criadoEm: t, atualizadoEm: t, itens: [], movimentos: [], toners: [], pessoas: [] };
  }

  function erro(msg) { const e = new Error(msg); e.negocio = true; return e; }

  function total(item) { return (item.saldo.MATRIZ || 0) + (item.saldo.SAO_CRISTOVAO || 0); }

  function snap(item) {
    return item ? { categoria: item.categoria, descricao: item.descricao, serie: item.serie } : null;
  }

  // Itens e toners excluídos ficam na Lixeira (exclusão reversível): somem das listas, mas o registro e o histórico ficam.
  const ativo = x => !x.excluido;
  const itensAtivos = db => db.itens.filter(ativo);
  const tonersAtivos = db => db.toners.filter(ativo);

  function getItem(db, id) {
    const it = db.itens.find(i => i.id === id);
    if (!it) throw erro('Item não encontrado.');
    if (it.excluido) throw erro('Este item está na Lixeira. Restaure-o antes de alterar.');
    return it;
  }

  // Texto para mensagens de série repetida: avisa quando o outro item está na Lixeira.
  const descreveOutro = o => `${o.categoria} — ${o.descricao}${o.excluido ? ' (está na Lixeira: restaure-o em vez de cadastrar de novo)' : ''}`;

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
      usuario: null, pessoaId: null, chamado: null, data: hojeISO(), obs: null, importado: false, criadoEm: agoraISO(),
      autor: autorAtual(), // quem registrou: vem da operação em execução (null na importação)
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
      if (outro) throw erro(`Já existe um item com o nº de série ${serie}: ${descreveOutro(outro)}.`);
    }
    checaLocal(d.local);
    const data = checaData(d.data || hojeISO());
    const qtd = controle === 'unidade' ? 1 : checaQtd(d.quantidade);
    const t = agoraISO();
    const item = {
      id: uid(), controle, categoria, descricao, serie: controle === 'unidade' ? serie : null,
      patrimonio: valorOuNulo(d.patrimonio), proprietario: limpa(d.proprietario) || 'Solar Cuidados',
      posicao: valorOuNulo(d.posicao), status: 'EM_ESTOQUE', local: d.local,
      saldo: { MATRIZ: 0, SAO_CRISTOVAO: 0 }, responsavelAtual: null, responsavelId: null, saldoMinimo: null,
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
        if (outro) throw erro(`Nº de série ${novo} já pertence a: ${descreveOutro(outro)}.`);
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

  // O que o usuário precisa saber antes de mandar um item para a Lixeira.
  function avisosExclusao(db, id) {
    const it = getItem(db, id);
    const avisos = [];
    const t = total(it);
    if (it.controle === 'unidade' && it.status === 'ENTREGUE') avisos.push(`Está entregue${it.responsavelAtual ? ' a ' + it.responsavelAtual : ''}: deixará de aparecer em "Entregues" e na Devolução.`);
    else if (t > 0) avisos.push(`Tem ${t} unidade(s) em estoque, que deixarão de contar nos totais.`);
    const movs = db.movimentos.filter(m => m.itemId === id).length;
    if (movs > 1) avisos.push(`Tem ${movs} movimentações no histórico (continuam guardadas).`);
    return avisos;
  }

  function excluirItem(db, id, motivo) {
    const it = getItem(db, id);
    const situacao = it.controle === 'unidade' ? STATUS[it.status] : `saldo ${total(it)}`;
    it.excluido = { em: agoraISO(), motivo: valorOuNulo(motivo), situacao };
    toque(db, it);
    return registrar(db, {
      tipo: 'EXCLUSAO', itemId: id, item: snap(it),
      obs: `Enviado para a Lixeira (${situacao})${it.excluido.motivo ? ' — ' + it.excluido.motivo : ''}`,
    });
  }

  function restaurarItem(db, id) {
    const it = db.itens.find(i => i.id === id);
    if (!it) throw erro('Item não encontrado.');
    if (!it.excluido) throw erro('Este item não está na Lixeira.');
    const k = it.serie && chave(it.serie);
    const conflito = k && db.itens.find(i => i.id !== id && !i.excluido && i.serie && chave(i.serie) === k);
    if (conflito) throw erro(`Não é possível restaurar: o nº de série ${it.serie} está em uso por ${conflito.categoria} — ${conflito.descricao}.`);
    it.excluido = null;
    toque(db, it);
    return registrar(db, { tipo: 'RESTAURACAO', itemId: id, item: snap(it), obs: 'Restaurado da Lixeira' });
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
    // Com pessoaId o nome vem do cadastro; sem ele continua aceitando texto (compatibilidade).
    let pessoa = null, usuario;
    if (d.pessoaId) {
      pessoa = getPessoa(db, d.pessoaId);
      if (!pessoa.ativo) throw erro(`${pessoa.nome} está inativa e não pode receber entregas. Reative o cadastro em Pessoas.`);
      usuario = pessoa.nome;
    } else {
      usuario = limpa(d.usuario);
      if (!usuario) throw erro('Informe para quem o item foi entregue.');
    }
    const data = checaData(d.data);
    let local, q;
    if (item.controle === 'unidade') {
      if (item.status !== 'EM_ESTOQUE') throw erro(`Item está "${STATUS[item.status]}" e não pode ser entregue.`);
      local = item.local; q = 1;
      if (item.saldo[local] < 1) throw erro('Item sem saldo no local registrado. Rode a verificação de consistência.');
      item.saldo[local] -= 1;
      item.status = 'ENTREGUE';
      item.responsavelAtual = usuario;
      item.responsavelId = pessoa ? pessoa.id : null;
    } else {
      checaLocal(d.local); local = d.local; q = checaQtd(d.quantidade);
      if (item.saldo[local] < q) throw erro(`Saldo insuficiente em ${LOCAIS[local]}: disponível ${item.saldo[local]}.`);
      item.saldo[local] -= q;
    }
    toque(db, item);
    return registrar(db, {
      tipo: 'ENTREGA', itemId: id, item: snap(item), local, delta: -q, quantidade: q, usuario, pessoaId: pessoa ? pessoa.id : null,
      chamado: normalizaChamado(d.chamado), data, obs: valorOuNulo(d.obs),
    });
  }

  function devolver(db, id, d) {
    const item = getItem(db, id);
    checaLocal(d.local);
    const data = checaData(d.data);
    const pessoa = d.pessoaId ? getPessoa(db, d.pessoaId) : null; // quem devolve pode estar inativa (ex-colaborador)
    let q;
    if (item.controle === 'unidade') {
      if (item.status !== 'ENTREGUE') throw erro(`Item está "${STATUS[item.status]}"; só itens entregues podem ser devolvidos.`);
      q = 1;
      item.local = d.local;
      item.saldo[d.local] += 1;
      item.status = d.manutencao ? 'MANUTENCAO' : 'EM_ESTOQUE';
      item.responsavelAtual = null;
      item.responsavelId = null;
      if (valorOuNulo(d.posicao)) item.posicao = valorOuNulo(d.posicao);
    } else {
      q = checaQtd(d.quantidade);
      item.saldo[d.local] += q;
    }
    toque(db, item);
    return registrar(db, {
      tipo: 'DEVOLUCAO', itemId: id, item: snap(item), local: d.local, delta: q, quantidade: q,
      usuario: pessoa ? pessoa.nome : valorOuNulo(d.usuario), pessoaId: pessoa ? pessoa.id : null,
      chamado: normalizaChamado(d.chamado), data,
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

  function getToner(db, id) {
    const t = db.toners.find(x => x.id === id);
    if (!t) throw erro('Toner não encontrado.');
    if (t.excluido) throw erro('Este toner está na Lixeira. Restaure-o antes de alterar.');
    return t;
  }

  function excluirToner(db, id, motivo) {
    const t = getToner(db, id);
    t.excluido = { em: agoraISO(), motivo: valorOuNulo(motivo), situacao: STATUS_TONER[t.status] };
    return registrar(db, { tipo: 'EXCLUSAO', tonerId: id, item: snapToner(t), obs: `Toner enviado para a Lixeira (${STATUS_TONER[t.status]})` });
  }

  function restaurarToner(db, id) {
    const t = db.toners.find(x => x.id === id);
    if (!t) throw erro('Toner não encontrado.');
    if (!t.excluido) throw erro('Este toner não está na Lixeira.');
    t.excluido = null;
    return registrar(db, { tipo: 'RESTAURACAO', tonerId: id, item: snapToner(t), obs: 'Toner restaurado da Lixeira' });
  }

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
    const t = getToner(db, id);
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
    const t = getToner(db, id);
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

  // Preenche a cor dos toners importados a partir da planilha (Dados e backup). Só toners com cor vazia
  // (e fora da Lixeira) são alterados; os demais são ignorados, para a operação ser reaplicável.
  // d = { arquivo, cores: [{ id, cor, linha, rgb }] }. Retorna quantos toners mudaram.
  function atualizarCoresToners(db, d) {
    const cores = d && Array.isArray(d.cores) ? d.cores : null;
    if (!cores || !cores.length) throw erro('Nenhuma cor para atualizar.');
    for (const c of cores) if (!c || typeof c.id !== 'string' || !valorOuNulo(c.cor)) throw erro('Lista de cores inválida.');
    const arquivo = limpa(d.arquivo);
    let n = 0;
    for (const c of cores) {
      const t = db.toners.find(x => x.id === c.id);
      if (!t || t.cor || t.excluido) continue; // não sobrescreve cor preenchida
      const m = editarToner(db, c.id, { cor: c.cor });
      if (!m) continue;
      m.obs += ` — pela planilha "${arquivo}" (linha ${c.linha}${c.rgb ? ', preenchimento #' + c.rgb : ''})`;
      n++;
    }
    return n;
  }

  // ---------- Pessoas ----------
  // Cadastro de colaboradores e setores que recebem itens (não são usuários da aplicação).
  // O modelo já prevê a ligação futura com o diretório Microsoft: origem 'diretorio' e entraId.
  // Todas as mutações recebem (db, args) com args serializável em JSON; ids novos nascem aqui dentro.

  const TIPOS_PESSOA = { PESSOA: 'Pessoa', SETOR: 'Setor' };
  const ORIGENS_PESSOA = { manual: 'Cadastro manual', migracao: 'Nomes antigos', diretorio: 'Diretório (Entra ID)' };
  const CAMPOS_PESSOA = { nome: 'Nome', tipo: 'Tipo', email: 'E-mail', departamento: 'Departamento', unidade: 'Unidade', obs: 'Observação' };
  const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Bancos antigos não têm db.pessoas: leitura trata como vazio; escrita cria a lista.
  const pessoasDe = db => db.pessoas || (db.pessoas = []);
  const listaPessoas = db => db.pessoas || [];
  const chaveNome = v => chave(v).replace(/[^a-z0-9]+/g, ' ').trim();
  const snapPessoa = p => ({ categoria: 'Pessoas', descricao: p.nome, serie: null });

  function getPessoa(db, id) {
    const p = listaPessoas(db).find(x => x.id === id);
    if (!p) throw erro('Pessoa não encontrada.');
    return p;
  }

  // Valida e normaliza os campos de cadastro (atual = pessoa em edição, para a checagem de e-mail único).
  function dadosPessoa(db, d, atual) {
    const nome = limpa(d.nome);
    if (!nome) throw erro('Informe o nome.');
    const tipo = d.tipo || 'PESSOA';
    if (!Object.hasOwn(TIPOS_PESSOA, tipo)) throw erro('Tipo inválido: use Pessoa ou Setor.');
    const email = (valorOuNulo(d.email) || '').toLowerCase() || null;
    if (email && !RE_EMAIL.test(email)) throw erro(`E-mail inválido: ${email}.`);
    const outro = email && listaPessoas(db).find(p => p.id !== (atual && atual.id) && p.email && p.email.toLowerCase() === email);
    if (outro) throw erro(`O e-mail ${email} já pertence a ${outro.nome}.`);
    const unidade = valorOuNulo(d.unidade);
    if (unidade && !Object.hasOwn(LOCAIS, unidade)) throw erro('Unidade inválida.');
    const r = { nome, tipo, email, departamento: valorOuNulo(d.departamento), unidade: unidade || null, obs: valorOuNulo(d.obs) };
    for (const [k, max] of [['nome', 200], ['email', 254], ['departamento', 200], ['obs', 1000]]) {
      if (r[k] && r[k].length > max) throw erro(`${CAMPOS_PESSOA[k]} muito longo (máximo ${max} caracteres).`);
    }
    return r;
  }

  function inserirPessoa(db, dados, origem, entraId) {
    const eid = valorOuNulo(entraId);
    if (eid && listaPessoas(db).some(p => p.entraId === eid)) throw erro('Já existe pessoa com este identificador do diretório.');
    const t = agoraISO();
    const p = Object.assign({ id: uid() }, dados, {
      ativo: true, origem: Object.hasOwn(ORIGENS_PESSOA, origem) ? origem : 'manual', entraId: eid || null, criadoEm: t, atualizadoEm: t,
    });
    pessoasDe(db).push(p);
    return p;
  }

  // d: { tipo, nome, email, departamento, unidade, obs, origem?, entraId? }
  function criarPessoa(db, d) {
    const p = inserirPessoa(db, dadosPessoa(db, d || {}, null), (d || {}).origem, (d || {}).entraId);
    registrar(db, {
      tipo: 'PESSOA', pessoaId: p.id, item: snapPessoa(p),
      obs: `${TIPOS_PESSOA[p.tipo]} cadastrado(a): ${p.nome}${p.departamento ? ' (' + p.departamento + ')' : ''}`,
    });
    return p;
  }

  // d: { id, ...campos }. Campo ausente = não alterar; '' apaga (exceto nome).
  function editarPessoa(db, d) {
    const p = getPessoa(db, d && d.id);
    const mesclado = {};
    for (const k of Object.keys(CAMPOS_PESSOA)) mesclado[k] = d[k] !== undefined ? d[k] : p[k];
    const novo = dadosPessoa(db, mesclado, p);
    const rot = (k, v) => k === 'tipo' ? TIPOS_PESSOA[v] : k === 'unidade' ? (LOCAIS[v] || '') : (v ?? '');
    const alteracoes = [];
    for (const k of Object.keys(CAMPOS_PESSOA)) {
      if ((p[k] ?? null) !== (novo[k] ?? null)) alteracoes.push({ campo: k, rotulo: CAMPOS_PESSOA[k], de: p[k] ?? null, para: novo[k] ?? null });
    }
    if (!alteracoes.length) return null;
    const renomeou = alteracoes.some(a => a.campo === 'nome');
    Object.assign(p, novo);
    p.atualizadoEm = agoraISO();
    if (renomeou) for (const it of db.itens) if (it.responsavelId === p.id) it.responsavelAtual = p.nome; // texto de exibição acompanha o cadastro
    return registrar(db, {
      tipo: 'PESSOA', pessoaId: p.id, item: snapPessoa(p), alteracoes,
      obs: alteracoes.map(a => `${a.rotulo}: "${rot(a.campo, a.de)}" → "${rot(a.campo, a.para)}"`).join('; '),
    });
  }

  // Pessoa com histórico nunca é apagada: só desativada (deixa de aparecer nas novas entregas).
  function desativarPessoa(db, d) {
    const p = getPessoa(db, d && d.id);
    if (!p.ativo) throw erro(`${p.nome} já está inativa.`);
    const n = itensComPessoa(db, p.id).reduce((s, x) => s + x.quantidade, 0);
    p.ativo = false;
    p.atualizadoEm = agoraISO();
    return registrar(db, {
      tipo: 'PESSOA', pessoaId: p.id, item: snapPessoa(p),
      obs: `Cadastro desativado${n ? ` (ainda com ${n} item(ns))` : ''}${valorOuNulo(d.motivo) ? ' — ' + valorOuNulo(d.motivo) : ''}`,
    });
  }

  function reativarPessoa(db, d) {
    const p = getPessoa(db, d && d.id);
    if (p.ativo) throw erro(`${p.nome} já está ativa.`);
    p.ativo = true;
    p.atualizadoEm = agoraISO();
    return registrar(db, { tipo: 'PESSOA', pessoaId: p.id, item: snapPessoa(p), obs: 'Cadastro reativado' });
  }

  // --- Consultas de pessoas ---

  // Nome de exibição do responsável: o do cadastro quando há vínculo, senão o texto antigo.
  function nomeResponsavel(db, item, mapa) {
    if (item.responsavelId) {
      const p = mapa ? mapa.get(item.responsavelId) : listaPessoas(db).find(x => x.id === item.responsavelId);
      if (p) return p.nome;
    }
    return item.responsavelAtual || '';
  }

  // Mapa pessoaId -> [{ item, controle, quantidade, desde }] do que está atualmente com cada pessoa.
  // Itens por unidade: situação ENTREGUE com responsavelId. Itens por quantidade: entregas com pessoaId menos
  // devoluções registradas com o mesmo pessoaId (devolução sem pessoa não abate). Itens na Lixeira ficam de fora.
  function posicoesPessoas(db) {
    const itens = new Map(db.itens.filter(ativo).map(i => [i.id, i]));
    const ultimaDoItem = new Map();   // itemId -> data da última entrega (qualquer pessoa)
    const porPessoa = new Map();      // pessoaId -> Map(itemId -> { quantidade, desde })
    for (const m of db.movimentos) {
      if (m.tipo !== 'ENTREGA' && m.tipo !== 'DEVOLUCAO') continue;
      if (m.tipo === 'ENTREGA' && m.data && (ultimaDoItem.get(m.itemId) || '') < m.data) ultimaDoItem.set(m.itemId, m.data);
      const it = m.pessoaId && itens.get(m.itemId);
      if (!it || it.controle !== 'quantidade') continue;
      let mp = porPessoa.get(m.pessoaId);
      if (!mp) porPessoa.set(m.pessoaId, mp = new Map());
      const e = mp.get(m.itemId) || { quantidade: 0, desde: null };
      if (m.tipo === 'ENTREGA') { e.quantidade += m.quantidade || 0; if (m.data && (e.desde || '') < m.data) e.desde = m.data; }
      else e.quantidade -= m.quantidade || 0;
      mp.set(m.itemId, e);
    }
    const r = new Map();
    const add = (pid, x) => { if (!r.has(pid)) r.set(pid, []); r.get(pid).push(x); };
    for (const [pid, mp] of porPessoa) {
      for (const [itemId, e] of mp) if (e.quantidade > 0) add(pid, { item: itens.get(itemId), controle: 'quantidade', quantidade: e.quantidade, desde: e.desde });
    }
    for (const it of itens.values()) {
      if (it.controle === 'unidade' && it.status === 'ENTREGUE' && it.responsavelId) add(it.responsavelId, { item: it, controle: 'unidade', quantidade: 1, desde: ultimaDoItem.get(it.id) || null });
    }
    const ord = (a, b) => a.item.categoria.localeCompare(b.item.categoria, 'pt-BR') || a.item.descricao.localeCompare(b.item.descricao, 'pt-BR');
    for (const lista of r.values()) lista.sort(ord);
    return r;
  }

  const itensComPessoa = (db, pessoaId) => posicoesPessoas(db).get(pessoaId) || [];

  // Entregas e devoluções registradas com a pessoa, mais recentes primeiro.
  function historicoPessoa(db, pessoaId) {
    return db.movimentos.filter(m => m.pessoaId === pessoaId && (m.tipo === 'ENTREGA' || m.tipo === 'DEVOLUCAO'))
      .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')) || String(b.criadoEm).localeCompare(String(a.criadoEm)));
  }

  // --- Migração dos nomes antigos (texto livre) ---

  const RE_SETOR = /^(filial|matriz|setor|departamento|depto|unidade|loja|sede|diretoria|gerencia|coordenacao|equipe|time|almoxarifado|recepcao|escritorio)\b/;
  const PARTICULAS = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);

  // "Nome (Setor)" -> nome + departamento sugerido.
  function separaNomeSetor(t) {
    const m = t.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
    if (m && limpa(m[1])) return { nome: limpa(m[1]), departamento: limpa(m[2]) || null };
    return { nome: t, departamento: null };
  }

  // Motivo pelo qual o texto parece um setor/unidade (só sugestão; quem decide é o usuário).
  function motivoSetor(nome) {
    if (RE_SETOR.test(chave(nome))) return 'começa com palavra de setor/unidade';
    if (!/\s/.test(nome) && nome === nome.toUpperCase() && /\p{L}/u.test(nome)) return 'texto em maiúsculas, sem espaço (sigla?)';
    return null;
  }

  function capitalizarNome(n) {
    if (n !== n.toUpperCase() && n !== n.toLowerCase()) return n;                 // já tem caixa mista
    if (!/\s/.test(n) && n === n.toUpperCase() && n.length > 1) return n;         // uma palavra em maiúsculas: mantém
    return n.toLowerCase().split(' ').map((w, i) => i > 0 && PARTICULAS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  // Textos distintos de movimento.usuario / item.responsavelAtual ainda sem vínculo, agrupados por nome normalizado
  // (sem acento/caixa/espaços/pontuação; "Nome (Setor)" agrupa com "Nome"). Não altera nada.
  function gruposNomesAntigos(db) {
    const porChave = new Map();
    const variantes = new Map();
    const ver = (texto, campo) => {
      const t = limpa(texto);
      if (!t) return;
      let v = variantes.get(chave(t));
      if (!v) {
        const sep = separaNomeSetor(t);
        v = { texto: t, nome: sep.nome, departamento: sep.departamento, movimentos: 0, itens: 0 };
        variantes.set(chave(t), v);
        const k = chaveNome(sep.nome) || chave(t);
        let g = porChave.get(k);
        if (!g) porChave.set(k, g = { id: k, variantes: [] });
        g.variantes.push(v);
      }
      v[campo]++;
    };
    for (const m of db.movimentos) if (!m.pessoaId && m.usuario) ver(m.usuario, 'movimentos');
    for (const it of db.itens) if (!it.responsavelId && it.responsavelAtual) ver(it.responsavelAtual, 'itens');

    const existentes = new Map();
    for (const p of listaPessoas(db)) {
      const k = chaveNome(p.nome);
      if (k && (!existentes.has(k) || (p.ativo && !existentes.get(k).ativo))) existentes.set(k, p);
    }
    const peso = v => v.movimentos + v.itens;
    const misto = s => s !== s.toUpperCase() && s !== s.toLowerCase();
    return [...porChave.values()].map(g => {
      const ord = g.variantes.slice().sort((a, b) => peso(b) - peso(a) || Number(misto(b.nome)) - Number(misto(a.nome)));
      const motivo = motivoSetor(ord[0].nome);
      const comDepto = ord.find(v => v.departamento);
      const ex = existentes.get(g.id);
      return {
        id: g.id,
        nome: motivo ? ord[0].nome : capitalizarNome(ord[0].nome),
        departamento: comDepto ? comDepto.departamento : null,
        tipoSugerido: motivo ? 'SETOR' : 'PESSOA',
        motivoSetor: motivo,
        variantes: ord.map(v => ({ texto: v.texto, movimentos: v.movimentos, itens: v.itens })),
        movimentos: ord.reduce((s, v) => s + v.movimentos, 0),
        itens: ord.reduce((s, v) => s + v.itens, 0),
        existenteId: ex ? ex.id : null,
      };
    }).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }

  // d.decisoes: [{ acao: 'criar'|'setor'|'vincular'|'ignorar', nomes: [textos originais],
  //                pessoa: { nome, departamento, unidade, email } (criar/setor), pessoaId (vincular) }]
  // Tudo é validado antes da primeira alteração. Os textos originais de movimento.usuario são preservados;
  // ganham só pessoaId. Itens: responsavelId (e responsavelAtual passa a ser o nome do cadastro).
  function vincularNomesAntigos(db, d) {
    const decisoes = Array.isArray(d && d.decisoes) ? d.decisoes : [];
    if (!decisoes.length) throw erro('Nenhuma decisão informada.');
    const usados = new Set(), emails = new Set(), plano = [];
    for (const dec of decisoes) {
      if (!['criar', 'setor', 'vincular', 'ignorar'].includes(dec.acao)) throw erro('Ação inválida na decisão.');
      if (dec.acao === 'ignorar') continue;
      const nomes = (dec.nomes || []).map(limpa).filter(Boolean);
      if (!nomes.length) throw erro('Decisão sem nomes para vincular.');
      const chaves = new Set(nomes.map(chave));
      for (const k of chaves) {
        if (usados.has(k)) throw erro(`O texto "${k}" aparece em mais de uma decisão.`);
        usados.add(k);
      }
      if (dec.acao === 'vincular') {
        plano.push({ nomes, chaves, pessoa: getPessoa(db, dec.pessoaId) });
      } else {
        const dados = dadosPessoa(db, Object.assign({}, dec.pessoa, { tipo: dec.acao === 'setor' ? 'SETOR' : 'PESSOA' }), null);
        if (dados.email) {
          if (emails.has(dados.email)) throw erro(`O e-mail ${dados.email} aparece em mais de uma pessoa nova.`);
          emails.add(dados.email);
        }
        plano.push({ nomes, chaves, dados });
      }
    }
    if (!plano.length) throw erro('Nenhum vínculo a aplicar (todos ignorados).');
    const lote = uid();
    const res = { pessoasCriadas: 0, movimentosVinculados: 0, itensVinculados: 0 };
    for (const g of plano) {
      const p = g.pessoa || inserirPessoa(db, g.dados, 'migracao');
      if (!g.pessoa) res.pessoasCriadas++;
      let nm = 0, ni = 0;
      for (const m of db.movimentos) {
        if (!m.pessoaId && m.usuario && g.chaves.has(chave(m.usuario))) { m.pessoaId = p.id; nm++; }
      }
      for (const it of db.itens) {
        if (!it.responsavelId && it.responsavelAtual && g.chaves.has(chave(it.responsavelAtual))) {
          it.responsavelId = p.id; it.responsavelAtual = p.nome; it.atualizadoEm = agoraISO(); ni++;
        }
      }
      res.movimentosVinculados += nm; res.itensVinculados += ni;
      registrar(db, {
        tipo: 'PESSOA', pessoaId: p.id, item: snapPessoa(p), lote,
        obs: `Nomes antigos vinculados a ${p.nome}: ${g.nomes.map(n => `"${n}"`).join(', ')} — ${nm} movimentação(ões) e ${ni} item(ns)${g.pessoa ? '' : ' (cadastro criado nesta operação)'}`,
      });
    }
    return res;
  }

  // ---------- Consultas ----------

  function uniq(arr) {
    const m = new Map();
    for (const v of arr) { const s = limpa(v); if (s && !m.has(chave(s))) m.set(chave(s), s); }
    return [...m.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  const listas = {
    categorias: db => uniq(itensAtivos(db).map(i => i.categoria)),
    posicoes: db => uniq(itensAtivos(db).map(i => i.posicao)),
    usuarios: db => uniq(db.movimentos.map(m => m.usuario).concat(itensAtivos(db).map(i => i.responsavelAtual))),
    proprietarios: db => uniq(['Solar Cuidados'].concat(itensAtivos(db).map(i => i.proprietario))),
    impressoras: db => uniq(tonersAtivos(db).map(t => t.impressora)),
    modelosToner: db => uniq(tonersAtivos(db).map(t => t.modelo)),
    justificativas: db => uniq(db.movimentos.filter(m => m.descarte).map(m => m.descarte.justificativa)),
  };

  function categoriaUsaSerie(db, categoria) {
    const k = chave(categoria);
    const doGrupo = itensAtivos(db).filter(i => chave(i.categoria) === k);
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
    // Pessoas: e-mail único e vínculos que apontam para cadastros existentes.
    const pessoaIds = new Set(listaPessoas(db).map(p => p.id));
    const emailsVistos = new Map();
    for (const p of listaPessoas(db)) {
      const e = p.email && p.email.toLowerCase();
      if (!e) continue;
      if (emailsVistos.has(e)) problemas.push({ msg: `E-mail ${e} repetido entre ${emailsVistos.get(e)} e ${p.nome}.` });
      else emailsVistos.set(e, p.nome);
    }
    for (const it of db.itens) {
      if (it.responsavelId && !pessoaIds.has(it.responsavelId)) problemas.push({ itemId: it.id, msg: `${it.categoria} — ${it.descricao}: responsável aponta para uma pessoa que não existe.` });
    }
    let semPessoa = 0;
    for (const m of db.movimentos) if (m.pessoaId && !pessoaIds.has(m.pessoaId)) semPessoa++;
    if (semPessoa) problemas.push({ msg: `${semPessoa} movimentação(ões) apontam para uma pessoa que não existe.` });
    return problemas;
  }

  App.ledger = {
    LOCAIS, STATUS, TIPOS, STATUS_TONER, DADOS_APAGADOS, CAMPOS_EDITAVEIS, CAMPOS_LOTE_ITEM, CAMPOS_LOTE_DESCARTE,
    novoBanco, total, snap, getItem, itemPorSerie, registrar,
    cadastrarItem, editarItem, editarItensEmLote, avisosExclusao, excluirItem, restaurarItem, itensAtivos, tonersAtivos,
    entrada, entregar, devolver, enviarManutencao, retornarManutencao, descartar, editarDescarte, editarDescartesEmLote, ajustar,
    adicionarToner, mudarStatusToner, editarToner, excluirToner, restaurarToner, atualizarCoresToners,
    listas, categoriaUsaSerie, guardaDados, verificarConsistencia,
    TIPOS_PESSOA, ORIGENS_PESSOA, CAMPOS_PESSOA, criarPessoa, editarPessoa, desativarPessoa, reativarPessoa, vincularNomesAntigos,
    getPessoa, listaPessoas, chaveNome, nomeResponsavel, posicoesPessoas, itensComPessoa, historicoPessoa, gruposNomesAntigos,
  };
})(globalThis.App = globalThis.App || {});

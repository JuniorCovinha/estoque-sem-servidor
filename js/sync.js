/* Sincronização por operações (offline-first).
   Cada alteração é uma operação serializável { id, nome, args, autor, criadoEm } aplicada pelo ledger.
   Estado local = base (última versão confirmada do remoto + etag + ids de operações já aplicadas)
                + pendentes (fila ainda não confirmada). O banco exibido é a base com as pendentes aplicadas.
   Ao sincronizar, se o remoto mudou, as pendentes são reaplicadas sobre ele (rebase) pelo mesmo ledger,
   revalidando cada uma; as que não se aplicam mais viram conflitos para revisão (nunca são descartadas sozinhas).
   O arquivo remoto guarda os ids das operações já aplicadas: reenviar a mesma operação não a aplica duas vezes. */
(function (App) {
  'use strict';
  const { comContexto, uid, agoraISO } = App.util;

  const FORMATO = 'estoque-ti';
  const SCHEMA_REMOTO = 2;
  const MAX_TENTATIVAS = 5;
  const RETENCAO_IDS_DIAS = 365; // ids de operações mais antigos saem do arquivo (limita o tamanho)
  const RE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/;

  // ---------- Lista branca de operações ----------
  // Só estas funções do ledger podem ser executadas como operação. O nome vindo da fila é apenas procurado
  // aqui; a função é sempre a do ledger carregado na página (nada de arquivo vira código).
  // Para estender: acrescente uma linha (nome da função em App.ledger → rótulo para a tela de conflitos)
  // ou chame App.sync.registrarOperacao('nome', 'Rótulo'). Convenção: L.fn(db, ...args JSON).
  const OPERACOES = new Map(Object.entries({
    cadastrarItem: 'Cadastro de item',
    editarItem: 'Edição de item',
    editarItensEmLote: 'Edição de itens em lote',
    excluirItem: 'Exclusão de item',
    restaurarItem: 'Restauração de item',
    entrada: 'Entrada',
    entregar: 'Entrega',
    devolver: 'Devolução',
    enviarManutencao: 'Envio para manutenção',
    retornarManutencao: 'Retorno da manutenção',
    descartar: 'Descarte',
    editarDescarte: 'Edição de descarte',
    editarDescartesEmLote: 'Edição de descartes em lote',
    ajustar: 'Ajuste de saldo',
    adicionarToner: 'Cadastro de toner',
    mudarStatusToner: 'Status do toner',
    editarToner: 'Edição de toner',
    excluirToner: 'Exclusão de toner',
    restaurarToner: 'Restauração de toner',
    atualizarCoresToners: 'Cores dos toners pela planilha',
  }).map(([nome, rotulo]) => [nome, { rotulo, fn: null }]));

  // fn opcional: por padrão usa App.ledger[nome] (resolvido na hora de aplicar).
  function registrarOperacao(nome, rotulo, fn) {
    if (typeof nome !== 'string' || !/^[a-zA-Z]\w{0,63}$/.test(nome)) throw new Error('Nome de operação inválido.');
    if (fn !== undefined && typeof fn !== 'function') throw new Error('fn deve ser uma função.');
    OPERACOES.set(nome, { rotulo: rotulo || nome, fn: fn || null });
  }

  const permitida = nome => typeof nome === 'string' && OPERACOES.has(nome);
  const rotuloOperacao = nome => (permitida(nome) && OPERACOES.get(nome).rotulo) || String(nome);

  function funcaoDe(nome) {
    const def = permitida(nome) ? OPERACOES.get(nome) : null;
    const L = App.ledger;
    const fn = def && (def.fn || (L && Object.hasOwn(L, nome) ? L[nome] : null));
    if (typeof fn !== 'function') throw erroSync('operacao', `Operação não permitida: "${String(nome).slice(0, 60)}".`);
    return fn;
  }

  // ---------- Erros identificáveis ----------
  function erroSync(codigo, msg) { const e = new Error(msg); e.codigo = codigo; return e; }
  const erroPrecondicao = () => erroSync('precondicao', 'O arquivo remoto foi alterado por outra gravação.');
  const erroOffline = msg => erroSync('offline', msg || 'Sem conexão com o armazenamento remoto.');
  const ehPrecondicao = e => !!e && e.codigo === 'precondicao';

  // ---------- Operações ----------
  function validarOperacao(op) {
    if (!op || typeof op !== 'object') throw erroSync('operacao', 'Operação malformada.');
    if (typeof op.id !== 'string' || !RE_ID.test(op.id)) throw erroSync('operacao', 'Operação com id inválido.');
    if (!permitida(op.nome)) throw erroSync('operacao', `Operação não permitida: "${String(op.nome).slice(0, 60)}".`);
    if (!Array.isArray(op.args)) throw erroSync('operacao', 'Operação sem lista de argumentos.');
    if (typeof op.criadoEm !== 'string' || isNaN(Date.parse(op.criadoEm))) throw erroSync('operacao', 'Operação sem data válida.');
    if (op.autor !== null && op.autor !== undefined && (typeof op.autor !== 'object' || typeof op.autor.nome !== 'string')) throw erroSync('operacao', 'Autor da operação inválido.');
    return op;
  }

  function novaOperacao(nome, args, autor) {
    if (!permitida(nome)) throw erroSync('operacao', `Operação não permitida: "${String(nome).slice(0, 60)}".`);
    if (!Array.isArray(args)) throw new Error('Os argumentos da operação devem ser uma lista.');
    let copia;
    try { copia = JSON.parse(JSON.stringify(args)); } catch (e) { throw new Error('Argumentos da operação não são serializáveis.'); }
    return {
      id: uid(), nome, args: copia,
      autor: autor && autor.nome ? { nome: String(autor.nome), email: autor.email ? String(autor.email) : null } : null,
      criadoEm: agoraISO(),
    };
  }

  // Aplica no próprio db (muta). Dentro do contexto, uid()/agoraISO()/hojeISO() derivam da operação.
  function aplicar(db, op) {
    validarOperacao(op);
    const fn = funcaoDe(op.nome);
    const args = structuredClone(op.args);
    return comContexto(op, () => fn(db, ...args));
  }

  // Aplica uma sequência sobre uma cópia de `inicio`. pular(op) = true ignora a operação (já aplicada).
  function reaplicar(inicio, ops, pular) {
    let atual = structuredClone(inicio);
    const ok = [], falhas = [];
    for (const op of ops) {
      if (pular && pular(op)) continue;
      try { aplicar(atual, op); ok.push(op); } catch (e) {
        falhas.push({ op, erro: e });
        // A regra pode ter mexido em algo antes de falhar: refaz do início só com as que deram certo.
        atual = structuredClone(inicio);
        for (const x of ok) aplicar(atual, x);
      }
    }
    return { db: atual, ok, falhas };
  }

  // ---------- Arquivo remoto ----------
  function podar(aplicadas) {
    const limite = Date.now() - RETENCAO_IDS_DIAS * 86400000;
    return [...aplicadas].filter(([, em]) => !(Date.parse(em) < limite));
  }

  function serializarRemoto(db, aplicadas) {
    return JSON.stringify({
      formato: FORMATO, schema: SCHEMA_REMOTO, atualizadoEm: db.atualizadoEm,
      operacoesAplicadas: Object.fromEntries(podar(aplicadas)), db,
    }, null, 1);
  }

  function lerAplicadas(obj) {
    const m = new Map();
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [id, em] of Object.entries(obj)) if (RE_ID.test(id) && typeof em === 'string') m.set(id, em);
    }
    return m;
  }

  // Lê e valida o conteúdo remoto. Aceita o formato antigo (banco schema 1 direto) para migração.
  function abrirRemoto(texto, validar) {
    let obj;
    try { obj = JSON.parse(texto); } catch (e) { throw erroSync('invalido', 'O arquivo de dados não é um JSON válido.'); }
    if (obj && obj.schema === 1) return { db: validar(obj), aplicadas: new Map(), legado: true };
    if (!obj || obj.formato !== FORMATO || obj.schema !== SCHEMA_REMOTO) throw erroSync('invalido', 'Formato do arquivo de dados não reconhecido.');
    return { db: validar(obj.db), aplicadas: lerAplicadas(obj.operacoesAplicadas), legado: false };
  }

  // Banco contido num JSON de backup (formato antigo ou novo).
  function extrairBanco(obj) {
    if (obj && obj.formato === FORMATO && obj.schema === SCHEMA_REMOTO) return obj.db;
    return obj;
  }

  const vazio = db => !db || (!db.itens.length && !db.movimentos.length && !db.toners.length);

  // ---------- Motor ----------
  /**
   * o = { remoto, validar(db), persistir(estadoSerializavel), backup(prefixo, texto, db), aoMudar() }
   * remoto = { nome, disponivel(), ler() -> {texto, etag} | null, gravar(texto, etagEsperado) -> {etag} }
   *   gravar lança erro com codigo 'precondicao' se o etag atual não for etagEsperado (null = não pode existir).
   */
  function criarMotor(o) {
    const remoto = o.remoto;
    const validar = o.validar || (x => x);
    const persistir = o.persistir || (async () => {});
    const aoMudar = o.aoMudar || (() => {});

    let base = { db: App.ledger.novoBanco(), etag: null, aplicadas: new Map() };
    let pendentes = [];
    let conflitos = [];
    let db = structuredClone(base.db);
    const estado = { sincronizando: false, ultimaSync: null, conflitoVersoes: null };
    let emCurso = null, repetir = false;

    function novoConflito(op, e) {
      return { id: op.id, op, erro: (e && e.message) || String(e), em: new Date().toISOString() };
    }

    function serializavel() {
      return {
        versao: 1, base: { db: base.db, etag: base.etag, aplicadas: [...base.aplicadas] },
        pendentes, conflitos, ultimaSync: estado.ultimaSync,
      };
    }
    const salvarLocal = () => persistir(serializavel());

    // Recalcula o banco exibido; pendente que não se aplica mais sobre a base vira conflito.
    function recalcular() {
      const r = reaplicar(base.db, pendentes);
      for (const f of r.falhas) conflitos.push(novoConflito(f.op, f.erro));
      pendentes = r.ok;
      db = r.db;
    }

    function carregar(salvo) {
      const b = salvo && salvo.base;
      if (!b || !b.db) throw new Error('Estado de sincronização inválido.');
      base = { db: validar(b.db), etag: typeof b.etag === 'string' ? b.etag : null, aplicadas: lerAplicadas(Object.fromEntries(Array.isArray(b.aplicadas) ? b.aplicadas : [])) };
      pendentes = [];
      conflitos = Array.isArray(salvo.conflitos) ? salvo.conflitos.filter(c => c && c.op) : [];
      for (const op of Array.isArray(salvo.pendentes) ? salvo.pendentes : []) {
        try { pendentes.push(validarOperacao(op)); } catch (e) { conflitos.push(novoConflito(op && typeof op === 'object' ? op : { id: 'invalida-' + Date.now() }, e)); }
      }
      estado.ultimaSync = salvo.ultimaSync || null;
      recalcular();
      aoMudar();
    }

    // Aplica no banco local (validando pelo ledger), enfileira e grava localmente.
    // Se a regra lançar erro, nada muda e o erro sobe para a interface.
    async function executar(nome, args, autor) {
      const op = novaOperacao(nome, args, autor);
      const copia = structuredClone(db);
      const resultado = aplicar(copia, op);
      db = copia;
      pendentes.push(op);
      let erroLocal = null;
      try { await salvarLocal(); } catch (e) { erroLocal = e; }
      aoMudar();
      return { op, resultado, erroLocal };
    }

    function sincronizar() {
      if (emCurso) { repetir = true; return emCurso; }
      emCurso = (async () => {
        estado.sincronizando = true; aoMudar();
        try {
          let r;
          do { repetir = false; r = await sincronizarUmaVez(); } while (repetir && r && r.ok);
          return r;
        } finally { emCurso = null; estado.sincronizando = false; aoMudar(); }
      })();
      return emCurso;
    }

    async function sincronizarUmaVez() {
      if (!remoto || !remoto.disponivel()) return { semConexao: true };
      for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
        const lido = await remoto.ler();
        const rem = lido ? abrirRemoto(lido.texto, validar) : null;
        const enviadas = pendentes.slice();
        let inicio, aplicadas;
        if (rem && base.etag !== null && lido.etag === base.etag) { inicio = base.db; aplicadas = base.aplicadas; }
        else if (rem && base.etag === null && !vazio(base.db) && base.db.atualizadoEm !== rem.db.atualizadoEm) {
          // Primeira ligação com um arquivo que tem outra versão dos dados: o usuário decide.
          estado.conflitoVersoes = { arquivo: rem.db.atualizadoEm, navegador: db.atualizadoEm, lido, rem };
          return { conflito: estado.conflitoVersoes };
        } else if (rem) { inicio = rem.db; aplicadas = rem.aplicadas; }
        else { inicio = base.db; aplicadas = base.aplicadas; } // remoto ainda não existe: cria

        const r = reaplicar(inicio, enviadas, op => aplicadas.has(op.id));
        const novas = new Map(aplicadas);
        for (const op of r.ok) novas.set(op.id, op.criadoEm);
        const gravar = r.ok.length > 0 || (rem ? rem.legado : !vazio(r.db));
        let etag = lido ? lido.etag : null;
        if (gravar) {
          try { etag = (await remoto.gravar(serializarRemoto(r.db, novas), lido ? lido.etag : null)).etag; }
          catch (e) { if (ehPrecondicao(e)) continue; throw e; }
        }
        confirmar(r, novas, etag, enviadas);
        await salvarLocal();
        return { ok: true, aplicadas: r.ok.length, conflitos: r.falhas.length, gravou: gravar };
      }
      throw erroSync('concorrencia', 'O arquivo foi alterado várias vezes seguidas durante a sincronização. Tente de novo.');
    }

    // Remoto confirmou: nova base; saem da fila as enviadas (aplicadas, já presentes no remoto ou em conflito).
    function confirmar(r, aplicadas, etag, enviadas) {
      const ids = new Set(enviadas.map(op => op.id));
      for (const f of r.falhas) conflitos.push(novoConflito(f.op, f.erro));
      base = { db: r.db, etag, aplicadas };
      pendentes = pendentes.filter(op => !ids.has(op.id));
      recalcular(); // operações feitas durante a sincronização
      estado.ultimaSync = new Date().toISOString();
      estado.conflitoVersoes = null;
    }

    // Resposta do usuário ao conflito de versões: 'arquivo' ou 'navegador'. A outra versão vai para backup.
    async function resolverVersoes(usar) {
      const c = estado.conflitoVersoes;
      if (!c) return;
      estado.conflitoVersoes = null;
      if (usar === 'navegador') {
        if (o.backup) await o.backup('arquivo-antes-de-usar-navegador', c.lido.texto, c.rem.db);
        const r = reaplicar(base.db, pendentes);
        const novas = new Map([...c.rem.aplicadas, ...base.aplicadas]);
        for (const op of r.ok) novas.set(op.id, op.criadoEm);
        const { etag } = await remoto.gravar(serializarRemoto(r.db, novas), c.lido.etag);
        confirmar(r, novas, etag, pendentes.slice());
      } else {
        if (o.backup) await o.backup('navegador-antes-de-usar-arquivo', JSON.stringify(db), db);
        base = { db: c.rem.db, etag: c.lido.etag, aplicadas: c.rem.aplicadas };
        recalcular(); // pendentes são reaplicadas sobre o arquivo; as que falharem ficam para revisão
      }
      await salvarLocal();
      aoMudar();
    }

    // Sem armazenamento remoto (dados só neste navegador): as pendentes passam direto para a base.
    // O etag é esquecido: ao ligar uma pasta, a versão do arquivo é comparada como na primeira ligação.
    async function consolidarLocal() {
      if (!pendentes.length && base.etag === null) return;
      const r = reaplicar(base.db, pendentes);
      const novas = new Map(base.aplicadas);
      for (const op of r.ok) novas.set(op.id, op.criadoEm);
      confirmar(r, novas, null, pendentes.slice());
      estado.ultimaSync = null;
      await salvarLocal();
      aoMudar();
    }

    // Outra pasta/arquivo: o etag guardado não vale mais.
    async function desvincular() {
      base = Object.assign({}, base, { etag: null });
      await salvarLocal();
      aoMudar();
    }

    // Substituição total (importação da planilha ou restauração de backup): não é operação.
    // Exige fila vazia e grava o novo banco como base (no remoto, se disponível).
    async function substituirBase(novo) {
      validar(novo);
      if (pendentes.length) throw erroSync('fila', `Há ${pendentes.length} alteração(ões) aguardando sincronização. Sincronize antes de substituir os dados.`);
      if (remoto && remoto.disponivel()) {
        let feito = false;
        for (let tentativa = 1; tentativa <= MAX_TENTATIVAS && !feito; tentativa++) {
          const lido = await remoto.ler();
          let aplicadas = base.aplicadas;
          if (lido) {
            try { aplicadas = new Map([...base.aplicadas, ...abrirRemoto(lido.texto, validar).aplicadas]); }
            catch (e) { if (o.backup) await o.backup('arquivo-ilegivel', lido.texto, null); }
          }
          try {
            const { etag } = await remoto.gravar(serializarRemoto(novo, aplicadas), lido ? lido.etag : null);
            base = { db: structuredClone(novo), etag, aplicadas };
            feito = true;
          } catch (e) { if (!ehPrecondicao(e)) throw e; }
        }
        if (!feito) throw erroSync('concorrencia', 'O arquivo foi alterado várias vezes seguidas. Tente de novo.');
        estado.ultimaSync = new Date().toISOString();
      } else {
        base = { db: structuredClone(novo), etag: null, aplicadas: base.aplicadas };
      }
      estado.conflitoVersoes = null;
      recalcular();
      await salvarLocal();
      aoMudar();
    }

    async function descartarConflito(id) {
      conflitos = conflitos.filter(c => c.id !== id);
      await salvarLocal();
      aoMudar();
    }

    // Reaplica a operação do conflito sobre o banco atual; se passar, volta para a fila (mesmo id e data).
    async function tentarDeNovo(id) {
      const c = conflitos.find(x => x.id === id);
      if (!c) throw new Error('Conflito não encontrado.');
      const copia = structuredClone(db);
      try { aplicar(copia, c.op); } catch (e) {
        c.erro = e.message || String(e); c.em = new Date().toISOString();
        await salvarLocal(); aoMudar();
        throw e;
      }
      db = copia;
      pendentes.push(c.op);
      conflitos = conflitos.filter(x => x !== c);
      await salvarLocal();
      aoMudar();
    }

    return {
      estado, carregar, executar, sincronizar, resolverVersoes, consolidarLocal, desvincular, substituirBase,
      descartarConflito, tentarDeNovo,
      get db() { return db; },
      get pendentes() { return pendentes.slice(); },
      get conflitos() { return conflitos.slice(); },
      get base() { return { db: base.db, etag: base.etag, aplicadas: new Map(base.aplicadas) }; },
    };
  }

  App.sync = {
    FORMATO, SCHEMA_REMOTO, OPERACOES, registrarOperacao, rotuloOperacao, permitida,
    novaOperacao, validarOperacao, aplicar, reaplicar, serializarRemoto, abrirRemoto, extrairBanco,
    erroSync, erroPrecondicao, erroOffline, ehPrecondicao, criarMotor,
  };
})(globalThis.App = globalThis.App || {});

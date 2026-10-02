/* Sincronização por operações (offline-first).
   Cada alteração é uma operação serializável { id, nome, args, autor, criadoEm } aplicada pelo ledger.
   Estado local = base (última versão confirmada do remoto + etag + ids de operações já aplicadas)
                + pendentes (fila ainda não confirmada). O banco exibido é a base com as pendentes aplicadas.
   Ao sincronizar, se o remoto mudou, as pendentes são reaplicadas sobre ele (rebase) pelo mesmo ledger,
   revalidando cada uma; as que não se aplicam mais viram conflitos para revisão (nunca são descartadas sozinhas).
   O arquivo remoto guarda os ids das operações já aplicadas (com a data em que foram aplicadas): reenviar a
   mesma operação não a aplica duas vezes. Além disso, uma operação cujos registros (ids determinísticos
   "<id da operação>-N") já estão no banco também não é reaplicada.
   Diário local: as operações confirmadas por este computador ficam guardadas (DIARIO_DIAS) no estado local.
   Se o arquivo remoto "voltar no tempo" (OneDrive, cópia restaurada, versão antiga da aplicação), as que
   sumiram dele são reaplicadas, com aviso e cópia do arquivo lido em backup/. */
(function (App) {
  'use strict';
  const { comContexto, uid, agoraISO } = App.util;

  const FORMATO = 'estoque-ti';
  const SCHEMA_REMOTO = 2;
  const MAX_TENTATIVAS = 5;
  const DIA_MS = 86400000;
  const RETENCAO_IDS_DIAS = 365; // ids aplicados há mais tempo que isso saem do arquivo (limita o tamanho)
  const DIARIO_DIAS = 90;        // diário local das operações confirmadas por este computador
  const DIARIO_MAX = 20000;
  const FUTURO_MAX_MS = 1 * DIA_MS;      // operação "do futuro" (relógio adiantado)
  const PASSADO_MAX_MS = 400 * DIA_MS;   // operação antiga demais (relógio atrasado / fila esquecida)
  const LIMITE_TEXTO = 50 * 1024 * 1024; // arquivo de dados maior que isso é recusado
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
    excluirDefinitivo: 'Exclusão definitiva da Lixeira',
    esvaziarLixeira: 'Esvaziar Lixeira',
    atualizarCoresToners: 'Cores dos toners pela planilha',
    criarPessoa: 'Cadastro de pessoa',
    editarPessoa: 'Edição de pessoa',
    desativarPessoa: 'Desativação de pessoa',
    reativarPessoa: 'Reativação de pessoa',
    vincularNomesAntigos: 'Vínculo de nomes antigos às pessoas',
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
    // Data absurda (relógio do computador errado ou fila esquecida): não aplica; vira conflito para revisão.
    const t = Date.parse(op.criadoEm), agora = Date.now();
    if (t > agora + FUTURO_MAX_MS || t < agora - PASSADO_MAX_MS) {
      throw erroSync('data', `Data inválida na operação (${op.criadoEm.slice(0, 10)}): confira a data e a hora do computador que a fez.`);
    }
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

  // Ids de operações cujos registros já estão no banco: todo registro criado dentro de uma operação
  // tem id "<id da operação>-N" (util.uid no contexto). Serve de segunda proteção contra aplicação dupla
  // quando o arquivo perdeu a lista operacoesAplicadas (formato antigo, cópia antiga, poda).
  const RE_ID_DERIVADO = /^(.+)-\d{1,4}$/;
  function operacoesPresentes(db) {
    const r = new Set();
    const ver = id => { if (typeof id === 'string') { const m = RE_ID_DERIVADO.exec(id); if (m) r.add(m[1]); } };
    for (const lista of [db.movimentos, db.itens, db.toners, db.pessoas || []]) for (const x of lista) if (x) ver(x.id);
    return r;
  }

  // ---------- Arquivo remoto ----------
  function podar(aplicadas) {
    const limite = Date.now() - RETENCAO_IDS_DIAS * DIA_MS;
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

  // Lê e valida o conteúdo remoto (antes de qualquer uso). Aceita o formato antigo (banco schema 1 direto)
  // para migração. Arquivo inválido é recusado com mensagem clara; a base atual continua.
  function abrirRemoto(texto, validar) {
    if (typeof texto !== 'string') throw erroSync('invalido', 'O arquivo de dados está vazio ou ilegível.');
    if (texto.length > LIMITE_TEXTO) throw erroSync('invalido', `O arquivo de dados é grande demais (${Math.round(texto.length / 1048576)} MB; máximo ${LIMITE_TEXTO / 1048576} MB).`);
    let obj;
    try { obj = JSON.parse(texto); } catch (e) { throw erroSync('invalido', 'O arquivo de dados não é um JSON válido.'); }
    const validado = x => {
      try { return validar(x); } catch (e) { throw erroSync('invalido', e.message || String(e)); }
    };
    if (obj && obj.schema === 1) return { db: validado(obj), aplicadas: new Map(), legado: true };
    if (!obj || obj.formato !== FORMATO || obj.schema !== SCHEMA_REMOTO) throw erroSync('invalido', 'Formato do arquivo de dados não reconhecido.');
    return { db: validado(obj.db), aplicadas: lerAplicadas(obj.operacoesAplicadas), legado: false };
  }

  // Banco contido num JSON de backup (formato antigo ou novo).
  function extrairBanco(obj) {
    if (obj && obj.formato === FORMATO && obj.schema === SCHEMA_REMOTO) return obj.db;
    return obj;
  }

  const vazio = db => !db || (!db.itens.length && !db.movimentos.length && !db.toners.length && !(db.pessoas || []).length);

  // Serializa tarefas assíncronas (uma de cada vez, na ordem de chegada).
  function criarFila() {
    let ultima = Promise.resolve();
    return fn => {
      const p = ultima.then(() => fn());
      ultima = p.catch(() => {});
      return p;
    };
  }

  const MENSAGENS_BLOQUEIO = {
    'outra-aba': 'A aplicação já está aberta em outra aba ou janela deste navegador. Use aquela (ou feche-a e recarregue esta).',
    'estado-invalido': 'Os dados guardados neste navegador estão inválidos e não foram carregados.',
  };

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
    const exclusivo = criarFila();

    let base = { db: App.ledger.novoBanco(), etag: null, aplicadas: new Map() };
    let pendentes = [];
    let conflitos = [];
    let diario = new Map(); // id -> { op, em }: operações deste computador já confirmadas pelo remoto
    let alertas = [];       // avisos persistentes para o usuário (regressão do arquivo, versão antiga...)
    let db = structuredClone(base.db);
    const estado = { sincronizando: false, ultimaSync: null, conflitoVersoes: null, bloqueio: null };
    let emCurso = null, repetir = false;
    const invalidosCopiados = new Set(); // etags de arquivos inválidos já guardados em backup/

    // ---------- Bloqueio (outra aba aberta, estado local inválido) ----------
    function bloquear(codigo, mensagem) {
      estado.bloqueio = { codigo, mensagem: mensagem || MENSAGENS_BLOQUEIO[codigo] || 'Operações bloqueadas.' };
      aoMudar();
    }
    function exigirLivre(permitido) {
      const b = estado.bloqueio;
      if (b && b.codigo !== permitido) throw erroSync('bloqueado', b.mensagem);
    }

    function novoConflito(op, e) {
      return { id: op.id, op, erro: (e && e.message) || String(e), em: new Date().toISOString() };
    }
    function adicionarConflito(op, e) {
      const c = novoConflito(op, e);
      conflitos = conflitos.filter(x => x.id !== c.id).concat(c);
    }

    function alertar(id, mensagem) {
      alertas = alertas.filter(a => a.id !== id).concat({ id, mensagem, em: new Date().toISOString() });
    }

    function podarDiario() {
      const limite = Date.now() - DIARIO_DIAS * DIA_MS;
      let lista = [...diario].filter(([, e]) => !(Date.parse(e.em) < limite));
      if (lista.length > DIARIO_MAX) lista = lista.slice(-DIARIO_MAX);
      diario = new Map(lista);
    }

    function serializavel() {
      return {
        versao: 1, base: { db: base.db, etag: base.etag, aplicadas: [...base.aplicadas] },
        pendentes, conflitos, ultimaSync: estado.ultimaSync,
        diario: [...diario.values()], alertas,
      };
    }
    // Estado bloqueado nunca é gravado (não sobrescreve o que está guardado no navegador).
    const salvarLocal = () => {
      if (estado.bloqueio) return Promise.reject(erroSync('bloqueado', estado.bloqueio.mensagem));
      return persistir(serializavel());
    };

    // Recalcula o banco exibido; pendente que não se aplica mais sobre a base vira conflito.
    function recalcular() {
      const r = reaplicar(base.db, pendentes);
      for (const f of r.falhas) adicionarConflito(f.op, f.erro);
      pendentes = r.ok;
      db = r.db;
    }

    // Se o estado salvo for inválido, lança e deixa o motor BLOQUEADO (nada é gravado por cima do estado salvo;
    // quem chamou guarda uma cópia e orienta o usuário).
    function carregar(salvo) {
      try {
        const b = salvo && salvo.base;
        if (!b || !b.db) throw new Error('Estado de sincronização inválido.');
        const nBase = {
          db: validar(b.db), etag: typeof b.etag === 'string' ? b.etag : null,
          aplicadas: lerAplicadas(Object.fromEntries(Array.isArray(b.aplicadas) ? b.aplicadas.filter(Array.isArray) : [])),
        };
        const nConflitos = Array.isArray(salvo.conflitos) ? salvo.conflitos.filter(c => c && c.op && typeof c.id === 'string') : [];
        const nPendentes = [];
        const extras = [];
        for (const op of Array.isArray(salvo.pendentes) ? salvo.pendentes : []) {
          try { nPendentes.push(validarOperacao(op)); } catch (e) { extras.push(novoConflito(op && typeof op === 'object' && typeof op.id === 'string' ? op : { id: 'invalida-' + Date.now() }, e)); }
        }
        const nDiario = new Map();
        for (const e of Array.isArray(salvo.diario) ? salvo.diario : []) {
          try { if (e && typeof e.em === 'string') nDiario.set(validarOperacao(e.op).id, { op: e.op, em: e.em }); } catch (x) { /* entrada velha/ruim do diário: ignorada */ }
        }
        const nAlertas = Array.isArray(salvo.alertas) ? salvo.alertas.filter(a => a && typeof a.id === 'string' && typeof a.mensagem === 'string') : [];
        base = nBase; pendentes = nPendentes; diario = nDiario; alertas = nAlertas;
        conflitos = nConflitos;
        for (const c of extras) conflitos = conflitos.filter(x => x.id !== c.id).concat(c);
        estado.ultimaSync = typeof salvo.ultimaSync === 'string' ? salvo.ultimaSync : null;
        podarDiario();
        recalcular();
        if (estado.bloqueio && estado.bloqueio.codigo === 'estado-invalido') estado.bloqueio = null;
      } catch (e) {
        bloquear('estado-invalido', `${MENSAGENS_BLOQUEIO['estado-invalido']} (${e.message || e}) Para continuar, restaure um backup em "Dados e backup → Restaurar backup (.json)" ou carregue de novo o arquivo da pasta.`);
        throw e;
      }
      aoMudar();
    }

    // Aplica no banco local (validando pelo ledger), enfileira e grava localmente.
    // Se a regra lançar erro, nada muda e o erro sobe para a interface.
    async function executar(nome, args, autor) {
      exigirLivre();
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
      try { exigirLivre(); } catch (e) { return Promise.reject(e); }
      if (emCurso) { repetir = true; return emCurso; }
      const p = exclusivo(async () => {
        estado.sincronizando = true; aoMudar();
        try {
          let r;
          do { repetir = false; r = await sincronizarUmaVez(); } while (repetir && r && r.ok);
          return r;
        } finally { estado.sincronizando = false; aoMudar(); }
      });
      emCurso = p;
      const limpar = () => { if (emCurso === p) emCurso = null; };
      p.then(limpar, limpar);
      return p;
    }

    async function guardarCopia(prefixo, texto, dbCopia) {
      if (!o.backup) return false;
      try { return (await o.backup(prefixo, texto, dbCopia)) !== false; } catch (e) { console.error(e); return false; }
    }

    async function lerRemotoValidado() {
      const lido = await remoto.ler();
      if (!lido) return { lido: null, rem: null };
      try { return { lido, rem: abrirRemoto(lido.texto, validar) }; } catch (e) {
        // Recusado ANTES de ser usado: a base atual continua; uma cópia do arquivo vai para backup/ (uma vez).
        if (e.codigo === 'invalido' && !invalidosCopiados.has(lido.etag)) {
          invalidosCopiados.add(lido.etag);
          await guardarCopia('arquivo-invalido', lido.texto, null);
        }
        throw erroSync('invalido', `O arquivo de dados da pasta foi recusado e não foi usado (os dados deste computador foram mantidos): ${e.message}`);
      }
    }

    async function sincronizarUmaVez() {
      exigirLivre();
      if (!remoto || !remoto.disponivel()) return { semConexao: true };
      for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
        const { lido, rem } = await lerRemotoValidado();
        const enviadas = pendentes.slice();
        const idsEnviadas = new Set(enviadas.map(op => op.id));
        let inicio, aplicadas, perdidas = [];
        let versaoAntiga = false, recriado = false;
        if (rem && base.etag !== null && lido.etag === base.etag) { inicio = base.db; aplicadas = base.aplicadas; }
        else {
          // Formato antigo (schema 1) num arquivo que já foi migrado: uma versão antiga da aplicação gravou
          // por cima. Não migra em silêncio: avisa, guarda cópia e reaplica o diário deste computador.
          versaoAntiga = !!(rem && rem.legado && (base.etag !== null || base.aplicadas.size > 0));
          if (rem && base.etag === null && !vazio(base.db) && base.db.atualizadoEm !== rem.db.atualizadoEm) {
            if (versaoAntiga) await avisarVersaoAntiga(lido, rem, 0, 0);
            // Primeira ligação com um arquivo que tem outra versão dos dados: o usuário decide.
            estado.conflitoVersoes = { arquivo: rem.db.atualizadoEm, navegador: db.atualizadoEm, lido, rem };
            return { conflito: estado.conflitoVersoes };
          }
          if (rem) {
            inicio = rem.db; aplicadas = rem.aplicadas;
            // Confirmadas por este computador que não constam do arquivo: o arquivo voltou no tempo.
            perdidas = [...diario.values()].map(e => e.op).filter(op => !aplicadas.has(op.id) && !idsEnviadas.has(op.id));
          } else {
            inicio = base.db; aplicadas = base.aplicadas; // remoto ainda não existe: cria
            recriado = base.etag !== null;               // existia e sumiu: recria com a versão deste computador
          }
        }

        const presentes = operacoesPresentes(inicio);
        const jaNoBanco = new Set();
        const pular = op => {
          if (aplicadas.has(op.id)) return true;
          if (presentes.has(op.id)) { jaNoBanco.add(op.id); return true; }
          return false;
        };
        const r = reaplicar(inicio, perdidas.concat(enviadas), pular);
        const agora = new Date().toISOString();
        const novas = new Map(aplicadas);
        for (const id of jaNoBanco) novas.set(id, agora); // registra no arquivo o que já estava aplicado
        for (const op of r.ok) novas.set(op.id, agora);   // data da aplicação (relógio de quem grava)
        const idsPerdidas = new Set(perdidas.map(op => op.id));
        const reaplicadas = r.ok.filter(op => idsPerdidas.has(op.id)).length;
        const perdidasFalharam = r.falhas.filter(f => idsPerdidas.has(f.op.id)).length;
        const regrediu = reaplicadas + perdidasFalharam > 0;
        const gravar = r.ok.length > 0 || jaNoBanco.size > 0 || (rem ? rem.legado : !vazio(r.db));

        // Cópia do arquivo lido antes de gravar por cima dele.
        let copiaOk = null;
        if (versaoAntiga) copiaOk = await guardarCopia('arquivo-versao-antiga', lido.texto, rem.db);
        else if (regrediu) copiaOk = await guardarCopia('arquivo-regrediu', lido.texto, rem.db);

        let etag = lido ? lido.etag : null;
        if (gravar) {
          try { etag = (await remoto.gravar(serializarRemoto(r.db, novas), lido ? lido.etag : null)).etag; }
          catch (e) { if (ehPrecondicao(e)) continue; throw e; }
        }
        confirmar(r, novas, etag, enviadas);
        if (versaoAntiga) await avisarVersaoAntiga(lido, rem, reaplicadas, perdidasFalharam, copiaOk);
        else if (regrediu) {
          const n = reaplicadas, f = perdidasFalharam;
          alertar('regressao', `O arquivo da pasta voltou para uma versão anterior; ${n} ${n === 1 ? 'lançamento deste computador foi reaplicado' : 'lançamentos deste computador foram reaplicados'}` +
            (f ? ` e ${f} não ${f === 1 ? 'pôde' : 'puderam'} ser reaplicado(s) (veja "Conflitos para revisar")` : '') +
            (copiaOk ? '. Uma cópia do arquivo lido foi guardada em backup/.' : '.') +
            ' Alterações feitas por outros computadores podem ter sido perdidas: confira com eles.');
        }
        if (recriado) alertar('recriado', 'O arquivo estoque.json tinha sumido da pasta e foi recriado com os dados deste computador.');
        await salvarLocal();
        return { ok: true, aplicadas: r.ok.length, conflitos: r.falhas.length, gravou: gravar, reaplicadas, regressao: regrediu || versaoAntiga };
      }
      throw erroSync('concorrencia', 'O arquivo foi alterado várias vezes seguidas durante a sincronização. Tente de novo.');
    }

    async function avisarVersaoAntiga(lido, rem, reaplicadas, falharam, copiaOk) {
      if (copiaOk === undefined) copiaOk = await guardarCopia('arquivo-versao-antiga', lido.texto, rem.db);
      alertar('versao-antiga', 'Há uma versão antiga da aplicação gravando nesta pasta (o estoque.json voltou ao formato antigo). ' +
        'Atualize ou feche a aplicação nos outros computadores.' +
        (reaplicadas ? ` ${reaplicadas} ${reaplicadas === 1 ? 'lançamento deste computador foi reaplicado' : 'lançamentos deste computador foram reaplicados'}.` : '') +
        (falharam ? ` ${falharam} não ${falharam === 1 ? 'pôde' : 'puderam'} ser reaplicado(s) (veja "Conflitos para revisar").` : '') +
        (copiaOk ? ' Uma cópia do arquivo antigo foi guardada em backup/.' : ''));
    }

    // Remoto confirmou: nova base; saem da fila as enviadas (aplicadas, já presentes no remoto ou em conflito).
    // As enviadas que não falharam entram no diário local; as do diário que falharam viram conflito e saem dele.
    function confirmar(r, aplicadas, etag, enviadas) {
      const ids = new Set(enviadas.map(op => op.id));
      const falharam = new Set(r.falhas.map(f => f.op.id));
      for (const f of r.falhas) { adicionarConflito(f.op, f.erro); diario.delete(f.op.id); }
      const agora = new Date().toISOString();
      for (const op of enviadas) if (!falharam.has(op.id) && !diario.has(op.id)) diario.set(op.id, { op, em: agora });
      podarDiario();
      base = { db: r.db, etag, aplicadas };
      pendentes = pendentes.filter(op => !ids.has(op.id));
      recalcular(); // operações feitas durante a sincronização
      estado.ultimaSync = agora;
      estado.conflitoVersoes = null;
    }

    // Resposta do usuário ao conflito de versões: 'arquivo' ou 'navegador'. A outra versão vai para backup.
    // Roda na mesma fila da sincronização; operações feitas durante a resolução continuam na fila.
    function resolverVersoes(usar) {
      if (usar !== 'navegador' && usar !== 'arquivo') return Promise.reject(new Error('Escolha qual versão usar: "arquivo" ou "navegador".'));
      return exclusivo(async () => {
        exigirLivre();
        const c = estado.conflitoVersoes;
        if (!c) return;
        estado.conflitoVersoes = null; // se falhar, a próxima sincronização detecta de novo
        const enviadas = pendentes.slice(); // capturadas ANTES de qualquer await
        if (usar === 'navegador') {
          if (o.backup) await o.backup('arquivo-antes-de-usar-navegador', c.lido.texto, c.rem.db);
          const r = reaplicar(base.db, enviadas);
          const agora = new Date().toISOString();
          const novas = new Map([...c.rem.aplicadas, ...base.aplicadas]);
          for (const op of r.ok) novas.set(op.id, agora);
          const { etag } = await remoto.gravar(serializarRemoto(r.db, novas), c.lido.etag);
          confirmar(r, novas, etag, enviadas);
        } else {
          const atual = db;
          if (o.backup) await o.backup('navegador-antes-de-usar-arquivo', JSON.stringify(atual), atual);
          diario = new Map(); // a versão do navegador foi descartada: nada dela deve ser reaplicado
          base = { db: c.rem.db, etag: c.lido.etag, aplicadas: c.rem.aplicadas };
          recalcular(); // pendentes são reaplicadas sobre o arquivo; as que falharem ficam para revisão
        }
        await salvarLocal();
        aoMudar();
      });
    }

    // Sem armazenamento remoto (dados só neste navegador): as pendentes passam direto para a base.
    // O etag é esquecido: ao ligar uma pasta, a versão do arquivo é comparada como na primeira ligação.
    function consolidarLocal() {
      return exclusivo(async () => {
        exigirLivre();
        if (!pendentes.length && base.etag === null) return;
        const enviadas = pendentes.slice();
        const r = reaplicar(base.db, enviadas);
        const novas = new Map(base.aplicadas);
        const agora = new Date().toISOString();
        for (const op of r.ok) novas.set(op.id, agora);
        const diarioAntes = diario;
        confirmar(r, novas, null, enviadas);
        diario = diarioAntes; // não foram confirmadas por um remoto: não entram no diário
        estado.ultimaSync = null;
        await salvarLocal();
        aoMudar();
      });
    }

    // Outra pasta/arquivo: o etag guardado e o diário não valem mais.
    function desvincular() {
      return exclusivo(async () => {
        exigirLivre();
        base = Object.assign({}, base, { etag: null });
        diario = new Map();
        await salvarLocal();
        aoMudar();
      });
    }

    // Substituição total (importação da planilha ou restauração de backup): não é operação.
    // Exige fila vazia; SEMPRE lê o arquivo remoto e guarda uma cópia dele em backup/ antes de gravar o novo
    // banco (alterações recentes de outros computadores ficam recuperáveis). Permitida também com o estado
    // local inválido (é a forma de sair dele).
    function substituirBase(novo) {
      return exclusivo(async () => {
        exigirLivre('estado-invalido');
        validar(novo);
        if (pendentes.length) throw erroSync('fila', `Há ${pendentes.length} alteração(ões) aguardando sincronização. Sincronize antes de substituir os dados.`);
        let etag = null, aplicadas = base.aplicadas;
        if (remoto && remoto.disponivel()) {
          let feito = false;
          for (let tentativa = 1; tentativa <= MAX_TENTATIVAS && !feito; tentativa++) {
            const lido = await remoto.ler();
            aplicadas = base.aplicadas;
            if (lido) {
              let remDb = null, legivel = true;
              try { const x = abrirRemoto(lido.texto, validar); aplicadas = new Map([...base.aplicadas, ...x.aplicadas]); remDb = x.db; }
              catch (e) { legivel = false; }
              if (o.backup) {
                const ok = await o.backup(legivel ? 'arquivo-antes-de-substituir' : 'arquivo-ilegivel', lido.texto, remDb);
                if (ok === false) throw new Error('Não foi possível guardar uma cópia do arquivo da pasta antes de substituir. Nada foi alterado.');
              }
            }
            try {
              etag = (await remoto.gravar(serializarRemoto(novo, aplicadas), lido ? lido.etag : null)).etag;
              feito = true;
            } catch (e) { if (!ehPrecondicao(e)) throw e; }
          }
          if (!feito) throw erroSync('concorrencia', 'O arquivo foi alterado várias vezes seguidas. Tente de novo.');
          estado.ultimaSync = new Date().toISOString();
        }
        base = { db: structuredClone(novo), etag, aplicadas };
        if (estado.bloqueio && estado.bloqueio.codigo === 'estado-invalido') estado.bloqueio = null;
        estado.conflitoVersoes = null;
        recalcular();
        await salvarLocal();
        aoMudar();
      });
    }

    // Saída do estado local inválido sem backup: recomeça vazio e, na próxima sincronização, adota o arquivo
    // da pasta. (O estado inválido já foi copiado por quem detectou o problema.)
    function recomecarDoArquivo() {
      return exclusivo(async () => {
        exigirLivre('estado-invalido');
        base = { db: App.ledger.novoBanco(), etag: null, aplicadas: new Map() };
        pendentes = []; conflitos = []; diario = new Map();
        estado.bloqueio = null;
        recalcular();
        await salvarLocal();
        aoMudar();
      });
    }

    async function descartarConflito(id) {
      exigirLivre();
      conflitos = conflitos.filter(c => c.id !== id);
      await salvarLocal();
      aoMudar();
    }

    async function dispensarAlerta(id) {
      exigirLivre();
      alertas = alertas.filter(a => a.id !== id);
      await salvarLocal();
      aoMudar();
    }

    // Reaplica a operação do conflito sobre o banco atual; se passar, volta para a fila (mesmo id e data).
    async function tentarDeNovo(id) {
      exigirLivre();
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
      descartarConflito, tentarDeNovo, dispensarAlerta, bloquear, recomecarDoArquivo,
      get db() { return db; },
      get pendentes() { return pendentes.slice(); },
      get conflitos() { return conflitos.slice(); },
      get alertas() { return alertas.slice(); },
      get diario() { return [...diario.values()]; },
      get base() { return { db: base.db, etag: base.etag, aplicadas: new Map(base.aplicadas) }; },
    };
  }

  App.sync = {
    FORMATO, SCHEMA_REMOTO, OPERACOES, LIMITE_TEXTO, DIARIO_DIAS, RETENCAO_IDS_DIAS, registrarOperacao, rotuloOperacao, permitida,
    novaOperacao, validarOperacao, aplicar, reaplicar, serializarRemoto, abrirRemoto, extrairBanco, operacoesPresentes,
    erroSync, erroPrecondicao, erroOffline, ehPrecondicao, criarMotor, criarFila,
  };
})(globalThis.App = globalThis.App || {});

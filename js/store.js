/* Persistência local e ligação com o armazenamento remoto.
   IndexedDB guarda o estado da sincronização (base + fila de operações + conflitos) e a pasta escolhida.
   O remoto padrão é o estoque.json numa pasta sincronizada com o SharePoint/OneDrive (App.remoto.pasta),
   com backup diário automático em <pasta>/backup/ antes da primeira gravação do dia.
   Login Microsoft/Graph, depois: troque o remoto em criarRemoto() por App.remoto.graph({...}). */
(function (App) {
  'use strict';

  const IDB_NOME = 'estoque-infra';
  const IDB_STORE = 'kv';

  const estado = {
    pasta: null,          // FileSystemDirectoryHandle
    conexao: 'sem-pasta', // sem-pasta | conectado | reconectar | indisponivel
    erro: null,
    copiasExtras: [],     // outros estoque*.json na pasta (cópias de conflito do OneDrive)
    corrompido: null,     // chave do IndexedDB com a cópia do estado local inválido
  };
  const ouvintes = new Set();
  function notificar() { ouvintes.forEach(f => { try { f(estado); } catch (e) { console.error(e); } }); }

  // ---------- IndexedDB ----------
  let idbPromessa = null;
  function idb() {
    if (!idbPromessa) {
      idbPromessa = new Promise((ok, falha) => {
        const req = indexedDB.open(IDB_NOME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
        req.onsuccess = () => ok(req.result);
        req.onerror = () => falha(req.error);
      });
    }
    return idbPromessa;
  }
  async function idbGet(k) {
    const d = await idb();
    return new Promise((ok, falha) => {
      const r = d.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(k);
      r.onsuccess = () => ok(r.result); r.onerror = () => falha(r.error);
    });
  }
  async function idbSet(k, v) {
    const d = await idb();
    return new Promise((ok, falha) => {
      const tx = d.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(v, k);
      tx.oncomplete = () => ok(); tx.onerror = () => falha(tx.error); tx.onabort = () => falha(tx.error);
    });
  }

  // ---------- Validação ----------
  // Validação profunda de um banco vindo do arquivo da pasta, de backup ou do IndexedDB, ANTES de ser adotado.
  // Lança erro com mensagem clara (quem chamou mantém a base atual). Campos desconhecidos são preservados.
  const MAX_REGISTROS = 500000; // por lista
  const MAX_SALDO = 1e9;
  function validarBanco(obj) {
    const L = App.ledger;
    const falha = msg => { throw new Error(`Dados inválidos: ${msg}.`); };
    const objeto = v => !!v && typeof v === 'object' && !Array.isArray(v);
    const texto = v => v === null || v === undefined || typeof v === 'string';
    const idOk = v => typeof v === 'string' && v.length > 0 && v.length <= 200;
    const naLista = (lista, k) => typeof k === 'string' && Object.hasOwn(lista, k);
    const opcional = (v, ok) => v === null || v === undefined || ok(v);

    if (!objeto(obj)) throw new Error('Arquivo não contém dados válidos.');
    if (obj.schema !== 1) throw new Error('Versão de dados não reconhecida (schema ' + String(obj.schema).slice(0, 20) + ').');
    // Bancos antigos não têm o cadastro de pessoas: tratado como lista vazia.
    if (obj.pessoas === undefined || obj.pessoas === null) obj.pessoas = [];
    for (const k of ['itens', 'movimentos', 'toners', 'pessoas']) {
      if (!Array.isArray(obj[k])) falha(k === 'pessoas' ? 'cadastro de pessoas malformado' : `"${k}" ausente`);
      if (obj[k].length > MAX_REGISTROS) falha(`"${k}" com registros demais (${obj[k].length})`);
    }
    if (!texto(obj.criadoEm) || !texto(obj.atualizadoEm)) falha('datas do banco');

    const unicos = (lista, nome) => {
      const vistos = new Set();
      lista.forEach((x, i) => {
        if (!objeto(x)) falha(`${nome} nº ${i + 1} malformado`);
        if (!idOk(x.id)) falha(`${nome} nº ${i + 1} sem identificador`);
        if (vistos.has(x.id)) falha(`identificador de ${nome} repetido (${x.id.slice(0, 60)})`);
        vistos.add(x.id);
      });
    };

    unicos(obj.itens, 'item');
    obj.itens.forEach((it, i) => {
      const onde = `item nº ${i + 1}`;
      if (it.controle !== 'unidade' && it.controle !== 'quantidade') falha(`${onde}: controle inválido`);
      if (typeof it.categoria !== 'string' || typeof it.descricao !== 'string') falha(`${onde}: categoria/descrição`);
      if (!objeto(it.saldo)) falha(`${onde}: saldo ausente`);
      for (const loc of Object.keys(L.LOCAIS)) {
        const s = it.saldo[loc];
        if (!Number.isSafeInteger(s) || s < 0 || s > MAX_SALDO) falha(`${onde}: saldo em ${L.LOCAIS[loc]} inválido`);
      }
      if (!naLista(L.STATUS, it.status)) falha(`${onde}: situação inválida`);
      if (!opcional(it.local, v => naLista(L.LOCAIS, v))) falha(`${onde}: local inválido`);
      for (const c of ['serie', 'patrimonio', 'proprietario', 'posicao', 'responsavelAtual', 'responsavelId', 'obs', 'criadoEm', 'atualizadoEm']) {
        if (!texto(it[c])) falha(`${onde}: campo "${c}" inválido`);
      }
      if (!opcional(it.excluido, objeto)) falha(`${onde}: marcação de Lixeira inválida`);
    });

    obj.movimentos.forEach((m, i) => {
      const onde = `movimentação nº ${i + 1}`;
      if (!objeto(m)) falha(`${onde} malformada`);
      if (!idOk(m.id)) falha(`${onde} sem identificador`);
      if (!naLista(L.TIPOS, m.tipo)) falha(`${onde}: tipo desconhecido`);
      if (!Number.isFinite(m.delta) || Math.abs(m.delta) > MAX_SALDO) falha(`${onde}: quantidade (delta) inválida`);
      if (!opcional(m.quantidade, v => Number.isFinite(v) && Math.abs(v) <= MAX_SALDO)) falha(`${onde}: quantidade inválida`);
      if (!opcional(m.local, v => naLista(L.LOCAIS, v))) falha(`${onde}: local inválido`);
      for (const c of ['itemId', 'tonerId', 'pessoaId', 'usuario', 'chamado', 'data', 'obs', 'criadoEm', 'lote', 'refMovimento']) {
        if (!texto(m[c])) falha(`${onde}: campo "${c}" inválido`);
      }
      if (!opcional(m.item, objeto) || !opcional(m.descarte, objeto) || !opcional(m.autor, objeto)) falha(`${onde}: dados complementares inválidos`);
      if (!opcional(m.alteracoes, Array.isArray)) falha(`${onde}: lista de alterações inválida`);
    });

    unicos(obj.toners, 'toner');
    obj.toners.forEach((t, i) => {
      const onde = `toner nº ${i + 1}`;
      if (typeof t.modelo !== 'string') falha(`${onde}: modelo inválido`);
      if (!naLista(L.STATUS_TONER, t.status)) falha(`${onde}: situação inválida`);
      for (const c of ['cor', 'impressora', 'obs']) if (!texto(t[c])) falha(`${onde}: campo "${c}" inválido`);
      if (!opcional(t.excluido, objeto)) falha(`${onde}: marcação de Lixeira inválida`);
    });

    unicos(obj.pessoas, 'pessoa (cadastro de pessoas)');
    obj.pessoas.forEach((p, i) => {
      const onde = `cadastro de pessoas, registro nº ${i + 1}`;
      if (typeof p.nome !== 'string' || !p.nome) falha(`${onde}: nome inválido`);
      if (!naLista(L.TIPOS_PESSOA, p.tipo)) falha(`${onde}: tipo inválido`);
      if (typeof p.ativo !== 'boolean') falha(`${onde}: situação (ativo) inválida`);
      for (const c of ['email', 'departamento', 'unidade', 'obs', 'entraId']) if (!texto(p[c])) falha(`${onde}: campo "${c}" inválido`);
    });
    return obj;
  }

  // ---------- Uma aba por vez ----------
  // Duas abas com o mesmo IndexedDB gravariam a fila uma por cima da outra. A primeira aba segura uma trava
  // (Web Locks) enquanto estiver aberta; as outras mostram "já está aberta em outra aba" e não alteram nada.
  // Sem Web Locks: tenta BroadcastChannel; sem nenhum dos dois (Node/testes): segue normalmente.
  const NOME_TRAVA = 'estoque-infra';
  function travarAba(locks, Canal) {
    if (locks && typeof locks.request === 'function') {
      return new Promise((ok, falha) => {
        locks.request(NOME_TRAVA, { ifAvailable: true }, trava => {
          if (!trava) { ok(false); return undefined; }
          ok(true);
          return new Promise(() => {}); // mantém a trava até a aba fechar
        }).catch(falha);
      });
    }
    if (typeof Canal === 'function') {
      return new Promise(ok => {
        const c = new Canal(NOME_TRAVA + '-aba');
        let outra = false, ativa = false;
        c.onmessage = ev => {
          if (ev.data === 'quem-esta-aberta?' && ativa) c.postMessage('aberta');
          else if (ev.data === 'aberta') outra = true;
        };
        c.postMessage('quem-esta-aberta?');
        setTimeout(() => { if (outra) { c.close(); ok(false); } else { ativa = true; ok(true); } }, 300);
      });
    }
    return Promise.resolve(true);
  }

  // Bloqueia o motor se outra aba já estiver ativa. Retorna true se esta aba pode alterar dados.
  async function garantirAbaUnica(motorAlvo, locks, Canal) {
    let unica = true;
    try { unica = await travarAba(locks, Canal); } catch (e) {
      console.error(e); // Web Locks indisponível neste contexto: tenta o BroadcastChannel
      try { unica = await travarAba(null, Canal); } catch (x) { console.error(x); unica = true; }
    }
    if (!unica) motorAlvo.bloquear('outra-aba');
    return unica;
  }

  // ---------- Sincronização periódica ----------
  // Puxa as alterações dos outros computadores a cada 5 min com a aba visível, ao voltar para a aba e ao focar.
  function ligarSincronizacaoPeriodica({ documento, janela, sincronizar: fn, intervaloMs = 5 * 60000, definirIntervalo = setInterval }) {
    const visivel = () => !documento || documento.visibilityState === 'visible';
    const talvez = () => { if (visivel()) fn(); };
    const id = definirIntervalo(talvez, intervaloMs);
    if (documento) documento.addEventListener('visibilitychange', talvez);
    if (janela) janela.addEventListener('focus', talvez);
    return id;
  }

  // ---------- Remoto e motor de sincronização ----------
  const suportaPasta = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

  function criarRemoto() {
    return App.remoto.pasta({
      obterPasta: () => (estado.conexao === 'conectado' ? estado.pasta : null),
      ultimoBackup: { ler: () => idbGet('ultimoBackup'), gravar: d => idbSet('ultimoBackup', d) },
      planilha: db => (App.exporter ? App.exporter.planilhaBinaria(db) : null),
    });
  }
  const remoto = criarRemoto();

  async function gravarBackup(prefixo, texto, db) {
    if (estado.conexao !== 'conectado' || !remoto.backup) return false;
    return remoto.backup(prefixo, texto, db);
  }

  const motor = App.sync.criarMotor({
    remoto, validar: validarBanco, backup: gravarBackup, aoMudar: notificar,
    persistir: s => idbSet('sync', s),
  });

  function erroDePermissao(e) { return e && (e.name === 'NotAllowedError' || e.name === 'SecurityError'); }

  // Sincroniza conforme a conexão. Erros ficam em estado.erro (a fila continua guardada).
  async function sincronizar() {
    if (motor.estado.bloqueio) { notificar(); return null; }
    if (estado.conexao === 'sem-pasta' || estado.conexao === 'indisponivel') {
      try { await motor.consolidarLocal(); } catch (e) { estado.erro = 'Não foi possível salvar no navegador: ' + e.message; }
      notificar();
      return null;
    }
    if (estado.conexao !== 'conectado') { notificar(); return null; }
    try {
      const r = await motor.sincronizar();
      estado.erro = null;
      await verificarCopias();
      return r;
    } catch (e) {
      console.error(e);
      if (erroDePermissao(e)) { estado.conexao = 'reconectar'; estado.erro = null; }
      else estado.erro = 'Falha ao sincronizar: ' + (e.message || e.name);
      return null;
    } finally { notificar(); }
  }
  const agendarSincronizacao = App.util.debounce(() => { sincronizar(); }, 800);

  // Cópias de conflito do OneDrive (estoque-NOMEDOPC.json etc.): só lista para o aviso em "Dados e backup".
  async function verificarCopias() {
    if (!remoto.copiasExtras) return;
    try { estado.copiasExtras = await remoto.copiasExtras(); } catch (e) { console.error(e); }
  }

  async function executar(nome, args, autor) {
    const r = await motor.executar(nome, args, autor);
    if (r.erroLocal) estado.erro = 'Alteração feita, mas não foi possível salvar no navegador: ' + r.erroLocal.message;
    agendarSincronizacao();
    return r.resultado;
  }

  async function resolverConflito(usar) {
    try { await motor.resolverVersoes(usar); }
    catch (e) {
      console.error(e);
      if (erroDePermissao(e)) estado.conexao = 'reconectar';
      else estado.erro = 'Falha ao gravar a versão escolhida: ' + (e.message || e.name);
      notificar();
      throw e;
    }
    return sincronizar();
  }

  // Estado local que não passa na validação: guarda uma cópia bruta, mantém o motor bloqueado (nada é
  // gravado por cima) e orienta o usuário (restaurar backup ou carregar do arquivo da pasta).
  async function carregarEstadoLocal() {
    let bruto = null;
    try {
      bruto = await idbGet('sync');
      if (bruto) return motor.carregar(bruto);
      // Versão anterior guardava só o banco em 'db': vira a base local, ainda sem vínculo (etag) com o arquivo.
      bruto = await idbGet('db');
      if (bruto) motor.carregar({ base: { db: bruto, etag: null, aplicadas: [] } });
    } catch (e) {
      console.error(e);
      if (!motor.estado.bloqueio) motor.bloquear('estado-invalido');
      const chave = 'sync-corrompido-' + Date.now();
      try { await idbSet(chave, bruto); estado.corrompido = chave; } catch (x) { console.error(x); }
      estado.erro = `Os dados guardados neste navegador estão inválidos e não foram usados (${e.message || e}). ` +
        (estado.corrompido ? `Uma cópia foi guardada no navegador ("${estado.corrompido}"). ` : '') +
        'Nenhuma alteração é permitida até resolver: em "Dados e backup", restaure um backup (.json) ou carregue os dados do arquivo da pasta.';
    }
  }

  async function iniciar() {
    // Uma aba por vez: a segunda não carrega nem grava nada.
    if (!(await garantirAbaUnica(motor, typeof navigator !== 'undefined' ? navigator.locks : null, typeof BroadcastChannel !== 'undefined' ? BroadcastChannel : null))) {
      notificar();
      return null;
    }
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* opcional */ }
    await carregarEstadoLocal();
    if (!suportaPasta()) { estado.conexao = 'indisponivel'; return sincronizar(); }
    const pasta = await idbGet('pasta');
    if (!pasta) { estado.conexao = 'sem-pasta'; return sincronizar(); }
    estado.pasta = pasta;
    const perm = await pasta.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') { estado.conexao = 'reconectar'; notificar(); return null; }
    estado.conexao = 'conectado';
    notificar();
    return sincronizar();
  }

  async function escolherPasta() {
    const pasta = await window.showDirectoryPicker({ id: 'estoque-infra', mode: 'readwrite' });
    const mesma = estado.pasta && await estado.pasta.isSameEntry(pasta).catch(() => false);
    estado.pasta = pasta;
    estado.conexao = 'conectado';
    estado.erro = null;
    await idbSet('pasta', pasta);
    // O etag da pasta anterior não vale para esta. (Com o estado local bloqueado não há etag a esquecer.)
    if (!mesma && !motor.estado.bloqueio) await motor.desvincular();
    notificar();
    return sincronizar();
  }

  async function reconectar() {
    if (!estado.pasta) return escolherPasta();
    const perm = await estado.pasta.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw new Error('Permissão negada para a pasta de dados.');
    estado.conexao = 'conectado';
    estado.erro = null;
    notificar();
    return sincronizar();
  }

  // Importação e restauração substituem tudo: exigem a fila vazia. Sincroniza antes SEMPRE (mesmo com a fila
  // vazia), para a tela mostrar os dados atuais do arquivo antes da confirmação.
  async function prepararSubstituicao() {
    const b = motor.estado.bloqueio;
    if (b && b.codigo !== 'estado-invalido') throw new Error(b.mensagem);
    if (!b) await sincronizar();
    const n = motor.pendentes.length;
    if (n) throw new Error(`Há ${n} ${n === 1 ? 'alteração' : 'alterações'} deste computador aguardando sincronização. Conecte a pasta e clique em "Sincronizar agora" antes de substituir os dados.`);
    if (estado.conexao === 'reconectar') throw new Error('Reconecte a pasta de dados antes de substituir os dados.');
  }

  // Grava o novo banco como base (sem virar operação), guardando antes uma cópia do estado anterior.
  async function substituirBanco(novo, motivo) {
    validarBanco(novo);
    await prepararSubstituicao();
    const atual = motor.db;
    let copiaFeita = false;
    if (atual && (atual.itens.length || atual.movimentos.length)) {
      copiaFeita = await gravarBackup('antes-de-' + motivo, JSON.stringify(atual), atual).catch(() => false);
      if (!copiaFeita && App.exporter) App.exporter.baixarJSON(atual, 'antes-de-' + motivo);
    }
    await motor.substituirBase(novo);
    estado.erro = null;
    notificar();
    return copiaFeita;
  }

  // Saída do estado local inválido: recomeça do arquivo da pasta (a cópia do estado inválido fica no navegador).
  async function recomecarDoArquivo() {
    if (estado.conexao !== 'conectado') throw new Error('Conecte a pasta de dados antes de carregar do arquivo.');
    await motor.recomecarDoArquivo();
    estado.erro = null;
    return sincronizar();
  }

  async function dispensarAlerta(id) { await motor.dispensarAlerta(id); }
  async function descartarConflito(id) { await motor.descartarConflito(id); }
  async function tentarConflitoDeNovo(id) { await motor.tentarDeNovo(id); agendarSincronizacao(); }

  function nomePasta() { return estado.pasta ? estado.pasta.name : null; }

  App.store = {
    estado, iniciar, executar, sincronizar, escolherPasta, reconectar, resolverConflito,
    prepararSubstituicao, substituirBanco, validarBanco, descartarConflito, tentarConflitoDeNovo,
    recomecarDoArquivo, dispensarAlerta, travarAba, garantirAbaUnica, ligarSincronizacaoPeriodica,
    gravarBackup, nomePasta, suportaPasta, onStatus: f => { ouvintes.add(f); return () => ouvintes.delete(f); },
    sync: motor,
    remoto,
    get db() { return motor.db; },
  };
})(globalThis.App = globalThis.App || {});

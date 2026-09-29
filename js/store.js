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
  function validarBanco(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('Arquivo não contém dados válidos.');
    if (obj.schema !== 1) throw new Error('Versão de dados não reconhecida (schema ' + obj.schema + ').');
    for (const k of ['itens', 'movimentos', 'toners']) if (!Array.isArray(obj[k])) throw new Error(`Dados inválidos: "${k}" ausente.`);
    for (const it of obj.itens) {
      if (!it || typeof it.id !== 'string' || !it.saldo || typeof it.saldo.MATRIZ !== 'number') throw new Error('Dados inválidos: item malformado.');
    }
    return obj;
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
    if (estado.conexao === 'sem-pasta' || estado.conexao === 'indisponivel') {
      try { await motor.consolidarLocal(); } catch (e) { estado.erro = 'Não foi possível salvar no navegador: ' + e.message; }
      notificar();
      return null;
    }
    if (estado.conexao !== 'conectado') { notificar(); return null; }
    try {
      const r = await motor.sincronizar();
      estado.erro = null;
      return r;
    } catch (e) {
      console.error(e);
      if (erroDePermissao(e)) { estado.conexao = 'reconectar'; estado.erro = null; }
      else estado.erro = 'Falha ao sincronizar: ' + (e.message || e.name);
      return null;
    } finally { notificar(); }
  }
  const agendarSincronizacao = App.util.debounce(() => { sincronizar(); }, 800);

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

  async function iniciar() {
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* opcional */ }
    const salvo = await idbGet('sync');
    if (salvo) motor.carregar(salvo);
    else {
      // Versão anterior guardava só o banco em 'db': vira a base local, ainda sem vínculo (etag) com o arquivo.
      const antigo = await idbGet('db');
      if (antigo) motor.carregar({ base: { db: validarBanco(antigo), etag: null, aplicadas: [] } });
    }
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
    if (!mesma) await motor.desvincular(); // o etag da pasta anterior não vale para esta
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

  // Importação e restauração substituem tudo: exigem a fila vazia (sincroniza antes, se der).
  async function prepararSubstituicao() {
    if (motor.pendentes.length) await sincronizar();
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

  async function descartarConflito(id) { await motor.descartarConflito(id); }
  async function tentarConflitoDeNovo(id) { await motor.tentarDeNovo(id); agendarSincronizacao(); }

  function nomePasta() { return estado.pasta ? estado.pasta.name : null; }

  App.store = {
    estado, iniciar, executar, sincronizar, escolherPasta, reconectar, resolverConflito,
    prepararSubstituicao, substituirBanco, validarBanco, descartarConflito, tentarConflitoDeNovo,
    gravarBackup, nomePasta, suportaPasta, onStatus: f => { ouvintes.add(f); return () => ouvintes.delete(f); },
    sync: motor,
    remoto,
    get db() { return motor.db; },
  };
})(globalThis.App = globalThis.App || {});

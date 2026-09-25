/* Persistência: IndexedDB (cópia de trabalho) + estoque.json numa pasta escolhida pelo usuário (fonte de verdade).
   Backup diário automático em <pasta>/backup/ antes da primeira gravação do dia. */
(function (App) {
  'use strict';
  const { hojeISO, pad } = App.util;

  const IDB_NOME = 'estoque-infra';
  const IDB_STORE = 'kv';
  const ARQUIVO = 'estoque.json';
  const PASTA_BACKUP = 'backup';

  const estado = {
    db: null,
    pasta: null,          // FileSystemDirectoryHandle
    conexao: 'sem-pasta', // sem-pasta | conectado | reconectar | indisponivel
    gravandoArquivo: false,
    pendenteArquivo: false,
    ultimoArquivo: null,  // Date da última gravação no arquivo
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

  // ---------- Arquivo ----------
  const suportaPasta = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

  async function lerArquivo(pasta) {
    try {
      const fh = await pasta.getFileHandle(ARQUIVO);
      const f = await fh.getFile();
      const texto = await f.text();
      return { texto, db: validarBanco(JSON.parse(texto)) };
    } catch (e) {
      if (e && e.name === 'NotFoundError') return null;
      throw e;
    }
  }

  async function escreverTexto(pasta, nome, conteudo) {
    const fh = await pasta.getFileHandle(nome, { create: true });
    const w = await fh.createWritable();
    await w.write(conteudo);
    await w.close();
  }

  function carimbo() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  async function gravarBackup(prefixo, texto, dbParaPlanilha) {
    if (!estado.pasta || estado.conexao !== 'conectado') return false;
    const dir = await estado.pasta.getDirectoryHandle(PASTA_BACKUP, { create: true });
    const nome = `${prefixo}-${carimbo()}`;
    await escreverTexto(dir, nome + '.json', texto);
    if (dbParaPlanilha && App.exporter) {
      const bin = App.exporter.planilhaBinaria(dbParaPlanilha);
      await escreverTexto(dir, nome + '.xlsx', new Blob([bin], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    }
    return true;
  }

  async function gravarArquivoAgora() {
    if (!estado.pasta || estado.conexao !== 'conectado' || !estado.db) return;
    if (estado.gravandoArquivo) { estado.pendenteArquivo = true; return; }
    estado.gravandoArquivo = true; estado.pendenteArquivo = false; notificar();
    try {
      // Backup diário: guarda a versão anterior do arquivo antes da primeira gravação do dia.
      const hoje = hojeISO();
      if ((await idbGet('ultimoBackup')) !== hoje) {
        const atual = await lerArquivo(estado.pasta).catch(() => null);
        if (atual) await gravarBackup('estoque', atual.texto, atual.db);
        await idbSet('ultimoBackup', hoje);
      }
      await escreverTexto(estado.pasta, ARQUIVO, JSON.stringify(estado.db, null, 1));
      estado.ultimoArquivo = new Date();
      estado.erro = null;
    } catch (e) {
      console.error(e);
      estado.erro = 'Falha ao gravar estoque.json: ' + (e.message || e.name);
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) estado.conexao = 'reconectar';
      estado.pendenteArquivo = true;
    } finally {
      estado.gravandoArquivo = false;
      notificar();
      if (estado.pendenteArquivo && estado.conexao === 'conectado' && !estado.erro) gravarArquivoAgora();
    }
  }
  const gravarArquivo = App.util.debounce(gravarArquivoAgora, 300);

  // ---------- API ----------

  async function salvar() {
    if (!estado.db) return;
    await idbSet('db', estado.db);
    if (estado.conexao === 'conectado') { estado.pendenteArquivo = true; notificar(); gravarArquivo(); }
    else notificar();
  }

  // Compara arquivo x navegador. Retorna null quando está tudo sincronizado, ou {conflito} para o usuário decidir.
  async function sincronizar() {
    const arq = await lerArquivo(estado.pasta);
    const local = estado.db;
    if (!arq && !local) return null;
    if (!arq) { await gravarArquivoAgora(); return null; }
    if (!local || !local.itens.length && !local.movimentos.length) {
      estado.db = arq.db; await idbSet('db', estado.db); notificar(); return null;
    }
    if (arq.db.atualizadoEm === local.atualizadoEm) { estado.ultimoArquivo = new Date(); notificar(); return null; }
    return { conflito: { arquivo: arq.db.atualizadoEm, navegador: local.atualizadoEm, arq } };
  }

  async function resolverConflito(conflito, usar) {
    if (usar === 'arquivo') {
      await gravarBackup('navegador-antes-de-usar-arquivo', JSON.stringify(estado.db));
      estado.db = conflito.arq.db;
      await idbSet('db', estado.db);
    } else {
      await gravarBackup('arquivo-antes-de-usar-navegador', conflito.arq.texto);
      await gravarArquivoAgora();
    }
    notificar();
  }

  async function iniciar() {
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* opcional */ }
    const salvo = await idbGet('db');
    estado.db = salvo ? validarBanco(salvo) : null;
    if (!suportaPasta()) { estado.conexao = 'indisponivel'; notificar(); return null; }
    const pasta = await idbGet('pasta');
    if (!pasta) { estado.conexao = 'sem-pasta'; notificar(); return null; }
    estado.pasta = pasta;
    const perm = await pasta.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') { estado.conexao = 'reconectar'; notificar(); return null; }
    estado.conexao = 'conectado';
    notificar();
    return sincronizar();
  }

  async function escolherPasta() {
    const pasta = await window.showDirectoryPicker({ id: 'estoque-infra', mode: 'readwrite' });
    estado.pasta = pasta;
    estado.conexao = 'conectado';
    estado.erro = null;
    await idbSet('pasta', pasta);
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

  // Substitui todos os dados (importação ou restauração), guardando antes uma cópia do estado anterior.
  async function substituirBanco(novo, motivo) {
    validarBanco(novo);
    let copiaFeita = false;
    if (estado.db && (estado.db.itens.length || estado.db.movimentos.length)) {
      copiaFeita = await gravarBackup('antes-de-' + motivo, JSON.stringify(estado.db), estado.db).catch(() => false);
      if (!copiaFeita && App.exporter) App.exporter.baixarJSON(estado.db, 'antes-de-' + motivo);
    }
    estado.db = novo;
    await salvar();
    return copiaFeita;
  }

  function nomePasta() { return estado.pasta ? estado.pasta.name : null; }

  App.store = {
    estado, iniciar, salvar, escolherPasta, reconectar, resolverConflito, substituirBanco, validarBanco,
    gravarBackup, nomePasta, suportaPasta, onStatus: f => { ouvintes.add(f); return () => ouvintes.delete(f); },
    get db() { return estado.db; },
    set db(v) { estado.db = v; },
  };
})(globalThis.App = globalThis.App || {});

/* Adaptadores de armazenamento remoto usados pela sincronização (js/sync.js).
   Interface: { nome, disponivel(), ler() -> { texto, etag } | null, gravar(texto, etagEsperado) -> { etag } }
   - gravar lança erro com codigo 'precondicao' (App.sync.erroPrecondicao) se o arquivo mudou desde a leitura
     (etagEsperado null = o arquivo ainda não pode existir); falta de conexão lança codigo 'offline'.
   - backup(prefixo, texto, db) é opcional.
   Implementações: pasta (padrão, estoque.json numa pasta local/OneDrive), memoria (testes) e graph (esqueleto). */
(function (App) {
  'use strict';
  const { hojeISO, pad } = App.util;

  const ARQUIVO = 'estoque.json';
  const PASTA_BACKUP = 'backup';
  const TIPO_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  // Hash rápido (cyrb53) do conteúdo: o etag da pasta muda só quando o conteúdo muda. Não é criptográfico
  // (só detecta alteração), e não depende de crypto.subtle, que pode faltar em file://.
  function hashTexto(s) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }
  const etagDe = texto => `${texto.length}-${hashTexto(texto)}`;

  function carimbo() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  // ---------- Pasta (File System Access API) ----------
  /**
   * o = { obterPasta() -> FileSystemDirectoryHandle com permissão | null,
   *       ultimoBackup: { ler() -> 'AAAA-MM-DD', gravar(dia) },   // controle do backup diário
   *       planilha(db) -> ArrayBuffer (opcional: .xlsx junto do .json no backup) }
   * Antes de sobrescrever o arquivo: cópia diária em backup/ e, na migração do formato antigo (schema 1),
   * uma cópia do arquivo antigo. A verificação do etag é feita logo antes de gravar; a pasta não tem
   * trava entre máquinas (o OneDrive sincroniza depois), por isso o modo definitivo é o Graph com If-Match.
   */
  function pasta(o) {
    async function lerArquivo(dir) {
      try {
        const fh = await dir.getFileHandle(ARQUIVO);
        const texto = await (await fh.getFile()).text();
        return { texto, etag: etagDe(texto) };
      } catch (e) {
        if (e && e.name === 'NotFoundError') return null;
        throw e;
      }
    }

    async function escrever(dir, nome, conteudo) {
      const fh = await dir.getFileHandle(nome, { create: true });
      const w = await fh.createWritable();
      await w.write(conteudo);
      await w.close();
    }

    async function backup(prefixo, texto, db) {
      const dir = o.obterPasta();
      if (!dir) return false;
      const b = await dir.getDirectoryHandle(PASTA_BACKUP, { create: true });
      const nome = `${prefixo}-${carimbo()}`;
      await escrever(b, nome + '.json', texto);
      if (db && o.planilha) {
        let bin = null;
        try { bin = o.planilha(db); } catch (e) { console.error(e); }
        if (bin) await escrever(b, nome + '.xlsx', new Blob([bin], { type: TIPO_XLSX }));
      }
      return true;
    }

    function bancoDoTexto(texto) {
      try {
        const obj = JSON.parse(texto);
        if (obj && obj.schema === 1) return { db: obj, legado: true };
        return { db: obj && obj.db && Array.isArray(obj.db.itens) ? obj.db : null, legado: false };
      } catch (e) { return { db: null, legado: false }; } // ilegível: vai para o backup como está
    }

    // Gravações deste processo passam uma de cada vez pelo trecho "confere etag → escreve".
    const exclusivo = App.sync.criarFila();
    const etagAtual = atual => (atual ? atual.etag : null);

    // Outros estoque*.json na pasta (ex.: cópias de conflito do OneDrive "estoque-NOMEDOPC.json"): só avisa.
    async function copiasExtras() {
      const dir = o.obterPasta();
      if (!dir || typeof dir.values !== 'function') return [];
      const nomes = [];
      for await (const x of dir.values()) {
        if (x && x.kind === 'file' && /^estoque.*\.json$/i.test(x.name) && x.name.toLowerCase() !== ARQUIVO) nomes.push(x.name);
      }
      return nomes.sort();
    }

    return {
      nome: 'Pasta',
      arquivo: ARQUIVO,
      disponivel: () => !!o.obterPasta(),
      backup,
      copiasExtras,
      async ler() {
        const dir = o.obterPasta();
        if (!dir) throw App.sync.erroOffline('Pasta de dados desconectada.');
        return lerArquivo(dir);
      },
      async gravar(texto, etagEsperado) {
        const dir = o.obterPasta();
        if (!dir) throw App.sync.erroOffline('Pasta de dados desconectada.');
        const esperado = etagEsperado ?? null;
        const atual = await lerArquivo(dir);
        if (etagAtual(atual) !== esperado) throw App.sync.erroPrecondicao();
        // Backups ANTES da checagem final (podem demorar: .xlsx, OneDrive).
        if (atual) {
          const { db, legado } = bancoDoTexto(atual.texto);
          if (legado) await backup('estoque-schema1-antes-da-migracao', atual.texto, db);
          const hoje = hojeISO();
          if ((await o.ultimoBackup.ler()) !== hoje) {
            await backup('estoque', atual.texto, db);
            await o.ultimoBackup.gravar(hoje);
          }
        }
        // Relê e confere o etag imediatamente antes de escrever, sem outra gravação deste processo no meio.
        // (Entre máquinas não há trava: o OneDrive sincroniza depois; o modo definitivo é o Graph com If-Match.)
        return exclusivo(async () => {
          if (etagAtual(await lerArquivo(dir)) !== esperado) throw App.sync.erroPrecondicao();
          await escrever(dir, ARQUIVO, texto);
          return { etag: etagDe(texto) };
        });
      },
    };
  }

  // ---------- Memória (testes / simulação) ----------
  // offline = true simula falta de conexão; perderResposta = n faz as próximas n gravações serem aceitas
  // mas "perderem a resposta" (erro de rede depois de gravar); antesDeGravar(m) roda uma vez antes da
  // próxima gravação (simula outro PC gravando no meio).
  function memoria(textoInicial) {
    const m = {
      nome: 'Memória', texto: textoInicial ?? null, versao: 0, offline: false,
      perderResposta: 0, antesDeGravar: null, gravacoes: 0,
      disponivel: () => !m.offline,
      async ler() {
        if (m.offline) throw App.sync.erroOffline();
        return m.texto === null ? null : { texto: m.texto, etag: 'v' + m.versao };
      },
      async gravar(texto, etagEsperado) {
        if (m.offline) throw App.sync.erroOffline();
        if (m.antesDeGravar) { const f = m.antesDeGravar; m.antesDeGravar = null; await f(m); }
        const atual = m.texto === null ? null : 'v' + m.versao;
        if (atual !== (etagEsperado ?? null)) throw App.sync.erroPrecondicao();
        m.texto = texto; m.versao++; m.gravacoes++;
        if (m.perderResposta > 0) { m.perderResposta--; throw App.sync.erroOffline('Resposta perdida (simulado).'); }
        return { etag: 'v' + m.versao };
      },
      // Alteração feita por fora (outro sistema).
      substituir(texto) { m.texto = texto; m.versao++; },
    };
    return m;
  }

  // ---------- SharePoint via Microsoft Graph (a implementar junto com o login MSAL) ----------
  // o = { driveId, itemId | caminho, obterToken() }   (token de App.sessao/MSAL: acquireTokenSilent)
  // ler():    GET  https://graph.microsoft.com/v1.0/drives/{driveId}/items/{itemId}/content
  //           404 -> null; etag = cabeçalho ETag (ou eTag do driveItem). Falha de rede/401 -> erroOffline().
  // gravar(): PUT  .../items/{itemId}/content  com If-Match: <etagEsperado>
  //           arquivo novo: PUT .../root:/{caminho}:/content com If-None-Match: *
  //           412 Precondition Failed -> throw App.sync.erroPrecondicao(); resposta traz o novo eTag.
  // backup(): PUT em backup/{prefixo}-{carimbo}.json na mesma biblioteca (opcional).
  // Permissão mínima: Sites.Selected concedida só ao site da TI. Nada de token em URL ou log.
  function graph() {
    const naoImplementado = async () => { throw App.sync.erroOffline('Armazenamento SharePoint ainda não implementado.'); };
    return { nome: 'SharePoint', disponivel: () => false, ler: naoImplementado, gravar: naoImplementado };
  }

  App.remoto = { ARQUIVO, PASTA_BACKUP, etagDe, pasta, memoria, graph };
})(globalThis.App = globalThis.App || {});

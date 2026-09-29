/* Inicialização, navegação entre telas, indicador de sincronização e execução de operações. */
(function (App) {
  'use strict';
  const { h, clear, preencher, fmtDataHora } = App.util;
  const UI = App.ui;
  const S = App.store;

  const main = document.getElementById('app');
  const statusEl = document.getElementById('status');
  let viewAtual = null;

  // Executa uma operação de negócio sincronizável: nome de uma função do ledger (lista branca em js/sync.js)
  // e argumentos JSON (depois do db). Se a regra lançar erro, nada muda e o erro sobe para quem chamou.
  App.executar = async function (nome, args, msgOk) {
    const r = await S.executar(nome, args, App.sessao.autor());
    if (msgOk) UI.toast(msgOk);
    App.render();
    return r;
  };

  // Substituído por App.executar: closures sobre o db não podem ser sincronizadas.
  App.acao = function () { throw new Error('App.acao foi substituído por App.executar(nome, args, mensagem).'); };

  App.render = function () {
    if (viewAtual && App.views[viewAtual]) {
      const v = App.views[viewAtual];
      if (v.atualizar && main.firstChild) v.atualizar(); else v.montar(main);
    }
    renderStatus();
  };

  function navegar() {
    const nome = (location.hash || '#estoque').slice(1);
    const view = App.views[nome] ? nome : 'estoque';
    UI.fecharMenu();
    viewAtual = view;
    document.querySelectorAll('.abas a').forEach(a => a.setAttribute('aria-current', a.dataset.view === view ? 'page' : 'false'));
    clear(main);
    App.views[view].montar(main);
    main.focus({ preventScroll: true });
    renderStatus();
  }

  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

  function renderStatus() {
    const e = S.estado, sy = S.sync;
    const n = sy.pendentes.length, nc = sy.conflitos.length;
    const aguardando = n ? plural(n, 'alteração aguardando', 'alterações aguardando') + ' sincronização' : null;
    const juntar = (...partes) => partes.filter(Boolean).join(' · ');
    let cls, txt, botao = null;
    if (e.erro) {
      cls = 'erro'; txt = juntar(e.erro, aguardando);
      botao = e.conexao === 'reconectar' ? ['Reconectar', () => conectar(S.reconectar)]
        : e.conexao === 'conectado' ? ['Tentar de novo', () => conectar(S.sincronizar)] : null;
    } else if (e.conexao === 'conectado') {
      if (sy.estado.sincronizando) { cls = 'gravando'; txt = 'Sincronizando…'; }
      else if (n) { cls = 'gravando'; txt = aguardando; }
      else { cls = 'ok'; txt = sy.estado.ultimaSync ? `Sincronizado às ${fmtDataHora(sy.estado.ultimaSync).slice(-5)}` : `Pasta ${S.nomePasta()}`; }
    } else if (e.conexao === 'reconectar') { cls = 'alerta'; txt = juntar('Sem conexão com a pasta', aguardando); botao = ['Reconectar', () => conectar(S.reconectar)]; }
    else if (e.conexao === 'sem-pasta') { cls = 'alerta'; txt = 'Dados só neste navegador'; botao = ['Escolher pasta', () => conectar(S.escolherPasta)]; }
    else { cls = 'alerta'; txt = 'Navegador sem gravação em pasta — use Chrome/Edge'; }
    statusEl.className = 'status ' + cls;
    preencher(statusEl, h('span', { class: 'ponto', 'aria-hidden': 'true' }), h('span', null, txt),
      nc ? h('a', { href: '#dados', style: 'color:inherit' }, plural(nc, 'conflito para revisar', 'conflitos para revisar')) : null,
      botao ? h('button', { type: 'button', class: 'btn pequeno', onclick: botao[1] }, botao[0]) : '');
    if (sy.estado.conflitoVersoes && !resolvendo) setTimeout(resolverVersoes, 0);
  }

  async function conectar(fn) {
    try {
      await fn();
      App.render();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      UI.toast(e.message || String(e), 'erro');
    }
  }
  App.conectar = conectar;

  // Primeira ligação com um arquivo que tem outra versão dos dados (ex.: migração ou troca de pasta).
  let resolvendo = false;
  async function resolverVersoes() {
    const c = S.sync.estado.conflitoVersoes;
    if (!c || resolvendo) return;
    resolvendo = true;
    try {
      // Destaca a versão mais recente (a mais provável de ser a certa); a outra vai para backup/.
      const navegadorMaisNovo = String(c.navegador || '') > String(c.arquivo || '');
      const escolha = await UI.escolher({
        titulo: 'Duas versões dos dados',
        mensagem: `O arquivo estoque.json da pasta foi alterado em ${fmtDataHora(c.arquivo)} e a cópia deste navegador em ${fmtDataHora(c.navegador)}. ` +
          `A mais recente é a ${navegadorMaisNovo ? 'do navegador' : 'da pasta'}. Qual versão usar? A outra será guardada em backup/.`,
        opcoes: [
          { valor: 'navegador', rotulo: 'Usar a cópia do navegador' + (navegadorMaisNovo ? ' (mais recente)' : ''), primario: navegadorMaisNovo },
          { valor: 'arquivo', rotulo: 'Usar o arquivo da pasta' + (navegadorMaisNovo ? '' : ' (mais recente)'), primario: !navegadorMaisNovo },
        ],
      });
      await S.resolverConflito(escolha === 'navegador' ? 'navegador' : 'arquivo');
      UI.toast('Dados sincronizados.');
    } catch (e) {
      UI.toast(e.message || String(e), 'erro');
    } finally {
      resolvendo = false;
      App.render();
    }
  }

  // Atalho "/" para a busca da tela atual.
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('dialog[open]')) return;
    const v = App.views[viewAtual];
    if (v && v.focarBusca) { e.preventDefault(); v.focarBusca(); }
  });

  // A fila fica no IndexedDB: fechar a página não perde nada; só avisa se estiver gravando agora.
  window.addEventListener('beforeunload', e => {
    if (S.sync.estado.sincronizando) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('online', () => { S.sincronizar(); });
  window.addEventListener('hashchange', navegar);
  S.onStatus(renderStatus);

  (async function iniciar() {
    try {
      await S.iniciar();
    } catch (e) {
      console.error(e);
      UI.toast('Problema ao abrir os dados: ' + (e.message || e), 'erro');
    }
    navegar();
  })();
})(globalThis.App = globalThis.App || {});

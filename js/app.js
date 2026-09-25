/* Inicialização, navegação entre telas, indicador de gravação e execução segura de operações. */
(function (App) {
  'use strict';
  const { h, clear, preencher, fmtDataHora } = App.util;
  const UI = App.ui;
  const S = App.store;

  const main = document.getElementById('app');
  const statusEl = document.getElementById('status');
  let viewAtual = null;

  // Executa uma operação de negócio; se falhar, o estado anterior é restaurado por inteiro.
  App.acao = async function (fn, msgOk) {
    const antes = structuredClone(S.db);
    let r;
    try {
      r = fn(S.db);
    } catch (e) {
      S.db = antes;
      throw e;
    }
    try { await S.salvar(); } catch (e) {
      UI.toast('Alteração feita, mas não foi possível salvar no navegador: ' + e.message, 'erro');
    }
    if (msgOk) UI.toast(msgOk);
    App.render();
    return r;
  };

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

  function renderStatus() {
    const e = S.estado;
    let cls, txt, botao = null;
    if (e.erro) { cls = 'erro'; txt = e.erro; botao = e.conexao === 'reconectar' ? ['Reconectar', () => conectar(S.reconectar)] : null; }
    else if (e.conexao === 'conectado') {
      if (e.gravandoArquivo || e.pendenteArquivo) { cls = 'gravando'; txt = 'Gravando…'; }
      else { cls = 'ok'; txt = `Salvo em ${S.nomePasta()}/estoque.json` + (e.ultimoArquivo ? ' · ' + fmtDataHora(e.ultimoArquivo.toISOString()).slice(-5) : ''); }
    } else if (e.conexao === 'reconectar') { cls = 'alerta'; txt = 'Pasta de dados desconectada'; botao = ['Reconectar', () => conectar(S.reconectar)]; }
    else if (e.conexao === 'sem-pasta') { cls = 'alerta'; txt = 'Dados só neste navegador'; botao = ['Escolher pasta', () => conectar(S.escolherPasta)]; }
    else { cls = 'alerta'; txt = 'Navegador sem gravação em pasta — use Chrome/Edge'; }
    statusEl.className = 'status ' + cls;
    preencher(statusEl, h('span', { class: 'ponto', 'aria-hidden': 'true' }), h('span', null, txt),
      botao ? h('button', { type: 'button', class: 'btn pequeno', onclick: botao[1] }, botao[0]) : '');
  }

  async function conectar(fn) {
    try {
      const r = await fn();
      if (r && r.conflito) await App.resolverConflito(r.conflito);
      App.render();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      UI.toast(e.message || String(e), 'erro');
    }
  }

  App.resolverConflito = async function (c) {
    const escolha = await UI.escolher({
      titulo: 'Duas versões dos dados',
      mensagem: `O arquivo estoque.json da pasta foi alterado em ${fmtDataHora(c.arquivo)} e a cópia deste navegador em ${fmtDataHora(c.navegador)}. Qual versão usar? A outra será guardada em backup/.`,
      opcoes: [
        { valor: 'navegador', rotulo: 'Usar a cópia do navegador' },
        { valor: 'arquivo', rotulo: 'Usar o arquivo da pasta', primario: true },
      ],
    });
    await S.resolverConflito(c, escolha === 'navegador' ? 'navegador' : 'arquivo');
    UI.toast('Dados sincronizados.');
  };

  // Atalho "/" para a busca da tela atual.
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('dialog[open]')) return;
    const v = App.views[viewAtual];
    if (v && v.focarBusca) { e.preventDefault(); v.focarBusca(); }
  });

  window.addEventListener('beforeunload', e => {
    if (S.estado.gravandoArquivo || S.estado.pendenteArquivo) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('hashchange', navegar);
  S.onStatus(renderStatus);

  (async function iniciar() {
    try {
      const r = await S.iniciar();
      if (!S.db) S.db = App.ledger.novoBanco();
      navegar();
      if (r && r.conflito) { await App.resolverConflito(r.conflito); App.render(); }
    } catch (e) {
      console.error(e);
      if (!S.db) S.db = App.ledger.novoBanco();
      navegar();
      UI.toast('Problema ao abrir os dados: ' + (e.message || e), 'erro');
    }
  })();
})(globalThis.App = globalThis.App || {});

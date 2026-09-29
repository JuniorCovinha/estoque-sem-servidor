/* Sessão: quem está usando este computador (autor das operações e movimentos).
   Hoje: operador local, com o nome digitado em "Dados e backup" e guardado neste navegador.
   Login Microsoft (MSAL), depois: após o login, chame
     App.sessao.usarProvedor(() => ({ nome: conta.name, email: conta.username }))
   e autor() passa a vir da conta; o nome local fica só como reserva. */
(function (App) {
  'use strict';
  const { limpa } = App.util;

  const CHAVE = 'estoque-infra.operador';
  const PADRAO = 'Operador local';
  let provedor = null; // função que devolve { nome, email } da conta logada

  function nomeLocal() {
    let n = '';
    try { n = localStorage.getItem(CHAVE) || ''; } catch (e) { /* armazenamento indisponível */ }
    return limpa(n).slice(0, 80) || PADRAO;
  }

  function definirNome(nome) {
    const n = limpa(nome).slice(0, 80);
    try {
      if (n && n !== PADRAO) localStorage.setItem(CHAVE, n); else localStorage.removeItem(CHAVE);
    } catch (e) { throw new Error('Não foi possível guardar o nome neste navegador.'); }
    return nomeLocal();
  }

  function autor() {
    if (provedor) {
      const a = provedor();
      if (a && limpa(a.nome)) return { nome: limpa(a.nome).slice(0, 120), email: a.email ? limpa(a.email).slice(0, 200) : null };
    }
    return { nome: nomeLocal(), email: null };
  }

  App.sessao = {
    PADRAO, autor, nomeLocal, definirNome,
    usarProvedor(fn) { provedor = typeof fn === 'function' ? fn : null; },
    get externa() { return !!provedor; },
  };
})(globalThis.App = globalThis.App || {});

/* Permissão de edição deste computador (modo consulta).
   Dois motivos independentes colocam a aplicação em "somente consulta"; qualquer um deles bloqueia:
     - manual: a pessoa marca, em Dados e backup, que este computador é só para consulta (guardado neste navegador);
     - detectado: o sistema percebeu que a pasta de dados não aceita gravação (permissão de leitura no SharePoint)
       ou que esta versão da aplicação está desatualizada. Quem detecta (js/store.js) chama definirDetectado.
   A proteção real é a permissão da pasta no SharePoint; aqui a tela só reflete isso e App.executar recusa alterações. */
(function (App) {
  'use strict';

  const CHAVE = 'estoque-infra.modo-consulta';
  const MOTIVO_MANUAL = 'Este computador está configurado só para consulta.';
  const MOTIVO_DETECTADO_PADRAO = 'Sem permissão para gravar na pasta de dados.';

  function lerManual() {
    try { return globalThis.localStorage.getItem(CHAVE) === '1'; } catch (e) { return false; } // armazenamento indisponível: editável
  }

  let manual = lerManual();
  let detectado = false;
  let motivoDetectado = null;
  const ouvintes = new Set();

  const podeEditar = () => !manual && !detectado;

  function motivo() {
    if (podeEditar()) return null;
    // A detecção vem primeiro: desmarcar a opção manual não libera a edição enquanto ela valer.
    if (detectado) return motivoDetectado || MOTIVO_DETECTADO_PADRAO;
    return MOTIVO_MANUAL;
  }

  function notificar() {
    for (const cb of [...ouvintes]) {
      try { cb(podeEditar()); } catch (e) { console.error(e); }
    }
  }

  // somenteLeitura=true bloqueia a edição, com o texto do motivo (opcional); false libera (se o modo manual também estiver desligado).
  function definirDetectado(somenteLeitura, texto) {
    const novo = !!somenteLeitura;
    const novoMotivo = novo ? (texto ? String(texto) : null) : null;
    if (novo === detectado && novoMotivo === motivoDetectado) return;
    detectado = novo;
    motivoDetectado = novoMotivo;
    notificar();
  }

  function definirManual(valor) {
    const novo = !!valor;
    if (novo === manual) return;
    manual = novo;
    try {
      if (novo) globalThis.localStorage.setItem(CHAVE, '1'); else globalThis.localStorage.removeItem(CHAVE);
    } catch (e) { /* vale só nesta sessão */ }
    notificar();
  }

  function aoMudar(cb) {
    if (typeof cb !== 'function') return () => {};
    ouvintes.add(cb);
    return () => { ouvintes.delete(cb); };
  }

  App.permissao = {
    podeEditar, motivo, definirDetectado, manual: () => manual, definirManual, aoMudar,
    detectado: () => detectado, motivoDetectado: () => motivoDetectado,
    MOTIVO_MANUAL,
  };
})(globalThis.App = globalThis.App || {});

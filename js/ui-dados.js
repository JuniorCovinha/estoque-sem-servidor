/* Dados e backup: pasta de dados, importação da planilha, exportações, restauração e verificação. */
(function (App) {
  'use strict';
  const { h, clear, fmtDataHora, fmtMoeda, fmtData, chave } = App.util;
  const L = App.ledger;
  const UI = App.ui;
  const S = App.store;

  let raiz;
  let importacao = null; // resultado de lerPlanilha em revisão

  function montar(el) {
    raiz = el;
    atualizar();
  }

  function atualizar() {
    if (!raiz) return;
    clear(raiz);
    if (importacao) return raiz.appendChild(relatorio());
    const db = S.db;
    raiz.append(secaoPasta(), secaoImportar(db), secaoExportar(db), secaoVerificar(db), secaoSobre(db));
  }

  // ---------- Pasta de dados ----------
  function secaoPasta() {
    const e = S.estado;
    let aviso;
    if (e.conexao === 'indisponivel') aviso = h('div', { class: 'aviso danger' }, 'Este navegador não permite gravar em pasta. Use o Google Chrome ou o Microsoft Edge. Enquanto isso, os dados ficam só neste navegador: baixe backups com frequência.');
    else if (e.conexao === 'sem-pasta') aviso = h('div', { class: 'aviso warn' }, 'Nenhuma pasta escolhida. Os dados estão só neste navegador; limpar o histórico/cache do navegador pode apagá-los.');
    else if (e.conexao === 'reconectar') aviso = h('div', { class: 'aviso warn' }, `O navegador pede permissão de novo para gravar na pasta "${S.nomePasta()}". Clique em Reconectar.`);
    else aviso = h('div', { class: 'aviso ok' }, `Gravando em "${S.nomePasta()}/estoque.json"`, e.ultimoArquivo ? ` — última gravação ${fmtDataHora(e.ultimoArquivo.toISOString())}` : '', '. Backup automático diário em "backup/".');
    return h('section', { class: 'secao' },
      h('h2', null, 'Pasta de dados'),
      h('p', null, 'Escolha uma pasta sincronizada com o SharePoint/OneDrive (ex.: dentro de "38.1 - Ativos de tecnologia"). A aplicação grava ali o arquivo estoque.json a cada alteração, e uma cópia diária em backup/ (JSON + planilha).'),
      aviso,
      e.erro ? h('div', { class: 'aviso danger' }, e.erro) : null,
      h('div', { class: 'linha-botoes' },
        e.conexao === 'reconectar' ? h('button', { class: 'btn primario', type: 'button', onclick: () => executar(() => S.reconectar()) }, 'Reconectar') : null,
        e.conexao !== 'indisponivel' ? h('button', { class: 'btn' + (e.conexao === 'sem-pasta' ? ' primario' : ''), type: 'button', onclick: () => executar(() => S.escolherPasta()) }, e.pasta ? 'Trocar pasta…' : 'Escolher pasta…') : null));
  }

  async function executar(fn) {
    try {
      const r = await fn();
      if (r && r.conflito) await App.resolverConflito(r.conflito);
      App.render();
    } catch (e) {
      if (e && e.name === 'AbortError') return; // usuário cancelou o seletor
      UI.toast(e.message || String(e), 'erro');
    }
  }

  // ---------- Importação ----------
  function secaoImportar(db) {
    const tem = db && (db.itens.length || db.movimentos.length);
    const input = h('input', { type: 'file', accept: '.xlsx,.xlsm', hidden: true, onchange: () => lerArquivo(input.files[0]) });
    const inputCores = h('input', { type: 'file', accept: '.xlsx,.xlsm', hidden: true, onchange: () => { const f = inputCores.files[0]; inputCores.value = ''; atualizarCoresToner(f); } });
    const tonersImportados = db ? db.toners.filter(tonerDaPlanilha) : [];
    return h('section', { class: 'secao' },
      h('h2', null, 'Importar planilha atual'),
      h('p', null, 'Lê a planilha "Ativos e Passivos Estoque e Descartes" (.xlsx). A planilha não é alterada. Antes de confirmar você verá um relatório com os casos que precisam de decisão.'),
      tem ? h('div', { class: 'aviso warn' }, `Já existem dados (${db.itens.length} itens, ${db.movimentos.length} movimentações${db.importacao ? `, importados em ${fmtDataHora(db.importacao.em)}` : ''}). Uma nova importação substitui tudo; uma cópia dos dados atuais é guardada antes.`) : null,
      h('div', { class: 'linha-botoes' }, input, h('button', { class: 'btn' + (tem ? '' : ' primario'), type: 'button', onclick: () => input.click() }, 'Escolher planilha…'),
        tonersImportados.length ? [inputCores, h('button', { class: 'btn', type: 'button', title: 'Preenche só a cor dos toners importados que estão com a cor vazia. Nada mais é alterado.', onclick: () => inputCores.click() }, 'Atualizar cores dos toners pela planilha…')] : null));
  }

  // ---------- Atualizar só as cores dos toners (sem re-importar) ----------
  const tonerDaPlanilha = t => t.origem && t.origem.linha && chave(t.origem.aba).includes('toner');

  async function atualizarCoresToner(arquivo) {
    if (!arquivo) return;
    let lidas;
    try {
      lidas = App.importer.lerCoresToner(await arquivo.arrayBuffer());
    } catch (e) {
      console.error(e);
      return UI.toast('Não foi possível ler a planilha: ' + e.message, 'erro');
    }
    const porLinha = new Map(lidas.map(c => [c.linha, c]));
    const aplicar = [], mantidos = [], ignorados = [];
    for (const t of S.db.toners.filter(tonerDaPlanilha)) {
      const c = porLinha.get(t.origem.linha);
      const modeloOriginal = t.origem.original && t.origem.original.modelo;
      if (!c) { ignorados.push(`linha ${t.origem.linha}: ${t.modelo} — linha não encontrada na planilha escolhida`); continue; }
      if (chave(c.modelo) !== chave(modeloOriginal || t.modelo) && chave(c.modelo) !== chave(t.modelo)) {
        ignorados.push(`linha ${c.linha}: modelo na planilha "${c.modelo}" ≠ toner "${t.modelo}" — não alterado`); continue;
      }
      if (t.cor) { mantidos.push(t); continue; }
      if (!c.cor) { ignorados.push(`linha ${c.linha}: ${t.modelo} — sem cor identificada na planilha${c.rgb ? ' (#' + c.rgb + ')' : ''}`); continue; }
      aplicar.push({ id: t.id, linha: c.linha, modelo: t.modelo, cor: c.cor, rgb: c.rgb });
    }
    aplicar.sort((a, b) => a.linha - b.linha);
    const extras = [
      mantidos.length ? `${mantidos.length} toner(s) já com cor preenchida — mantidos como estão.` : null,
      ...ignorados,
    ].filter(Boolean);
    if (!aplicar.length) {
      if (ignorados.length) console.info('Toners não atualizados:\n' + ignorados.join('\n'));
      UI.toast(`Nenhum toner com cor vazia para atualizar (${mantidos.length} já com cor${ignorados.length ? `, ${ignorados.length} sem correspondência/cor na planilha` : ''}).`);
      return;
    }
    const ok = await UI.confirmar({
      titulo: 'Atualizar cores dos toners?', ok: `Atualizar ${aplicar.length} toner(s)`,
      mensagem: `Arquivo "${arquivo.name}". Só a cor dos toners abaixo (hoje vazia) será preenchida; cada alteração fica no histórico. Nada mais muda.`,
      detalhes: aplicar.map(a => `linha ${a.linha}: ${a.modelo} → ${a.cor}${a.rgb ? ' (#' + a.rgb + ')' : ''}`).concat(extras),
    });
    if (!ok) return;
    try {
      await App.acao(d => {
        for (const a of aplicar) {
          const t = d.toners.find(x => x.id === a.id);
          if (!t || t.cor) continue; // não sobrescreve cor preenchida
          const m = L.editarToner(d, a.id, { cor: a.cor });
          if (m) m.obs += ` — pela planilha "${arquivo.name}" (linha ${a.linha}${a.rgb ? ', preenchimento #' + a.rgb : ''})`;
        }
      }, `Cores atualizadas em ${aplicar.length} toner(s).`);
    } catch (e) {
      console.error(e);
      UI.toast('Falha ao atualizar as cores: ' + e.message, 'erro');
    }
  }

  async function lerArquivo(arquivo) {
    if (!arquivo) return;
    try {
      const buf = await arquivo.arrayBuffer();
      importacao = App.importer.lerPlanilha(buf, arquivo.name);
      atualizar();
      window.scrollTo(0, 0);
    } catch (e) {
      console.error(e);
      UI.toast('Não foi possível ler a planilha: ' + e.message, 'erro');
    }
  }

  function relatorio() {
    const r = importacao;
    const visiveis = r.pendencias.filter(p => p.grupo !== 'oculto');
    const grupos = [
      { chave: 'decisao', titulo: 'Decisões necessárias', desc: 'Escolha uma opção em cada caso para poder importar.' },
      { chave: 'revisar', titulo: 'Revise (já vem com uma sugestão)', desc: 'Confira a sugestão e altere se necessário.' },
      { chave: 'info', titulo: 'Apenas para conhecimento', desc: 'Nada a decidir; ficam registrados assim.' },
    ];
    const contador = h('span', { class: 'fraco' });
    const btnOk = h('button', { class: 'btn primario', type: 'button', onclick: confirmarImportacao }, 'Confirmar importação');
    const atualizarContador = () => {
      const falta = App.importer.pendentes(r).length;
      contador.textContent = falta ? `Faltam ${falta} decisão(ões).` : 'Tudo pronto para importar.';
      btnOk.disabled = falta > 0;
      raiz.querySelectorAll('.pend.decisao').forEach(el => el.classList.toggle('resolvida', !!el._p.valor));
    };
    const res = r.resumo;
    const wrap = h('div', null,
      h('section', { class: 'secao' },
        h('h2', null, 'Relatório de importação'),
        h('p', null, `Arquivo: ${r.arquivo || '—'} · abas encontradas: ${r.abas.join(', ')}`),
        h('div', { class: 'cartoes', style: 'margin:10px 0 0' },
          cartao('Linhas do Estoque', res.estoque), cartao('Celulares (aba própria)', res.celulares), cartao('Entregas', res.entregas),
          cartao('Descartes', `${res.descartes} · ${fmtMoeda(res.valorDescarte)}`), cartao('Toners', res.toners)),
        r.avisos.map(a => h('div', { class: 'aviso warn' }, a))),
      grupos.map(g => {
        const lista = visiveis.filter(p => p.grupo === g.chave);
        if (!lista.length) return null;
        return h('div', { class: 'pend-grupo', style: 'max-width:980px' },
          h('h3', null, `${g.titulo} (${lista.length})`), h('p', { class: 'fraco', style: 'margin:-4px 0 8px' }, g.desc),
          lista.map(p => cartaoPendencia(p, atualizarContador)));
      }),
      h('div', { class: 'rodape-fixo', style: 'max-width:980px' },
        h('button', { class: 'btn', type: 'button', onclick: () => { importacao = null; atualizar(); } }, 'Cancelar'),
        btnOk, contador));
    setTimeout(atualizarContador, 0);
    return wrap;
  }

  function cartao(rotulo, valor) {
    return h('div', { class: 'cartao' }, h('div', { class: 'rotulo' }, rotulo), h('div', { class: 'valor', style: 'font-size:18px' }, valor));
  }

  function cartaoPendencia(p, aoMudar) {
    const box = h('div', { class: 'pend ' + p.grupo });
    box._p = p;
    box.append(h('div', { class: 'pend-titulo' }, p.titulo), h('div', { class: 'pend-detalhe' }, p.detalhe));
    if (p.tipoCampo === 'opcoes') {
      const nome = 'p-' + p.id;
      box.appendChild(h('div', { class: 'pend-opcoes', role: 'radiogroup' }, p.opcoes.map(o =>
        h('label', null, h('input', { type: 'radio', name: nome, value: o.valor, checked: p.valor === o.valor, onchange: () => { p.valor = o.valor; aoMudar(); } }), o.rotulo))));
    } else if (p.tipoCampo === 'data') {
      box.appendChild(h('div', { class: 'pend-opcoes' }, h('label', null, 'Data correta: ',
        h('input', { type: 'date', value: p.valor || '', onchange: e => { p.valor = e.target.value || null; aoMudar(); } }))));
    } else if (p.tipoCampo === 'texto') {
      const id = 'dl-' + p.id;
      box.appendChild(h('div', { class: 'pend-opcoes' }, h('label', null, 'Categoria: ',
        h('input', { type: 'text', value: p.valor || '', list: id, style: 'width:260px', oninput: e => { p.valor = e.target.value; aoMudar(); } }),
        h('datalist', { id }, (p.sugestoes || []).map(s => h('option', { value: s }))))));
    }
    return box;
  }

  async function confirmarImportacao() {
    const r = importacao;
    const db = S.db;
    const tem = db && (db.itens.length || db.movimentos.length);
    if (tem) {
      const ok = await UI.confirmar({
        titulo: 'Substituir os dados atuais?', perigo: true, ok: 'Substituir',
        mensagem: `Os ${db.itens.length} itens e ${db.movimentos.length} movimentações atuais serão substituídos pela importação.`,
        detalhes: [S.estado.conexao === 'conectado' ? 'Uma cópia será salva em backup/ na pasta de dados.' : 'Uma cópia será baixada (arquivo .json) antes.'],
      });
      if (!ok) return;
    }
    try {
      const novo = App.importer.aplicar(r);
      const problemas = L.verificarConsistencia(novo);
      await S.substituirBanco(novo, 'importacao');
      importacao = null;
      UI.toast(`Importação concluída: ${novo.itens.length} itens, ${novo.movimentos.length} movimentações, ${novo.toners.length} toners.`);
      if (problemas.length) UI.toast(`${problemas.length} ponto(s) para revisar na verificação de consistência.`, 'erro');
      location.hash = '#estoque';
      App.render();
    } catch (e) {
      console.error(e);
      UI.toast('Falha na importação: ' + e.message + ' — escolha a planilha novamente.', 'erro');
      importacao = null;
      atualizar();
    }
  }

  // ---------- Exportar / backup ----------
  function secaoExportar(db) {
    const vazio = !db || (!db.itens.length && !db.movimentos.length && !db.toners.length);
    const inputJSON = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: () => restaurar(inputJSON.files[0]) });
    return h('section', { class: 'secao' },
      h('h2', null, 'Exportar e backup'),
      h('p', null, 'A planilha de backup tem as abas Estoque, Movimentações, Descarte e Toner, com uma linha de cabeçalho e filtros — pronta para abrir no Excel. O backup .json guarda tudo e pode ser restaurado aqui.'),
      h('div', { class: 'linha-botoes' },
        h('button', { class: 'btn primario', type: 'button', disabled: vazio, onclick: () => App.exporter.baixarPlanilha(S.db) }, 'Baixar planilha (.xlsx)'),
        h('button', { class: 'btn', type: 'button', disabled: vazio, onclick: () => App.exporter.baixarCSVEstoque(S.db) }, 'Baixar estoque (.csv)'),
        h('button', { class: 'btn', type: 'button', disabled: vazio, onclick: () => App.exporter.baixarJSON(S.db) }, 'Baixar backup completo (.json)'),
        S.estado.conexao === 'conectado' ? h('button', { class: 'btn', type: 'button', disabled: vazio, onclick: async () => {
          try { await S.gravarBackup('manual', JSON.stringify(S.db), S.db); UI.toast('Backup gravado na pasta backup/.'); } catch (e) { UI.toast(e.message, 'erro'); }
        } }, 'Gravar backup na pasta agora') : null,
        inputJSON,
        h('button', { class: 'btn', type: 'button', onclick: () => inputJSON.click() }, 'Restaurar backup (.json)…')),
      h('p', { style: 'margin-top:10px;font-size:12.5px' }, 'Os arquivos exportados contêm nomes de colaboradores (dados pessoais). Guarde-os apenas em locais com acesso restrito à equipe de TI; evite e-mail e pen drive.'));
  }

  async function restaurar(arquivo) {
    if (!arquivo) return;
    try {
      const novo = S.validarBanco(JSON.parse(await arquivo.text()));
      const ok = await UI.confirmar({
        titulo: 'Restaurar backup?', perigo: true, ok: 'Restaurar',
        mensagem: `O arquivo "${arquivo.name}" tem ${novo.itens.length} itens e ${novo.movimentos.length} movimentações (salvo em ${fmtDataHora(novo.atualizadoEm)}). Os dados atuais serão substituídos; uma cópia deles é guardada antes.`,
      });
      if (!ok) return;
      await S.substituirBanco(novo, 'restauracao');
      UI.toast('Backup restaurado.');
      App.render();
    } catch (e) {
      UI.toast('Backup inválido: ' + e.message, 'erro');
    }
  }

  // ---------- Verificação ----------
  function secaoVerificar(db) {
    const saida = h('div');
    return h('section', { class: 'secao' },
      h('h2', null, 'Verificação de consistência'),
      h('p', null, 'Confere se o saldo de cada item bate com o histórico, se há séries repetidas e itens com situação incompatível com o saldo.'),
      h('div', { class: 'linha-botoes' }, h('button', { class: 'btn', type: 'button', disabled: !db, onclick: () => {
        const probs = L.verificarConsistencia(S.db);
        clear(saida).appendChild(probs.length
          ? h('div', { class: 'aviso warn' }, `${probs.length} ponto(s) encontrados:`, h('ul', { class: 'lista-simples' }, probs.map(p => h('li', null, p.msg))))
          : h('div', { class: 'aviso ok' }, 'Nenhuma inconsistência encontrada.'));
      } }, 'Verificar agora')),
      saida);
  }

  function secaoSobre(db) {
    return h('section', { class: 'secao' },
      h('h2', null, 'Sobre os dados'),
      db ? h('ul', { class: 'lista-simples' },
        h('li', null, `${db.itens.length} itens · ${db.movimentos.length} movimentações · ${db.toners.length} toners`),
        h('li', null, `Última alteração: ${fmtDataHora(db.atualizadoEm)}`),
        db.importacao ? h('li', null, `Importado de "${db.importacao.arquivo}" em ${fmtDataHora(db.importacao.em)}`) : null,
        h('li', null, `Leitura/escrita de planilhas: SheetJS ${typeof XLSX !== 'undefined' ? XLSX.version : '—'} (arquivo local, sem internet)`),
      ) : h('p', null, 'Sem dados ainda.'),
      h('p', { style: 'font-size:12.5px' }, `Hoje: ${fmtData(App.util.hojeISO())}`));
  }

  App.views = App.views || {};
  App.views.dados = { montar, atualizar };
})(globalThis.App = globalThis.App || {});

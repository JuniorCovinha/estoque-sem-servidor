/* Componentes de interface reutilizáveis: toast, confirmação, formulário em diálogo, menu e utilidades. */
(function (App) {
  'use strict';
  const { h, clear, chave } = App.util;

  function toast(msg, tipo) {
    const box = document.getElementById('toasts');
    const t = h('div', { class: 'toast' + (tipo === 'erro' ? ' erro' : ''), role: tipo === 'erro' ? 'alert' : 'status' }, msg);
    box.appendChild(t);
    setTimeout(() => t.remove(), tipo === 'erro' ? 7000 : 3500);
  }

  function abrirDialogo(dlg) {
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 0));
    dlg.showModal();
    return dlg;
  }

  function confirmar({ titulo, mensagem, ok = 'Confirmar', cancelar = 'Cancelar', perigo = false, detalhes }) {
    return new Promise(resolve => {
      let resultado = false;
      const btnOk = h('button', { type: 'submit', class: 'btn ' + (perigo ? 'perigo cheio' : 'primario'), value: 'ok' }, ok);
      const dlg = h('dialog', { class: 'dlg' },
        h('form', { method: 'dialog', onsubmit: e => { resultado = e.submitter && e.submitter.value === 'ok'; } },
          h('div', { class: 'dlg-cab' }, h('h2', null, titulo || 'Confirmar')),
          h('div', { class: 'dlg-corpo' },
            mensagem ? h('p', { style: 'margin:0 0 6px' }, mensagem) : null,
            detalhes && detalhes.length ? h('ul', { class: 'lista-simples' }, detalhes.map(d => h('li', null, d))) : null),
          h('div', { class: 'dlg-rodape' },
            h('button', { type: 'submit', class: 'btn', value: 'cancelar' }, cancelar), btnOk)));
      dlg.addEventListener('close', () => resolve(resultado));
      abrirDialogo(dlg);
      btnOk.focus();
    });
  }

  function escolher({ titulo, mensagem, opcoes }) {
    return new Promise(resolve => {
      let resultado = null;
      const dlg = h('dialog', { class: 'dlg' },
        h('form', { method: 'dialog', onsubmit: e => { resultado = e.submitter ? e.submitter.value : null; } },
          h('div', { class: 'dlg-cab' }, h('h2', null, titulo)),
          h('div', { class: 'dlg-corpo' }, h('p', { style: 'margin:0' }, mensagem)),
          h('div', { class: 'dlg-rodape' }, opcoes.map(o => h('button', { type: 'submit', class: 'btn' + (o.primario ? ' primario' : ''), value: o.valor }, o.rotulo)))));
      dlg.addEventListener('cancel', e => e.preventDefault()); // exige escolha
      dlg.addEventListener('close', () => resolve(resultado));
      abrirDialogo(dlg);
    });
  }

  // ---------- Formulário genérico ----------
  let seqId = 0;

  /**
   * campos: [{ nome, rotulo, tipo, valor, opcoes, lista, obrigatorio, dica, largo, visivel(v), aoMudar(v, api),
   *            manterAoContinuar, itens() (tipo 'item'), conteudo(v) (tipo 'info'), min, max, passo, placeholder }]
   * botoes: [{ rotulo, acao, primario }]; aoEnviar(valores, acao) -> 'continuar' mantém o diálogo aberto.
   */
  function formulario({ titulo, subtitulo, campos, botoes, aoEnviar, largo, rodapeEsquerda }) {
    const valores = {};
    const refs = {};
    const erroForm = h('div', { class: 'erro-form', role: 'alert' });
    let enviando = false;

    const api = {
      valores,
      set(nome, v) { valores[nome] = v; escreveControle(nome); atualizar(); },
      atualizar() { atualizar(); },
      campo(nome) { return refs[nome]; },
    };

    function escreveControle(nome) {
      const r = refs[nome]; if (!r) return;
      const c = r.def; const v = valores[nome];
      if (c.tipo === 'checkbox') r.ctrl.checked = !!v;
      else if (c.tipo === 'radio') r.ctrl.querySelectorAll('input').forEach(i => { i.checked = i.value === v; });
      else if (c.tipo === 'item') r.ctrl.value = v ? (r.rotuloPorId.get(v) || '') : '';
      else if (c.tipo !== 'info') r.ctrl.value = v ?? '';
      if (c.tipo === 'select') valores[nome] = r.ctrl.value; // valor fora das opções vira a opção exibida
    }

    function atualizar() {
      for (const r of Object.values(refs)) {
        const c = r.def;
        const vis = c.visivel ? !!c.visivel(valores) : true;
        r.wrap.hidden = !vis;
        if (c.tipo === 'info') { clear(r.ctrl); const cont = c.conteudo(valores); if (cont) App.util.appendChildren(r.ctrl, [cont]); r.wrap.hidden = !vis || !cont; }
        if (c.dicaDinamica) {
          const d = c.dicaDinamica(valores);
          r.dica.textContent = d ? d.texto : (c.dica || '');
          r.dica.className = 'dica' + (d && d.warn ? ' warn' : '');
        }
      }
    }

    function montaItemPicker(c, id) {
      const listaId = 'dl' + (++seqId);
      const dl = h('datalist', { id: listaId });
      const input = h('input', { type: 'text', id, list: listaId, autocomplete: 'off', placeholder: c.placeholder || 'Digite série, modelo ou categoria…' });
      const ref = { rotuloPorId: new Map(), idPorRotulo: new Map(), idPorSerie: new Map() };
      ref.recarregar = () => {
        clear(dl); ref.rotuloPorId.clear(); ref.idPorRotulo.clear(); ref.idPorSerie.clear();
        const usados = new Map();
        for (const it of c.itens()) {
          let r = (c.rotuloDe || App.uiRotuloItem)(it); // rotuloDe/chavesExtra reaproveitam o seletor (ex.: pessoas)
          const n = (usados.get(r) || 0) + 1; usados.set(r, n);
          if (n > 1) r += ` #${n}`;
          ref.rotuloPorId.set(it.id, r); ref.idPorRotulo.set(r, it.id);
          for (const k of (c.chavesExtra ? c.chavesExtra(it) : [it.serie])) if (k) ref.idPorSerie.set(chave(k), it.id);
          dl.appendChild(h('option', { value: r }));
        }
      };
      ref.recarregar();
      const resolver = () => {
        const txt = input.value;
        let id2 = ref.idPorRotulo.get(txt) || ref.idPorSerie.get(chave(txt)) || null;
        if (valores[c.nome] !== id2) {
          valores[c.nome] = id2;
          if (c.aoMudar) c.aoMudar(valores, api);
          atualizar();
        }
        return id2;
      };
      input.addEventListener('input', resolver);
      input.addEventListener('change', () => { if (resolver()) input.value = ref.rotuloPorId.get(valores[c.nome]); });
      input.addEventListener('keydown', e => {
        // Leitor de código de barras / série digitada: Enter resolve a série sem enviar o formulário.
        if (e.key === 'Enter') {
          const id2 = resolver();
          if (id2 && input.value !== ref.rotuloPorId.get(id2)) { e.preventDefault(); input.value = ref.rotuloPorId.get(id2); focarProximo(input); }
          else if (!id2 && input.value) { e.preventDefault(); }
        }
      });
      return { ctrl: input, extra: dl, ref };
    }

    function focarProximo(el) {
      const foc = [...form.querySelectorAll('input:not([type=hidden]), select, textarea')].filter(x => !x.closest('[hidden]') && !x.disabled && !x.readOnly);
      const i = foc.indexOf(el);
      if (i >= 0 && foc[i + 1]) foc[i + 1].focus();
    }

    const grade = h('div', { class: 'grade' });
    for (const c of campos) {
      const id = 'f' + (++seqId);
      valores[c.nome] = c.valor !== undefined ? (typeof c.valor === 'function' ? c.valor() : c.valor) : (c.tipo === 'checkbox' ? false : '');
      let ctrl, extra = null, refItem = null;
      if (c.tipo === 'select') {
        ctrl = h('select', { id }, (c.opcoes || []).map(o => h('option', { value: o.valor }, o.rotulo)));
      } else if (c.tipo === 'textarea') {
        ctrl = h('textarea', { id, rows: 2, placeholder: c.placeholder || null });
      } else if (c.tipo === 'checkbox') {
        ctrl = h('input', { type: 'checkbox', id });
      } else if (c.tipo === 'radio') {
        ctrl = h('div', { class: 'segmentado', role: 'radiogroup' }, (c.opcoes || []).map(o =>
          h('label', null, h('input', { type: 'radio', name: id, value: o.valor }), o.rotulo)));
      } else if (c.tipo === 'info') {
        ctrl = h('div', { class: 'info-item' });
      } else if (c.tipo === 'item') {
        const p = montaItemPicker(c, id); ctrl = p.ctrl; extra = p.extra; refItem = p.ref;
      } else {
        ctrl = h('input', { type: c.tipo || 'text', id, autocomplete: 'off', placeholder: c.placeholder || null, min: c.min ?? null, max: c.max ?? null, step: c.passo ?? null, inputmode: c.tipo === 'number' ? 'numeric' : null });
        if (c.lista) {
          const listaId = 'dl' + (++seqId);
          ctrl.setAttribute('list', listaId);
          extra = h('datalist', { id: listaId }, (typeof c.lista === 'function' ? c.lista() : c.lista).map(v => h('option', { value: v })));
        }
      }
      const dica = h('span', { class: 'dica' }, c.dica || '');
      const erroCampo = h('span', { class: 'erro-campo' });
      const wrap = h('div', { class: 'campo' + (c.largo || c.tipo === 'info' || c.tipo === 'textarea' || c.tipo === 'item' ? ' largo' : '') },
        c.tipo === 'checkbox'
          ? h('label', { class: 'check', for: id }, ctrl, c.rotulo)
          : [c.rotulo ? h(c.tipo === 'radio' || c.tipo === 'info' ? 'span' : 'label', { class: c.tipo === 'radio' || c.tipo === 'info' ? 'rotulo' : null, for: c.tipo === 'radio' || c.tipo === 'info' ? null : id }, c.rotulo, c.obrigatorio ? h('span', { class: 'obrig', 'aria-hidden': 'true' }, '*') : null) : null, ctrl],
        extra, dica, erroCampo);
      refs[c.nome] = { def: c, ctrl, wrap, dica, erroCampo, ...(refItem || {}) };
      if (refItem) refs[c.nome].recarregar = refItem.recarregar;

      if (c.tipo !== 'item' && c.tipo !== 'info') {
        const ler = () => {
          if (c.tipo === 'checkbox') valores[c.nome] = ctrl.checked;
          else if (c.tipo === 'radio') { const s = ctrl.querySelector('input:checked'); valores[c.nome] = s ? s.value : ''; }
          else valores[c.nome] = ctrl.value;
          wrap.classList.remove('com-erro'); erroCampo.textContent = '';
          if (c.aoMudar) c.aoMudar(valores, api);
          atualizar();
        };
        ctrl.addEventListener(c.tipo === 'select' || c.tipo === 'checkbox' || c.tipo === 'radio' ? 'change' : 'input', ler);
      }
      grade.appendChild(wrap);
      escreveControle(c.nome);
    }

    const form = h('form', { novalidate: true },
      h('div', { class: 'dlg-cab' }, h('h2', null, titulo), subtitulo ? h('p', null, subtitulo) : null),
      h('div', { class: 'dlg-corpo' }, erroForm, grade),
      h('div', { class: 'dlg-rodape' },
        rodapeEsquerda ? h('div', { class: 'esq' }, rodapeEsquerda) : null,
        h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancelar'),
        (botoes || [{ rotulo: 'Salvar', acao: 'salvar', primario: true }]).map(b =>
          h('button', { type: 'submit', class: 'btn' + (b.primario ? ' primario' : ''), value: b.acao }, b.rotulo))));

    const dlg = h('dialog', { class: 'dlg' + (largo ? ' largo' : '') }, form);

    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (enviando) return;
      const acao = e.submitter ? e.submitter.value : (botoes && botoes[0] ? botoes[0].acao : 'salvar');
      erroForm.textContent = '';
      let faltando = null;
      for (const r of Object.values(refs)) {
        if (!r.def.obrigatorio || r.wrap.hidden) continue;
        const v = valores[r.def.nome];
        if (v === '' || v === null || v === undefined) {
          r.wrap.classList.add('com-erro');
          r.erroCampo.textContent = r.def.tipo === 'item' ? (r.def.msgSelecione || 'Selecione um item da lista.') : 'Campo obrigatório.';
          faltando = faltando || r;
        }
      }
      if (faltando) { (faltando.ctrl.querySelector ? (faltando.ctrl.querySelector('input') || faltando.ctrl) : faltando.ctrl).focus(); return; }
      enviando = true;
      try {
        const res = await aoEnviar(valores, acao, api);
        if (res === false) return;
        if (res === 'continuar') {
          for (const r of Object.values(refs)) {
            if (r.def.manterAoContinuar || r.def.tipo === 'info') continue;
            valores[r.def.nome] = r.def.valor !== undefined ? (typeof r.def.valor === 'function' ? r.def.valor() : r.def.valor) : (r.def.tipo === 'checkbox' ? false : '');
            if (r.recarregar) r.recarregar();
            escreveControle(r.def.nome);
          }
          for (const r of Object.values(refs)) if (r.def.aoMudar && !r.def.manterAoContinuar) r.def.aoMudar(valores, api);
          atualizar();
          focarPrimeiro();
          return;
        }
        dlg.close();
      } catch (err) {
        erroForm.textContent = err.message || String(err);
        if (!err.negocio) console.error(err);
      } finally { enviando = false; }
    });

    function focarPrimeiro() {
      const cands = [...form.querySelectorAll('.dlg-corpo input, .dlg-corpo textarea')].filter(x => !x.closest('[hidden]') && !x.readOnly && x.type !== 'checkbox' && x.type !== 'radio');
      const alvo = cands.find(x => !x.value) || cands[0];
      if (alvo) alvo.focus();
    }

    for (const c of campos) if (c.aoMudar && c.chamarAoAbrir) c.aoMudar(valores, api);
    atualizar();
    abrirDialogo(dlg);
    focarPrimeiro();
    return { dlg, api };
  }

  // ---------- Menu de ações ----------
  let menuAberto = null;
  function fecharMenu() { if (menuAberto) { menuAberto.remove(); menuAberto = null; } }
  function menu(ancora, itens) {
    fecharMenu();
    const m = h('div', { class: 'menu', role: 'menu' });
    for (const it of itens) {
      if (it === '-') { m.appendChild(h('hr')); continue; }
      m.appendChild(h('button', { type: 'button', role: 'menuitem', class: it.perigo ? 'perigo' : null, onclick: () => { fecharMenu(); it.fn(); } }, it.rotulo));
    }
    document.body.appendChild(m);
    const r = ancora.getBoundingClientRect();
    const mw = m.offsetWidth, mh = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + 'px';
    m.style.top = (r.bottom + mh + 8 > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
    menuAberto = m;
    const botoes = [...m.querySelectorAll('button')];
    if (botoes[0]) botoes[0].focus();
    m.addEventListener('keydown', e => {
      const i = botoes.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); botoes[(i + 1) % botoes.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); botoes[(i - 1 + botoes.length) % botoes.length].focus(); }
      if (e.key === 'Escape') { fecharMenu(); ancora.focus(); }
    });
  }
  document.addEventListener('mousedown', e => { if (menuAberto && !menuAberto.contains(e.target)) fecharMenu(); });
  window.addEventListener('resize', fecharMenu);
  document.addEventListener('scroll', fecharMenu, true);

  // ---------- Preferências de tela (conveniência local; nunca dados de negócio) ----------
  function prefs(nome, padrao) {
    let v = {};
    try { v = JSON.parse(localStorage.getItem('estoque-ui-' + nome) || '{}') || {}; } catch (e) { v = {}; }
    const obj = Object.assign({}, padrao, v);
    obj.salvar = () => { try { const c = Object.assign({}, obj); delete c.salvar; localStorage.setItem('estoque-ui-' + nome, JSON.stringify(c)); } catch (e) { /* ignorado */ } };
    return obj;
  }

  function select(opcoes, valor, aoMudar, rotuloAria) {
    const s = h('select', { 'aria-label': rotuloAria || null, onchange: () => aoMudar(s.value) }, opcoes.map(o => h('option', { value: o.valor }, o.rotulo)));
    s.value = valor;
    return s;
  }

  function cabecalhoOrdenavel(colunas, estado, aoOrdenar) {
    return h('tr', null, colunas.map(c => {
      if (!c.chave) return h('th', { class: c.classe || null }, c.rotulo);
      const ativo = estado.ord === c.chave;
      return h('th', {
        class: 'ordenavel ' + (c.classe || ''), tabindex: 0, 'aria-sort': ativo ? (estado.dir > 0 ? 'ascending' : 'descending') : 'none',
        onclick: () => aoOrdenar(c.chave), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); aoOrdenar(c.chave); } },
      }, c.rotulo, ativo ? h('span', { class: 'seta' }, estado.dir > 0 ? '▲' : '▼') : null);
    }));
  }

  // ---------- Seleção de linhas (edição em lote) ----------
  // Os ids ficam num Set que sobrevive a filtros e re-render. Shift+clique marca um intervalo dos exibidos.
  // A tela chama exibidos(ids, existentes) a cada atualização e refletir() depois de montar as linhas.
  function selecao({ corpo, aoEditar }) {
    const ids = new Set();
    let exibidos = [];
    let ancora = null;
    const chkTodos = h('input', { type: 'checkbox', 'aria-label': 'Selecionar todos os exibidos', title: 'Selecionar todos os exibidos',
      onclick: () => {
        const todos = exibidos.length && exibidos.every(id => ids.has(id));
        for (const id of exibidos) todos ? ids.delete(id) : ids.add(id);
        ancora = null; refletir();
      } });
    const barra = h('div', { class: 'barra-lote', role: 'region', 'aria-label': 'Seleção', hidden: true });

    function th() { return h('th', { class: 'sel' }, chkTodos); }

    function td(id, nome) {
      const chk = h('input', { type: 'checkbox', checked: ids.has(id), dataset: { sel: id }, 'aria-label': 'Selecionar ' + (nome || '') });
      return h('td', {
        class: 'sel',
        onmousedown: e => { if (e.shiftKey) e.preventDefault(); }, // evita selecionar texto no Shift+clique
        onclick: e => {
          if (e.target !== chk) chk.checked = !chk.checked;
          const marcar = chk.checked;
          const i = exibidos.indexOf(id), j = ancora ? exibidos.indexOf(ancora) : -1;
          const faixa = e.shiftKey && i >= 0 && j >= 0 ? exibidos.slice(Math.min(i, j), Math.max(i, j) + 1) : [id];
          for (const x of faixa) marcar ? ids.add(x) : ids.delete(x);
          ancora = id; refletir();
        },
      }, chk);
    }

    function definirExibidos(lista, existentes) {
      exibidos = lista;
      for (const id of [...ids]) if (!existentes.has(id)) ids.delete(id);
      if (ancora && !exibidos.includes(ancora)) ancora = null;
    }

    function limpar() { ids.clear(); ancora = null; refletir(); }

    function refletir() {
      for (const c of corpo.querySelectorAll('input[data-sel]')) {
        c.checked = ids.has(c.dataset.sel);
        c.closest('tr').classList.toggle('selecionada', c.checked);
      }
      const noFiltro = exibidos.filter(id => ids.has(id)).length;
      chkTodos.checked = !!exibidos.length && noFiltro === exibidos.length;
      chkTodos.indeterminate = noFiltro > 0 && noFiltro < exibidos.length;
      const fora = ids.size - noFiltro;
      barra.hidden = !ids.size;
      if (!ids.size) return clear(barra);
      App.util.preencher(barra,
        h('span', null, h('strong', null, ids.size), ids.size === 1 ? ' selecionado' : ' selecionados',
          fora ? h('span', { class: 'fora' }, ` (${fora} fora do filtro atual)`) : null),
        h('button', { type: 'button', class: 'btn pequeno primario', onclick: () => aoEditar([...ids], fora) }, 'Editar em lote'),
        fora ? h('button', { type: 'button', class: 'btn pequeno', onclick: () => { for (const id of [...ids]) if (!exibidos.includes(id)) ids.delete(id); refletir(); } }, 'Desmarcar os fora do filtro') : null,
        h('button', { type: 'button', class: 'btn pequeno fantasma', onclick: limpar }, 'Limpar seleção'));
    }

    return { ids, barra, th, td, exibidos: definirExibidos, refletir, limpar };
  }

  function comparar(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a ?? '').localeCompare(String(b ?? ''), 'pt-BR', { numeric: true, sensitivity: 'base' });
  }

  // Busca com vários termos: todos precisam aparecer em algum campo.
  function filtroTexto(busca) {
    const termos = chave(busca).split(' ').filter(Boolean);
    if (!termos.length) return () => true;
    return campos => { const alvo = chave(campos.filter(Boolean).join(' ')); return termos.every(t => alvo.includes(t)); };
  }

  App.ui = { toast, confirmar, escolher, formulario, menu, fecharMenu, prefs, select, cabecalhoOrdenavel, comparar, filtroTexto, abrirDialogo, selecao };
})(globalThis.App = globalThis.App || {});

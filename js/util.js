/* Utilitários gerais: DOM seguro, texto, datas e ids. */
(function (App) {
  'use strict';

  // Cria elementos sem innerHTML: todo conteúdo vindo de dados vira textContent (evita XSS - CWE-79).
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required' || k === 'readOnly') el[k] = !!v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    appendChildren(el, children);
    return el;
  }

  function appendChildren(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  // Limpa e preenche ignorando null/false (Element.append escreveria "null").
  function preencher(el, ...children) { clear(el); appendChildren(el, children); return el; }

  // Valores usados na planilha como "vazio".
  const VAZIOS = new Set(['', '-', '--', 'n/a', 'na', '—']);

  function limpa(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/\s+/g, ' ').trim();
  }

  function valorOuNulo(v) {
    const s = limpa(v);
    return VAZIOS.has(s.toLowerCase()) ? null : s;
  }

  // Normaliza para comparação: minúsculas, sem acentos, espaços simples.
  function chave(v) {
    return limpa(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function uid() {
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  // Datas de negócio são guardadas como 'AAAA-MM-DD' (sem fuso).
  function hojeISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function agoraISO() { return new Date().toISOString(); }

  function excelSerialParaISO(n) {
    const ms = Date.UTC(1899, 11, 30) + Math.round(Number(n)) * 86400000;
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }

  function dataParaISO(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' && isFinite(v)) return excelSerialParaISO(v);
    if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    const s = limpa(v);
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return null;
  }

  function fmtData(iso) {
    if (!iso) return '—';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso);
  }

  function fmtDataHora(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  function fmtMoeda(n) { return (n === null || n === undefined || n === '' || isNaN(n)) ? '—' : brl.format(Number(n)); }

  function numero(v, padrao = 0) {
    if (v === null || v === undefined || v === '') return padrao;
    if (typeof v === 'number') return isFinite(v) ? v : padrao;
    const s = String(v).trim().replace(/\./g, '').replace(',', '.');
    const n = Number(s);
    return isFinite(n) ? n : padrao;
  }

  // Chamados seguem o padrão observado na planilha: #MMAA-NNNNNN
  const RE_CHAMADO = /^#?(\d{4})-(\d{6})$/;
  function normalizaChamado(v) {
    const s = valorOuNulo(v);
    if (!s) return null;
    const m = s.replace(/\s+/g, '').match(RE_CHAMADO);
    return m ? `#${m[1]}-${m[2]}` : s;
  }
  function chamadoValido(v) { return !v || RE_CHAMADO.test(v); }

  function debounce(fn, ms) {
    let t;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }

  function contem(texto, termo) { return chave(texto).includes(termo); }

  App.util = {
    h, clear, preencher, appendChildren, limpa, valorOuNulo, chave, uid, hojeISO, agoraISO,
    excelSerialParaISO, dataParaISO, fmtData, fmtDataHora, fmtMoeda, numero,
    normalizaChamado, chamadoValido, debounce, contem, pad,
  };
})(globalThis.App = globalThis.App || {});

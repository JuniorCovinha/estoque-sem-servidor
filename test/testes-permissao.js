/* Testes do modo consulta (somente leitura): App.permissao, a guarda de App.executar e as telas (Node, sem navegador).
   As telas rodam sobre um DOM mínimo de mentira (só o que util.js/ui-*.js usam); serve para provar quais botões existem
   em cada modo, não para testar o layout. Uso: node test/testes-permissao.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const raiz = path.join(__dirname, '..');

// ---------- DOM mínimo ----------
class Node { }
class FTexto extends Node {
  constructor(t) { super(); this.data = String(t); this.parentNode = null; }
  get textContent() { return this.data; }
}
const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
function casa(el, simples) {
  const m = simples.match(/^([a-z0-9]*)((?:[.#][\w-]+|\[[^\]]+\])*)$/i);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const p of (m[2].match(/[.#][\w-]+|\[[^\]]+\]/g) || [])) {
    if (p[0] === '.') { if (!el.classList.contains(p.slice(1))) return false; }
    else if (p[0] === '#') { if (el.id !== p.slice(1)) return false; }
    else {
      const mm = p.match(/^\[([\w-]+)(?:="?([^\]"]*)"?)?\]$/);
      const nome = mm[1], val = mm[2];
      const atual = nome.startsWith('data-') ? el.dataset[camel(nome.slice(5))] : (nome === 'open' ? (el.attrs.open !== undefined ? '' : undefined) : el.attrs[nome]);
      if (atual === undefined || (val !== undefined && String(atual) !== val)) return false;
    }
  }
  return true;
}
class FEl extends Node {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.dataset = {};
    this.parentNode = null; this.hidden = false; this.value = ''; this.checked = false; this.disabled = false; this.style = {};
    this.className = ''; this.id = '';
    const self = this;
    this.classList = {
      contains: c => self.className.split(/\s+/).includes(c),
      add: c => { if (!self.classList.contains(c)) self.className = (self.className + ' ' + c).trim(); },
      remove: c => { self.className = self.className.split(/\s+/).filter(x => x && x !== c).join(' '); },
      toggle: (c, f) => { (f === undefined ? !self.classList.contains(c) : f) ? self.classList.add(c) : self.classList.remove(c); },
    };
  }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.id = v; if (k === 'hidden') this.hidden = true; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  _solta(n) { if (n.parentNode) n.parentNode.children.splice(n.parentNode.children.indexOf(n), 1); n.parentNode = null; }
  appendChild(n) {
    if (n.tagName === '#FRAG') { for (const c of [...n.children]) this.appendChild(c); return n; }
    this._solta(n); n.parentNode = this; this.children.push(n); return n;
  }
  removeChild(n) { this._solta(n); return n; }
  append(...ns) { for (const n of ns) this.appendChild(n instanceof Node ? n : new FTexto(n)); }
  prepend(...ns) {
    const novos = ns.map(n => n instanceof Node ? n : new FTexto(n));
    for (const n of novos) this._solta(n);
    for (const n of novos) n.parentNode = this;
    this.children.unshift(...novos);
  }
  before(n) { const p = this.parentNode; n.parentNode = p; p.children.splice(p.children.indexOf(this), 0, n); }
  remove() { this._solta(this); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener() { }
  focus() { } select() { } showModal() { this.attrs.open = ''; } close() { delete this.attrs.open; }
  getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0 }; }
  click() { for (const fn of this.listeners.click || []) fn({ target: this, currentTarget: this, preventDefault() { } }); }
  disparar(tipo, extra) { for (const fn of this.listeners[tipo] || []) fn(Object.assign({ target: this, currentTarget: this, preventDefault() { } }, extra)); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  closest(sel) { for (let x = this; x && x.tagName; x = x.parentNode) if (sel.split(',').some(s => casa(x, s.trim()))) return x; return null; }
  get textContent() { return this.children.map(c => c.textContent).join(''); }
  set textContent(t) { this.children = []; this.appendChild(new FTexto(t)); }
  querySelectorAll(sel) {
    const r = [];
    const varre = n => { for (const c of n.children) { if (c instanceof FEl) { if (sel.split(',').some(s => casa(c, s.trim()))) r.push(c); varre(c); } } };
    varre(this); return r;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
const body = new FEl('body');
const main = new FEl('main'); main.id = 'app';
const statusEl = new FEl('div'); statusEl.id = 'status';
const toasts = new FEl('div'); toasts.id = 'toasts';
body.append(statusEl, main, toasts);
const documento = {
  body,
  createElement: t => new FEl(t),
  createTextNode: t => new FTexto(t),
  createDocumentFragment: () => new FEl('#frag'),
  getElementById: id => { const r = body.querySelectorAll('#' + id); return r[0] || null; },
  querySelector: s => body.querySelector(s),
  querySelectorAll: s => body.querySelectorAll(s),
  addEventListener() { },
  activeElement: null,
};
function armazenamento() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
}

globalThis.window = globalThis;
globalThis.Node = Node;
globalThis.document = documento;
globalThis.location = { hash: '' };
globalThis.localStorage = armazenamento();
globalThis.addEventListener = () => { };
globalThis.CSS = { escape: s => s };

const carregar = f => vm.runInThisContext(fs.readFileSync(path.join(raiz, f), 'utf8'), { filename: f });
function novaApp() { delete globalThis.App; }

let ok = 0, falhas = 0;
const fila = [];
function teste(nome, fn) { fila.push({ nome, fn }); }
const lanca = (fn, re) => assert.throws(fn, e => re.test(e.message));

// ---------- Parte 1: App.permissao isolado ----------
console.log('\nApp.permissao');
function novaPermissao(ls) {
  const antes = globalThis.localStorage;
  globalThis.localStorage = ls;
  const salva = globalThis.App;
  globalThis.App = {};
  carregar('js/permissao.js');
  const P = globalThis.App.permissao;
  globalThis.App = salva; globalThis.localStorage = antes;
  return P;
}
// A permissão guarda a referência ao localStorage global no momento das chamadas: mantém o fake ativo durante o teste.
function comLS(ls, fn) {
  const antes = globalThis.localStorage;
  globalThis.localStorage = ls;
  try { return fn(); } finally { globalThis.localStorage = antes; }
}

teste('padrão: pode editar e não há motivo', () => {
  const ls = armazenamento();
  comLS(ls, () => {
    const P = novaPermissao(ls);
    assert.strictEqual(P.podeEditar(), true);
    assert.strictEqual(P.motivo(), null);
    assert.strictEqual(P.manual(), false);
  });
});

teste('modo manual bloqueia, informa o motivo e libera ao desmarcar', () => {
  const ls = armazenamento();
  comLS(ls, () => {
    const P = novaPermissao(ls);
    P.definirManual(true);
    assert.strictEqual(P.podeEditar(), false);
    assert.strictEqual(P.manual(), true);
    assert.match(P.motivo(), /só para consulta/);
    P.definirManual(false);
    assert.strictEqual(P.podeEditar(), true);
    assert.strictEqual(P.motivo(), null);
  });
});

teste('detecção de somente leitura bloqueia, com o motivo informado, e libera ao limpar', () => {
  const ls = armazenamento();
  comLS(ls, () => {
    const P = novaPermissao(ls);
    P.definirDetectado(true, 'A pasta não aceita gravação.');
    assert.strictEqual(P.podeEditar(), false);
    assert.strictEqual(P.manual(), false);
    assert.strictEqual(P.motivo(), 'A pasta não aceita gravação.');
    P.definirDetectado(true); // sem texto: motivo padrão
    assert.match(P.motivo(), /permissão/i);
    P.definirDetectado(false, 'ignorado');
    assert.strictEqual(P.podeEditar(), true);
    assert.strictEqual(P.motivo(), null);
  });
});

teste('manual e detectado se combinam: qualquer um bloqueia; só libera quando os dois saem', () => {
  const ls = armazenamento();
  comLS(ls, () => {
    const P = novaPermissao(ls);
    P.definirManual(true); P.definirDetectado(true, 'Sem permissão.');
    assert.strictEqual(P.podeEditar(), false);
    P.definirManual(false);
    assert.strictEqual(P.podeEditar(), false, 'a detecção continua valendo');
    assert.strictEqual(P.motivo(), 'Sem permissão.');
    P.definirManual(true); P.definirDetectado(false);
    assert.strictEqual(P.podeEditar(), false, 'o manual continua valendo');
    P.definirManual(false);
    assert.strictEqual(P.podeEditar(), true);
  });
});

teste('o modo manual é persistido no localStorage e relido por uma nova carga', () => {
  const ls = armazenamento();
  comLS(ls, () => {
    const P1 = novaPermissao(ls);
    P1.definirManual(true);
    assert.ok([...ls._m.values()].includes('1'), 'gravou no armazenamento');
    const P2 = novaPermissao(ls); // "reabrir o navegador"
    assert.strictEqual(P2.manual(), true);
    assert.strictEqual(P2.podeEditar(), false);
    P2.definirManual(false);
    assert.strictEqual(ls._m.size, 0, 'desmarcar remove a chave');
    assert.strictEqual(novaPermissao(ls).podeEditar(), true);
  });
});

teste('a detecção não é persistida (vale só nesta sessão)', () => {
  const ls = armazenamento();
  comLS(ls, () => {
    novaPermissao(ls).definirDetectado(true, 'x');
    assert.strictEqual(ls._m.size, 0);
    assert.strictEqual(novaPermissao(ls).podeEditar(), true);
  });
});

teste('localStorage indisponível: não quebra e vale na sessão', () => {
  const ruim = { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); }, removeItem() { throw new Error('bloqueado'); } };
  comLS(ruim, () => {
    const P = novaPermissao(ruim);
    assert.strictEqual(P.podeEditar(), true);
    P.definirManual(true);
    assert.strictEqual(P.podeEditar(), false);
  });
});

teste('aoMudar dispara a cada mudança real, não repete sem mudança e permite desinscrever', () => {
  const ls = armazenamento();
  comLS(ls, () => {
    const P = novaPermissao(ls);
    const chamadas = [];
    const sair = P.aoMudar(pode => chamadas.push(pode));
    P.definirManual(true);                   // false
    P.definirManual(true);                   // sem mudança
    P.definirDetectado(true, 'a');           // false (muda o estado detectado)
    P.definirDetectado(true, 'a');           // sem mudança
    P.definirDetectado(true, 'b');           // muda só o motivo: avisa para atualizar a faixa
    P.definirManual(false);                  // ainda bloqueado pela detecção
    P.definirDetectado(false);               // true
    assert.deepStrictEqual(chamadas, [false, false, false, false, true]);
    sair();
    P.definirManual(true);
    assert.strictEqual(chamadas.length, 5, 'depois de desinscrever não recebe mais');
  });
});

teste('um ouvinte que lança erro não impede os outros', () => {
  const ls = armazenamento();
  comLS(ls, () => {
    const P = novaPermissao(ls);
    const erro = console.error; console.error = () => { };
    try {
      let chamou = false;
      P.aoMudar(() => { throw new Error('boom'); });
      P.aoMudar(() => { chamou = true; });
      P.definirManual(true);
      assert.strictEqual(chamou, true);
    } finally { console.error = erro; }
  });
});

// ---------- Parte 2: aplicação carregada com o DOM de mentira ----------
console.log('\nGuarda de App.executar e telas');
novaApp();
for (const f of ['js/util.js', 'js/permissao.js', 'js/ledger.js', 'js/sync.js']) carregar(f);
const A = globalThis.App;
const L = A.ledger;
const hoje = A.util.hojeISO();

// Dados de exemplo (só fictícios).
const db = L.novoBanco();
const nb = L.cadastrarItem(db, { categoria: 'Notebook', descricao: 'Modelo X', controle: 'unidade', serie: 'SN-CONSULTA-1', local: 'MATRIZ', data: hoje });
const nb2 = L.cadastrarItem(db, { categoria: 'Notebook', descricao: 'Modelo Y', controle: 'unidade', serie: 'SN-CONSULTA-2', local: 'MATRIZ', data: hoje });
L.cadastrarItem(db, { categoria: 'Mouse', descricao: 'M100', controle: 'quantidade', quantidade: 5, local: 'MATRIZ', data: hoje });
const pessoa = L.criarPessoa(db, { nome: 'Ana Teste', email: 'ana@exemplo.com', departamento: 'Financeiro' });
L.entregar(db, nb2.id, { pessoaId: pessoa.id, data: hoje });
const excl = L.cadastrarItem(db, { categoria: 'Teclado', descricao: 'K1', controle: 'unidade', serie: 'SN-LIXO-1', local: 'MATRIZ', data: hoje });
L.excluirItem(db, excl.id);
const velho = L.cadastrarItem(db, { categoria: 'Monitor', descricao: 'Quebrado', controle: 'unidade', serie: 'SN-DESC-1', local: 'MATRIZ', data: hoje });
L.descartar(db, velho.id, { justificativa: 'Tela quebrada', data: hoje });
L.adicionarToner(db, { modelo: 'W9008-EVP', cor: 'Preto', status: 'NOVO', quantidade: 1, data: hoje });
L.criarPessoa(db, { nome: 'Setor Financeiro', tipo: 'SETOR' });
const _textoLivre = L.entregar(db, L.cadastrarItem(db, { categoria: 'Notebook', descricao: 'Texto livre', controle: 'unidade', serie: 'SN-TXT', local: 'MATRIZ', data: hoje }).id, { usuario: 'Fulano Antigo', data: hoje });

// Stub do store: só o que as telas e o app.js leem.
const chamadasStore = [];
A.store = {
  db,
  estado: { conexao: 'conectado', pasta: { name: 'Pasta' }, erro: null },
  sync: {
    pendentes: [], alertas: [], estado: { bloqueio: null, ultimaSync: null, sincronizando: false },
    conflitos: [{ id: 'c1', erro: 'O item já foi entregue.', em: new Date().toISOString(),
      op: { nome: 'entregar', args: [nb.id, {}], autor: { nome: 'Fulana' }, criadoEm: new Date().toISOString() } }],
  },
  nomePasta: () => 'Pasta',
  iniciar: async () => { },
  executar: async (nome, args, autor) => { chamadasStore.push([nome, args, autor]); return 'feito'; },
  onStatus() { },
  ligarSincronizacaoPeriodica() { },
};
for (const f of ['js/sessao.js', 'js/ui-common.js', 'js/ui-acoes.js', 'js/ui-estoque.js', 'js/ui-movimentos.js', 'js/ui-descarte.js',
  'js/ui-toner.js', 'js/ui-dados.js', 'js/ui-lixeira.js', 'js/ui-pessoas.js', 'js/app.js']) carregar(f);
const P = A.permissao;
const UI = A.ui;

// Leitura da tela: rótulos dos botões/links com aparência de botão e textos.
const rotulos = el => el.querySelectorAll('button').map(b => b.textContent.trim()).concat(el.querySelectorAll('a').map(a => a.textContent.trim()));
const tem = (el, texto) => rotulos(el).some(r => r === texto || r.includes(texto));
const caixas = el => el.querySelectorAll('input').filter(i => i.attrs.type === 'checkbox');
function tela(nome) {
  const el = new FEl('div');
  A.views[nome].montar(el);
  return el;
}
function emModo(consulta, fn) {
  P.definirManual(consulta);
  try { return fn(); } finally { P.definirManual(false); }
}

teste('faixa "Modo consulta" aparece abaixo do cabeçalho só quando não pode editar', () => {
  const faixa = documento.getElementById('faixa-consulta');
  assert.ok(faixa, 'a faixa existe');
  assert.strictEqual(body.children.indexOf(faixa), body.children.indexOf(main) - 1, 'logo antes do conteúdo');
  assert.strictEqual(faixa.hidden, true);
  P.definirManual(true);
  assert.strictEqual(faixa.hidden, false);
  assert.match(faixa.textContent, /^Modo consulta — Este computador está configurado só para consulta\.$/);
  P.definirManual(false); P.definirDetectado(true, 'Sem permissão de gravação na pasta.');
  assert.match(faixa.textContent, /Modo consulta — Sem permissão de gravação na pasta\./);
  P.definirDetectado(false);
  assert.strictEqual(faixa.hidden, true);
});

teste('App.executar rejeita em consulta com erro de negócio e não chega ao store', async () => {
  chamadasStore.length = 0;
  P.definirDetectado(true, 'Sem permissão de gravação na pasta.');
  try {
    await assert.rejects(() => A.executar('entregar', [nb.id, {}], 'ok'), e => {
      assert.strictEqual(e.negocio, true);
      assert.match(e.message, /^Modo consulta: este computador não pode alterar o estoque\. Sem permissão de gravação na pasta\.$/);
      return true;
    });
    assert.strictEqual(chamadasStore.length, 0);
  } finally { P.definirDetectado(false); }
});

teste('App.executar rejeita também no modo manual e volta a funcionar ao sair dele', async () => {
  chamadasStore.length = 0;
  P.definirManual(true);
  await assert.rejects(() => A.executar('entregar', [nb.id, {}]), /Modo consulta/);
  P.definirManual(false);
  const r = await A.executar('entregar', [nb.id, {}]);
  assert.strictEqual(r, 'feito');
  assert.strictEqual(chamadasStore.length, 1);
  assert.strictEqual(chamadasStore[0][0], 'entregar');
});

teste('Estoque: editável tem todos os botões; consulta só tem Histórico no menu ⋯', () => {
  const normal = tela('estoque');
  for (const t of ['+ Novo item', 'Devolução', 'Nova entrega', 'Entregar']) assert.ok(tem(normal, t), t);
  assert.ok(caixas(normal).length > 0, 'caixas de seleção');
  assert.ok(normal.querySelectorAll('td.editavel').length > 0, 'células editáveis');
  emModo(true, () => {
    const c = tela('estoque');
    for (const t of ['+ Novo item', 'Devolução', 'Nova entrega', 'Entregar', 'Devolver', 'Editar em lote']) assert.ok(!tem(c, t), 'não deveria ter ' + t);
    assert.strictEqual(caixas(c).length, 0, 'sem seleção em lote');
    assert.strictEqual(c.querySelectorAll('td.editavel').length, 0, 'sem edição por duplo clique');
    assert.strictEqual(c.querySelectorAll('th.sel').length, 0);
    assert.ok(tem(c, '⋯'), 'o menu ⋯ continua');
    assert.deepStrictEqual(A.acoes.acoesDoItem(nb).map(a => a.rotulo), ['Histórico']);
    assert.deepStrictEqual(A.acoes.acoesDoItem(nb2).map(a => a.rotulo), ['Histórico']);
    assert.ok(!A.acoes.acoesDoItem(nb).some(a => a.primaria));
  });
});

teste('Estoque: Enter na busca abre a ação principal quando editável e não faz nada em consulta', async () => {
  const dialogos = () => body.querySelectorAll('dialog').length;
  const esperar = ms => new Promise(r => setTimeout(r, ms));
  for (const consulta of [false, true]) {
    P.definirManual(consulta);
    try {
      const c = tela('estoque');
      const busca = c.querySelector('input');
      busca.value = 'SN-CONSULTA-1';
      busca.disparar('input');
      await esperar(150); // a busca usa debounce
      assert.strictEqual(c.querySelectorAll('tr[data-id]').length, 1, 'um único item visível');
      const antes = dialogos();
      busca.disparar('keydown', { key: 'Enter' });
      assert.strictEqual(dialogos(), consulta ? antes : antes + 1, consulta ? 'nada abre em consulta' : 'abre o formulário de entrega');
      body.querySelectorAll('dialog').forEach(d => d.remove());
      busca.value = ''; busca.disparar('input');
      await esperar(150);
    } finally { P.definirManual(false); }
  }
});

teste('Movimentações: sem Devolução e Nova entrega em consulta; a consulta e o Histórico continuam', () => {
  assert.ok(tem(tela('movimentos'), 'Nova entrega'));
  emModo(true, () => {
    const c = tela('movimentos');
    assert.ok(!tem(c, 'Nova entrega') && !tem(c, 'Devolução'));
    assert.ok(c.querySelectorAll('a').length > 0, 'links para o histórico do item continuam');
  });
});

teste('Descarte: sem Registrar, Editar e lote em consulta', () => {
  const n = tela('descarte');
  assert.ok(tem(n, 'Registrar descarte') && tem(n, 'Editar'));
  assert.ok(caixas(n).length > 1, 'caixas de seleção (inclui "só sem confirmação")');
  emModo(true, () => {
    const c = tela('descarte');
    assert.ok(!tem(c, 'Registrar descarte') && !tem(c, 'Editar'));
    assert.strictEqual(c.querySelectorAll('th.sel').length, 0);
    assert.strictEqual(c.querySelectorAll('input[data-sel]').length, 0);
    assert.ok(c.textContent.includes('Tela quebrada'), 'a lista continua visível');
    assert.ok(c.querySelectorAll('input').some(i => i.attrs.type === 'search'), 'busca continua');
  });
});

teste('Toner: status vira texto e somem Adicionar, Editar e ⋯ em consulta', () => {
  const n = tela('toner');
  assert.ok(tem(n, '+ Adicionar toner') && tem(n, 'Editar'));
  assert.ok(n.querySelectorAll('select').length > 1, 'select de status por linha');
  emModo(true, () => {
    const c = tela('toner');
    assert.ok(!tem(c, '+ Adicionar toner') && !tem(c, 'Editar') && !tem(c, '⋯'));
    // só o filtro "Todos os status" continua como select
    assert.strictEqual(c.querySelectorAll('select').length, 1);
    assert.ok(c.textContent.includes('W9008-EVP'));
    assert.deepStrictEqual(A.acoes.acoesDoToner(db.toners[0]), []);
  });
});

teste('Pessoas: sem cadastrar, vincular, editar e desativar; "Ver itens" e exportar continuam', () => {
  const n = tela('pessoas');
  assert.ok(tem(n, '+ Nova pessoa') && tem(n, 'Vincular nomes antigos…'));
  emModo(true, () => {
    const c = tela('pessoas');
    assert.ok(!tem(c, '+ Nova pessoa') && !tem(c, 'Vincular nomes antigos…'));
    assert.ok(tem(c, '⋯'), 'menu por linha continua');
    // o menu contém só "Ver itens"
    const menus = [];
    const orig = UI.menu; UI.menu = (_a, itens) => menus.push(itens.map(i => i.rotulo));
    try { c.querySelectorAll('button').filter(b => b.textContent === '⋯').forEach(b => b.click()); } finally { UI.menu = orig; }
    assert.ok(menus.length > 0);
    for (const m of menus) assert.deepStrictEqual(m, ['Ver itens']);
    const itens = c.querySelectorAll('button').filter(b => b.className.includes('link-itens'));
    assert.ok(itens.length > 0, 'o número de itens com a pessoa continua clicável');
  });
});

teste('Pessoas: abrirMigracao é recusada em consulta', () => {
  const toastsAntes = toasts.children.length;
  emModo(true, () => { tela('pessoas'); A.pessoasUI.abrirMigracao(); });
  assert.strictEqual(toasts.children.length, toastsAntes + 1);
  assert.match(toasts.lastChild.textContent, /Modo consulta/);
});

teste('Lixeira: sem Restaurar, Excluir definitivamente e Esvaziar; Histórico continua', () => {
  const n = tela('lixeira');
  for (const t of ['Restaurar', 'Excluir definitivamente', 'Esvaziar lixeira', 'Histórico']) assert.ok(tem(n, t), t);
  emModo(true, () => {
    const c = tela('lixeira');
    for (const t of ['Restaurar', 'Excluir definitivamente', 'Esvaziar lixeira']) assert.ok(!tem(c, t), 'não deveria ter ' + t);
    assert.ok(tem(c, 'Histórico'));
    assert.ok(c.textContent.includes('SN-LIXO-1'));
  });
});

teste('Dados e backup: some o que altera; ficam baixar, verificar, pasta e a opção "Uso deste computador"', () => {
  const n = tela('dados');
  for (const t of ['Escolher planilha…', 'Restaurar backup (.json)…', 'Atualizar cores dos toners pela planilha…', 'Tentar de novo', 'Descartar', 'Baixar planilha (.xlsx)']) {
    if (t === 'Atualizar cores dos toners pela planilha…') continue; // só aparece com toners importados
    assert.ok(tem(n, t), t);
  }
  emModo(true, () => {
    const c = tela('dados');
    for (const t of ['Escolher planilha…', 'Restaurar backup (.json)…', 'Atualizar cores dos toners pela planilha…', 'Tentar de novo', 'Descartar', 'Gravar backup na pasta agora']) {
      assert.ok(!tem(c, t), 'não deveria ter ' + t);
    }
    for (const t of ['Baixar planilha (.xlsx)', 'Baixar estoque (.csv)', 'Baixar backup completo (.json)', 'Verificar agora', 'Trocar pasta…', 'Sincronizar agora']) assert.ok(tem(c, t), t);
    assert.ok(c.textContent.includes('Uso deste computador'));
    assert.ok(c.textContent.includes('Este computador é só para consulta (não altera o estoque)'));
    assert.ok(c.textContent.includes('Quem não tem permissão de edição no SharePoint fica em consulta automaticamente.'));
    assert.ok(c.textContent.includes('O item já foi entregue.'), 'o conflito continua visível, só sem os botões');
  });
});

teste('Dados e backup: a caixa manual altera o modo; modo detectado mostra o motivo e não deixa desmarcar', () => {
  const c = tela('dados');
  const caixa = () => c.querySelector('#chk-so-consulta');
  assert.ok(caixa());
  assert.strictEqual(caixa().checked, false);
  caixa().checked = true; caixa().disparar('change');
  assert.strictEqual(P.manual(), true);
  assert.strictEqual(P.podeEditar(), false);
  P.definirManual(false);
  // detectado, sem manual
  P.definirDetectado(true, 'A pasta está somente para leitura.');
  try {
    const d = tela('dados');
    const cx = d.querySelector('#chk-so-consulta');
    assert.strictEqual(cx.checked, true);
    assert.strictEqual(cx.disabled, true, 'não pode desmarcar por ali');
    assert.ok(d.textContent.includes('A pasta está somente para leitura.'));
  } finally { P.definirDetectado(false); }
});

teste('Planilha de consulta: só aparece se o store informar; mostra data/erro; "Atualizar agora" só se pode editar e a função existir', () => {
  const S = A.store;
  assert.ok(!tela('dados').textContent.includes('Planilha de consulta'));
  S.estado.planilhaConsulta = { nome: 'estoque-consulta.xlsx', ultima: null, erro: null };
  try {
    assert.ok(tela('dados').textContent.includes('Ainda não gerada'));
    assert.ok(!tem(tela('dados'), 'Atualizar agora'), 'sem a função no store, sem botão');
    S.atualizarPlanilhaConsulta = async () => { };
    assert.ok(tem(tela('dados'), 'Atualizar agora'));
    emModo(true, () => assert.ok(!tem(tela('dados'), 'Atualizar agora'), 'em consulta não atualiza'));
    S.estado.planilhaConsulta = { nome: 'estoque-consulta.xlsx', ultima: new Date(2026, 4, 7, 9, 5).toISOString(), erro: null };
    assert.ok(tela('dados').textContent.includes('Atualizada em 07/05 09:05'));
    S.estado.planilhaConsulta = { nome: 'estoque-consulta.xlsx', ultima: null, erro: 'Arquivo em uso.' };
    assert.ok(tela('dados').textContent.includes('Arquivo em uso.'));
  } finally { delete S.estado.planilhaConsulta; delete S.atualizarPlanilhaConsulta; }
});

teste('Exportações continuam em consulta (baixar planilha, CSV, JSON e lista da pessoa)', () => {
  emModo(true, () => {
    const c = tela('dados');
    for (const t of ['Baixar planilha (.xlsx)', 'Baixar estoque (.csv)', 'Baixar backup completo (.json)']) {
      const b = c.querySelectorAll('button').find(x => x.textContent === t);
      assert.ok(b && !b.disabled, t);
    }
    assert.ok(typeof A.pessoasUI.abrirItens === 'function');
  });
});

teste('entrar e sair do modo consulta redesenha a tela aberta (app.js)', async () => {
  location.hash = '#estoque';
  // a inicialização do app.js é assíncrona (S.iniciar); espera o primeiro desenho
  await new Promise(r => setTimeout(r, 20));
  assert.ok(main.children.length > 0, 'a tela foi desenhada');
  assert.ok(tem(main, 'Nova entrega'));
  P.definirManual(true);
  assert.ok(!tem(main, 'Nova entrega'), 'redesenhou sem os botões');
  assert.ok(documento.getElementById('faixa-consulta').hidden === false);
  P.definirManual(false);
  assert.ok(tem(main, 'Nova entrega'), 'voltou com os botões');
  assert.strictEqual(documento.getElementById('faixa-consulta').hidden, true);
});

// ---------- execução ----------
(async () => {
  for (const { nome, fn } of fila) {
    try { await fn(); ok++; console.log('  ✓ ' + nome); }
    catch (e) { falhas++; console.log('  ✗ ' + nome + '\n      ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n      ')); }
  }
  console.log(`\n${ok} testes passaram, ${falhas} falharam.`);
  process.exit(falhas ? 1 : 0);
})();

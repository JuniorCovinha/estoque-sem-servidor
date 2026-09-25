/* Importação única da planilha atual (.xlsx) para o modelo da aplicação.
   Nada é decidido silenciosamente: casos ambíguos viram "pendências" que o usuário resolve antes de confirmar. */
(function (App) {
  'use strict';
  const { limpa, valorOuNulo, chave, numero, dataParaISO, fmtData, normalizaChamado, uid, agoraISO, hojeISO } = App.util;
  const L = App.ledger;

  // ---------- Leitura de células ----------

  function valor(ws, r, c) {
    if (c === undefined || c === null || c < 0) return null;
    const cel = ws[XLSX.utils.encode_cell({ r, c })];
    return cel ? cel.v : null;
  }

  function ultimaLinha(ws) {
    return ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).e.r : 0;
  }

  // Procura a linha de cabeçalho em que todas as colunas obrigatórias aparecem.
  function achaCabecalho(ws, specs, obrigatorias) {
    const fim = Math.min(ultimaLinha(ws), 60);
    for (let r = 0; r <= fim; r++) {
      const cols = {};
      for (let c = 0; c <= 30; c++) {
        const k = chave(valor(ws, r, c));
        if (!k) continue;
        for (const [nome, teste] of Object.entries(specs)) {
          if (cols[nome] === undefined && teste(k)) { cols[nome] = c; break; }
        }
      }
      if (obrigatorias.every(n => cols[n] !== undefined)) return { linha: r, cols };
    }
    return null;
  }

  function colunaNaLinha(ws, r, teste) {
    for (let c = 0; c <= 30; c++) if (teste(chave(valor(ws, r, c)))) return c;
    return undefined;
  }

  const eq = s => k => k === s;
  const ini = s => k => k.startsWith(s);

  function acharAba(wb, teste) {
    const nome = wb.SheetNames.find(n => teste(chave(n)));
    return nome ? { nome, ws: wb.Sheets[nome] } : null;
  }

  function linhaOriginal(ws, r, cab) {
    const o = {};
    for (const [nome, c] of Object.entries(cab.cols)) o[nome] = valor(ws, r, c);
    return o;
  }

  // ---------- Heurísticas (sempre expostas ao usuário) ----------

  function tokens(s) { return chave(s).replace(/[()/,.]/g, ' ').split(' ').filter(Boolean); }

  function adivinhaCategoria(texto, categorias) {
    const tk = new Set(tokens(texto));
    let melhor = null;
    for (const cat of categorias) {
      const ct = tokens(cat);
      if (ct.length && ct.every(t => tk.has(t)) && (!melhor || ct.length > tokens(melhor).length)) melhor = cat;
    }
    return melhor;
  }

  function categoriaCelular(modelo) {
    const k = chave(modelo);
    if (k.startsWith('samsung') || k.startsWith('galaxy')) return 'Celular Samsung';
    if (k.startsWith('moto')) return 'Celular Motorola';
    return 'Celular';
  }

  // ---------- Cor do toner (célula pintada) ----------
  // Na aba "Controle de toner" a coluna Cor não tem texto: a célula é preenchida com a cor do toner.
  // O SheetJS (cellStyles) expõe o preenchimento em cell.s.fgColor como rgb, theme(+tint) ou indexed.

  // Paleta padrão de cores indexadas do Excel (0–63).
  const PALETA_INDEXADA = ('000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF ' +
    '800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF ' +
    '000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 ' +
    '3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333').split(' ');

  function hexParaRGB(hex) {
    const s = String(hex || '').replace(/^#/, '');
    const x = s.length === 8 ? s.slice(2) : s; // ARGB → RGB
    return /^[0-9a-f]{6}$/i.test(x) ? [0, 2, 4].map(i => parseInt(x.slice(i, i + 2), 16)) : null;
  }
  const rgbParaHex = ([r, g, b]) => [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();

  function rgbParaHSL([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const hh = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [hh * 60, s, l];
  }
  function hslParaRGB([hh, s, l]) {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((hh / 60) % 2 - 1)), m = l - c / 2;
    const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
    return [r, g, b].map(v => (v + m) * 255);
  }
  // Tint do Excel: clareia (tint > 0) ou escurece (tint < 0) a luminosidade.
  function aplicaTint(rgb, tint) {
    if (!tint) return rgb;
    const [hh, s, l] = rgbParaHSL(rgb);
    return hslParaRGB([hh, s, tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint]);
  }

  // Retorna o RGB ("RRGGBB") do preenchimento da célula, ou null se não houver preenchimento.
  function rgbDoPreenchimento(wb, cel) {
    const s = cel && cel.s;
    if (!s || !s.patternType || s.patternType === 'none' || !s.fgColor) return null;
    const f = s.fgColor;
    let rgb = hexParaRGB(f.rgb); // SheetJS já resolve tema + tint quando consegue
    if (!rgb && f.theme !== undefined) {
      const esquema = wb.Themes && wb.Themes.themeElements && wb.Themes.themeElements.clrScheme;
      const base = esquema && esquema[f.theme] && hexParaRGB(esquema[f.theme].rgb);
      if (base) rgb = aplicaTint(base, f.tint || 0);
    }
    if (!rgb && f.indexed !== undefined && PALETA_INDEXADA[f.indexed]) rgb = aplicaTint(hexParaRGB(PALETA_INDEXADA[f.indexed]), f.tint || 0);
    return rgb ? rgbParaHex(rgb) : null;
  }

  // Cores usuais de toner: escolhe a mais próxima pela distância de matiz (limiar em graus).
  // Preto/branco/cinza são decididos pela luminosidade e saturação, onde a matiz não tem sentido.
  const CORES_TONER = [{ nome: 'Amarelo', matiz: 60, limiar: 25 }, { nome: 'Ciano', matiz: 180, limiar: 20 }, { nome: 'Magenta', matiz: 300, limiar: 30 }];
  const CORES_GENERICAS = [[15, 'Vermelho'], [35, 'Laranja'], [85, 'Amarelo'], [160, 'Verde'], [200, 'Ciano'], [255, 'Azul'], [270, 'Roxo'], [330, 'Magenta'], [345, 'Rosa'], [360, 'Vermelho']];

  // { nome, usual } — usual = uma das cores de toner (Preto, Ciano, Magenta, Amarelo).
  function nomeDaCor(hex) {
    const rgb = hexParaRGB(hex);
    if (!rgb) return { nome: '', usual: false };
    const [hh, s, l] = rgbParaHSL(rgb);
    if (l <= 0.2 || (l <= 0.35 && s <= 0.25)) return { nome: 'Preto', usual: true };
    if (s < 0.2 || l >= 0.95) return { nome: l >= 0.9 ? 'Branco' : 'Cinza', usual: false };
    let melhor = null;
    for (const c of CORES_TONER) {
      const dist = Math.min(Math.abs(hh - c.matiz), 360 - Math.abs(hh - c.matiz));
      if (dist <= c.limiar && (!melhor || dist < melhor.dist)) melhor = { nome: c.nome, dist };
    }
    if (melhor) return { nome: melhor.nome, usual: true };
    return { nome: CORES_GENERICAS.find(([ate]) => hh < ate)[1], usual: false };
  }

  // Localiza a aba de toner e o cabeçalho (Quantidade / Modelo / Cor / IMPRESSORA / STATUS).
  function abaToner(wb) {
    const aba = acharAba(wb, n => n.includes('toner'));
    if (!aba) return null;
    const cab = achaCabecalho(aba.ws, {
      quantidade: eq('quantidade'), modelo: eq('modelo'), cor: eq('cor'), impressora: eq('impressora'), status: eq('status'),
    }, ['modelo', 'status']);
    return cab ? Object.assign(aba, { cab }) : null;
  }

  // Cor de uma linha: texto na célula prevalece; senão, o nome da cor pintada; branco/sem preenchimento → vazio.
  function corDaLinha(wb, ws, r, c) {
    const texto = c === undefined ? null : valorOuNulo(valor(ws, r, c));
    const rgb = c === undefined ? null : rgbDoPreenchimento(wb, ws[XLSX.utils.encode_cell({ r, c })]);
    if (texto) return { cor: texto, rgb, fonte: 'texto', usual: true };
    if (!rgb) return { cor: null, rgb: null, fonte: 'vazia', usual: true };
    const n = nomeDaCor(rgb);
    if (n.nome === 'Branco') return { cor: null, rgb, fonte: 'preenchimento', usual: false, nomeLido: n.nome };
    return { cor: n.nome, rgb, fonte: 'preenchimento', usual: n.usual, nomeLido: n.nome };
  }

  function lerCoresDoWorkbook(wb) {
    const t = abaToner(wb);
    if (!t) return [];
    const lista = [];
    for (let r = t.cab.linha + 1; r <= ultimaLinha(t.ws); r++) {
      const modelo = limpa(valor(t.ws, r, t.cab.cols.modelo));
      if (!modelo) continue;
      lista.push(Object.assign({ linha: r + 1, modelo, aba: t.nome }, corDaLinha(wb, t.ws, r, t.cab.cols.cor)));
    }
    return lista;
  }

  // Só as cores da aba de toner: [{ linha, modelo, cor, rgb, fonte, usual, aba }]. Não altera a planilha.
  function lerCoresToner(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array', cellStyles: true, cellFormula: false, cellHTML: false });
    if (!abaToner(wb)) throw new Error('Aba "Controle de toner" (com cabeçalho Modelo / STATUS) não encontrada.');
    return lerCoresDoWorkbook(wb);
  }

  const rotuloCor = c => `${c.cor || '(vazia)'}${c.rgb ? ' (#' + c.rgb + ')' : ''}${c.fonte === 'texto' ? ' — texto da célula' : ''}`;

  // ---------- Parse ----------

  function lerPlanilha(arrayBuffer, nomeArquivo) {
    const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: false, cellFormula: false, cellHTML: false, cellStyles: true });
    const agora = agoraISO();
    const hoje = hojeISO();
    const anoAtual = Number(hoje.slice(0, 4));
    const draft = { itens: [], movimentos: [], toners: [] };
    const pend = [];
    const avisos = [];
    const resumo = {};

    const novoItem = o => {
      const it = Object.assign({
        id: uid(), controle: 'quantidade', categoria: '', descricao: '', serie: null, patrimonio: null,
        proprietario: 'Solar Cuidados', posicao: null, status: 'EM_ESTOQUE', local: 'MATRIZ',
        saldo: { MATRIZ: 0, SAO_CRISTOVAO: 0 }, responsavelAtual: null, saldoMinimo: null, obs: null,
        criadoEm: agora, atualizadoEm: agora, origem: null,
      }, o);
      draft.itens.push(it);
      return it;
    };
    const novoMov = o => {
      const m = Object.assign({
        id: uid(), tipo: null, itemId: null, item: null, local: null, delta: 0, quantidade: 0, usuario: null,
        chamado: null, data: hoje, obs: null, importado: true, criadoEm: agora,
      }, o);
      draft.movimentos.push(m);
      return m;
    };
    const saldoInicial = (it, local, q, origem) => novoMov({
      tipo: 'SALDO_INICIAL', itemId: it.id, item: L.snap(it), local, delta: q, quantidade: q, data: hoje,
      obs: `Importado da planilha (${origem.aba}, linha ${origem.linha})`, origem,
    });
    const P = o => { const p = Object.assign({ id: uid(), valor: null, tipoCampo: o.opcoes ? 'opcoes' : 'info' }, o); pend.push(p); return p; };
    const rotuloItem = it => `${it.categoria} — ${it.descricao}${it.serie ? ' · série ' + it.serie : ''}`;

    // ===== Aba Estoque =====
    const abaE = acharAba(wb, n => n === 'estoque');
    if (!abaE) throw new Error('Aba "Estoque" não encontrada. Confira se é a planilha correta.');
    const wsE = abaE.ws;
    const cabE = achaCabecalho(wsE, {
      local: eq('local'), item: eq('item'), descricao: eq('descricao'), serie: ini('numero de serie'),
      patrimonio: eq('patrimonio'), proprietario: eq('proprietario'), posicao: eq('posicao'),
      total: eq('total'), minimo: ini('saldo minimo'),
    }, ['item', 'descricao', 'serie']);
    if (!cabE) throw new Error('Cabeçalho da aba Estoque não reconhecido (ITEM / DESCRIÇÃO / NÚMERO DE SÉRIE).');
    const cM = colunaNaLinha(wsE, cabE.linha + 1, eq('matriz'));
    const cS = colunaNaLinha(wsE, cabE.linha + 1, eq('sc'));
    if (cM === undefined) throw new Error('Coluna "Matriz" não encontrada abaixo de LOCAL na aba Estoque.');
    const itensEstoque = [];

    for (let r = cabE.linha + 1; r <= ultimaLinha(wsE); r++) {
      const c = cabE.cols;
      const categoria = limpa(valor(wsE, r, c.item));
      const descricao = limpa(valor(wsE, r, c.descricao));
      const serie = valorOuNulo(valor(wsE, r, c.serie));
      if (!categoria && !descricao && !serie) continue;
      if (chave(valor(wsE, r, cM)) === 'matriz') continue; // subcabeçalho
      const origem = { aba: abaE.nome, linha: r + 1, original: linhaOriginal(wsE, r, cabE) };
      const qM = numero(valor(wsE, r, cM));
      const qS = cS === undefined ? 0 : numero(valor(wsE, r, cS));
      const minimo = valor(wsE, r, c.minimo);
      const base = {
        categoria: categoria || descricao, descricao: descricao || categoria,
        patrimonio: valorOuNulo(valor(wsE, r, c.patrimonio)),
        proprietario: limpa(valor(wsE, r, c.proprietario)) || 'Solar Cuidados',
        posicao: valorOuNulo(valor(wsE, r, c.posicao)),
        saldoMinimo: minimo === null || minimo === '' ? null : numero(minimo, null),
        origem,
      };

      if (!serie) {
        const it = novoItem(Object.assign(base, { controle: 'quantidade', saldo: { MATRIZ: qM, SAO_CRISTOVAO: qS } }));
        if (qM > 0) saldoInicial(it, 'MATRIZ', qM, origem);
        if (qS > 0) saldoInicial(it, 'SAO_CRISTOVAO', qS, origem);
        itensEstoque.push(it);
        continue;
      }

      const tot = qM + qS;
      const local = qS > 0 && qM === 0 ? 'SAO_CRISTOVAO' : 'MATRIZ';
      const it = novoItem(Object.assign(base, { controle: 'unidade', serie, local }));
      itensEstoque.push(it);
      if (tot === 1) {
        it.saldo[local] = 1;
        saldoInicial(it, local, 1, origem);
      } else if (tot > 1) {
        // Série única com mais de uma unidade: não é possível ser a mesma peça.
        it.controle = 'quantidade'; it.serie = null;
        it.saldo = { MATRIZ: qM, SAO_CRISTOVAO: qS };
        it.obs = `Nº de série informado na planilha: ${serie}`;
        if (qM > 0) saldoInicial(it, 'MATRIZ', qM, origem);
        if (qS > 0) saldoInicial(it, 'SAO_CRISTOVAO', qS, origem);
        P({ grupo: 'info', titulo: `Item com nº de série e quantidade ${tot}`, detalhe: `${rotuloItem(it)} (Estoque, linha ${r + 1}). Importado como item por quantidade; a série foi para a observação.` });
      } else {
        P({
          grupo: 'decisao', titulo: 'Item com nº de série e quantidade 0 no Estoque',
          detalhe: `${categoria} — ${descricao} · série ${serie} · posição ${base.posicao || '—'} (Estoque, linha ${r + 1}). Onde este item está?`,
          opcoes: [
            { valor: 'EM_ESTOQUE', rotulo: 'Está no estoque (saldo 1)' },
            { valor: 'ENTREGUE', rotulo: 'Foi entregue' },
            { valor: 'DESCARTADO', rotulo: 'Foi descartado' },
            { valor: 'remover', rotulo: 'Não importar' },
          ],
          aplicar: (d, v) => {
            const alvo = d.itens.find(x => x.id === it.id);
            if (!alvo) return;
            if (v === 'remover') return removerItem(d, it.id);
            alvo.status = v;
            if (v === 'EM_ESTOQUE') { alvo.saldo[alvo.local] = 1; d.movimentos.push(Object.assign(mkMovDe(saldoInicialModelo(alvo, origem, hoje, agora)))); }
          },
        });
      }

      if (/manuten[cç][aã]o/i.test(descricao)) {
        P({
          grupo: 'revisar', titulo: 'Situação escrita na descrição',
          detalhe: `"${descricao}" (Estoque, linha ${r + 1}). Marcar como "Em manutenção" e tirar o texto da descrição?`,
          opcoes: [{ valor: 'aplicar', rotulo: 'Sim, marcar manutenção' }, { valor: 'manter', rotulo: 'Não, manter como está' }],
          valor: 'aplicar',
          aplicar: (d, v) => {
            const alvo = d.itens.find(x => x.id === it.id);
            if (v !== 'aplicar' || !alvo || alvo.controle !== 'unidade') return;
            if (alvo.status === 'EM_ESTOQUE') alvo.status = 'MANUTENCAO';
            alvo.descricao = limpa(alvo.descricao.replace(/\(?\s*manuten[cç][aã]o\s*\)?/i, '')) || alvo.descricao;
          },
        });
      }
    }

    // Séries repetidas dentro do Estoque
    const porSerie = new Map();
    for (const it of itensEstoque) if (it.serie) {
      const k = chave(it.serie);
      porSerie.set(k, (porSerie.get(k) || []).concat(it));
    }
    for (const grupo of porSerie.values()) {
      if (grupo.length < 2) continue;
      P({
        grupo: 'decisao', titulo: `Nº de série repetido no Estoque: ${grupo[0].serie}`,
        detalhe: grupo.map(g => `linha ${g.origem.linha} — ${g.descricao}, posição ${g.posicao || '—'}, qtd ${L.total(g)}`).join(' | '),
        opcoes: [
          { valor: 'primeiro', rotulo: `Manter só a linha ${grupo[0].origem.linha}` },
          { valor: 'todos', rotulo: 'Manter todas (ficará marcado na verificação)' },
        ],
        aplicar: (d, v) => { if (v === 'primeiro') grupo.slice(1).forEach(g => removerItem(d, g.id)); },
      });
    }
    // Mesmo item (sem série) repetido em mais de uma linha
    const chaveItem = i => chave(i.categoria) + '|' + chave(i.descricao);
    const porItem = new Map();
    for (const it of itensEstoque) if (it.controle === 'quantidade') porItem.set(chaveItem(it), (porItem.get(chaveItem(it)) || []).concat(it));
    for (const grupo of porItem.values()) {
      if (grupo.length < 2) continue;
      const mesmaPos = grupo.every(g => chave(g.posicao) === chave(grupo[0].posicao));
      P({
        grupo: 'revisar', titulo: `Mesmo item em ${grupo.length} linhas: ${grupo[0].categoria} — ${grupo[0].descricao}`,
        detalhe: grupo.map(g => `linha ${g.origem.linha}: ${L.total(g)} un., posição ${g.posicao || '—'}`).join(' | ') + '. Juntar soma as quantidades num único item.',
        opcoes: [{ valor: 'juntar', rotulo: `Juntar (total ${grupo.reduce((s, g) => s + L.total(g), 0)} un.)` }, { valor: 'manter', rotulo: 'Manter separados' }],
        valor: mesmaPos ? 'juntar' : 'manter',
        aplicar: (d, v) => {
          if (v !== 'juntar') return;
          const [alvo, ...resto] = grupo;
          for (const g of resto) {
            alvo.saldo.MATRIZ += g.saldo.MATRIZ; alvo.saldo.SAO_CRISTOVAO += g.saldo.SAO_CRISTOVAO;
            d.movimentos.forEach(m => { if (m.itemId === g.id) { m.itemId = alvo.id; m.item = L.snap(alvo); } });
            d.itens = d.itens.filter(i => i.id !== g.id);
            if (g.posicao && chave(g.posicao) !== chave(alvo.posicao)) alvo.obs = [alvo.obs, `Também havia unidades na posição ${g.posicao}`].filter(Boolean).join('; ');
          }
        },
      });
    }
    resumo.estoque = itensEstoque.length;

    const categoriasEstoque = L.listas.categorias({ itens: itensEstoque });

    // ===== Aba Celulares (unificada no Estoque) =====
    const abaC = acharAba(wb, n => n === 'celulares');
    resumo.celulares = 0;
    if (abaC) {
      const wsC = abaC.ws;
      const cabC = achaCabecalho(wsC, {
        modelo: eq('modelo'), status: k => k.startsWith('disp'), serie: ini('numero de serie'),
        patrimonio: eq('patrimonio'), proprietario: eq('proprietario'), posicao: eq('posicao'),
      }, ['modelo', 'status']);
      if (cabC) for (let r = cabC.linha + 1; r <= ultimaLinha(wsC); r++) {
        const c = cabC.cols;
        const modelo = limpa(valor(wsC, r, c.modelo));
        if (!modelo) continue;
        const st = chave(valor(wsC, r, c.status));
        const serie = valorOuNulo(valor(wsC, r, c.serie));
        const origem = { aba: abaC.nome, linha: r + 1, original: linhaOriginal(wsC, r, cabC) };
        const it = novoItem({
          controle: 'unidade', categoria: categoriaCelular(modelo), descricao: modelo, serie,
          patrimonio: valorOuNulo(valor(wsC, r, c.patrimonio)),
          proprietario: limpa(valor(wsC, r, c.proprietario)) || 'Solar Cuidados',
          posicao: valorOuNulo(valor(wsC, r, c.posicao)),
          status: st.startsWith('manut') ? 'MANUTENCAO' : 'EM_ESTOQUE', local: 'MATRIZ', origem,
          obs: `Aba Celulares: ${limpa(valor(wsC, r, c.status)) || '—'}`,
        });
        it.saldo.MATRIZ = 1;
        saldoInicial(it, 'MATRIZ', 1, origem);
        resumo.celulares++;
        const ultimo = tokens(modelo).slice(-1)[0];
        const parecidos = itensEstoque.filter(e => chave(e.categoria).includes('celular') && tokens(e.descricao).includes(ultimo));
        P({
          grupo: parecidos.length ? 'decisao' : 'revisar',
          titulo: `Celular da aba Celulares${serie ? '' : ' sem nº de série'}: ${modelo} (${limpa(valor(wsC, r, c.status)) || '—'})`,
          detalhe: parecidos.length
            ? `Pode ser o mesmo aparelho já listado no Estoque: ${parecidos.map(p => `${p.descricao}${p.serie ? ' (' + p.serie + ')' : ''}, linha ${p.origem.linha}`).join('; ')}.`
            : `Será importado como ${it.categoria}, situação "${L.STATUS[it.status]}", na Matriz.`,
          opcoes: [{ valor: 'importar', rotulo: 'Importar como novo item' }, { valor: 'remover', rotulo: 'Não importar (já está no Estoque)' }],
          valor: parecidos.length ? null : 'importar',
          aplicar: (d, v) => { if (v === 'remover') removerItem(d, it.id); },
        });
      }
    }

    // ===== Aba Disponibilização (histórico de entregas) =====
    const abaD = acharAba(wb, n => n.startsWith('disponibiliza'));
    resumo.entregas = 0;
    if (abaD) {
      const wsD = abaD.ws;
      const cabD = achaCabecalho(wsD, {
        local: eq('local'), item: eq('item'), serie: ini('numero de serie'), patrimonio: eq('patrimonio'),
        usuario: eq('usuario'), chamado: eq('chamado'), data: eq('data'), descricao: eq('descricao'),
      }, ['item', 'usuario', 'data']);
      if (!cabD) avisos.push('Cabeçalho da aba Disponibilização não reconhecido; entregas não importadas.');
      const cM2 = cabD && colunaNaLinha(wsD, cabD.linha + 1, eq('matriz'));
      const cS2 = cabD && colunaNaLinha(wsD, cabD.linha + 1, eq('sc'));
      const entregasPorSerie = new Map();
      const semCategoria = new Map();

      if (cabD) for (let r = cabD.linha + 1; r <= ultimaLinha(wsD); r++) {
        const c = cabD.cols;
        const texto = limpa(valor(wsD, r, c.item));
        const serie = valorOuNulo(valor(wsD, r, c.serie));
        if (!texto && !serie) continue;
        if (chave(valor(wsD, r, cM2)) === 'matriz') continue;
        const qM = numero(valor(wsD, r, cM2));
        const qS = cS2 === undefined ? 0 : numero(valor(wsD, r, cS2));
        const local = qS > 0 && qM === 0 ? 'SAO_CRISTOVAO' : 'MATRIZ';
        const qtd = (qM + qS) || 1;
        const usuario = valorOuNulo(valor(wsD, r, c.usuario));
        const brutoData = valor(wsD, r, c.data);
        const data = dataParaISO(brutoData);
        const statusTxt = valorOuNulo(valor(wsD, r, c.descricao));
        const origem = { aba: abaD.nome, linha: r + 1, original: linhaOriginal(wsD, r, cabD) };
        const descricao = serie ? limpa(texto.replace(new RegExp('\\(\\s*' + serie.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\)', 'i'), '')) : texto;

        let item = null;
        if (serie) {
          item = draft.itens.find(i => i.serie && chave(i.serie) === chave(serie));
          if (!item) {
            const cat = adivinhaCategoria(descricao, categoriasEstoque);
            item = novoItem({
              controle: 'unidade', categoria: cat || descricao, descricao, serie,
              patrimonio: valorOuNulo(valor(wsD, r, c.patrimonio)), status: 'ENTREGUE', local, origem,
              obs: 'Criado a partir do histórico de entregas',
            });
            item._criadoPorEntrega = true;
            if (!cat) {
              const k = chave(descricao);
              semCategoria.set(k, (semCategoria.get(k) || { texto: descricao, itens: [] }));
              semCategoria.get(k).itens.push(item);
            }
          }
          const lista = entregasPorSerie.get(item.id) || [];
          lista.push({ usuario, data, linha: r + 1 });
          entregasPorSerie.set(item.id, lista);
        } else {
          const candidatos = itensEstoque.filter(i => i.controle === 'quantidade' && tokens(i.categoria).every(t => tokens(texto).includes(t)));
          const fino = candidatos.filter(i => tokens(i.descricao).filter(t => t.length > 1).every(t => tokens(texto).includes(t)));
          // Linhas repetidas do mesmo item contam como um único candidato (vincula à primeira).
          const unico = arr => arr.length && arr.every(i => chaveItem(i) === chaveItem(arr[0])) ? arr[0] : null;
          item = unico(fino) || unico(candidatos);
          // "Celular" genérico também conta como a categoria "Celular Samsung" para este alerta.
          const tt = tokens(texto);
          const cats = [adivinhaCategoria(texto, categoriasEstoque)].concat(categoriasEstoque.filter(ct => tt.length && tt.every(t => tokens(ct).includes(t)))).filter(Boolean);
          if (!item && cats.some(ct => L.categoriaUsaSerie({ itens: itensEstoque }, ct))) {
            P({ grupo: 'info', titulo: 'Entrega sem nº de série de item que costuma ter série', detalhe: `"${texto}" para ${usuario || '—'} em ${fmtData(data)} (linha ${r + 1}). Importada só como histórico, sem vínculo com item.` });
          }
        }

        const mov = novoMov({
          tipo: 'ENTREGA', itemId: item ? item.id : null,
          item: item ? L.snap(item) : { categoria: adivinhaCategoria(texto, categoriasEstoque) || texto, descricao: texto, serie },
          local, quantidade: qtd, usuario, chamado: normalizaChamado(valor(wsD, r, c.chamado)),
          data, obs: statusTxt, origem,
        });
        resumo.entregas++;

        const ano = data ? Number(data.slice(0, 4)) : null;
        if (!data || ano < anoAtual - 5 || data > hoje) {
          P({
            grupo: data ? 'revisar' : 'decisao', tipoCampo: 'data',
            titulo: data ? `Data suspeita: ${fmtData(data)}` : 'Entrega sem data válida',
            detalhe: `"${texto}" para ${usuario || '—'} (Disponibilização, linha ${r + 1}; valor original: ${brutoData ?? 'vazio'}).`,
            valor: data,
            aplicar: (d, v) => { mov.data = v || mov.data; },
          });
        }
        if (!statusTxt) {
          P({
            grupo: 'revisar', titulo: 'Entrega sem status',
            detalhe: `"${texto}" para ${usuario || '—'} em ${fmtData(data)} (linha ${r + 1}). A coluna DESCRIÇÃO está vazia.`,
            opcoes: [{ valor: 'importar', rotulo: 'Importar como entregue' }, { valor: 'remover', rotulo: 'Não importar' }],
            valor: 'importar',
            aplicar: (d, v) => {
              if (v === 'remover') {
                d.movimentos = d.movimentos.filter(m => m.id !== mov.id);
                const e = entregasPorSerie.get(mov.itemId);
                if (e) { const i = e.findIndex(x => x.linha === r + 1); if (i >= 0) e.splice(i, 1); }
              }
            },
          });
        }
      }

      // Situação final de itens com série após todas as entregas
      for (const [itemId, lista] of entregasPorSerie) {
        const it = draft.itens.find(i => i.id === itemId);
        const ordenada = () => lista.slice().sort((a, b) => String(a.data).localeCompare(String(b.data)) || a.linha - b.linha);
        if (lista.length > 1) {
          P({
            grupo: 'info', titulo: `Mesmo nº de série entregue ${lista.length} vezes sem devolução: ${it.serie}`,
            detalhe: `${it.descricao}: ${ordenada().map(e => `${e.usuario || '—'} em ${fmtData(e.data)} (linha ${e.linha})`).join('; ')}. Fica registrado como entregue ao último.`,
          });
        }
        if (it._criadoPorEntrega) {
          const prePass = () => { const u = ordenada().slice(-1)[0]; it.responsavelAtual = u ? u.usuario : null; };
          prePass();
          P({ grupo: 'oculto', aplicar: () => { prePass(); if (!lista.length) removerItem(draft, it.id); } });
        } else if (it.status === 'EM_ESTOQUE' || it.status === 'MANUTENCAO') {
          const u = ordenada().slice(-1)[0];
          P({
            grupo: 'decisao', titulo: `Item consta no Estoque e também como entregue: ${it.serie}`,
            detalhe: `${rotuloItem(it)} está no Estoque (linha ${it.origem.linha}, saldo ${L.total(it)}), mas foi entregue a ${u.usuario || '—'} em ${fmtData(u.data)} (Disponibilização, linha ${u.linha}).`,
            opcoes: [
              { valor: 'baixar', rotulo: `Está com ${u.usuario || 'o usuário'} (baixar do estoque)` },
              { valor: 'manter', rotulo: 'Voltou ao estoque (manter saldo)' },
            ],
            aplicar: (d, v) => {
              const alvo = d.itens.find(x => x.id === it.id);
              if (!alvo) return;
              const uu = ordenada().slice(-1)[0];
              if (!uu) return;
              if (v === 'baixar' && L.total(alvo) > 0) {
                const local = alvo.saldo.MATRIZ > 0 ? 'MATRIZ' : 'SAO_CRISTOVAO';
                alvo.saldo[local] -= 1;
                alvo.status = 'ENTREGUE';
                alvo.responsavelAtual = uu.usuario;
                d.movimentos.push(mkMovDe({
                  tipo: 'AJUSTE', itemId: alvo.id, item: L.snap(alvo), local, delta: -1, quantidade: 1, data: hoje, criadoEm: agora,
                  obs: `Baixa decidida na importação: entregue a ${uu.usuario || '—'} em ${fmtData(uu.data)} (Disponibilização, linha ${uu.linha})`,
                }));
              } else if (v === 'manter') {
                const e = d.movimentos.find(m => m.origem && m.origem.linha === uu.linha && m.tipo === 'ENTREGA' && m.itemId === alvo.id);
                if (e) e.obs = [e.obs, 'Item voltou ao estoque (devolução não registrada na planilha)'].filter(Boolean).join(' — ');
              }
            },
          });
        }
      }

      for (const g of semCategoria.values()) {
        P({
          grupo: 'revisar', tipoCampo: 'texto', sugestoes: categoriasEstoque,
          titulo: `Categoria para itens entregues: "${g.texto}" (${g.itens.length})`,
          detalhe: 'Não há categoria equivalente no Estoque. Informe a categoria (ex.: "Tablet Samsung") ou deixe como está.',
          valor: g.texto,
          aplicar: (d, v) => {
            const cat = limpa(v) || g.texto;
            for (const it of g.itens) {
              it.categoria = cat;
              d.movimentos.filter(m => m.itemId === it.id).forEach(m => { m.item = L.snap(it); });
            }
          },
        });
      }
    }

    // ===== Aba Descarte =====
    const abaX = acharAba(wb, n => n === 'descarte');
    resumo.descartes = 0; resumo.valorDescarte = 0;
    if (abaX) {
      const wsX = abaX.ws;
      const cabX = achaCabecalho(wsX, {
        item: eq('item'), qtd: k => k.startsWith('qtd'), modelo: eq('modelo'), serie: ini('numero de serie'),
        ano: ini('ano de fabric'), justificativa: eq('justificativa'),
        unit: k => k.startsWith('valor estimado') && k.includes('unit'), totalV: k => k.startsWith('valor estimado') && k.includes('total'),
      }, ['item', 'qtd', 'justificativa']);
      if (!cabX) avisos.push('Cabeçalho da aba Descarte não reconhecido; descartes não importados.');
      if (cabX) for (let r = cabX.linha + 1; r <= ultimaLinha(wsX); r++) {
        const c = cabX.cols;
        const cat = limpa(valor(wsX, r, c.item));
        const modelo = limpa(valor(wsX, r, c.modelo));
        if (!cat && !modelo) continue;
        if (chave(cat) === 'total' || chave(valor(wsX, r, c.unit)) === 'total') continue;
        const q = numero(valor(wsX, r, c.qtd), 1) || 1;
        const vu = valor(wsX, r, c.unit);
        const serie = valorOuNulo(valor(wsX, r, c.serie));
        const anoV = valorOuNulo(valor(wsX, r, c.ano));
        const origem = { aba: abaX.nome, linha: r + 1, original: linhaOriginal(wsX, r, cabX) };
        const valorUnit = vu === null || vu === '' ? null : numero(vu, null);
        novoMov({
          tipo: 'DESCARTE', itemId: null, item: { categoria: cat || modelo, descricao: modelo || cat, serie },
          quantidade: q, data: null, obs: 'Importado da planilha (data do descarte não registrada)', origem,
          descarte: {
            justificativa: valorOuNulo(valor(wsX, r, c.justificativa)), anoFabricacao: anoV ? String(anoV).slice(0, 4) : null,
            valorUnit, dadosApagados: 'NAO_INFORMADO', metodo: null, certificado: null,
          },
        });
        resumo.descartes++;
        resumo.valorDescarte += (valorUnit || 0) * q;
        if (serie) {
          const noEstoque = itensEstoque.find(i => i.serie && chave(i.serie) === chave(serie));
          if (noEstoque) P({ grupo: 'info', titulo: `Série descartada também está no Estoque: ${serie}`, detalhe: `Descarte linha ${r + 1} × Estoque linha ${noEstoque.origem.linha}. Revise após importar.` });
        }
      }
    }

    // ===== Aba Controle de toner =====
    const abaT = abaToner(wb);
    resumo.toners = 0;
    if (abaT) {
      const wsT = abaT.ws;
      const cabT = abaT.cab;
      const mapa = { novo: 'NOVO', 'em uso': 'EM_USO', descarte: 'DESCARTE' };
      const coresLidas = [];
      for (let r = cabT.linha + 1; r <= ultimaLinha(wsT); r++) {
        const c = cabT.cols;
        const modelo = limpa(valor(wsT, r, c.modelo));
        if (!modelo) continue;
        const stTxt = chave(valor(wsT, r, c.status));
        const status = mapa[stTxt] || 'NOVO';
        if (!mapa[stTxt]) P({ grupo: 'info', titulo: 'Status de toner não reconhecido', detalhe: `Linha ${r + 1}: "${valor(wsT, r, c.status) ?? ''}". Importado como Novo.` });
        const q = numero(valor(wsT, r, c.quantidade), 1) || 1;
        const cor = corDaLinha(wb, wsT, r, c.cor);
        coresLidas.push(Object.assign({ linha: r + 1, modelo }, cor));
        if (!cor.usual) {
          P({
            grupo: 'info', titulo: cor.cor ? `Cor de toner não usual: ${cor.cor}` : 'Toner sem cor identificada',
            detalhe: `${modelo} (Controle de toner, linha ${r + 1}): preenchimento #${cor.rgb} (${cor.nomeLido}). ${cor.cor ? 'Importado com esse nome' : 'Importado com a cor vazia'}; ajuste em Toner → Editar se necessário.`,
          });
        }
        const origem = { aba: abaT.nome, linha: r + 1, original: linhaOriginal(wsT, r, cabT), corRGB: cor.rgb ? '#' + cor.rgb : null };
        for (let i = 0; i < q; i++) {
          draft.toners.push({ id: uid(), modelo, cor: cor.cor, impressora: valorOuNulo(valor(wsT, r, c.impressora)), status, obs: null, origem });
          resumo.toners++;
        }
      }
      if (coresLidas.some(x => x.fonte === 'preenchimento')) {
        P({
          grupo: 'info', titulo: 'Cores dos toners lidas do preenchimento da célula',
          detalhe: coresLidas.map(x => `linha ${x.linha}: ${x.modelo} → ${rotuloCor(x)}`).join(' | '),
        });
      }
    }

    return { draft, pendencias: pend, avisos, resumo, arquivo: nomeArquivo || null, abas: wb.SheetNames };
  }

  // ---------- Aplicação das decisões ----------

  function mkMovDe(o) {
    return Object.assign({ id: uid(), importado: true, usuario: null, chamado: null, obs: null, local: null, delta: 0, quantidade: 0 }, o);
  }

  function saldoInicialModelo(it, origem, hoje, agora) {
    return {
      tipo: 'SALDO_INICIAL', itemId: it.id, item: L.snap(it), local: it.local, delta: 1, quantidade: 1, data: hoje, criadoEm: agora,
      obs: `Importado da planilha (${origem.aba}, linha ${origem.linha}) — situação confirmada na importação`, origem,
    };
  }

  function removerItem(d, id) {
    d.itens = d.itens.filter(i => i.id !== id);
    d.movimentos = d.movimentos.filter(m => !(m.itemId === id && (m.tipo === 'SALDO_INICIAL' || m.tipo === 'AJUSTE')));
    d.movimentos.forEach(m => { if (m.itemId === id) m.itemId = null; });
  }

  function pendentes(resultado) {
    return resultado.pendencias.filter(p => p.grupo === 'decisao' && (p.valor === null || p.valor === undefined || p.valor === ''));
  }

  function aplicar(resultado) {
    if (pendentes(resultado).length) throw new Error('Ainda há decisões obrigatórias sem resposta.');
    const d = resultado.draft;
    for (const p of resultado.pendencias) if (p.aplicar) p.aplicar(d, p.valor);
    for (const it of d.itens) delete it._criadoPorEntrega;
    const db = L.novoBanco();
    db.itens = d.itens;
    db.movimentos = d.movimentos;
    db.toners = d.toners;
    db.importacao = { arquivo: resultado.arquivo, em: agoraISO(), resumo: resultado.resumo };
    return db;
  }

  App.importer = { lerPlanilha, aplicar, pendentes, lerCoresToner, nomeDaCor, rgbDoPreenchimento };
})(globalThis.App = globalThis.App || {});

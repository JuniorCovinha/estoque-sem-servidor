# Estoque TI — contexto para o Claude Code

Aplicação local de controle de estoque de ativos de TI da Solar Cuidados (Infraestrutura). HTML/CSS/JS puro,
sem framework, sem build, sem servidor: o usuário abre `index.html` direto no Chrome (`file://`).
Funcionalidades, regras de negócio e estrutura: ver `README.md`. Instalação na pasta do SharePoint: `GUIA-INSTALACAO.md`.
Idioma de tudo (código, comentários, interface, commits): **português do Brasil**.

## Regras de código (não quebrar)

- **Scripts clássicos**, cada arquivo em `(function (App) { 'use strict'; ... })(globalThis.App = globalThis.App || {});`.
  Nada de ES modules (`import`/`export`): o Chrome bloqueia módulos em `file://`. Ordem de carga em `index.html`.
- **DOM só por `App.util.h(tag, attrs, ...filhos)` e `App.util.preencher(el, ...filhos)`.** Nunca `innerHTML`,
  `insertAdjacentHTML`, `outerHTML` nem `eval` (requisito de segurança, CWE-79). Não use `el.append(...)` com
  valores que podem ser `null` (escreve "null"): use `preencher`.
- Estilo do código: nomes em português, comentários curtos, funções pequenas; siga o arquivo vizinho.
- Toda alteração de dados passa por `App.executar('nomeDaFuncaoDoLedger', [args], 'mensagem')` (operações
  sincronizáveis). Mudanças só visuais não devem mexer em `js/ledger.js`, `js/sync.js`, `js/remoto.js`, `js/store.js`.
- Sem rede: nenhum recurso externo (CDN, Google Fonts etc.). Fontes/imagens só locais.
- Ao publicar uma versão nova do app, aumente `VERSAO_APP` em `js/sync.js`.

## Identidade visual

Use a skill **Solar_Brand_Identity** (instalada na conta) como fonte de verdade da marca.

- **Cores**: todas em variáveis no topo de `css/app.css` (`:root`), com tema escuro em
  `@media (prefers-color-scheme: dark)` (`:root:not([data-theme="light"])`). Não espalhe cores soltas pelo CSS:
  crie/ajuste tokens.
  - Marca: `--solar-roxo #5F0F42` (estrutura: topo, botão principal, títulos), `--solar-sol #FAA836`
    (destaque: aba ativa, foco, botão de chamada no topo), `--solar-magenta #A2026B` (situação "Entregue"),
    neutros quentes `--solar-neutro #D7D0CA` / `--solar-sol-claro #FACF9E`.
  - Semânticos (decisão: NÃO seguem a marca, para não confundir estado com decoração): `--ok` (verde, em estoque),
    `--warn` (âmbar, manutenção/atenção), `--danger` (vermelho, erro/excluir), `--neutral`.
  - No tema escuro o botão principal vira laranja com texto escuro (`--accent`/`--on-accent`).
- **Tipografia**: `--fonte-marca` (Gotham, instalada só no PC do usuário; peso 500, sem negrito sintético) em títulos,
  abas, botões e números dos cartões; `--fonte-texto` (Segoe UI) em tabelas e textos densos. Em PC sem Gotham cai
  na Segoe UI — o layout precisa continuar bom assim.
- **Logo** (`img/logo-solar-fundo-roxo.png`) e **grafismo orbital** (`img/grafismo-orbital.png`): arquivos
  originais da marca. Nunca redesenhar, recolorir, filtrar ou distorcer; só posicionar/redimensionar mantendo proporção.
  O grafismo fica no canto direito do topo (`css/marca.css`) e no estado vazio do Estoque.
- Contraste mínimo WCAG AA (4,5:1 para texto). Foco visível em todo controle (`--focus`).

## Onde ficam os componentes visuais

- `css/app.css` — seções marcadas com `/* ---------- Nome ---------- */`: Topo, Barra de ferramentas, Controles,
  Tabela, Cartões/seções, Relatório de importação, Diálogos, Menu, Toasts, Seleção e edição em lote, Pessoas,
  Modo consulta. Classes principais: `.btn` (+ `primario`, `perigo`, `pequeno`, `fantasma`, `icone`),
  `.badge` (+ `ok`, `info`, `warn`, `danger`, `neutro`), `.aviso`, `.cartao`/`.cartoes`, `.secao`, `.tab`/`.tabela-wrap`,
  `dialog.dlg` (`.dlg-cab`, `.dlg-corpo`, `.dlg-rodape`), `.campo`/`.grade`, `.segmentado`, `.menu`, `.toast`,
  `.faixa-consulta`, `.vazio`, `.pend`.
- `css/marca.css` — grafismo orbital do topo.
- `js/ui-common.js` — componentes: `App.ui.formulario` (diálogos de formulário), `confirmar`, `escolher`, `menu`,
  `toast`, `select`, `cabecalhoOrdenavel`, `selecao` (seleção/lote), `prefs`.
- Telas: `js/ui-estoque.js`, `ui-movimentos.js`, `ui-descarte.js`, `ui-toner.js`, `ui-pessoas.js`, `ui-lixeira.js`,
  `ui-dados.js`; diálogos de operação em `js/ui-acoes.js`; topo/status/navegação em `js/app.js`.
- Modo consulta (somente leitura): `js/permissao.js`; as telas escondem botões quando `!App.permissao.podeEditar()`.

## Testes (rodar antes de concluir qualquer mudança)

```
node test/testes.js
node test/testes-lote.js
node test/testes-sync.js
node test/testes-pessoas.js
node test/testes-revisao.js
node test/testes-compartilhamento.js
node test/testes-permissao.js
node test/poc-revisao.js        # deve dar "0 reproduzido(s)"
```
Atenção: `test/testes-permissao.js` confere o **texto exato** de vários botões e títulos. Se renomear um rótulo,
atualize o teste junto (e confirme que a mudança é intencional).

## Como visualizar no navegador embutido

O painel de navegador do Claude não executa o app aberto por `file://`. Para ver as telas:
`node tools/servidor-teste.js` → `http://localhost:8765` (para o painel, crie `.claude/launch.json` apontando
`runtimeExecutable: "node"`, `runtimeArgs: ["tools/servidor-teste.js"]`, `port: 8765`; `.claude/` não é versionado).
O servidor bloqueia a pasta `dados/`. O navegador de teste tem armazenamento próprio (começa vazio): para ter dados,
importe a planilha em Dados e backup, ou cadastre itens de teste. Confira os temas claro e escuro e uma largura
estreita (~620 px), onde o topo quebra em duas linhas.

## Nunca

- Alterar `Planilha Ativos e Passivos Estoque e Descartes.xlsx` ou qualquer coisa em `dados/` (dados reais, LGPD).
- Versionar dados, planilhas, backups ou o zip (já estão no `.gitignore`).
- Fazer commit/push sem o usuário pedir.

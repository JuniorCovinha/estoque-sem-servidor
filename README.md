# Estoque TI — aplicação local

Controle de estoque de ativos de TI (Matriz e São Cristóvão), entregas, devoluções, manutenção, descarte e toner.
Roda direto no navegador, sem servidor e sem internet.

## Como abrir

Dê dois cliques em **`Abrir Estoque TI.cmd`**: abre direto no Google Chrome (ou no Edge, se não houver Chrome).

Para ter um atalho na área de trabalho, rode uma vez **`Criar atalho na area de trabalho.cmd`**
(depois de colocar a pasta no lugar definitivo; se mover a pasta, rode de novo).

## Primeiro uso

1. **Dados e backup → Importar planilha atual** e escolha `Planilha Ativos e Passivos Estoque e Descartes.xlsx`.
   A planilha é apenas lida. Resolva as decisões do relatório e clique em **Confirmar importação**.
2. **Dados e backup → Escolher pasta…** e selecione uma pasta sincronizada com o SharePoint/OneDrive.
   A aplicação grava ali `estoque.json` a cada alteração e, na primeira gravação de cada dia,
   uma cópia da versão anterior em `backup/` (`.json` + `.xlsx`).

Ao reabrir, o Chrome pode pedir para **Reconectar** a pasta (um clique no topo da tela).
Enquanto a pasta estiver desconectada, as alterações ficam guardadas no navegador e são enviadas ao reconectar.

## Sincronização (vários computadores)

- Cada alteração é uma **operação** (ex.: "entregar item X a Fulana") com autor e horário. O topo mostra
  "N alterações aguardando sincronização" ou "Sincronizado às HH:MM".
- Se outra pessoa gravou o arquivo antes, as suas operações são **reaplicadas sobre a versão dela**, com as
  mesmas regras. As que não fizerem mais sentido (ex.: o notebook já foi entregue por outra pessoa) vão para
  **Dados e backup → Sincronização → Conflitos para revisar** (Tentar de novo / Descartar). Nada é descartado sozinho.
- O autor vem de **Dados e backup → Quem está usando este computador** (até existir login Microsoft).
- Importar a planilha e restaurar backup substituem tudo: só com a fila vazia. A aplicação sincroniza antes e guarda
  uma cópia do arquivo da pasta em `backup/arquivo-antes-de-substituir-*.json` (alterações de outros PCs ficam recuperáveis).
- O `estoque.json` antigo é convertido automaticamente para o novo formato; uma cópia do arquivo antigo fica em
  `backup/estoque-schema1-antes-da-migracao-*.json`.
- Cada computador guarda por 90 dias as operações que ele já confirmou. Se o arquivo da pasta "voltar no tempo"
  (conflito do OneDrive, cópia antiga restaurada, versão antiga da aplicação gravando o formato antigo), elas são
  reaplicadas, com aviso em **Dados e backup** e cópia do arquivo lido em `backup/`. Cópias de conflito do OneDrive
  (`estoque-NOMEDOPC.json`) são apontadas ali, mas nunca mescladas sozinhas.
- Arquivo de dados inválido (estrutura, saldos, tipos) é recusado antes de ser usado: os dados do computador são mantidos.
- Só uma aba/janela da aplicação por navegador; a segunda mostra um aviso e não altera nada.
- Com a aba visível, a aplicação busca as alterações dos outros computadores a cada 5 minutos e ao voltar para a aba.

## Uso diário

| Tarefa | Onde |
|---|---|
| Entregar item | **Nova entrega**, ou busque a série e tecle Enter |
| Devolução (inclusive "voltou com defeito") | **Devolução** |
| Cadastrar itens em sequência | **+ Novo item → Cadastrar e lançar outro** |
| Entrada / ajuste por contagem / manutenção / descarte | botão da linha ou menu **⋯** |
| Corrigir texto (categoria, descrição, série, patrimônio, posição) | dois cliques na célula |
| Alterar vários itens de uma vez (categoria, posição…) | marque as linhas (Shift+clique = intervalo) → **Editar em lote** |
| Marcar vários descartes (ex.: "Dados apagados: Não se aplica") | tela **Descarte** → marque as linhas → **Editar em lote** |
| Excluir item ou toner (vai para a Lixeira) | menu **⋯ → Excluir…** |
| Consultar ou recuperar excluídos | aba **Lixeira → Restaurar** |
| Preencher a cor dos toners já importados | **Dados e backup → Atualizar cores dos toners pela planilha…** |
| Cadastrar colaborador ou setor que recebe itens | aba **Pessoas → + Nova pessoa** (ou **+ Cadastrar nova pessoa** dentro da entrega/devolução) |
| Aproveitar os nomes já digitados nas entregas antigas | **Pessoas → Vincular nomes antigos…** (você decide, grupo a grupo; nada é criado sozinho) |
| Ver com quem está cada item / preparar inventário por colaborador | **Pessoas → número na coluna "Itens com a pessoa"** → **Exportar lista (.xlsx)** |
| Ver tudo o que aconteceu com um item | menu **⋯ → Histórico** |
| Planilha para backup | **Dados e backup → Baixar planilha (.xlsx)** |

Atalho: `/` vai para a busca.

## Regras

- O saldo só muda por movimentação (entrada, entrega, devolução, ajuste, descarte). Tudo fica no histórico.
- Nº de série é único.
- Toner: só os **novos** contam como estoque.
- Pessoas: "Entregue para" e "Devolvido por" escolhem um cadastro. Pessoa inativa não recebe novas entregas, mas pode devolver; cadastro com histórico nunca é apagado, só desativado. E-mail é único.
- Colaboradores não acessam a aplicação (são só cadastro). O modelo já guarda `origem` e `entraId` para a futura ligação com o diretório Microsoft (Entra ID).
- Itens por quantidade "com a pessoa" = entregues a ela menos o que voltou registrado no nome dela.
- Saldo mínimo / solicitar compra: fora do MVP (o campo existe e foi preservado, vazio).

## Arquivos

```
index.html            tela
css/app.css           estilos (identidade visual Solar)
css/marca.css         grafismo orbital no topo
img/                  logo e grafismo originais da marca (sem alteração)
js/                   util, ledger (regras), importer, exporter, ui-*
js/sync.js            operações, lista branca, fila, rebase e conflitos
js/remoto.js          armazenamento remoto: pasta (padrão), memória (testes), SharePoint/Graph (esqueleto)
js/sessao.js          quem está usando (autor das operações)
js/store.js           IndexedDB, pasta escolhida e ligação com a sincronização
vendor/xlsx.full.min.js   SheetJS 0.20.3 (SHA-256 cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41)
test/                 testes: node test/testes.js, testes-lote.js, testes-sync.js, testes-pessoas.js e testes-revisao.js
                      (poc-revisao.js: provas de conceito da revisão; deve reportar 0 reproduzidos)
```

## Segurança e LGPD

- Os arquivos de dados e backups contêm nomes de colaboradores: mantenha-os só em pastas com acesso restrito à TI.
- Cada movimentação registra o nome de quem a fez (e, com login Microsoft, o e-mail): também é dado pessoal.
- O cadastro de pessoas guarda nome, e-mail e departamento (dados pessoais, LGPD): cadastre só o necessário e desative quem saiu da empresa. As planilhas exportadas (backup e "itens com a pessoa") também os contêm.
- Nenhum dado sai da máquina: não há chamadas de rede; a biblioteca de planilhas é local.

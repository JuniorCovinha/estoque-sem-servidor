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
| Preencher a cor dos toners já importados | **Dados e backup → Atualizar cores dos toners pela planilha…** |
| Ver tudo o que aconteceu com um item | menu **⋯ → Histórico** |
| Planilha para backup | **Dados e backup → Baixar planilha (.xlsx)** |

Atalho: `/` vai para a busca.

## Regras

- O saldo só muda por movimentação (entrada, entrega, devolução, ajuste, descarte). Tudo fica no histórico.
- Nº de série é único.
- Toner: só os **novos** contam como estoque.
- Saldo mínimo / solicitar compra: fora do MVP (o campo existe e foi preservado, vazio).

## Arquivos

```
index.html            tela
css/app.css           estilos (identidade visual Solar)
css/marca.css         grafismo orbital no topo
img/                  logo e grafismo originais da marca (sem alteração)
js/                   util, ledger (regras), importer, exporter, store (gravação), ui-*
vendor/xlsx.full.min.js   SheetJS 0.20.3 (SHA-256 cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41)
test/                 testes: node test/testes.js e node test/testes-lote.js
```

## Segurança e LGPD

- Os arquivos de dados e backups contêm nomes de colaboradores: mantenha-os só em pastas com acesso restrito à TI.
- Nenhum dado sai da máquina: não há chamadas de rede; a biblioteca de planilhas é local.

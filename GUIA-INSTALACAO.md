# Estoque TI — guia de instalação na pasta do SharePoint

Para a equipe de Infraestrutura. O aplicativo roda no Google Chrome (ou Microsoft Edge) de cada computador e
usa uma pasta do SharePoint, sincronizada pelo OneDrive, para guardar e compartilhar os dados.
Não há servidor nem instalação de programa.

## 1. Estrutura da pasta (uma vez)

Crie uma **subpasta restrita** no SharePoint, por exemplo `Estoque TI`, com esta estrutura:

```
Estoque TI\
  app\      aplicativo (index.html, css, js, img, vendor, "Abrir Estoque TI.cmd", ...)
  dados\    estoque.json, estoque-consulta.xlsx e backup\   (criados pelo aplicativo)
```

**Permissões** (Configurações da pasta → Gerenciar acesso → parar de herdar permissões):

| Quem | Permissão |
|---|---|
| Quem lança no estoque (até 3 pessoas da Infra) | **Editar** |
| Quem só consulta | **Ler** |
| Demais colaboradores | **Sem acesso** |

- A pasta contém nome, e-mail e equipamentos de colaboradores (dados pessoais — LGPD): não deixe aberta para a empresa toda.
- Deixe o **controle de versão** da biblioteca ativado (padrão do SharePoint): ele guarda as versões anteriores do `estoque.json`.
- Opcional: só quem atualiza o aplicativo precisa de **Editar** em `app\`.

Copie o conteúdo do pacote do aplicativo para `app\`. A pasta `dados\` pode começar vazia: o primeiro
computador que escolher a pasta grava o `estoque.json` (ver item 3).

## 2. Em cada computador

1. No SharePoint, abra a pasta `Estoque TI` e clique em **Sincronizar** (ou **Adicionar atalho a Meus arquivos**).
   Ela aparece no Explorador de Arquivos, dentro da área do OneDrive da empresa.
2. No Explorador, clique com o botão direito em `Estoque TI` → **Sempre manter neste dispositivo**
   (o aplicativo precisa dos arquivos disponíveis, inclusive sem internet).
3. Dê dois cliques em `app\Criar atalho na area de trabalho.cmd`. Ele cria o atalho **Estoque TI** na área de trabalho.
   (Se o Windows avisar "O Windows protegeu o computador": **Mais informações → Executar assim mesmo**.)
4. Abra pelo atalho e vá em **Dados e backup**:
   - **Quem está usando este computador**: informe o nome (aparece como autor das alterações).
   - **Computador só de consulta?** Marque **"Este computador é só para consulta"** ANTES de escolher a pasta.
   - **Escolher pasta…** → selecione `Estoque TI\dados` → permita o acesso (de preferência **"Permitir em todas as visitas"**).
5. Pronto. O topo mostra "Sincronizado às HH:MM".

Ao abrir em outro dia, o Chrome pode pedir **Reconectar** a pasta (um clique no topo).

## 3. Primeira carga dos dados

Quem já usa o aplicativo com os dados atuais (o administrador) faz, no próprio computador, o item 2 e escolhe
`Estoque TI\dados`. Como a pasta está vazia, os dados do navegador dele são gravados lá. Depois disso os
demais computadores recebem tudo ao escolher a mesma pasta.

## 4. Como os dados circulam

- Cada alteração é gravada no `estoque.json` e o OneDrive envia para o SharePoint e para os outros computadores.
- O aplicativo busca as novidades a cada 5 minutos e sempre que a janela volta a ficar ativa.
- Se dois computadores lançarem quase ao mesmo tempo, o aplicativo reaplica os lançamentos sobre a versão
  mais nova, com as mesmas regras. O que não fizer mais sentido (ex.: o mesmo notebook entregue duas vezes)
  vai para **Dados e backup → Sincronização → Conflitos para revisar**. Nada é descartado sozinho.
- Sem internet, dá para continuar lançando: as alterações ficam guardadas e são enviadas depois.

## 5. Planilha de consulta

O aplicativo mantém em `dados\` a planilha **`estoque-consulta.xlsx`** (abas LEIA-ME, Estoque, Movimentações,
Descarte, Toner, Pessoas, Lixeira), atualizada pelo computador que fez a última alteração (no máximo a cada
2 minutos). Pode ser aberta no Excel ou no próprio SharePoint.

**Não edite essa planilha**: o que for alterado nela não volta para o aplicativo e é substituído na próxima atualização.

## 6. Modo consulta

- Quem marcou "só consulta" vê o aplicativo sem botões de alteração (busca, filtros, histórico e exportações continuam).
- Se a pasta não aceitar gravação (permissão só de leitura), o aplicativo também entra em consulta sozinho.
  Atenção: numa pasta do OneDrive só de leitura, às vezes o Windows aceita a gravação no computador e só
  falha ao enviar — por isso marque a opção "só consulta" na instalação de quem não lança.

## 7. Atualizar o aplicativo

1. Substitua os arquivos de `app\` pela versão nova (o OneDrive leva aos computadores).
2. Cada usuário fecha e abre o aplicativo (ou aperta F5).
3. Um computador que ainda estiver com a versão antiga aberta é avisado
   ("Este computador está com uma versão antiga do aplicativo…") e fica em consulta até recarregar.

Para quem desenvolve: a cada versão publicada, aumente `VERSAO_APP` em `js/sync.js`.

## 8. Avisos que podem aparecer

| Aviso | O que fazer |
|---|---|
| **Reconectar** no topo | Clique e permita o acesso à pasta. |
| **Conflitos para revisar** | Em Dados e backup, veja cada um e escolha "Tentar de novo" ou "Descartar". |
| **Cópias de conflito na pasta** (`estoque-NOMEDOPC.json`) | O OneDrive criou uma cópia porque dois computadores gravaram ao mesmo tempo. Confira com quem lançou; os lançamentos de cada computador são reaplicados quando ele sincronizar. Depois de conferir, mova a cópia para `backup\`. |
| **O arquivo da pasta voltou para uma versão anterior** | O aplicativo já reaplicou os lançamentos deste computador; o arquivo lido foi guardado em `backup\`. |
| **Versão antiga do aplicativo** | Feche e abra o aplicativo pelo atalho (que aponta para `app\`). |
| **Planilha aberta no Excel** | Feche a planilha de consulta no Excel; ela é atualizada na próxima alteração. |
| **A aplicação já está aberta em outra aba** | Use a aba que já está aberta (só uma por navegador). |

## 9. Backup e recuperação

- `dados\backup\` recebe uma cópia diária automática (`.json` + `.xlsx`) e uma cópia antes de importar,
  restaurar, esvaziar a Lixeira etc.
- Para voltar a uma versão: **Dados e backup → Restaurar backup (.json)**, ou o histórico de versões do SharePoint.

## 10. Limites conhecidos

- A pasta do OneDrive não tem trava entre computadores: com até 3 pessoas lançando funciona bem, mas dois
  lançamentos no mesmo segundo podem gerar uma cópia de conflito (ver item 8).
- Sem o login Microsoft, o autor das alterações é o nome informado em cada computador; o SharePoint registra,
  no histórico de versões, a conta que gravou cada versão do arquivo.
- Próxima etapa (quando houver o registro do aplicativo no Entra ID): gravação direta no SharePoint pela API
  da Microsoft, com trava real e login da empresa.

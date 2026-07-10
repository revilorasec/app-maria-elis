# App Maria Elis — PWA com OneDrive

Este é um aplicativo HTML5/PWA estático, responsivo e sem backend próprio. Ele usa login Microsoft (MSAL) e Microsoft Graph para guardar os dados privados diretamente em uma pasta do OneDrive.

Não usa Azure Functions, Blob Storage, banco externo, Key Vault, API própria, servidor de aplicação ou assinatura Azure para banco/backend.

## Onde os dados ficam

Após o login, o app cria ou usa esta estrutura na pasta configurada do OneDrive (padrão: `(APP MARIA ELIS)`):

```text
(APP MARIA ELIS)/
├─ dados.json
├─ Backup/
│  └─ dados_YYYY-MM-DD.json
├─ Fotos/
│  └─ YYYY/MM/YYYY-MM-DD_HH-MM-SS_tipo.jpg
├─ Anexos/
└─ Config/
```

`dados.json` contém perfil da criança, usuários autorizados, orientações, tarefas, registros do dia, alimentação, sono, fraldas, banho, medicamentos, sintomas, observações, documentos, caminhos de fotos e metadados de backup. Fotos e documentos ficam como arquivos privados no OneDrive; o JSON guarda apenas o caminho e o status de sincronização.

## Como funciona

1. Na primeira abertura, informe o **Application (client) ID**, o **Directory (tenant) ID** e o nome da pasta do OneDrive.
2. Entre com a conta Microsoft.
3. O app localiza/cria a pasta, cria as subpastas e carrega `dados.json`.
4. Se ainda não houver `dados.json`, grava uma estrutura inicial fictícia e torna a primeira conta real o administrador.
5. Cada alteração grava o JSON no OneDrive. Antes da primeira gravação do dia, o app faz uma cópia em `Backup/`.
6. Fotos são redimensionadas no celular e enviadas para `Fotos/AAAA/MM/`. Se o envio falhar, o registro permanece no aparelho e entra em uma fila de reenvio.

## Configurar o Microsoft Entra

Você não cria recursos Azure pagos. É necessário apenas ter permissão para registrar um aplicativo no Microsoft Entra da organização/conta que possui o OneDrive.

1. Abra o [Microsoft Entra admin center](https://entra.microsoft.com/) e vá em **Applications > App registrations > New registration**.
2. Dê um nome, por exemplo `App Maria Elis`.
3. Para uso no OneDrive corporativo, escolha as contas do diretório da organização. Anote o **Application (client) ID** e o **Directory (tenant) ID** exibidos em *Overview*.
4. Em **Authentication > Add a platform**, escolha **Single-page application (SPA)**.
5. Cadastre a URL final do site, por exemplo `https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/`. Para teste local, cadastre também `http://localhost:8080/` se estiver usando esse endereço.
6. Em **API permissions > Microsoft Graph > Delegated permissions**, adicione `User.Read` e `Files.ReadWrite`. O app pede somente acesso aos arquivos da pessoa conectada. Se a política da empresa exigir aprovação, peça o consentimento ao administrador.
7. Não crie **client secret**. Uma SPA não deve ter segredo embutido no navegador.

A URI de redirecionamento precisa corresponder exatamente à URL que aparece no navegador; caso contrário o login retorna `AADSTS50011`. A Microsoft classifica apps JavaScript como SPA e explica essa exigência nas páginas de [configuração de redirect URI](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri) e [limitações de redirect URI](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url). `Files.ReadWrite` delegado permite ler, criar, alterar e apagar os arquivos da pessoa conectada; é mais restrito do que `Files.ReadWrite.All`. Consulte a [referência de permissões do Graph](https://learn.microsoft.com/en-us/graph/permissions-reference).

## Preparar o OneDrive e os usuários

1. Entre no OneDrive da conta proprietária e crie `(APP MARIA ELIS)`.
2. Abra o app, salve a configuração e entre com essa conta. Ele criará `dados.json`, `Backup`, `Fotos`, `Anexos` e `Config`.
3. Para usar contas diferentes (por exemplo, responsáveis e babá), compartilhe essa pasta apenas com as contas autorizadas, com a permissão apropriada.
4. Cada pessoa convidada deve adicionar um **atalho da pasta compartilhada em Meus arquivos** antes de abrir o app; assim a mesma pasta aparece na raiz do OneDrive dela. Sem esse atalho, o app pode criar uma pasta de mesmo nome separada.
5. Depois do primeiro acesso, cadastre no `dados.json` os e-mails das pessoas autorizadas e seus papéis (`admin`, `guardian`, `caregiver` ou `visitor`). A proteção real é a permissão da pasta no OneDrive; os papéis controlam a interface do app.

Para a configuração mais simples, use sempre a mesma conta Microsoft da família no app. Para uma equipe, use a pasta compartilhada acima e valide o acesso com cada conta antes de cadastrar dados reais.

## Publicar como site estático

O guia literal está em [GUIA_PUBLICAR_GITHUB_ONEDRIVE.md](GUIA_PUBLICAR_GITHUB_ONEDRIVE.md). Em resumo, envie somente o código estático ao GitHub e publique com GitHub Pages, Netlify, Vercel ou outro host estático. GitHub Pages pode publicar de uma branch; veja a [documentação oficial](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

## Backup e restauração

- **Automático:** antes da primeira gravação diária, o conteúdo anterior de `dados.json` é salvo como `Backup/dados_YYYY-MM-DD.json`.
- **Manual:** em Configurações, use **Baixar** para uma cópia local e **Sincronizar** para reenviar alterações/fotos pendentes.
- **Restaurar:** em Configurações, clique em **Restaurar** e informe, por exemplo, `Backup/dados_2026-07-10.json`. O app copia esse JSON de volta para `dados.json`.

## Estrutura do projeto

```text
index.html
manifest.json
service-worker.js
assets/
  css/styles.css
  js/app.js
  js/auth.js
  js/graph.js
  js/storage.js
  js/photos.js
  js/ui.js
  icons/
data/data.sample.json
```

## Nunca enviar ao GitHub

O `.gitignore` bloqueia `dados.json`, `Backup/`, `Fotos/`, `Anexos/`, `Config/`, `dados_privados_origem/`, documentos, planilhas e arquivos `.env`.

Antes de cada envio, confira `git status`. Não suba dados reais da criança, fotos, documentos, comprovantes, senhas, token, client secret ou cópia do OneDrive. O **client ID não é segredo**, mas o client secret nunca deve ser criado nem colocado no projeto.
# Passo a passo: GitHub + OneDrive (sem backend e sem assinatura Azure)

Siga esta ordem. Você não precisa criar Azure Functions, Blob Storage, banco de dados, Key Vault ou uma assinatura Azure para hospedar o app.

## Parte 1 — preparar os arquivos

1. Abra a pasta `C:\Codex\Maria_Elis`.
2. Confira se os arquivos de código existem: `index.html`, `manifest.json`, `service-worker.js`, `assets/` e `data/data.sample.json`.
3. Não mova para esta pasta nenhuma foto, certidão, planilha, PDF ou `dados.json` real.
4. Se estiver usando Git no computador, execute `git status` e confirme que `dados_privados_origem/`, fotos e arquivos privados não aparecem na lista para envio.

## Parte 2 — criar o repositório no GitHub

1. Entre em [github.com](https://github.com/) e clique em **New repository**.
2. Nome sugerido: `app-maria-elis`.
3. Se puder, marque **Private**.
4. Não adicione README pelo GitHub, pois o projeto já possui um.
5. Clique em **Create repository**.
6. Envie a pasta do projeto com GitHub Desktop, VS Code ou pelo botão **Add file > Upload files**. Envie o código: `index.html`, `manifest.json`, `service-worker.js`, `assets/`, `data/`, `README.md`, `SECURITY.md` e os guias.
7. Antes de confirmar, confira novamente que não há `dados.json`, fotos, documentos nem `dados_privados_origem/` selecionados.

## Parte 3 — publicar no GitHub Pages

1. Dentro do repositório, abra **Settings > Pages**.
2. Em **Build and deployment**, escolha **Deploy from a branch**.
3. Escolha a branch `main` e a pasta `/(root)`.
4. Clique em **Save**.
5. Aguarde o GitHub mostrar a URL publicada, semelhante a `https://SEU-USUARIO.github.io/app-maria-elis/`.
6. Copie essa URL exatamente, incluindo a barra final.

Se Pages não estiver disponível para um repositório privado no seu plano, mantenha o repositório privado e publique a mesma pasta estática no Netlify ou Vercel. A arquitetura do app não muda.

## Parte 4 — registrar o login Microsoft

1. Abra [entra.microsoft.com](https://entra.microsoft.com/).
2. Vá em **Applications > App registrations > New registration**.
3. Crie o aplicativo `App Maria Elis`.
4. Em **Authentication**, clique em **Add a platform** e escolha **Single-page application (SPA)**.
5. Cole a URL do GitHub Pages copiada na parte anterior. Exemplo: `https://SEU-USUARIO.github.io/app-maria-elis/`.
6. Em **API permissions**, adicione as permissões delegadas do Microsoft Graph: `User.Read` e `Files.ReadWrite`.
7. Em **Overview**, copie o **Application (client) ID** e o **Directory (tenant) ID**.
8. Não crie client secret. O app não usa e não deve usar segredo no navegador.

Se o portal informar que é necessária aprovação, peça ao administrador do Microsoft 365/Entra para conceder consentimento às duas permissões. Isso não cria serviços Azure pagos.

## Parte 5 — preparar o OneDrive

1. Entre no OneDrive da conta que será dona dos dados.
2. Crie uma pasta chamada exatamente `(APP MARIA ELIS)`.
3. Se outras pessoas forem usar suas próprias contas, compartilhe essa pasta somente com elas.
4. Peça que cada pessoa convidada abra a pasta compartilhada no OneDrive e use **Adicionar atalho a Meus arquivos**.

## Parte 6 — configurar e testar o app

1. Abra a URL do GitHub Pages no celular ou computador.
2. Na configuração inicial, cole o **Client ID**, o **Tenant ID** e informe `(APP MARIA ELIS)`.
3. Clique em **Salvar e entrar com Microsoft**.
4. Entre com a conta que possui (ou recebeu o atalho de) `(APP MARIA ELIS)`.
5. Verifique no OneDrive se foram criados `dados.json`, `Backup/`, `Fotos/`, `Anexos/` e `Config/`.
6. Faça um registro e uma foto de teste. Confira se a foto aparece em `Fotos/AAAA/MM/`.
7. Na tela **Configurações**, confirme o estado **Sincronizado**.

## Quando algo der errado

- **AADSTS50011:** a URL do navegador não está cadastrada exatamente como Redirect URI. Copie a URL publicada de novo e salve em **Authentication > SPA**.
- **Não encontra a pasta compartilhada:** adicione o atalho dela em **Meus arquivos** e entre novamente.
- **Foto pendente:** conecte à internet e toque em **Sincronizar** em Configurações.
- **Acesso negado no Graph:** confira se `User.Read` e `Files.ReadWrite` foram adicionadas como permissões delegadas e se a conta tem acesso à pasta.
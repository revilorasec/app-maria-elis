# Decisão de arquitetura — App Maria Elis

A referência de RH já demonstra a solução adequada para este caso: um app estático que autentica com MSAL e grava arquivos diretamente no OneDrive por Microsoft Graph.

## Arquitetura escolhida

```text
Navegador/PWA estático
  ├─ MSAL: login Microsoft
  ├─ Microsoft Graph: leitura e gravação
  └─ OneDrive: dados.json, Backup, Fotos, Anexos e Config
```

Não há Azure Functions, Blob Storage, banco externo, Key Vault, API própria nem backend obrigatório.

## Motivos

- A família precisa de um fluxo simples de publicar e manter.
- Fotos, documentos e JSON já podem ficar no OneDrive privado da conta Microsoft.
- O PWA pode ser hospedado em qualquer servidor estático.
- O backup diário é apenas mais um arquivo JSON no OneDrive.

## Controles importantes

- Usar Microsoft Graph com permissões delegadas `User.Read` e `Files.ReadWrite`.
- Usar uma única pasta compartilhada `(APP MARIA ELIS)` e adicionar seu atalho em Meus arquivos para cada conta autorizada.
- Tratar papéis no JSON como organização de interface; o controle de acesso aos arquivos é o compartilhamento do OneDrive.
- Não enviar dados reais ou anexos ao GitHub.
- Manter fotos pendentes em fila local e sincronizá-las quando a internet voltar.

## Publicação

GitHub Pages, Netlify, Vercel ou outro host estático são suficientes. O único cadastro externo necessário é o App Registration no Microsoft Entra para permitir o login e a chamada ao Microsoft Graph.
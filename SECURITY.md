# Segurança e privacidade

Este app é uma SPA estática. Não existe servidor próprio: o navegador faz login com MSAL e conversa com o Microsoft Graph em nome da conta conectada.

## Regras obrigatórias

- Não criar nem colocar `client secret`, senha, token ou certificado no código, no GitHub ou em `.env`.
- Não publicar `dados.json`, fotos, documentos, PDFs, planilhas ou a pasta `dados_privados_origem/`.
- Deixar o repositório privado sempre que possível. Caso seja público, confirme que ele contém apenas código e dados fictícios.
- Conceder acesso à pasta `(APP MARIA ELIS)` somente às contas autorizadas. A permissão do OneDrive é a barreira de acesso aos arquivos.
- Usar `User.Read` e `Files.ReadWrite` delegados. Não ampliar para `Files.ReadWrite.All` sem uma necessidade comprovada e revisão do administrador.
- Revisar periodicamente quem tem acesso à pasta compartilhada e remover contas que não devem mais ver os dados.

## Limites do modelo simples

Os papéis exibidos na interface (`admin`, `guardian`, `caregiver`, `visitor`) ajudam a organizar as telas, mas não substituem controle de acesso no servidor. A confidencialidade prática vem da conta Microsoft autenticada e da lista de compartilhamento da pasta no OneDrive.

Para pessoas usando contas distintas, compartilhe uma única pasta e peça que todas adicionem o atalho em **Meus arquivos**. Não deixe cada pessoa criar uma pasta separada de mesmo nome.

## Dispositivos e cópias locais

- O app guarda uma cópia local de segurança e uma fila de fotos pendentes para resistir à falta de conexão. Proteja o celular/computador com senha e remova o acesso ao navegador em dispositivos compartilhados.
- O cache local não é um backup definitivo. Confirme o estado **Sincronizado** e mantenha os backups do OneDrive.
- Em caso de perda de aparelho, revogue a sessão Microsoft, revise o compartilhamento da pasta e altere a senha conforme a política da conta.

## Saúde

O app é um organizador de registros. Não interpreta resultados, não prescreve tratamento e não substitui orientação profissional ou atendimento de emergência.
# Schema de dados no OneDrive

`dados.json` é o banco principal do app. Ele fica na pasta `(APP MARIA ELIS)` no OneDrive e contém somente registros, relações, permissões, estados de sincronização e caminhos de arquivos.

## Versão e inicialização

O schema atual é a versão 2, indicada por `meta.schemaVersion`. A função `migrateSchemaV2(data)`, em `assets/js/schemaMigration.js`, é idempotente: pode ser executada novamente sem duplicar pessoas ou vínculos.

`meta.bootstrapCompleted` informa se o primeiro administrador real já foi criado. Registros marcados como demonstração não concluem o bootstrap.

## Coleções principais

| Coleção | Finalidade |
| --- | --- |
| `childProfile` | Perfil e informações essenciais da criança. |
| `people` | Cadastro unificado de família, cuidadores, profissionais, escola e contatos. |
| `caregiverProfiles` | Dados operacionais não sensíveis de cuidadores. |
| `users` | Contas Microsoft autorizadas, papel e concessões básicas. |
| `accessGrants` | Concessões adicionais vinculadas a pessoa ou usuário. |
| `trash` | Registros removidos, seus vínculos e a data de expiração em 30 dias. |
| `documents` | Metadados e caminhos de documentos. |
| `vaccines` | Vacinas, doses, lotes e caminhos dos comprovantes. |
| `appointments` | Consultas e orientações. |
| `growthRecords` | Medições de crescimento. |
| `dailyInstructions` | Instruções do dia. |
| `dailyTasks` | Afazeres e confirmação de execução. |
| `dailyLogs` | Observações livres. |
| `dailyPhotos` | Metadados e caminhos das fotos. |
| `medications` | Medicamentos e orientações. |
| `auditLog` | Registro técnico resumido das alterações. |
| `emergencyContacts`, `doctors` | Coleções legadas mantidas durante a transição. |

## Pessoa: `people[]`

Exemplo estrutural, sem dados reais:

```json
{
  "id": "person-...",
  "entityKind": "person",
  "primaryType": "guardian",
  "types": ["guardian"],
  "fullName": "",
  "relationship": "",
  "photoPath": "Anexos/Pessoas/.../foto.jpg",
  "photoUrl": "",
  "phone": "",
  "whatsapp": "",
  "email": "",
  "address": {
    "formatted": "",
    "latitude": null,
    "longitude": null
  },
  "priority": null,
  "notes": "",
  "active": true,
  "relatedPersonIds": [],
  "documentIds": [],
  "permissions": [],
  "timestamps": {
    "createdAt": null,
    "updatedAt": null
  }
}
```

Tipos previstos incluem `mother`, `father`, `grandmother`, `grandfather`, `relative`, `babysitter`, `caregiver`, `pediatrician`, `doctor`, `specialist`, `therapist`, `school`, `emergency-contact`, `pickup-authorized`, `pickup-denied`, `guardian`, `grandparent`, `visitor`, `contact` e `other`.

## Perfil compartilhado do cuidador: `caregiverProfiles[]`

Este perfil guarda somente o necessário para o uso operacional:

```json
{
  "id": "caregiver-profile-...",
  "personId": "person-...",
  "userId": "user-...",
  "status": "active",
  "startDate": "",
  "function": "",
  "workSchedule": [],
  "experience": "",
  "courses": [],
  "firstAidTraining": { "completed": false },
  "completedSteps": [],
  "onboardingCompletedAt": null
}
```

CPF, RG, data de nascimento, salário, referências profissionais, contato pessoal de emergência, data de desligamento e documentos trabalhistas não pertencem ao `dados.json` compartilhado.

## Área administrativa separada

Dados pessoais, financeiros e trabalhistas do cuidador ficam em:

```text
(APP MARIA ELIS - ADMIN)/
  dados_admin.json
  Documentos/
  Config/
```

Essa pasta é localizada ou criada somente pela conta `admin` e nunca deve ser compartilhada com cuidador, visitante ou outros usuários da pasta principal. Registros privados legados são copiados para `dados_admin.json` antes de serem removidos do JSON comum. A exclusão de um cuidador agenda também a remoção administrativa para a mesma data de expiração da lixeira.

## Migração e vínculos

- `emergencyContacts` gera ou vincula pessoa do tipo `emergency-contact`.
- `doctors` usa `pediatrician` para pediatria/neonatologia e `doctor` nos demais casos.
- `users` recebe `personId` e pode gerar um único `caregiverProfile`.
- A vinculação procura `personId`, origem e ID legado, e-mail e, somente quando ambos existem, nome mais telefone. Nome isolado não une pessoas homônimas.
- `people`, `caregiverProfiles`, `accessGrants` e `trash` sempre existem como arrays.

## Arquivos, fotos e fila local

- Fotos: `Fotos/AAAA/MM/AAAA-MM-DD_HH-MM-SS_tipo.jpg`.
- Documentos comuns: `Anexos/AAAA/MM/AAAA-MM-DD_HH-MM-SS_nome.ext`.
- Documentos administrativos: `(APP MARIA ELIS - ADMIN)/Documentos/Cuidadores/...`.
- Backups: `Backup/dados_AAAA-MM-DD.json`.
- `filePath`, `photoPath` e `avatarPath` apontam para arquivos autenticados; não existem links públicos permanentes.
- Imagens sincronizadas são carregadas do OneDrive por sessão autenticada. O JSON não guarda a foto ou miniatura em Base64.
- Enquanto uma foto aguarda envio, o arquivo fica no IndexedDB local; `dados.json` guarda apenas o estado `pending`.

## Cache, conflito e integridade

O cache local usa conta Microsoft + `driveId:itemId`. O envelope registra o ETag base do `dados.json`. Uma fila pendente só é reenviada automaticamente quando o OneDrive continua na mesma versão. Se o arquivo remoto mudou, o app bloqueia a sobrescrita e oferece baixar a cópia local antes de usar a versão do OneDrive.

Gravações usam `If-Match`; um ETag divergente produz conflito em vez de substituir alterações de outra pessoa.

## Permissões

Papéis disponíveis: `admin`, `guardian`, `caregiver`, `grandparent`, `visitor` e `custom`. Concessões personalizadas complementam o papel.

As permissões da interface não substituem a proteção física do OneDrive. Quem recebe edição na pasta principal pode abrir o `dados.json` diretamente; por isso os campos administrativos ficam em uma pasta separada e não compartilhada.
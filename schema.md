# Schema de dados no OneDrive

`dados.json` é o banco principal do app. Ele é um JSON privado salvo em `(APP MARIA ELIS)` no OneDrive da família/organização.

## Campos principais

| Coleção | Campos relevantes |
| --- | --- |
| `childProfile` | `id`, `name`, `birthDate`, `photoUrl`, `healthPlan`, `bloodType`, `allergies`, `criticalNotes` |
| `users` | `id`, `name`, `email`, `phone`, `role`, `active`, `createdAt` |
| `dailyInstructions` | `id`, `date`, `title`, `description`, `status`, `notes` |
| `dailyTasks` | `id`, `instructionId`, `date`, `title`, `category`, `scheduledTime`, `description`, `priority`, `requiresPhoto`, `status`, `completedBy`, `completedAt`, `comments` |
| `dailyLogs` | `id`, `date`, `time`, `type`, `description`, `mood`, `symptoms`, `isImportant`, `createdBy`, `createdAt` |
| `dailyPhotos` | `id`, `taskId`, `date`, `category`, `filePath`, `fileName`, `thumbnailUrl`, `caption`, `uploadedBy`, `uploadedAt`, `syncStatus` |
| `documents` | `id`, `title`, `category`, `description`, `filePath`, `fileName`, `expirationDate`, `sensitivity` |
| `vaccines` | `id`, `name`, `dose`, `expectedDate`, `appliedDate`, `location`, `batch`, `status`, `proofFilePath`, `notes` |
| `appointments` | `id`, `specialty`, `doctorName`, `date`, `time`, `reason`, `medicalGuidance`, `prescriptionFilePath`, `examFilePath`, `status` |
| `medications` | `id`, `name`, `dosage`, `schedule`, `frequency`, `status`, `notes` |
| `emergencyContacts` | `id`, `name`, `relationship`, `phone`, `whatsapp`, `priority`, `notes` |
| `auditLog` | `id`, `userId`, `action`, `entityType`, `entityId`, `createdAt` |

## Anexos e sincronização

- Fotos: `Fotos/AAAA/MM/AAAA-MM-DD_HH-MM-SS_tipo.jpg`.
- Documentos: `Anexos/AAAA/MM/AAAA-MM-DD_HH-MM-SS_nome.ext`.
- Backup: `Backup/dados_YYYY-MM-DD.json`.
- `syncStatus` de foto: `pending`, `synced` ou `local-only`.
- `filePath` é relativo à pasta `(APP MARIA ELIS)` e não contém link público.

## Permissões e integridade

Os papéis `admin`, `guardian`, `caregiver` e `visitor` organizam a interface. O acesso efetivo aos arquivos é controlado pela conta Microsoft autenticada e pelo compartilhamento da pasta do OneDrive. O app usa ETag no `dados.json` para detectar conflito de edição simultânea.
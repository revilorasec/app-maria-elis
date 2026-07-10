# Migração de dados antigos

A migração continua usando somente `dados.json`, `Fotos/`, `Anexos/` e o OneDrive. Ela não envia nada ao GitHub nem usa backend.

## O que já está organizado localmente

A pasta privada `dados_privados_origem/` contém documentos, exames, comprovantes de vacina e cópias da planilha histórica. Ela é ignorada pelo Git.

## Importação pelo app

Em **Mais > Importar dados antigos**, um responsável pode selecionar um pacote JSON privado. O app:

- importa documentos, vacinas, fotos, registros, consultas, crescimento e medicamentos;
- preserva `filePath` já existente no OneDrive;
- ignora itens com o mesmo `id` ou `filePath`;
- registra `bundleId`, data, responsável e relatório em `dados.json`;
- permite rodar novamente sem duplicar o pacote.

## Formato do pacote

Salve o pacote fora do repositório, por exemplo dentro de `dados_privados_origem/`. Ele precisa ter um identificador único:

```json
{
  "bundleId": "migracao-privada-2026-07-10-v1",
  "source": "Eventos_Filha.xlsx e arquivos organizados",
  "warnings": [],
  "documents": [],
  "vaccines": [],
  "dailyPhotos": [],
  "dailyLogs": [],
  "appointments": [],
  "growthRecords": [],
  "medications": []
}
```

Cada foto ou documento deve ter `id`, `filePath`, `fileName` e os campos relacionados ao registro. O `filePath` é relativo à pasta `(APP MARIA ELIS)` no OneDrive.

## Antes de importar arquivos reais

1. Copie fotos e documentos para `Fotos/` ou `Anexos/` no OneDrive, preservando os caminhos do pacote.
2. Faça um backup de `dados.json`.
3. Selecione o pacote na tela de migração.
4. Leia o relatório exibido após o envio.
5. Confira amostras em Documentos, Vacinas, Histórico e Afazeres.

A planilha e os anexos privados não são importados automaticamente no navegador porque ele não tem permissão para ler pastas locais sem seleção explícita. O pacote JSON é a etapa controlada e auditável para evitar envio/duplicação acidental.
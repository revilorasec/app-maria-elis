# Estrutura de anexos privados

Os arquivos originais mantidos para organização local ficam em `dados_privados_origem/` e nunca devem ser publicados ou usados como dados de exemplo.

## Organização local de origem

```text
dados_privados_origem/
├─ documentos/
│  ├─ pessoais/certidoes/
│  ├─ pessoais/declaracoes_nascimento/
│  ├─ escola/
│  └─ outros/
├─ saude/
│  ├─ consultas/
│  ├─ exames/neonatais/
│  ├─ receitas/
│  ├─ laudos/
│  ├─ plano_de_saude/
│  └─ vacinas/comprovantes/AAAA/AAAA-MM-DD/
└─ eventos_diarios/AAAA/AAAA-MM/AAAA-MM-DD/
   ├─ fotos/
   ├─ videos/
   ├─ documentos/
   └─ outros/
```

Use nomes descritivos sem nome completo, CPF, carteirinha, telefone ou dados clínicos. Exemplos: `certidao_nascimento.jpg`, `resultado_teste_do_pezinho.pdf` e `receita_pediatria_2026-07-09.pdf`.

## Estrutura usada pelo app no OneDrive

```text
(APP MARIA ELIS)/
├─ dados.json
├─ Backup/dados_YYYY-MM-DD.json
├─ Fotos/AAAA/MM/AAAA-MM-DD_HH-MM-SS_categoria.jpg
├─ Anexos/AAAA/MM/AAAA-MM-DD_HH-MM-SS_nome-do-arquivo.ext
└─ Config/
```

O `dados.json` guarda apenas o caminho privado (`filePath`), o nome, o tipo e o status de sincronização. A abertura do anexo é feita com o Microsoft Graph pela conta Microsoft já autorizada; não há URL pública permanente, API própria ou backend.
# Changelog

## 0.2.0 - 2026-07-12 — Fase 1

- Removidos os dados fictícios do arquivo inicial e adicionada limpeza global de exemplos.
- Criado cadastro universal de Pessoas, com ações de telefone, WhatsApp, endereço, rota, documentos e permissões.
- Criado assistente de cuidador em cinco etapas, com progresso real e dados sensíveis em pasta administrativa separada.
- Dados da criança passaram a usar Pessoas para pediatra e contatos de emergência; foto com zoom e enquadramento.
- Implementados papéis `admin`, `guardian`, `caregiver`, `grandparent`, `visitor` e `custom`, com concessões adicionais.
- Protegido o administrador principal contra alteração, rebaixamento, desativação e exclusão acidentais.
- Exclusões de Pessoas, afazeres, vacinas e medidas usam lixeira de 30 dias; Pessoas restauram também seus vínculos.
- Corrigidos cadastro, abertura, múltiplos comprovantes, edição e exclusão de vacinas.
- Corrigido CRUD de crescimento sem medidas fictícias.
- Adicionados schema v2 e migração idempotente, incluindo migração de campos privados legados.
- Cache local isolado por conta e item real do OneDrive, com ETag base, fila pendente e tela segura de conflito.
- Fotos sincronizadas passaram a ser carregadas do OneDrive autenticado; o JSON guarda somente caminhos e metadados.
- Service worker atualizado para `maria-onedrive-shell-v15`.

## 0.1.0 - 2026-07-09

- Análise segura das fontes existentes, sem copiar dados reais.
- Primeiro protótipo PWA mobile-first com dados fictícios.
- Serviços modulares preparados para autenticação, armazenamento, permissões, relatórios, gráficos e notificações.
- Documentação inicial de schema, segurança e publicação.
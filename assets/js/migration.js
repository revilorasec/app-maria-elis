const COLLECTIONS = ['documents', 'vaccines', 'dailyPhotos', 'dailyLogs', 'appointments', 'growthRecords', 'medications'];

export function importLegacyBundle(database, bundle, userId) {
  if (!bundle || typeof bundle !== 'object') throw new Error('O arquivo de migração não contém um JSON válido.');
  const bundleId = String(bundle.bundleId || bundle.id || '').trim();
  if (!bundleId) throw new Error('O pacote precisa ter um bundleId para evitar importações duplicadas.');
  database.migrations = Array.isArray(database.migrations) ? database.migrations : [];
  if (database.migrations.some((item) => item.bundleId === bundleId)) {
    return { bundleId, skipped: true, imported: {}, skippedItems: {}, warnings: ['Este pacote já foi importado anteriormente.'] };
  }

  const report = { bundleId, skipped: false, imported: {}, skippedItems: {}, warnings: Array.isArray(bundle.warnings) ? [...bundle.warnings] : [] };
  for (const collection of COLLECTIONS) {
    const incoming = Array.isArray(bundle[collection]) ? bundle[collection] : [];
    if (!Array.isArray(database[collection])) database[collection] = [];
    let imported = 0;
    let skippedItems = 0;
    for (const raw of incoming) {
      if (!raw || typeof raw !== 'object') { skippedItems++; continue; }
      const item = { ...raw, id: raw.id || `${collection}-${crypto.randomUUID()}`, importedAt: new Date().toISOString(), importedBy: userId };
      const duplicate = database[collection].some((current) => current.id === item.id || (item.filePath && current.filePath === item.filePath));
      if (duplicate) { skippedItems++; continue; }
      database[collection].push(item);
      imported++;
    }
    report.imported[collection] = imported;
    report.skippedItems[collection] = skippedItems;
  }

  database.migrations.unshift({ bundleId, source: bundle.source || 'arquivo selecionado', importedAt: new Date().toISOString(), importedBy: userId, report });
  return report;
}

export function migrationReportText(report) {
  const imported = Object.entries(report.imported || {}).filter(([, count]) => count).map(([name, count]) => `${name}: ${count}`).join(', ') || 'nenhum item novo';
  const skipped = Object.entries(report.skippedItems || {}).filter(([, count]) => count).map(([name, count]) => `${name}: ${count}`).join(', ') || 'nenhum';
  return `Importados: ${imported}. Ignorados por duplicidade ou formato: ${skipped}.`;
}
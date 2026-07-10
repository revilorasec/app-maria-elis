export function buildDailyReport(data, date) {
  const tasks = data.dailyTasks.filter((task) => task.date === date);
  const logs = data.dailyLogs.filter((log) => log.date === date);
  const photos = data.dailyPhotos.filter((photo) => photo.date === date);
  const completed = tasks.filter((task) => task.status === 'completed' || task.status === 'late').length;
  return { date, tasks, logs, photos, completed, pending: tasks.length - completed };
}

export function printDailyReport(data, date) {
  const report = buildDailyReport(data, date);
  const rows = report.tasks.map((task) => `<li><strong>${escape(task.title)}</strong> — ${escape(statusLabel(task.status))}${task.completedAt ? ` (${escape(task.completedAt.slice(11, 16))})` : ''}</li>`).join('');
  const logs = report.logs.map((log) => `<li><strong>${escape(log.type)}:</strong> ${escape(log.description)}</li>`).join('') || '<li>Nenhum registro livre.</li>';
  const win = window.open('', '_blank');
  if (!win) return false;
  win.opener = null;
  win.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Resumo do dia</title><style>body{font:16px system-ui;margin:32px;color:#19312d}h1{color:#2f6f66}li{margin:10px 0}.note{color:#63716d}</style></head><body><h1>Resumo do dia — ${escape(formatDate(date))}</h1><p>${report.completed} tarefa(s) concluída(s), ${report.pending} pendente(s) e ${report.photos.length} foto(s) registrada(s).</p><h2>Tarefas</h2><ul>${rows}</ul><h2>Registros</h2><ul>${logs}</ul><p class="note">Resumo gerado pelo app. Use “Salvar como PDF” no diálogo de impressão.</p><script>window.onload=()=>window.print()<\/script></body></html>`);
  win.document.close();
  return true;
}

export function exportBackup(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `copia-local-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function escape(value) {
  return String(value || '').replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
}

function statusLabel(status) {
  return ({ completed: 'concluída', late: 'concluída com atraso', pending: 'pendente', skipped: 'não feita' })[status] || status;
}

function formatDate(date) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full' }).format(new Date(`${date}T12:00:00`));
}
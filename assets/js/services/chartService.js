function escape(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
}

export function lineChart(records, { label, valueKey, formatter = (value) => value }) {
  if (!records.length) return '<p class="muted">Ainda não há dados para este gráfico.</p>';
  const width = 330;
  const height = 170;
  const values = records.map((record) => Number(record[valueKey]));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, index) => {
    const x = 28 + (index * (width - 50)) / Math.max(values.length - 1, 1);
    const y = 128 - ((value - min) / range) * 82;
    return { x, y, value, date: records[index].date };
  });
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const dots = points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="4" fill="#2f6f66"><title>${escape(formatter(point.value))} · ${escape(formatDate(point.date))}</title></circle>`).join('');
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(label)}. Mínimo ${escape(formatter(min))}; máximo ${escape(formatter(max))}.">
    <line x1="28" y1="130" x2="310" y2="130" stroke="currentColor" opacity=".14"/>
    <line x1="28" y1="42" x2="28" y2="130" stroke="currentColor" opacity=".14"/>
    <path d="${path}" fill="none" stroke="#2f6f66" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
    <text x="28" y="151" font-size="11" fill="currentColor" opacity=".65">${escape(formatDate(records[0].date, true))}</text>
    <text x="235" y="151" font-size="11" fill="currentColor" opacity=".65">${escape(formatDate(records.at(-1).date, true))}</text>
    <text x="34" y="34" font-size="11" fill="currentColor" opacity=".7">${escape(formatter(max))}</text>
  </svg>`;
}

export function donutChart({ completed, pending }) {
  const total = completed + pending || 1;
  const completedDash = (completed / total) * 100;
  return `<div class="donut" style="--progress: ${completedDash}" role="img" aria-label="${completed} tarefas concluídas e ${pending} pendentes"><span>${completed}<small>feitas</small></span></div>`;
}

function formatDate(value, short = false) {
  return new Intl.DateTimeFormat('pt-BR', short ? { month: 'short', year: '2-digit' } : { day: '2-digit', month: 'short' }).format(new Date(`${value}T12:00:00`));
}

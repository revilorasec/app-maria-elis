
const digits = (value) => String(value || '').replace(/\D/g, '');

function formatCpf(value) {
  const d = digits(value).slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1-$2');
}

function formatCnpj(value) {
  const d = digits(value).slice(0, 14);
  return d
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\/\d{4})(\d)/, '$1-$2');
}

function formatCep(value) {
  const d = digits(value).slice(0, 8);
  return d.replace(/^(\d{5})(\d)/, '$1-$2');
}

function formatRg(value) {
  const d = digits(value).slice(0, 9);
  if (d.length <= 2) return d;
  if (d.length <= 5) return d.replace(/^(\d{2})(\d+)/, '$1.$2');
  if (d.length <= 8) return d.replace(/^(\d{2})(\d{3})(\d+)/, '$1.$2.$3');
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d)$/, '$1.$2.$3-$4');
}

function formatPhone(value) {
  const d = digits(value).replace(/^55(?=\d{10,11}$)/, '').slice(0, 11);
  if (!d) return '';
  if (d.length <= 2) return '(' + d;
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  if (d.length <= 10) {
    const first = rest.slice(0, 4);
    const last = rest.slice(4, 8);
    return last ? `(${ddd}) ${first}-${last}` : `(${ddd}) ${first}`;
  }
  const ninth = rest.slice(0, 1);
  const middle = rest.slice(1, 5);
  const last = rest.slice(5, 9);
  if (!middle) return `(${ddd}) ${ninth}`;
  return last ? `(${ddd}) ${ninth} ${middle}-${last}` : `(${ddd}) ${ninth} ${middle}`;
}

function normalizeDecimalTyping(value, decimals) {
  let v = String(value ?? '').replace(/\./g, ',').replace(/[^\d,]/g, '');
  const firstComma = v.indexOf(',');
  if (firstComma >= 0) {
    v = v.slice(0, firstComma + 1) + v.slice(firstComma + 1).replace(/,/g, '');
    const [whole, fraction = ''] = v.split(',');
    v = whole + ',' + fraction.slice(0, decimals);
  }
  v = v.replace(/^0+(?=\d)/, '');
  return v;
}

function normalizeDecimalBlur(value, decimals) {
  const v = normalizeDecimalTyping(value, decimals);
  if (!v) return '';
  const [whole = '0', fraction = ''] = v.split(',');
  return whole + ',' + fraction.padEnd(decimals, '0').slice(0, decimals);
}

function inferFormat(input) {
  const explicit = input.dataset.format;
  if (explicit) return explicit;
  const key = `${input.name || ''} ${input.id || ''}`.toLowerCase();
  if (/(^|[_-])cpf($|[_-])|\bcpf\b/.test(key)) return 'cpf';
  if (/(^|[_-])cnpj($|[_-])|\bcnpj\b/.test(key)) return 'cnpj';
  if (/(^|[_-])cep($|[_-])|\bcep\b/.test(key)) return 'cep';
  if (/(^|[_-])rg($|[_-])|\brg\b/.test(key)) return 'rg';
  if (/(phone|telefone|celular|whatsapp|mobile)/.test(key)) return 'phone';
  if (/(weight_kg|peso)/.test(key)) return 'measure-3';
  if (/(height_cm|altura|head_circumference|perimetro|perímetro|temperature_c|temperatura)/.test(key)) return 'measure-1';
  return '';
}

function applyLive(input, format) {
  if (format === 'cpf') input.value = formatCpf(input.value);
  else if (format === 'cnpj') input.value = formatCnpj(input.value);
  else if (format === 'cep') input.value = formatCep(input.value);
  else if (format === 'rg') input.value = formatRg(input.value);
  else if (format === 'phone') input.value = formatPhone(input.value);
  else if (format === 'measure-3') input.value = normalizeDecimalTyping(input.value, 3);
  else if (format === 'measure-1') input.value = normalizeDecimalTyping(input.value, 1);
}

function applyBlur(input, format) {
  if (format === 'measure-3') input.value = normalizeDecimalBlur(input.value, 3);
  else if (format === 'measure-1') input.value = normalizeDecimalBlur(input.value, 1);
  else applyLive(input, format);
}

function prepare(input) {
  if (!(input instanceof HTMLInputElement) || input.dataset.formatterReady === '1') return;
  const format = inferFormat(input);
  if (!format) return;
  input.dataset.formatterReady = '1';
  input.dataset.inferredFormat = format;
  if (['phone','cpf','cnpj','cep','rg'].includes(format)) input.inputMode = 'numeric';
  if (format.startsWith('measure-')) input.inputMode = 'decimal';
  applyBlur(input, format);
}

document.addEventListener('input', (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const format = input.dataset.inferredFormat || inferFormat(input);
  if (!format) return;
  input.dataset.inferredFormat = format;
  applyLive(input, format);
}, true);

document.addEventListener('blur', (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const format = input.dataset.inferredFormat || inferFormat(input);
  if (format) applyBlur(input, format);
}, true);

function scan(root = document) {
  root.querySelectorAll?.('input').forEach(prepare);
}

scan();
new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches?.('input')) prepare(node);
      scan(node);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

export { formatCpf, formatCnpj, formatCep, formatRg, formatPhone, normalizeDecimalBlur };

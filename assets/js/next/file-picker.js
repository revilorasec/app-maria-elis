import { FILE_GATEWAY_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js?v=19';
import { supabase, currentSession } from './supabase.js?v=19';

export function renderFilePicker({ id = 'file', label = 'Arquivo', accept = 'image/*,application/pdf,video/*', avatar = false } = {}) {
  return `<label class="attachment-button">${label}<input id="${id}" type="file" accept="${accept}" ${avatar ? 'capture="environment"' : ''}></label><div id="${id}-preview" class="file-preview" hidden></div>`;
}

export function bindFilePreview(id) {
  const input = document.querySelector(`#${id}`);
  const preview = document.querySelector(`#${id}-preview`);
  if (!input || !preview) return;
  let currentUrl = '';
  const clear = () => {
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = '';
    input.value = '';
    preview.hidden = true;
    preview.innerHTML = '';
  };
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return clear();
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = URL.createObjectURL(file);
    preview.hidden = false;
    preview.innerHTML = file.type.startsWith('image/')
      ? `<img src="${currentUrl}" alt="Prévia selecionada"><div><strong>${file.name}</strong><small>${Math.ceil(file.size / 1024)} KB</small></div><button type="button" data-file-reset>Remover</button>`
      : `<div><strong>${file.name}</strong><small>${Math.ceil(file.size / 1024)} KB</small></div><button type="button" data-file-reset>Remover</button>`;
    preview.querySelector('[data-file-reset]')?.addEventListener('click', clear);
  });
}

export async function uploadFile(file, metadata = {}) {
  if (!file) throw new Error('Escolha um arquivo.');
  const session = await currentSession();
  if (!session) throw new Error('Sessão expirada.');
  const form = new FormData();
  form.set('file', file);
  form.set('metadata', JSON.stringify({
    clientRequestId: crypto.randomUUID(),
    originalName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    fileType: metadata.fileType || 'document',
    category: metadata.category || 'other',
    relatedRecordType: metadata.relatedRecordType || null,
    relatedRecordId: metadata.relatedRecordId || null,
    contactId: metadata.contactId || null,
  }));
  const response = await fetch(`${FILE_GATEWAY_URL}?action=upload`, {
    method: 'POST',
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${session.access_token}` },
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (body.error === 'unsupported_file') throw new Error('Tipo de arquivo não permitido.');
    throw new Error(body.message || 'Não foi possível enviar o arquivo.');
  }
  return body.file;
}

export async function uploadSelectedFile(input, metadata) {
  return uploadFile(input?.files?.[0], metadata);
}



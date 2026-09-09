import { addRecord, flushPersistence, getData, localDate, updateRecord } from './services/dataService.js?v=16';
import { deleteFile, getFileUrl, uploadFile } from './storage.js?v=16';
import { notify } from './services/notificationService.js?v=16';

const ENHANCEMENT_VERSION = '17';
let enhanceScheduled = false;
let saving = false;

injectStyles();
observeApp();
scheduleEnhance();

document.addEventListener('click', async (event) => {
  const control = event.target.closest('[data-appointment-action]');
  if (!control || control.disabled) return;
  event.preventDefault();
  event.stopPropagation();
  const action = control.dataset.appointmentAction;
  try {
    if (action === 'add') openAppointmentEditor();
    if (action === 'edit') openAppointmentEditor(control.dataset.id || '');
    if (action === 'close') closeAppointmentEditor();
    if (action === 'open-photo') {
      const path = control.dataset.path || '';
      if (!path) return;
      window.open(await getFileUrl(path), '_blank', 'noopener');
    }
  } catch (error) {
    notify(error.message || 'Não foi possível concluir a ação.', 'error');
  }
}, true);

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'appointment-enhancement-form') return;
  event.preventDefault();
  event.stopPropagation();
  if (saving) return;
  saving = true;
  const submit = event.target.querySelector('[type="submit"]');
  if (submit) {
    submit.disabled = true;
    submit.textContent = 'Salvando…';
  }
  try {
    await saveAppointment(event.target);
  } catch (error) {
    notify(error.message || 'Não foi possível salvar a consulta.', 'error');
    if (submit) {
      submit.disabled = false;
      submit.textContent = 'Salvar consulta';
    }
  } finally {
    saving = false;
  }
}, true);

function observeApp() {
  const app = document.querySelector('#app');
  if (!app) return;
  new MutationObserver(scheduleEnhance).observe(app, { childList: true, subtree: true });
}

function scheduleEnhance() {
  if (enhanceScheduled) return;
  enhanceScheduled = true;
  requestAnimationFrame(() => {
    enhanceScheduled = false;
    enhanceAppointmentsPage();
  });
}

function enhanceAppointmentsPage() {
  const heading = document.querySelector('#main-content .page-heading h1');
  if (!heading || heading.textContent.trim() !== 'Consultas') return;
  let database;
  try { database = getData(); } catch { return; }
  if (!canManageAppointments(database)) return;

  const pageHeading = heading.closest('.page-heading');
  if (pageHeading && !document.querySelector('[data-appointment-toolbar]')) {
    const toolbar = document.createElement('section');
    toolbar.className = 'appointment-enhancement-toolbar';
    toolbar.dataset.appointmentToolbar = 'true';
    toolbar.innerHTML = '<button class="button button--wide" data-appointment-action="add">＋ Adicionar consulta</button>';
    pageHeading.insertAdjacentElement('afterend', toolbar);
  }

  const appointments = sortedAppointments(database);
  const cards = document.querySelectorAll('#main-content .record-list > .record-card');
  cards.forEach((card, index) => {
    const appointment = appointments[index];
    if (!appointment || card.dataset.appointmentEnhanced === appointment.id) return;
    card.dataset.appointmentEnhanced = appointment.id;
    const existing = card.querySelector('[data-appointment-card-actions]');
    if (existing) existing.remove();
    const photos = photoPaths(appointment);
    const actions = document.createElement('div');
    actions.className = 'appointment-card-actions';
    actions.dataset.appointmentCardActions = 'true';
    actions.innerHTML = `<span class="appointment-photo-count">Fotos: ${photos.length}</span><button class="button button--secondary button--small" data-appointment-action="edit" data-id="${escapeHtml(appointment.id)}">Editar</button>`;
    card.appendChild(actions);
  });
}

function sortedAppointments(database) {
  return [...(database.appointments || [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

function canManageAppointments(database) {
  const current = currentUser(database);
  if (!current) return false;
  const role = current.role || current.roleId;
  if (role === 'admin' || role === 'guardian') return true;
  const permissions = current.permissions || current.grantedPermissions || [];
  return permissions.includes('*') || permissions.includes('appointments:*') || permissions.includes('appointments:edit') || permissions.includes('appointments:create');
}

function currentUser(database) {
  return [...(database.users || [])]
    .filter((item) => item.active !== false)
    .sort((a, b) => String(b.lastAccessAt || '').localeCompare(String(a.lastAccessAt || '')))[0] || null;
}

function currentUserId(database) {
  return currentUser(database)?.id || 'app-user';
}

function openAppointmentEditor(id = '') {
  const database = getData();
  if (!canManageAppointments(database)) throw new Error('Seu perfil não pode alterar consultas.');
  const appointment = id ? (database.appointments || []).find((item) => item.id === id) : null;
  if (id && !appointment) throw new Error('Consulta não encontrada.');
  const photos = photoPaths(appointment);
  const root = document.querySelector('#modal-root');
  if (!root) throw new Error('Não foi possível abrir a edição.');

  root.innerHTML = `
    <div class="modal-backdrop appointment-enhancement-backdrop" data-appointment-action="close">
      <section class="modal appointment-editor" role="dialog" aria-modal="true" aria-labelledby="appointment-editor-title" onclick="event.stopPropagation()">
        <button class="modal__close" data-appointment-action="close" aria-label="Fechar">×</button>
        <p class="eyebrow">Consultas</p>
        <h2 id="appointment-editor-title">${appointment ? 'Editar consulta' : 'Adicionar consulta'}</h2>
        <form id="appointment-enhancement-form" class="form-card">
          <input type="hidden" name="appointmentId" value="${escapeHtml(appointment?.id || '')}">
          <div class="form-grid">
            <label>Data<input name="date" type="date" value="${escapeHtml(appointment?.date || localDate())}" required></label>
            <label>Horário<input name="time" type="time" value="${escapeHtml(appointment?.time || '09:00')}" required></label>
          </div>
          <div class="form-grid">
            <label>Especialidade<input name="specialty" value="${escapeHtml(appointment?.specialty || '')}" placeholder="Ex.: Pediatria" required></label>
            <label>Médico(a)<input name="doctorName" value="${escapeHtml(appointment?.doctorName || '')}" placeholder="Nome do profissional" required></label>
          </div>
          <label>Motivo da consulta<textarea name="reason" rows="3" placeholder="Motivo, sintomas ou acompanhamento">${escapeHtml(appointment?.reason || '')}</textarea></label>
          <label>Local / clínica<input name="location" value="${escapeHtml(appointment?.location || '')}" placeholder="Clínica, hospital ou endereço"></label>
          <div class="form-grid">
            <label>Status<select name="status"><option value="scheduled" ${selected(appointment?.status, 'scheduled', !appointment)}>Agendada</option><option value="completed" ${selected(appointment?.status, 'completed')}>Realizada</option></select></label>
            <label>Próximo retorno<input name="nextReturnDate" type="date" value="${escapeHtml(appointment?.nextReturnDate || '')}"></label>
          </div>
          <label>Orientações / observações<textarea name="notes" rows="4" placeholder="Prescrições, orientações e observações importantes">${escapeHtml(appointment?.notes || appointment?.observations || '')}</textarea></label>

          ${photos.length ? `<section class="appointment-existing-photos"><div class="section-title"><div><p class="eyebrow">${photos.length} foto(s)</p><h3>Fotos já anexadas</h3></div></div><div class="appointment-photo-list">${photos.map((path, index) => `<article class="appointment-photo-item"><div><strong>Foto ${index + 1}</strong><small>${escapeHtml(fileNameFromPath(path))}</small></div><div class="appointment-photo-item__actions"><button type="button" class="text-button" data-appointment-action="open-photo" data-path="${escapeHtml(path)}">Abrir</button><label class="appointment-remove-photo"><input type="checkbox" name="removePhoto" value="${escapeHtml(path)}"> Remover</label></div></article>`).join('')}</div></section>` : ''}

          <label class="appointment-photo-picker">Adicionar fotos da consulta<input name="photos" type="file" accept="image/*" multiple><small>Você pode selecionar 4 ou mais fotos de uma vez. As imagens ficam no OneDrive.</small></label>
          <button class="button button--wide" type="submit">Salvar consulta</button>
        </form>
      </section>
    </div>`;
}

function closeAppointmentEditor() {
  const root = document.querySelector('#modal-root');
  if (root) root.innerHTML = '';
}

async function saveAppointment(form) {
  const database = getData();
  if (!canManageAppointments(database)) throw new Error('Seu perfil não pode alterar consultas.');
  const values = new FormData(form);
  const existingId = String(values.get('appointmentId') || '');
  const current = existingId ? (database.appointments || []).find((item) => item.id === existingId) : null;
  if (existingId && !current) throw new Error('Consulta não encontrada.');

  const date = String(values.get('date') || '');
  const time = String(values.get('time') || '');
  const specialty = String(values.get('specialty') || '').trim();
  const doctorName = String(values.get('doctorName') || '').trim();
  if (!date || !time || !specialty || !doctorName) throw new Error('Informe data, horário, especialidade e médico(a).');

  const appointmentId = existingId || ('appointments-' + crypto.randomUUID());
  const keptPhotos = photoPaths(current).filter((path) => !values.getAll('removePhoto').includes(path));
  const uploaded = [];
  try {
    for (const file of values.getAll('photos')) {
      if (!(file instanceof File) || !file.name || !file.size) continue;
      if (!String(file.type || '').startsWith('image/')) throw new Error('Selecione somente arquivos de imagem nas fotos da consulta.');
      const path = appointmentPhotoPath(appointmentId, file.name);
      await uploadFile(path, file, file.type || 'image/jpeg');
      uploaded.push(path);
      keptPhotos.push(path);
    }
  } catch (error) {
    await Promise.allSettled(uploaded.map((path) => deleteFile(path)));
    throw error;
  }

  const record = {
    date,
    time,
    specialty,
    doctorName,
    reason: String(values.get('reason') || '').trim(),
    location: String(values.get('location') || '').trim(),
    status: String(values.get('status') || 'scheduled'),
    nextReturnDate: String(values.get('nextReturnDate') || ''),
    notes: String(values.get('notes') || '').trim(),
    photoPaths: [...new Set(keptPhotos)]
  };

  const userId = currentUserId(database);
  if (current) updateRecord('appointments', appointmentId, record, userId);
  else addRecord('appointments', { id: appointmentId, ...record }, userId);

  const removed = photoPaths(current).filter((path) => !record.photoPaths.includes(path));
  await Promise.allSettled(removed.map((path) => deleteFile(path)));
  await flushPersistence();
  closeAppointmentEditor();
  notify(current ? 'Consulta atualizada.' : 'Consulta adicionada.');
  refreshAppointmentsThroughApp();
}

function photoPaths(appointment) {
  if (!appointment) return [];
  const candidates = appointment.photoPaths || appointment.photos || appointment.attachmentPaths || [];
  return Array.isArray(candidates) ? candidates.filter(Boolean) : [];
}

function appointmentPhotoPath(appointmentId, originalName) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '_',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');
  const suffix = crypto.randomUUID().slice(0, 8);
  return `Anexos/Consultas/${safeFileName(appointmentId)}/${stamp}_${suffix}_${safeFileName(originalName)}`;
}

function refreshAppointmentsThroughApp() {
  const more = document.querySelector('.bottom-nav [data-page="more"], [data-page="more"]');
  if (!more) {
    window.location.reload();
    return;
  }
  more.click();
  setTimeout(() => {
    const appointments = [...document.querySelectorAll('[data-page="appointments"]')][0];
    if (appointments) appointments.click();
    else window.location.reload();
  }, 0);
}

function safeFileName(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'arquivo';
}

function fileNameFromPath(path = '') {
  return String(path).split('/').pop() || 'Imagem';
}

function selected(current, value, fallback = false) {
  return current === value || (!current && fallback) ? 'selected' : '';
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function injectStyles() {
  if (document.querySelector('#appointment-enhancement-styles')) return;
  const style = document.createElement('style');
  style.id = 'appointment-enhancement-styles';
  style.textContent = `
    .appointment-enhancement-toolbar { margin: 0 0 1rem; }
    .appointment-card-actions { display:flex; align-items:center; justify-content:flex-end; gap:.65rem; margin-left:auto; padding-left:.75rem; flex-wrap:wrap; }
    .appointment-photo-count { font-size:.78rem; opacity:.72; white-space:nowrap; }
    .appointment-editor { max-width:720px; max-height:min(88vh,900px); overflow:auto; }
    .appointment-existing-photos { margin:.25rem 0 .5rem; padding:.9rem; border:1px solid var(--border, rgba(127,127,127,.22)); border-radius:14px; }
    .appointment-photo-list { display:grid; gap:.65rem; }
    .appointment-photo-item { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.7rem .8rem; border-radius:12px; background:var(--surface-soft, rgba(127,127,127,.08)); }
    .appointment-photo-item div:first-child { min-width:0; }
    .appointment-photo-item strong, .appointment-photo-item small { display:block; }
    .appointment-photo-item small { opacity:.7; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:300px; }
    .appointment-photo-item__actions { display:flex; align-items:center; gap:.7rem; flex-wrap:wrap; justify-content:flex-end; }
    .appointment-remove-photo { display:flex; align-items:center; gap:.35rem; font-size:.84rem; }
    .appointment-photo-picker small { display:block; margin-top:.35rem; opacity:.72; font-weight:400; }
    @media (max-width:640px) {
      .appointment-card-actions { width:100%; justify-content:space-between; padding:.7rem 0 0; }
      .appointment-photo-item { align-items:flex-start; flex-direction:column; }
      .appointment-photo-item__actions { width:100%; justify-content:space-between; }
    }
  `;
  document.head.appendChild(style);
}

console.info(`Melhorias de consultas v${ENHANCEMENT_VERSION} carregadas.`);

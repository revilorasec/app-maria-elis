import { supabase, currentSession } from './supabase.js?v=20';

let overlay = null;
let appointments = [];
let saving = false;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function toast(message, error = false) {
  let region = document.querySelector('#medical-quick-toast');
  if (!region) {
    region = document.createElement('div');
    region.id = 'medical-quick-toast';
    region.className = 'medical-quick-toast-region';
    document.body.append(region);
  }
  const box = document.createElement('div');
  box.className = `medical-quick-toast${error ? ' medical-quick-toast--error' : ''}`;
  box.textContent = message;
  region.append(box);
  setTimeout(() => box.remove(), error ? 7000 : 3000);
}

async function familyId() {
  const session = await currentSession();
  if (!session) throw new Error('Sua sessão expirou. Entre novamente no app.');
  const result = await supabase.rpc('my_access_context');
  if (result.error) throw result.error;
  if (!result.data?.active || !result.data?.family_id) throw new Error('Não foi possível identificar sua família ativa.');
  return result.data.family_id;
}

async function loadAppointments() {
  const id = await familyId();
  const result = await supabase
    .from('medical_appointments')
    .select('id,specialty,doctor_name,clinic_or_hospital,appointment_at,updated_at')
    .eq('family_id', id)
    .order('appointment_at', { ascending: false });
  if (result.error) throw result.error;
  appointments = result.data || [];
}

function closeOverlay() {
  overlay?.remove();
  document.querySelectorAll('.medical-quick-overlay').forEach((node) => node.remove());
  overlay = null;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function card(row) {
  return `<article class="medical-quick-card">
    <div>
      <small>${esc(formatDate(row.appointment_at))}</small>
      <h3>${esc(row.specialty || 'Consulta')}</h3>
      <p>${esc(row.doctor_name || '')}${row.clinic_or_hospital ? ` · ${esc(row.clinic_or_hospital)}` : ''}</p>
    </div>
    <button type="button" class="button button--secondary button--small" data-medical-quick-edit="${esc(row.id)}">Editar</button>
  </article>`;
}

async function openList() {
  try {
    await loadAppointments();
    closeOverlay();
    overlay = document.createElement('div');
    overlay.className = 'medical-quick-overlay';
    overlay.innerHTML = `<section class="medical-quick-panel" role="dialog" aria-modal="true">
      <header class="medical-quick-header">
        <div><p>Saúde</p><h2>Consultas médicas</h2></div>
        <button type="button" class="medical-quick-close" data-medical-quick-close>×</button>
      </header>
      <div class="medical-quick-toolbar"><button type="button" class="button" data-medical-quick-new>＋ Nova consulta</button></div>
      <section class="medical-quick-list">${appointments.length ? appointments.map(card).join('') : '<div class="medical-quick-empty"><strong>Nenhuma consulta cadastrada.</strong></div>'}</section>
    </section>`;
    document.body.append(overlay);
  } catch (error) {
    console.error(error);
    toast(error?.message || 'Não foi possível abrir as consultas.', true);
  }
}

function openEditor(id = '') {
  const row = id ? appointments.find((item) => item.id === id) : null;
  closeOverlay();
  overlay = document.createElement('div');
  overlay.className = 'medical-quick-overlay';
  overlay.innerHTML = `<section class="medical-quick-panel medical-quick-panel--form" role="dialog" aria-modal="true">
    <header class="medical-quick-header">
      <div><p>Consultas médicas</p><h2>${row ? 'Editar consulta' : 'Nova consulta'}</h2></div>
      <button type="button" class="medical-quick-close" data-medical-quick-close>×</button>
    </header>
    <form id="medical-quick-form" class="medical-quick-form">
      <input type="hidden" name="id" value="${esc(row?.id || '')}">
      <label>Especialidade<input name="specialty" required autocomplete="off" value="${esc(row?.specialty || '')}" placeholder="Ex.: Pediatria"></label>
      <label>Nome do médico<input name="doctor_name" required autocomplete="off" value="${esc(row?.doctor_name || '')}" placeholder="Ex.: Dra. Talita Oliveira"></label>
      <label>Local<input name="location" required autocomplete="off" value="${esc(row?.clinic_or_hospital || '')}" placeholder="Ex.: Clínica / Hospital"></label>
      <div class="medical-quick-footer">
        <button type="button" class="button button--secondary" data-medical-quick-back>Voltar</button>
        <button type="submit" class="button" data-medical-quick-save>Salvar</button>
      </div>
    </form>
  </section>`;
  document.body.append(overlay);
  overlay.querySelector('input[name="specialty"]')?.focus();
}

async function save(form) {
  if (saving) return;
  saving = true;
  const button = form.querySelector('[data-medical-quick-save]');
  if (button) { button.disabled = true; button.textContent = 'Salvando…'; }
  try {
    const session = await currentSession();
    if (!session) throw new Error('Sua sessão expirou. Entre novamente no app.');
    const data = new FormData(form);
    const id = String(data.get('id') || '').trim();
    const specialty = String(data.get('specialty') || '').trim();
    const doctor = String(data.get('doctor_name') || '').trim();
    const location = String(data.get('location') || '').trim();
    if (!specialty || !doctor || !location) throw new Error('Preencha especialidade, nome do médico e local.');

    const result = await supabase.rpc('save_medical_appointment_quick', {
      p_id: id || null,
      p_specialty: specialty,
      p_doctor_name: doctor,
      p_location: location,
    });
    if (result.error) throw result.error;

    toast(id ? 'Consulta atualizada.' : 'Consulta salva.');
    await openList();
  } catch (error) {
    console.error('Falha ao salvar consulta', error);
    const raw = String(error?.message || 'Não foi possível salvar.');
    const message = raw.includes('permission_denied') ? 'Seu acesso não permite editar consultas.'
      : raw.includes('not_authenticated') ? 'Sua sessão expirou. Entre novamente no app.'
      : raw.includes('specialty_required') || raw.includes('doctor_required') || raw.includes('location_required') ? 'Preencha os três campos.'
      : raw;
    toast(`Erro ao salvar: ${message}`, true);
    if (button) { button.disabled = false; button.textContent = 'Salvar'; }
  } finally {
    saving = false;
  }
}

function enhance() {
  const main = document.querySelector('#main-content');
  const heading = main?.querySelector('.page-heading h1,.next-page-heading h1');
  const title = heading?.textContent?.trim();
  if (title === 'Mais') {
    const grid = main.querySelector('.next-feature-grid');
    if (grid && !grid.querySelector('[data-medical-quick-open]')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'medical-quick-feature';
      button.dataset.medicalQuickOpen = '1';
      button.innerHTML = '<span>✚</span><div><strong>Consultas médicas</strong><small>Especialidade, médico e local</small></div>';
      grid.prepend(button);
    }
  }
  if (title === 'Agenda') {
    const headingBox = heading.closest('.page-heading,.next-page-heading');
    if (headingBox && !headingBox.querySelector('[data-medical-quick-open]')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button--secondary button--small';
      button.dataset.medicalQuickOpen = '1';
      button.textContent = 'Consultas médicas';
      headingBox.append(button);
    }
  }
}

document.addEventListener('click', (event) => {
  if (event.target.closest('[data-medical-quick-open]')) { event.preventDefault(); return openList(); }
  if (event.target.closest('[data-medical-quick-close]')) { event.preventDefault(); return closeOverlay(); }
  if (event.target.closest('[data-medical-quick-new]')) { event.preventDefault(); return openEditor(); }
  const edit = event.target.closest('[data-medical-quick-edit]');
  if (edit) { event.preventDefault(); return openEditor(edit.dataset.medicalQuickEdit || ''); }
  if (event.target.closest('[data-medical-quick-back]')) { event.preventDefault(); return openList(); }
}, true);

document.addEventListener('submit', async (event) => {
  if (event.target?.id !== 'medical-quick-form') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  await save(event.target);
}, true);

const style = document.createElement('style');
style.textContent = `
.medical-quick-feature{appearance:none;border:1px solid var(--border,rgba(58,87,82,.18));background:var(--surface,#fff);border-radius:18px;padding:1rem;text-align:left;display:flex;align-items:center;gap:.8rem;min-height:92px;color:inherit;font:inherit;cursor:pointer;width:100%;box-shadow:0 8px 24px rgba(41,62,58,.06)}
.medical-quick-feature>span{width:42px;height:42px;border-radius:14px;display:grid;place-items:center;background:rgba(47,111,102,.12);font-size:1.25rem;color:#2f6f66}.medical-quick-feature strong,.medical-quick-feature small{display:block}.medical-quick-feature small{margin-top:.28rem;opacity:.72}
.medical-quick-overlay{position:fixed;inset:0;z-index:10000;background:rgba(17,28,26,.6);display:flex;align-items:flex-end;justify-content:center}.medical-quick-panel{width:min(760px,100%);max-height:95dvh;overflow:auto;background:var(--surface,#fff);color:var(--text,#20302d);border-radius:24px 24px 0 0;padding:1rem 1rem max(1rem,env(safe-area-inset-bottom))}.medical-quick-panel--form{width:min(620px,100%)}
.medical-quick-header{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;border-bottom:1px solid var(--border,rgba(58,87,82,.12));padding:.5rem 0 1rem}.medical-quick-header p{margin:0;text-transform:uppercase;letter-spacing:.08em;font-size:.72rem;font-weight:700;color:#2f6f66}.medical-quick-header h2{margin:.15rem 0}.medical-quick-close{border:0;background:transparent;font-size:2rem;line-height:1;color:inherit}.medical-quick-toolbar{padding:1rem 0}.medical-quick-list{display:grid;gap:.75rem}.medical-quick-card{border:1px solid var(--border,rgba(58,87,82,.14));border-radius:16px;padding:1rem;display:flex;align-items:center;justify-content:space-between;gap:1rem}.medical-quick-card h3{margin:.2rem 0}.medical-quick-card p,.medical-quick-card small{margin:0;opacity:.75}.medical-quick-form{display:grid;gap:1rem;padding:1rem 0}.medical-quick-form label{display:grid;gap:.4rem;font-weight:700}.medical-quick-form input{width:100%;box-sizing:border-box;border:1px solid var(--border,rgba(58,87,82,.22));background:var(--surface,#fff);color:inherit;border-radius:12px;padding:.9rem;font:inherit}.medical-quick-footer{display:flex;gap:.75rem;justify-content:flex-end;margin-top:.5rem}.medical-quick-toast-region{position:fixed;z-index:14000;top:16px;left:50%;transform:translateX(-50%);display:grid;gap:.5rem;width:min(92vw,520px)}.medical-quick-toast{padding:12px 16px;border-radius:12px;background:#225d54;color:#fff;font-weight:700;box-shadow:0 12px 32px rgba(0,0,0,.25)}.medical-quick-toast--error{background:#9b2c2c}
@media (max-width:640px){.medical-quick-panel{border-radius:0;width:100%;height:100dvh;max-height:100dvh}.medical-quick-card{align-items:flex-start}.medical-quick-footer{position:sticky;bottom:0;background:var(--surface,#fff);padding:.75rem 0}.medical-quick-footer .button{flex:1}}
`;
document.head.append(style);

new MutationObserver(() => requestAnimationFrame(enhance)).observe(document.querySelector('#app'), { childList: true, subtree: true });
enhance();

import { supabase, currentSession } from './supabase.js?v=20';

const MODULE_VERSION = '21';
const state = {
  context: null,
  appointments: [],
  overlay: null,
  busy: false,
};

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const attr = esc;

const localDateTimeValue = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
};

const formatDateTime = (value) => {
  if (!value) return 'Data não informada';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('pt-BR', {
    weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(date);
};

const numberOrNull = (value) => {
  const normalized = String(value ?? '').trim().replace(',', '.');
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
};

function toast(message, type = 'info') {
  let region = document.querySelector('#appointment-next-toast-region');
  if (!region) {
    region = document.createElement('div');
    region.id = 'appointment-next-toast-region';
    region.className = 'appointment-next-toast-region';
    document.body.append(region);
  }
  const node = document.createElement('div');
  node.className = `appointment-next-toast${type === 'error' ? ' appointment-next-toast--error' : ''}`;
  node.textContent = message;
  region.append(node);
  setTimeout(() => node.remove(), 3800);
}

function setBusy(value) {
  state.busy = value;
  document.querySelectorAll('[data-appointment-save], [data-appointment-add]').forEach((button) => {
    button.disabled = value;
  });
}

async function loadContext() {
  const session = await currentSession();
  if (!session) throw new Error('Faça login novamente para acessar as consultas.');
  const { data, error } = await supabase.rpc('my_access_context');
  if (error || !data?.active || !data?.family_id) {
    throw new Error(error?.message || 'Não foi possível identificar a família ativa.');
  }
  state.context = { ...data, session };
  return state.context;
}

async function loadAppointments() {
  const context = state.context || await loadContext();
  const { data, error } = await supabase
    .from('medical_appointments')
    .select('*')
    .eq('family_id', context.family_id)
    .order('appointment_at', { ascending: false });
  if (error) throw error;
  state.appointments = data || [];
  return state.appointments;
}

function appointmentSummary(row) {
  const details = [row.specialty, row.doctor_name].filter(Boolean).join(' · ') || 'Consulta médica';
  const secondary = [row.clinic_or_hospital, row.reason].filter(Boolean).join(' · ');
  const hasOutcome = Boolean(
    row.diagnosis || row.medical_notes || row.recommendations || row.prescribed_medications
    || row.ordered_exams || row.vaccines_guidance || row.parent_notes
  );
  const status = hasOutcome ? 'Registro preenchido' : new Date(row.appointment_at) < new Date() ? 'Aguardando registro' : 'Agendada';
  return `<article class="appointment-next-card">
    <div class="appointment-next-card__main">
      <div class="appointment-next-card__date">${esc(formatDateTime(row.appointment_at))}</div>
      <h3>${esc(details)}</h3>
      ${secondary ? `<p>${esc(secondary)}</p>` : ''}
      <span class="appointment-next-status">${esc(status)}</span>
    </div>
    <button type="button" class="button button--secondary button--small" data-appointment-edit="${attr(row.id)}">Editar</button>
  </article>`;
}

function listMarkup() {
  if (!state.appointments.length) {
    return `<section class="appointment-next-empty">
      <strong>Nenhuma consulta cadastrada.</strong>
      <p>Cadastre a consulta para registrar tudo antes, durante e depois do atendimento.</p>
    </section>`;
  }
  return `<section class="appointment-next-list">${state.appointments.map(appointmentSummary).join('')}</section>`;
}

async function openAppointments() {
  try {
    await loadContext();
    await loadAppointments();
    closeOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'appointment-next-overlay';
    overlay.dataset.appointmentOverlay = 'list';
    overlay.innerHTML = `<section class="appointment-next-panel" role="dialog" aria-modal="true" aria-labelledby="appointment-next-title">
      <header class="appointment-next-header">
        <div>
          <p class="appointment-next-eyebrow">Saúde</p>
          <h2 id="appointment-next-title">Consultas médicas</h2>
          <p>Cadastre, edite e registre como foi cada consulta.</p>
        </div>
        <button type="button" class="appointment-next-close" data-appointment-close aria-label="Fechar">×</button>
      </header>
      <div class="appointment-next-actions">
        <button type="button" class="button" data-appointment-add>＋ Nova consulta</button>
      </div>
      <div data-appointment-list>${listMarkup()}</div>
    </section>`;
    document.body.append(overlay);
    state.overlay = overlay;
  } catch (error) {
    console.error(error);
    toast(error.message || 'Não foi possível abrir as consultas.', 'error');
  }
}

function formSection(title, text, content) {
  return `<section class="appointment-next-section"><div class="appointment-next-section__heading"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}</div>${content}</section>`;
}

function appointmentFormMarkup(record = null) {
  const appointmentAt = localDateTimeValue(record?.appointment_at || new Date());
  const returnAt = record?.return_at ? localDateTimeValue(record.return_at) : '';
  return `<form id="appointment-next-form" class="appointment-next-form">
    <input type="hidden" name="id" value="${attr(record?.id || '')}">
    ${formSection('1. Consulta', 'Informações do agendamento.', `
      <div class="appointment-next-grid appointment-next-grid--2">
        <label>Data e horário<input name="appointment_at" type="datetime-local" required value="${attr(appointmentAt)}"></label>
        <label>Especialidade<input name="specialty" required value="${attr(record?.specialty || 'Pediatria')}" placeholder="Ex.: Pediatria"></label>
      </div>
      <div class="appointment-next-grid appointment-next-grid--2">
        <label>Médico(a) / profissional<input name="doctor_name" value="${attr(record?.doctor_name || '')}" placeholder="Nome do profissional"></label>
        <label>Clínica / hospital<input name="clinic_or_hospital" value="${attr(record?.clinic_or_hospital || '')}" placeholder="Local da consulta"></label>
      </div>
      <label>Motivo da consulta<textarea name="reason" rows="2" placeholder="Por que a consulta foi marcada?">${esc(record?.reason || '')}</textarea></label>
    `)}

    ${formSection('2. Durante a consulta', 'Use estes campos enquanto conversa com o profissional.', `
      <label>Queixa principal<textarea name="chief_complaint" rows="2" placeholder="Sintomas, comportamento, dúvida principal...">${esc(record?.chief_complaint || '')}</textarea></label>
      <label>Histórico relatado<textarea name="history_reported" rows="3" placeholder="O que foi contado ao profissional, evolução, episódios anteriores...">${esc(record?.history_reported || '')}</textarea></label>
      <div class="appointment-next-grid appointment-next-grid--4">
        <label>Peso (kg)<input name="weight_kg" inputmode="decimal" value="${attr(record?.weight_kg ?? '')}"></label>
        <label>Altura (cm)<input name="height_cm" inputmode="decimal" value="${attr(record?.height_cm ?? '')}"></label>
        <label>Perímetro cefálico (cm)<input name="head_circumference_cm" inputmode="decimal" value="${attr(record?.head_circumference_cm ?? '')}"></label>
        <label>Temperatura (°C)<input name="temperature_c" inputmode="decimal" value="${attr(record?.temperature_c ?? '')}"></label>
      </div>
    `)}

    ${formSection('3. Como foi a consulta', 'Registre o resultado e tudo que precisa ser lembrado depois.', `
      <label>Diagnóstico / avaliação<textarea name="diagnosis" rows="2">${esc(record?.diagnosis || '')}</textarea></label>
      <label>Anotações médicas<textarea name="medical_notes" rows="3" placeholder="O que o profissional explicou ou observou...">${esc(record?.medical_notes || '')}</textarea></label>
      <label>Orientações e recomendações<textarea name="recommendations" rows="3" placeholder="Cuidados, sinais de alerta, alimentação, rotina...">${esc(record?.recommendations || '')}</textarea></label>
      <label>Medicamentos prescritos<textarea name="prescribed_medications" rows="2" placeholder="Nome, dose e orientação, se houver">${esc(record?.prescribed_medications || '')}</textarea></label>
      <label>Exames solicitados<textarea name="ordered_exams" rows="2">${esc(record?.ordered_exams || '')}</textarea></label>
      <label>Orientações sobre vacinas<textarea name="vaccines_guidance" rows="2">${esc(record?.vaccines_guidance || '')}</textarea></label>
      <div class="appointment-next-grid appointment-next-grid--2">
        <label>Próximo retorno<input name="return_at" type="datetime-local" value="${attr(returnAt)}"></label>
        <label>Observações dos pais<textarea name="parent_notes" rows="2" placeholder="Dúvidas, decisões ou lembretes pessoais">${esc(record?.parent_notes || '')}</textarea></label>
      </div>
    `)}

    <div class="appointment-next-form__footer">
      <button type="button" class="button button--secondary" data-appointment-back>Voltar</button>
      <button type="submit" class="button" data-appointment-save>Salvar consulta</button>
    </div>
  </form>`;
}

function openEditor(id = '') {
  const record = id ? state.appointments.find((item) => item.id === id) : null;
  if (id && !record) {
    toast('Consulta não encontrada.', 'error');
    return;
  }
  closeOverlay();
  const overlay = document.createElement('div');
  overlay.className = 'appointment-next-overlay';
  overlay.dataset.appointmentOverlay = 'editor';
  overlay.innerHTML = `<section class="appointment-next-panel appointment-next-panel--form" role="dialog" aria-modal="true" aria-labelledby="appointment-next-form-title">
    <header class="appointment-next-header">
      <div>
        <p class="appointment-next-eyebrow">Consultas médicas</p>
        <h2 id="appointment-next-form-title">${record ? 'Editar consulta' : 'Nova consulta'}</h2>
        <p>Você pode voltar e alterar qualquer informação depois.</p>
      </div>
      <button type="button" class="appointment-next-close" data-appointment-close aria-label="Fechar">×</button>
    </header>
    ${appointmentFormMarkup(record)}
  </section>`;
  document.body.append(overlay);
  state.overlay = overlay;
  overlay.querySelector('input[name="doctor_name"]')?.focus();
}

function closeOverlay() {
  state.overlay?.remove();
  document.querySelectorAll('.appointment-next-overlay').forEach((node) => node.remove());
  state.overlay = null;
}

async function syncCalendarEvent(appointment) {
  const context = state.context || await loadContext();
  const session = context.session || await currentSession();
  const titleParts = [appointment.specialty || 'Consulta', appointment.doctor_name].filter(Boolean);
  const payload = {
    family_id: context.family_id,
    event_type: 'appointment',
    title: titleParts.join(' · '),
    starts_at: appointment.appointment_at,
    ends_at: null,
    location: appointment.clinic_or_hospital || '',
    notes: '',
    related_record_type: 'medical_appointment',
    related_record_id: appointment.id,
    active: true,
    all_day: false,
    audience_role: 'all',
    requires_acknowledgement: false,
    updated_by: session?.user?.id || null,
  };

  const existing = await supabase
    .from('calendar_events')
    .select('id')
    .eq('family_id', context.family_id)
    .eq('related_record_type', 'medical_appointment')
    .eq('related_record_id', appointment.id)
    .maybeSingle();
  if (existing.error) throw existing.error;

  if (existing.data?.id) {
    const { error } = await supabase.from('calendar_events').update(payload).eq('id', existing.data.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('calendar_events').insert({ ...payload, created_by: session?.user?.id || null });
    if (error) throw error;
  }
}

async function saveAppointment(form) {
  if (state.busy) return;
  setBusy(true);
  try {
    const context = state.context || await loadContext();
    const session = context.session || await currentSession();
    const data = new FormData(form);
    const id = String(data.get('id') || '');
    const appointmentAtRaw = String(data.get('appointment_at') || '');
    if (!appointmentAtRaw) throw new Error('Informe a data e o horário da consulta.');

    const payload = {
      family_id: context.family_id,
      doctor_name: String(data.get('doctor_name') || '').trim(),
      specialty: String(data.get('specialty') || 'Pediatria').trim() || 'Pediatria',
      clinic_or_hospital: String(data.get('clinic_or_hospital') || '').trim(),
      appointment_at: new Date(appointmentAtRaw).toISOString(),
      reason: String(data.get('reason') || '').trim(),
      chief_complaint: String(data.get('chief_complaint') || '').trim(),
      history_reported: String(data.get('history_reported') || '').trim(),
      weight_kg: numberOrNull(data.get('weight_kg')),
      height_cm: numberOrNull(data.get('height_cm')),
      head_circumference_cm: numberOrNull(data.get('head_circumference_cm')),
      temperature_c: numberOrNull(data.get('temperature_c')),
      diagnosis: String(data.get('diagnosis') || '').trim(),
      medical_notes: String(data.get('medical_notes') || '').trim(),
      recommendations: String(data.get('recommendations') || '').trim(),
      prescribed_medications: String(data.get('prescribed_medications') || '').trim(),
      ordered_exams: String(data.get('ordered_exams') || '').trim(),
      vaccines_guidance: String(data.get('vaccines_guidance') || '').trim(),
      return_at: data.get('return_at') ? new Date(String(data.get('return_at'))).toISOString() : null,
      parent_notes: String(data.get('parent_notes') || '').trim(),
      updated_by: session?.user?.id || null,
    };

    let saved;
    if (id) {
      const result = await supabase
        .from('medical_appointments')
        .update(payload)
        .eq('id', id)
        .eq('family_id', context.family_id)
        .select('*')
        .single();
      if (result.error) throw result.error;
      saved = result.data;
    } else {
      const result = await supabase
        .from('medical_appointments')
        .insert({ ...payload, created_by: session?.user?.id || null })
        .select('*')
        .single();
      if (result.error) throw result.error;
      saved = result.data;
    }

    try {
      await syncCalendarEvent(saved);
    } catch (calendarError) {
      console.warn('Consulta salva, mas a agenda não pôde ser sincronizada.', calendarError);
    }

    toast(id ? 'Consulta atualizada.' : 'Consulta cadastrada.');
    await openAppointments();
  } catch (error) {
    console.error(error);
    toast(error.message || 'Não foi possível salvar a consulta.', 'error');
  } finally {
    setBusy(false);
  }
}

function enhanceVisiblePage() {
  const main = document.querySelector('#main-content');
  if (!main) return;
  const heading = main.querySelector('.page-heading h1, .next-page-heading h1');
  const title = heading?.textContent?.trim();

  if (title === 'Mais') {
    const grid = main.querySelector('.next-feature-grid');
    if (grid && !grid.querySelector('[data-medical-appointments]')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'appointment-next-feature-card';
      button.dataset.medicalAppointments = 'true';
      button.innerHTML = '<span class="appointment-next-feature-card__icon">✚</span><span><strong>Consultas médicas</strong><small>Agendar, editar e registrar como foi</small></span>';
      grid.prepend(button);
    }
  }

  if (title === 'Agenda') {
    const pageHeading = heading.closest('.page-heading, .next-page-heading');
    if (pageHeading && !pageHeading.querySelector('[data-medical-appointments]')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button--secondary button--small';
      button.dataset.medicalAppointments = 'true';
      button.textContent = 'Consultas médicas';
      pageHeading.append(button);
    }
  }
}

function injectStyles() {
  if (document.querySelector('#appointment-next-styles')) return;
  const style = document.createElement('style');
  style.id = 'appointment-next-styles';
  style.textContent = `
    .appointment-next-feature-card{appearance:none;border:1px solid var(--border,rgba(58,87,82,.18));background:var(--surface,#fff);border-radius:18px;padding:1rem;text-align:left;display:flex;align-items:center;gap:.8rem;min-height:92px;color:inherit;font:inherit;cursor:pointer;width:100%;box-shadow:0 8px 24px rgba(41,62,58,.06)}
    .appointment-next-feature-card__icon{width:42px;height:42px;border-radius:14px;display:grid;place-items:center;background:rgba(47,111,102,.12);font-size:1.25rem;color:#2f6f66;flex:0 0 auto}
    .appointment-next-feature-card strong,.appointment-next-feature-card small{display:block}.appointment-next-feature-card small{margin-top:.28rem;opacity:.72;line-height:1.25}
    .appointment-next-overlay{position:fixed;inset:0;z-index:10000;background:rgba(17,28,26,.58);backdrop-filter:blur(3px);display:flex;align-items:flex-end;justify-content:center;padding:0}
    .appointment-next-panel{background:var(--surface,#fff);color:var(--text,#20302d);width:min(820px,100%);max-height:94dvh;overflow:auto;border-radius:24px 24px 0 0;padding:1rem 1rem max(1rem,env(safe-area-inset-bottom));box-shadow:0 -18px 50px rgba(0,0,0,.2)}
    .appointment-next-panel--form{width:min(920px,100%)}
    .appointment-next-header{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;position:sticky;top:-1rem;background:var(--surface,#fff);z-index:2;padding:1rem 0 .8rem;border-bottom:1px solid var(--border,rgba(58,87,82,.12))}
    .appointment-next-header h2{margin:.1rem 0 .25rem;font-size:1.55rem}.appointment-next-header p{margin:0;opacity:.72}.appointment-next-eyebrow{text-transform:uppercase;letter-spacing:.09em;font-size:.72rem;font-weight:700;color:#2f6f66!important;opacity:1!important}
    .appointment-next-close{border:0;background:transparent;font-size:2rem;line-height:1;padding:.15rem .35rem;cursor:pointer;color:inherit}
    .appointment-next-actions{display:flex;justify-content:flex-end;padding:1rem 0}
    .appointment-next-list{display:grid;gap:.75rem}.appointment-next-card{display:flex;justify-content:space-between;gap:1rem;align-items:center;padding:1rem;border:1px solid var(--border,rgba(58,87,82,.15));border-radius:16px;background:var(--surface-soft,#f7faf9)}
    .appointment-next-card__main{min-width:0}.appointment-next-card__date{font-size:.82rem;font-weight:700;color:#2f6f66;margin-bottom:.28rem}.appointment-next-card h3{margin:0 0 .3rem;font-size:1.02rem}.appointment-next-card p{margin:0 0 .55rem;opacity:.72;line-height:1.35}.appointment-next-status{display:inline-flex;border-radius:999px;background:rgba(47,111,102,.1);padding:.28rem .55rem;font-size:.75rem;font-weight:700;color:#2f6f66}
    .appointment-next-empty{padding:2rem 1rem;text-align:center;border:1px dashed var(--border,rgba(58,87,82,.25));border-radius:16px}.appointment-next-empty p{opacity:.72}
    .appointment-next-form{display:grid;gap:1rem;padding-top:1rem}.appointment-next-section{border:1px solid var(--border,rgba(58,87,82,.15));border-radius:18px;padding:1rem;background:var(--surface,#fff);display:grid;gap:.8rem}.appointment-next-section__heading h3{margin:0;font-size:1.05rem}.appointment-next-section__heading p{margin:.22rem 0 0;opacity:.68;font-size:.88rem}
    .appointment-next-form label{display:grid;gap:.38rem;font-weight:650;font-size:.88rem}.appointment-next-form input,.appointment-next-form textarea,.appointment-next-form select{width:100%;box-sizing:border-box;border:1px solid var(--border,rgba(58,87,82,.2));border-radius:12px;padding:.78rem .85rem;background:var(--surface,#fff);color:inherit;font:inherit}.appointment-next-form textarea{resize:vertical;min-height:72px}
    .appointment-next-grid{display:grid;gap:.75rem}.appointment-next-grid--2{grid-template-columns:repeat(2,minmax(0,1fr))}.appointment-next-grid--4{grid-template-columns:repeat(4,minmax(0,1fr))}.appointment-next-form__footer{display:flex;justify-content:flex-end;gap:.75rem;position:sticky;bottom:-1rem;background:var(--surface,#fff);padding:1rem 0 calc(1rem + env(safe-area-inset-bottom));border-top:1px solid var(--border,rgba(58,87,82,.12))}
    .appointment-next-toast-region{position:fixed;z-index:11000;top:calc(.8rem + env(safe-area-inset-top));left:50%;transform:translateX(-50%);width:min(92vw,520px);display:grid;gap:.5rem}.appointment-next-toast{background:#173f39;color:#fff;padding:.85rem 1rem;border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.22);font-weight:650}.appointment-next-toast--error{background:#7f2f2f}
    @media (max-width:680px){.appointment-next-overlay{align-items:stretch}.appointment-next-panel{width:100%;max-height:none;height:100dvh;border-radius:0;padding-top:max(1rem,env(safe-area-inset-top))}.appointment-next-header{top:calc(-1rem - env(safe-area-inset-top));padding-top:calc(1rem + env(safe-area-inset-top))}.appointment-next-grid--2,.appointment-next-grid--4{grid-template-columns:1fr}.appointment-next-card{align-items:flex-start}.appointment-next-card .button{flex:0 0 auto}.appointment-next-form__footer{bottom:calc(-1rem - env(safe-area-inset-bottom));padding-bottom:calc(1rem + env(safe-area-inset-bottom))}}
  `;
  document.head.append(style);
}

function bindEvents() {
  document.addEventListener('click', async (event) => {
    const open = event.target.closest('[data-medical-appointments]');
    if (open) {
      event.preventDefault();
      event.stopPropagation();
      await openAppointments();
      return;
    }
    if (event.target.closest('[data-appointment-close]')) {
      event.preventDefault();
      closeOverlay();
      return;
    }
    if (event.target.closest('[data-appointment-add]')) {
      event.preventDefault();
      openEditor();
      return;
    }
    const edit = event.target.closest('[data-appointment-edit]');
    if (edit) {
      event.preventDefault();
      openEditor(edit.dataset.appointmentEdit || '');
      return;
    }
    if (event.target.closest('[data-appointment-back]')) {
      event.preventDefault();
      await openAppointments();
    }
  }, true);

  document.addEventListener('submit', async (event) => {
    if (event.target.id !== 'appointment-next-form') return;
    event.preventDefault();
    event.stopPropagation();
    await saveAppointment(event.target);
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.overlay) closeOverlay();
  });
}

function observeApp() {
  const app = document.querySelector('#app');
  if (!app) return;
  const observer = new MutationObserver(() => requestAnimationFrame(enhanceVisiblePage));
  observer.observe(app, { childList: true, subtree: true });
  enhanceVisiblePage();
}

injectStyles();
bindEvents();
observeApp();
console.info(`APP MARIA consultas v${MODULE_VERSION} ativa`);

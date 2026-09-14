import { supabase, signInWithPin, signOut, currentSession } from './supabase.js?v=20';
import { INACTIVITY_MS } from './config.js?v=20';
import { createPermissionChecker, roleLabel, permissionLabel } from './permissions.js?v=20';
import { renderFilePicker, bindFilePreview, uploadSelectedFile, uploadFile } from './file-picker.js?v=20';
import { cropImage } from './photo-editor.js?v=20';
import { syncMedicationTasks, completeCareTask } from './care-service.js?v=20';
import { addIcsToCalendar } from './ics.js?v=20';
import { planLegacyImport } from './migration-preview.js?v=20';
import { listUsers, createUser, updateUser, resetUserPin, setUserBlock, unblockUser, setRolePermission } from './identity-client.js?v=20';
import { listDocuments, archiveDocument, openDocument } from './document-service.js?v=20';
import { listRoutineTasks, listOpenRoutineTasks, loadRoutineTask, createRoutineTask, respondRoutineTask, toggleRoutineItem, startRoutineTask, stopRoutineTask, listRoutineTemplates, loadRoutineTemplate, saveRoutineTemplate, listDailyLogs, createDailyLog, attachDailyLogFile, listEmergencyHospitals, createEmergencyHospital, listUpcomingEvents, acknowledgeEvent } from './routine-service.js?v=20';
import { listRecipes, loadRecipe, saveRecipe, deleteRecipe } from './recipe-service.js?v=20';

const app = document.querySelector('#app');
const LOGIN_EMAIL_STORAGE_KEY = 'maria-elis-login-email-v1';
const state = {
  context: null,
  page: 'home',
  modal: null,
  timer: null,
  activityBound: false,
  escapeBound: false,
  busy: false,
  historyFrom: '',
  historyTo: '',
  historyType: 'all',
  privateUrls: new Map(),
  acknowledgedEventIds: new Set(),
};

function rememberedLoginEmail() {
  try {
    return localStorage.getItem(LOGIN_EMAIL_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function rememberLoginEmail(value) {
  try {
    const email = String(value || '').trim().toLowerCase();
    if (email) localStorage.setItem(LOGIN_EMAIL_STORAGE_KEY, email);
    else localStorage.removeItem(LOGIN_EMAIL_STORAGE_KEY);
  } catch {
    // O login continua funcionando mesmo quando o navegador bloqueia o armazenamento local.
  }
}

const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[char]));
const attr = esc;
const can = (code) => state.context?.can?.(code) === true;
const isAdmin = () => ['admin', 'father', 'mother'].includes(state.context?.membership?.role);
const canManage = (code) => isAdmin() || can(code);
const isCaregiver = () => state.context?.membership?.role === 'caregiver';
const canQuickRegister = () => can('daily_logs.create') || isAdmin();
function requirePermission(code) {
  if (canManage(code)) return true;
  toast('Seu perfil não permite esta ação.', 'warning');
  return false;
}
const initials = (value) => String(value || 'ME').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
const todayIso = () => new Date().toISOString().slice(0, 10);
const dateInputValue = (value) => value ? new Date(value).toISOString().slice(0, 10) : '';
const localDateTimeValue = (value) => {
  if (!value) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
};
const formatDate = (value, options = {}) => {
  if (!value) return 'Data não informada';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('pt-BR', options).format(date);
};
const formatPhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return value || '';
};

const dateOnly = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};
const startOfLocalDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};
const addDays = (value, days) => {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
};
const endOfLocalDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
};
const calculateAge = (birthDate) => {
  if (!birthDate) return 'Não informada';
  const birth = new Date(`${birthDate}T12:00:00`);
  if (Number.isNaN(birth.getTime()) || birth > new Date()) return 'Não informada';
  const today = new Date();
  let years = today.getFullYear() - birth.getFullYear();
  let months = today.getMonth() - birth.getMonth();
  if (today.getDate() < birth.getDate()) months -= 1;
  if (months < 0) { years -= 1; months += 12; }
  if (years <= 0) return `${months} ${months === 1 ? 'mês' : 'meses'}`;
  return `${years} ${years === 1 ? 'ano' : 'anos'}${months ? ` e ${months} ${months === 1 ? 'mês' : 'meses'}` : ''}`;
};
const addressText = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.formatted || [value.street, value.number, value.complement, value.neighborhood, value.city, value.state, value.postalCode].filter(Boolean).join(', ');
};
const safeExternalUrl = (value) => {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
};
const jsonList = (value) => Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
const lines = (value) => String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
const currentUserId = () => state.context?.session?.user?.id || '';
const eventAcknowledgedByMe = (event) =>
  state.acknowledgedEventIds.has(event.id)
  || (event.event_acknowledgements || []).some((item) => item.user_id === currentUserId());
const eventAcknowledgementCount = (event) => {
  const ids = new Set((event.event_acknowledgements || []).map((item) => item.user_id));
  if (state.acknowledgedEventIds.has(event.id) && currentUserId()) ids.add(currentUserId());
  return ids.size;
};
const taskStatusLabel = (task) => {
  if (task.status === 'completed') return 'Concluído';
  if (task.status === 'unable') return 'Não foi possível';
  if (task.status === 'refused') return 'Recusado';
  if (task.status === 'cancelled') return 'Cancelado';
  if (task.status === 'in_progress') return 'Em andamento';
  if (new Date(task.due_at) < new Date()) return 'Atrasado';
  return 'Pendente';
};
const groupLabelForDate = (value) => {
  const date = startOfLocalDay(value);
  const today = startOfLocalDay();
  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(today, 7);
  if (date < today) return 'Atrasadas';
  if (date.getTime() === today.getTime()) return 'Hoje';
  if (date.getTime() === tomorrow.getTime()) return 'Amanhã';
  if (date < weekEnd) return 'Esta semana';
  return 'Próximos';
};
async function privateFileUrl(fileId) {
  if (!fileId) return '';
  if (state.privateUrls.has(fileId)) return state.privateUrls.get(fileId);
  const response = await openDocument(fileId);
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const data = await response.json();
    if (data.url) {
      state.privateUrls.set(fileId, data.url);
      return data.url;
    }
    return '';
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  state.privateUrls.set(fileId, url);
  return url;
}

const taskIsTerminal = (status) => ['completed', 'unable', 'refused', 'cancelled'].includes(status);
const taskKindLabel = (kind) => ({ medication: 'Medicamento', meal: 'Alimentação', sleep: 'Sono', hygiene: 'Higiene', routine: 'Rotina', other: 'Outro' })[kind] || 'Afazer';
const taskActualTime = (value) => value ? formatDate(value, { hour: '2-digit', minute: '2-digit' }) : '—';
const normalizeErrorMessage = (error) => {
  const raw = String(error?.message || error || '');
  const mapping = {
    task_photo_required: 'Tire uma foto antes de concluir.',
    task_note_required: 'Inclua uma observação antes de concluir.',
    task_start_required: 'Registre o início antes de concluir.',
    task_end_required: 'Registre o fim antes de concluir.',
    task_checklist_incomplete: 'Conclua todas as etapas antes de finalizar.',
    task_unavailable_reason_required: 'Explique por que não foi possível realizar o afazer.',
    task_already_started: 'Este afazer já foi iniciado.',
    task_not_started: 'Inicie o afazer antes de registrar o fim.',
  };
  return Object.entries(mapping).find(([key]) => raw.includes(key))?.[1] || raw || 'Não foi possível concluir a operação.';
};
const icon = (name) => ({
  home: '⌂', contacts: '◎', register: '+', agenda: '▣', more: '•••', files: '▤', recipes: '♨',
  medications: '✚', child: '♡', users: '♙', migration: '⇄', phone: '☎', whatsapp: '◉',
  edit: '✎', lock: '⌁', unlock: '✓', download: '↓', archive: '⌫', calendar: '▦',
  calendarAdd: '<svg class="calendar-add-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"></rect><path d="M7.5 3v4M16.5 3v4M3.5 9.5h17M12 12.5v5M9.5 15h5"></path></svg>', task: '✓',
  emergency: '!', history: '↺', plan: '☷', photo: '▧', note: '✎', check: '✓', log: '＋', timer: '◷', camera: '▣', template: '≡', hospital: '✚', info: 'i',
}[name] || '•');

function toast(message, type = 'info') {
  const region = document.querySelector('#next-toast-region');
  if (!region) return;
  const node = document.createElement('div');
  node.className = `toast${type === 'error' ? ' toast--error' : type === 'warning' ? ' toast--warning' : ''}`;
  node.textContent = message;
  region.append(node);
  setTimeout(() => node.remove(), 3500);
}

function setBusy(value, message = 'Processando…') {
  state.busy = value;
  let overlay = document.querySelector('#next-busy');
  if (value) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'next-busy';
      overlay.className = 'next-busy';
      overlay.innerHTML = `<div class="next-busy__card"><span class="next-spinner"></span><strong>${esc(message)}</strong></div>`;
      document.body.append(overlay);
    }
  } else {
    overlay?.remove();
  }
}

async function runBusy(work, successMessage) {
  if (state.busy) return;
  setBusy(true);
  try {
    const result = await work();
    if (successMessage) toast(successMessage);
    return result;
  } catch (error) {
    console.error(error);
    toast(normalizeErrorMessage(error), 'error');
    return null;
  } finally {
    setBusy(false);
  }
}

async function loadContext() {
  const session = await currentSession();
  if (!session) return null;
  const access = await supabase.rpc('my_access_context');
  if (access.error || !access.data?.active) return { session, blocked: true, reason: access.data?.reason || access.error?.message };
  const membership = {
    id: access.data.membership_id,
    family_id: access.data.family_id,
    role: access.data.role,
  };
  const [defaultRoleRows, familyRoleRows, memberRows] = await Promise.all([
    supabase.from('role_permissions').select('permission_code,allowed').eq('role', membership.role),
    supabase.from('family_role_permissions').select('permission_code,allowed').eq('family_id', membership.family_id).eq('role', membership.role),
    supabase.from('membership_permissions').select('permission_code,allowed').eq('membership_id', membership.id),
  ]);
  const rolePermissions = new Map((defaultRoleRows.data || []).map((item) => [item.permission_code, item]));
  for (const item of familyRoleRows.data || []) rolePermissions.set(item.permission_code, item);
  return {
    session,
    membership,
    profile: { display_name: access.data.display_name },
    can: createPermissionChecker({
      role: membership.role,
      rolePermissions: [...rolePermissions.values()],
      overrides: memberRows.data || [],
    }),
  };
}

function resetInactivity() {
  clearTimeout(state.timer);
  if (!state.context) return;
  state.timer = setTimeout(async () => {
    await signOut();
    state.context = null;
    state.page = 'home';
    await render();
    toast('A sessão foi encerrada por inatividade.', 'warning');
  }, INACTIVITY_MS);
}

function emptyState(title, text, action = '') {
  return `<section class="empty-state"><span>○</span><h2>${esc(title)}</h2><p>${esc(text)}</p>${action}</section>`;
}

function pageHeading(title, subtitle = '', action = '') {
  return `<section class="page-heading next-page-heading"><div><p class="eyebrow">App Maria Elis</p><h1>${esc(title)}</h1>${subtitle ? `<p class="muted">${esc(subtitle)}</p>` : ''}</div>${action}</section>`;
}

function navButton(page, label, iconName, primary = false) {
  const active = state.page === page;
  return `<button class="nav-item next-nav__item${active ? ' nav-item--active' : ''}${primary ? ' nav-item--primary' : ''}" data-page="${page}" aria-label="${esc(label)}" aria-current="${active ? 'page' : 'false'}"><span>${icon(iconName)}</span><small>${esc(label)}</small></button>`;
}

function navigation() {
  if (isCaregiver()) {
    return `<nav class="bottom-nav next-nav" aria-label="Navegação principal">
      ${navButton('home', 'Rotina', 'home')}
      ${navButton('register', 'Registrar', 'register', true)}
      ${navButton('agenda', 'Agenda', 'agenda')}
      ${navButton('emergency', 'Emergência', 'emergency')}
    </nav>`;
  }
  return `<nav class="bottom-nav next-nav" aria-label="Navegação principal">
    ${navButton('home', 'Rotina', 'home')}
    ${navButton('planning', 'Planejar', 'plan')}
    ${navButton('history', 'Histórico', 'history')}
    ${navButton('more', 'Mais', 'more')}
  </nav>`;
}

function topbar() {
  const display = state.context.profile.display_name || state.context.session.user.email;
  return `<header class="topbar next-topbar">
    <div class="topbar__identity"><div class="topbar__avatar next-avatar">ME</div><div><strong>Maria Elis</strong><p class="muted">${esc(roleLabel(state.context.membership.role))}</p></div></div>
    <div class="topbar__actions"><span class="next-user-name">${esc(display)}</span><button class="button button--secondary button--small" data-action="signout">Trocar usuário</button></div>
  </header>`;
}

function quickCard(page, iconName, title, text) {
  return `<button class="next-feature-card" data-page="${page}"><span>${icon(iconName)}</span><div><strong>${esc(title)}</strong><small>${esc(text)}</small></div><b>›</b></button>`;
}


function routineTaskCard(task, { planning = false } = {}) {
  const items = (task.care_task_items || []).sort((left, right) => left.position - right.position);
  const checked = items.filter((item) => item.completed).length;
  const overdue = !taskIsTerminal(task.status) && new Date(task.due_at) < new Date();
  const assignment = task.assigned_role === 'caregiver'
    ? 'Perfil Babá'
    : task.assigned_role === 'guardian'
      ? 'Responsáveis'
      : 'Toda a família';
  return `<button class="task-card routine-task-card${overdue ? ' routine-task-card--late' : ''}" data-task-open="${attr(task.id)}">
    <time class="task-card__time">${formatDate(task.due_at, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
    <div class="routine-task-card__body">
      <div class="task-card__meta"><span class="category-tag">${esc(taskKindLabel(task.task_kind))}</span><span class="routine-status">${esc(taskStatusLabel(task))}</span></div>
      <h2>${esc(task.title || 'Afazer')}</h2>
      ${task.planned_end_at ? `<small class="routine-time-range">Previsto: ${formatDate(task.due_at, { hour: '2-digit', minute: '2-digit' })}–${formatDate(task.planned_end_at, { hour: '2-digit', minute: '2-digit' })}</small>` : ''}
      ${task.instructions ? `<p>${esc(task.instructions)}</p>` : ''}
      ${planning ? `<small>Atribuído a: ${esc(assignment)}${task.requires_timer ? ' · início e fim obrigatórios' : ''}</small>` : ''}
      ${items.length ? `<small>${checked}/${items.length} etapas concluídas</small><span class="routine-progress"><i style="width:${Math.round((checked / items.length) * 100)}%"></i></span>` : ''}
    </div><b>›</b>
  </button>`;
}

function scheduleEventCard(event, { planning = false } = {}) {
  const acknowledged = eventAcknowledgedByMe(event);
  const count = eventAcknowledgementCount(event);
  const audience = event.audience_role === 'guardian' ? 'Responsáveis' : event.audience_role === 'all' ? 'Toda a família' : 'Perfil Babá';
  const when = event.all_day
    ? `${formatDate(event.starts_at, { weekday: 'short', day: '2-digit', month: '2-digit' })} · dia inteiro`
    : `${formatDate(event.starts_at, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${event.ends_at ? ` até ${formatDate(event.ends_at, { hour: '2-digit', minute: '2-digit' })}` : ''}`;
  const acknowledgement = isCaregiver() && event.requires_acknowledgement
    ? acknowledged
      ? `<span class="status-pill status-pill--success">Ciente</span>`
      : `<button type="button" class="button button--small" data-event-ack="${attr(event.id)}">Marcar como ciente</button>`
    : planning && event.requires_acknowledgement
      ? `<span class="status-pill status-pill--soft">${count ? `${count} confirmação(ões)` : 'Aguardando ciência'}</span>`
      : '';
  return `<article class="schedule-event-card">
    <button type="button" class="schedule-event-card__main" data-event-open="${attr(event.id)}" aria-label="Abrir ${attr(event.title || 'evento')}">
      <span class="schedule-event-card__icon">${icon('calendar')}</span>
      <span class="schedule-event-card__body">
        <span class="task-card__meta"><span class="category-tag">Agenda</span>${planning ? `<span class="routine-status">${esc(audience)}</span>` : ''}</span>
        <strong class="schedule-event-card__title">${esc(event.title || 'Evento')}</strong>
        <span>${esc(when)}</span>
        ${event.location ? `<small>${esc(event.location)}</small>` : ''}
        ${event.notes ? `<small>${esc(event.notes)}</small>` : ''}
      </span>
      <b aria-hidden="true">›</b>
    </button>
    <div class="schedule-event-card__actions">${acknowledgement}<button type="button" class="icon-button icon-button--calendar-add" data-ics="${attr(event.id)}" aria-label="Adicionar à agenda" title="Adicionar à agenda">${icon('calendarAdd')}</button></div>
  </article>`;
}

function groupedSchedule(items, planning = false) {
  const order = ['Atrasadas', 'Hoje', 'Amanhã', 'Esta semana', 'Próximos'];
  const groups = new Map(order.map((label) => [label, []]));
  items.forEach((item) => {
    const date = item.kind === 'task' ? item.row.due_at : item.row.starts_at;
    const ongoingEvent = item.kind === 'event'
      && new Date(item.row.starts_at) < startOfLocalDay()
      && item.row.ends_at
      && new Date(item.row.ends_at) >= startOfLocalDay();
    groups.get(ongoingEvent ? 'Hoje' : groupLabelForDate(date))?.push(item);
  });
  return order.map((label) => {
    const rows = groups.get(label) || [];
    if (!rows.length) return '';
    return `<section class="section-block schedule-group schedule-group--${label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '-')}">
      <div class="section-title"><h2>${esc(label)}</h2><span class="status-pill status-pill--soft">${rows.length}</span></div>
      <div class="task-list routine-task-list">${rows.map((entry) => entry.kind === 'task' ? routineTaskCard(entry.row, { planning }) : scheduleEventCard(entry.row, { planning })).join('')}</div>
    </section>`;
  }).join('');
}

async function homePage() {
  const today = startOfLocalDay();
  const [tasks, events] = await Promise.all([
    can('tasks.view') ? listOpenRoutineTasks({ includeAllAssignments: !isCaregiver() }) : [],
    can('events.view') ? listUpcomingEvents({ from: today.toISOString() }) : [],
  ]);
  const visibleEvents = events.filter((event) => {
    if (!isCaregiver()) return true;
    return event.audience_role === 'caregiver' || event.audience_role === 'all';
  });
  const entries = [
    ...tasks.map((row) => ({ kind: 'task', row, at: row.due_at })),
    ...visibleEvents.map((row) => ({ kind: 'event', row, at: row.starts_at })),
  ].sort((left, right) => new Date(left.at) - new Date(right.at));
  const display = state.context.profile.display_name || state.context.session.user.email;
  const pendingAcks = visibleEvents.filter((event) => event.requires_acknowledgement && !eventAcknowledgedByMe(event)).length;

  const primaryActions = isCaregiver()
    ? `<button class="quick-action quick-action--important" data-scroll-routine><span>${icon('task')}</span>Afazeres</button>
       <button class="quick-action quick-action--danger" data-page="emergency"><span>${icon('emergency')}</span>Emergência</button>
       <button class="quick-action" data-page="hospitals"><span>${icon('hospital')}</span>Hospitais</button>`
    : `<button class="quick-action" data-page="planning"><span>${icon('plan')}</span>Planejar</button>
       <button class="quick-action" data-page="history"><span>${icon('history')}</span>Histórico</button>
       <button class="quick-action quick-action--danger" data-page="emergency"><span>${icon('emergency')}</span>Emergência</button>`;

  const schedule = entries.length
    ? `<div id="routine-schedule">${groupedSchedule(entries)}</div>`
    : `<section id="routine-schedule" class="section-block">${emptyState('Nada pendente', isCaregiver() ? 'Não há afazeres pendentes nem eventos futuros atribuídos ao seu perfil.' : 'A rotina ainda não possui afazeres pendentes ou eventos futuros.', canManage('tasks.manage') ? '<button class="button" data-page="planning">Planejar a semana</button>' : '')}</section>`;

  return `<section class="hero-card next-hero"><div class="hero-card__copy"><span class="status-pill">${esc(roleLabel(state.context.membership.role))}</span><h2>Olá, ${esc(display)}</h2><p>${tasks.length ? `${tasks.length} afazer(es) pendente(s).` : 'Nenhum afazer pendente.'}${pendingAcks ? ` ${pendingAcks} evento(s) aguardam sua confirmação.` : ''}</p></div><div class="next-hero__date"><strong>${formatDate(new Date(), { day: '2-digit' })}</strong><small>${formatDate(new Date(), { month: 'short' })}</small></div></section>
    <section class="quick-actions next-quick-actions routine-primary-actions caregiver-shortcuts">${primaryActions}</section>
    ${schedule}`;
}

async function planningPage() {
  if (!canManage('tasks.manage')) return denyPage();
  const today = startOfLocalDay();
  const [tasks, events] = await Promise.all([
    listOpenRoutineTasks({ includeAllAssignments: true }),
    listUpcomingEvents({ from: today.toISOString() }),
  ]);
  const entries = [
    ...tasks.map((row) => ({ kind: 'task', row, at: row.due_at })),
    ...events.map((row) => ({ kind: 'event', row, at: row.starts_at })),
  ].sort((left, right) => new Date(left.at) - new Date(right.at));
  const list = entries.length
    ? groupedSchedule(entries.map((entry) => ({ ...entry, row: entry.row })), true)
    : emptyState('Nada planejado', 'Cadastre afazeres ou avisos para preparar a semana inteira.', '<button class="button" data-action="new-task">Novo afazer</button>');
  const actions = `<div class="heading-actions"><button class="button button--secondary button--small" data-page="templates">Títulos e regras</button><button class="button button--secondary button--small" data-action="new-event">Novo evento ou aviso</button><button class="button button--small" data-action="new-task">Novo afazer</button></div>`;
  return `${pageHeading('Planejar', 'Prepare a semana inteira. Tudo fica visível para a babá assim que for salvo.', actions)}
    <section class="planning-view-hint"><span class="status-pill status-pill--success">Lista completa</span><p>Afazeres concluídos saem desta tela e permanecem no Histórico.</p></section>
    <section class="planning-schedule">${list}</section>`;
}

async function templatesPage() {
  if (!canManage('tasks.manage')) return denyPage();
  const templates = await listRoutineTemplates();
  const list = templates.length ? templates.map((template) => {
    const steps = (template.routine_template_items || []).filter((item) => item.active !== false).sort((a, b) => a.position - b.position);
    const requirements = [
      template.requires_timer ? 'início e fim' : '',
      template.requires_photo ? 'foto' : '',
      template.requires_note ? 'observação' : '',
    ].filter(Boolean).join(', ');
    return `<button class="record-card record-card--button template-card" data-template-edit="${attr(template.id)}"><span class="record-card__icon">${icon('template')}</span><div><h2>${esc(template.title)}</h2><p>${steps.length ? `${steps.length} etapa(s) padrão` : 'Sem etapas padrão'}</p><small>${requirements ? `Exige ${esc(requirements)}` : 'Registros opcionais'}${template.instructions ? ' · possui orientações' : ''}</small></div><b>›</b></button>`;
  }).join('') : emptyState('Nenhum título cadastrado', 'Crie títulos como Almoço, Lanche, Soneca e Medicamento.', '<button class="button" data-action="new-template">Cadastrar título</button>');
  return `${pageHeading('Títulos e regras padrão', 'Cada título pode preencher automaticamente orientações, etapas e exigências.', '<button class="button button--small" data-action="new-template">Cadastrar título</button>')}<section class="instruction-box instruction-box--neutral"><strong>Onde colocar regras como “não usar o celular”?</strong><p>Use o campo Orientações obrigatórias. As etapas devem ser ações que a babá marca como realizadas.</p></section><section class="record-list next-record-list">${list}</section>`;
}

async function registerPage() {
  if (!can('daily_logs.create')) return denyPage();
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const logs = await listDailyLogs(start.toISOString(), end.toISOString());
  const categories = [
    ['feeding', 'Alimentação'], ['sleep', 'Sono'], ['diaper', 'Fralda'],
    ['bath', 'Banho'], ['mood', 'Humor'], ['symptom', 'Sintoma'],
    ['incident', 'Ocorrência'], ['walk', 'Passeio'], ['other', 'Outro'],
  ];
  const recent = logs.length ? logs.map((log) => `<article class="record-card"><span class="record-card__icon">${icon('log')}</span><div><h2>${esc(log.title || categoryLabel(log.category))}</h2><p>${esc(log.note || 'Sem observação')}</p><small>${formatDate(log.occurred_at, { hour: '2-digit', minute: '2-digit' })}</small></div>${log.photo_file_id ? `<button class="icon-button" data-file-open="${attr(log.photo_file_id)}" aria-label="Abrir foto">${icon('photo')}</button>` : ''}</article>`).join('') : emptyState('Nenhum registro hoje', 'Use os botões acima para contar o que aconteceu durante o dia.');
  return `${pageHeading('Registrar o dia', 'Alimentação, sono, humor, sintomas, ocorrências e fotos.')}
    <section class="daily-log-categories">${categories.map(([value, label]) => `<button class="daily-log-category" data-new-log="${value}"><span>${icon(value === 'symptom' || value === 'incident' ? 'emergency' : 'log')}</span>${esc(label)}</button>`).join('')}</section>
    <section class="section-block"><div class="section-title"><h2>Registros de hoje</h2></div><div class="record-list">${recent}</div></section>`;
}

function categoryLabel(value) {
  return ({ feeding: 'Alimentação', sleep: 'Sono', diaper: 'Fralda', bath: 'Banho', mood: 'Humor', symptom: 'Sintoma', incident: 'Ocorrência', walk: 'Passeio', other: 'Outro' })[value] || 'Registro';
}

async function historyPage() {
  if (!can('daily_logs.view') && !can('tasks.view')) return denyPage();
  const today = endOfLocalDay();
  if (!state.historyTo) state.historyTo = dateOnly(today);
  if (!state.historyFrom) state.historyFrom = dateOnly(addDays(today, -30));
  const start = startOfLocalDay(`${state.historyFrom}T12:00:00`);
  const end = endOfLocalDay(`${state.historyTo}T12:00:00`);
  const [logs, terminalTasks, events] = await Promise.all([
    can('daily_logs.view') ? listDailyLogs(start.toISOString(), end.toISOString()) : [],
    can('tasks.view') ? listRoutineTasks(null, null, {
      includeAllAssignments: true,
      statuses: ['completed', 'unable', 'refused', 'cancelled'],
      limit: 1000,
    }) : [],
    can('events.view') ? listUpcomingEvents({ from: start.toISOString(), to: end.toISOString(), limit: 1000 }) : [],
  ]);
  const tasks = terminalTasks.filter((row) => {
    const at = new Date(row.completed_at || row.updated_at || row.due_at);
    return at >= start && at <= end;
  });
  const allEntries = [
    ...logs.map((row) => ({ at: row.occurred_at, type: 'log', row })),
    ...tasks.map((row) => ({ at: row.completed_at || row.updated_at || row.due_at, type: 'task', row })),
    ...events.map((row) => ({ at: row.starts_at, type: 'event', row })),
  ];
  const entries = allEntries
    .filter((entry) => state.historyType === 'all' || entry.type === state.historyType)
    .sort((left, right) => new Date(right.at) - new Date(left.at));

  const days = new Map();
  entries.forEach((entry) => {
    const key = dateOnly(entry.at);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(entry);
  });
  const list = entries.length
    ? [...days.entries()].map(([day, rows]) => `<section class="history-day"><div class="section-title"><h2>${formatDate(`${day}T12:00:00`, { weekday: 'long', day: '2-digit', month: 'long' })}</h2><span class="status-pill status-pill--soft">${rows.length}</span></div><div class="history-list">${rows.map((entry) => entry.type === 'log'
      ? `<article class="history-entry"><time>${formatDate(entry.at, { hour: '2-digit', minute: '2-digit' })}</time><span>${icon('log')}</span><div><strong>${esc(entry.row.title || categoryLabel(entry.row.category))}</strong><p>${esc(entry.row.note || '')}</p></div>${entry.row.photo_file_id ? `<button class="icon-button" data-file-open="${attr(entry.row.photo_file_id)}">${icon('photo')}</button>` : ''}</article>`
      : entry.type === 'event'
        ? `<button class="history-entry history-entry--button" data-event-open="${attr(entry.row.id)}"><time>${formatDate(entry.at, { hour: '2-digit', minute: '2-digit' })}</time><span>${icon('calendar')}</span><div><strong>${esc(entry.row.title)}</strong><p>${esc(entry.row.location || 'Evento ou aviso')}${entry.row.requires_acknowledgement ? ` · ${eventAcknowledgementCount(entry.row)} confirmação(ões)` : ''}</p></div><b>›</b></button>`
        : `<button class="history-entry history-entry--button" data-task-open="${attr(entry.row.id)}"><time>${formatDate(entry.at, { hour: '2-digit', minute: '2-digit' })}</time><span>${icon('task')}</span><div><strong>${esc(entry.row.title)}</strong><p>${esc(taskStatusLabel(entry.row))}${entry.row.note ? ` · ${esc(entry.row.note)}` : ''}</p></div><b>›</b></button>`).join('')}</div></section>`).join('')
    : emptyState('Sem registros no período', 'Altere as datas ou aguarde a conclusão de afazeres.');

  const filters = `<form id="history-filter-form" class="history-filters"><label>De<input name="from" type="date" value="${attr(state.historyFrom)}" required></label><label>Até<input name="to" type="date" value="${attr(state.historyTo)}" required></label><label>Mostrar<select name="type"><option value="all"${state.historyType === 'all' ? ' selected' : ''}>Tudo</option><option value="task"${state.historyType === 'task' ? ' selected' : ''}>Afazeres</option><option value="log"${state.historyType === 'log' ? ' selected' : ''}>Registros do dia</option><option value="event"${state.historyType === 'event' ? ' selected' : ''}>Eventos e avisos</option></select></label><button class="button button--small">Aplicar</button><div class="history-presets"><button type="button" class="button button--secondary button--small" data-history-days="7">7 dias</button><button type="button" class="button button--secondary button--small" data-history-days="30">30 dias</button><button type="button" class="button button--secondary button--small" data-history-days="365">1 ano</button></div></form>`;
  return `${pageHeading('Histórico', 'Afazeres concluídos, impedimentos e registros do dia.')} ${filters}<section class="history-results">${list}</section>`;
}

async function emergencyPage() {
  if (!can('child.view') && !can('contacts.view')) return denyPage();
  const familyId = state.context.membership.family_id;
  const [childResult, contactsResult, hospitals] = await Promise.all([
    can('child.view') ? supabase.from('child_profiles').select('*').eq('family_id', familyId).maybeSingle() : Promise.resolve({ data: null }),
    can('contacts.view') ? supabase.from('contacts').select('*').eq('family_id', familyId).eq('active', true).order('emergency_order', { ascending: true, nullsFirst: false }).order('full_name') : Promise.resolve({ data: [] }),
    can('child.view') ? listEmergencyHospitals() : [],
  ]);
  if (childResult.error) throw childResult.error;
  if (contactsResult.error) throw contactsResult.error;
  const data = childResult.data?.data || {};
  const contacts = (contactsResult.data || []).filter((contact) => contact.emergency_order || /pediatra|médic|medic|hospital|emerg|mãe|pai|mae/i.test(`${contact.relationship_type} ${contact.notes}`));
  const childPhoto = data.photoFileId ? await privateFileUrl(data.photoFileId).catch(() => '') : '';
  const cardPhoto = data.healthCardFileId ? await privateFileUrl(data.healthCardFileId).catch(() => '') : '';
  const editAction = canManage('child.edit') ? `<div class="emergency-actions"><button class="button button--small" data-child-edit="${attr(childResult.data?.id || '')}">Editar informações</button><button class="button button--secondary button--small" data-action="new-hospital">Cadastrar hospital</button></div>` : '';
  return `${pageHeading('Emergência', 'Informações essenciais para agir rapidamente.', editAction)}
    <section class="emergency-child-summary">
      ${childPhoto ? `<img src="${attr(childPhoto)}" alt="Foto de ${attr(data.name || 'Maria Elis')}" class="emergency-child-photo">` : `<div class="person-avatar person-avatar--large">${initials(data.name || 'Maria Elis')}</div>`}
      <div><h2>${esc(data.name || 'Maria Elis')}</h2><p>${data.birthDate ? `${esc(calculateAge(data.birthDate))} · ` : ''}Tipo sanguíneo: <strong>${esc(data.bloodType || 'Não informado')}</strong></p><p>${data.motherName ? `Mãe: ${esc(data.motherName)}` : ''}${data.motherName && data.fatherName ? ' · ' : ''}${data.fatherName ? `Pai: ${esc(data.fatherName)}` : ''}</p></div>
      <button class="button button--secondary button--small" data-page="home">Voltar aos afazeres</button>
    </section>
    ${data.allergies ? `<section class="emergency-alert"><strong>ALERGIAS</strong><p>${esc(data.allergies)}</p></section>` : `<section class="emergency-alert emergency-alert--neutral"><strong>Alergias</strong><p>Nenhuma informação cadastrada.</p></section>`}
    <section class="emergency-grid">
      <article class="emergency-card"><h2>Informações médicas</h2><dl class="detail-list"><div><dt>Condições importantes</dt><dd>${esc(data.medicalConditions || 'Não informado')}</dd></div><div><dt>Plano de saúde</dt><dd>${esc(data.healthPlan || 'Não informado')}${data.healthPlanNumber ? ` · ${esc(data.healthPlanNumber)}` : ''}</dd></div><div><dt>Orientações de emergência</dt><dd>${esc(data.emergencyInstructions || 'Nenhuma orientação cadastrada.')}</dd></div></dl>${cardPhoto ? `<button class="health-card-preview" data-file-open="${attr(data.healthCardFileId)}"><img src="${attr(cardPhoto)}" alt="Carteirinha do plano de saúde"><span>Ver carteirinha</span></button>` : ''}</article>
      <article class="emergency-card"><h2>Contatos de emergência</h2>${contacts.length ? contacts.map((contact) => `<div class="emergency-contact"><div><strong>${esc(contact.full_name)}</strong><small>${esc(contact.relationship_type || 'Contato')}</small></div><div>${contact.phone_normalized ? `<a class="emergency-call" href="tel:${attr(contact.phone_normalized)}">${icon('phone')} Ligar</a>` : ''}${contact.whatsapp_normalized ? `<a class="emergency-whatsapp" href="https://wa.me/55${attr(contact.whatsapp_normalized)}" target="_blank" rel="noopener">${icon('whatsapp')} WhatsApp</a>` : ''}</div></div>`).join('') : '<p class="permission-note">Nenhum contato de emergência cadastrado.</p>'}</article>
    </section>
    <section class="section-block"><div class="section-title"><h2>Hospitais cadastrados</h2><button class="button button--secondary button--small" data-page="hospitals">Abrir lista completa</button></div><div class="record-list">${hospitals.length ? hospitals.slice(0, 3).map((hospital) => `<article class="hospital-card"><div><strong>${esc(hospital.name)}</strong><p>${esc(hospital.address || '')}</p>${hospital.notes ? `<small>${esc(hospital.notes)}</small>` : ''}</div><div>${hospital.phone_normalized ? `<a class="button button--secondary button--small" href="tel:${attr(hospital.phone_normalized)}">Ligar</a>` : ''}${hospital.address ? `<a class="button button--small" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(hospital.address)}" target="_blank" rel="noopener">Mapa</a>` : ''}</div></article>`).join('') : emptyState('Nenhum hospital cadastrado', 'Cadastre os hospitais de preferência para acesso rápido.')}</div></section>`;
}

async function hospitalsPage() {
  if (!can('child.view')) return denyPage();
  const hospitals = await listEmergencyHospitals();
  const action = canManage('child.edit') ? '<button class="button button--small" data-action="new-hospital">Cadastrar hospital</button>' : '';
  const list = hospitals.length ? hospitals.map((hospital) => `<article class="hospital-card hospital-card--large"><div><span class="record-card__icon">${icon('hospital')}</span><strong>${esc(hospital.name)}</strong><p>${esc(hospital.address || 'Endereço não informado')}</p>${hospital.notes ? `<small>${esc(hospital.notes)}</small>` : ''}</div><div>${hospital.phone_normalized ? `<a class="button button--secondary" href="tel:${attr(hospital.phone_normalized)}">${icon('phone')} Ligar</a>` : ''}${hospital.address ? `<a class="button" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(hospital.address)}" target="_blank" rel="noopener">Abrir mapa</a>` : ''}</div></article>`).join('') : emptyState('Nenhum hospital cadastrado', 'Os responsáveis ainda não cadastraram hospitais.');
  return `${pageHeading('Hospitais', 'Acesso rápido a telefone, endereço e mapa.', action)}<section class="caregiver-return-bar"><button class="button button--secondary" data-page="home">Voltar aos afazeres</button><button class="button button--danger" data-page="emergency">Informações de emergência</button></section><section class="record-list next-record-list">${list}</section>`;
}

async function taskModalData() {
  const templates = await listRoutineTemplates();
  return { templates };
}

function taskModal(data = {}) {
  const templates = data.templates || [];
  const local = new Date(Date.now() + 5 * 60000);
  const options = templates.map((template) => `<option value="${attr(template.id)}"${template.id === data.templateId ? ' selected' : ''}>${esc(template.title)}</option>`).join('');
  const serialized = esc(JSON.stringify(templates.map((template) => ({
    id: template.id,
    title: template.title,
    task_kind: template.task_kind,
    instructions: template.instructions || '',
    requires_photo: Boolean(template.requires_photo),
    requires_note: Boolean(template.requires_note),
    requires_timer: Boolean(template.requires_timer),
    steps: (template.routine_template_items || []).filter((item) => item.active !== false).sort((a, b) => a.position - b.position).map((item) => item.label),
  }))));
  return `<div class="modal-backdrop"><section class="modal modal--wide" role="dialog" aria-modal="true" data-modal-panel><button type="button" class="modal__close" data-action="close-modal" aria-label="Fechar">×</button><h2>Novo afazer</h2><form id="task-form" data-templates="${serialized}"><label>Título<select name="template_id" id="task-template" required><option value="">Escolha um título</option>${options}<option value="custom">Outro título</option></select></label><label id="task-custom-title-wrap" hidden>Título personalizado<input name="custom_title" id="task-custom-title" placeholder="Digite o título"></label><div class="form-grid"><label>Data<input name="date" type="date" required value="${local.toISOString().slice(0, 10)}"></label><label>Hora de início<input name="time" type="time" required value="${local.toISOString().slice(11, 16)}"></label></div><div class="form-grid"><label>Hora prevista para terminar <small>(opcional)</small><input name="end_time" type="time"></label><label>Atribuir a<select name="assigned_role"><option value="caregiver">Perfil Babá</option><option value="guardian">Responsáveis</option><option value="all">Toda a família</option></select></label></div><label>Orientações obrigatórias<textarea name="instructions" id="task-instructions" placeholder="Regras que não são marcadas como etapa. Ex.: não usar o celular durante a refeição."></textarea></label><label>Etapas<textarea name="checklist" id="task-checklist" placeholder="Uma etapa por linha&#10;Lavar as mãos&#10;Oferecer a refeição&#10;Dar água"></textarea></label><div class="requirement-grid"><label class="check-line"><input name="requires_timer" id="task-requires-timer" type="checkbox"> Exigir registro de início e fim</label><label class="check-line"><input name="requires_photo" id="task-requires-photo" type="checkbox"> Exigir foto</label><label class="check-line"><input name="requires_note" id="task-requires-note" type="checkbox"> Exigir observação</label></div><p class="permission-note">Quando foto ou observação não forem exigidas, continuam disponíveis como opcionais. Soneca sempre exige início e fim.</p><div class="next-form-actions"><button type="button" class="button button--secondary" data-action="close-modal">Cancelar</button><button class="button">Salvar afazer</button></div></form></section></div>`;
}

function routineTemplateModal(template = {}) {
  const items = (template.routine_template_items || []).filter((item) => item.active !== false).sort((a, b) => a.position - b.position);
  return `<div class="modal-backdrop"><section class="modal modal--wide" role="dialog" aria-modal="true" data-modal-panel><button type="button" class="modal__close" data-action="close-modal" aria-label="Fechar">×</button><h2>${template.id ? 'Editar título e regras' : 'Cadastrar título e regras'}</h2><form id="routine-template-form"><input type="hidden" name="id" value="${attr(template.id || '')}"><label>Título<input name="title" required value="${attr(template.title || '')}" placeholder="Ex.: Almoço, Lanche, Soneca"></label><label>Orientações obrigatórias<textarea name="instructions" placeholder="Ex.: não usar o celular durante a refeição.">${esc(template.instructions || '')}</textarea></label><label>Etapas padrão<textarea name="checklist" placeholder="Uma ação por linha.">${esc(items.map((item) => item.label).join('\n'))}</textarea></label><div class="requirement-grid"><label class="check-line"><input name="requires_timer" type="checkbox"${template.requires_timer ? ' checked' : ''}> Exigir início e fim</label><label class="check-line"><input name="requires_photo" type="checkbox"${template.requires_photo ? ' checked' : ''}> Exigir foto</label><label class="check-line"><input name="requires_note" type="checkbox"${template.requires_note ? ' checked' : ''}> Exigir observação</label></div><p class="permission-note">Títulos com a palavra “Soneca” sempre exigirão início e fim.</p><div class="next-form-actions"><button type="button" class="button button--secondary" data-action="close-modal">Cancelar</button><button class="button">Salvar padrão</button></div></form></section></div>`;
}

function taskDetailsModal(task) {
  const items = (task.care_task_items || []).sort((a, b) => a.position - b.position);
  const updates = task.care_task_updates || [];
  const terminal = taskIsTerminal(task.status);
  const started = Boolean(task.started_at);
  const ended = Boolean(task.ended_at);
  const allItemsDone = !items.length || items.every((item) => item.completed);
  const timerLabel = task.requires_timer ? 'Início e fim obrigatórios.' : 'Início e fim são opcionais.';
  const timerActions = !terminal && can('tasks.complete') ? `<section class="task-timer-card"><div><strong>Tempo real</strong><p>Início: ${taskActualTime(task.started_at)} · Fim: ${taskActualTime(task.ended_at)}</p><small>${esc(timerLabel)}</small></div><div class="task-timer-actions">${!started ? `<button type="button" class="button" data-task-timer="start">${icon('timer')} Iniciar</button>` : !ended ? `<button type="button" class="button button--secondary" data-task-timer="stop">${icon('timer')} Parar</button>` : '<span class="status-pill status-pill--success">Tempo registrado</span>'}</div></section>` : (started || ended ? `<section class="task-timer-card"><div><strong>Tempo real</strong><p>Início: ${taskActualTime(task.started_at)} · Fim: ${taskActualTime(task.ended_at)}</p></div></section>` : '');
  return `<div class="modal-backdrop"><section class="modal modal--wide" role="dialog" aria-modal="true" data-modal-panel><button type="button" class="modal__close" data-action="close-modal" aria-label="Fechar">×</button><div class="task-detail-heading"><div><p class="eyebrow">${formatDate(task.due_at, { weekday: 'long', hour: '2-digit', minute: '2-digit' })}${task.planned_end_at ? ` até ${formatDate(task.planned_end_at, { hour: '2-digit', minute: '2-digit' })}` : ''}</p><h2>${esc(task.title)}</h2></div><span class="status-pill">${esc(task.status === 'completed' ? 'Concluído' : task.status === 'unable' ? 'Não foi possível' : task.status === 'in_progress' ? 'Em andamento' : 'Pendente')}</span></div>${task.instructions ? `<section class="instruction-box"><strong>Orientações obrigatórias</strong><p>${esc(task.instructions)}</p></section>` : ''}${timerActions}${items.length ? `<section class="task-checklist"><h3>Etapas</h3>${items.map((item) => `<label class="task-check-item"><input type="checkbox" data-task-item="${attr(item.id)}"${item.completed ? ' checked' : ''}${terminal ? ' disabled' : ''}><span>${esc(item.label)}</span></label>`).join('')}</section>` : ''}${updates.length ? `<section class="task-updates"><h3>Registros</h3>${updates.map((update) => `<article><small>${formatDate(update.created_at, { hour: '2-digit', minute: '2-digit' })}</small><p>${esc(update.note || (update.status === 'completed' ? 'Afazer concluído.' : update.status === 'unable' ? 'Não foi possível concluir.' : 'Andamento registrado.'))}</p>${update.file_id ? `<button class="text-button" data-file-open="${attr(update.file_id)}">Ver foto</button>` : ''}</article>`).join('')}</section>` : ''}${!terminal && can('tasks.complete') ? `<form id="task-response-form"><input type="hidden" name="taskId" value="${attr(task.id)}"><label>Observação<textarea name="note" placeholder="Conte como foi ou informe algo importante."></textarea></label><div class="camera-field"><input id="task-photo" class="visually-hidden" type="file" accept="image/*" capture="environment"><label for="task-photo" class="camera-button"><span>${icon('camera')}</span><strong>Tirar foto</strong><small>Usar a câmera do celular</small></label><div id="task-photo-preview" class="file-preview" hidden></div></div><div class="requirement-summary"><p>${task.requires_photo ? '<strong>Foto obrigatória.</strong>' : 'Foto opcional.'}</p><p>${task.requires_note ? '<strong>Observação obrigatória.</strong>' : 'Observação opcional.'}</p><p>${task.requires_timer ? '<strong>Início e fim obrigatórios.</strong>' : 'Início e fim opcionais.'}</p>${items.length ? `<p>${allItemsDone ? 'Todas as etapas foram concluídas.' : '<strong>Conclua todas as etapas antes de finalizar.</strong>'}</p>` : ''}</div><div class="next-form-actions next-form-actions--spread"><button type="button" class="button button--danger" data-task-response="unable">Não foi possível</button><button type="button" class="button button--secondary" data-task-response="in_progress">Registrar andamento</button><button type="button" class="button" data-task-response="completed">Concluir</button></div></form>` : '<div class="next-form-actions"><button type="button" class="button button--secondary" data-action="close-modal">Fechar</button></div>'}</section></div>`;
}

function dailyLogModal(category = 'other') {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" data-modal-panel><button type="button" class="modal__close" data-action="close-modal" aria-label="Fechar">×</button><h2>${esc(categoryLabel(category))}</h2><form id="daily-log-form"><input type="hidden" name="category" value="${attr(category)}"><label>Horário<input name="occurred_at" type="datetime-local" required value="${attr(local)}"></label><label>Título<input name="title" placeholder="Opcional"></label><label>O que aconteceu?<textarea name="note" required placeholder="Descreva de forma simples."></textarea></label>${renderFilePicker({ id: 'daily-log-photo', label: 'Adicionar foto', accept: 'image/*', avatar: true })}<div class="next-form-actions"><button type="button" class="button button--secondary" data-action="close-modal">Cancelar</button><button class="button">Salvar registro</button></div></form></section></div>`;
}

function hospitalModal() {
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" data-modal-panel><button type="button" class="modal__close" data-action="close-modal" aria-label="Fechar">×</button><h2>Cadastrar hospital</h2><form id="hospital-form"><label>Nome<input name="name" required></label><label>Telefone<input name="phone" inputmode="tel"></label><label>Endereço<input name="address"></label><label>Observações<textarea name="notes" placeholder="Ex.: pronto-socorro infantil 24 horas"></textarea></label><label>Prioridade<input name="priority" type="number" min="1" max="20" value="1"></label><div class="next-form-actions"><button type="button" class="button button--secondary" data-action="close-modal">Cancelar</button><button class="button">Salvar hospital</button></div></form></section></div>`;
}

async function contactsPage() {
  if (!can('contacts.view')) return denyPage();
  const result = await supabase.from('contacts').select('*').eq('family_id', state.context.membership.family_id).order('emergency_order', { ascending: true, nullsFirst: false }).order('full_name');
  if (result.error) throw result.error;
  const rows = result.data || [];
  const canEditContacts = canManage('contacts.edit');
  const action = canManage('contacts.create') ? '<button class="button button--small" data-action="new-contact">Registrar</button>' : '';
  const list = rows.length ? rows.map((row) => {
    const phone = row.phone_normalized || row.whatsapp_normalized || '';
    const main = canEditContacts
      ? `<button class="person-card__main" data-contact-edit="${attr(row.id)}"><span class="person-avatar">${initials(row.full_name)}</span><span><strong>${esc(row.full_name)}</strong><small>${esc(row.relationship_type || 'Contato')}${phone ? ` · ${esc(formatPhone(phone))}` : ''}</small></span><b>›</b></button>`
      : `<div class="person-card__main person-card__main--readonly"><span class="person-avatar">${initials(row.full_name)}</span><span><strong>${esc(row.full_name)}</strong><small>${esc(row.relationship_type || 'Contato')}${phone ? ` · ${esc(formatPhone(phone))}` : ''}</small></span></div>`;
    return `<article class="person-card${row.active === false ? ' person-card--inactive' : ''}">${main}<div class="person-card__quick">${row.phone_normalized ? `<a href="tel:${attr(row.phone_normalized)}" aria-label="Ligar para ${attr(row.full_name)}">${icon('phone')}</a>` : ''}${row.whatsapp_normalized ? `<a href="https://wa.me/55${attr(row.whatsapp_normalized)}" target="_blank" rel="noopener" aria-label="WhatsApp de ${attr(row.full_name)}">${icon('whatsapp')}</a>` : ''}</div></article>`;
  }).join('') : emptyState('Nenhum contato', canManage('contacts.create') ? 'Cadastre familiares, médicos e pessoas de confiança.' : 'Nenhum contato foi cadastrado.', action);
  return `${pageHeading('Contatos', 'Familiares, responsáveis, médicos e emergências.', action)}<section class="record-list next-record-list">${list}</section>`;
}

function contactModal(data = {}) {
  const editing = Boolean(data.id);
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="contact-title" data-modal-panel><button type="button" class="modal__close" data-action="close-modal" aria-label="Fechar">×</button><h2 id="contact-title">${editing ? 'Editar contato' : 'Novo contato'}</h2><form id="contact-form"><input type="hidden" name="id" value="${attr(data.id || '')}"><div class="form-grid"><label>Nome completo<input name="full_name" value="${attr(data.full_name || '')}" required autocomplete="name"></label><label>Vínculo<input name="relationship_type" value="${attr(data.relationship_type || '')}" placeholder="Ex.: Avó, pediatra"></label></div><div class="form-grid"><label>Telefone<input name="phone_normalized" inputmode="tel" value="${attr(formatPhone(data.phone_normalized))}" placeholder="(11) 99999-9999"></label><label>WhatsApp<input name="whatsapp_normalized" inputmode="tel" value="${attr(formatPhone(data.whatsapp_normalized))}" placeholder="(11) 99999-9999"></label></div><label>E-mail<input name="email" type="email" value="${attr(data.email || '')}"></label><div class="form-grid"><label>Prioridade de emergência<input name="emergency_order" type="number" min="1" max="99" value="${attr(data.emergency_order || '')}"></label><label>Status<select name="active"><option value="true"${data.active !== false ? ' selected' : ''}>Ativo</option><option value="false"${data.active === false ? ' selected' : ''}>Inativo</option></select></label></div><div class="profile-photo-row"><div class="person-avatar person-avatar--large" id="contact-photo-placeholder">${initials(data.full_name)}</div><div><strong>Foto do contato</strong><p>A foto será recortada no aparelho antes do envio.</p><input id="contact-photo" name="photo" type="file" accept="image/*"></div></div><label>Zoom da foto<input id="contact-zoom" type="range" min="1" max="3" step=".1" value="1"></label><img id="contact-photo-preview" class="next-photo-preview" alt="Prévia da foto" hidden><div class="next-form-actions"><button type="button" class="button button--secondary" data-action="close-modal">Cancelar</button><button class="button">${editing ? 'Salvar alterações' : 'Cadastrar contato'}</button></div></form></section></div>`;
}

async function usersPage() {
  if (!can('users.manage')) return denyPage();
  let users = [];
  let errorMessage = '';
  try {
    const result = await listUsers();
    users = result.users || [];
  } catch (error) {
    errorMessage = error.message;
  }
  const cards = await Promise.all(users.map(async (user) => {
    const id = user.user_id || user.id || '';
    const display = user.display_name || user.preferred_name || user.email || 'Pessoa sem nome';
    const blocked = Boolean(user.blocked || user.blocked_until || user.active === false);
    const avatarUrl = user.avatar_file_id ? await privateFileUrl(user.avatar_file_id).catch(() => '') : '';
    const phone = formatPhone(user.phone_normalized || user.whatsapp_normalized || '');
    return `<button type="button" class="record-card record-card--button next-user-card next-user-card--clickable" data-user-open="${attr(id)}">
      ${avatarUrl ? `<img class="person-avatar person-avatar--image" src="${attr(avatarUrl)}" alt="Foto de ${attr(display)}">` : `<span class="person-avatar">${initials(display)}</span>`}
      <div><h2>${esc(display)}</h2><p>${esc(user.email || 'E-mail não informado')} · ${esc(roleLabel(user.role))}</p><small>${phone ? `${esc(phone)} · ` : ''}${blocked ? 'Acesso bloqueado' : 'Acesso ativo'}</small></div>
      <b>›</b>
    </button>`;
  }));
  const list = cards.length ? cards.join('') : emptyState('Nenhum usuário listado', errorMessage || 'Adicione um responsável ou cuidador para acessar o aplicativo.', '<button class="button" data-action="new-user">Adicionar usuário</button>');
  return `${pageHeading('Usuários', 'Clique em qualquer parte do cartão para abrir o cadastro completo.', '<button class="button button--small" data-action="new-user">Adicionar</button>')}<section class="record-list next-record-list">${list}</section>`;
}

function userModal(record = {}) {
  const editing = Boolean(record.user_id || record.id);
  const id = record.user_id || record.id || '';
  const displayName = record.display_name || '';
  const address = addressText(record.address);
  const blocked = Boolean(record.blocked || record.blocked_until || record.active === false);
  const avatar = record.avatarUrl
    ? `<img class="profile-editor-photo" src="${attr(record.avatarUrl)}" alt="Foto de ${attr(displayName || 'usuário')}">`
    : `<div class="profile-editor-photo profile-editor-photo--placeholder">${initials(displayName || 'Pessoa')}</div>`;
  return `<div class="modal-backdrop"><section class="modal modal--wide" role="dialog" aria-modal="true" data-modal-panel>
    <button type="button" class="modal__close" data-action="close-modal" aria-label="Fechar">×</button>
    <h2>${editing ? 'Cadastro da pessoa' : 'Nova pessoa'}</h2>
    <form id="user-form">
      <input type="hidden" name="userId" value="${attr(id)}">
      <section class="profile-editor-head">${avatar}<div>${renderFilePicker({ id: 'user-photo', label: editing ? 'Alterar foto' : 'Adicionar foto', accept: 'image/*' })}</div></section>
      <div class="form-grid"><label>Nome completo<input name="displayName" value="${attr(displayName)}" required autocomplete="name"></label><label>Nome de preferência<input name="preferredName" value="${attr(record.preferred_name || '')}"></label></div>
      <div class="form-grid"><label>Data de nascimento<input name="birthDate" type="date" value="${attr(dateInputValue(record.birth_date))}"></label><label>Vínculo com a criança<input name="relationshipToChild" value="${attr(record.relationship_to_child || '')}" placeholder="Ex.: mãe, pai, babá"></label></div>
      <div class="form-grid"><label>E-mail<input name="email" type="email" value="${attr(record.email || '')}" required autocomplete="email"></label><label>${editing ? 'Novo PIN temporário (opcional)' : 'PIN temporário'}<input name="pin" inputmode="numeric" pattern="[0-9]{6,12}" minlength="6" maxlength="12" ${editing ? '' : 'required'}></label></div>
      <div class="form-grid"><label>Telefone<input name="phone" value="${attr(record.phone_normalized || '')}" inputmode="tel"></label><label>WhatsApp<input name="whatsapp" value="${attr(record.whatsapp_normalized || '')}" inputmode="tel"></label></div>
      <label>Endereço<input name="address" value="${attr(address)}" autocomplete="street-address"></label>
      <div class="form-grid"><label>Categoria de acesso<select name="role"><option value="father" ${record.role === 'father' || record.role === 'admin' ? 'selected' : ''}>Pai — acesso total</option><option value="mother" ${record.role === 'mother' || record.role === 'guardian' ? 'selected' : ''}>Mãe — acesso total</option><option value="grandparent" ${record.role === 'grandparent' ? 'selected' : ''}>Familiar</option><option value="caregiver" ${record.role === 'caregiver' ? 'selected' : ''}>Babá</option><option value="doctor" ${record.role === 'doctor' ? 'selected' : ''}>Médico(a)</option><option value="friend" ${record.role === 'friend' || record.role === 'visitor' ? 'selected' : ''}>Amigo(a)</option></select></label><label>Data de início<input name="startsOn" type="date" value="${attr(dateInputValue(record.starts_at) || todayIso())}"></label></div>
      <div class="form-grid"><label>Contato de emergência<input name="emergencyContactName" value="${attr(record.emergency_contact_name || '')}"></label><label>Telefone de emergência<input name="emergencyContactPhone" value="${attr(record.emergency_contact_phone || '')}" inputmode="tel"></label></div>
      <label>Observações<textarea name="notes">${esc(record.notes || '')}</textarea></label>
      ${editing ? `<section class="user-access-controls"><h3>Controle de acesso</h3><p>${blocked ? 'Este acesso está bloqueado.' : 'Este acesso está ativo.'}</p><div><button type="button" class="button button--secondary" data-user-pin="${attr(id)}">Redefinir PIN</button>${blocked ? `<button type="button" class="button" data-user-unblock="${attr(id)}">Desbloquear acesso</button>` : `<button type="button" class="button button--danger" data-user-block="${attr(id)}">Bloquear acesso</button>`}</div></section>` : ''}
      <div class="next-form-actions"><button type="button" class="button button--secondary" data-action="close-modal">Cancelar</button><button class="button">${editing ? 'Salvar cadastro' : 'Criar usuário'}</button></div>
    </form>
  </section></div>`;
}

function pinModal(userId) {
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" data-modal-panel><button type="button" class="modal__close" data-action="close-modal">×</button><h2>Redefinir PIN</h2><form id="pin-form"><input type="hidden" name="userId" value="${attr(userId)}"><label>Novo PIN<input name="pin" inputmode="numeric" pattern="[0-9]{6,12}" minlength="6" maxlength="12" required autofocus></label><p class="permission-note">Use entre 6 e 12 números. O PIN antigo não pode ser consultado.</p><div class="next-form-actions"><button type="button" class="button button--secondary" data-action="close-modal">Cancelar</button><button class="button">Redefinir PIN</button></div></form></section></div>`;
}

async function medicationsPage() {
  if (!can('medications.view')) return denyPage();
  const result = await supabase.from('medications').select('*').eq('family_id', state.context.membership.family_id).order('created_at', { ascending: false });
  if (result.error) throw result.error;
  const rows = result.data || [];
  const action = canManage('medications.edit') ? '<button class="button button--small" data-action="new-medication">Cadastrar</button>' : '';
  const list = rows.length
    ? rows.map((row) => `<article class="record-card"><span class="record-card__icon">${icon('medications')}</span><div><h2>${esc(row.name)}</h2><p>${esc(row.dose || 'Dose não informada')} · ${row.kind === 'continuous' ? 'Uso contínuo' : 'Temporário'}</p><small>${row.starts_on ? `Desde ${formatDate(row.starts_on)}` : ''}</small></div><span class="status-pill ${row.active === false ? 'status-pill--danger' : 'status-pill--success'}">${row.active === false ? 'Encerrado' : 'Ativo'}</span></article>`).join('')
    : emptyState('Nenhum medicamento', canManage('medications.edit') ? 'Cadastre medicamentos e horários para gerar afazeres automaticamente.' : 'Nenhum medicamento foi cadastrado.', action);
  return `${pageHeading('Medicamentos', 'Horários e afazeres são gerados sem duplicação.', action)}<section class="record-list next-record-list">${list}</section>`;
}

function medicationModal() {
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" data-modal-panel><button type="button" class="modal__close" data-action="close-modal">×</button><h2>Novo medicamento</h2><form id="medication-form"><div class="form-grid"><label>Nome<input name="name" required></label><label>Tipo<select name="kind"><option value="temporary">Temporário</option><option value="continuous">Uso contínuo</option></select></label></div><div class="form-grid"><label>Dose<input name="dose" placeholder="Ex.: 5 ml"></label><label>Via<input name="route" placeholder="Ex.: Oral"></label></div><div class="form-grid"><label>Horário<input name="time" type="time" required></label><label>Início<input name="starts_on" type="date" value="${todayIso()}" required></label></div><label>Orientações<textarea name="instructions" placeholder="Orientações importantes"></textarea></label><div class="next-form-actions"><button type="button" class="button button--secondary" data-action="close-modal">Cancelar</button><button class="button">Salvar e gerar afazeres</button></div></form></section></div>`;
}

async function agendaPage() {
  if (!can('events.view')) return denyPage();
  const rows = await listUpcomingEvents({ from: startOfLocalDay().toISOString(), limit: 500 });
  const visible = rows.filter((event) => !isCaregiver() || event.audience_role === 'caregiver' || event.audience_role === 'all');
  const action = canManage('events.edit') ? '<button class="button button--small" data-action="new-event">Novo evento ou aviso</button>' : '';
  const list = visible.length
    ? visible.map((row) => scheduleEventCard(row, { planning: !isCaregiver() })).join('')
    : emptyState('Agenda vazia', canManage('events.edit') ? 'Adicione viagens, consultas, vacinas, exames e outros avisos.' : 'Nenhum compromisso futuro foi cadastrado.', action);
  return `${pageHeading('Agenda', 'Eventos e avisos futuros ficam visíveis assim que são cadastrados.', action)}<section class="record-list next-record-list">${list}</section>`;
}

function eventModal(record = null) {
  const editing = Boolean(record?.id);
  const acknowledged = editing ? eventAcknowledgedByMe(record) : false;
  const when = editing
    ? (record.all_day
      ? `${formatDate(record.starts_at, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })} · dia inteiro`
      : `${formatDate(record.starts_at, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}${record.ends_at ? ` até ${formatDate(record.ends_at, { hour: '2-digit', minute: '2-digit' })}` : ''}`)
    : '';
  if (editing && !canManage('events.edit')) {
    const acknowledgement = record.requires_acknowledgement
      ? acknowledged
        ? '<span class="status-pill status-pill--success">Ciente</span>'
        : `<button type="button" class="button" data-event-ack="${attr(record.id)}">Marcar como ciente</button>`
      : '<span class="status-pill status-pill--soft">Somente informativo</span>';
    return `<div class="modal-backdrop"><section class="modal modal--wide" role="dialog" aria-modal="true" data-modal-panel>
      <button type="button" class="modal__close" data-action="close-modal">×</button>
      <p class="eyebrow">Agenda</p>
      <h2>${esc(record.title || 'Evento')}</h2>
      <div class="event-detail">
        <p><strong>${esc(when)}</strong></p>
        ${record.location ? `<p><strong>Local:</strong> ${esc(record.location)}</p>` : ''}
        ${record.notes ? `<div class="instruction-box instruction-box--neutral"><strong>Informações e orientações</strong><p>${esc(record.notes)}</p></div>` : ''}
      </div>
      <div class="next-form-actions"><button type="button" class="button button--secondary" data-action="close-modal">Fechar</button>${acknowledgement}</div>
    </section></div>`;
  }
  const initial = editing ? localDateTimeValue(record.starts_at) : localDateTimeValue(new Date(Date.now() + 3600000));
  const end = editing ? localDateTimeValue(record.ends_at) : '';
  return `<div class="modal-backdrop"><section class="modal modal--wide" role="dialog" aria-modal="true" data-modal-panel>
    <button type="button" class="modal__close" data-action="close-modal">×</button>
    <h2>${editing ? 'Editar evento ou aviso' : 'Novo evento ou aviso'}</h2>
    <form id="event-form">
      <input type="hidden" name="event_id" value="${attr(record?.id || '')}">
      <label>Título<input name="title" required value="${attr(record?.title || '')}" placeholder="Ex.: Viagem do Cesar, Pediatra, Vacinação"></label>
      <label class="check-row"><input name="all_day" type="checkbox" ${record?.all_day ? 'checked' : ''}> Evento de dia inteiro</label>
      <div class="form-grid"><label>Início<input name="starts_at" type="datetime-local" value="${attr(initial)}" required></label><label>Término opcional<input name="ends_at" type="datetime-local" value="${attr(end)}"></label></div>
      <div class="form-grid"><label>Mostrar para<select name="audience_role"><option value="caregiver" ${!record || record.audience_role === 'caregiver' ? 'selected' : ''}>Perfil Babá</option><option value="guardian" ${record?.audience_role === 'guardian' ? 'selected' : ''}>Responsáveis</option><option value="all" ${record?.audience_role === 'all' ? 'selected' : ''}>Toda a família</option></select></label><label>Confirmação<select name="requires_acknowledgement"><option value="true" ${record?.requires_acknowledgement !== false ? 'selected' : ''}>Exigir botão Ciente</option><option value="false" ${record?.requires_acknowledgement === false ? 'selected' : ''}>Apenas informar</option></select></label></div>
      <label>Local<input name="location" value="${attr(record?.location || '')}" placeholder="Endereço ou local do compromisso"></label>
      <label>Informações e orientações<textarea name="notes" placeholder="Explique o que vai acontecer e o que a babá precisa saber.">${esc(record?.notes || '')}</textarea></label>
      <div class="instruction-box instruction-box--neutral"><strong>Horário local</strong><p>O horário exibido e salvo será o horário informado neste aparelho.</p></div>
      <div class="next-form-actions next-form-actions--split">${editing ? `<button type="button" class="button button--danger" data-event-delete="${attr(record.id)}">Excluir evento</button>` : '<span></span>'}<div><button type="button" class="button button--secondary" data-action="close-modal">Cancelar</button><button class="button">${editing ? 'Salvar alterações' : 'Salvar evento'}</button></div></div>
    </form>
  </section></div>`;
}

async function childPage() {
  if (!can('child.view')) return denyPage();
  const result = await supabase.from('child_profiles').select('*').eq('family_id', state.context.membership.family_id).maybeSingle();
  if (result.error) throw result.error;
  const record = result.data || null;
  const data = record?.data || {};
  const [photoUrl, cardUrl] = await Promise.all([
    data.photoFileId ? privateFileUrl(data.photoFileId).catch(() => '') : '',
    data.healthCardFileId ? privateFileUrl(data.healthCardFileId).catch(() => '') : '',
  ]);
  const action = canManage('child.edit') ? `<button class="button button--small" data-child-edit="${attr(record?.id || '')}">Editar</button>` : '';
  const avatar = photoUrl
    ? `<img class="child-profile-photo" src="${attr(photoUrl)}" alt="Foto de ${attr(data.name || 'Maria Elis')}">`
    : `<div class="person-avatar person-avatar--large">${initials(data.name || 'Maria Elis')}</div>`;
  return `${pageHeading('Dados da criança', 'Informações pessoais, familiares e médicas.', action)}
    <section class="person-hero child-person-hero">${avatar}<div><h2>${esc(data.name || 'Maria Elis')}</h2><p>${data.birthDate ? `${formatDate(`${data.birthDate}T12:00:00`)} · ${esc(calculateAge(data.birthDate))}` : 'Data de nascimento não cadastrada'}</p><p>Tipo sanguíneo: <strong>${esc(data.bloodType || 'Não informado')}</strong></p></div><button class="button button--danger button--small" data-page="emergency">Abrir emergência</button></section>
    <section class="settings-card"><dl class="detail-list">
      <div><dt>Nome completo</dt><dd>${esc(data.name || 'Não informado')}</dd></div>
      <div><dt>Idade</dt><dd>${esc(calculateAge(data.birthDate))}</dd></div>
      <div><dt>Mãe</dt><dd>${esc(data.motherName || 'Não informado')}</dd></div>
      <div><dt>Pai</dt><dd>${esc(data.fatherName || 'Não informado')}</dd></div>
      <div><dt>Tipo sanguíneo</dt><dd>${esc(data.bloodType || 'Não informado')}</dd></div>
      <div><dt>Plano de saúde</dt><dd>${esc(data.healthPlan || 'Não informado')}${data.healthPlanNumber ? ` · ${esc(data.healthPlanNumber)}` : ''}</dd></div>
      <div><dt>Alergias</dt><dd>${esc(data.allergies || 'Não informado')}</dd></div>
      <div><dt>Condições médicas</dt><dd>${esc(data.medicalConditions || 'Não informado')}</dd></div>
      <div><dt>Orientações de emergência</dt><dd>${esc(data.emergencyInstructions || 'Nenhuma orientação cadastrada.')}</dd></div>
      <div><dt>Observações gerais</dt><dd>${esc(data.notes || 'Nenhuma observação cadastrada.')}</dd></div>
    </dl></section>
    ${cardUrl ? `<section class="settings-card"><div class="section-title"><h2>Carteirinha do plano</h2></div><button class="health-card-preview health-card-preview--large" data-file-open="${attr(data.healthCardFileId)}"><img src="${attr(cardUrl)}" alt="Carteirinha do plano de saúde"><span>Abrir imagem</span></button></section>` : ''}`;
}

function childModal(record = null) {
  const data = record?.data || record || {};
  const bloodTypes = ['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
  return `<div class="modal-backdrop"><section class="modal modal--wide" role="dialog" aria-modal="true" data-modal-panel>
    <button type="button" class="modal__close" data-action="close-modal" aria-label="Fechar">×</button>
    <h2>Dados da criança</h2>
    <form id="child-form">
      <input type="hidden" name="recordId" value="${attr(record?.id || '')}">
      <div class="form-grid"><label>Nome completo<input name="name" value="${attr(data.name || '')}" required></label><label>Nascimento<input name="birthDate" type="date" value="${attr(dateInputValue(data.birthDate))}"></label></div>
      <div class="form-grid"><label>Nome da mãe<input name="motherName" value="${attr(data.motherName || '')}"></label><label>Nome do pai<input name="fatherName" value="${attr(data.fatherName || '')}"></label></div>
      <div class="form-grid"><label>Tipo sanguíneo<select name="bloodType">${bloodTypes.map((type) => `<option value="${attr(type)}" ${data.bloodType === type ? 'selected' : ''}>${type || 'Não informado'}</option>`).join('')}</select></label><label>Plano de saúde<input name="healthPlan" value="${attr(data.healthPlan || '')}"></label></div>
      <label>Número da carteirinha<input name="healthPlanNumber" value="${attr(data.healthPlanNumber || '')}"></label>
      <section class="profile-upload-grid"><div><h3>Foto da criança</h3>${data.photoFileId ? `<button type="button" class="button button--secondary button--small" data-file-open="${attr(data.photoFileId)}">Ver foto atual</button>` : ''}${renderFilePicker({ id: 'child-photo', label: 'Fotografar ou escolher', accept: 'image/*', avatar: true })}</div><div><h3>Carteirinha do plano</h3>${data.healthCardFileId ? `<button type="button" class="button button--secondary button--small" data-file-open="${attr(data.healthCardFileId)}">Ver imagem atual</button>` : ''}${renderFilePicker({ id: 'health-card-photo', label: 'Fotografar ou escolher', accept: 'image/*', avatar: true })}</div></section>
      <label>Alergias<textarea name="allergies" placeholder="Descreva alergias alimentares, medicamentosas ou outras.">${esc(data.allergies || '')}</textarea></label>
      <label>Condições médicas importantes<textarea name="medicalConditions">${esc(data.medicalConditions || '')}</textarea></label>
      <label>Orientações de emergência<textarea name="emergencyInstructions" placeholder="O que a babá deve fazer em caso de emergência.">${esc(data.emergencyInstructions || '')}</textarea></label>
      <label>Observações gerais<textarea name="notes">${esc(data.notes || '')}</textarea></label>
      <div class="next-form-actions"><button type="button" class="button button--secondary" data-action="close-modal">Cancelar</button><button class="button">Salvar</button></div>
    </form>
  </section></div>`;
}

async function photosPage() {
  if (!can('photos.view')) return denyPage();
  let files = [];
  let listError = '';
  try {
    files = await listDocuments('active', 'photos');
  } catch (error) {
    listError = error.message;
  }
  const uploadAction = canManage('photos.create') ? '<button class="button button--small" data-action="new-photo">Adicionar foto</button>' : '';
  const tiles = await Promise.all(files.map(async (file) => {
    const id = file.id || file.fileId || '';
    const url = await privateFileUrl(id).catch(() => '');
    const name = file.originalName || 'Foto';
    return `<button type="button" class="photo-tile" data-file-open="${attr(id)}" aria-label="Abrir ${attr(name)}">${url ? `<img src="${attr(url)}" alt="${attr(name)}" loading="lazy">` : `<span>${icon('photo')}</span>`}<small>${esc(name)}</small></button>`;
  }));
  const content = tiles.length ? `<section class="photo-gallery">${tiles.join('')}</section>` : emptyState('Nenhuma foto', listError || 'As fotos da família e dos registros aparecerão aqui.', uploadAction);
  return `${pageHeading('Fotos', 'Galeria separada dos documentos privados.', uploadAction)}${content}${listError ? `<p class="permission-note">${esc(listError)}</p>` : ''}`;
}

function photoModal() {
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" data-modal-panel><button type="button" class="modal__close" data-action="close-modal">×</button><h2>Adicionar foto</h2><form id="photo-form">${renderFilePicker({ id: 'gallery-photo', label: 'Tirar ou escolher foto', accept: 'image/*', avatar: true })}<label>Categoria<select name="category"><option value="daily">Dia a dia</option><option value="meal">Alimentação</option><option value="activity">Atividade</option><option value="health">Saúde</option><option value="other">Outra</option></select></label><div class="next-form-actions"><button type="button" class="button button--secondary" data-action="close-modal">Cancelar</button><button class="button">Salvar foto</button></div></form></section></div>`;
}

const recipeCategoryLabel = (value) => ({ breakfast: 'Café da manhã', lunch: 'Almoço', snack: 'Lanche', dinner: 'Jantar', dessert: 'Sobremesa', drink: 'Bebida', other: 'Outra' })[value] || 'Outra';

async function recipesPage() {
  if (!can('recipes.view')) return denyPage();
  const recipes = await listRecipes();
  const action = canManage('recipes.create') ? '<button class="button button--small" data-action="new-recipe">Adicionar</button>' : '';
  const cards = await Promise.all(recipes.map(async (recipe) => {
    const photoUrl = recipe.photo_file_id ? await privateFileUrl(recipe.photo_file_id).catch(() => '') : '';
    const ingredients = jsonList(recipe.ingredients);
    return `<button type="button" class="record-card record-card--button recipe-card" data-recipe-open="${attr(recipe.id)}">${photoUrl ? `<img class="recipe-card__photo" src="${attr(photoUrl)}" alt="${attr(recipe.title)}">` : `<span class="record-card__icon">${icon('recipes')}</span>`}<div><h2>${esc(recipe.title)}</h2><p>${esc(recipeCategoryLabel(recipe.category))}</p><small>${ingredients.length} ingrediente(s)</small></div><b>›</b></button>`;
  }));
  return `${pageHeading('Receitas culinárias', 'Ingredientes, preparo, fotos e links para consultar durante os cuidados.', action)}<section class="record-list next-record-list">${cards.length ? cards.join('') : emptyState('Nenhuma receita', canManage('recipes.create') ? 'Cadastre a primeira receita da Maria Elis.' : 'Nenhuma receita foi cadastrada.', action)}</section>`;
}

function recipeModal(record = {}) {
  const editing = Boolean(record.id);
  return `<div class="modal-backdrop"><section class="modal modal--wide" role="dialog" aria-modal="true" data-modal-panel><button type="button" class="modal__close" data-action="close-modal">×</button><h2>${editing ? 'Editar receita' : 'Nova receita'}</h2><form id="recipe-form"><input type="hidden" name="id" value="${attr(record.id || '')}"><div class="form-grid"><label>Nome da receita<input name="title" required maxlength="160" value="${attr(record.title || '')}"></label><label>Categoria<select name="category"><option value="breakfast" ${record.category === 'breakfast' ? 'selected' : ''}>Café da manhã</option><option value="lunch" ${record.category === 'lunch' ? 'selected' : ''}>Almoço</option><option value="snack" ${record.category === 'snack' ? 'selected' : ''}>Lanche</option><option value="dinner" ${record.category === 'dinner' ? 'selected' : ''}>Jantar</option><option value="dessert" ${record.category === 'dessert' ? 'selected' : ''}>Sobremesa</option><option value="drink" ${record.category === 'drink' ? 'selected' : ''}>Bebida</option><option value="other" ${!record.category || record.category === 'other' ? 'selected' : ''}>Outra</option></select></label></div><label>Ingredientes <small>(um por linha, incluindo a quantidade)</small><textarea name="ingredients" required placeholder="1 banana madura&#10;2 colheres de aveia">${esc(jsonList(record.ingredients).join('\n'))}</textarea></label><label>Modo de preparo<textarea name="instructions" placeholder="Descreva o preparo passo a passo">${esc(record.instructions || '')}</textarea></label><label>Links <small>(um por linha)</small><textarea name="links" placeholder="https://...">${esc(jsonList(record.links).join('\n'))}</textarea></label><label>Alerta de alergia ou restrição<input name="allergyAlert" value="${attr(record.allergy_alert || '')}"></label><label>Observações<textarea name="notes">${esc(record.notes || '')}</textarea></label>${renderFilePicker({ id: 'recipe-photo', label: editing ? 'Substituir foto (opcional)' : 'Adicionar foto (opcional)', accept: 'image/*', avatar: true })}<div class="next-form-actions"><button type="button" class="button button--secondary" data-action="close-modal">Cancelar</button><button class="button">Salvar receita</button></div></form></section></div>`;
}

function recipeDetailsModal(record) {
  const ingredients = jsonList(record.ingredients);
  const links = jsonList(record.links).map(safeExternalUrl).filter(Boolean);
  return `<div class="modal-backdrop"><section class="modal modal--wide recipe-details" role="dialog" aria-modal="true" data-modal-panel><button type="button" class="modal__close" data-action="close-modal">×</button>${record.photoUrl ? `<img class="recipe-details__hero" src="${attr(record.photoUrl)}" alt="${attr(record.title)}">` : ''}<p class="eyebrow">${esc(recipeCategoryLabel(record.category))}</p><h2>${esc(record.title)}</h2>${record.allergy_alert ? `<div class="instruction-box instruction-box--danger"><strong>Atenção</strong><p>${esc(record.allergy_alert)}</p></div>` : ''}<section><h3>Ingredientes</h3><ul class="recipe-list">${ingredients.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></section>${record.instructions ? `<section><h3>Modo de preparo</h3><p class="recipe-preparation">${esc(record.instructions)}</p></section>` : ''}${links.length ? `<section><h3>Links</h3><div class="recipe-links">${links.map((url, index) => `<a class="button button--secondary" href="${attr(url)}" target="_blank" rel="noopener">Abrir link ${index + 1}</a>`).join('')}</div></section>` : ''}${record.notes ? `<section><h3>Observações</h3><p>${esc(record.notes)}</p></section>` : ''}<div class="next-form-actions"><button type="button" class="button button--secondary" data-action="close-modal">Fechar</button>${canManage('recipes.edit') ? `<button type="button" class="button" data-recipe-edit="${attr(record.id)}">Editar</button>` : ''}${canManage('recipes.delete') ? `<button type="button" class="button button--danger" data-recipe-delete="${attr(record.id)}">Excluir</button>` : ''}</div></section></div>`;
}

async function accessCategoriesPage() {
  if (!can('users.manage')) return denyPage();
  const familyId = state.context.membership.family_id;
  const [definitionsResult, defaultsResult, overridesResult] = await Promise.all([
    supabase.from('permission_definitions').select('code,resource,action,description').order('resource').order('action'),
    supabase.from('role_permissions').select('role,permission_code,allowed'),
    supabase.from('family_role_permissions').select('role,permission_code,allowed').eq('family_id', familyId),
  ]);
  if (definitionsResult.error || defaultsResult.error || overridesResult.error) throw definitionsResult.error || defaultsResult.error || overridesResult.error;
  const definitions = definitionsResult.data || [];
  const defaults = new Map((defaultsResult.data || []).map((item) => [`${item.role}:${item.permission_code}`, item.allowed]));
  const overrides = new Map((overridesResult.data || []).map((item) => [`${item.role}:${item.permission_code}`, item.allowed]));
  const roles = [
    ['grandparent', 'Familiar'], ['caregiver', 'Babá'], ['doctor', 'Médico(a)'], ['friend', 'Amigo(a)'],
  ];
  const modules = new Map();
  for (const item of definitions) {
    if (!modules.has(item.resource)) modules.set(item.resource, []);
    modules.get(item.resource).push(item);
  }
  const moduleNames = { child: 'Dados da criança', contacts: 'Contatos e emergência', daily_logs: 'Registros diários', events: 'Agenda', files: 'Documentos', photos: 'Fotos', recipes: 'Receitas culinárias', medications: 'Medicamentos', tasks: 'Rotina e afazeres', health: 'Saúde e desenvolvimento', users: 'Usuários e acessos' };
  const cards = roles.map(([role, label]) => `<details class="permission-category" ${role === 'caregiver' ? 'open' : ''}><summary><strong>${esc(label)}</strong><span>Configurar acessos</span></summary><div class="permission-modules">${[...modules.entries()].map(([resource, items]) => `<section class="permission-module"><h3>${esc(moduleNames[resource] || resource)}</h3>${items.map((item) => { const key = `${role}:${item.code}`; const checked = overrides.has(key) ? overrides.get(key) : defaults.get(key); return `<label class="permission-toggle"><input type="checkbox" data-role-permission data-role="${attr(role)}" data-code="${attr(item.code)}" ${checked ? 'checked' : ''}><span>${esc(permissionLabel(item.code))}</span></label>`; }).join('')}</section>`).join('')}</div></details>`).join('');
  return `${pageHeading('Categorias de acesso', 'Pai e Mãe têm acesso total. Configure abaixo o que as outras categorias podem fazer.')}<section class="parent-access-note"><strong>Pai e Mãe</strong><span>Acesso total e permanente a todas as áreas.</span></section><section class="permission-categories">${cards}</section>`;
}

async function documentsPage() {
  if (!can('files.view')) return denyPage();
  let files = [];
  let listError = '';
  try {
    files = await listDocuments('active', 'documents');
  } catch (error) {
    listError = error.message;
  }
  const uploadAction = canManage('files.create') ? '<button class="button button--small" data-action="new-file">Enviar</button>' : '';
  const list = files.length ? files.map((file) => {
    const id = file.id || file.fileId || file.file_id || '';
    const name = file.originalName || file.original_name || file.name || file.title || 'Documento';
    const category = file.category || file.fileType || file.file_type || 'Arquivo';
    const created = file.createdAt || file.created_at || file.uploadedAt || file.uploaded_at;
    return `<article class="record-card"><span class="record-card__icon">${icon('files')}</span><div><h2>${esc(name)}</h2><p>${esc(category)}</p><small>${created ? formatDate(created, { day: '2-digit', month: 'short', year: 'numeric' }) : ''}</small></div><div class="next-card-actions"><button class="icon-button" data-file-open="${attr(id)}" aria-label="Abrir arquivo">${icon('download')}</button>${isAdmin() ? `<button class="icon-button" data-file-archive="${attr(id)}" aria-label="Arquivar arquivo">${icon('archive')}</button>` : ''}</div></article>`;
  }).join('') : emptyState('Nenhum documento', listError || (canManage('files.create') ? 'Envie documentos de saúde, identificação ou outros anexos.' : 'Nenhum documento autorizado está disponível.'), uploadAction);
  return `${pageHeading('Documentos', 'Arquivos privados acessados pelo gateway seguro.', uploadAction)}<section class="record-list next-record-list">${list}</section>${listError ? `<p class="permission-note">${esc(listError)}</p>` : ''}`;
}

function fileModal() {
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" data-modal-panel><button type="button" class="modal__close" data-action="close-modal">×</button><h2>Enviar documento</h2><form id="file-form"><label>Categoria<select name="category"><option value="health">Saúde</option><option value="identity">Identificação</option><option value="school">Escola</option><option value="other">Outros</option></select></label>${renderFilePicker({ id: 'next-file', label: 'Selecionar arquivo ou foto' })}<p class="permission-note">O envio só começa após sua confirmação.</p><div class="next-form-actions"><button type="button" class="button button--secondary" data-action="close-modal">Cancelar</button><button class="button">Confirmar envio</button></div></form></section></div>`;
}

function morePage() {
  const cards = [
    can('contacts.view') ? quickCard('contacts', 'contacts', 'Contatos', 'Familiares, médicos e emergências') : '',
    can('medications.view') ? quickCard('medications', 'medications', 'Medicamentos', 'Orientações e horários') : '',
    can('recipes.view') ? quickCard('recipes', 'recipes', 'Receitas culinárias', 'Ingredientes, preparo, fotos e links') : '',
    can('photos.view') ? quickCard('photos', 'photo', 'Fotos', 'Galeria da Maria Elis') : '',
    can('files.view') ? quickCard('documents', 'files', 'Documentos', 'Arquivos privados e prescrições') : '',
    can('child.view') ? quickCard('child', 'child', 'Dados da criança', 'Saúde e informações privadas') : '',
    can('child.view') || can('contacts.view') ? quickCard('emergency', 'emergency', 'Emergência', 'Alergias, hospitais e contatos') : '',
    canManage('tasks.manage') ? quickCard('templates', 'template', 'Títulos e regras', 'Padrões de almoço, soneca, banho e outros') : '',
  ].filter(Boolean);
  if (can('users.manage')) {
    cards.push(quickCard('users', 'users', 'Usuários', 'Cadastros, acessos e PINs'));
    cards.push(quickCard('access', 'lock', 'Categorias de acesso', 'Definir o que cada categoria pode fazer'));
  }
  return `${pageHeading('Mais', 'Cadastros e configurações do responsável.')}<section class="next-feature-grid">${cards.join('')}</section><section class="settings-card"><div class="setting-line"><div><strong>Sessão protegida</strong><p>O aplicativo encerra o acesso após inatividade.</p></div><span class="status-pill status-pill--success">Ativo</span></div></section>`;
}

function migrationPage() {
  if (!isAdmin()) return denyPage();
  return `${pageHeading('Prévia de migração', 'Ferramenta administrativa. Nenhum dado é importado automaticamente.')}<form id="migration-form" class="form-card"><label>JSON fictício<textarea name="json" placeholder="{&quot;medications&quot;:[]}"></textarea></label><button class="button">Simular</button></form><pre id="migration-result" class="next-code-result"></pre>`;
}

function quickRegisterModal() {
  const actions = [
    canManage('contacts.create') ? `<button class="register-type" data-action="new-contact"><span>${icon('contacts')}</span>Contato</button>` : '',
    canManage('medications.edit') ? `<button class="register-type" data-action="new-medication"><span>${icon('medications')}</span>Medicamento</button>` : '',
    canManage('events.edit') ? `<button class="register-type" data-action="new-event"><span>${icon('calendar')}</span>Evento</button>` : '',
    canManage('files.create') ? `<button class="register-type" data-action="new-file"><span>${icon('files')}</span>Documento</button>` : '',
    canManage('photos.create') ? `<button class="register-type" data-action="new-photo"><span>${icon('photo')}</span>Foto</button>` : '',
    canManage('recipes.create') ? `<button class="register-type" data-action="new-recipe"><span>${icon('recipes')}</span>Receita culinária</button>` : '',
  ].filter(Boolean).join('');
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" data-modal-panel><button type="button" class="modal__close" data-action="close-modal" aria-label="Fechar">×</button><h2>O que deseja registrar?</h2><div class="register-picker">${actions || '<p class="permission-note">Seu perfil não possui ações de cadastro.</p>'}</div></section></div>`;
}

function denyPage() {
  return emptyState('Acesso não permitido', 'Seu perfil não recebeu permissão para acessar esta área.');
}

async function pageBody() {
  switch (state.page) {
    case 'contacts': return contactsPage();
    case 'users': return usersPage();
    case 'access': return accessCategoriesPage();
    case 'documents': return documentsPage();
    case 'photos': return photosPage();
    case 'recipes': return recipesPage();
    case 'medications': return medicationsPage();
    case 'agenda': return agendaPage();
    case 'child': return childPage();
    case 'planning': return planningPage();
    case 'templates': return templatesPage();
    case 'register': return registerPage();
    case 'history': return historyPage();
    case 'emergency': return emergencyPage();
    case 'hospitals': return hospitalsPage();
    case 'migration': return migrationPage();
    case 'more': return morePage();
    default: return homePage();
  }
}

function renderLogin() {
  const email = rememberedLoginEmail();
  const identity = email
    ? `<div class="next-auth__identity"><span>Entrar como</span><strong>${esc(email)}</strong></div><input name="email" type="hidden" value="${attr(email)}">`
    : '<label>E-mail<input name="email" type="email" required autocomplete="email" autofocus></label>';
  const changeUser = email ? '<button class="text-button" type="button" data-action="change-login-user">Usar outro e-mail</button>' : '';
  return `<main class="next-auth"><section class="next-auth__card"><div class="next-auth__brand"><div class="next-auth__logo">ME</div><p class="eyebrow">App Maria Elis</p><h1>${email ? 'Olá novamente' : 'Bem-vindo'}</h1><p>${email ? 'Digite somente seu PIN para entrar.' : 'Entre com seu e-mail e PIN individual.'}</p></div><form id="login-form" class="next-auth__form">${identity}<label>PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{6,12}" minlength="6" maxlength="12" required autocomplete="current-password" ${email ? 'autofocus' : ''}></label><button class="button button--wide">Entrar</button>${changeUser}</form><p class="next-auth__privacy">Acesso privado e protegido por permissões. A Microsoft funciona apenas nos bastidores.</p></section></main><div id="next-toast-region" class="toast-region" aria-live="polite"></div>`;
}

function renderBlocked() {
  return `<main class="next-auth"><section class="next-auth__card"><div class="next-auth__logo">!</div><h1>Acesso indisponível</h1><p>Este usuário não possui associação ativa com a família.</p><button class="button button--wide" data-action="signout">Trocar usuário</button></section></main><div id="next-toast-region" class="toast-region" aria-live="polite"></div>`;
}

function modalHtml() {
  if (!state.modal) return '';
  switch (state.modal.type) {
    case 'quick': return quickRegisterModal();
    case 'contact': return contactModal(state.modal.data);
    case 'user': return userModal(state.modal.data);
    case 'pin': return pinModal(state.modal.data.userId);
    case 'medication': return medicationModal();
    case 'event': return eventModal(state.modal.data);
    case 'file': return fileModal();
    case 'photo': return photoModal();
    case 'recipe': return recipeModal(state.modal.data);
    case 'recipe-details': return recipeDetailsModal(state.modal.data);
    case 'child': return childModal(state.modal.data);
    case 'task': return taskModal(state.modal.data);
    case 'template': return routineTemplateModal(state.modal.data);
    case 'task-details': return taskDetailsModal(state.modal.data);
    case 'daily-log': return dailyLogModal(state.modal.data.category);
    case 'hospital': return hospitalModal();
    default: return '';
  }
}

async function render({ refreshContext = false } = {}) {
  try {
    if (refreshContext || !state.context) state.context = await loadContext();
    if (!state.context) {
      app.innerHTML = renderLogin();
      bind();
      return;
    }
    if (state.context.blocked) {
      app.innerHTML = renderBlocked();
      bind();
      return;
    }
    resetInactivity();
    const body = await pageBody();
    app.innerHTML = `${topbar()}<div class="next-layout"><main id="main-content" class="main-content next-main">${body}</main></div>${navigation()}${modalHtml()}<div id="next-toast-region" class="toast-region" aria-live="polite"></div>`;
    bind();
  } catch (error) {
    console.error(error);
    app.innerHTML = `<main class="fatal"><h1>Não foi possível carregar esta tela</h1><p>${esc(error?.message || 'Erro inesperado.')}</p><button class="button" data-action="reload">Tentar novamente</button></main>`;
    bind();
  }
}

function openModal(type, data = {}) {
  state.modal = { type, data };
  render();
}

function closeModal() {
  state.modal = null;
  render();
}

async function openContact(id) {
  const result = await supabase.from('contacts').select('*').eq('id', id).single();
  if (result.error) throw result.error;
  openModal('contact', result.data);
}

async function openUser(id) {
  const result = await listUsers();
  const user = (result.users || []).find((item) => (item.user_id || item.id) === id);
  if (!user) throw new Error('Usuário não encontrado.');
  const avatarUrl = user.avatar_file_id ? await privateFileUrl(user.avatar_file_id).catch(() => '') : '';
  openModal('user', { ...user, avatarUrl });
}

async function openChildEditor() {
  const result = await supabase.from('child_profiles').select('*').eq('family_id', state.context.membership.family_id).maybeSingle();
  if (result.error) throw result.error;
  openModal('child', result.data || {});
}

async function handleOpenDocument(id) {
  const response = await openDocument(id);
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const data = await response.json();
    if (data.url) window.open(data.url, '_blank', 'noopener');
    else throw new Error('O gateway não retornou um arquivo válido.');
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function openTask(id) {
  const task = await loadRoutineTask(id);
  openModal('task-details', task);
}

async function openTaskCreator() {
  const data = await taskModalData();
  openModal('task', data);
}

async function openRoutineTemplate(id) {
  const template = id ? await loadRoutineTemplate(id) : {};
  openModal('template', template);
}

async function openRecipe(id) {
  const recipe = await loadRecipe(id);
  const photoUrl = recipe.photo_file_id ? await privateFileUrl(recipe.photo_file_id).catch(() => '') : '';
  openModal('recipe-details', { ...recipe, photoUrl });
}

async function openCalendarEvent(id) {
  const result = await supabase.from('calendar_events')
    .select('*')
    .eq('id', id)
    .single();
  if (result.error) throw result.error;
  const acknowledgements = await supabase.from('event_acknowledgements')
    .select('user_id,acknowledged_at')
    .eq('event_id', id);
  const record = {
    ...result.data,
    event_acknowledgements: acknowledgements.error ? [] : (acknowledgements.data || []),
  };
  openModal('event', record);
}

function bindPhotoPreview() {
  const input = document.querySelector('#contact-photo');
  const zoom = document.querySelector('#contact-zoom');
  const preview = document.querySelector('#contact-photo-preview');
  let previewUrl = '';
  const update = async () => {
    const file = input?.files?.[0];
    if (!file || !preview) return;
    try {
      const cropped = await cropImage(file, { zoom: Number(zoom?.value || 1), size: 480 });
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(cropped);
      preview.src = previewUrl;
      preview.hidden = false;
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  input?.addEventListener('change', update);
  zoom?.addEventListener('input', update);
}

function bind() {
  if (!state.activityBound) {
    ['pointerdown', 'keydown', 'touchstart'].forEach((eventName) => document.addEventListener(eventName, resetInactivity, { passive: true }));
    state.activityBound = true;
  }
  if (!state.escapeBound) {
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.modal) closeModal();
    });
    state.escapeBound = true;
  }

  document.querySelectorAll('[data-page]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.page = button.dataset.page;
      state.modal = null;
      await render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  document.querySelectorAll('[data-action="signout"]').forEach((button) => button.addEventListener('click', async () => {
    await signOut();
    state.context = null;
    state.page = 'home';
    state.modal = null;
    await render();
  }));

  document.querySelectorAll('[data-action="reload"]').forEach((button) => button.addEventListener('click', () => render()));
  document.querySelectorAll('[data-action="change-login-user"]').forEach((button) => button.addEventListener('click', () => {
    rememberLoginEmail('');
    render();
  }));
  document.querySelectorAll('[data-scroll-routine]').forEach((button) => button.addEventListener('click', () => {
    document.querySelector('#routine-schedule')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  document.querySelectorAll('[data-event-open]').forEach((button) => button.addEventListener('click', () => runBusy(() => openCalendarEvent(button.dataset.eventOpen))));
  document.querySelectorAll('[data-event-ack]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    return runBusy(async () => {
      const eventId = button.dataset.eventAck;
      await acknowledgeEvent(eventId);
      state.acknowledgedEventIds.add(eventId);
      button.outerHTML = '<span class="status-pill status-pill--success">Ciente</span>';
      await render();
    }, 'Confirmação registrada.');
  }));
  document.querySelectorAll('[data-user-open]').forEach((button) => button.addEventListener('click', () => runBusy(() => openUser(button.dataset.userOpen))));
  document.querySelectorAll('[data-recipe-open]').forEach((button) => button.addEventListener('click', () => runBusy(() => openRecipe(button.dataset.recipeOpen))));
  document.querySelectorAll('[data-history-days]').forEach((button) => button.addEventListener('click', async () => {
    const days = Number(button.dataset.historyDays || 30);
    state.historyTo = todayIso();
    state.historyFrom = dateOnly(addDays(new Date(), -days));
    await render();
  }));
  document.querySelectorAll('[data-action="quick-register"]').forEach((button) => button.addEventListener('click', () => {
    if (canQuickRegister()) openModal('quick');
  }));
  document.querySelectorAll('[data-action="new-contact"]').forEach((button) => button.addEventListener('click', () => {
    if (requirePermission('contacts.create')) openModal('contact');
  }));
  document.querySelectorAll('[data-action="new-user"]').forEach((button) => button.addEventListener('click', () => {
    if (requirePermission('users.manage')) openModal('user');
  }));
  document.querySelectorAll('[data-action="new-medication"]').forEach((button) => button.addEventListener('click', () => {
    if (requirePermission('medications.edit')) openModal('medication');
  }));
  document.querySelectorAll('[data-action="new-event"]').forEach((button) => button.addEventListener('click', () => {
    if (requirePermission('events.edit')) openModal('event');
  }));
  document.querySelectorAll('[data-action="new-file"]').forEach((button) => button.addEventListener('click', () => {
    if (requirePermission('files.create')) openModal('file');
  }));
  document.querySelectorAll('[data-action="new-photo"]').forEach((button) => button.addEventListener('click', () => {
    if (requirePermission('photos.create')) openModal('photo');
  }));
  document.querySelectorAll('[data-action="new-recipe"]').forEach((button) => button.addEventListener('click', () => {
    if (requirePermission('recipes.create')) openModal('recipe');
  }));
  document.querySelectorAll('[data-action="new-task"]').forEach((button) => button.addEventListener('click', () => {
    if (requirePermission('tasks.manage')) runBusy(openTaskCreator);
  }));
  document.querySelectorAll('[data-action="new-template"]').forEach((button) => button.addEventListener('click', () => {
    if (requirePermission('tasks.manage')) runBusy(() => openRoutineTemplate(''));
  }));
  document.querySelectorAll('[data-template-edit]').forEach((button) => button.addEventListener('click', () => {
    if (requirePermission('tasks.manage')) runBusy(() => openRoutineTemplate(button.dataset.templateEdit));
  }));
  document.querySelectorAll('[data-new-log]').forEach((button) => button.addEventListener('click', () => {
    if (requirePermission('daily_logs.create')) openModal('daily-log', { category: button.dataset.newLog });
  }));
  document.querySelectorAll('[data-action="new-hospital"]').forEach((button) => button.addEventListener('click', () => {
    if (requirePermission('child.edit')) openModal('hospital');
  }));

  document.querySelectorAll('[data-action="close-modal"]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeModal();
  }));
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeModal();
  }));
  document.querySelectorAll('[data-modal-panel]').forEach((panel) => panel.addEventListener('click', (event) => event.stopPropagation()));

  document.querySelectorAll('[data-contact-edit]').forEach((button) => button.addEventListener('click', () => {
    if (requirePermission('contacts.edit')) runBusy(() => openContact(button.dataset.contactEdit));
  }));
  document.querySelectorAll('[data-task-open]').forEach((button) => button.addEventListener('click', () => runBusy(() => openTask(button.dataset.taskOpen))));
  document.querySelectorAll('[data-task-item]').forEach((input) => input.addEventListener('change', () => runBusy(async () => {
    await toggleRoutineItem(input.dataset.taskItem, input.checked);
    state.modal.data = await loadRoutineTask(state.modal.data.id);
    await render();
  })));
  document.querySelectorAll('[data-task-timer]').forEach((button) => button.addEventListener('click', () => runBusy(async () => {
    const task = state.modal?.data;
    if (!task?.id) return;
    if (button.dataset.taskTimer === 'start') await startRoutineTask(task.id);
    else await stopRoutineTask(task.id);
    state.modal.data = await loadRoutineTask(task.id);
    await render();
  }, button.dataset.taskTimer === 'start' ? 'Início registrado.' : 'Fim registrado.')));
  document.querySelectorAll('[data-task-response]').forEach((button) => button.addEventListener('click', async () => {
    const form = document.querySelector('#task-response-form');
    if (!form) return;
    const data = new FormData(form);
    const task = state.modal?.data;
    const status = button.dataset.taskResponse;
    const note = String(data.get('note') || '').trim();
    const photoInput = document.querySelector('#task-photo');
    const photo = photoInput?.files?.[0] || null;
    const checklist = task?.care_task_items || [];
    if (status === 'completed' && checklist.some((item) => !item.completed)) return toast('Conclua todas as etapas antes de finalizar.', 'warning');
    if (status === 'completed' && task?.requires_timer && !task?.started_at) return toast('Registre o início antes de concluir.', 'warning');
    if (status === 'completed' && task?.requires_timer && !task?.ended_at) return toast('Registre o fim antes de concluir.', 'warning');
    if (status === 'completed' && task?.requires_note && !note && !String(task?.note || '').trim()) return toast('Inclua uma observação antes de concluir.', 'warning');
    if (status === 'completed' && task?.requires_photo && !photo && !task?.proof_file_id && !(task.care_task_updates || []).some((item) => item.file_id)) return toast('Tire uma foto antes de concluir.', 'warning');
    if (status === 'unable' && !note) return toast('Explique por que não foi possível realizar o afazer.', 'warning');
    await runBusy(async () => {
      let fileId = null;
      if (photo) {
        const uploaded = await uploadFile(photo, { fileType: 'task-photo', category: 'routine', relatedRecordType: 'care_task', relatedRecordId: task.id });
        fileId = uploaded.id || uploaded.fileId || null;
      }
      await respondRoutineTask(task.id, status, note, fileId);
      state.modal = null;
      await render();
    }, status === 'completed' ? 'Afazer concluído.' : status === 'unable' ? 'Impedimento registrado.' : 'Andamento registrado.');
  }));
  document.querySelectorAll('[data-child-edit]').forEach((button) => button.addEventListener('click', () => { if (requirePermission('child.edit')) runBusy(openChildEditor); }));
  document.querySelectorAll('[data-user-pin]').forEach((button) => button.addEventListener('click', () => openModal('pin', { userId: button.dataset.userPin })));
  document.querySelectorAll('[data-user-block]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Bloquear o acesso deste usuário?')) return;
    await runBusy(async () => {
      await setUserBlock(button.dataset.userBlock, '2099-12-31T23:59:59.000Z');
      state.modal = null;
      state.page = 'users';
      await render();
    }, 'Usuário bloqueado.');
  }));
  document.querySelectorAll('[data-user-unblock]').forEach((button) => button.addEventListener('click', async () => {
    await runBusy(async () => {
      await unblockUser(button.dataset.userUnblock);
      state.modal = null;
      state.page = 'users';
      await render();
    }, 'Usuário desbloqueado.');
  }));
  document.querySelectorAll('[data-role-permission]').forEach((input) => input.addEventListener('change', async () => {
    const allowed = input.checked;
    input.disabled = true;
    await runBusy(async () => {
      await setRolePermission(state.context.membership.family_id, input.dataset.role, input.dataset.code, allowed);
      await render();
    }, 'Permissão atualizada.');
    input.disabled = false;
  }));
  document.querySelectorAll('[data-recipe-edit]').forEach((button) => button.addEventListener('click', () => {
    if (requirePermission('recipes.edit')) openModal('recipe', state.modal.data);
  }));
  document.querySelectorAll('[data-recipe-delete]').forEach((button) => button.addEventListener('click', async () => {
    if (!requirePermission('recipes.delete') || !confirm('Excluir esta receita?')) return;
    await runBusy(async () => {
      await deleteRecipe(button.dataset.recipeDelete);
      state.modal = null;
      state.page = 'recipes';
      await render();
    }, 'Receita excluída.');
  }));
  document.querySelectorAll('[data-file-open]').forEach((button) => button.addEventListener('click', () => runBusy(() => handleOpenDocument(button.dataset.fileOpen))));
  document.querySelectorAll('[data-file-archive]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Arquivar este documento?')) return;
    await runBusy(async () => {
      await archiveDocument(button.dataset.fileArchive, 'Arquivado pelo administrador');
      await render();
    }, 'Documento arquivado.');
  }));
  document.querySelectorAll('[data-task-complete]').forEach((button) => button.addEventListener('click', () => runBusy(() => openTask(button.dataset.taskComplete))));

  document.querySelector('#history-filter-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    state.historyFrom = String(form.get('from') || '');
    state.historyTo = String(form.get('to') || '');
    state.historyType = String(form.get('type') || 'all');
    await render();
  });

  document.querySelector('#login-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const pin = String(form.get('pin') || '');
    if (!/^[0-9]{6,12}$/.test(pin)) {
      toast('O PIN deve ter entre 6 e 12 números.', 'warning');
      return;
    }
    await runBusy(async () => {
      const email = String(form.get('email') || '').trim().toLowerCase();
      const result = await signInWithPin(email, pin);
      if (result.error) throw new Error('E-mail ou PIN inválido.');
      rememberLoginEmail(email);
      state.context = null;
      state.page = 'home';
      await render({ refreshContext: true });
    });
  });

  document.querySelector('#contact-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const contactId = String(form.get('id') || '');
    if (!requirePermission(contactId ? 'contacts.edit' : 'contacts.create')) return;
    await runBusy(async () => {
      const id = contactId;
      const payload = {
        family_id: state.context.membership.family_id,
        full_name: String(form.get('full_name') || '').trim(),
        relationship_type: String(form.get('relationship_type') || 'other').trim() || 'other',
        phone_normalized: String(form.get('phone_normalized') || '').replace(/\D/g, '') || null,
        whatsapp_normalized: String(form.get('whatsapp_normalized') || '').replace(/\D/g, '') || null,
        email: String(form.get('email') || '').trim() || null,
        emergency_order: form.get('emergency_order') ? Number(form.get('emergency_order')) : null,
        active: form.get('active') !== 'false',
      };
      const query = id
        ? supabase.from('contacts').update(payload).eq('id', id).select().single()
        : supabase.from('contacts').insert(payload).select().single();
      const result = await query;
      if (result.error) throw result.error;
      const photo = document.querySelector('#contact-photo')?.files?.[0];
      if (photo) {
        const cropped = await cropImage(photo, { zoom: Number(document.querySelector('#contact-zoom')?.value || 1) });
        await uploadFile(cropped, { fileType: 'avatar', category: 'profile', relatedRecordType: 'contact', relatedRecordId: result.data.id, contactId: result.data.id });
      }
      state.modal = null;
      state.page = 'contacts';
      await render();
    }, 'Contato salvo.');
  });

  document.querySelector('#user-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requirePermission('users.manage')) return;
    const form = new FormData(event.currentTarget);
    const userId = String(form.get('userId') || '');
    const pin = String(form.get('pin') || '');
    if (!userId && !/^[0-9]{6,12}$/.test(pin)) {
      toast('O PIN deve ter entre 6 e 12 números.', 'warning');
      return;
    }
    if (userId && pin && !/^[0-9]{6,12}$/.test(pin)) {
      toast('O novo PIN deve ter entre 6 e 12 números.', 'warning');
      return;
    }
    await runBusy(async () => {
      const payload = {
        userId: userId || undefined,
        email: String(form.get('email') || '').trim().toLowerCase(),
        pin: pin || undefined,
        role: String(form.get('role') || ''),
        displayName: String(form.get('displayName') || '').trim(),
        preferredName: String(form.get('preferredName') || '').trim(),
        birthDate: String(form.get('birthDate') || '') || null,
        phone: String(form.get('phone') || ''),
        whatsapp: String(form.get('whatsapp') || ''),
        address: String(form.get('address') || '').trim(),
        relationshipToChild: String(form.get('relationshipToChild') || '').trim(),
        startsOn: String(form.get('startsOn') || '') || null,
        emergencyContactName: String(form.get('emergencyContactName') || '').trim(),
        emergencyContactPhone: String(form.get('emergencyContactPhone') || ''),
        notes: String(form.get('notes') || '').trim(),
        roleLabel: roleLabel(String(form.get('role') || '')),
        active: true,
      };
      const result = userId ? await updateUser(payload) : await createUser(payload);
      const savedUserId = userId || result.userId;
      if (userId && pin) await resetUserPin(savedUserId, pin);
      const photo = document.querySelector('#user-photo')?.files?.[0];
      if (photo && savedUserId) {
        const uploaded = await uploadFile(photo, {
          fileType: 'avatar',
          category: 'profile',
          relatedRecordType: 'profile',
          relatedRecordId: savedUserId,
        });
        const avatarFileId = uploaded.id || uploaded.fileId || null;
        if (avatarFileId) await updateUser({ ...payload, userId: savedUserId, avatarFileId });
      }
      state.modal = null;
      state.page = 'users';
      await render();
    }, userId ? 'Cadastro atualizado.' : 'Usuário criado.');
  });

  document.querySelector('#pin-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const pin = String(form.get('pin') || '');
    if (!/^[0-9]{6,12}$/.test(pin)) {
      toast('O PIN deve ter entre 6 e 12 números.', 'warning');
      return;
    }
    await runBusy(async () => {
      await resetUserPin(form.get('userId'), pin);
      state.modal = null;
      await render();
    }, 'PIN redefinido.');
  });

  document.querySelector('#task-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requirePermission('tasks.manage')) return;
    const form = new FormData(event.currentTarget);
    const templateId = String(form.get('template_id') || '');
    const templates = JSON.parse(event.currentTarget.dataset.templates || '[]');
    const template = templates.find((item) => item.id === templateId) || null;
    const title = templateId === 'custom' ? String(form.get('custom_title') || '').trim() : String(template?.title || '').trim();
    if (!title) return toast('Escolha ou informe um título.', 'warning');
    await runBusy(async () => {
      const dueAt = new Date(`${form.get('date')}T${form.get('time')}:00`).toISOString();
      let plannedEndAt = null;
      if (form.get('end_time')) {
        plannedEndAt = new Date(`${form.get('date')}T${form.get('end_time')}:00`).toISOString();
        if (new Date(plannedEndAt) <= new Date(dueAt)) throw new Error('A hora prevista para terminar deve ser posterior ao início.');
      }
      const checklist = String(form.get('checklist') || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      const requiresTimer = title.toLocaleLowerCase('pt-BR').includes('soneca') || form.get('requires_timer') === 'on';
      await createRoutineTask({
        family_id: state.context.membership.family_id,
        template_id: templateId && templateId !== 'custom' ? templateId : null,
        title,
        due_at: dueAt,
        planned_end_at: plannedEndAt,
        task_kind: template?.task_kind || 'routine',
        assigned_role: form.get('assigned_role'),
        instructions: String(form.get('instructions') || '').trim(),
        requires_timer: requiresTimer,
        requires_photo: form.get('requires_photo') === 'on',
        requires_note: form.get('requires_note') === 'on',
      }, checklist);
      state.modal = null;
      state.page = 'planning';
      await render();
    }, 'Afazer programado.');
  });

  document.querySelector('#routine-template-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requirePermission('tasks.manage')) return;
    const form = new FormData(event.currentTarget);
    const title = String(form.get('title') || '').trim();
    if (!title) return toast('Informe o título.', 'warning');
    const checklist = String(form.get('checklist') || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    await runBusy(async () => {
      await saveRoutineTemplate({
        id: String(form.get('id') || '') || null,
        family_id: state.context.membership.family_id,
        title,
        task_kind: title.toLocaleLowerCase('pt-BR').includes('soneca') ? 'sleep'
          : /almoço|lanche|jantar|café|refeição/i.test(title) ? 'meal'
          : /remédio|medicamento/i.test(title) ? 'medication'
          : /banho|fralda|higiene/i.test(title) ? 'hygiene'
          : 'routine',
        instructions: String(form.get('instructions') || '').trim(),
        requires_timer: title.toLocaleLowerCase('pt-BR').includes('soneca') || form.get('requires_timer') === 'on',
        requires_photo: form.get('requires_photo') === 'on',
        requires_note: form.get('requires_note') === 'on',
        active: true,
      }, checklist);
      state.modal = null;
      state.page = 'templates';
      await render();
    }, 'Título e regras salvos.');
  });

  document.querySelector('#daily-log-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requirePermission('daily_logs.create')) return;
    const form = new FormData(event.currentTarget);
    await runBusy(async () => {
      const log = await createDailyLog({
        family_id: state.context.membership.family_id,
        category: form.get('category'),
        occurred_at: new Date(form.get('occurred_at')).toISOString(),
        title: String(form.get('title') || '').trim(),
        note: String(form.get('note') || '').trim(),
      });
      const photo = document.querySelector('#daily-log-photo')?.files?.[0];
      if (photo) {
        const uploaded = await uploadFile(photo, { fileType: 'daily-log-photo', category: 'daily-log', relatedRecordType: 'daily_log', relatedRecordId: log.id });
        const fileId = uploaded.id || uploaded.fileId || null;
        if (fileId) await attachDailyLogFile(log.id, fileId);
      }
      state.modal = null;
      state.page = 'register';
      await render();
    }, 'Registro salvo.');
  });

  document.querySelector('#hospital-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requirePermission('child.edit')) return;
    const form = new FormData(event.currentTarget);
    await runBusy(async () => {
      await createEmergencyHospital({
        family_id: state.context.membership.family_id,
        name: String(form.get('name') || '').trim(),
        phone_normalized: String(form.get('phone') || '').replace(/\D/g, '') || null,
        address: String(form.get('address') || '').trim(),
        notes: String(form.get('notes') || '').trim(),
        priority: Number(form.get('priority') || 1),
      });
      state.modal = null;
      state.page = 'emergency';
      await render();
    }, 'Hospital cadastrado.');
  });

  document.querySelector('#medication-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requirePermission('medications.edit')) return;
    const form = new FormData(event.currentTarget);
    await runBusy(async () => {
      const medicationResult = await supabase.from('medications').insert({
        family_id: state.context.membership.family_id,
        name: form.get('name'),
        kind: form.get('kind'),
        dose: form.get('dose') || '',
        route: form.get('route') || '',
        guidance: form.get('instructions') || '',
        starts_on: form.get('starts_on'),
        active: true,
      }).select().single();
      if (medicationResult.error) throw medicationResult.error;
      const scheduleResult = await supabase.from('medication_schedules').insert({
        medication_id: medicationResult.data.id,
        time_of_day: form.get('time'),
        active: true,
      }).select().single();
      if (scheduleResult.error) throw scheduleResult.error;
      const end = new Date(); end.setDate(end.getDate() + 30);
      await syncMedicationTasks(supabase, medicationResult.data, [scheduleResult.data], form.get('starts_on'), end.toISOString().slice(0, 10));
      state.modal = null;
      state.page = 'medications';
      await render();
    }, 'Medicamento e afazeres cadastrados.');
  });

  document.querySelector('#event-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requirePermission('events.edit')) return;
    const form = new FormData(event.currentTarget);
    const eventId = String(form.get('event_id') || '');
    await runBusy(async () => {
      const startsRaw = String(form.get('starts_at') || '');
      const endsRaw = String(form.get('ends_at') || '');
      const startsDate = new Date(startsRaw);
      const endsDate = endsRaw ? new Date(endsRaw) : null;
      if (!startsRaw || Number.isNaN(startsDate.getTime())) throw new Error('Informe uma data e hora de início válidas.');
      if (endsDate && Number.isNaN(endsDate.getTime())) throw new Error('Informe uma data e hora de término válidas.');
      if (endsDate && endsDate < startsDate) throw new Error('O término deve ser posterior ao início.');
      const payload = {
        family_id: state.context.membership.family_id,
        title: String(form.get('title') || '').trim(),
        starts_at: startsDate.toISOString(),
        ends_at: endsDate ? endsDate.toISOString() : null,
        location: String(form.get('location') || '').trim(),
        notes: String(form.get('notes') || '').trim(),
        all_day: form.get('all_day') === 'on',
        audience_role: String(form.get('audience_role') || 'caregiver'),
        requires_acknowledgement: String(form.get('requires_acknowledgement') || 'true') === 'true',
      };
      const result = eventId
        ? await supabase.from('calendar_events').update(payload).eq('id', eventId)
        : await supabase.from('calendar_events').insert(payload);
      if (result.error) throw result.error;
      state.modal = null;
      state.page = 'planning';
      await render();
    }, eventId ? 'Evento atualizado.' : 'Evento cadastrado.');
  });

  document.querySelectorAll('[data-event-delete]').forEach((button) => button.addEventListener('click', async () => {
    if (!requirePermission('events.edit')) return;
    if (!window.confirm('Excluir este evento ou aviso?')) return;
    await runBusy(async () => {
      const result = await supabase.from('calendar_events').update({ active: false }).eq('id', button.dataset.eventDelete);
      if (result.error) throw result.error;
      state.modal = null;
      state.page = 'planning';
      await render();
    }, 'Evento excluído.');
  }));

  document.querySelectorAll('[data-ics]').forEach((button) => button.addEventListener('click', async (event) => {
    event.stopPropagation();
    const result = await supabase.from('calendar_events').select('*').eq('id', button.dataset.ics).single();
    if (result.error) return toast('Não foi possível preparar o evento para a agenda.', 'error');
    try {
      const mode = await addIcsToCalendar({
        id: result.data.id,
        title: result.data.title,
        startsAt: result.data.starts_at,
        endsAt: result.data.ends_at,
        allDay: result.data.all_day,
        location: result.data.location,
        notes: result.data.notes,
        recurrenceRule: result.data.recurrence_rule,
      });
      const message = mode === 'shared'
        ? 'Escolha o aplicativo de agenda e confirme para salvar.'
        : mode === 'google'
          ? 'O Google Agenda foi aberto com o evento preenchido. Confirme em Salvar.'
          : 'O arquivo de agenda foi preparado. Abra-o e confirme para salvar.';
      toast(message);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      toast('Não foi possível abrir o evento na agenda.', 'error');
    }
  }));

  document.querySelector('#child-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requirePermission('child.edit')) return;
    const form = new FormData(event.currentTarget);
    await runBusy(async () => {
      const current = state.modal?.data?.data || {};
      let data = {
        ...current,
        name: String(form.get('name') || '').trim(),
        birthDate: String(form.get('birthDate') || '') || null,
        motherName: String(form.get('motherName') || '').trim(),
        fatherName: String(form.get('fatherName') || '').trim(),
        bloodType: String(form.get('bloodType') || ''),
        healthPlan: String(form.get('healthPlan') || '').trim(),
        healthPlanNumber: String(form.get('healthPlanNumber') || '').trim(),
        allergies: String(form.get('allergies') || '').trim(),
        medicalConditions: String(form.get('medicalConditions') || '').trim(),
        emergencyInstructions: String(form.get('emergencyInstructions') || '').trim(),
        notes: String(form.get('notes') || '').trim(),
      };
      const recordId = String(form.get('recordId') || '');
      const saveResult = recordId
        ? await supabase.from('child_profiles').update({ data }).eq('id', recordId).select().single()
        : await supabase.from('child_profiles').insert({ family_id: state.context.membership.family_id, data }).select().single();
      if (saveResult.error) throw saveResult.error;
      const savedId = saveResult.data.id;
      const childPhoto = document.querySelector('#child-photo')?.files?.[0];
      const healthCardPhoto = document.querySelector('#health-card-photo')?.files?.[0];
      if (childPhoto) {
        const uploaded = await uploadFile(childPhoto, {
          fileType: 'child-photo',
          category: 'profile',
          relatedRecordType: 'child_profile',
          relatedRecordId: savedId,
        });
        data = { ...data, photoFileId: uploaded.id || uploaded.fileId || data.photoFileId || null };
      }
      if (healthCardPhoto) {
        const uploaded = await uploadFile(healthCardPhoto, {
          fileType: 'health-card',
          category: 'health',
          relatedRecordType: 'child_profile',
          relatedRecordId: savedId,
        });
        data = { ...data, healthCardFileId: uploaded.id || uploaded.fileId || data.healthCardFileId || null };
      }
      if (childPhoto || healthCardPhoto) {
        const updateResult = await supabase.from('child_profiles').update({ data }).eq('id', savedId);
        if (updateResult.error) throw updateResult.error;
      }
      state.modal = null;
      state.page = 'child';
      await render();
    }, 'Dados da criança salvos.');
  });

  document.querySelector('#file-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requirePermission('files.create')) return;
    if (!confirm('Confirmar o envio deste arquivo?')) return;
    const form = new FormData(event.currentTarget);
    await runBusy(async () => {
      await uploadSelectedFile(document.querySelector('#next-file'), { fileType: 'document', category: form.get('category') });
      state.modal = null;
      state.page = 'documents';
      await render();
    }, 'Arquivo enviado.');
  });

  document.querySelector('#photo-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!requirePermission('photos.create')) return;
    const form = new FormData(event.currentTarget);
    await runBusy(async () => {
      await uploadSelectedFile(document.querySelector('#gallery-photo'), { fileType: 'gallery-photo', category: String(form.get('category') || 'other') });
      state.modal = null;
      state.page = 'photos';
      await render();
    }, 'Foto adicionada.');
  });

  document.querySelector('#recipe-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const id = String(form.get('id') || '');
    if (!requirePermission(id ? 'recipes.edit' : 'recipes.create')) return;
    const rawLinks = lines(form.get('links'));
    const recipeLinks = rawLinks.map(safeExternalUrl);
    if (recipeLinks.some((url) => !url)) return toast('Informe apenas links completos iniciados por http:// ou https://.', 'warning');
    await runBusy(async () => {
      let saved = await saveRecipe({
        id: id || null,
        family_id: state.context.membership.family_id,
        title: String(form.get('title') || '').trim(),
        category: String(form.get('category') || 'other'),
        ingredients: lines(form.get('ingredients')),
        instructions: String(form.get('instructions') || '').trim(),
        links: recipeLinks,
        allergy_alert: String(form.get('allergyAlert') || '').trim(),
        notes: String(form.get('notes') || '').trim(),
        active: true,
      });
      const photo = document.querySelector('#recipe-photo')?.files?.[0];
      if (photo) {
        const uploaded = await uploadFile(photo, { fileType: 'recipe-photo', category: 'recipe', relatedRecordType: 'recipe', relatedRecordId: saved.id });
        saved = await saveRecipe({ ...saved, photo_file_id: uploaded.id || uploaded.fileId || null });
      }
      state.modal = null;
      state.page = 'recipes';
      await render();
    }, 'Receita salva.');
  });

  document.querySelector('#migration-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const source = JSON.parse(new FormData(event.currentTarget).get('json') || '{}');
      document.querySelector('#migration-result').textContent = JSON.stringify(planLegacyImport(source), null, 2);
    } catch {
      toast('O JSON fictício é inválido.', 'error');
    }
  });

  const taskTemplate = document.querySelector('#task-template');
  const taskForm = document.querySelector('#task-form');
  const applyTaskTemplate = () => {
    if (!taskTemplate || !taskForm) return;
    const templates = JSON.parse(taskForm.dataset.templates || '[]');
    const selected = templates.find((item) => item.id === taskTemplate.value);
    const custom = taskTemplate.value === 'custom';
    const customWrap = document.querySelector('#task-custom-title-wrap');
    const customInput = document.querySelector('#task-custom-title');
    if (customWrap) customWrap.hidden = !custom;
    if (customInput) customInput.required = custom;
    if (!selected) return;
    const instructions = document.querySelector('#task-instructions');
    const checklist = document.querySelector('#task-checklist');
    const timer = document.querySelector('#task-requires-timer');
    const photo = document.querySelector('#task-requires-photo');
    const note = document.querySelector('#task-requires-note');
    if (instructions) instructions.value = selected.instructions || '';
    if (checklist) checklist.value = (selected.steps || []).join('\n');
    if (timer) {
      timer.checked = Boolean(selected.requires_timer) || String(selected.title || '').toLocaleLowerCase('pt-BR').includes('soneca');
      timer.disabled = String(selected.title || '').toLocaleLowerCase('pt-BR').includes('soneca');
    }
    if (photo) photo.checked = Boolean(selected.requires_photo);
    if (note) note.checked = Boolean(selected.requires_note);
  };
  taskTemplate?.addEventListener('change', applyTaskTemplate);
  if (taskTemplate?.value) applyTaskTemplate();

  bindFilePreview('next-file');
  bindFilePreview('task-photo');
  bindFilePreview('daily-log-photo');
  bindFilePreview('child-photo');
  bindFilePreview('health-card-photo');
  bindFilePreview('user-photo');
  bindFilePreview('gallery-photo');
  bindFilePreview('recipe-photo');
  bindPhotoPreview();
}

render();

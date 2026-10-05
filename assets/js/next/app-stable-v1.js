import { supabase, signInWithPin, signOut, currentSession } from './supabase.js?v=20';
import { listUsers, createUser, setRolePermission } from './identity-client.js?v=20';

const app = document.querySelector('#app');
const AUTH_HINT_KEY = 'maria-stable-auth-hint-v1';
const PHONE_DOMAIN = 'mariaelis.app';

const ROLE_LABELS = {
  admin: 'Administrador', father: 'Pai', mother: 'Mãe', guardian: 'Responsável',
  grandparent: 'Familiar', caregiver: 'Babá', doctor: 'Médico(a)', friend: 'Amigo(a)',
  visitor: 'Amigo(a)', custom: 'Personalizado',
};
const CONFIGURABLE_ROLES = ['grandparent', 'caregiver', 'doctor', 'friend'];
const RESOURCE_LABELS = {
  child: 'Dados da Maria', contacts: 'Contatos e emergência', events: 'Agenda e eventos',
  health: 'Saúde e consultas', medications: 'Medicamentos', daily_logs: 'Registros diários',
  tasks: 'Rotina e afazeres', photos: 'Fotos', files: 'Documentos', recipes: 'Receitas', users: 'Usuários e acessos',
};

const state = {
  session: null,
  context: null,
  page: 'home',
  consultations: [],
  events: [],
  users: [],
  permissionDefinitions: [],
  roleDefaults: [],
  familyRolePermissions: [],
  lastInvite: null,
  busy: false,
};

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const attr = esc;
const nowLocalInput = () => {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0,16);
};
const localInput = (value) => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16);
};
const formatDate = (value) => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(d);
};
const digits = (value) => String(value || '').replace(/\D/g,'');
const normalizePhone = (value) => {
  let d = digits(value);
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  return d.slice(0, 11);
};
const formattedPhone = (value) => {
  const d = normalizePhone(value);
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  return d;
};
const syntheticEmail = (phone) => `${normalizePhone(phone)}@${PHONE_DOMAIN}`;
const roleLabel = (role) => ROLE_LABELS[role] || role || 'Perfil';
const isAdmin = () => ['admin','father','mother'].includes(state.context?.role);

function toast(message, error=false) {
  let region = document.querySelector('#stable-toast-region');
  if (!region) {
    region = document.createElement('div'); region.id = 'stable-toast-region'; region.className='stable-toast-region'; document.body.append(region);
  }
  const box = document.createElement('div'); box.className=`stable-toast${error?' stable-toast--error':''}`; box.textContent=message; region.append(box);
  setTimeout(()=>box.remove(), error?7000:3500);
}

function setBusy(value) {
  state.busy = value;
  document.querySelectorAll('button').forEach((b)=>{ if (b.dataset.allowBusy !== '1') b.disabled = value; });
}

function readHint() {
  try { return JSON.parse(localStorage.getItem(AUTH_HINT_KEY) || 'null'); } catch { return null; }
}
function writeHint(hint) {
  try { if (hint) localStorage.setItem(AUTH_HINT_KEY, JSON.stringify(hint)); else localStorage.removeItem(AUTH_HINT_KEY); } catch {}
}

function loginEmailFromInput(raw, hint) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value && hint?.email) return hint.email;
  if (value.includes('@')) return value;
  const phone = normalizePhone(value);
  if (phone.length < 10) throw new Error('Informe um celular com DDD.');
  return syntheticEmail(phone);
}

async function loadContext() {
  const session = await currentSession();
  if (!session) return null;
  const access = await supabase.rpc('my_access_context');
  if (access.error || !access.data?.active) throw new Error(access.error?.message || access.data?.reason || 'Seu acesso não está ativo.');
  const context = {
    session,
    familyId: access.data.family_id,
    membershipId: access.data.membership_id,
    role: access.data.role,
    displayName: access.data.display_name || session.user.email || 'Usuário',
  };
  const [defaults, familyOverrides, memberOverrides] = await Promise.all([
    supabase.from('role_permissions').select('permission_code,allowed').eq('role', context.role),
    supabase.from('family_role_permissions').select('permission_code,allowed').eq('family_id', context.familyId).eq('role', context.role),
    supabase.from('membership_permissions').select('permission_code,allowed').eq('membership_id', context.membershipId),
  ]);
  context.permissionDefaults = new Map((defaults.data || []).map(r=>[r.permission_code,Boolean(r.allowed)]));
  context.permissionFamily = new Map((familyOverrides.data || []).map(r=>[r.permission_code,Boolean(r.allowed)]));
  context.permissionMember = new Map((memberOverrides.data || []).map(r=>[r.permission_code,Boolean(r.allowed)]));
  state.session = session;
  state.context = context;

  try {
    const profile = await supabase.from('profiles').select('phone_normalized').eq('user_id', session.user.id).maybeSingle();
    const phone = normalizePhone(profile.data?.phone_normalized || '');
    if (phone.length >= 10) writeHint({ label: formattedPhone(phone), email: session.user.email, phone });
  } catch {}
  return context;
}

function can(code) {
  if (isAdmin()) return true;
  if (!state.context) return false;
  if (state.context.permissionMember.has(code)) return state.context.permissionMember.get(code) === true;
  if (state.context.permissionFamily.has(code)) return state.context.permissionFamily.get(code) === true;
  return state.context.permissionDefaults.get(code) === true;
}

function renderLogin() {
  const hint = readHint();
  const params = new URLSearchParams(location.search);
  const invitePhone = normalizePhone(params.get('phone') || '');
  const remembered = hint && !invitePhone;
  app.innerHTML = `<main class="stable-login">
    <section class="stable-login-card">
      <div class="stable-brand"><span>ME</span><div><strong>Maria Elis</strong><small>Acesso da família</small></div></div>
      <h1>${remembered ? `Olá, ${esc(hint.label || 'de novo')}` : 'Entrar no APP MARIA'}</h1>
      <p>${remembered ? 'Digite apenas seu PIN.' : 'Use seu celular com DDD e seu PIN.'}</p>
      <form id="stable-login-form" class="stable-form">
        ${remembered ? '' : `<label>Celular<input name="login" inputmode="tel" autocomplete="tel" value="${attr(invitePhone ? formattedPhone(invitePhone) : '')}" placeholder="(11) 99999-9999" required></label>`}
        <label>PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{6,12}" minlength="6" maxlength="12" autocomplete="current-password" required></label>
        <button class="stable-primary" type="submit">Entrar</button>
      </form>
      <div class="stable-login-links">
        ${remembered ? '<button type="button" class="stable-link" data-action="switch-user">Trocar usuário</button>' : '<button type="button" class="stable-link" data-action="legacy-login">Acesso antigo por e-mail</button>'}
      </div>
      <form id="stable-legacy-login-form" class="stable-form" hidden>
        <label>E-mail do acesso antigo<input name="email" type="email" autocomplete="email"></label>
        <label>PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{6,12}" minlength="6" maxlength="12"></label>
        <button class="stable-secondary" type="submit">Entrar uma vez e migrar</button>
      </form>
    </section>
  </main>`;
}

function nav() {
  const items = [
    ['home','Início'],
    ...(can('health.view') || can('health.edit') ? [['consultations','Consultas']] : []),
    ...(can('events.view') || can('events.edit') ? [['events','Eventos']] : []),
    ...(isAdmin() ? [['access','Acessos']] : []),
  ];
  return `<nav class="stable-nav">${items.map(([p,l])=>`<button data-page="${p}" class="${state.page===p?'active':''}">${esc(l)}</button>`).join('')}</nav>`;
}

function shell(content) {
  app.innerHTML = `<div class="stable-shell">
    <header class="stable-top"><div class="stable-brand"><span>ME</span><div><strong>Maria Elis</strong><small>${esc(roleLabel(state.context?.role))}</small></div></div><button class="stable-link" data-action="signout">Sair</button></header>
    <main id="main-content" class="stable-main">${content}</main>
    ${nav()}
  </div>`;
}

function renderHome() {
  const cards = [];
  if (can('health.view') || can('health.edit')) cards.push(`<button class="stable-card" data-page="consultations"><b>Consultas</b><span>Registrar rapidamente e editar depois</span></button>`);
  if (can('events.view') || can('events.edit')) cards.push(`<button class="stable-card" data-page="events"><b>Eventos</b><span>Agenda simples, sem depender de outros módulos</span></button>`);
  if (isAdmin()) cards.push(`<button class="stable-card" data-page="access"><b>Usuários e acessos</b><span>Convites, perfis e permissões</span></button>`);
  shell(`<section class="stable-hero"><p>Versão estável</p><h1>O essencial, sem complicação.</h1><span>Entrar, convidar, definir acesso e registrar consulta/evento.</span></section><section class="stable-grid">${cards.join('')}</section>`);
}

async function loadConsultations() {
  const result = await supabase.from('medical_appointments').select('id,specialty,doctor_name,clinic_or_hospital,appointment_at,updated_at').eq('family_id',state.context.familyId).order('appointment_at',{ascending:false}).limit(100);
  if (result.error) throw result.error;
  state.consultations = result.data || [];
}
function consultationCard(row) {
  return `<article class="stable-row"><button class="stable-row-main" data-consultation-edit="${attr(row.id)}"><small>${esc(formatDate(row.appointment_at))}</small><strong>${esc(row.specialty || 'Consulta')}</strong><span>${esc([row.doctor_name,row.clinic_or_hospital].filter(Boolean).join(' · ') || 'Sem outros dados')}</span></button></article>`;
}
async function renderConsultations() {
  try { await loadConsultations(); } catch(e) { return shell(`<div class="stable-error"><h2>Não foi possível carregar consultas</h2><p>${esc(e.message)}</p><button data-page="consultations">Tentar novamente</button></div>`); }
  shell(`<section class="stable-heading"><div><p>Saúde</p><h1>Consultas</h1><span>Somente a especialidade é obrigatória.</span></div>${can('health.edit')?'<button class="stable-primary" data-action="new-consultation">Nova consulta</button>':''}</section><section class="stable-list">${state.consultations.length?state.consultations.map(consultationCard).join(''):'<div class="stable-empty">Nenhuma consulta cadastrada.</div>'}</section>`);
}
function renderConsultationForm(id='') {
  const row = id ? state.consultations.find(x=>x.id===id) : null;
  shell(`<section class="stable-heading"><div><p>Consulta</p><h1>${row?'Editar':'Nova'} consulta</h1></div></section>
    <form id="consultation-form" class="stable-form stable-panel">
      <input type="hidden" name="id" value="${attr(row?.id||'')}">
      <label>Especialidade *<input name="specialty" required value="${attr(row?.specialty||'')}" placeholder="Ex.: Pediatria"></label>
      <label>Nome do médico <small>opcional</small><input name="doctor_name" value="${attr(row?.doctor_name||'')}"></label>
      <label>Local <small>opcional</small><input name="location" value="${attr(row?.clinic_or_hospital||'')}"></label>
      <div class="stable-actions"><button type="button" class="stable-secondary" data-page="consultations">Cancelar</button><button class="stable-primary" type="submit">Salvar</button></div>
    </form>`);
}
async function saveConsultation(form) {
  const data = new FormData(form);
  const specialty = String(data.get('specialty')||'').trim();
  if (!specialty) throw new Error('Informe a especialidade.');
  const result = await supabase.rpc('save_medical_appointment_quick', {
    p_id: String(data.get('id')||'').trim() || null,
    p_specialty: specialty,
    p_doctor_name: String(data.get('doctor_name')||'').trim(),
    p_location: String(data.get('location')||'').trim(),
  });
  if (result.error) throw result.error;
}

async function loadEvents() {
  const result = await supabase.from('calendar_events').select('*').eq('family_id',state.context.familyId).eq('active',true).order('starts_at',{ascending:false}).limit(100);
  if (result.error) throw result.error;
  state.events = result.data || [];
}
function eventCard(row) {
  return `<article class="stable-row"><button class="stable-row-main" data-event-edit="${attr(row.id)}"><small>${esc(formatDate(row.starts_at))}</small><strong>${esc(row.title||'Evento')}</strong><span>${esc(row.location||row.notes||'Sem detalhes')}</span></button></article>`;
}
async function renderEvents() {
  try { await loadEvents(); } catch(e) { return shell(`<div class="stable-error"><h2>Não foi possível carregar eventos</h2><p>${esc(e.message)}</p><button data-page="events">Tentar novamente</button></div>`); }
  shell(`<section class="stable-heading"><div><p>Agenda</p><h1>Eventos</h1><span>Cadastro simples e independente.</span></div>${can('events.edit')?'<button class="stable-primary" data-action="new-event">Novo evento</button>':''}</section><section class="stable-list">${state.events.length?state.events.map(eventCard).join(''):'<div class="stable-empty">Nenhum evento cadastrado.</div>'}</section>`);
}
function renderEventForm(id='') {
  const row = id ? state.events.find(x=>x.id===id) : null;
  shell(`<section class="stable-heading"><div><p>Agenda</p><h1>${row?'Editar':'Novo'} evento</h1></div></section>
    <form id="event-form" class="stable-form stable-panel">
      <input type="hidden" name="id" value="${attr(row?.id||'')}">
      <label>Título *<input name="title" required value="${attr(row?.title||'')}"></label>
      <label>Data e horário *<input name="starts_at" type="datetime-local" required value="${attr(row?.starts_at?localInput(row.starts_at):nowLocalInput())}"></label>
      <label>Local <small>opcional</small><input name="location" value="${attr(row?.location||'')}"></label>
      <label>Observações <small>opcional</small><textarea name="notes" rows="4">${esc(row?.notes||'')}</textarea></label>
      <div class="stable-actions"><button type="button" class="stable-secondary" data-page="events">Cancelar</button><button class="stable-primary" type="submit">Salvar</button></div>
    </form>`);
}
async function saveEvent(form) {
  const data = new FormData(form);
  const id = String(data.get('id')||'').trim();
  const title = String(data.get('title')||'').trim();
  const rawDate = String(data.get('starts_at')||'').trim();
  if (!title || !rawDate) throw new Error('Informe título, data e horário.');
  const startsAt = new Date(rawDate).toISOString();
  const payload = {
    family_id: state.context.familyId,
    event_type: 'event',
    title,
    starts_at: startsAt,
    ends_at: null,
    location: String(data.get('location')||'').trim(),
    notes: String(data.get('notes')||'').trim(),
    related_record_type: null,
    related_record_id: null,
    active: true,
    all_day: false,
    audience_role: 'all',
    requires_acknowledgement: false,
    updated_by: state.session.user.id,
  };
  let result;
  if (id) result = await supabase.from('calendar_events').update(payload).eq('id',id).eq('family_id',state.context.familyId);
  else result = await supabase.from('calendar_events').insert({...payload,created_by:state.session.user.id});
  if (result.error) throw result.error;
}

async function loadAccessData() {
  const [usersResult, defs, defaults, overrides] = await Promise.all([
    listUsers(),
    supabase.from('permission_definitions').select('code,resource,action,description').order('resource').order('action'),
    supabase.from('role_permissions').select('role,permission_code,allowed').in('role',CONFIGURABLE_ROLES),
    supabase.from('family_role_permissions').select('role,permission_code,allowed').eq('family_id',state.context.familyId).in('role',CONFIGURABLE_ROLES),
  ]);
  state.users = usersResult.users || [];
  if (defs.error) throw defs.error;
  state.permissionDefinitions = defs.data || [];
  state.roleDefaults = defaults.data || [];
  state.familyRolePermissions = overrides.data || [];
}
function effectiveRolePermission(role, code) {
  const override = state.familyRolePermissions.find(x=>x.role===role && x.permission_code===code);
  if (override) return Boolean(override.allowed);
  const base = state.roleDefaults.find(x=>x.role===role && x.permission_code===code);
  return Boolean(base?.allowed);
}
function permissionsMatrix() {
  const resources = [...new Set(state.permissionDefinitions.map(x=>x.resource))]
    .filter(r=>RESOURCE_LABELS[r])
    .sort((a,b)=>RESOURCE_LABELS[a].localeCompare(RESOURCE_LABELS[b],'pt-BR'));
  return `<section class="stable-permissions"><h2>Permissões por perfil</h2><p>Pai e Mãe têm acesso total. Nos demais perfis, marque o que cada um pode ver ou alterar.</p>
    <div class="stable-perm-table"><div class="stable-perm-head"><b>Área</b>${CONFIGURABLE_ROLES.map(r=>`<b>${esc(roleLabel(r))}</b>`).join('')}</div>
    ${resources.map(resource=>{
      const defs = state.permissionDefinitions.filter(x=>x.resource===resource);
      const view = defs.find(x=>x.action==='view');
      const change = defs.filter(x=>x.action!=='view');
      return `<div class="stable-perm-row"><div><strong>${esc(RESOURCE_LABELS[resource])}</strong></div>${CONFIGURABLE_ROLES.map(role=>{
        const viewChecked = view ? effectiveRolePermission(role,view.code) : change.some(d=>effectiveRolePermission(role,d.code));
        const changeChecked = change.length ? change.every(d=>effectiveRolePermission(role,d.code)) : viewChecked;
        return `<div class="stable-perm-cell">${view?`<label><input type="checkbox" data-role-view="1" data-role="${role}" data-resource="${resource}" data-code="${attr(view.code)}" ${viewChecked?'checked':''}> Ver</label>`:''}${change.length?`<label><input type="checkbox" data-role-change="1" data-role="${role}" data-resource="${resource}" ${changeChecked?'checked':''}> Alterar</label>`:''}</div>`;
      }).join('')}</div>`;
    }).join('')}</div></section>`;
}
function inviteResult() {
  if (!state.lastInvite) return '';
  const i = state.lastInvite;
  return `<section class="stable-invite-result"><h3>Convite pronto</h3><p><strong>${esc(i.name)}</strong> · ${esc(roleLabel(i.role))}</p><p>Celular: ${esc(formattedPhone(i.phone))}<br>PIN temporário: <strong>${esc(i.pin)}</strong></p><div class="stable-actions"><button class="stable-primary" data-action="share-whatsapp">Enviar pelo WhatsApp</button><button class="stable-secondary" data-action="copy-invite">Copiar convite</button></div></section>`;
}
function userCard(user) {
  const phone = user.phone_normalized ? formattedPhone(user.phone_normalized) : '';
  const label = user.display_name || user.preferred_name || phone || user.email || 'Usuário';
  return `<article class="stable-user"><div><strong>${esc(label)}</strong><span>${esc(roleLabel(user.role))}${phone?` · ${esc(phone)}`:''}</span></div><span class="stable-status ${user.active?'ok':'off'}">${user.active?'Ativo':'Inativo'}</span></article>`;
}
async function renderAccess() {
  try { await loadAccessData(); } catch(e) { return shell(`<div class="stable-error"><h2>Não foi possível carregar acessos</h2><p>${esc(e.message)}</p><button data-page="access">Tentar novamente</button></div>`); }
  shell(`<section class="stable-heading"><div><p>Administrador</p><h1>Usuários e acessos</h1><span>Convide, escolha o perfil e defina exatamente o que cada perfil pode acessar.</span></div></section>
    <section class="stable-panel"><h2>Novo convite</h2><form id="invite-form" class="stable-form stable-form-grid">
      <label>Nome *<input name="name" required></label>
      <label>Celular com DDD *<input name="phone" inputmode="tel" required></label>
      <label>Perfil *<select name="role" required><option value="grandparent">Familiar</option><option value="caregiver">Babá</option><option value="doctor">Médico(a)</option><option value="friend">Amigo(a)</option><option value="mother">Mãe — acesso total</option><option value="father">Pai — acesso total</option></select></label>
      <button class="stable-primary" type="submit">Criar convite</button>
    </form>${inviteResult()}</section>
    <section class="stable-panel"><h2>Usuários</h2><div class="stable-list">${state.users.length?state.users.map(userCard).join(''):'<div class="stable-empty">Nenhum usuário.</div>'}</div></section>
    ${permissionsMatrix()}`);
}
async function createInvite(form) {
  const data = new FormData(form);
  const name = String(data.get('name')||'').trim();
  const phone = normalizePhone(data.get('phone'));
  const role = String(data.get('role')||'').trim();
  if (!name || phone.length < 10 || !ROLE_LABELS[role]) throw new Error('Preencha nome, celular e perfil.');
  const pin = String(Math.floor(100000 + Math.random()*900000));
  const email = syntheticEmail(phone);
  const existing = state.users.find(u=>normalizePhone(u.phone_normalized||'')===phone || String(u.email||'').toLowerCase()===email);
  if (existing) throw new Error('Já existe um usuário com esse celular.');
  await createUser({ email, pin, role, displayName:name, preferredName:name, phone, whatsapp:phone, active:true });
  const link = `${location.origin}${location.pathname}?invite=1&phone=${encodeURIComponent(phone)}`;
  state.lastInvite = { name, phone, role, pin, link };
}
function inviteMessage() {
  const i = state.lastInvite;
  if (!i) return '';
  return `Você foi convidado para o APP MARIA como ${roleLabel(i.role)}.\n\nAbra: ${i.link}\nCelular: ${formattedPhone(i.phone)}\nPIN temporário: ${i.pin}\n\nDepois de entrar, guarde seu PIN.`;
}
async function toggleView(input) {
  await setRolePermission(state.context.familyId,input.dataset.role,input.dataset.code,input.checked);
}
async function toggleChange(input) {
  const role = input.dataset.role;
  const resource = input.dataset.resource;
  const codes = state.permissionDefinitions.filter(d=>d.resource===resource && d.action!=='view').map(d=>d.code);
  for (const code of codes) await setRolePermission(state.context.familyId,role,code,input.checked);
}

async function renderPage(page=state.page) {
  state.page = page;
  if (!state.context) return renderLogin();
  if (page==='consultations') return renderConsultations();
  if (page==='events') return renderEvents();
  if (page==='access' && isAdmin()) return renderAccess();
  state.page='home';
  return renderHome();
}

async function login(raw, pin, hint=null) {
  const email = loginEmailFromInput(raw,hint);
  const result = await signInWithPin(email,String(pin||''));
  if (result.error || !result.data?.session) throw result.error || new Error('Não foi possível entrar.');
  state.session = result.data.session;
  await loadContext();
  const label = String(raw||'').trim() || hint?.label || state.context.displayName;
  writeHint({label: label.includes('@') ? label : formattedPhone(label), email});
  const url = new URL(location.href); url.searchParams.delete('invite'); url.searchParams.delete('phone'); history.replaceState({},'',url);
  await renderPage('home');
}

async function init() {
  try {
    state.session = await currentSession();
    if (state.session) {
      await loadContext();
      await renderPage('home');
    } else renderLogin();
  } catch(e) {
    console.error(e);
    await signOut().catch(()=>{});
    state.session=null; state.context=null; renderLogin(); toast(e.message || 'Sessão inválida.',true);
  }
}

document.addEventListener('click', async (event) => {
  const pageBtn = event.target.closest('[data-page]');
  if (pageBtn) { event.preventDefault(); return renderPage(pageBtn.dataset.page); }
  const action = event.target.closest('[data-action]')?.dataset.action;
  try {
    if (action==='switch-user') { writeHint(null); renderLogin(); return; }
    if (action==='legacy-login') { document.querySelector('#stable-legacy-login-form')?.removeAttribute('hidden'); return; }
    if (action==='signout') { await signOut(); state.session=null; state.context=null; state.page='home'; renderLogin(); return; }
    if (action==='new-consultation') return renderConsultationForm();
    if (action==='new-event') return renderEventForm();
    if (action==='share-whatsapp' && state.lastInvite) {
      const target = state.lastInvite.phone.startsWith('55')?state.lastInvite.phone:`55${state.lastInvite.phone}`;
      window.open(`https://wa.me/${target}?text=${encodeURIComponent(inviteMessage())}`,'_blank','noopener'); return;
    }
    if (action==='copy-invite' && state.lastInvite) { await navigator.clipboard.writeText(inviteMessage()); toast('Convite copiado.'); return; }
    const c = event.target.closest('[data-consultation-edit]'); if (c) return renderConsultationForm(c.dataset.consultationEdit);
    const e = event.target.closest('[data-event-edit]'); if (e) return renderEventForm(e.dataset.eventEdit);
  } catch(e) { console.error(e); toast(e.message || 'Não foi possível concluir.',true); }
},true);

document.addEventListener('change', async (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  try {
    if (input.matches('[data-role-view]')) { setBusy(true); await toggleView(input); await renderAccess(); }
    else if (input.matches('[data-role-change]')) { setBusy(true); await toggleChange(input); await renderAccess(); }
  } catch(e) { console.error(e); toast(e.message || 'Não foi possível alterar a permissão.',true); await renderAccess(); }
  finally { setBusy(false); }
},true);

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  try {
    setBusy(true);
    if (form.id==='stable-login-form') {
      const data=new FormData(form); await login(data.get('login'),data.get('pin'),readHint()); return;
    }
    if (form.id==='stable-legacy-login-form') {
      const data=new FormData(form); await login(data.get('email'),data.get('pin'),null); return;
    }
    if (form.id==='consultation-form') { await saveConsultation(form); toast('Consulta salva.'); return renderConsultations(); }
    if (form.id==='event-form') { await saveEvent(form); toast('Evento salvo.'); return renderEvents(); }
    if (form.id==='invite-form') { await createInvite(form); await renderAccess(); toast('Convite criado.'); return; }
  } catch(e) { console.error(e); toast(e.message || 'Não foi possível concluir.',true); }
  finally { setBusy(false); }
},true);

const style = document.createElement('style');
style.textContent = `
:root{--st-bg:#f7f4ee;--st-card:#fff;--st-text:#16332f;--st-muted:#6d7c78;--st-primary:#2f7d71;--st-line:#dfe7e3;--st-danger:#a33b3b}
*{box-sizing:border-box}.stable-shell,.stable-login{min-height:100dvh;background:var(--st-bg);color:var(--st-text);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.stable-login{display:grid;place-items:center;padding:20px}.stable-login-card{width:min(440px,100%);background:var(--st-card);border:1px solid var(--st-line);border-radius:24px;padding:24px;box-shadow:0 18px 60px rgba(33,64,58,.10)}.stable-brand{display:flex;align-items:center;gap:12px}.stable-brand>span{width:44px;height:44px;border-radius:14px;background:var(--st-primary);color:#fff;display:grid;place-items:center;font-weight:800}.stable-brand strong,.stable-brand small{display:block}.stable-brand small{color:var(--st-muted);margin-top:2px}.stable-login h1{font-size:1.8rem;margin:28px 0 8px}.stable-login p{color:var(--st-muted);margin:0 0 20px}.stable-form{display:grid;gap:14px}.stable-form-grid{grid-template-columns:repeat(3,minmax(0,1fr));align-items:end}.stable-form label{display:grid;gap:6px;font-weight:700}.stable-form label small{font-weight:400;color:var(--st-muted)}.stable-form input,.stable-form select,.stable-form textarea{width:100%;border:1px solid var(--st-line);border-radius:12px;background:#fff;color:var(--st-text);padding:13px 14px;font:inherit}.stable-form textarea{resize:vertical}.stable-primary,.stable-secondary,.stable-link,.stable-nav button,.stable-card,.stable-row-main{font:inherit}.stable-primary,.stable-secondary{border-radius:12px;padding:12px 16px;font-weight:750;cursor:pointer}.stable-primary{border:0;background:var(--st-primary);color:#fff}.stable-secondary{border:1px solid var(--st-line);background:#fff;color:var(--st-text)}.stable-link{border:0;background:transparent;color:var(--st-primary);font-weight:700;padding:8px;cursor:pointer}.stable-login-links{text-align:center;margin-top:10px}.stable-top{height:72px;padding:12px 18px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--st-line);background:rgba(255,255,255,.92);position:sticky;top:0;z-index:20}.stable-main{max-width:980px;margin:0 auto;padding:24px 18px 100px}.stable-nav{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:30;width:min(720px,calc(100% - 28px));background:#fff;border:1px solid var(--st-line);border-radius:18px;padding:8px;display:flex;gap:6px;box-shadow:0 14px 40px rgba(33,64,58,.14)}.stable-nav button{flex:1;border:0;border-radius:12px;background:transparent;padding:12px 8px;color:var(--st-muted);font-weight:700}.stable-nav button.active{background:#e8f2ef;color:var(--st-text)}.stable-hero{padding:18px 0 26px}.stable-hero p,.stable-heading p{margin:0;text-transform:uppercase;letter-spacing:.08em;font-size:.72rem;font-weight:800;color:var(--st-primary)}.stable-hero h1{font-size:clamp(2rem,5vw,3.2rem);line-height:1.05;margin:8px 0 10px}.stable-hero span,.stable-heading span{color:var(--st-muted)}.stable-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.stable-card{border:1px solid var(--st-line);border-radius:18px;background:#fff;padding:18px;text-align:left;min-height:130px;cursor:pointer}.stable-card b,.stable-card span{display:block}.stable-card b{font-size:1.15rem}.stable-card span{color:var(--st-muted);margin-top:8px;line-height:1.4}.stable-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:20px}.stable-heading h1{margin:4px 0;font-size:2rem}.stable-panel,.stable-permissions{background:#fff;border:1px solid var(--st-line);border-radius:18px;padding:18px;margin-bottom:18px}.stable-list{display:grid;gap:10px}.stable-row,.stable-user{background:#fff;border:1px solid var(--st-line);border-radius:16px}.stable-row-main{width:100%;border:0;background:transparent;text-align:left;padding:16px;display:grid;gap:4px;color:inherit}.stable-row-main small,.stable-row-main span,.stable-user span{color:var(--st-muted)}.stable-row-main strong{font-size:1.05rem}.stable-empty,.stable-error{padding:28px;border:1px dashed var(--st-line);border-radius:16px;text-align:center;color:var(--st-muted)}.stable-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:8px}.stable-invite-result{margin-top:18px;padding:16px;border-radius:14px;background:#eef7f4}.stable-user{padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px}.stable-user strong,.stable-user span{display:block}.stable-status{padding:5px 9px;border-radius:999px;font-size:.75rem;font-weight:800}.stable-status.ok{background:#e7f6ee;color:#246b48}.stable-status.off{background:#f5e9e9;color:#8d3939}.stable-permissions h2{margin-top:0}.stable-permissions>p{color:var(--st-muted)}.stable-perm-table{display:grid;gap:0;border:1px solid var(--st-line);border-radius:14px;overflow:auto}.stable-perm-head,.stable-perm-row{display:grid;grid-template-columns:minmax(180px,1.4fr) repeat(4,minmax(130px,1fr));min-width:740px}.stable-perm-head{background:#f4f7f5}.stable-perm-head>*{padding:12px;border-right:1px solid var(--st-line)}.stable-perm-row>div{padding:12px;border-top:1px solid var(--st-line);border-right:1px solid var(--st-line)}.stable-perm-cell{display:grid;gap:7px}.stable-perm-cell label{display:flex;gap:7px;align-items:center;font-size:.9rem}.stable-toast-region{position:fixed;z-index:20000;top:16px;left:50%;transform:translateX(-50%);width:min(92vw,520px);display:grid;gap:8px}.stable-toast{padding:13px 16px;border-radius:12px;background:#225d54;color:#fff;font-weight:750;box-shadow:0 12px 34px rgba(0,0,0,.22)}.stable-toast--error{background:var(--st-danger)}
@media(max-width:760px){.stable-grid{grid-template-columns:1fr}.stable-form-grid{grid-template-columns:1fr}.stable-heading{align-items:flex-start;flex-direction:column}.stable-heading>.stable-primary{width:100%}.stable-main{padding-top:18px}.stable-nav{bottom:8px}.stable-nav button{font-size:.86rem;padding:11px 5px}.stable-actions{flex-direction:column}.stable-actions button{width:100%}.stable-login-card{padding:20px}.stable-top .stable-brand small{display:none}}
`;
document.head.append(style);

init();

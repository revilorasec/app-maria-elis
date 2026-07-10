import { loadData, addRecord, updateRecord, saveData, resetLocalCache, localDate, setPersistence, flushPersistence } from './services/dataService.js';
import { can, getRoleLabel } from './services/permissionsService.js';
import { notify, offlineNotice } from './services/notificationService.js';
import { lineChart, donutChart } from './services/chartService.js';
import { exportBackup, printDailyReport } from './services/reportService.js';
import { clearOneDriveConfig, initializeMicrosoftSession, saveOneDriveConfig, signInMicrosoft, signOutMicrosoft } from './auth.js';
import { connectOneDrive, getFileUrl, getRootWebUrl, loadDB, restoreDB, saveDB, uploadFile } from './storage.js';
import { eventPhotoPath, listPendingPhotos, queuePendingPhoto, removePendingPhoto, resizeImage } from './photos.js';
import { renderConnectionStatus } from './ui.js';

const app = document.querySelector('#app');
const pageNames = {
  home: 'Início', instructions: 'Orientações', register: 'Registrar', emergency: 'Emergência', more: 'Mais',
  documents: 'Documentos', vaccines: 'Vacinas', appointments: 'Consultas', growth: 'Crescimento',
  medications: 'Medicamentos', routine: 'Rotina', settings: 'Configurações'
};
let currentPage = 'home';
let selectedRegisterType = 'observação';
let data;
let user;
let oneDriveConfig;
let microsoftAccount;
let syncState = 'Conectando';

init();

async function init() {
  applyTheme();
  registerServiceWorker();
  bindConnectivity();
  try {
    const session = await initializeMicrosoftSession();
    oneDriveConfig = session.config;
    if (!oneDriveConfig) return renderSetup();
    if (!session.account) return renderLogin();

    microsoftAccount = session.account;
    syncState = 'Conectando ao OneDrive';
    app.innerHTML = '<main class="fatal"><h1>Conectando ao OneDrive…</h1><p>Carregando a área privada da Maria.</p></main>';
    const initialData = await loadData();
    await connectOneDrive(oneDriveConfig.folderName);
    data = await loadData(await loadDB(initialData));
    setPersistence({
      save: async (snapshot) => {
        setSyncState('Salvando');
        const saved = await saveDB(snapshot);
        data.meta = saved.meta;
        setSyncState('Sincronizado');
      },
      onError: (error) => {
        setSyncState('Pendente');
        notify(`Alteração guardada neste aparelho. A sincronização falhou: ${error.message}`, 'warning');
      }
    });
    user = resolveAuthorizedUser(microsoftAccount);
    await syncPendingPhotoUploads();
    syncState = 'Sincronizado';
    render();
  } catch (error) {
    app.innerHTML = `<main class="fatal"><h1>Não foi possível conectar</h1><p>${escape(error.message)}</p><button class="button" data-action="reconfigure-onedrive">Revisar configuração</button></main>`;
  }
}

function resolveAuthorizedUser(account) {
  const email = String(account.username || '').trim().toLowerCase();
  const registered = (data.users || []).filter((item) => item.email && !item.email.endsWith('.invalid'));
  if (!registered.length) {
    const firstAdmin = {
      id: `user-${crypto.randomUUID()}`,
      name: account.name || account.username || 'Responsável',
      email,
      phone: '',
      role: 'admin',
      active: true,
      createdAt: new Date().toISOString()
    };
    data.users = [firstAdmin];
    data.auditLog = data.auditLog || [];
    data.auditLog.unshift({ id: `audit-${crypto.randomUUID()}`, userId: firstAdmin.id, action: 'bootstrap', entityType: 'user', entityId: firstAdmin.id, oldValue: null, newValue: '[primeiro responsável autorizado]', createdAt: new Date().toISOString() });
    saveData(data);
    return firstAdmin;
  }
  const found = registered.find((item) => item.email.toLowerCase() === email && item.active);
  if (!found) throw new Error(`A conta ${email || 'Microsoft selecionada'} ainda não está autorizada neste dados.json.`);
  return found;
}

function renderSetup() {
  app.innerHTML = `<main class="fatal"><p class="eyebrow">Configuração inicial</p><h1>Conectar ao OneDrive</h1><p>Informe apenas os identificadores públicos do aplicativo Microsoft. Eles ficam neste navegador; senha e client secret não são usados.</p><form id="onedrive-setup-form" class="form-card"><label>ID do aplicativo cliente<input name="clientId" required autocomplete="off" placeholder="00000000-0000-0000-0000-000000000000"></label><label>ID do diretório/locatário<input name="tenantId" value="organizations" required autocomplete="off"></label><label>Pasta no OneDrive<input name="folderName" value="(APP MARIA ELIS)" required></label><button class="button button--wide" type="submit">Salvar e entrar com Microsoft</button></form></main>`;
}

function renderLogin() {
  app.innerHTML = `<main class="fatal"><p class="eyebrow">Área privada</p><h1>Entrar com Microsoft</h1><p>Ao entrar, o app usa a pasta <strong>${escape(oneDriveConfig.folderName)}</strong> no OneDrive da conta autorizada.</p><button class="button button--wide" data-action="microsoft-login">Entrar com Microsoft</button><button class="text-button" data-action="reconfigure-onedrive">Alterar configuração</button></main>`;
}

function setSyncState(value) {
  syncState = value;
  const badge = document.querySelector('#sync-indicator');
  if (badge) badge.textContent = value;
}
function render() {
  const profile = data.childProfile;
  app.innerHTML = `
    <header class="topbar">
      <div class="topbar__identity">
        <img src="${escape(profile.photoUrl)}" alt="Avatar ilustrativo" class="topbar__avatar">
        <div><p class="eyebrow">Cuidado da criança</p><strong>${escape(profile.name)}</strong></div>
      </div>
      <div class="topbar__actions">
        <span id="sync-indicator" class="offline-indicator">${escape(syncState)}</span><span id="offline-indicator" class="offline-indicator" ${navigator.onLine ? 'hidden' : ''}>Offline</span>
        <button class="icon-button" data-action="toggle-theme" aria-label="Alternar tema" title="Alternar tema">◐</button>
      </div>
    </header>
    <main id="main-content" class="main-content" tabindex="-1">
      ${renderPage()}
    </main>
    ${renderNavigation()}
    <div id="modal-root"></div>
  `;
}

function renderPage() {
  switch (currentPage) {
    case 'home': return renderHome();
    case 'instructions': return renderInstructions();
    case 'register': return renderRegister();
    case 'emergency': return renderEmergency();
    case 'more': return renderMore();
    case 'documents': return renderDocuments();
    case 'vaccines': return renderVaccines();
    case 'appointments': return renderAppointments();
    case 'growth': return renderGrowth();
    case 'medications': return renderMedications();
    case 'routine': return renderRoutine();
    case 'settings': return renderSettings();
    default: return renderHome();
  }
}

function renderHome() {
  const today = localDate();
  const todayTasks = data.dailyTasks.filter((task) => task.date === today);
  const completed = todayTasks.filter(isDone).length;
  const pending = todayTasks.length - completed;
  const nextAppointment = data.appointments.filter((item) => item.status === 'scheduled').sort((a, b) => a.date.localeCompare(b.date))[0];
  const vaccineAlert = data.vaccines.find((vaccine) => vaccine.status === 'overdue') || data.vaccines.find((vaccine) => vaccine.status === 'upcoming');
  const lastGrowth = [...data.growthRecords].sort((a, b) => b.date.localeCompare(a.date))[0];
  const unread = !data.dailyConfirmations.some((item) => item.instructionId === 'inst-demo-today' && item.userId === user.id);
  const latestPhotos = data.dailyPhotos.filter((photo) => photo.date === today).slice(0, 3);

  return `
    <section class="page-heading">
      <div><p class="eyebrow">${formatLongDate(today)}</p><h1>Bom dia, ${escape(firstName(user.name))}.</h1><p class="muted">O essencial da rotina em um só lugar.</p></div>
      <button class="avatar-button" data-page="settings" aria-label="Abrir configurações de perfil">${initials(user.name)}</button>
    </section>

    <section class="hero-card">
      <div class="hero-card__copy"><span class="status-pill status-pill--soft">${escape(ageFrom(profile().birthDate))}</span><h2>${escape(profile().name)}</h2><p>${escape(sessionSummary(user))}</p></div>
      <img src="${escape(profile().photoUrl)}" alt="Avatar ilustrativo da criança" class="hero-card__avatar">
    </section>

    <section class="quick-actions" aria-label="Registros rápidos">
      <button class="quick-action" data-quick="foto"><span>◉</span>Foto</button>
      <button class="quick-action" data-quick="alimentação"><span>◌</span>Alimentação</button>
      <button class="quick-action" data-quick="sono"><span>☾</span>Sono</button>
      <button class="quick-action" data-quick="medicamento"><span>✚</span>Remédio</button>
      <button class="quick-action" data-quick="sintoma"><span>⌁</span>Sintoma</button>
      <button class="quick-action" data-quick="observação"><span>✎</span>Nota</button>
    </section>

    <section class="section-block">
      <div class="section-title"><div><p class="eyebrow">Hoje</p><h2>Plano do dia</h2></div><button class="text-button" data-page="instructions">Ver tudo</button></div>
      <article class="progress-card">
        ${donutChart({ completed, pending })}
        <div><strong>${completed} de ${todayTasks.length} tarefas concluídas</strong><p class="muted">${unread ? 'As orientações ainda precisam ser confirmadas.' : 'Orientações confirmadas.'}</p><button class="button button--secondary button--small" data-page="instructions">Abrir orientações</button></div>
      </article>
    </section>

    <section class="section-block">
      <div class="section-title"><div><p class="eyebrow">Atenção</p><h2>Alertas importantes</h2></div></div>
      <div class="alert-stack">
        ${unread ? alertCard('Orientações ainda não confirmadas', 'Confirme a leitura para os responsáveis acompanharem.', 'instructions', 'important') : ''}
        ${todayTasks.filter((task) => task.priority === 'required' && !isDone(task)).map((task) => alertCard(`${task.title} pendente`, `Previsto para ${task.scheduledTime}.`, 'instructions', 'danger')).join('')}
        ${vaccineAlert ? alertCard(`Vacina ${vaccineAlert.status === 'overdue' ? 'em atraso' : 'próxima'}`, `${vaccineAlert.name} · ${formatDate(vaccineAlert.expectedDate)}`, 'vaccines', vaccineAlert.status === 'overdue' ? 'danger' : 'info') : ''}
        ${nextAppointment ? alertCard('Próxima consulta', `${nextAppointment.specialty} · ${formatDate(nextAppointment.date)} às ${nextAppointment.time}`, 'appointments', 'info') : ''}
      </div>
    </section>

    <section class="section-block two-up">
      <article class="mini-card" data-page="growth" role="button" tabindex="0"><span class="mini-card__icon">↗</span><p class="eyebrow">Crescimento</p><strong>${lastGrowth ? `${lastGrowth.weight.toFixed(1)} kg` : 'Sem dados'}</strong><p class="muted">Último registro</p></article>
      <article class="mini-card" data-page="routine" role="button" tabindex="0"><span class="mini-card__icon">◷</span><p class="eyebrow">Registros</p><strong>${data.dailyLogs.filter((log) => log.date === today).length}</strong><p class="muted">Hoje</p></article>
    </section>

    <section class="section-block">
      <div class="section-title"><div><p class="eyebrow">Acompanhar</p><h2>Últimos registros</h2></div><button class="text-button" data-page="routine">Timeline</button></div>
      <div class="timeline compact">${renderTimeline(today, 4)}</div>
    </section>

    ${latestPhotos.length ? `<section class="section-block"><div class="section-title"><div><p class="eyebrow">Registros visuais</p><h2>Fotos de hoje</h2></div></div><div class="photo-strip">${latestPhotos.map(renderPhoto).join('')}</div></section>` : ''}
  `;
}

function renderInstructions() {
  const today = localDate();
  const instruction = data.dailyInstructions.find((item) => item.date === today);
  const tasks = data.dailyTasks.filter((task) => task.date === today).sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime));
  const confirmation = instruction && data.dailyConfirmations.find((item) => item.instructionId === instruction.id && item.userId === user.id);
  const completed = tasks.filter(isDone).length;
  const canConfirm = can(user.role, 'instructions:confirm');
  const canComplete = can(user.role, 'tasks:complete');

  return `
    ${subPageHeading('Orientações do Dia', 'Uma rotina clara, simples e acompanhável.')}
    <article class="instruction-hero">
      <div><span class="status-pill status-pill--soft">${formatDate(today)}</span><h2>${escape(instruction?.title || 'Sem plano publicado')}</h2><p>${escape(instruction?.description || 'Crie as orientações do dia para começar.')}</p></div>
      ${instruction ? (confirmation ? `<span class="confirmation confirmation--done">✓ Leitura confirmada</span>` : `<button class="button" data-action="confirm-reading" ${canConfirm ? '' : 'disabled'}>Li e entendi</button>`) : ''}
    </article>
    ${!canConfirm && instruction && !confirmation ? `<p class="permission-note">Seu perfil pode visualizar, mas não confirmar estas orientações.</p>` : ''}
    <section class="section-block">
      <div class="section-title"><div><p class="eyebrow">Checklist</p><h2>${completed}/${tasks.length} concluídas</h2></div><button class="text-button" data-action="print-report">Resumo</button></div>
      <div class="task-list">${tasks.map((task) => renderTask(task, canComplete)).join('') || emptyState('Ainda não há tarefas para hoje.', 'Criar registro', 'register')}</div>
    </section>
    <section class="section-block">
      <div class="section-title"><div><p class="eyebrow">Feed do dia</p><h2>O que aconteceu</h2></div><button class="text-button" data-page="routine">Ver timeline</button></div>
      <div class="timeline">${renderTimeline(today, 12)}</div>
    </section>
  `;
}

function renderRegister() {
  const options = [
    ['foto', '◉', 'Tirar foto'], ['alimentação', '◌', 'Alimentação'], ['sono', '☾', 'Sono'],
    ['medicamento', '✚', 'Medicamento'], ['sintoma', '⌁', 'Sintoma'], ['observação', '✎', 'Observação'],
    ['tarefa', '✓', 'Tarefa concluída'], ['evento', '★', 'Evento importante']
  ];
  const hasPermission = can(user.role, 'logs:create');
  const requiresPhoto = selectedRegisterType === 'foto';
  return `
    ${subPageHeading('Registrar', 'Poucos toques para contar como foi o dia.')}
    <section class="register-picker" aria-label="Tipo de registro">${options.map(([id, icon, label]) => `<button class="register-type ${selectedRegisterType === id ? 'register-type--active' : ''}" data-register-type="${id}" ${id === 'foto' && !can(user.role, 'photos:attach') ? 'disabled' : ''}><span>${icon}</span>${label}</button>`).join('')}</section>
    <form id="quick-form" class="form-card" novalidate>
      <input type="hidden" name="type" value="${escape(selectedRegisterType)}">
      <div class="form-card__title"><span class="form-icon">${options.find((option) => option[0] === selectedRegisterType)?.[1] || '✎'}</span><div><h2>${escape(options.find((option) => option[0] === selectedRegisterType)?.[2] || 'Registro')}</h2><p class="muted">Será salvo no feed de hoje.</p></div></div>
      <label>Horário<input type="time" name="time" value="${currentTime()}" required></label>
      <label>Descrição<textarea name="description" rows="4" placeholder="Conte o que aconteceu…" required></textarea></label>
      ${selectedRegisterType === 'sono' ? `<div class="form-grid"><label>Início<input type="time" name="sleepStart"></label><label>Fim<input type="time" name="sleepEnd"></label></div>` : ''}
      ${selectedRegisterType === 'sintoma' ? `<label>Sintoma principal<input name="symptoms" placeholder="Ex.: tosse, febre, irritação"></label>` : ''}
      ${selectedRegisterType === 'tarefa' ? `<label>Tarefa relacionada<select name="taskId"><option value="">Nenhuma / registro livre</option>${data.dailyTasks.filter((task) => task.date === localDate() && !isDone(task)).map((task) => `<option value="${task.id}">${escape(task.title)}</option>`).join('')}</select></label>` : ''}
      <label class="check-row"><input type="checkbox" name="important"> Marcar como importante</label>
      ${requiresPhoto ? photoInput() : `<button type="button" class="attachment-button" data-action="open-photo" data-context="free">◉ Adicionar foto (opcional)</button>`}
      <button class="button button--wide" type="submit" ${hasPermission ? '' : 'disabled'}>Salvar registro</button>
      ${!hasPermission ? '<p class="permission-note">Seu perfil atual não pode criar registros.</p>' : ''}
    </form>
  `;
}

function renderEmergency() {
  const contacts = [...data.emergencyContacts].sort((a, b) => a.priority - b.priority);
  const doctor = data.doctors[0];
  return `
    ${subPageHeading('Emergência', 'Informações essenciais para agir rápido.')}
    <section class="emergency-banner"><span>⚕</span><div><h2>Em risco imediato?</h2><p>Ligue para o serviço de emergência da sua região. Este app não substitui orientação médica.</p></div></section>
    <section class="section-block"><div class="section-title"><div><p class="eyebrow">Ligar agora</p><h2>Responsáveis</h2></div></div><div class="contact-list">${contacts.map(renderContact).join('')}</div></section>
    <section class="section-block"><div class="section-title"><div><p class="eyebrow">Saúde</p><h2>Resumo crítico</h2></div></div>
      <article class="critical-card"><div><span>Alergias</span><strong>${escape(profile().allergies.join(', '))}</strong></div><div><span>Tipo sanguíneo</span><strong>${escape(profile().bloodType)}</strong></div><div class="critical-card__wide"><span>Observações</span><strong>${escape(profile().criticalNotes)}</strong></div></article>
    </section>
    ${doctor ? `<section class="section-block"><div class="section-title"><div><p class="eyebrow">Profissional</p><h2>${escape(doctor.specialty)}</h2></div></div><article class="contact-card"><div class="contact-card__avatar">⚕</div><div><strong>${escape(doctor.name)}</strong><p>${escape(doctor.clinic)}</p></div><a class="call-button" href="tel:${phoneHref(doctor.phone)}" aria-label="Ligar para profissional">☎</a></article></section>` : ''}
  `;
}

function renderMore() {
  const items = [
    ['documents', '▣', 'Documentos', 'Arquivos privados no OneDrive'], ['vaccines', '◈', 'Vacinas', 'Histórico e alertas'],
    ['appointments', '◷', 'Consultas', 'Agenda e retornos'], ['growth', '↗', 'Crescimento', 'Peso, altura e IMC'],
    ['medications', '✚', 'Medicamentos', 'Uso e confirmações'], ['routine', '☰', 'Rotina', 'Timeline e registros'],
    ['settings', '⚙', 'Configurações', 'OneDrive, backup e acesso']
  ];
  return `
    ${subPageHeading('Mais', 'Informações organizadas para quando você precisar.')}
    <section class="menu-list">${items.map(([page, icon, title, copy]) => `<button class="menu-item" data-page="${page}"><span class="menu-item__icon">${icon}</span><span><strong>${title}</strong><small>${copy}</small></span><span class="chevron">›</span></button>`).join('')}</section>
    <section class="demo-note"><span>☁</span><div><strong>Dados privados no OneDrive</strong><p>Os registros e anexos ficam na pasta privada da família, não no GitHub.</p></div></section>
  `;
}
function renderDocuments() {
  const allowed = can(user.role, 'documents:view');
  if (!allowed) return restrictedPage('Documentos', 'Documentos e resultados clínicos são restritos por padrão para cuidadores e visitantes.');
  const canUpload = can(user.role, 'documents:create');
  const records = data.documents || [];
  return `${subPageHeading('Documentos', 'Anexos privados organizados no OneDrive.')}
    ${canUpload ? `<section class="settings-card"><h2>Adicionar documento</h2><form id="attachment-form" class="form-card"><label>Título<input name="title" required placeholder="Ex.: Carteira de vacinação"></label><label>Categoria<select name="category"><option>Saúde</option><option>Documentos pessoais</option><option>Escola</option><option>Outros</option></select></label><label>Arquivo<input name="attachment" type="file" required></label><label>Observação<textarea name="description" rows="2" placeholder="Opcional"></textarea></label><button class="button button--wide" type="submit">Enviar para o OneDrive</button></form></section>` : ''}
    <p class="privacy-inline">🔒 Os arquivos reais permanecem em <strong>Anexos/</strong> no OneDrive. O repositório não recebe documentos ou fotos.</p>
    <div class="record-list">${records.map((document) => `<article class="record-card"><span class="record-icon">▣</span><div><span class="status-pill status-pill--soft">${escape(document.category)}</span><h2>${escape(document.title)}</h2><p>${escape(document.description || 'Sem observação.')}</p><small>${document.filePath ? escape(document.filePath) : document.expirationDate ? `Validade: ${formatDate(document.expirationDate)}` : 'Sem arquivo anexado'}</small></div>${document.filePath ? `<button class="icon-button" data-action="open-document" data-path="${escape(document.filePath)}" aria-label="Abrir ${escape(document.title)}">›</button>` : ''}</article>`).join('') || emptyState('Nenhum documento cadastrado.', 'Envie o primeiro arquivo privado.', '')}</div>`;
}
function renderVaccines() {
  const allowed = can(user.role, 'vaccines:view');
  if (!allowed) return restrictedPage('Vacinas', 'O histórico completo de vacinação é visível somente a responsáveis autorizados.');
  const applied = data.vaccines.filter((item) => item.status === 'applied').length;
  return `${subPageHeading('Vacinas', 'Histórico, comprovantes privados e alertas.')}
    <section class="metric-row"><article class="metric-card"><strong>${applied}</strong><span>aplicadas</span></article><article class="metric-card metric-card--warning"><strong>${data.vaccines.length - applied}</strong><span>pendentes</span></article></section>
    <section class="chart-card"><div class="section-title"><div><p class="eyebrow">Situação</p><h2>Aplicadas x pendentes</h2></div></div>${donutChart({ completed: applied, pending: data.vaccines.length - applied })}</section>
    <div class="record-list">${data.vaccines.map((vaccine) => `<article class="record-card"><span class="record-icon">◈</span><div><span class="status-pill ${statusClass(vaccine.status)}">${statusLabel(vaccine.status)}</span><h2>${escape(vaccine.name)}</h2><p>${escape(vaccine.dose)} · ${formatDate(vaccine.expectedDate)}</p><small>${vaccine.appliedDate ? `Aplicada em ${formatDate(vaccine.appliedDate)}` : 'Sem comprovante no protótipo'}</small></div></article>`).join('')}</div>`;
}

function renderAppointments() {
  const allowed = can(user.role, 'appointments:view');
  if (!allowed) return restrictedPage('Consultas', 'Consultas e orientações médicas são restritas por padrão para cuidadores e visitantes.');
  return `${subPageHeading('Consultas', 'Agenda, histórico e próximos retornos.')}
    <div class="record-list">${[...data.appointments].sort((a, b) => b.date.localeCompare(a.date)).map((appointment) => `<article class="record-card"><span class="record-icon">◷</span><div><span class="status-pill ${statusClass(appointment.status)}">${statusLabel(appointment.status)}</span><h2>${escape(appointment.specialty)}</h2><p>${escape(appointment.doctorName)} · ${formatDate(appointment.date)} às ${escape(appointment.time)}</p><small>${escape(appointment.reason)}</small>${appointment.nextReturnDate ? `<small class="record-detail">Retorno: ${formatDate(appointment.nextReturnDate)}</small>` : ''}</div></article>`).join('')}</div>`;
}

function renderGrowth() {
  const allowed = can(user.role, 'growth:view');
  if (!allowed) return restrictedPage('Crescimento', 'Dados de crescimento são restritos por padrão para cuidadores e visitantes.');
  const records = [...data.growthRecords].sort((a, b) => a.date.localeCompare(b.date));
  const last = records.at(-1);
  return `${subPageHeading('Crescimento', 'Evolução apresentada de forma simples.')}
    <section class="metric-row"><article class="metric-card"><strong>${last.weight.toFixed(1)} kg</strong><span>peso atual</span></article><article class="metric-card"><strong>${last.height.toFixed(0)} cm</strong><span>altura atual</span></article><article class="metric-card"><strong>${last.bmi.toFixed(1)}</strong><span>IMC</span></article></section>
    <section class="chart-card"><div class="section-title"><div><p class="eyebrow">Filtro: todo o período</p><h2>Evolução de peso</h2></div></div>${lineChart(records, { label: 'Evolução do peso', valueKey: 'weight', formatter: (value) => `${value.toFixed(1)} kg` })}</section>
    <section class="chart-card"><div class="section-title"><div><p class="eyebrow">Filtro: todo o período</p><h2>Evolução de altura</h2></div></div>${lineChart(records, { label: 'Evolução da altura', valueKey: 'height', formatter: (value) => `${value.toFixed(0)} cm` })}</section>
    <section class="chart-card"><div class="section-title"><div><p class="eyebrow">Filtro: todo o período</p><h2>Evolução de IMC</h2></div></div>${lineChart(records, { label: 'Evolução do IMC', valueKey: 'bmi', formatter: (value) => value.toFixed(1) })}</section>`;
}

function renderMedications() {
  const allowed = can(user.role, 'medications:view');
  if (!allowed) return restrictedPage('Medicamentos', 'A lista de medicamentos é restrita por padrão para cuidadores e visitantes.');
  return `${subPageHeading('Medicamentos', 'Uso previsto, confirmação e histórico.')}
    <div class="record-list">${data.medications.map((medication) => `<article class="record-card"><span class="record-icon">✚</span><div><span class="status-pill ${statusClass(medication.status)}">${statusLabel(medication.status)}</span><h2>${escape(medication.name)}</h2><p>${escape(medication.dosage)} · ${escape(medication.schedule)}</p><small>${escape(medication.notes)}</small></div></article>`).join('') || emptyState('Nenhum medicamento ativo.', '', '')}</div>
    <p class="privacy-inline">Apenas informações confirmadas por um profissional devem ser cadastradas.</p>`;
}

function renderRoutine() {
  const today = localDate();
  return `${subPageHeading('Rotina', 'A timeline reúne tarefas, fotos e registros livres.')}
    <section class="date-chip-row"><button class="date-chip date-chip--active">Hoje · ${formatDate(today)}</button></section>
    <section class="section-block"><div class="section-title"><div><p class="eyebrow">Timeline</p><h2>Dia em andamento</h2></div><button class="text-button" data-page="register">Registrar</button></div><div class="timeline">${renderTimeline(today, 100)}</div></section>`;
}

function renderSettings() {
  return `${subPageHeading('Configurações', 'OneDrive, backup e acesso da família.')}
    <section class="settings-card"><div class="setting-line"><div><strong>Conta conectada</strong><p>${escape(renderConnectionStatus(microsoftAccount, oneDriveConfig.folderName))}</p></div><span class="status-pill status-pill--success">${escape(syncState)}</span></div></section>
    <section class="settings-card"><div class="setting-line"><div><strong>Pasta privada</strong><p>${escape(oneDriveConfig.folderName)} · dados.json, Backup, Fotos e Anexos.</p></div><button class="button button--secondary button--small" data-action="open-onedrive">Abrir</button></div></section>
    <section class="settings-card"><div class="setting-line"><div><strong>Sincronização</strong><p>Salva as alterações no dados.json e tenta enviar fotos pendentes.</p></div><button class="button button--secondary button--small" data-action="sync-now">Sincronizar</button></div></section>
    <section class="settings-card"><div class="setting-line"><div><strong>Backup automático</strong><p>É criado no OneDrive, uma vez por dia, antes da próxima gravação.</p></div><button class="button button--secondary button--small" data-action="restore-backup">Restaurar</button></div></section>
    <section class="settings-card"><div class="setting-line"><div><strong>Cópia neste aparelho</strong><p>Baixa um JSON local para conferência, sem expor dados no GitHub.</p></div><button class="button button--secondary button--small" data-action="export-backup">Baixar</button></div></section>
    <section class="settings-card"><div class="setting-line"><div><strong>Tema</strong><p>Claro, escuro ou conforme o aparelho.</p></div><button class="button button--secondary button--small" data-action="toggle-theme">Alternar</button></div></section>
    <section class="settings-card"><div class="setting-line"><div><strong>Conta Microsoft</strong><p>Use sair somente neste navegador; os arquivos continuam no OneDrive.</p></div><button class="button button--danger button--small" data-action="sign-out-microsoft">Sair</button></div></section>
    <section class="settings-card"><div class="setting-line"><div><strong>Alterar conexão</strong><p>Troca o ID do aplicativo, locatário ou pasta neste aparelho.</p></div><button class="button button--secondary button--small" data-action="reconfigure-onedrive">Alterar</button></div></section>`;
}
function renderNavigation() {
  const tabs = [['home', '⌂', 'Início'], ['instructions', '☑', 'Orientações'], ['register', '＋', 'Registrar'], ['emergency', '⚕', 'Emergência'], ['more', '☰', 'Mais']];
  return `<nav class="bottom-nav" aria-label="Navegação principal">${tabs.map(([page, icon, label]) => `<button class="nav-item ${currentPage === page ? 'nav-item--active' : ''} ${page === 'register' ? 'nav-item--primary' : ''}" data-page="${page}" aria-current="${currentPage === page ? 'page' : 'false'}"><span>${icon}</span><small>${label}</small></button>`).join('')}</nav>`;
}

function renderTask(task, canComplete) {
  const done = isDone(task);
  const late = !done && isLate(task);
  return `<article class="task-card ${done ? 'task-card--done' : ''} ${late ? 'task-card--late' : ''}">
    <div class="task-card__time">${escape(task.scheduledTime)}</div><div class="task-card__body"><div class="task-card__meta"><span class="category-tag">${escape(task.category)}</span>${task.requiresPhoto ? '<span title="Exige foto" aria-label="Exige foto">◉</span>' : ''}${task.priority === 'required' ? '<span class="required-label">Obrigatório</span>' : ''}</div><h2>${escape(task.title)}</h2><p>${escape(task.description)}</p>${task.comments?.length ? `<small>💬 ${escape(task.comments.at(-1).comment)}</small>` : ''}</div>
    <div class="task-card__actions">${done ? '<span class="done-mark">✓</span>' : `<button class="complete-button" data-action="complete-task" data-id="${task.id}" ${canComplete ? '' : 'disabled'} aria-label="Concluir ${escape(task.title)}">✓</button>`}${task.requiresPhoto ? `<button class="photo-mini" data-action="open-photo" data-task-id="${task.id}" aria-label="Adicionar foto a ${escape(task.title)}">◉</button>` : ''}</div>
  </article>`;
}

function renderTimeline(date, limit) {
  const taskEvents = data.dailyTasks.filter((task) => task.date === date && (isDone(task) || task.status === 'pending')).map((task) => ({ time: task.completedAt?.slice(11, 16) || task.scheduledTime, type: isDone(task) ? 'Tarefa concluída' : 'Tarefa pendente', description: task.title, icon: isDone(task) ? '✓' : '○', state: isDone(task) ? 'done' : 'pending' }));
  const logEvents = data.dailyLogs.filter((log) => log.date === date).map((log) => ({ time: log.time, type: log.type, description: log.description, icon: iconFor(log.type), state: log.isImportant ? 'important' : 'normal' }));
  const photoEvents = data.dailyPhotos.filter((photo) => photo.date === date).map((photo) => ({ time: photo.uploadedAt.slice(11, 16), type: 'Foto', description: photo.caption || photo.category, icon: '◉', state: 'normal', photo }));
  const confirmationEvents = data.dailyConfirmations.filter((item) => item.confirmedAt.slice(0, 10) === date).map((item) => ({ time: item.confirmedAt.slice(11, 16), type: 'Leitura confirmada', description: 'Orientações do dia confirmadas.', icon: '✓', state: 'done' }));
  const events = [...taskEvents, ...logEvents, ...photoEvents, ...confirmationEvents].sort((a, b) => a.time.localeCompare(b.time)).slice(0, limit);
  return events.map((event) => `<article class="timeline-item timeline-item--${event.state}"><time>${escape(event.time)}</time><span class="timeline-item__icon">${event.icon}</span><div><strong>${escape(event.type)}</strong><p>${escape(event.description)}</p>${event.photo ? renderPhoto(event.photo) : ''}</div></article>`).join('') || emptyState('Nenhum registro para esta data.', 'Registrar agora', 'register');
}

function renderPhoto(photo) {
  const status = photo.syncStatus === 'pending' ? '<small class="record-detail">Envio pendente</small>' : '';
  return `<figure class="photo-card"><img src="${escape(photo.thumbnailUrl)}" alt="Prévia de foto registrada: ${escape(photo.caption || photo.category)}"><figcaption>${escape(photo.caption || photo.category)} ${status}</figcaption></figure>`;
}
function renderContact(contact) {
  return `<article class="contact-card"><div class="contact-card__avatar">${initials(contact.name)}</div><div><strong>${escape(contact.name)}</strong><p>${escape(contact.relationship)}</p></div><div class="contact-card__actions"><a class="call-button" href="tel:${phoneHref(contact.phone)}" aria-label="Ligar para ${escape(contact.name)}">☎</a><a class="message-button" href="https://wa.me/${phoneHref(contact.whatsapp)}" target="_blank" rel="noopener" aria-label="Enviar mensagem para ${escape(contact.name)}">◌</a></div></article>`;
}

function photoInput() {
  return `<label class="camera-input">◉ Tirar ou escolher foto<input name="photo" type="file" accept="image/*" capture="environment"></label>`;
}

function restrictedPage(title, message) {
  return `${subPageHeading(title, 'Área protegida.')}${emptyState('Acesso restrito', message, 'more')}`;
}

function emptyState(title, description, actionPage) {
  return `<article class="empty-state"><span>⌁</span><h2>${escape(title)}</h2><p>${escape(description)}</p>${actionPage ? `<button class="button button--secondary" data-page="${actionPage}">Abrir</button>` : ''}</article>`;
}

function subPageHeading(title, description) {
  return `<section class="page-heading page-heading--sub"><button class="back-button" data-page="more" aria-label="Voltar">‹</button><div><p class="eyebrow">${formatDate(localDate())}</p><h1>${escape(title)}</h1><p class="muted">${escape(description)}</p></div></section>`;
}

function alertCard(title, copy, page, tone) {
  return `<button class="alert-card alert-card--${tone}" data-page="${page}"><span>${tone === 'danger' ? '!' : tone === 'important' ? '✓' : 'i'}</span><div><strong>${escape(title)}</strong><p>${escape(copy)}</p></div><b>›</b></button>`;
}

function profile() { return data.childProfile; }
function isDone(task) { return task.status === 'completed' || task.status === 'late'; }
function isLate(task) { return task.date === localDate() && task.scheduledTime < currentTime() && task.status === 'pending'; }
function currentTime() { return new Date().toTimeString().slice(0, 5); }
function firstName(name) { return name.split(' ')[0]; }
function initials(name) { return name.split(' ').slice(0, 2).map((item) => item[0]).join('').toUpperCase(); }
function phoneHref(value = '') { return value.replace(/\D/g, ''); }
function escape(value = '') { return String(value).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character])); }
function formatDate(value) { return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00`)); }
function formatLongDate(value) { return new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${value}T12:00:00`)); }
function ageFrom(value) { const birth = new Date(`${value}T12:00:00`); const now = new Date(); let months = (now.getFullYear() - birth.getFullYear()) * 12 + now.getMonth() - birth.getMonth(); if (now.getDate() < birth.getDate()) months--; return months < 24 ? `${Math.max(months, 0)} meses` : `${Math.floor(months / 12)} anos e ${months % 12} meses`; }
function statusLabel(value) { return ({ applied: 'Aplicada', upcoming: 'Próxima', overdue: 'Atrasada', scheduled: 'Agendada', completed: 'Realizada', active: 'Ativo', suspended: 'Suspenso', pending: 'Pendente' })[value] || value; }
function statusClass(value) { return ({ applied: 'status-pill--success', completed: 'status-pill--success', active: 'status-pill--success', overdue: 'status-pill--danger', upcoming: 'status-pill--warning', scheduled: 'status-pill--info', pending: 'status-pill--warning' })[value] || 'status-pill--soft'; }
function iconFor(type) { return ({ alimentação: '◌', sono: '☾', medicamento: '✚', sintoma: '⌁', observação: '✎', atividade: '★', evento: '★' })[type] || '•'; }

document.addEventListener('click', async (event) => {
  const control = event.target.closest('[data-page], [data-quick], [data-register-type], [data-action]');
  if (!control || control.disabled) return;
  if (control.dataset.page) { currentPage = control.dataset.page; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (control.dataset.quick) { selectedRegisterType = control.dataset.quick; currentPage = 'register'; render(); return; }
  if (control.dataset.registerType) { selectedRegisterType = control.dataset.registerType; render(); return; }
  try {
    switch (control.dataset.action) {
      case 'reload': window.location.reload(); break;
      case 'toggle-theme': toggleTheme(); break;
      case 'microsoft-login': await signInMicrosoft(); break;
      case 'sign-out-microsoft': await signOutMicrosoft(); break;
      case 'reconfigure-onedrive':
        if (window.confirm('Alterar a conexão neste aparelho? Os dados já salvos no OneDrive não serão apagados.')) {
          clearOneDriveConfig();
          resetLocalCache();
          window.location.reload();
        }
        break;
      case 'sync-now': await syncNow(); notify('Sincronização concluída.'); break;
      case 'open-onedrive': window.open(await getRootWebUrl(), '_blank', 'noopener'); break;
      case 'open-document': window.open(await getFileUrl(control.dataset.path), '_blank', 'noopener'); break;
      case 'restore-backup': await restoreBackupFromPrompt(); break;
      case 'confirm-reading': confirmReading(); break;
      case 'complete-task': completeTask(control.dataset.id); break;
      case 'open-photo': openPhotoModal(control.dataset.taskId || ''); break;
      case 'close-modal': document.querySelector('#modal-root').innerHTML = ''; break;
      case 'print-report': if (!printDailyReport(data, localDate())) notify('O navegador bloqueou a janela do relatório.', 'error'); break;
      case 'export-backup': exportBackup(data); notify('Cópia local baixada. O backup automático fica no OneDrive.'); break;
    }
  } catch (error) { notify(error.message, 'error'); }
});

document.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    if (event.target.id === 'onedrive-setup-form') {
      const formData = new FormData(event.target);
      saveOneDriveConfig({ clientId: formData.get('clientId'), tenantId: formData.get('tenantId'), folderName: formData.get('folderName') });
      window.location.reload();
      return;
    }
    if (event.target.id === 'quick-form') await saveQuickRecord(event.target);
    if (event.target.id === 'photo-form') await savePhotoRecord(event.target);
    if (event.target.id === 'attachment-form') await saveAttachment(event.target);
  } catch (error) { notify(error.message, 'error'); }
});
async function saveQuickRecord(form) {
  if (!can(user.role, 'logs:create')) return notify('Seu perfil não pode criar registros.', 'error');
  const formData = new FormData(form);
  const type = formData.get('type');
  const description = formData.get('description').trim();
  if (!description) return notify('Descreva o registro antes de salvar.', 'error');
  if (type === 'tarefa' && formData.get('taskId')) completeTask(formData.get('taskId'), description);
  if (type === 'foto') {
    const file = formData.get('photo');
    if (!file?.size) return notify('Escolha uma foto para este registro.', 'error');
    await createPhoto({ file, caption: description, category: 'Registro livre' });
  }
  addRecord('dailyLogs', { date: localDate(), time: formData.get('time'), type, description, mood: '', symptoms: formData.get('symptoms') || '', fileUrl: null, isImportant: formData.get('important') === 'on' }, user.id);
  currentPage = 'routine'; render(); notify('Registro salvo no feed de hoje.');
}

function confirmReading() {
  const instruction = data.dailyInstructions.find((item) => item.date === localDate());
  if (!instruction || !can(user.role, 'instructions:confirm')) return notify('Seu perfil não pode confirmar a leitura.', 'error');
  addRecord('dailyConfirmations', { instructionId: instruction.id, userId: user.id, confirmedAt: new Date().toISOString(), message: 'Li e entendi as orientações do dia.' }, user.id);
  render(); notify('Leitura confirmada para os responsáveis.');
}

function completeTask(id, comment = '') {
  if (!can(user.role, 'tasks:complete')) return notify('Seu perfil não pode concluir tarefas.', 'error');
  const task = data.dailyTasks.find((item) => item.id === id);
  if (!task) return;
  const status = isLate(task) ? 'late' : 'completed';
  const comments = comment ? [...(task.comments || []), { userId: user.id, comment, createdAt: new Date().toISOString() }] : task.comments || [];
  updateRecord('dailyTasks', id, { status, completedBy: user.id, completedAt: new Date().toISOString(), comments }, user.id);
  render(); notify(status === 'late' ? 'Tarefa marcada como feita com atraso.' : 'Tarefa concluída.');
}

function openPhotoModal(taskId) {
  if (!can(user.role, 'photos:attach')) return notify('Seu perfil não pode enviar fotos.', 'error');
  const task = data.dailyTasks.find((item) => item.id === taskId);
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="photo-title" onclick="event.stopPropagation()"><button class="modal__close" data-action="close-modal" aria-label="Fechar">×</button><p class="eyebrow">Registro visual</p><h2 id="photo-title">${task ? escape(task.title) : 'Adicionar foto'}</h2><form id="photo-form"><input type="hidden" name="taskId" value="${escape(taskId)}">${photoInput()}<label>Comentário<textarea name="caption" rows="3" placeholder="O que esta foto registra?"></textarea></label><label class="check-row"><input type="checkbox" name="important"> Marcar como importante</label><button class="button button--wide" type="submit">Salvar foto</button></form><p class="permission-note">A imagem é comprimida neste dispositivo e enviada para a pasta privada Fotos/ no OneDrive.</p></section></div>`;
}

async function savePhotoRecord(form) {
  const formData = new FormData(form);
  const file = formData.get('photo');
  if (!file?.size) return notify('Escolha uma foto antes de salvar.', 'error');
  const task = data.dailyTasks.find((item) => item.id === formData.get('taskId'));
  try {
    await createPhoto({ file, caption: formData.get('caption').trim(), category: task?.category || 'Registro livre', taskId: task?.id || null, isImportant: formData.get('important') === 'on' });
    document.querySelector('#modal-root').innerHTML = '';
    render();
    notify('Foto registrada no feed do dia.');
  } catch (error) { notify(error.message, 'error'); }
}

async function createPhoto({ file, caption, category, taskId = null, isImportant = false }) {
  const capturedAt = new Date();
  const { blob, thumbnailUrl } = await resizeImage(file);
  const id = `photo-${crypto.randomUUID()}`;
  const storageKey = eventPhotoPath(category, capturedAt);
  const photo = addRecord('dailyPhotos', {
    id,
    taskId,
    instructionId: 'inst-demo-today',
    date: localDate(),
    category,
    filePath: storageKey,
    fileName: storageKey.split('/').at(-1),
    fileUrl: null,
    thumbnailUrl,
    caption,
    uploadedBy: user.id,
    uploadedAt: capturedAt.toISOString(),
    isImportant,
    syncStatus: 'pending'
  }, user.id);
  try {
    await uploadFile(storageKey, blob, 'image/jpeg');
    updateRecord('dailyPhotos', photo.id, { syncStatus: 'synced', syncedAt: new Date().toISOString() }, user.id);
    return { pending: false };
  } catch (error) {
    try {
      await queuePendingPhoto({ id: `pending-${photo.id}`, photoId: photo.id, storageKey, blob, mimeType: 'image/jpeg', createdAt: capturedAt.toISOString() });
      setSyncState('Pendente');
      return { pending: true };
    } catch {
      updateRecord('dailyPhotos', photo.id, { syncStatus: 'local-only' }, user.id);
      throw new Error('A foto foi guardada neste aparelho, mas a fila de envio não pôde ser criada. Tente sincronizar antes de fechar o navegador.');
    }
  }
}

async function syncPendingPhotoUploads() {
  let pending;
  try { pending = await listPendingPhotos(); }
  catch { return; }
  for (const item of pending) {
    try {
      await uploadFile(item.storageKey, item.blob, item.mimeType || 'image/jpeg');
      if (data.dailyPhotos?.some((photo) => photo.id === item.photoId)) {
        updateRecord('dailyPhotos', item.photoId, { syncStatus: 'synced', syncedAt: new Date().toISOString() }, user.id);
      }
      await removePendingPhoto(item.id);
    } catch {
      setSyncState('Pendente');
      return;
    }
  }
}

async function syncNow() {
  setSyncState('Salvando');
  await flushPersistence();
  await syncPendingPhotoUploads();
  await flushPersistence();
  const saved = await saveDB(data);
  data.meta = saved.meta;
  setSyncState('Sincronizado');
  render();
}

async function restoreBackupFromPrompt() {
  const suggested = `Backup/dados_${localDate()}.json`;
  const path = window.prompt('Informe o caminho do backup no OneDrive:', suggested);
  if (!path) return;
  data = await loadData(await restoreDB(path.trim()));
  user = resolveAuthorizedUser(microsoftAccount);
  render();
  notify('Backup restaurado e salvo como dados.json.');
}

async function saveAttachment(form) {
  if (!can(user.role, 'documents:create')) throw new Error('Seu perfil não pode enviar documentos.');
  const formData = new FormData(form);
  const file = formData.get('attachment');
  if (!file?.size) throw new Error('Escolha um arquivo antes de enviar.');
  const now = new Date();
  const path = attachmentPath(file.name, now);
  await uploadFile(path, file, file.type || 'application/octet-stream');
  addRecord('documents', {
    title: String(formData.get('title') || file.name).trim(),
    category: String(formData.get('category') || 'Outros'),
    description: String(formData.get('description') || '').trim(),
    filePath: path,
    fileName: file.name,
    fileUrl: null,
    expirationDate: null,
    sensitivity: 'sensitive'
  }, user.id);
  form.reset();
  render();
  notify('Documento enviado ao OneDrive.');
}

function attachmentPath(name, date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString();
  const [year, month] = local.slice(0, 10).split('-');
  const timestamp = local.slice(0, 19).replace('T', '_').replaceAll(':', '-');
  return `Anexos/${year}/${month}/${timestamp}_${safeFileName(name)}`;
}

function safeFileName(name) {
  const clean = String(name || 'anexo').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-');
  return clean || 'anexo';
}
function applyTheme() {
  const current = localStorage.getItem('cuidado-theme') || 'system';
  document.documentElement.dataset.theme = current;
}

function toggleTheme() {
  const current = localStorage.getItem('cuidado-theme') || 'system';
  const next = current === 'system' ? 'dark' : current === 'dark' ? 'light' : 'system';
  localStorage.setItem('cuidado-theme', next); applyTheme(); render(); notify(`Tema: ${next === 'system' ? 'do sistema' : next === 'dark' ? 'escuro' : 'claro'}.`);
}

function bindConnectivity() {
  const update = () => {
    const badge = document.querySelector('#offline-indicator');
    if (badge) badge.hidden = navigator.onLine;
    if (!navigator.onLine) return notify(offlineNotice(), 'warning');
    if (data && user) syncNow().catch(() => setSyncState('Pendente'));
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
}
function registerServiceWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
}


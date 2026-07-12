import { loadData, addRecord, updateRecord, removeRecord, saveData, resetLocalCache, localDate, setPersistence, flushPersistence } from './services/dataService.js?v=12';
import { can, getRoleLabel } from './services/permissionsService.js';
import { notify, offlineNotice } from './services/notificationService.js';
import { lineChart, donutChart } from './services/chartService.js';
import { exportBackup, printDailyReport } from './services/reportService.js';
import { clearOneDriveConfig, initializeMicrosoftSession, saveOneDriveConfig, signInMicrosoft, signOutMicrosoft } from './auth.js';
import { connectOneDrive, getFileUrl, getRootWebUrl, loadDB, restoreDB, saveDB, uploadFile } from './storage.js';
import { eventPhotoPath, listPendingPhotos, queuePendingPhoto, removePendingPhoto, resizeImage } from './photos.js';
import { renderConnectionStatus } from './ui.js';
import { importLegacyBundle, migrationReportText } from './migration.js';

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
let selectedTaskId = null;
let selectedVaccineId = null;
let pendingAvatarCrop = null;
let historyFilter = { period: 'today', date: localDate(), type: '' };
let lastMigrationReport = null;

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
    const normalizedLegacyData = normalizeLegacyData();
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
    if (normalizedLegacyData) saveData(data);
    user = resolveAuthorizedUser(microsoftAccount);
    await syncPendingPhotoUploads();
    syncState = 'Sincronizado';
    render();
  } catch (error) {
    app.innerHTML = `<main class="fatal"><h1>Não foi possível conectar</h1><p>${escape(error.message)}</p><button class="button" data-action="reconfigure-onedrive">Revisar configuração</button></main>`;
  }
}

function normalizeLegacyData() {
  let changed = false;
  const typeByCategory = { alimentação: 'Lanche', medicamento: 'Medicamento', sono: 'Sono', banho: 'Banho', atividade: 'Brincadeira', observação: 'Observação', sintoma: 'Sintoma' };
  const collections = ['users', 'documents', 'vaccines', 'appointments', 'growthRecords', 'dailyInstructions', 'dailyTasks', 'dailyPhotos', 'dailyConfirmations', 'dailyComments', 'dailyLogs', 'medications', 'medicationAdministrations', 'emergencyContacts', 'doctors', 'attachments', 'auditLog'];
  const isDemoRecord = (item) => {
    const id = String(item?.id || '').toLowerCase();
    const email = String(item?.email || '').toLowerCase();
    return id.includes('-demo') || id.startsWith('demo-') || email.endsWith('.invalid');
  };
  for (const collection of collections) {
    if (!Array.isArray(data[collection])) { data[collection] = []; changed = true; continue; }
    const realRecords = data[collection].filter((item) => !isDemoRecord(item));
    if (realRecords.length !== data[collection].length) { data[collection] = realRecords; changed = true; }
  }
  if (!data.childProfile || /exemplo|demonstra/i.test(String(data.childProfile.name || ''))) {
    data.childProfile = { id: 'child-maria-elis', name: 'Maria Elis', birthDate: '', photoUrl: 'assets/icons/child-avatar.svg', healthPlan: '', bloodType: '', allergies: [], criticalNotes: '', address: '' };
    changed = true;
  }
  data.dailyTasks = data.dailyTasks.map((task) => {
    const next = { ...task };
    if (!next.taskType) { next.taskType = typeByCategory[next.category] || 'Outro'; changed = true; }
    if (next.familyNote == null) { next.familyNote = next.description || ''; changed = true; }
    if (!Array.isArray(next.checklist)) { next.checklist = []; changed = true; }
    if (next.caregiverNote == null) { next.caregiverNote = ''; changed = true; }
    return next;
  });
  if (!data.meta) { data.meta = {}; changed = true; }
  if (!data.meta.demoCleanupAt) { data.meta.demoCleanupAt = new Date().toISOString(); changed = true; }
  return changed;
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
      <div class="topbar__actions"><button class="icon-button" data-page="more" aria-label="Abrir mais opções" title="Mais opções">☰</button>
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
    case 'instructions': return renderAfazeres();
    case 'tasks': return renderAfazeres();
    case 'task-detail': return renderTaskDetail();
    case 'history': return renderHistory();
    case 'child-data': return renderChildData();
    case 'users': return renderUsers();
    case 'migration': return renderMigration();
    case 'register': return renderRegister();
    case 'emergency': return renderEmergency();
    case 'more': return renderMore();
    case 'documents': return renderDocuments();
    case 'vaccines': return renderVaccines();
    case 'vaccine-detail': return renderVaccineDetail();
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
  const tasks = tasksForDate(today);
  const pending = tasks.filter((task) => !isDone(task));
  const completed = tasks.filter(isDone);
  return `
    <section class="page-heading">
      <div><p class="eyebrow">${formatLongDate(today)}</p><h1>Bom dia, ${escape(firstName(user.name))}.</h1><p class="muted">Hoje, ${escape(profile().name)} tem ${tasks.length} afazer(es).</p></div>
      <button class="avatar-button" data-page="settings" aria-label="Abrir configurações">${initials(user.name)}</button>
    </section>
    <section class="hero-card hero-card--tasks"><div class="hero-card__copy"><span class="status-pill status-pill--soft">${escape(syncState)}</span><h2>Afazeres do dia</h2><p>${pending.length} pendente(s) e ${completed.length} concluído(s).</p></div><img src="${escape(profile().photoUrl)}" alt="Avatar de ${escape(profile().name)}" class="hero-card__avatar"></section>
    <section class="today-actions">${can(user.role, 'tasks:create') ? `<button class="button button--wide" data-page="register">＋ Adicionar afazer</button>` : ''}<button class="button button--secondary button--wide" data-page="register">◉ Registrar foto/observação</button></section>
    <section class="section-block"><div class="section-title"><div><p class="eyebrow">Agora</p><h2>Pendentes</h2></div><span class="status-pill status-pill--warning">${pending.length}</span></div><div class="task-list">${pending.map(renderDayTask).join('') || emptyState('Nenhum afazer pendente.', 'A rotina de hoje está em dia.', '')}</div></section>
    <section class="section-block"><div class="section-title"><div><p class="eyebrow">Feitos</p><h2>Concluídas</h2></div><span class="status-pill status-pill--success">${completed.length}</span></div><div class="task-list">${completed.map(renderDayTask).join('') || '<p class="muted">As tarefas concluídas aparecerão aqui.</p>'}</div></section>`;
}

function renderAfazeres() {
  const tasks = tasksForDate(localDate());
  const pending = tasks.filter((task) => !isDone(task));
  const completed = tasks.filter(isDone);
  return `${subPageHeading('Afazeres do dia', 'Uma lista simples para seguir a rotina.')}${can(user.role, 'tasks:create') ? `<button class="button button--wide" data-page="register">＋ Adicionar afazer</button>` : ''}<section class="section-block"><div class="section-title"><div><p class="eyebrow">Em ordem de horário</p><h2>Pendentes</h2></div><span class="status-pill status-pill--warning">${pending.length}</span></div><div class="task-list">${pending.map(renderDayTask).join('') || emptyState('Nenhum afazer pendente.', 'Use Adicionar afazer para montar a rotina.', 'register')}</div></section><section class="section-block"><div class="section-title"><div><p class="eyebrow">Concluídas</p><h2>Feitas hoje</h2></div><span class="status-pill status-pill--success">${completed.length}</span></div><div class="task-list">${completed.map(renderDayTask).join('') || '<p class="muted">Nenhum afazer concluído ainda.</p>'}</div></section>`;
}
function renderRegister() {
  const canCreate = can(user.role, 'tasks:create');
  const types = taskTypes();
  return `${subPageHeading('Registrar', 'Criar a rotina ou registrar como foi o dia.')}
    ${canCreate ? `<section class="settings-card"><div class="section-title"><div><p class="eyebrow">Responsáveis</p><h2>Adicionar afazer</h2></div></div><form id="task-form" class="form-card"><label>Data<input name="date" type="date" value="${localDate()}" required></label><div class="form-grid"><label>Horário<input name="scheduledTime" type="time" value="${currentTime()}" required></label><label>Tipo<select name="taskType">${types.map((type) => `<option value="${type}">${type}</option>`).join('')}</select></label></div><label>Título<input name="title" required placeholder="Ex.: Lanche da manhã"></label><label>Orientação da família<textarea name="familyNote" rows="4" placeholder="Explique o que fazer e os cuidados importantes."></textarea></label><label>Checklist (um item por linha)<textarea name="checklistText" rows="5" placeholder="Lavar as mãos&#10;Preparar o lanche&#10;Tirar foto"></textarea></label><label class="check-row"><input type="checkbox" name="requiresPhoto"> Solicitar foto neste afazer</label><button class="button button--wide" type="submit">Salvar afazer</button></form></section>` : ''}
    <section class="settings-card"><div class="section-title"><div><p class="eyebrow">Babá e responsáveis</p><h2>Registrar foto ou observação</h2></div></div><form id="quick-form" class="form-card"><label>Tipo<select name="type">${types.map((type) => `<option value="${type}">${type}</option>`).join('')}</select></label><label>Horário<input type="time" name="time" value="${currentTime()}" required></label><label>Observação<textarea name="description" rows="3" required placeholder="Conte como foi."></textarea></label>${photoInput()}<button class="button button--secondary button--wide" type="submit">Salvar registro</button></form></section>`;
}
function renderEmergency() {
  const contacts = [...(data.emergencyContacts || [])].sort((a, b) => a.priority - b.priority); const doctor = data.doctors?.[0];
  return `${subPageHeading('Emergência', 'Contatos e cuidados importantes.')}<section class="emergency-banner"><span>⚕</span><div><h2>Risco imediato?</h2><p>Acione o serviço de emergência local. Este app não substitui atendimento médico.</p></div></section><section class="emergency-grid">${contacts.map((contact) => `<a class="emergency-action" href="tel:${phoneHref(contact.phone)}"><strong>${escape(contact.relationship || contact.name)}</strong><small>${escape(contact.name)}</small><span>☎</span></a>`).join('')}${doctor ? `<a class="emergency-action" href="tel:${phoneHref(doctor.phone)}"><strong>Pediatra</strong><small>${escape(doctor.name)}</small><span>☎</span></a>` : ''}<a class="emergency-action" href="tel:192"><strong>Emergência médica</strong><small>Chamar atendimento</small><span>☎</span></a></section><section class="section-block"><div class="section-title"><div><p class="eyebrow">Cuidados importantes</p><h2>Saúde</h2></div></div><article class="critical-card"><div class="critical-card__wide"><span>Alergias</span><strong>${escape((profile().allergies || []).join(', ') || 'Não informado')}</strong></div><div class="critical-card__wide"><span>Observações</span><strong>${escape(profile().criticalNotes || 'Não informado')}</strong></div><div><span>Convênio</span><strong>${escape(profile().healthPlan || 'Não informado')}</strong></div><div><span>Tipo sanguíneo</span><strong>${escape(profile().bloodType || 'Não informado')}</strong></div><div class="critical-card__wide"><span>Endereço</span><strong>${escape(profile().address || 'Não informado')}</strong></div></article></section>`;
}
function renderMore() {
  const items = [
    ['documents', '▣', 'Documentos', 'Arquivos privados'], ['vaccines', '◈', 'Vacinas', 'Histórico e comprovantes'],
    ['appointments', '◷', 'Consultas', 'Agenda e retornos'], ['growth', '↗', 'Crescimento', 'Peso e altura'],
    ['medications', '✚', 'Medicamentos fixos', 'Uso contínuo'], ['child-data', '♥', 'Dados da criança', 'Perfil, alergias e contatos'],
    ['users', '◉', 'Usuários e permissões', 'Pessoas autorizadas'], ['migration', '⇪', 'Importar dados antigos', 'Migração e relatório'],
    ['settings', '⚙', 'Configurações', 'OneDrive, backup e acesso']
  ];
  return `${subPageHeading('Mais', 'Dados usados principalmente pelos responsáveis.')}<section class="menu-list">${items.map(([page, icon, title, copy]) => `<button class="menu-item" data-page="${page}"><span class="menu-item__icon">${icon}</span><span><strong>${title}</strong><small>${copy}</small></span><span class="chevron">›</span></button>`).join('')}</section>`;
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
  if (!allowed) return restrictedPage('Vacinas', 'O histórico de vacinação é visível somente para responsáveis autorizados.');
  const canManage = can(user.role, 'tasks:create');
  const records = [...(data.vaccines || [])].sort((a, b) => String(b.appliedDate || b.expectedDate || '').localeCompare(String(a.appliedDate || a.expectedDate || '')));
  return `${subPageHeading('Vacinas', 'Toque em uma vacina para abrir todos os dados e comprovantes.')}
    ${canManage ? `<section class="settings-card"><div class="section-title"><div><p class="eyebrow">Responsáveis</p><h2>Adicionar vacina</h2></div></div><form id="vaccine-form" class="form-card"><label>Data da aplicação<input name="appliedDate" type="date" value="${localDate()}" required></label><div class="form-grid"><label>Vacina<input name="name" required placeholder="Ex.: Varicela"></label><label>Dose<input name="dose" required placeholder="Ex.: 2º ou Reforço"></label></div><div class="form-grid"><label>Lote<input name="batch" placeholder="Se disponível"></label><label>Local<input name="location" placeholder="Posto ou clínica"></label></div><label>Observação<textarea name="notes" rows="2"></textarea></label><label>Comprovantes/fotos (pode escolher várias)<input name="proofs" type="file" accept="image/*,application/pdf" multiple></label><button class="button button--wide" type="submit">Salvar vacina</button></form></section><section class="settings-card"><h2>Anexar as fotos já organizadas</h2><p class="muted">Selecione todas as fotos da pasta de vacinas de uma vez. O app identifica vacina e dose pelo nome do arquivo e aceita duas ou mais fotos por registro.</p><form id="vaccine-bulk-photo-form" class="form-card"><label>Selecionar a pasta inteira “comprovantes”<input name="vaccineProofDirectory" type="file" accept="image/*,application/pdf" webkitdirectory directory multiple></label><label>Ou selecionar várias fotos<input name="vaccineProofFiles" type="file" accept="image/*,application/pdf" multiple></label><button class="button button--secondary button--wide" type="submit">Importar e relacionar fotos</button></form></section>` : ''}
    <section class="section-block"><div class="section-title"><div><p class="eyebrow">${records.length} registro(s)</p><h2>Histórico</h2></div></div><div class="record-list">${records.map((vaccine) => { const proofs = vaccine.proofFilePaths || []; return `<article class="record-card record-card--interactive"><span class="record-icon">◈</span><button class="record-card__main" data-action="open-vaccine" data-id="${vaccine.id}" aria-label="Abrir detalhes de ${escape(vaccine.name)}"><span class="status-pill ${statusClass(vaccine.status || 'applied')}">${statusLabel(vaccine.status || 'applied')}</span><h2>${escape(vaccine.name)}</h2><p>${escape(vaccine.dose)} · ${vaccine.appliedDate ? formatDate(vaccine.appliedDate) : 'Data não informada'}</p><small>${vaccine.batch ? `Lote: ${escape(vaccine.batch)}` : 'Lote não informado'} · ${proofs.length} comprovante(s)</small></button><span class="chevron">›</span></article>`; }).join('') || emptyState('Nenhuma vacina cadastrada.', 'Adicione ou importe o histórico privado.', '')}</div></section>`;
}

function renderVaccineDetail() {
  const vaccine = (data.vaccines || []).find((item) => item.id === selectedVaccineId);
  if (!vaccine) { currentPage = 'vaccines'; return renderVaccines(); }
  const canManage = can(user.role, 'tasks:create');
  const proofs = vaccine.proofFilePaths || [];
  return `<section class="page-heading page-heading--sub"><button class="back-button" data-page="vaccines" aria-label="Voltar">‹</button><div><p class="eyebrow">${vaccine.appliedDate ? formatDate(vaccine.appliedDate) : 'Data não informada'}</p><h1>${escape(vaccine.name)}</h1><p class="muted">${escape(vaccine.dose)}</p></div></section>
    <section class="task-detail-card vaccine-detail-card"><span class="status-pill ${statusClass(vaccine.status || 'applied')}">${statusLabel(vaccine.status || 'applied')}</span><dl class="detail-list"><div><dt>Data</dt><dd>${vaccine.appliedDate ? formatDate(vaccine.appliedDate) : 'Não informada'}</dd></div><div><dt>Dose</dt><dd>${escape(vaccine.dose || 'Não informada')}</dd></div><div><dt>Lote</dt><dd>${escape(vaccine.batch || 'Não informado')}</dd></div><div><dt>Local</dt><dd>${escape(vaccine.location || 'Não informado')}</dd></div><div><dt>Observações</dt><dd>${escape(vaccine.notes || 'Nenhuma observação')}</dd></div></dl></section>
    <section class="section-block"><div class="section-title"><div><p class="eyebrow">${proofs.length} arquivo(s)</p><h2>Fotos e comprovantes</h2></div></div><div class="proof-grid">${proofs.map((proof, index) => `<button class="proof-card" data-action="open-vaccine-proof" data-path="${escape(proof)}"><span>▧</span><strong>Comprovante ${index + 1}</strong><small>Abrir arquivo</small></button>`).join('') || emptyState('Nenhuma foto anexada.', 'Use Editar vacina ou a importação em lote para incluir duas ou mais fotos.', '')}</div></section>
    ${canManage ? `<section class="task-management"><button class="text-button" data-action="edit-vaccine" data-id="${vaccine.id}">Editar e anexar fotos</button><button class="text-button text-button--danger" data-action="delete-vaccine" data-id="${vaccine.id}">Apagar vacina</button></section>` : ''}`;
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
  return renderHistory();
}

function renderHistory() {
  const filtered = tasksForHistory();
  return `${subPageHeading('Histórico', 'Afazeres, fotos e observações.')}
    <form id="history-filter-form" class="filter-panel"><label>Período<select name="period"><option value="today" ${historyFilter.period === 'today' ? 'selected' : ''}>Hoje</option><option value="yesterday" ${historyFilter.period === 'yesterday' ? 'selected' : ''}>Ontem</option><option value="week" ${historyFilter.period === 'week' ? 'selected' : ''}>Esta semana</option><option value="date" ${historyFilter.period === 'date' ? 'selected' : ''}>Escolher data</option></select></label><label>Data<input type="date" name="date" value="${historyFilter.date}"></label><label>Tipo<select name="type"><option value="">Todos</option>${taskTypes().map((type) => `<option value="${type}" ${historyFilter.type === type ? 'selected' : ''}>${type}</option>`).join('')}</select></label><button class="button button--secondary" type="submit">Filtrar</button></form>
    <section class="section-block"><div class="section-title"><div><p class="eyebrow">${filtered.length} resultado(s)</p><h2>Afazeres</h2></div></div><div class="task-list">${filtered.map(renderDayTask).join('') || emptyState('Nenhum afazer encontrado.', 'Ajuste o filtro ou crie um afazer.', 'register')}</div></section>`;
}
function renderSettings() {
  return `${subPageHeading('Configurações', 'OneDrive, backup e acesso da família.')}
    <section class="settings-card"><div class="setting-line"><div><strong>Conta conectada</strong><p>${escape(renderConnectionStatus(microsoftAccount, oneDriveConfig.folderName))}</p></div><span class="status-pill status-pill--success">${escape(syncState)}</span></div></section>
    <section class="settings-card"><div class="setting-line"><div><strong>Dados da criança</strong><p>Nome, alergias, contatos e observações fixas.</p></div><button class="button button--secondary button--small" data-page="child-data">Editar</button></div></section>
    <section class="settings-card"><div class="setting-line"><div><strong>Sincronização</strong><p>Salva dados e tenta enviar fotos pendentes.</p></div><button class="button button--secondary button--small" data-action="sync-now">Sincronizar</button></div></section>
    <section class="settings-card"><div class="setting-line"><div><strong>Backup</strong><p>Backup diário no OneDrive.</p></div><button class="button button--secondary button--small" data-action="restore-backup">Restaurar</button></div></section>
    <section class="settings-card"><div class="setting-line"><div><strong>Pasta privada</strong><p>${escape(oneDriveConfig.folderName)}</p></div><button class="button button--secondary button--small" data-action="open-onedrive">Abrir</button></div></section>
    <section class="settings-card"><div class="setting-line"><div><strong>Conta Microsoft</strong><p>Sair somente deste navegador.</p></div><button class="button button--danger button--small" data-action="sign-out-microsoft">Sair</button></div></section>`;
}
function renderNavigation() {
  const tabs = [['home', '⌂', 'Hoje'], ['tasks', '☑', 'Afazeres'], ['register', '＋', 'Registrar'], ['history', '◷', 'Histórico'], ['emergency', '⚕', 'Emergência']];
  return `<nav class="bottom-nav" aria-label="Navegação principal">${tabs.map(([page, icon, label]) => `<button class="nav-item ${currentPage === page || (page === 'tasks' && currentPage === 'task-detail') ? 'nav-item--active' : ''} ${page === 'register' ? 'nav-item--primary' : ''}" data-page="${page}" aria-current="${currentPage === page ? 'page' : 'false'}"><span>${icon}</span><small>${label}</small></button>`).join('')}</nav>`;
}

function renderDayTask(task) {
  const complete = isDone(task);
  const photos = (data.dailyPhotos || []).filter((photo) => photo.taskId === task.id);
  return `<article class="day-task ${complete ? 'day-task--done' : ''}"><button class="day-task__main" data-action="open-task" data-id="${task.id}"><time>${escape(task.scheduledTime || '--:--')}</time><span><strong>${escape(task.title)}</strong><small>${escape(task.taskType || task.category || 'Outro')}${task.familyNote ? ` · ${escape(task.familyNote)}` : ''}</small></span></button><div class="day-task__actions">${photos.length ? '<span title="Foto enviada">◉</span>' : ''}${!complete && can(user.role, 'photos:attach') ? `<button class="icon-button" data-action="open-photo" data-task-id="${task.id}" aria-label="Adicionar foto">◉</button>` : ''}${!complete && can(user.role, 'tasks:complete') ? `<button class="complete-button" data-action="complete-task" data-id="${task.id}" aria-label="Marcar como feito">✓</button>` : complete ? '<span class="done-mark">✓</span>' : ''}</div>${complete ? `<p class="day-task__done">Feito ${task.completedAt ? `às ${escape(task.completedAt.slice(11, 16))}` : ''}${task.caregiverNote ? ` · ${escape(task.caregiverNote)}` : ''}</p>` : ''}</article>`;
}

function renderTaskDetail() {
  const task = data.dailyTasks.find((item) => item.id === selectedTaskId);
  if (!task) return `${subPageHeading('Afazer', 'O afazer não foi encontrado.')}${emptyState('Afazer indisponível', 'Volte para a lista de hoje.', 'tasks')}`;
  const checklist = normalizedChecklist(task);
  const photos = (data.dailyPhotos || []).filter((photo) => photo.taskId === task.id);
  const canWork = can(user.role, 'tasks:complete') || can(user.role, 'logs:create');
  const canManage = can(user.role, 'tasks:create');
  return `<section class="page-heading page-heading--sub"><button class="back-button" data-page="tasks" aria-label="Voltar">‹</button><div><p class="eyebrow">${formatDate(task.date)} · ${escape(task.scheduledTime || '--:--')}</p><h1>${escape(task.title)}</h1><p class="muted">${escape(task.taskType || task.category || 'Outro')}</p></div></section>
    <section class="task-detail-card"><span class="status-pill ${isDone(task) ? 'status-pill--success' : 'status-pill--warning'}">${isDone(task) ? 'Concluído' : 'Pendente'}</span><h2>Orientação da família</h2><p>${escape(task.familyNote || task.description || 'Sem orientação adicional.')}</p>${task.requiresPhoto ? '<p class="task-detail-hint">Foto solicitada para este afazer.</p>' : ''}</section>
    <section class="section-block"><div class="section-title"><div><p class="eyebrow">Passo a passo</p><h2>Checklist</h2></div></div>${checklist.length ? `<div class="checklist">${checklist.map((item, index) => `<label class="checklist__item"><input type="checkbox" data-action="toggle-checklist" data-task-id="${task.id}" data-index="${index}" ${item.checked ? 'checked' : ''} ${canWork ? '' : 'disabled'}><span>${escape(item.label)}</span></label>`).join('')}</div>` : '<p class="muted">Sem checklist para este afazer.</p>'}</section>
    <section class="section-block"><div class="section-title"><div><p class="eyebrow">Registro de quem executou</p><h2>Observação da babá</h2></div></div><form id="task-note-form" class="form-card"><input type="hidden" name="taskId" value="${task.id}"><label>Como foi?<textarea name="caregiverNote" rows="4" ${canWork ? '' : 'disabled'} placeholder="Ex.: comeu bem, dormiu às 13:10.">${escape(task.caregiverNote || '')}</textarea></label><button class="button button--secondary button--wide" type="submit" ${canWork ? '' : 'disabled'}>Salvar observação</button></form></section>
    ${photos.length ? `<section class="section-block"><div class="section-title"><div><p class="eyebrow">Registro visual</p><h2>Fotos</h2></div></div><div class="photo-strip">${photos.map(renderPhoto).join('')}</div></section>` : ''}
    <section class="task-detail-actions">${can(user.role, 'photos:attach') ? `<button class="button button--secondary button--wide" data-action="open-photo" data-task-id="${task.id}">◉ Adicionar foto</button>` : ''}${!isDone(task) && can(user.role, 'tasks:complete') ? `<button class="button button--wide" data-action="complete-task" data-id="${task.id}">✓ Marcar como feito</button>` : ''}</section>
    ${isDone(task) ? `<section class="completion-card"><strong>Concluído</strong><p>${task.completedAt ? formatDateTime(task.completedAt) : ''} · ${escape(userName(task.completedBy))}</p></section>` : ''}
    ${canManage ? `<section class="task-management"><button class="text-button" data-action="edit-task" data-id="${task.id}">Editar afazer</button><button class="text-button text-button--danger" data-action="delete-task" data-id="${task.id}">Apagar afazer</button></section>` : ''}`;
}

function renderChildData() {
  const canEdit = can(user.role, 'tasks:create'); const child = profile(); const doctor = data.doctors?.[0] || {};
  const contacts = (data.emergencyContacts || []).map((item) => `${item.name || ''} | ${item.relationship || ''} | ${item.phone || ''}`).join('\n');
  return `${subPageHeading('Dados da criança', 'Informações fixas para a família e a babá.')}<form id="child-profile-form" class="form-card"><div class="profile-photo-row"><img src="${escape(child.photoUrl || 'assets/icons/child-avatar.svg')}" alt="Foto atual da criança"><div><strong>Foto do perfil</strong><p>Escolha uma foto e ajuste zoom e posição antes de salvar.</p></div></div><label>Nome<input name="name" value="${escape(child.name || '')}" ${canEdit ? '' : 'disabled'} required></label><label>Data de nascimento<input name="birthDate" type="date" value="${escape(child.birthDate || '')}" ${canEdit ? '' : 'disabled'}></label><label>Escolher nova foto<input name="avatar" type="file" accept="image/*" ${canEdit ? '' : 'disabled'}></label><p id="avatar-crop-status" class="permission-note">Depois de escolher, o editor de enquadramento será aberto.</p><label>Alergias (separadas por vírgula)<textarea name="allergies" rows="2" ${canEdit ? '' : 'disabled'}>${escape((child.allergies || []).join(', '))}</textarea></label><label>Medicamentos importantes e cuidados especiais<textarea name="criticalNotes" rows="4" ${canEdit ? '' : 'disabled'}>${escape(child.criticalNotes || '')}</textarea></label><label>Convênio<input name="healthPlan" value="${escape(child.healthPlan || '')}" ${canEdit ? '' : 'disabled'}></label><label>Endereço<input name="address" value="${escape(child.address || '')}" ${canEdit ? '' : 'disabled'}></label><div class="form-grid"><label>Pediatra<input name="doctorName" value="${escape(doctor.name || '')}" ${canEdit ? '' : 'disabled'}></label><label>Telefone do pediatra<input name="doctorPhone" value="${escape(doctor.phone || '')}" ${canEdit ? '' : 'disabled'}></label></div><label>Contatos de emergência (um por linha: Nome | Relação | Telefone)<textarea name="emergencyContacts" rows="5" ${canEdit ? '' : 'disabled'}>${escape(contacts)}</textarea></label><button class="button button--wide" type="submit" ${canEdit ? '' : 'disabled'}>Salvar dados da criança</button></form>`;
}
function renderUsers() {
  const canManage = can(user.role, 'tasks:create');
  return `${subPageHeading('Usuários e permissões', 'O e-mail e o papel controlam o que cada pessoa pode fazer no app.')}<section class="settings-card permission-guide"><h2>Como liberar uma pessoa</h2><ol><li>No OneDrive, compartilhe a pasta <strong>${escape(oneDriveConfig.folderName)}</strong> com o e-mail exato da pessoa e marque <strong>Pode editar</strong>.</li><li>Peça para ela abrir a pasta compartilhada e escolher <strong>Adicionar atalho aos Meus arquivos</strong>.</li><li>Aqui no app, adicione o mesmo e-mail e escolha o papel.</li><li>No aparelho dela, configure o mesmo Client ID, Tenant ID e nome da pasta; depois entre com esse e-mail Microsoft.</li></ol><p class="permission-note"><strong>Importante:</strong> cadastrar apenas aqui não compartilha o OneDrive. As duas permissões são necessárias.</p><dl class="role-guide"><div><dt>Responsável</dt><dd>Administra dados, vacinas, documentos, tarefas e usuários.</dd></div><div><dt>Babá/cuidador(a)</dt><dd>Executa tarefas, registra observações e fotos, com acesso privado limitado.</dd></div><div><dt>Visitante</dt><dd>Somente leitura das áreas liberadas.</dd></div></dl></section><div class="record-list">${(data.users || []).map((item) => `<article class="record-card"><span class="record-icon">◉</span><div><h2>${escape(item.name)}</h2><p>${escape(item.email || '')}</p><small>${escape(getRoleLabel(item.role))} · ${item.active ? 'ativo' : 'inativo'}</small></div></article>`).join('') || emptyState('Nenhuma pessoa cadastrada.', 'O primeiro login Microsoft se torna o administrador.', '')}</div>${canManage ? `<section class="settings-card"><h2>Adicionar pessoa autorizada</h2><form id="user-form" class="form-card"><label>Nome<input name="name" required></label><label>E-mail Microsoft<input type="email" name="email" required></label><label>Papel<select name="role"><option value="guardian">Responsável</option><option value="caregiver">Babá/cuidador(a)</option><option value="visitor">Visitante</option></select></label><button class="button button--wide" type="submit">Adicionar usuário</button></form></section>` : ''}`;
}
function renderMigration() {
  const canImport = can(user.role, 'tasks:create');
  return `${subPageHeading('Importar dados antigos', 'Importação idempotente de um pacote JSON privado.')}<section class="settings-card"><p>Selecione um pacote JSON preparado conforme o guia de migração. O app ignora itens com o mesmo ID ou caminho e registra um relatório no dados.json.</p>${canImport ? `<form id="migration-form" class="form-card"><label>Pacote de migração<input name="legacyBundle" type="file" accept="application/json,.json" required></label><button class="button button--wide" type="submit">Importar pacote</button></form>` : '<p class="permission-note">Somente responsáveis podem importar dados.</p>'}</section>${lastMigrationReport ? `<section class="settings-card"><h2>Último relatório</h2><p>${escape(migrationReportText(lastMigrationReport))}</p>${lastMigrationReport.warnings?.length ? `<p class="permission-note">${escape(lastMigrationReport.warnings.join(' '))}</p>` : ''}</section>` : ''}`;
}

function taskTypes() { return ['Medicamento', 'Lanche', 'Almoço', 'Jantar', 'Sono', 'Banho', 'Passeio', 'Brincadeira', 'Fralda', 'Sintoma', 'Observação', 'Outro']; }
function tasksForDate(date) { return (data.dailyTasks || []).filter((task) => task.date === date).sort((a, b) => String(a.scheduledTime || '').localeCompare(String(b.scheduledTime || ''))); }
function tasksForHistory() { const today = localDate(); const selected = historyFilter.date || today; return (data.dailyTasks || []).filter((task) => { const matchesType = !historyFilter.type || (task.taskType || task.category) === historyFilter.type; if (!matchesType) return false; if (historyFilter.period === 'today') return task.date === today; if (historyFilter.period === 'yesterday') return task.date === shiftDate(today, -1); if (historyFilter.period === 'week') return task.date >= shiftDate(today, -6) && task.date <= today; return task.date === selected; }).sort((a, b) => `${b.date}${b.scheduledTime || ''}`.localeCompare(`${a.date}${a.scheduledTime || ''}`)); }
function shiftDate(date, days) { const value = new Date(`${date}T12:00:00`); value.setDate(value.getDate() + days); return value.toISOString().slice(0, 10); }
function normalizedChecklist(task) { return (task.checklist || []).map((item) => typeof item === 'string' ? { label: item, checked: false } : { label: item.label || '', checked: Boolean(item.checked), checkedAt: item.checkedAt || null, checkedBy: item.checkedBy || null }); }
function defaultChecklist(type) { return ({ Medicamento: ['Conferir nome do remédio', 'Conferir horário', 'Dar medicamento', 'Registrar se tomou tudo'], Lanche: ['Preparar lanche', 'Oferecer', 'Tirar foto', 'Registrar aceitação'], Almoço: ['Aquecer comida', 'Conferir temperatura', 'Dar almoço', 'Tirar foto do prato', 'Registrar aceitação'], Sono: ['Preparar ambiente', 'Registrar início', 'Registrar fim'], Banho: ['Separar itens', 'Dar banho', 'Registrar observação'] })[type] || []; }
function userName(id) { return data.users?.find((item) => item.id === id)?.name || 'Usuário autorizado'; }
function formatDateTime(value) { return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }

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
function connectionSummary(currentUser) {
  const accountName = microsoftAccount?.username || currentUser.email || 'Conta Microsoft';
  return `${getRoleLabel(currentUser.role)} · ${accountName} · OneDrive conectado`;
}
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
  if (control.dataset.page) { currentPage = control.dataset.page; if (currentPage !== 'task-detail') selectedTaskId = null; if (currentPage !== 'vaccine-detail') selectedVaccineId = null; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (control.dataset.quick) { selectedRegisterType = control.dataset.quick; currentPage = 'register'; render(); return; }
  if (control.dataset.registerType) { selectedRegisterType = control.dataset.registerType; render(); return; }
  try {
    switch (control.dataset.action) {
      case 'reload': window.location.reload(); break;
      case 'toggle-theme': toggleTheme(); break;
      case 'microsoft-login': await signInMicrosoft(); break;
      case 'sign-out-microsoft': await signOutMicrosoft(); break;
      case 'reconfigure-onedrive': if (window.confirm('Alterar a conexão neste aparelho? Os dados no OneDrive não serão apagados.')) { clearOneDriveConfig(); resetLocalCache(); window.location.reload(); } break;
      case 'sync-now': await syncNow(); notify('Sincronização concluída.'); break;
      case 'open-onedrive': window.open(await getRootWebUrl(), '_blank', 'noopener'); break;
      case 'open-document': window.open(await getFileUrl(control.dataset.path), '_blank', 'noopener'); break;
      case 'open-vaccine-proof': window.open(await getFileUrl(control.dataset.path), '_blank', 'noopener'); break;
      case 'open-vaccine': selectedVaccineId = control.dataset.id; currentPage = 'vaccine-detail'; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); break;
      case 'edit-vaccine': openVaccineEditor(control.dataset.id); break;
      case 'delete-vaccine': deleteVaccine(control.dataset.id); break;
      case 'clear-example-vaccines': clearExampleVaccines(); break;
      case 'confirm-avatar-crop': await confirmAvatarCrop(); break;
      case 'restore-backup': await restoreBackupFromPrompt(); break;
      case 'open-task': selectedTaskId = control.dataset.id; currentPage = 'task-detail'; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); break;
      case 'toggle-checklist': toggleTaskChecklist(control.dataset.taskId, Number(control.dataset.index), control.checked); break;
      case 'complete-task': completeTask(control.dataset.id); break;
      case 'edit-task': openTaskEditor(control.dataset.id); break;
      case 'delete-task': deleteTask(control.dataset.id); break;
      case 'open-photo': openPhotoModal(control.dataset.taskId || ''); break;
      case 'close-modal': document.querySelector('#modal-root').innerHTML = ''; break;
      case 'print-report': if (!printDailyReport(data, localDate())) notify('O navegador bloqueou a janela do relatório.', 'error'); break;
      case 'export-backup': exportBackup(data); notify('Cópia local baixada.'); break;
    }
  } catch (error) { notify(error.message, 'error'); }
});
document.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    if (event.target.id === 'onedrive-setup-form') { const formData = new FormData(event.target); saveOneDriveConfig({ clientId: formData.get('clientId'), tenantId: formData.get('tenantId'), folderName: formData.get('folderName') }); window.location.reload(); return; }
    if (event.target.id === 'task-form') await saveTask(event.target);
    if (event.target.id === 'quick-form') await saveQuickRecord(event.target);
    if (event.target.id === 'task-note-form') saveTaskNote(event.target);
    if (event.target.id === 'photo-form') await savePhotoRecord(event.target);
    if (event.target.id === 'attachment-form') await saveAttachment(event.target);
    if (event.target.id === 'child-profile-form') await saveChildProfile(event.target);
    if (event.target.id === 'user-form') saveUser(event.target);
    if (event.target.id === 'migration-form') await importMigrationBundle(event.target);
    if (event.target.id === 'vaccine-form') await saveVaccine(event.target);
    if (event.target.id === 'vaccine-bulk-photo-form') await importVaccineProofs(event.target);
    if (event.target.id === 'history-filter-form') saveHistoryFilter(event.target);
  } catch (error) { notify(error.message, 'error'); }
});
document.addEventListener('input', (event) => {
  if (!event.target.matches('[data-avatar-control]') || !pendingAvatarCrop) return;
  pendingAvatarCrop[event.target.dataset.avatarControl] = Number(event.target.value);
  drawAvatarCrop();
});
document.addEventListener('change', async (event) => {
  if (event.target.matches('input[name="avatar"]') && event.target.files?.[0]) {
    try { await openAvatarEditor(event.target.files[0]); } catch (error) { notify(error.message, 'error'); }
  }
});

async function saveTask(form) {
  if (!can(user.role, 'tasks:create')) throw new Error('Seu perfil não pode criar ou editar afazeres.');
  const values = new FormData(form); const taskId = values.get('taskId'); const taskType = String(values.get('taskType') || 'Outro');
  const checklistText = String(values.get('checklistText') || '').trim();
  const checklist = (checklistText ? checklistText.split(/\r?\n/) : defaultChecklist(taskType)).map((label) => ({ label: String(label).trim(), checked: false })).filter((item) => item.label);
  const record = { date: String(values.get('date')), scheduledTime: String(values.get('scheduledTime')), taskType, category: taskType.toLowerCase(), title: String(values.get('title')).trim(), description: String(values.get('familyNote') || '').trim(), familyNote: String(values.get('familyNote') || '').trim(), checklist, requiresPhoto: values.get('requiresPhoto') === 'on', priority: 'normal', status: 'pending', comments: [] };
  if (!record.title || !record.date || !record.scheduledTime) throw new Error('Informe data, horário e título do afazer.');
  if (taskId) { const previous = data.dailyTasks.find((item) => item.id === taskId); updateRecord('dailyTasks', taskId, { ...record, status: previous?.status || 'pending', completedAt: previous?.completedAt || null, completedBy: previous?.completedBy || null, caregiverNote: previous?.caregiverNote || '' }, user.id); selectedTaskId = taskId; currentPage = 'task-detail'; }
  else { addRecord('dailyTasks', record, user.id); currentPage = 'home'; }
  document.querySelector('#modal-root').innerHTML = ''; render(); notify(taskId ? 'Afazer atualizado.' : 'Afazer adicionado ao dia.');
}

function saveTaskNote(form) {
  const values = new FormData(form); const taskId = String(values.get('taskId')); const note = String(values.get('caregiverNote') || '').trim();
  if (!can(user.role, 'tasks:complete') && !can(user.role, 'logs:create')) throw new Error('Seu perfil não pode registrar observações.');
  updateRecord('dailyTasks', taskId, { caregiverNote: note, caregiverNoteAt: new Date().toISOString(), caregiverNoteBy: user.id }, user.id); render(); notify('Observação salva.');
}

function toggleTaskChecklist(taskId, index, checked) {
  if (!can(user.role, 'tasks:complete') && !can(user.role, 'logs:create')) return notify('Seu perfil não pode atualizar o checklist.', 'error');
  const task = data.dailyTasks.find((item) => item.id === taskId); if (!task) return;
  const checklist = normalizedChecklist(task); if (!checklist[index]) return;
  checklist[index] = { ...checklist[index], checked, checkedAt: checked ? new Date().toISOString() : null, checkedBy: checked ? user.id : null };
  updateRecord('dailyTasks', taskId, { checklist }, user.id); render();
}

function openTaskEditor(id) {
  if (!can(user.role, 'tasks:create')) return notify('Seu perfil não pode editar afazeres.', 'error');
  const task = data.dailyTasks.find((item) => item.id === id); if (!task) return;
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()"><button class="modal__close" data-action="close-modal" aria-label="Fechar">×</button><h2>Editar afazer</h2><form id="task-form"><input type="hidden" name="taskId" value="${task.id}"><label>Data<input name="date" type="date" value="${escape(task.date)}" required></label><div class="form-grid"><label>Horário<input name="scheduledTime" type="time" value="${escape(task.scheduledTime)}" required></label><label>Tipo<select name="taskType">${taskTypes().map((type) => `<option value="${type}" ${(task.taskType || task.category) === type ? 'selected' : ''}>${type}</option>`).join('')}</select></label></div><label>Título<input name="title" value="${escape(task.title)}" required></label><label>Orientação da família<textarea name="familyNote" rows="4">${escape(task.familyNote || task.description || '')}</textarea></label><label>Checklist (um item por linha)<textarea name="checklistText" rows="5">${escape(normalizedChecklist(task).map((item) => item.label).join('\n'))}</textarea></label><label class="check-row"><input type="checkbox" name="requiresPhoto" ${task.requiresPhoto ? 'checked' : ''}> Solicitar foto</label><button class="button button--wide" type="submit">Salvar alterações</button></form></section></div>`;
}

function deleteTask(id) {
  if (!can(user.role, 'tasks:create')) return notify('Seu perfil não pode apagar afazeres.', 'error');
  const task = data.dailyTasks.find((item) => item.id === id); if (!task) return;
  if (!window.confirm(`Apagar o afazer "${task.title}"? Esta ação não pode ser desfeita.`)) return;
  removeRecord('dailyTasks', id, user.id); selectedTaskId = null; currentPage = 'tasks'; render(); notify('Afazer apagado.');
}

async function saveChildProfile(form) {
  if (!can(user.role, 'tasks:create')) throw new Error('Seu perfil não pode editar os dados da criança.');
  const values = new FormData(form); const updated = { ...profile(), name: String(values.get('name')).trim(), birthDate: String(values.get('birthDate') || ''), allergies: String(values.get('allergies') || '').split(',').map((item) => item.trim()).filter(Boolean), criticalNotes: String(values.get('criticalNotes') || '').trim(), healthPlan: String(values.get('healthPlan') || '').trim(), address: String(values.get('address') || '').trim() };
  const contactLines = String(values.get('emergencyContacts') || '').split(/\r?\n/).map((line) => line.split('|').map((part) => part.trim())).filter((parts) => parts[0]);
  data.emergencyContacts = contactLines.map((parts, index) => ({ id: data.emergencyContacts?.[index]?.id || 'contact-' + crypto.randomUUID(), name: parts[0], relationship: parts[1] || 'Contato', phone: parts[2] || '', whatsapp: parts[2] || '', priority: index + 1, notes: '' }));
  const doctorName = String(values.get('doctorName') || '').trim(); const doctorPhone = String(values.get('doctorPhone') || '').trim();
  if (doctorName || doctorPhone) data.doctors = [{ ...(data.doctors?.[0] || { id: 'doctor-' + crypto.randomUUID(), specialty: 'Pediatria', clinic: '', address: '', notes: '' }), name: doctorName, phone: doctorPhone, specialty: 'Pediatria' }];
  const avatar = values.get('avatar');
  if (avatar?.size) {
    if (!pendingAvatarCrop?.blob || pendingAvatarCrop.fileName !== avatar.name) throw new Error('Abra a foto e confirme o enquadramento antes de salvar.');
    const filePath = 'Anexos/Perfil/avatar_' + Date.now() + '.jpg';
    await uploadFile(filePath, pendingAvatarCrop.blob, 'image/jpeg');
    updated.photoUrl = pendingAvatarCrop.thumbnailUrl;
    updated.avatarPath = filePath;
  }
  data.childProfile = updated; pendingAvatarCrop = null; saveData(data); render(); notify('Dados da criança atualizados.');
}

async function openAvatarEditor(file) {
  if (!file.type.startsWith('image/')) throw new Error('Escolha um arquivo de imagem.');
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('Não foi possível abrir a foto.')); image.src = objectUrl; });
  pendingAvatarCrop = { fileName: file.name, image, objectUrl, zoom: 1, panX: 0, panY: 0, blob: null, thumbnailUrl: null };
  document.querySelector('#modal-root').innerHTML = '<div class="modal-backdrop"><section class="modal avatar-crop-editor" role="dialog" aria-modal="true"><button class="modal__close" data-action="close-modal" aria-label="Fechar">×</button><h2>Editar foto do perfil</h2><p class="muted">A área quadrada mostra exatamente o que aparecerá no app.</p><canvas id="avatar-crop-canvas" width="512" height="512" aria-label="Prévia do enquadramento"></canvas><label>Zoom<input data-avatar-control="zoom" type="range" min="1" max="3" step="0.05" value="1"></label><label>Posição horizontal<input data-avatar-control="panX" type="range" min="-100" max="100" step="1" value="0"></label><label>Posição vertical<input data-avatar-control="panY" type="range" min="-100" max="100" step="1" value="0"></label><button class="button button--wide" data-action="confirm-avatar-crop">Usar este enquadramento</button></section></div>';
  drawAvatarCrop();
}

function drawAvatarCrop() {
  const canvas = document.querySelector('#avatar-crop-canvas');
  if (!canvas || !pendingAvatarCrop?.image) return;
  const context = canvas.getContext('2d'); const image = pendingAvatarCrop.image; const size = canvas.width;
  const scale = Math.max(size / image.width, size / image.height) * pendingAvatarCrop.zoom;
  const width = image.width * scale; const height = image.height * scale;
  const maxX = Math.max(0, (width - size) / 2); const maxY = Math.max(0, (height - size) / 2);
  const x = (size - width) / 2 + (pendingAvatarCrop.panX / 100) * maxX;
  const y = (size - height) / 2 + (pendingAvatarCrop.panY / 100) * maxY;
  context.clearRect(0, 0, size, size); context.drawImage(image, x, y, width, height);
}

async function confirmAvatarCrop() {
  const canvas = document.querySelector('#avatar-crop-canvas');
  if (!canvas || !pendingAvatarCrop) return;
  pendingAvatarCrop.blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  pendingAvatarCrop.thumbnailUrl = canvas.toDataURL('image/jpeg', 0.82);
  URL.revokeObjectURL(pendingAvatarCrop.objectUrl);
  document.querySelector('#modal-root').innerHTML = '';
  const status = document.querySelector('#avatar-crop-status');
  if (status) status.textContent = 'Enquadramento confirmado. Agora toque em “Salvar dados da criança”.';
  notify('Enquadramento da foto confirmado.');
}
function saveUser(form) {
  if (!can(user.role, 'tasks:create')) throw new Error('Seu perfil não pode adicionar usuários.');
  const values = new FormData(form); const email = String(values.get('email')).trim().toLowerCase();
  if ((data.users || []).some((item) => item.email?.toLowerCase() === email)) throw new Error('Este e-mail já está cadastrado.');
  addRecord('users', { name: String(values.get('name')).trim(), email, role: String(values.get('role')), phone: '', active: true }, user.id); render(); notify('Usuário autorizado adicionado.');
}

async function importMigrationBundle(form) {
  if (!can(user.role, 'tasks:create')) throw new Error('Seu perfil não pode importar dados.');
  const file = new FormData(form).get('legacyBundle'); if (!file?.size) throw new Error('Selecione um pacote JSON.');
  const bundle = JSON.parse(await file.text()); lastMigrationReport = importLegacyBundle(data, bundle, user.id); saveData(data); render(); notify(lastMigrationReport.skipped ? 'Este pacote já tinha sido importado.' : 'Importação concluída.');
}

function saveHistoryFilter(form) { const values = new FormData(form); historyFilter = { period: String(values.get('period')), date: String(values.get('date') || localDate()), type: String(values.get('type') || '') }; render(); }
async function saveQuickRecord(form) {
  if (!can(user.role, 'logs:create')) return notify('Seu perfil não pode criar registros.', 'error');
  const formData = new FormData(form); const type = String(formData.get('type') || 'Observação'); const description = String(formData.get('description') || '').trim();
  if (!description) return notify('Escreva uma observação antes de salvar.', 'error');
  const file = formData.get('photo'); if (file?.size) await createPhoto({ file, caption: description, category: type });
  addRecord('dailyLogs', { date: localDate(), time: String(formData.get('time') || currentTime()), type, description, mood: '', symptoms: '', fileUrl: null, isImportant: false }, user.id);
  currentPage = 'home'; render(); notify('Registro salvo.');
}
function confirmReading() {
  const instruction = data.dailyInstructions.find((item) => item.date === localDate());
  if (!instruction || !can(user.role, 'instructions:confirm')) return notify('Seu perfil não pode confirmar a leitura.', 'error');
  addRecord('dailyConfirmations', { instructionId: instruction.id, userId: user.id, confirmedAt: new Date().toISOString(), message: 'Li e entendi as orientações do dia.' }, user.id);
  render(); notify('Leitura confirmada para os responsáveis.');
}

function completeTask(id, comment = '') {
  if (!can(user.role, 'tasks:complete')) return notify('Seu perfil não pode concluir tarefas.', 'error');
  const task = data.dailyTasks.find((item) => item.id === id); if (!task) return;
  const comments = comment ? [...(task.comments || []), { userId: user.id, comment, createdAt: new Date().toISOString() }] : task.comments || [];
  updateRecord('dailyTasks', id, { status: 'completed', completedBy: user.id, completedAt: new Date().toISOString(), comments }, user.id);
  render(); notify('Afazer marcado como feito.');
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
    instructionId: data.dailyInstructions.find((item) => item.date === localDate())?.id || null,
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

async function saveVaccine(form) {
  if (!can(user.role, 'tasks:create')) throw new Error('Seu perfil não pode alterar vacinas.');
  const values = new FormData(form); const vaccineId = String(values.get('vaccineId') || ''); const appliedDate = String(values.get('appliedDate') || '');
  const current = vaccineId ? data.vaccines.find((item) => item.id === vaccineId) : null;
  if (!appliedDate || !String(values.get('name') || '').trim() || !String(values.get('dose') || '').trim()) throw new Error('Informe data, vacina e dose.');
  const proofPaths = [...(current?.proofFilePaths || [])];
  for (const file of values.getAll('proofs')) {
    if (!file?.size) continue;
    const path = vaccineProofPath(file.name, appliedDate);
    await uploadFile(path, file, file.type || 'application/octet-stream');
    if (!proofPaths.includes(path)) proofPaths.push(path);
  }
  const record = { name: String(values.get('name')).trim(), dose: String(values.get('dose')).trim(), appliedDate, expectedDate: appliedDate, batch: String(values.get('batch') || '').trim(), location: String(values.get('location') || '').trim(), notes: String(values.get('notes') || '').trim(), status: 'applied', proofFilePaths: proofPaths, proofExpectedCount: Math.max(proofPaths.length, Number(current?.proofExpectedCount || 0)), proofStatus: proofPaths.length ? 'uploaded' : 'none' };
  if (current) updateRecord('vaccines', current.id, record, user.id); else addRecord('vaccines', record, user.id);
  document.querySelector('#modal-root').innerHTML = '';
  selectedVaccineId = current?.id || selectedVaccineId;
  render(); notify('Vacina salva com ' + proofPaths.length + ' comprovante(s).');
}

async function importVaccineProofs(form) {
  if (!can(user.role, 'tasks:create')) throw new Error('Seu perfil não pode anexar comprovantes.');
  const formData = new FormData(form);
  const files = [...formData.getAll('vaccineProofDirectory'), ...formData.getAll('vaccineProofFiles')].filter((file) => file?.size);
  if (!files.length) throw new Error('Escolha uma ou mais fotos.');
  const matched = new Map(); const unmatched = [];
  for (const file of files) {
    const vaccine = findVaccineForProof(file.name);
    if (!vaccine) { unmatched.push(file.name); continue; }
    const path = vaccineProofPath(file.name, vaccine.appliedDate || vaccine.expectedDate || localDate());
    await uploadFile(path, file, file.type || 'application/octet-stream');
    const paths = matched.get(vaccine.id) || [...(vaccine.proofFilePaths || [])];
    if (!paths.includes(path)) paths.push(path);
    matched.set(vaccine.id, paths);
  }
  for (const [id, paths] of matched) {
    const vaccine = data.vaccines.find((item) => item.id === id);
    updateRecord('vaccines', id, { proofFilePaths: paths, proofExpectedCount: Math.max(paths.length, Number(vaccine?.proofExpectedCount || 0)), proofStatus: 'uploaded' }, user.id);
  }
  form.reset(); render();
  const uploaded = files.length - unmatched.length;
  notify(unmatched.length ? uploaded + ' foto(s) anexada(s). ' + unmatched.length + ' arquivo(s) não puderam ser relacionados pelo nome.' : uploaded + ' foto(s) anexada(s) às vacinas corretas.');
}

function findVaccineForProof(fileName) {
  const file = normalizeSearch(fileName);
  const patterns = [
    { prefix: 'triplice-dose-1', name: 'triplice', dose: '1' },
    { prefix: 'varicela-dose-1', name: 'varicela', dose: '1' },
    { prefix: 'meningo-b-reforco', name: 'meningo-b', dose: 'reforco' },
    { prefix: 'pneumo-15-reforco', name: 'pneumo-15', dose: 'reforco' },
    { prefix: 'meningo-acwy-reforco', name: 'meningo-acwy', dose: 'reforco' },
    { prefix: 'pentavalente-reforco', name: 'pentavalente', dose: 'reforco' },
    { prefix: 'varicela-dose-2', name: 'varicela', dose: '2' },
    { prefix: 'influenza-dose-1', name: 'influenza', dose: '1' }
  ];
  const pattern = patterns.find((item) => file.includes(item.prefix));
  if (!pattern) return null;
  return (data.vaccines || []).find((item) => {
    const vaccineName = normalizeSearch(item.name); const dose = normalizeSearch(item.dose);
    const doseMatches = dose.includes(pattern.dose) || (pattern.dose === '1' && /(^|-)1($|-)/.test(dose)) || (pattern.dose === '2' && /(^|-)2($|-)/.test(dose));
    return vaccineName.includes(pattern.name) && doseMatches;
  }) || null;
}

function normalizeSearch(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function openVaccineEditor(id) {
  if (!can(user.role, 'tasks:create')) return notify('Seu perfil não pode editar vacinas.', 'error');
  const vaccine = data.vaccines.find((item) => item.id === id); if (!vaccine) return;
  const proofCount = (vaccine.proofFilePaths || []).length;
  document.querySelector('#modal-root').innerHTML = '<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()"><button class="modal__close" data-action="close-modal" aria-label="Fechar">×</button><h2>Editar vacina</h2><form id="vaccine-form"><input type="hidden" name="vaccineId" value="' + vaccine.id + '"><label>Data da aplicação<input name="appliedDate" type="date" value="' + escape(vaccine.appliedDate || '') + '" required></label><div class="form-grid"><label>Vacina<input name="name" value="' + escape(vaccine.name) + '" required></label><label>Dose<input name="dose" value="' + escape(vaccine.dose) + '" required></label></div><div class="form-grid"><label>Lote<input name="batch" value="' + escape(vaccine.batch || '') + '"></label><label>Local<input name="location" value="' + escape(vaccine.location || '') + '"></label></div><label>Observação<textarea name="notes" rows="3">' + escape(vaccine.notes || '') + '</textarea></label><label>Adicionar comprovantes (pode escolher vários)<input name="proofs" type="file" accept="image/*,application/pdf" multiple></label><p class="permission-note">' + proofCount + ' comprovante(s) já anexado(s).</p><button class="button button--wide" type="submit">Salvar alterações</button></form></section></div>';
}

function deleteVaccine(id) {
  if (!can(user.role, 'tasks:create')) return notify('Seu perfil não pode apagar vacinas.', 'error');
  const vaccine = data.vaccines.find((item) => item.id === id); if (!vaccine) return;
  if (!window.confirm('Apagar ' + vaccine.name + ' (' + vaccine.dose + ')?')) return;
  removeRecord('vaccines', id, user.id); selectedVaccineId = null; currentPage = 'vaccines'; render(); notify('Vacina apagada.');
}

function clearExampleVaccines() {
  if (!can(user.role, 'tasks:create')) return notify('Seu perfil não pode apagar vacinas.', 'error');
  const examples = data.vaccines.filter(isExampleVaccine); if (!examples.length) return notify('Não há vacinas de exemplo.');
  if (!window.confirm('Apagar ' + examples.length + ' vacina(s) de exemplo?')) return;
  examples.forEach((item) => removeRecord('vaccines', item.id, user.id)); render(); notify('Vacinas de exemplo apagadas.');
}

function isExampleVaccine(vaccine) { return String(vaccine.id || '').includes('-demo') || /exemplo/i.test(String(vaccine.name || '') + ' ' + String(vaccine.notes || '')); }
function vaccineProofPath(fileName, date) { const parts = date.split('-'); return 'Anexos/Vacinas/' + parts[0] + '/' + parts[1] + '/' + date + '_' + safeFileName(fileName); }
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js?v=12').catch(() => {});
}


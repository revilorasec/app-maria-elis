import { loadData, loadInitialData, getPendingChanges, preserveLegacyPendingNamespace, addRecord, updateRecord, removeRecord, saveData, resetLocalCache, localDate, setPersistence, flushPersistence, setDataNamespace, setDataBaseVersion, hasPendingChanges } from './services/dataService.js?v=16';
import { can, getRoleLabel } from './services/permissionsService.js?v=16';
import { clearDeviceBinding, clearFailedAttempts, createPinHash, getDeviceBinding, isAttemptBlocked, registerFailedAttempt, remainingBlockMinutes, saveDeviceBinding, setDeviceLocked, validPin, verifyPin } from './services/deviceAccessService.js?v=16';
import { notify, offlineNotice } from './services/notificationService.js?v=16';
import { lineChart, donutChart } from './services/chartService.js?v=16';
import { exportBackup, printDailyReport } from './services/reportService.js?v=16';
import { clearOneDriveConfig, initializeMicrosoftSession, saveOneDriveConfig, signInMicrosoft, signOutMicrosoft } from './auth.js?v=16';
import { backupDB, connectOneDrive, deleteFile, downloadFile, getDBVersion, getFileUrl, getRootWebUrl, getStorageIdentity, listFiles, loadDB, readJsonFile, restoreDB, saveDB, uploadFile, writeJsonFile } from './storage.js?v=16';
import { eventPhotoPath, listPendingPhotos, queuePendingPhoto, removePendingPhoto, resizeImage } from './photos.js?v=16';
import { renderConnectionStatus } from './ui.js?v=16';
import { importLegacyBundle, migrationReportText } from './migration.js?v=16';
import { extractLegacyPrivateCaregiverData, hasLegacyPrivateCaregiverData, migrateSchemaV2 } from './schemaMigration.js?v=16';
import { connectAdminArea, DEFAULT_ADMIN_FOLDER, deleteAdminPath, getAdminFileUrl, saveAdminData, uploadAdminFile } from './adminStorage.js?v=16';

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
let microsoftUser;
let oneDriveConfig;
let dataNamespace = null;
let microsoftAccount;
let syncState = 'Conectando';
let selectedTaskId = null;
let selectedVaccineId = null;
let selectedPersonId = null;
let peopleFilter = 'active';
let caregiverStep = 1;
let adminData = null;
let adminAreaStatus = 'unavailable';
let pendingAvatarCrop = null;
let historyFilter = { period: 'today', date: localDate(), type: '' };
let lastMigrationReport = null;
let pendingConflict = null;
let deviceBinding = null;
let restrictedDeviceMode = false;
let deviceInactivityTimer = null;
let selectedDevicePersonId = '';
let suppressNextCommonBackup = false;
const privateImageUrls = new Map();
const privateImageLoads = new Map();

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
    const initialData = await loadInitialData();
    await connectOneDrive(oneDriveConfig.folderName);
    const accountNamespace = microsoftAccount.homeAccountId || microsoftAccount.localAccountId || microsoftAccount.username;
    const legacyNamespace = [accountNamespace, oneDriveConfig.tenantId, oneDriveConfig.folderName].join('|');
    dataNamespace = setDataNamespace([accountNamespace, oneDriveConfig.tenantId, getStorageIdentity()].join('|'));
    preserveLegacyPendingNamespace(legacyNamespace);

    const remoteData = await loadDB(initialData);
    const remoteVersion = getDBVersion();
    const pending = getPendingChanges();
    data = structuredClone(remoteData);
    prepareCurrentData();
    assertAccountAuthorized(microsoftAccount, data);

    if (pending) {
      if (pendingConflictsWithRemote(pending, remoteData, remoteVersion)) {
        pendingConflict = { state: pending.state, remoteData, remoteVersion };
        renderSyncConflict();
        return;
      }
      data = structuredClone(pending.state);
      prepareCurrentData();
    }

    setDataBaseVersion(remoteVersion);
    user = resolveAuthorizedUser(microsoftAccount);
    microsoftUser = user;
    if ((user.role || user.roleId) !== 'admin' && (Number(data.meta?.privacyMigrationVersion || 0) < 1 || hasLegacyPrivateCaregiverData(data) || containsEmbeddedDataUrls(data))) {
      throw new Error('Existem dados antigos da babá que precisam ser protegidos. Entre primeiro com o administrador para concluir a migração segura.');
    }
    data = await loadData(data, { markDirty: Boolean(pending) });
    await tryLoadAdminArea(false);
    await migrateLegacyPrivateCaregiverData();
    await migrateEmbeddedImages();
    cleanupOrphanCaregiverProfiles();
    await purgeExpiredAdminCaregivers();
    await purgeExpiredTrash();
    configurePersistence();

    saveData(data);
    await offerLegacyPendingPhotoRecovery();
    await syncPendingPhotoUploads();
    syncState = hasPendingChanges() ? 'Pendente' : 'Sincronizado';
    if (resumeRestrictedDeviceMode()) return;
    if ((microsoftUser.role || microsoftUser.roleId) === 'admin') {
      renderDeviceEnrollment();
      return;
    }
    render();
  } catch (error) {
    app.innerHTML = '<main class="fatal"><h1>Não foi possível conectar</h1><p>' + escape(error.message) + '</p><button class="button" data-action="reconfigure-onedrive">Revisar configuração</button></main>';
  }
}

function configurePersistence() {
  setPersistence({
    save: async (snapshot) => {
      setSyncState('Salvando');
      const skipBackup = suppressNextCommonBackup;
      const saved = await saveDB(snapshot, { skipBackup });
      if (skipBackup) suppressNextCommonBackup = false;
      data.meta = saved.meta;
      setDataBaseVersion(getDBVersion());
      setSyncState('Sincronizado');
    },
    onError: (error) => {
      setSyncState('Pendente');
      notify('Alteração guardada neste aparelho. A sincronização falhou: ' + error.message, 'warning');
    }
  });
}
function prepareCurrentData() {
  normalizeLegacyData();
  migrateSchemaV2(data);
}

function assertAccountAuthorized(account, candidate) {
  const email = String(account.username || '').trim().toLowerCase();
  const registered = (candidate.users || []).filter((item) => item.email && !String(item.email).endsWith('.invalid'));
  if (!registered.length) {
    if (candidate.meta?.bootstrapCompleted) throw new Error('Nenhum administrador ativo foi encontrado. Restaure um backup ou peça ajuda ao responsável pelo app.');
    return true;
  }
  if (!registered.some((item) => String(item.email).toLowerCase() === email && item.active)) {
    throw new Error('A conta ' + (email || 'Microsoft selecionada') + ' ainda não está autorizada neste dados.json.');
  }
  return true;
}

function pendingConflictsWithRemote(pending, remoteData, remoteVersion) {
  if (pending.requiresReview) return true;
  const pendingUsers = (pending.state?.users || []).filter((item) => item.email && !String(item.email).endsWith('.invalid'));
  const remoteUsers = (remoteData?.users || []).filter((item) => item.email && !String(item.email).endsWith('.invalid'));
  if (!remoteUsers.length && pendingUsers.length) return true;
  if (pending.baseVersion && remoteVersion) return String(pending.baseVersion) !== String(remoteVersion);
  const pendingStamp = String(pending.state?.meta?.updatedAt || '');
  const remoteStamp = String(remoteData?.meta?.updatedAt || '');
  return pendingStamp !== remoteStamp;
}

function renderSyncConflict() {
  app.innerHTML = `<main class="fatal"><p class="eyebrow">Proteção dos dados</p><h1>Há duas versões para revisar</h1><p>Este aparelho possui alterações pendentes, mas o OneDrive também mudou. Para não apagar nada de outra pessoa, o app não sobrescreveu o arquivo.</p><button class="button button--wide" data-action="export-pending-conflict">Baixar cópia das alterações deste aparelho</button><button class="button button--secondary button--wide" data-action="discard-pending-conflict">Depois do download, usar a versão do OneDrive</button><p class="permission-note">Guarde a cópia local antes de continuar. Ela poderá ser revisada ou importada com segurança.</p></main>`;
}
const DATA_COLLECTIONS = ['users', 'documents', 'vaccines', 'appointments', 'growthRecords', 'dailyInstructions', 'dailyTasks', 'dailyPhotos', 'dailyConfirmations', 'dailyComments', 'dailyLogs', 'medications', 'medicationAdministrations', 'emergencyContacts', 'doctors', 'attachments', 'auditLog', 'people', 'caregiverProfiles', 'accessGrants', 'trash'];

function isDemoRecord(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.isDemo === true || item.isExample === true || item.demo === true) return true;
  const nested = item.record && typeof item.record === 'object' ? item.record : {};
  const id = String(item.id || item.entityId || nested.id || '').toLowerCase();
  const email = String(item.email || nested.email || '').toLowerCase();
  const label = [item.name, item.fullName, item.title, nested.name, nested.fullName, nested.title].filter(Boolean).join(' ').toLowerCase();
  return /(^|[-_])(demo|example|exemplo|sample)([-_]|$)/.test(id)
    || email.endsWith('.invalid')
    || /(^|\s)(demo|exemplo|demonstração)(\s|$)/i.test(label);
}

function normalizeLegacyData() {
  let changed = false;
  let removedDemoUsers = false;
  const typeByCategory = { alimentação: 'Lanche', medicamento: 'Medicamento', sono: 'Sono', banho: 'Banho', atividade: 'Brincadeira', observação: 'Observação', sintoma: 'Sintoma' };
  data.meta = data.meta && typeof data.meta === 'object' ? data.meta : {};
  for (const collection of DATA_COLLECTIONS) {
    if (!Array.isArray(data[collection])) { data[collection] = []; changed = true; continue; }
    const previousLength = data[collection].length;
    const realRecords = data[collection].filter((item) => !isDemoRecord(item));
    if (realRecords.length !== previousLength) {
      if (collection === 'users') removedDemoUsers = true;
      data[collection] = realRecords;
      changed = true;
    }
  }
  if (!data.childProfile || data.childProfile.isDemo === true || /exemplo|demonstra|demo/i.test(String(data.childProfile.name || ''))) {
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
  if (data.childProfile.avatarPath && String(data.childProfile.photoUrl || '').startsWith('data:')) { data.childProfile.photoUrl = ''; changed = true; }
  data.people = data.people.map((person) => person.photoPath && String(person.photoUrl || '').startsWith('data:') ? (changed = true, { ...person, photoUrl: '' }) : person);
  data.dailyPhotos = data.dailyPhotos.map((photo) => photo.filePath && photo.syncStatus === 'synced' && String(photo.thumbnailUrl || '').startsWith('data:') ? (changed = true, { ...photo, thumbnailUrl: '' }) : photo);
  if (removedDemoUsers && !data.users.length && data.meta.bootstrapCompleted) { data.meta.bootstrapCompleted = false; changed = true; }

  if (!data.meta.demoCleanupAt) { data.meta.demoCleanupAt = new Date().toISOString(); changed = true; }
  return changed;
}
function resolveAuthorizedUser(account) {
  const email = String(account.username || '').trim().toLowerCase();
  const registered = (data.users || []).filter((item) => item.email && !item.email.endsWith('.invalid'));
  if (!registered.length) {
    if (data.meta?.bootstrapCompleted) throw new Error('Nenhum administrador ativo foi encontrado. Restaure um backup ou peça ajuda ao responsável pelo app.');
    const personId = 'person-' + crypto.randomUUID();
    const firstAdmin = {
      id: 'user-' + crypto.randomUUID(),
      personId,
      name: account.name || account.username || 'Responsável',
      email,
      normalizedEmail: email,
      phone: '',
      role: 'admin',
      roleId: 'admin',
      active: true,
      microsoftIdentity: {
        tenantId: account.tenantId || '',
        objectId: account.localAccountId || '',
        homeAccountId: account.homeAccountId || ''
      },
      createdAt: new Date().toISOString(),
      lastAccessAt: new Date().toISOString()
    };
    data.people = Array.isArray(data.people) ? data.people : [];
    data.people.unshift({
      id: personId,
      entityKind: 'person',
      primaryType: 'guardian',
      types: ['guardian'],
      fullName: firstAdmin.name,
      relationship: 'Responsável',
      photoPath: '',
      photoUrl: '',
      phone: '',
      whatsapp: '',
      email,
      address: { formatted: '', latitude: null, longitude: null },
      priority: 1,
      notes: '',
      active: true,
      relatedPersonIds: [],
      documentIds: [],
      permissions: [],
      createdAt: new Date().toISOString(),
      createdBy: firstAdmin.id
    });
    data.users = [firstAdmin];
    data.meta = { ...(data.meta || {}), bootstrapCompleted: true };
    data.auditLog = data.auditLog || [];
    data.auditLog.unshift({ id: 'audit-' + crypto.randomUUID(), userId: firstAdmin.id, action: 'bootstrap', entityType: 'user', entityId: firstAdmin.id, oldValue: null, newValue: '[primeiro responsável autorizado]', createdAt: new Date().toISOString() });
    return firstAdmin;
  }
  const found = registered.find((item) => item.email.toLowerCase() === email && item.active);
  if (!found) throw new Error('A conta ' + (email || 'Microsoft selecionada') + ' ainda não está autorizada neste dados.json.');
  found.role = found.role || found.roleId || 'visitor';
  found.roleId = found.role;
  found.normalizedEmail = email;
  found.microsoftIdentity = {
    ...(found.microsoftIdentity || {}),
    tenantId: account.tenantId || found.microsoftIdentity?.tenantId || '',
    objectId: account.localAccountId || found.microsoftIdentity?.objectId || '',
    homeAccountId: account.homeAccountId || found.microsoftIdentity?.homeAccountId || ''
  };
  found.lastAccessAt = new Date().toISOString();
  data.meta = { ...(data.meta || {}), bootstrapCompleted: true };
  return found;
}

function isRestrictedDeviceMode() { return restrictedDeviceMode === true && (user?.role || user?.roleId) === 'caregiver'; }
function currentMicrosoftAdmin() {
  const id = microsoftUser?.id;
  const email = String(microsoftUser?.email || microsoftAccount?.username || '').toLowerCase();
  return (data.users || []).find((item) => item.id === id) || (data.users || []).find((item) => String(item.email || '').toLowerCase() === email && (item.role || item.roleId) === 'admin') || null;
}
function hasPin(record) { return Boolean(record?.pinHash?.salt && record?.pinHash?.digest); }
function userForDeviceBinding() {
  if (!deviceBinding?.personId) return null;
  const candidate = (data.users || []).find((item) => item.personId === deviceBinding.personId);
  return candidate && candidate.active !== false && candidate.deviceEnabled === true && (candidate.role || candidate.roleId) === 'caregiver' && hasPin(candidate) ? candidate : null;
}
function devicePerson() { return personById(deviceBinding?.personId || user?.personId) || {}; }
function resumeRestrictedDeviceMode() {
  deviceBinding = getDeviceBinding();
  const deviceUser = userForDeviceBinding();
  if (!deviceBinding) return false;
  if (!deviceUser) { clearDeviceBinding(); deviceBinding = null; return false; }
  user = deviceUser; restrictedDeviceMode = true; adminData = null; adminAreaStatus = 'restricted';
  deviceBinding = setDeviceLocked(true); renderDeviceLock(); return true;
}
function renderAdminPinSetup() {
  app.innerHTML = '<main class="fatal device-access-screen"><p class="eyebrow">Segurança do dispositivo</p><h1>Defina o PIN do administrador</h1><p>Ele será exigido para trocar o usuário deste aparelho e abrir as configurações administrativas.</p><form id="admin-pin-setup-form" class="form-card"><label>PIN do administrador<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,6}" minlength="4" maxlength="6" autocomplete="new-password" required></label><label>Confirmar PIN<input name="pinConfirmation" type="password" inputmode="numeric" pattern="[0-9]{4,6}" minlength="4" maxlength="6" autocomplete="new-password" required></label><button class="button button--wide" type="submit">Salvar PIN e continuar</button></form></main>';
}
function renderDeviceEnrollment() {
  const admin = currentMicrosoftAdmin();
  if (!admin || !hasPin(admin)) { renderAdminPinSetup(); return; }
  const people = activePeople().filter((person) => ((data.users || []).find((item) => item.personId === person.id)?.role || '') !== 'admin');
  const selected = people.find((person) => person.id === selectedDevicePersonId);
  const cards = people.map((person) => {
    const photo = person.photoPath ? privateImageMarkup(person.photoPath, person.photoUrl || 'assets/icons/child-avatar.svg', 'Foto de ' + person.fullName) : person.photoUrl ? '<img src="' + escape(person.photoUrl) + '" alt="">' : '<span>' + personTypeIcon(person.primaryType) + '</span>';
    return '<button class="person-card__main device-person-choice ' + (selected?.id === person.id ? 'is-selected' : '') + '" data-action="select-device-person" data-id="' + escape(person.id) + '"><span class="person-avatar">' + photo + '</span><span><strong>' + escape(firstName(person.fullName || 'Pessoa')) + '</strong><small>' + escape(person.relationship || 'Babá/cuidador(a)') + '</small></span><b>›</b></button>';
  }).join('');
  const form = selected ? '<form id="device-enrollment-form" class="form-card"><input type="hidden" name="personId" value="' + escape(selected.id) + '"><p class="permission-note">Defina ou redefina o PIN de ' + escape(firstName(selected.fullName)) + '. O PIN não é salvo em texto puro.</p><label>PIN de acesso<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,6}" minlength="4" maxlength="6" autocomplete="new-password" required></label><label>Confirmar PIN<input name="pinConfirmation" type="password" inputmode="numeric" pattern="[0-9]{4,6}" minlength="4" maxlength="6" autocomplete="new-password" required></label><label>Bloqueio automático<select name="lockAfterMinutes"><option value="10">10 minutos</option><option value="5">5 minutos</option><option value="15">15 minutos</option><option value="30">30 minutos</option></select></label><button class="button button--wide" type="submit">Entrar como ' + escape(firstName(selected.fullName)) + '</button></form>' : '<p class="muted">Selecione uma pessoa ativa para configurar este aparelho.</p>';
  app.innerHTML = '<main class="fatal device-access-screen"><p class="eyebrow">Este aparelho</p><h1>Quem usará este dispositivo?</h1><p>Escolha quem usará o app. A pessoa verá somente os recursos liberados para ela.</p><section class="device-person-list">' + (cards || '<p class="muted">Cadastre primeiro a babá em Pessoas.</p>') + '</section>' + form + '<button class="text-button" data-action="continue-admin-mode">Usar modo administrador</button></main>';
  hydratePrivateImages().catch(() => {});
}
function renderDeviceLock() {
  const person = devicePerson();
  const blocked = isAttemptBlocked(deviceBinding, 'unlock');
  const photo = person.photoPath ? privateImageMarkup(person.photoPath, person.photoUrl || 'assets/icons/child-avatar.svg', 'Foto de ' + (person.fullName || 'usuária'), 'device-access-avatar') : '<span class="device-access-avatar person-avatar">' + initials(person.fullName || user?.name || 'U') + '</span>';
  const form = blocked ? '<p class="restricted-card">Muitas tentativas inválidas. Tente novamente em aproximadamente ' + remainingBlockMinutes(deviceBinding, 'unlock') + ' minuto(s).</p>' : '<form id="device-unlock-form" class="form-card"><label>PIN de acesso<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,6}" minlength="4" maxlength="6" autocomplete="current-password" autofocus required></label><button class="button button--wide" type="submit">Entrar</button></form>';
  app.innerHTML = '<main class="fatal device-access-screen"><div class="device-access-identity">' + photo + '<div><p class="eyebrow">Modo Babá</p><h1>' + escape(firstName(person.fullName || user?.name || 'Usuária')) + '</h1><p>' + escape(person.relationship || 'Babá/cuidador(a)') + '</p></div></div><p>Informe seu PIN para abrir os afazeres.</p>' + form + '<button class="text-button" data-action="request-admin-mode">Trocar usuário / Modo administrador</button></main>';
  hydratePrivateImages().catch(() => {});
}
function renderAdminPinPrompt() {
  const blocked = isAttemptBlocked(deviceBinding, 'admin');
  const form = blocked ? '<p class="restricted-card">Muitas tentativas inválidas. Tente novamente em aproximadamente ' + remainingBlockMinutes(deviceBinding, 'admin') + ' minuto(s).</p>' : '<form id="admin-unlock-form" class="form-card"><label>PIN do administrador<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,6}" minlength="4" maxlength="6" autocomplete="current-password" autofocus required></label><button class="button button--wide" type="submit">Continuar como administrador</button></form>';
  app.innerHTML = '<main class="fatal device-access-screen"><p class="eyebrow">Área protegida</p><h1>Modo administrador</h1><p>Digite o PIN do administrador para trocar o usuário ou alterar este aparelho.</p>' + form + '<button class="text-button" data-action="back-to-device-lock">Voltar</button></main>';
}
async function saveAdminPin(form) {
  const values = new FormData(form); const pin = String(values.get('pin') || ''); const confirmation = String(values.get('pinConfirmation') || '');
  if (!validPin(pin) || pin !== confirmation) throw new Error('Informe e confirme um PIN numérico igual, de 4 a 6 dígitos.');
  const admin = currentMicrosoftAdmin(); if (!admin) throw new Error('Administrador não encontrado.');
  microsoftUser = updateRecord('users', admin.id, { pinHash: await createPinHash(pin), pinUpdatedAt: new Date().toISOString() }, admin.id); user = microsoftUser; renderDeviceEnrollment();
}
async function enrollDeviceUser(form) {
  const values = new FormData(form); const person = personById(String(values.get('personId') || '')); const pin = String(values.get('pin') || ''); const confirmation = String(values.get('pinConfirmation') || '');
  if (!person || person.active === false) throw new Error('Escolha uma pessoa ativa para este dispositivo.');
  if (!validPin(pin) || pin !== confirmation) throw new Error('Informe e confirme um PIN numérico igual, de 4 a 6 dígitos.');
  const existing = (data.users || []).find((item) => item.personId === person.id);
  if ((existing?.role || existing?.roleId) === 'admin') throw new Error('O administrador não pode ser vinculado ao modo restrito.');
  const record = { ...(existing || {}), personId: person.id, name: person.fullName, role: 'caregiver', roleId: 'caregiver', active: true, deviceEnabled: true, deviceAuthorizedAt: new Date().toISOString(), pinHash: await createPinHash(pin), pinUpdatedAt: new Date().toISOString() };
  const deviceUser = existing ? updateRecord('users', existing.id, record, microsoftUser.id) : addRecord('users', record, microsoftUser.id);
  updateRecord('people', person.id, { deviceEnabled: true }, microsoftUser.id);
  deviceBinding = saveDeviceBinding({ personId: person.id, displayName: person.fullName, role: 'caregiver', permissions: deviceUser.permissions || [], restricted: true, locked: false, lockAfterMinutes: Number(values.get('lockAfterMinutes') || 10), configuredAt: new Date().toISOString(), unlockFailedAttempts: 0, unlockBlockedUntil: null, adminFailedAttempts: 0, adminBlockedUntil: null });
  user = deviceUser; restrictedDeviceMode = true; adminData = null; adminAreaStatus = 'restricted'; startDeviceInactivityTimer(); render(); notify('Modo Babá configurado neste aparelho.');
}
async function unlockDevice(form) {
  deviceBinding = getDeviceBinding(); if (!deviceBinding || isAttemptBlocked(deviceBinding, 'unlock')) throw new Error('Este dispositivo está temporariamente bloqueado.');
  const deviceUser = userForDeviceBinding(); if (!deviceUser) throw new Error('O acesso deste dispositivo foi revogado.');
  if (!await verifyPin(String(new FormData(form).get('pin') || ''), deviceUser.pinHash)) {
    deviceBinding = registerFailedAttempt('unlock'); throw new Error(isAttemptBlocked(deviceBinding, 'unlock') ? 'PIN bloqueado por 15 minutos após muitas tentativas inválidas.' : 'PIN incorreto.');
  }
  deviceBinding = clearFailedAttempts('unlock'); deviceBinding = setDeviceLocked(false);
  user = updateRecord('users', deviceUser.id, { lastAccessAt: new Date().toISOString(), lastUnlockedAt: new Date().toISOString() }, deviceUser.id);
  restrictedDeviceMode = true; startDeviceInactivityTimer(); render();
}
async function unlockAdministrator(form) {
  deviceBinding = getDeviceBinding(); if (!deviceBinding || isAttemptBlocked(deviceBinding, 'admin')) throw new Error('A troca de usuário está temporariamente bloqueada.');
  const admin = currentMicrosoftAdmin(); if (!admin || !hasPin(admin)) throw new Error('O PIN do administrador precisa ser definido primeiro.');
  if (!await verifyPin(String(new FormData(form).get('pin') || ''), admin.pinHash)) {
    deviceBinding = registerFailedAttempt('admin'); throw new Error(isAttemptBlocked(deviceBinding, 'admin') ? 'PIN bloqueado por 15 minutos após muitas tentativas inválidas.' : 'PIN incorreto.');
  }
  clearFailedAttempts('admin'); setDeviceLocked(true); restrictedDeviceMode = false; user = admin; clearDeviceInactivityTimer(); renderDeviceEnrollment();
}
function returnToDeviceLock() { const deviceUser = userForDeviceBinding(); if (!deviceUser) return; user = deviceUser; restrictedDeviceMode = true; deviceBinding = setDeviceLocked(true); clearDeviceInactivityTimer(); renderDeviceLock(); }
function lockDeviceNow() { if (!isRestrictedDeviceMode()) return; deviceBinding = setDeviceLocked(true); clearDeviceInactivityTimer(); renderDeviceLock(); }
function startDeviceInactivityTimer() { clearDeviceInactivityTimer(); if (!isRestrictedDeviceMode()) return; deviceInactivityTimer = window.setTimeout(lockDeviceNow, Math.max(1, Number(getDeviceBinding()?.lockAfterMinutes || 10)) * 60_000); }
function clearDeviceInactivityTimer() { if (deviceInactivityTimer) window.clearTimeout(deviceInactivityTimer); deviceInactivityTimer = null; }
function recordDeviceActivity() { if (isRestrictedDeviceMode() && getDeviceBinding()?.locked !== true) startDeviceInactivityTimer(); }
function canOpenPage(page) {
  if (!isRestrictedDeviceMode()) return true;
  const allowed = new Set(['home', 'instructions', 'tasks', 'task-detail', 'register', 'emergency', 'more', 'documents', 'vaccines', 'appointments', 'medications', 'history']);
  const permission = { documents: 'documents:view', vaccines: 'vaccines:view', appointments: 'appointments:view', medications: 'medications:view', history: 'tasks:view' }[page];
  return allowed.has(page) && (!permission || canCurrent(permission));
}
function assertDeviceAction(action) {
  if (!isRestrictedDeviceMode()) return;
  const forbidden = new Set(['microsoft-login','sign-out-microsoft','reconfigure-onedrive','sync-now','open-onedrive','setup-admin-area','open-admin-file','restore-backup','clear-example-data','clear-example-vaccines','add-person','open-person','edit-person','filter-people','toggle-person-active','delete-person','open-caregiver-step','person-documents','manage-person-access','edit-user-access','revoke-user-access','restore-trash','add-growth','edit-growth','delete-growth','print-report','export-backup','export-pending-conflict','discard-pending-conflict','revoke-device']);
  if (forbidden.has(action)) throw new Error('Esta ação não está disponível no Modo Babá.');
  const required = { 'open-task': 'tasks:view', 'toggle-checklist': 'tasks:complete', 'complete-task': 'tasks:complete', 'open-photo': 'photos:attach', 'open-document': 'documents:view', 'open-vaccine': 'vaccines:view', 'open-vaccine-proof': 'vaccines:view', 'edit-vaccine': 'vaccines:edit', 'delete-vaccine': 'vaccines:delete' };
  if (required[action] && !canCurrent(required[action])) throw new Error('Seu perfil não tem permissão para esta ação.');
}
function assertDeviceForm(formId) {
  if (!isRestrictedDeviceMode()) return;
  if (new Set(['onedrive-setup-form','task-form','attachment-form','child-profile-form','person-form','caregiver-form','access-form','growth-form','user-form','migration-form','vaccine-form','vaccine-bulk-photo-form']).has(formId)) throw new Error('Este formulário não está disponível no Modo Babá.');
}

function renderSetup() {
  app.innerHTML = `<main class="fatal"><p class="eyebrow">Configuração inicial</p><h1>Conectar ao OneDrive</h1><p>Informe apenas os identificadores públicos do aplicativo Microsoft. Eles ficam neste navegador; senha e client secret não são usados.</p><form id="onedrive-setup-form" class="form-card"><label>ID do aplicativo cliente<input name="clientId" required autocomplete="off" placeholder="00000000-0000-0000-0000-000000000000"></label><label>ID do diretório/locatário<input name="tenantId" value="organizations" required autocomplete="off"></label><label>Pasta no OneDrive<input name="folderName" value="(APP MARIA ELIS)" required></label><button class="button button--wide" type="submit">Salvar e entrar com Microsoft</button></form></main>`;
}

function renderLogin() {
  app.innerHTML = `<main class="fatal"><p class="eyebrow">Área privada</p><h1>Entrar com Microsoft</h1><p>Ao entrar, o app usa a pasta <strong>${escape(oneDriveConfig.folderName)}</strong> no OneDrive da conta autorizada.</p><button class="button button--wide" data-action="microsoft-login">Entrar com Microsoft</button><button class="text-button" data-action="reconfigure-onedrive">Alterar configuração</button></main>`;
}

async function tryLoadAdminArea(create = false) {
  if ((user?.role || user?.roleId) !== 'admin') { adminData = null; adminAreaStatus = 'restricted'; return false; }
  try {
    adminData = await connectAdminArea({ folderName: DEFAULT_ADMIN_FOLDER, create });
    adminAreaStatus = 'connected';
    return true;
  } catch (error) {
    adminData = null;
    adminAreaStatus = error.code === 'ADMIN_FOLDER_NOT_FOUND' ? 'not-configured' : 'error';
    if (create) throw error;
    return false;
  }
}
function cleanupOrphanCaregiverProfiles() {
  const validPersonIds = new Set((data.people || []).map((person) => person.id));
  const profiles = (data.caregiverProfiles || []).filter((profile) => validPersonIds.has(profile.personId));
  if (profiles.length === (data.caregiverProfiles || []).length) return false;
  data.caregiverProfiles = profiles;
  saveData(data);
  return true;
}
async function purgeExpiredAdminCaregivers() {
  if (!adminData || (user.role || user.roleId) !== 'admin') return false;
  const now = Date.now();
  let changed = false;
  for (const [personId, record] of Object.entries(adminData.caregivers || {})) {
    const purgeAt = Date.parse(record.scheduledPurgeAfter || '');
    if (Number.isFinite(purgeAt) && purgeAt <= now && !personById(personId)) {
      await deleteAdminPath('Documentos/Cuidadores/' + personId);
      delete adminData.caregivers[personId];
      changed = true;
    }
  }
  if (changed) adminData = await saveAdminData(adminData);
  return changed;
}
function mergePrivateExtraction(extracted) {
  const unique = (values) => [...new Map(values.filter((value) => value !== undefined && value !== null && value !== '').map((value) => [JSON.stringify(value), value])).values()];
  for (const [personId, legacy] of Object.entries(extracted.caregivers || {})) {
    const current = adminData.caregivers[personId] || {};
    adminData.caregivers[personId] = {
      ...legacy,
      ...current,
      personalData: { ...(legacy.personalData || {}), ...(current.personalData || {}) },
      employment: { ...(legacy.employment || {}), ...(current.employment || {}) },
      emergencyContact: { ...(legacy.emergencyContact || {}), ...(current.emergencyContact || {}) },
      professionalReferences: unique([...(legacy.professionalReferences || []), ...(current.professionalReferences || [])]),
      documents: unique([...(legacy.documents || []), ...(current.documents || [])]),
      legacyDocuments: unique([...(legacy.legacyDocuments || []), ...(current.legacyDocuments || [])]),
      legacyContracts: unique([...(legacy.legacyContracts || []), ...(current.legacyContracts || [])]),
      migratedAt: new Date().toISOString(),
      migratedBy: user.id
    };
  }
}

function containsEmbeddedDataUrls(value, seen = new WeakSet()) {
  if (typeof value === 'string') return /^data:image\//i.test(value);
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((item) => containsEmbeddedDataUrls(item, seen));
}

function stripEmbeddedDataUrls(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  let changed = false;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && /^data:image\//i.test(item)) { value[key] = ''; changed = true; }
    else if (item && typeof item === 'object' && stripEmbeddedDataUrls(item, seen)) changed = true;
  }
  return changed;
}

async function migrateLegacyPrivateCaregiverData() {
  const scanBackups = Number(data.meta?.privacyMigrationVersion || 0) < 1;
  const currentPrivate = hasLegacyPrivateCaregiverData(data);
  const currentEmbedded = containsEmbeddedDataUrls(data);
  if (!scanBackups && !currentPrivate && !currentEmbedded) return false;
  if ((user.role || user.roleId) !== 'admin') throw new Error('Somente o administrador pode concluir a proteção dos dados antigos.');

  const sanitizedBackups = [];
  const privateExtractions = [];
  if (scanBackups) {
    const files = (await listFiles('Backup')).filter((file) => file.file && /\.json$/i.test(file.name));
    for (const file of files) {
      let backup;
      try { backup = await readJsonFile('Backup/' + file.name); }
      catch { continue; }
      const original = structuredClone(backup);
      migrateSchemaV2(backup);
      const hasPrivate = hasLegacyPrivateCaregiverData(backup);
      const hasEmbedded = containsEmbeddedDataUrls(backup);
      if (!hasPrivate && !hasEmbedded) continue;
      if (!adminData) await tryLoadAdminArea(true);
      await uploadAdminFile('BackupPrivado/' + safeFileName(file.name), new Blob([JSON.stringify(original, null, 2)], { type: 'application/json' }), 'application/json');
      if (hasPrivate) privateExtractions.push(extractLegacyPrivateCaregiverData(backup));
      if (hasEmbedded) stripEmbeddedDataUrls(backup);
      backup.meta = { ...(backup.meta || {}), privacySanitizedAt: new Date().toISOString() };
      sanitizedBackups.push({ path: 'Backup/' + file.name, value: backup, eTag: file.eTag });
    }
  }

  let currentExtraction = null;
  if (currentPrivate) {
    if (!adminData) await tryLoadAdminArea(true);
    currentExtraction = extractLegacyPrivateCaregiverData(data);
    privateExtractions.push(currentExtraction);
  }
  if (currentEmbedded) {
    if (!adminData) await tryLoadAdminArea(true);
    await uploadAdminFile('BackupPrivado/migracao_base64_atual.json', new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'application/json');
  }
  if (privateExtractions.length) {
    for (const extracted of privateExtractions) mergePrivateExtraction(extracted);
  }
  if (adminData && (privateExtractions.length || sanitizedBackups.length || currentEmbedded)) {
    adminData.backupPrivacyScanAt = new Date().toISOString();
    adminData = await saveAdminData(adminData);
  }
  for (const backup of sanitizedBackups) await writeJsonFile(backup.path, backup.value, backup.eTag);
  data.meta = { ...(data.meta || {}), privacyMigrationVersion: 1, privacyMigrationAt: new Date().toISOString() };
  if (currentExtraction?.changed || currentEmbedded) suppressNextCommonBackup = true;
  saveData(data);
  return Boolean(currentExtraction?.changed || currentEmbedded || sanitizedBackups.length);
}

function dataUrlToBlob(dataUrl) {
  const [header, encoded = ''] = String(dataUrl).split(',', 2);
  const mimeType = header.match(/^data:([^;]+)/i)?.[1] || 'image/jpeg';
  const binary = header.includes(';base64') ? atob(encoded) : decodeURIComponent(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

async function migrateEmbeddedImages() {
  if (!containsEmbeddedDataUrls(data)) return false;
  if ((user.role || user.roleId) !== 'admin') throw new Error('Entre com o administrador para migrar as imagens antigas com segurança.');
  if (!adminData) await tryLoadAdminArea(true);
  let changed = false;
  const move = async (record, urlKey, pathKey, path) => {
    const value = record?.[urlKey];
    if (!/^data:image\//i.test(String(value || ''))) return;
    const target = record[pathKey] || path;
    await uploadFile(target, dataUrlToBlob(value), String(value).slice(5).split(';')[0] || 'image/jpeg');
    record[pathKey] = target;
    record[urlKey] = '';
    if ('syncStatus' in record) record.syncStatus = 'synced';
    changed = true;
  };
  await move(data.childProfile, 'photoUrl', 'avatarPath', 'Anexos/Perfil/avatar_migrado.jpg');
  for (const person of data.people || []) await move(person, 'photoUrl', 'photoPath', 'Anexos/Pessoas/' + safeFileName(person.id) + '/foto_migrada.jpg');
  for (const photo of data.dailyPhotos || []) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(photo.date || '') ? photo.date : localDate();
    const [year, month] = date.split('-');
    await move(photo, 'thumbnailUrl', 'filePath', `Fotos/${year}/${month}/${date}_00-00-00_migracao-${safeFileName(photo.id)}.jpg`);
  }
  for (const entry of data.trash || []) {
    if (entry.collection === 'people') await move(entry.record, 'photoUrl', 'photoPath', 'Anexos/Pessoas/' + safeFileName(entry.originalId || entry.record?.id) + '/foto_migrada_lixeira.jpg');
    if (entry.collection === 'dailyPhotos') await move(entry.record, 'thumbnailUrl', 'filePath', 'Fotos/Migracao/' + safeFileName(entry.originalId || entry.record?.id) + '.jpg');
  }
  if (stripEmbeddedDataUrls(data)) changed = true;
  if (changed) { suppressNextCommonBackup = true; saveData(data); }
  return changed;
}
async function setupAdminArea() {
  if ((user?.role || user?.roleId) !== 'admin') return notify('Somente o administrador pode criar a área restrita.', 'error');
  if (!window.confirm('Criar a pasta administrativa separada no seu OneDrive? Não compartilhe essa pasta com a babá ou visitantes.')) return;
  await tryLoadAdminArea(true); document.querySelector('#modal-root').innerHTML = ''; render(); notify('Área administrativa protegida criada.');
}
function renderAdminSettingsCard() {
  if ((user?.role || user?.roleId) !== 'admin') return '';
  if (adminAreaStatus === 'connected') return '<section class="settings-card"><div class="setting-line"><div><strong>Área administrativa</strong><p>CPF, RG, salário e contratos ficam em uma pasta separada e não compartilhada.</p></div><span class="status-pill status-pill--success">Protegida</span></div></section>';
  return '<section class="settings-card"><div class="setting-line"><div><strong>Área administrativa</strong><p>Crie a pasta separada para guardar dados trabalhistas com segurança.</p></div><button class="button button--secondary button--small" data-action="setup-admin-area">Ativar</button></div></section>';
}

function setSyncState(value) {
  syncState = value;
  const badge = document.querySelector('#sync-indicator');
  if (badge) badge.textContent = value;
}

function restrictedDeviceControls() {
  return isRestrictedDeviceMode() ? '<button class="icon-button" data-action="lock-device-now" aria-label="Bloquear agora" title="Bloquear agora">⌑</button><button class="icon-button" data-action="request-admin-mode" aria-label="Trocar usuário" title="Trocar usuário">⋮</button>' : '';
}

function render() {
  const profile = data.childProfile;
  app.innerHTML = `
    <header class="topbar">
      <div class="topbar__identity">
        ${privateImageMarkup(profile.avatarPath, profile.photoUrl || 'assets/icons/child-avatar.svg', 'Avatar da criança', 'topbar__avatar')}
        <div><p class="eyebrow">Cuidado da criança</p><strong>${escape(profile.name)}</strong></div>
      </div>
      <div class="topbar__actions"><button class="icon-button" data-page="more" aria-label="Abrir mais opções" title="Mais opções">☰</button>
        <span id="sync-indicator" class="offline-indicator">${escape(syncState)}</span><span id="offline-indicator" class="offline-indicator" ${navigator.onLine ? 'hidden' : ''}>Offline</span>
        <button class="icon-button" data-action="toggle-theme" aria-label="Alternar tema" title="Alternar tema">◐</button>${restrictedDeviceControls()}
      </div>
    </header>
    <main id="main-content" class="main-content" tabindex="-1">
      ${renderPage()}
    </main>
    ${renderNavigation()}
    <div id="modal-root"></div>
  `;
  hydratePrivateImages().catch(() => {});
}

function renderPage() {
  if (!canOpenPage(currentPage)) return restrictedPage('Área protegida', 'Esta tela não está disponível no Modo Babá.');
  switch (currentPage) {
    case 'home': return renderHome();
    case 'instructions': return renderAfazeres();
    case 'tasks': return renderAfazeres();
    case 'task-detail': return renderTaskDetail();
    case 'history': return renderHistory();
    case 'child-data': return renderChildData();
    case 'users': return renderUsers();
    case 'people': return renderPeople();
    case 'person-detail': return renderPersonDetail();
    case 'trash': return renderTrash();
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

function homeProfileButton() { return isRestrictedDeviceMode() ? '<span class="avatar-button" aria-label="Perfil restrito">' + initials(user.name) + '</span>' : '${homeProfileButton()}'; }
function renderHome() {
  if (!canCurrent('dashboard:view')) return restrictedPage('Hoje', 'Seu perfil não pode abrir o painel.');
  if (!canCurrent('tasks:view')) return `${subPageHeading('Hoje', 'Acesso essencial.')}<section class="settings-card"><h2>Acesso limitado</h2><p>Seu perfil não recebeu acesso aos afazeres. Use Emergência ou Mais para abrir somente os recursos liberados.</p></section>`;
  const today = localDate();
  const tasks = tasksForDate(today);
  const pending = tasks.filter((task) => !isDone(task));
  const completed = tasks.filter(isDone);
  return `
    <section class="page-heading">
      <div><p class="eyebrow">${formatLongDate(today)}</p><h1>Bom dia, ${escape(firstName(user.name))}.</h1><p class="muted">Hoje, ${escape(profile().name)} tem ${tasks.length} afazer(es).</p></div>
      ${homeProfileButton()}
    </section>
    <section class="hero-card hero-card--tasks"><div class="hero-card__copy"><span class="status-pill status-pill--soft">${escape(syncState)}</span><h2>Afazeres do dia</h2><p>${pending.length} pendente(s) e ${completed.length} concluído(s).</p></div>${privateImageMarkup(profile().avatarPath, profile().photoUrl || 'assets/icons/child-avatar.svg', 'Avatar de ' + profile().name, 'hero-card__avatar')}</section>
    <section class="today-actions">${canCurrent('tasks:create') ? `<button class="button button--wide" data-page="register">＋ Adicionar afazer</button>` : ''}<button class="button button--secondary button--wide" data-page="register">◉ Registrar foto/observação</button></section>
    <section class="section-block"><div class="section-title"><div><p class="eyebrow">Agora</p><h2>Pendentes</h2></div><span class="status-pill status-pill--warning">${pending.length}</span></div><div class="task-list">${pending.map(renderDayTask).join('') || emptyState('Nenhum afazer pendente.', 'A rotina de hoje está em dia.', '')}</div></section>
    <section class="section-block"><div class="section-title"><div><p class="eyebrow">Feitos</p><h2>Concluídas</h2></div><span class="status-pill status-pill--success">${completed.length}</span></div><div class="task-list">${completed.map(renderDayTask).join('') || '<p class="muted">As tarefas concluídas aparecerão aqui.</p>'}</div></section>`;
}

function renderAfazeres() {
  if (!canCurrent('tasks:view')) return restrictedPage('Afazeres', 'Seu perfil não pode visualizar afazeres.');
  const tasks = tasksForDate(localDate());
  const pending = tasks.filter((task) => !isDone(task));
  const completed = tasks.filter(isDone);
  return `${subPageHeading('Afazeres do dia', 'Uma lista simples para seguir a rotina.')}${canCurrent('tasks:create') ? `<button class="button button--wide" data-page="register">＋ Adicionar afazer</button>` : ''}<section class="section-block"><div class="section-title"><div><p class="eyebrow">Em ordem de horário</p><h2>Pendentes</h2></div><span class="status-pill status-pill--warning">${pending.length}</span></div><div class="task-list">${pending.map(renderDayTask).join('') || emptyState('Nenhum afazer pendente.', 'Use Adicionar afazer para montar a rotina.', 'register')}</div></section><section class="section-block"><div class="section-title"><div><p class="eyebrow">Concluídas</p><h2>Feitas hoje</h2></div><span class="status-pill status-pill--success">${completed.length}</span></div><div class="task-list">${completed.map(renderDayTask).join('') || '<p class="muted">Nenhum afazer concluído ainda.</p>'}</div></section>`;
}
function renderRegister() {
  if (!canCurrent('tasks:create') && !canCurrent('logs:create') && !canCurrent('photos:attach')) return restrictedPage('Registrar', 'Seu perfil não pode criar registros.');
  const canCreate = canCurrent('tasks:create');
  const types = taskTypes();
  return `${subPageHeading('Registrar', 'Criar a rotina ou registrar como foi o dia.')}
    ${canCreate ? `<section class="settings-card"><div class="section-title"><div><p class="eyebrow">Responsáveis</p><h2>Adicionar afazer</h2></div></div><form id="task-form" class="form-card"><label>Data<input name="date" type="date" value="${localDate()}" required></label><div class="form-grid"><label>Horário<input name="scheduledTime" type="time" value="${currentTime()}" required></label><label>Tipo<select name="taskType">${types.map((type) => `<option value="${type}">${type}</option>`).join('')}</select></label></div><label>Título<input name="title" required placeholder="Ex.: Lanche da manhã"></label><label>Orientação da família<textarea name="familyNote" rows="4" placeholder="Explique o que fazer e os cuidados importantes."></textarea></label><label>Checklist (um item por linha)<textarea name="checklistText" rows="5" placeholder="Lavar as mãos&#10;Preparar o lanche&#10;Tirar foto"></textarea></label><label class="check-row"><input type="checkbox" name="requiresPhoto"> Solicitar foto neste afazer</label><button class="button button--wide" type="submit">Salvar afazer</button></form></section>` : ''}
    <section class="settings-card"><div class="section-title"><div><p class="eyebrow">Babá e responsáveis</p><h2>Registrar foto ou observação</h2></div></div><form id="quick-form" class="form-card"><label>Tipo<select name="type">${types.map((type) => `<option value="${type}">${type}</option>`).join('')}</select></label><label>Horário<input type="time" name="time" value="${currentTime()}" required></label><label>Observação<textarea name="description" rows="3" required placeholder="Conte como foi."></textarea></label>${photoInput()}<button class="button button--secondary button--wide" type="submit">Salvar registro</button></form></section>`;
}
function renderEmergency() {
  if (!canCurrent('emergency:view')) return restrictedPage('Emergência', 'Seu perfil não pode abrir os contatos de emergência.');
  const selectedIds = new Set(profile().emergencyPersonIds || []);
  let contacts = activePeople().filter((person) => selectedIds.size ? selectedIds.has(person.id) : isEmergencyPerson(person));
  if (!contacts.length && !selectedIds.size) contacts = (data.emergencyContacts || []).map((contact) => ({ id: contact.id, fullName: contact.name, relationship: contact.relationship, phone: contact.phone, whatsapp: contact.whatsapp, priority: contact.priority, primaryType: 'emergency-contact', types: ['emergency-contact'] }));
  contacts.sort((a, b) => Number(a.priority || 99) - Number(b.priority || 99));
  const pediatrician = personById(profile().pediatricianPersonId) || activePeople().find((person) => person.primaryType === 'pediatrician');
  if (!selectedIds.size && pediatrician && !contacts.some((person) => person.id === pediatrician.id)) contacts.push(pediatrician);
  return `${subPageHeading('Emergência', 'O essencial para agir rápido.')}<section class="critical-card emergency-critical"><div class="critical-card__wide"><span>Alergias</span><strong>${escape((profile().allergies || []).join(', ') || 'Não informado')}</strong></div><div class="critical-card__wide"><span>Cuidados e medicamentos importantes</span><strong>${escape(profile().criticalNotes || 'Não informado')}</strong></div><div><span>Convênio</span><strong>${escape(profile().healthPlan || 'Não informado')}</strong></div><div><span>Tipo sanguíneo</span><strong>${escape(profile().bloodType || 'Não informado')}</strong></div></section><section class="emergency-grid">${contacts.filter((person) => person.phone).map((person) => `<a class="emergency-action" href="tel:${phoneHref(person.phone)}"><strong>${escape(person.relationship || personTypeLabel(person.primaryType))}</strong><small>${escape(person.fullName)}</small><span>☎</span></a>`).join('')}<a class="emergency-action emergency-action--urgent" href="tel:192"><strong>Emergência médica</strong><small>Ligar para o SAMU</small><span>☎</span></a></section><section class="emergency-banner"><span>⚕</span><div><h2>Risco imediato?</h2><p>Ligue para o serviço de emergência. Este app não substitui atendimento médico.</p></div></section><section class="settings-card"><div class="setting-line"><div><strong>Endereço da criança</strong><p>${escape(profile().address || 'Não informado')}</p></div>${profile().address ? `<a class="button button--secondary button--small" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(profile().address)}" target="_blank" rel="noopener">Rota</a>` : ''}</section>`;
}
function renderMore() {
  const items = [
    ['people', '◉', 'Pessoas', 'Família, cuidadores e profissionais'],
    ['documents', '▣', 'Documentos', 'Arquivos privados'], ['vaccines', '◈', 'Vacinas', 'Histórico e comprovantes'],
    ['appointments', '◷', 'Consultas', 'Agenda e retornos'], ['growth', '↗', 'Crescimento', 'Peso e altura'],
    ['medications', '✚', 'Medicamentos fixos', 'Uso contínuo'], ['child-data', '♥', 'Dados da criança', 'Perfil, saúde e endereço'],
    ['users', '⚿', 'Usuários e permissões', 'Quem pode entrar no app'], ['migration', '⇪', 'Importar dados antigos', 'Migração e relatório'],
    ['settings', '⚙', 'Configurações', 'OneDrive, backup e acesso']
  ];
  if (canCurrent('people:manage') && (data.trash || []).length) items.push(['trash', '⌫', 'Lixeira', 'Restaurar itens por 30 dias']);
  return `${subPageHeading('Mais', 'Recursos organizados por assunto.')}<section class="menu-list">${items.filter(([page]) => canOpenPage(page)).map(([page, icon, title, copy]) => `<button class="menu-item" data-page="${page}"><span class="menu-item__icon">${icon}</span><span><strong>${title}</strong><small>${copy}</small></span><span class="chevron">›</span></button>`).join('')}</section>`;
}

function documentVisibleToCurrent(item) {
  if (!isRestrictedDeviceMode()) return true;
  return item?.caregiverVisible === true || item?.allowedRoles?.includes('caregiver') || item?.allowedPersonIds?.includes(user?.personId) || item?.allowedUserIds?.includes(user?.id);
}
function canOpenDocumentPath(path) {
  return (data.documents || []).some((item) => item.filePath === path && documentVisibleToCurrent(item));
}
function renderDocuments() {
  const allowed = canCurrent('documents:view');
  if (!allowed) return restrictedPage('Documentos', 'Documentos e resultados clínicos são restritos por padrão para cuidadores e visitantes.');
  const canUpload = canCurrent('documents:create');
  const records = (data.documents || []).filter(documentVisibleToCurrent);
  return `${subPageHeading('Documentos', 'Anexos privados organizados no OneDrive.')}
    ${canUpload ? `<section class="settings-card"><h2>Adicionar documento</h2><form id="attachment-form" class="form-card"><label>Título<input name="title" required placeholder="Ex.: Carteira de vacinação"></label><label>Categoria<select name="category"><option>Saúde</option><option>Documentos pessoais</option><option>Escola</option><option>Outros</option></select></label><label>Arquivo<input name="attachment" type="file" required></label><label>Observação<textarea name="description" rows="2" placeholder="Opcional"></textarea></label><label class="check-row"><input type="checkbox" name="caregiverVisible"> Liberar este documento no Modo Babá</label><button class="button button--wide" type="submit">Enviar para o OneDrive</button></form></section>` : ''}
    <p class="privacy-inline">🔒 Os arquivos reais permanecem em <strong>Anexos/</strong> no OneDrive. O repositório não recebe documentos ou fotos.</p>
    <div class="record-list">${records.map((document) => `<article class="record-card"><span class="record-icon">▣</span><div><span class="status-pill status-pill--soft">${escape(document.category)}</span><h2>${escape(document.title)}</h2><p>${escape(document.description || 'Sem observação.')}</p><small>${document.filePath ? escape(document.filePath) : document.expirationDate ? `Validade: ${formatDate(document.expirationDate)}` : 'Sem arquivo anexado'}</small></div>${document.filePath ? `<button class="icon-button" data-action="open-document" data-path="${escape(document.filePath)}" aria-label="Abrir ${escape(document.title)}">›</button>` : ''}</article>`).join('') || emptyState('Nenhum documento cadastrado.', 'Envie o primeiro arquivo privado.', '')}</div>`;
}
function renderVaccines() {
  const allowed = canCurrent('vaccines:view');
  if (!allowed) return restrictedPage('Vacinas', 'O histórico de vacinação é visível somente para responsáveis autorizados.');
  const canCreate = canCurrent('vaccines:create');
  const canEdit = canCurrent('vaccines:edit');
  const records = [...(data.vaccines || [])].sort((a, b) => String(b.appliedDate || b.expectedDate || '').localeCompare(String(a.appliedDate || a.expectedDate || '')));
  return `${subPageHeading('Vacinas', 'Toque em uma vacina para abrir todos os dados e comprovantes.')}
    ${canCreate ? `<section class="settings-card"><div class="section-title"><div><p class="eyebrow">Responsáveis</p><h2>Adicionar vacina</h2></div></div><form id="vaccine-form" class="form-card"><label>Data da aplicação<input name="appliedDate" type="date" value="${localDate()}" required></label><div class="form-grid"><label>Vacina<input name="name" required placeholder="Ex.: Varicela"></label><label>Dose<input name="dose" required placeholder="Ex.: 2º ou Reforço"></label></div><div class="form-grid"><label>Lote<input name="batch" placeholder="Se disponível"></label><label>Local<input name="location" placeholder="Posto ou clínica"></label></div><label>Observação<textarea name="notes" rows="2"></textarea></label><label>Comprovantes/fotos (pode escolher várias)<input name="proofs" type="file" accept="image/*,application/pdf" multiple></label><button class="button button--wide" type="submit">Salvar vacina</button></form></section>` : ''}
    ${canEdit ? `<section class="settings-card"><h2>Anexar as fotos já organizadas</h2><p class="muted">Selecione todas as fotos da pasta de vacinas de uma vez. O app identifica vacina e dose pelo nome do arquivo e aceita duas ou mais fotos por registro.</p><form id="vaccine-bulk-photo-form" class="form-card"><label>Selecionar a pasta inteira “comprovantes”<input name="vaccineProofDirectory" type="file" accept="image/*,application/pdf" webkitdirectory directory multiple></label><label>Ou selecionar várias fotos<input name="vaccineProofFiles" type="file" accept="image/*,application/pdf" multiple></label><button class="button button--secondary button--wide" type="submit">Importar e relacionar fotos</button></form></section>` : ''}
    <section class="section-block"><div class="section-title"><div><p class="eyebrow">${records.length} registro(s)</p><h2>Histórico</h2></div></div><div class="record-list">${records.map((vaccine) => { const proofs = vaccine.proofFilePaths || []; return `<article class="record-card record-card--interactive"><span class="record-icon">◈</span><button class="record-card__main" data-action="open-vaccine" data-id="${vaccine.id}" aria-label="Abrir detalhes de ${escape(vaccine.name)}"><span class="status-pill ${statusClass(vaccine.status || 'applied')}">${statusLabel(vaccine.status || 'applied')}</span><h2>${escape(vaccine.name)}</h2><p>${escape(vaccine.dose)} · ${vaccine.appliedDate ? formatDate(vaccine.appliedDate) : 'Data não informada'}</p><small>${vaccine.batch ? `Lote: ${escape(vaccine.batch)}` : 'Lote não informado'} · ${proofs.length} comprovante(s)</small></button><span class="chevron">›</span></article>`; }).join('') || emptyState('Nenhuma vacina cadastrada.', 'Adicione ou importe o histórico privado.', '')}</div></section>`;
}

function renderVaccineDetail() {
  if (!canCurrent('vaccines:view')) return restrictedPage('Vacinas', 'Seu perfil não pode visualizar vacinas.');
  const vaccine = (data.vaccines || []).find((item) => item.id === selectedVaccineId);
  if (!vaccine) { currentPage = 'vaccines'; return renderVaccines(); }
  const canEdit = canCurrent('vaccines:edit');
  const canDelete = canCurrent('vaccines:delete');
  const proofs = vaccine.proofFilePaths || [];
  return `<section class="page-heading page-heading--sub"><button class="back-button" data-page="vaccines" aria-label="Voltar">‹</button><div><p class="eyebrow">${vaccine.appliedDate ? formatDate(vaccine.appliedDate) : 'Data não informada'}</p><h1>${escape(vaccine.name)}</h1><p class="muted">${escape(vaccine.dose)}</p></div></section>
    <section class="task-detail-card vaccine-detail-card"><span class="status-pill ${statusClass(vaccine.status || 'applied')}">${statusLabel(vaccine.status || 'applied')}</span><dl class="detail-list"><div><dt>Data</dt><dd>${vaccine.appliedDate ? formatDate(vaccine.appliedDate) : 'Não informada'}</dd></div><div><dt>Dose</dt><dd>${escape(vaccine.dose || 'Não informada')}</dd></div><div><dt>Lote</dt><dd>${escape(vaccine.batch || 'Não informado')}</dd></div><div><dt>Local</dt><dd>${escape(vaccine.location || 'Não informado')}</dd></div><div><dt>Observações</dt><dd>${escape(vaccine.notes || 'Nenhuma observação')}</dd></div></dl></section>
    <section class="section-block"><div class="section-title"><div><p class="eyebrow">${proofs.length} arquivo(s)</p><h2>Fotos e comprovantes</h2></div></div><div class="proof-grid">${proofs.map((proof, index) => `<button class="proof-card" data-action="open-vaccine-proof" data-path="${escape(proof)}"><span>▧</span><strong>Comprovante ${index + 1}</strong><small>Abrir arquivo</small></button>`).join('') || emptyState('Nenhuma foto anexada.', 'Use Editar vacina ou a importação em lote para incluir duas ou mais fotos.', '')}</div></section>
    ${canEdit || canDelete ? `<section class="task-management">${canEdit ? `<button class="text-button" data-action="edit-vaccine" data-id="${vaccine.id}">Editar e anexar fotos</button>` : ''}${canDelete ? `<button class="text-button text-button--danger" data-action="delete-vaccine" data-id="${vaccine.id}">Apagar vacina</button>` : ''}</section>` : ''}`;
}
function renderAppointments() {
  const allowed = canCurrent('appointments:view');
  if (!allowed) return restrictedPage('Consultas', 'Consultas e orientações médicas são restritas por padrão para cuidadores e visitantes.');
  return `${subPageHeading('Consultas', 'Agenda, histórico e próximos retornos.')}
    <div class="record-list">${[...data.appointments].sort((a, b) => b.date.localeCompare(a.date)).map((appointment) => `<article class="record-card"><span class="record-icon">◷</span><div><span class="status-pill ${statusClass(appointment.status)}">${statusLabel(appointment.status)}</span><h2>${escape(appointment.specialty)}</h2><p>${escape(appointment.doctorName)} · ${formatDate(appointment.date)} às ${escape(appointment.time)}</p><small>${escape(appointment.reason)}</small>${appointment.nextReturnDate ? `<small class="record-detail">Retorno: ${formatDate(appointment.nextReturnDate)}</small>` : ''}</div></article>`).join('')}</div>`;
}

function renderGrowth() {
  const allowed = canCurrent('growth:view');
  if (!allowed) return restrictedPage('Crescimento', 'Dados de crescimento são restritos por padrão.');
  const canManage = canCurrent('growth:create');
  const records = [...(data.growthRecords || [])].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const last = records.at(-1);
  return `${subPageHeading('Crescimento', 'Medidas reais, sem exemplos automáticos.')}${canManage ? '<button class="button button--wide" data-action="add-growth">＋ Adicionar medida</button>' : ''}${last ? `<section class="metric-row"><article class="metric-card"><strong>${Number(last.weight || 0).toFixed(1)} kg</strong><span>peso mais recente</span></article><article class="metric-card"><strong>${Number(last.height || 0).toFixed(0)} cm</strong><span>altura mais recente</span></article><article class="metric-card"><strong>${Number(last.bmi || 0).toFixed(1)}</strong><span>IMC</span></article></section>` : emptyState('Nenhuma medida cadastrada.', 'Adicione a primeira medida real, inclusive retroativa.', '')}${records.length ? `<section class="chart-card"><div class="section-title"><div><p class="eyebrow">Todo o período</p><h2>Evolução de peso</h2></div></div>${lineChart(records, { label: 'Evolução do peso', valueKey: 'weight', formatter: (value) => Number(value).toFixed(1) + ' kg' })}</section><section class="chart-card"><div class="section-title"><div><p class="eyebrow">Todo o período</p><h2>Evolução de altura</h2></div></div>${lineChart(records, { label: 'Evolução da altura', valueKey: 'height', formatter: (value) => Number(value).toFixed(0) + ' cm' })}</section><section class="section-block"><div class="section-title"><div><p class="eyebrow">${records.length} registro(s)</p><h2>Medidas</h2></div></div><div class="record-list">${[...records].reverse().map((record) => `<article class="record-card"><span class="record-icon">↗</span><div><h2>${formatDate(record.date)}</h2><p>${Number(record.weight || 0).toFixed(1)} kg · ${Number(record.height || 0).toFixed(0)} cm · IMC ${Number(record.bmi || 0).toFixed(1)}</p><small>${escape(record.source || 'Origem não informada')}${record.notes ? ' · ' + escape(record.notes) : ''}</small></div>${canManage ? `<div class="record-card__actions"><button class="icon-button" data-action="edit-growth" data-id="${record.id}">✎</button><button class="icon-button" data-action="delete-growth" data-id="${record.id}">×</button></div>` : ''}</article>`).join('')}</div></section>` : ''}`;
}

function openGrowthEditor(id = '') {
  if (!canCurrent('growth:create')) return notify('Seu perfil não pode alterar medidas.', 'error');
  const record = id ? (data.growthRecords || []).find((item) => item.id === id) : null;
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()"><button class="modal__close" data-action="close-modal">×</button><h2>${record ? 'Editar medida' : 'Adicionar medida'}</h2><form id="growth-form"><input type="hidden" name="growthId" value="${escape(record?.id || '')}"><label>Data<input name="date" type="date" value="${escape(record?.date || localDate())}" required></label><div class="form-grid"><label>Peso (kg)<input name="weight" inputmode="decimal" value="${escape(record?.weight ?? '')}" required></label><label>Altura (cm)<input name="height" inputmode="decimal" value="${escape(record?.height ?? '')}" required></label></div><label>Perímetro cefálico (cm)<input name="headCircumference" inputmode="decimal" value="${escape(record?.headCircumference ?? '')}"></label><label>Origem<select name="source">${['Casa','Pediatra','Nutricionista','Outro especialista','Hospital','Posto de saúde','Escola','Outro'].map((source) => `<option value="${source}" ${record?.source === source ? 'selected' : ''}>${source}</option>`).join('')}</select></label><label>Observação<textarea name="notes" rows="3">${escape(record?.notes || '')}</textarea></label><button class="button button--wide" type="submit">Salvar medida</button></form><p class="permission-note">O app registra medidas; não cria diagnóstico médico.</p></section></div>`;
}

function saveGrowth(form) {
  if (!canCurrent('growth:create')) throw new Error('Seu perfil não pode alterar medidas.');
  const values = new FormData(form); const id = String(values.get('growthId') || '');
  const weight = Number(String(values.get('weight') || '').replace(',', '.')); const height = Number(String(values.get('height') || '').replace(',', '.'));
  if (!(weight > 0) || !(height > 0)) throw new Error('Informe peso e altura válidos.');
  const bmi = weight / ((height / 100) ** 2);
  const headText = String(values.get('headCircumference') || '').replace(',', '.');
  const record = { date: String(values.get('date')), weight, height, bmi, headCircumference: headText ? Number(headText) : null, source: String(values.get('source') || 'Outro'), notes: String(values.get('notes') || '').trim() };
  if (id) updateRecord('growthRecords', id, record, user.id); else addRecord('growthRecords', record, user.id);
  document.querySelector('#modal-root').innerHTML = ''; render(); notify(id ? 'Medida atualizada.' : 'Medida adicionada.');
}

function deleteGrowth(id) {
  if (!canCurrent('growth:delete')) return notify('Seu perfil não pode apagar medidas.', 'error');
  const record = (data.growthRecords || []).find((item) => item.id === id); if (!record) return;
  if (!window.confirm('Mover a medida de ' + formatDate(record.date) + ' para a lixeira?')) return;
  moveToTrash('growthRecords', id, 'Medida de ' + formatDate(record.date)); render(); notify('Medida movida para a lixeira.');
}

function renderMedications() {
  const allowed = canCurrent('medications:view');
  if (!allowed) return restrictedPage('Medicamentos', 'A lista de medicamentos é restrita por padrão para cuidadores e visitantes.');
  return `${subPageHeading('Medicamentos', 'Uso previsto, confirmação e histórico.')}
    <div class="record-list">${data.medications.map((medication) => `<article class="record-card"><span class="record-icon">✚</span><div><span class="status-pill ${statusClass(medication.status)}">${statusLabel(medication.status)}</span><h2>${escape(medication.name)}</h2><p>${escape(medication.dosage)} · ${escape(medication.schedule)}</p><small>${escape(medication.notes)}</small></div></article>`).join('') || emptyState('Nenhum medicamento ativo.', '', '')}</div>
    <p class="privacy-inline">Apenas informações confirmadas por um profissional devem ser cadastradas.</p>`;
}

function renderRoutine() {
  return renderHistory();
}

function renderHistory() {
  if (!canCurrent('tasks:view')) return restrictedPage('Histórico', 'Seu perfil não pode visualizar o histórico de afazeres.');
  const filtered = tasksForHistory();
  return `${subPageHeading('Histórico', 'Afazeres, fotos e observações.')}
    <form id="history-filter-form" class="filter-panel"><label>Período<select name="period"><option value="today" ${historyFilter.period === 'today' ? 'selected' : ''}>Hoje</option><option value="yesterday" ${historyFilter.period === 'yesterday' ? 'selected' : ''}>Ontem</option><option value="week" ${historyFilter.period === 'week' ? 'selected' : ''}>Esta semana</option><option value="date" ${historyFilter.period === 'date' ? 'selected' : ''}>Escolher data</option></select></label><label>Data<input type="date" name="date" value="${historyFilter.date}"></label><label>Tipo<select name="type"><option value="">Todos</option>${taskTypes().map((type) => `<option value="${type}" ${historyFilter.type === type ? 'selected' : ''}>${type}</option>`).join('')}</select></label><button class="button button--secondary" type="submit">Filtrar</button></form>
    <section class="section-block"><div class="section-title"><div><p class="eyebrow">${filtered.length} resultado(s)</p><h2>Afazeres</h2></div></div><div class="task-list">${filtered.map(renderDayTask).join('') || emptyState('Nenhum afazer encontrado.', 'Ajuste o filtro ou crie um afazer.', 'register')}</div></section>`;
}

function renderDeviceAdminCard() {
  const binding = getDeviceBinding();
  if ((user?.role || user?.roleId) !== 'admin' || !binding) return '';
  const person = personById(binding.personId);
  return '<section class="settings-card"><div class="setting-line"><div><strong>Dispositivo vinculado</strong><p>' + escape(person?.fullName || binding.displayName || 'Usuária') + ' usa o Modo Babá neste aparelho.</p></div><button class="button button--danger button--small" data-action="revoke-device">Revogar</button></div></section>';
}
function revokeCurrentDevice() {
  if ((user?.role || user?.roleId) !== 'admin') throw new Error('Somente o administrador pode revogar este dispositivo.');
  const binding = getDeviceBinding();
  if (!binding) return notify('Não há dispositivo vinculado.', 'warning');
  const access = (data.users || []).find((item) => item.personId === binding.personId);
  if (access) updateRecord('users', access.id, { deviceEnabled: false, deviceRevokedAt: new Date().toISOString() }, user.id);
  const person = personById(binding.personId);
  if (person) updateRecord('people', person.id, { deviceEnabled: false }, user.id);
  clearDeviceBinding(); deviceBinding = null; selectedDevicePersonId = '';
  notify('Dispositivo revogado. A pessoa não poderá desbloquear este aparelho.');
  render();
}
function renderSettings() {
  if (isRestrictedDeviceMode()) return restrictedPage('Configurações', 'Configurações técnicas são exclusivas do administrador.');
  return `${subPageHeading('Configurações', 'OneDrive, backup e acesso da família.')}
    <section class="settings-card"><div class="setting-line"><div><strong>Conta conectada</strong><p>${escape(renderConnectionStatus(microsoftAccount, oneDriveConfig.folderName))}</p></div><span class="status-pill status-pill--success">${escape(syncState)}</span></div></section>
    <section class="settings-card"><div class="setting-line"><div><strong>Dados da criança</strong><p>Nome, alergias, contatos e observações fixas.</p></div><button class="button button--secondary button--small" data-page="child-data">Editar</button></div></section>
${renderAdminSettingsCard()}${renderDeviceAdminCard()}
    <section class="settings-card"><div class="setting-line"><div><strong>Sincronização</strong><p>Salva dados e tenta enviar fotos pendentes.</p></div><button class="button button--secondary button--small" data-action="sync-now">Sincronizar</button></div></section>
    ${(user.role || user.roleId) === 'admin' ? '<section class="settings-card"><div class="setting-line"><div><strong>Backup</strong><p>Backup diário no OneDrive.</p></div><button class="button button--secondary button--small" data-action="restore-backup">Restaurar</button></div></section>' : ''}
    <section class="settings-card"><div class="setting-line"><div><strong>Pasta privada</strong><p>${escape(oneDriveConfig.folderName)}</p></div><button class="button button--secondary button--small" data-action="open-onedrive">Abrir</button></div></section>
    ${(user.role || user.roleId) === 'admin' ? '<section class="settings-card"><div class="setting-line"><div><strong>Dados de exemplo</strong><p>Verifique e remova qualquer registro fictício remanescente.</p></div><button class="button button--secondary button--small" data-action="clear-example-data">Verificar</button></div></section>' : ''}
    <section class="settings-card"><div class="setting-line"><div><strong>Conta Microsoft</strong><p>Sair somente deste navegador.</p></div><button class="button button--danger button--small" data-action="sign-out-microsoft">Sair</button></div></section>`;
}
function renderNavigation() {
  const tabs = [];
  if (canCurrent('dashboard:view')) tabs.push(['home', '⌂', 'Hoje']);
  if (canCurrent('tasks:view')) tabs.push(['tasks', '☑', 'Afazeres']);
  if (canCurrent('tasks:create') || canCurrent('logs:create') || canCurrent('photos:attach')) tabs.push(['register', '＋', 'Registrar']);
  if (canCurrent('emergency:view')) tabs.push(['emergency', '⚕', 'Emergência']);
  tabs.push(['more', '☰', 'Mais']);
  return `<nav class="bottom-nav" aria-label="Navegação principal">${tabs.map(([page, icon, label]) => `<button class="nav-item ${currentPage === page || (page === 'tasks' && currentPage === 'task-detail') ? 'nav-item--active' : ''} ${page === 'register' ? 'nav-item--primary' : ''}" data-page="${page}" aria-current="${currentPage === page ? 'page' : 'false'}"><span>${icon}</span><small>${label}</small></button>`).join('')}</nav>`;
}
function renderDayTask(task) {
  const complete = isDone(task);
  const photos = (data.dailyPhotos || []).filter((photo) => photo.taskId === task.id);
  return `<article class="day-task ${complete ? 'day-task--done' : ''}"><button class="day-task__main" data-action="open-task" data-id="${task.id}"><time>${escape(task.scheduledTime || '--:--')}</time><span><strong>${escape(task.title)}</strong><small>${escape(task.taskType || task.category || 'Outro')}${task.familyNote ? ` · ${escape(task.familyNote)}` : ''}</small></span></button><div class="day-task__actions">${photos.length ? '<span title="Foto enviada">◉</span>' : ''}${!complete && canCurrent('photos:attach') ? `<button class="icon-button" data-action="open-photo" data-task-id="${task.id}" aria-label="Adicionar foto">◉</button>` : ''}${!complete && canCurrent('tasks:complete') ? `<button class="complete-button" data-action="complete-task" data-id="${task.id}" aria-label="Marcar como feito">✓</button>` : complete ? '<span class="done-mark">✓</span>' : ''}</div>${complete ? `<p class="day-task__done">Feito ${task.completedAt ? `às ${escape(task.completedAt.slice(11, 16))}` : ''}${task.caregiverNote ? ` · ${escape(task.caregiverNote)}` : ''}</p>` : ''}</article>`;
}

function renderTaskDetail() {
  if (!canCurrent('tasks:view')) return restrictedPage('Afazer', 'Seu perfil não pode visualizar afazeres.');
  const task = data.dailyTasks.find((item) => item.id === selectedTaskId);
  if (!task) return `${subPageHeading('Afazer', 'O afazer não foi encontrado.')}${emptyState('Afazer indisponível', 'Volte para a lista de hoje.', 'tasks')}`;
  const checklist = normalizedChecklist(task);
  const photos = (data.dailyPhotos || []).filter((photo) => photo.taskId === task.id);
  const canWork = canCurrent('tasks:complete') || canCurrent('logs:create');
  const canManage = canCurrent('tasks:create');
  return `<section class="page-heading page-heading--sub"><button class="back-button" data-page="tasks" aria-label="Voltar">‹</button><div><p class="eyebrow">${formatDate(task.date)} · ${escape(task.scheduledTime || '--:--')}</p><h1>${escape(task.title)}</h1><p class="muted">${escape(task.taskType || task.category || 'Outro')}</p></div></section>
    <section class="task-detail-card"><span class="status-pill ${isDone(task) ? 'status-pill--success' : 'status-pill--warning'}">${isDone(task) ? 'Concluído' : 'Pendente'}</span><h2>Orientação da família</h2><p>${escape(task.familyNote || task.description || 'Sem orientação adicional.')}</p>${task.requiresPhoto ? '<p class="task-detail-hint">Foto solicitada para este afazer.</p>' : ''}</section>
    <section class="section-block"><div class="section-title"><div><p class="eyebrow">Passo a passo</p><h2>Checklist</h2></div></div>${checklist.length ? `<div class="checklist">${checklist.map((item, index) => `<label class="checklist__item"><input type="checkbox" data-action="toggle-checklist" data-task-id="${task.id}" data-index="${index}" ${item.checked ? 'checked' : ''} ${canWork ? '' : 'disabled'}><span>${escape(item.label)}</span></label>`).join('')}</div>` : '<p class="muted">Sem checklist para este afazer.</p>'}</section>
    <section class="section-block"><div class="section-title"><div><p class="eyebrow">Registro de quem executou</p><h2>Observação da babá</h2></div></div><form id="task-note-form" class="form-card"><input type="hidden" name="taskId" value="${task.id}"><label>Como foi?<textarea name="caregiverNote" rows="4" ${canWork ? '' : 'disabled'} placeholder="Ex.: comeu bem, dormiu às 13:10.">${escape(task.caregiverNote || '')}</textarea></label><button class="button button--secondary button--wide" type="submit" ${canWork ? '' : 'disabled'}>Salvar observação</button></form></section>
    ${photos.length ? `<section class="section-block"><div class="section-title"><div><p class="eyebrow">Registro visual</p><h2>Fotos</h2></div></div><div class="photo-strip">${photos.map(renderPhoto).join('')}</div></section>` : ''}
    <section class="task-detail-actions">${canCurrent('photos:attach') ? `<button class="button button--secondary button--wide" data-action="open-photo" data-task-id="${task.id}">◉ Adicionar foto</button>` : ''}${!isDone(task) && canCurrent('tasks:complete') ? `<button class="button button--wide" data-action="complete-task" data-id="${task.id}">✓ Marcar como feito</button>` : ''}</section>
    ${isDone(task) ? `<section class="completion-card"><strong>Concluído</strong><p>${task.completedAt ? formatDateTime(task.completedAt) : ''} · ${escape(userName(task.completedBy))}</p></section>` : ''}
    ${canManage ? `<section class="task-management"><button class="text-button" data-action="edit-task" data-id="${task.id}">Editar afazer</button><button class="text-button text-button--danger" data-action="delete-task" data-id="${task.id}">Apagar afazer</button></section>` : ''}`;
}

function renderChildData() {
  if (!canCurrent('child:view')) return restrictedPage('Dados da criança', 'Seu perfil não pode abrir os dados da criança.');
  const canEdit = canCurrent('child:edit');
  const child = profile();
  const pediatricians = activePeople().filter((person) => person.types?.some((type) => ['pediatrician', 'doctor', 'specialist'].includes(type)));
  const emergencyIds = new Set(child.emergencyPersonIds || []);
  return `${subPageHeading('Dados da criança', 'Perfil, saúde e endereço em blocos simples.')}
    <form id="child-profile-form" class="form-card">
      <section class="form-section"><h2>1. Perfil</h2><div class="profile-photo-row">${privateImageMarkup(child.avatarPath, child.photoUrl || 'assets/icons/child-avatar.svg', 'Foto atual da criança')}<div><strong>Foto do perfil</strong><p>Escolha uma foto e ajuste o enquadramento.</p></div></div><label>Nome<input name="name" value="${escape(child.name || '')}" ${canEdit ? '' : 'disabled'} required></label><label>Data de nascimento<input name="birthDate" type="date" value="${escape(child.birthDate || '')}" ${canEdit ? '' : 'disabled'}></label><label>Escolher nova foto<input name="avatar" type="file" accept="image/*" ${canEdit ? '' : 'disabled'}></label><p id="avatar-crop-status" class="permission-note">Depois de escolher, o editor de enquadramento será aberto.</p></section>
      <section class="form-section"><h2>2. Saúde essencial</h2><label>Alergias (separadas por vírgula)<textarea name="allergies" rows="2" ${canEdit ? '' : 'disabled'}>${escape((child.allergies || []).join(', '))}</textarea></label><label>Medicamentos e cuidados importantes<textarea name="criticalNotes" rows="3" ${canEdit ? '' : 'disabled'}>${escape(child.criticalNotes || '')}</textarea></label><div class="form-grid"><label>Convênio<input name="healthPlan" value="${escape(child.healthPlan || '')}" ${canEdit ? '' : 'disabled'}></label><label>Tipo sanguíneo<input name="bloodType" value="${escape(child.bloodType || '')}" ${canEdit ? '' : 'disabled'}></label></div><label>Pediatra principal<select name="pediatricianPersonId" ${canEdit ? '' : 'disabled'}><option value="">Não selecionado</option>${pediatricians.map((person) => `<option value="${person.id}" ${child.pediatricianPersonId === person.id ? 'selected' : ''}>${escape(person.fullName)}</option>`).join('')}</select></label><fieldset class="choice-field"><legend>Contatos que aparecem em Emergência</legend>${activePeople().filter(isEmergencyPerson).map((person) => `<label class="check-row"><input type="checkbox" name="emergencyPersonIds" value="${person.id}" ${emergencyIds.has(person.id) ? 'checked' : ''} ${canEdit ? '' : 'disabled'}> ${escape(person.fullName)} · ${escape(person.relationship || personTypeLabel(person.primaryType))}</label>`).join('') || '<p class="muted">Cadastre contatos no menu Pessoas.</p>'}</fieldset></section>
      <section class="form-section"><h2>3. Endereço</h2><label>Endereço da criança<input name="address" value="${escape(child.address || '')}" ${canEdit ? '' : 'disabled'}></label></section>
      <button class="button button--wide" type="submit" ${canEdit ? '' : 'disabled'}>Salvar dados da criança</button>
    </form>`;
}

function renderPeople() {
  if (!canCurrent('people:view')) return restrictedPage('Pessoas', 'Seu perfil não pode abrir o cadastro de pessoas.');
  const canManage = canCurrent('people:manage');
  const visible = canManage ? (data.people || []) : (data.people || []).filter(personVisibleToCurrent);
  const records = visible.filter((person) => peopleFilter === 'all' || person.active !== false).sort((a, b) => String(a.fullName || '').localeCompare(String(b.fullName || ''), 'pt-BR'));
  return `${subPageHeading('Pessoas', 'Família, cuidadores, profissionais e contatos em um só lugar.')}
    <section class="people-toolbar"><div class="segmented"><button class="segmented__item ${peopleFilter === 'active' ? 'is-active' : ''}" data-action="filter-people" data-filter="active">Ativos</button><button class="segmented__item ${peopleFilter === 'all' ? 'is-active' : ''}" data-action="filter-people" data-filter="all">Todos</button></div>${canManage ? '<button class="button" data-action="add-person">＋ Pessoa</button>' : ''}</section>
    <div class="record-list">${records.map(renderPersonCard).join('') || emptyState('Nenhuma pessoa cadastrada.', 'Comece por mãe, pai, cuidador ou pediatra.', '')}</div>
    ${canManage && (data.trash || []).some((item) => item.collection === 'people') ? '<button class="text-button" data-page="trash">Abrir lixeira</button>' : ''}`;
}

function renderPersonCard(person) {
  const picture = person.photoPath ? privateImageMarkup(person.photoPath, person.photoUrl || 'assets/icons/child-avatar.svg', 'Foto de ' + (person.fullName || 'pessoa')) : person.photoUrl ? `<img src="${escape(person.photoUrl)}" alt="">` : `<span>${personTypeIcon(person.primaryType)}</span>`;
  return `<article class="person-card ${person.active === false ? 'person-card--inactive' : ''}"><button class="person-card__main" data-action="open-person" data-id="${person.id}"><span class="person-avatar">${picture}</span><span><strong>${escape(person.fullName || 'Sem nome')}</strong><small>${escape(person.relationship || personTypeLabel(person.primaryType))}${person.active === false ? ' · inativo' : ''}</small></span><b>›</b></button><div class="person-card__quick">${person.phone ? `<a href="tel:${phoneHref(person.phone)}" aria-label="Ligar para ${escape(person.fullName)}">☎</a>` : ''}${person.whatsapp || person.phone ? `<a href="https://wa.me/${phoneHref(person.whatsapp || person.phone)}" target="_blank" rel="noopener" aria-label="Abrir WhatsApp de ${escape(person.fullName)}">◌</a>` : ''}</div></article>`;
}

function renderPersonDetail() {
  const person = (data.people || []).find((item) => item.id === selectedPersonId);
  if (person && !personVisibleToCurrent(person)) return restrictedPage('Pessoa', 'Seu perfil não pode abrir este cadastro.');
  if (!person) { currentPage = 'people'; return renderPeople(); }
  const canManage = canCurrent('people:manage');
  const caregiver = isCaregiverPerson(person);
  const profileRecord = caregiverProfileFor(person.id);
  const address = person.address?.formatted || '';
  const documents = (data.documents || []).filter((document) => document.personId === person.id || person.documentIds?.includes(document.id));
  return `<section class="page-heading page-heading--sub"><button class="back-button" data-page="people" aria-label="Voltar">‹</button><div><p class="eyebrow">${escape(personTypeLabel(person.primaryType))}</p><h1>${escape(person.fullName)}</h1><p class="muted">${escape(person.relationship || (person.active === false ? 'Inativo' : 'Cadastro ativo'))}</p></div></section>
    <section class="person-hero"><span class="person-avatar person-avatar--large">${person.photoPath ? privateImageMarkup(person.photoPath, person.photoUrl || 'assets/icons/child-avatar.svg', 'Foto de ' + person.fullName) : person.photoUrl ? `<img src="${escape(person.photoUrl)}" alt="">` : personTypeIcon(person.primaryType)}</span><div><span class="status-pill ${person.active === false ? 'status-pill--soft' : 'status-pill--success'}">${person.active === false ? 'Inativo' : 'Ativo'}</span><p>${escape(person.notes || 'Sem observações.')}</p></div></section>
    <section class="quick-action-grid">${person.phone ? `<a href="tel:${phoneHref(person.phone)}"><span>☎</span><strong>Ligar</strong></a>` : ''}${person.whatsapp || person.phone ? `<a href="https://wa.me/${phoneHref(person.whatsapp || person.phone)}" target="_blank" rel="noopener"><span>◌</span><strong>WhatsApp</strong></a>` : ''}${address ? `<a href="${mapsUrl(person, false)}" target="_blank" rel="noopener"><span>⌖</span><strong>Endereço</strong></a><a href="${mapsUrl(person, true)}" target="_blank" rel="noopener"><span>➜</span><strong>Traçar rota</strong></a>` : ''}${canCurrent('documents:view') ? `<button data-action="person-documents" data-id="${person.id}"><span>▣</span><strong>Documentos (${documents.length})</strong></button>` : ''}${canCurrent('permissions:manage') ? `<button data-action="manage-person-access" data-id="${person.id}"><span>⚿</span><strong>Permissões</strong></button>` : ''}</section>
    <section class="task-detail-card"><dl class="detail-list"><div><dt>Telefone</dt><dd>${escape(person.phone || 'Não informado')}</dd></div><div><dt>E-mail</dt><dd>${escape(person.email || 'Não informado')}</dd></div><div><dt>Endereço</dt><dd>${escape(address || 'Não informado')}</dd></div><div><dt>Funções</dt><dd>${escape((person.types || [person.primaryType]).map(personTypeLabel).join(', '))}</dd></div></dl></section>
    ${caregiver ? renderCaregiverSummary(person, profileRecord, canManage) : ''}
    ${canManage ? `<section class="task-management"><button class="text-button" data-action="edit-person" data-id="${person.id}">Editar pessoa</button><button class="text-button" data-action="toggle-person-active" data-id="${person.id}">${person.active === false ? 'Reativar' : 'Desativar'}</button><button class="text-button text-button--danger" data-action="delete-person" data-id="${person.id}">Mover para lixeira</button></section>` : ''}`;
}

function renderCaregiverSummary(person, caregiver, canManage) {
  const completedSteps = new Set(caregiver?.completedSteps || []);
  const complete = completedSteps.size;
  const nextStep = [1, 2, 3, 4, 5].find((step) => !completedSteps.has(step)) || 5;
  return `<section class="settings-card"><div class="section-title"><div><p class="eyebrow">Cadastro do cuidador</p><h2>${complete}/5 etapas preenchidas</h2></div><span class="status-pill status-pill--soft">${caregiver?.status === 'inactive' ? 'Inativo' : complete === 5 ? 'Concluído' : 'Em andamento'}</span></div><div class="step-dots">${[1,2,3,4,5].map((step) => `<button class="${completedSteps.has(step) ? 'is-done' : ''}" data-action="open-caregiver-step" data-id="${person.id}" data-step="${step}">${step}</button>`).join('')}</div><p class="muted">Identificação, trabalho, documentos, emergência e controle.</p>${canManage ? `<button class="button button--secondary button--wide" data-action="open-caregiver-step" data-id="${person.id}" data-step="${nextStep}">${complete ? 'Continuar cadastro' : 'Começar cadastro'}</button>` : ''}<p class="privacy-inline">CPF, RG, salário, referências, contatos pessoais e documentos trabalhistas ficam fora do dados.json compartilhado.</p></section>`;
}

function renderUsers() {
  if (!canCurrent('users:view')) return restrictedPage('Usuários e permissões', 'Seu perfil não pode administrar acessos.');
  const canManage = canCurrent('users:manage');
  return `${subPageHeading('Usuários e permissões', 'Somente pessoas que podem entrar no app.')}<section class="settings-card permission-guide"><h2>Como liberar uma pessoa</h2><ol><li>Cadastre a pessoa em <strong>Pessoas</strong>.</li><li>No OneDrive, compartilhe <strong>${escape(oneDriveConfig.folderName)}</strong> com o e-mail exato e marque <strong>Pode editar</strong>.</li><li>Peça para a pessoa adicionar o atalho aos Meus arquivos.</li><li>Abra a pessoa e toque em <strong>Permissões</strong>.</li></ol><p class="permission-note">Revogar aqui bloqueia o app, mas você também deve remover o compartilhamento no OneDrive.</p></section><div class="record-list">${(data.users || []).map((item) => { const person = personById(item.personId); return `<article class="record-card"><span class="record-icon">${personTypeIcon(person?.primaryType || item.role)}</span><div><h2>${escape(person?.fullName || item.name)}</h2><p>${escape(item.email || '')}</p><small>${escape(getRoleLabel(item.role || item.roleId))} · ${item.active ? 'ativo' : 'inativo'}</small></div>${canManage && item.id !== user.id && (item.role || item.roleId) !== 'admin' ? `<button class="icon-button" data-action="edit-user-access" data-id="${item.id}" aria-label="Editar acesso">✎</button>` : ''}</article>`; }).join('') || emptyState('Nenhum acesso adicional.', 'Cadastre a pessoa primeiro e depois libere o acesso.', 'people')}</div>`;
}

function renderTrash() {
  if (!canCurrent('people:manage')) return restrictedPage('Lixeira', 'Somente administradores podem abrir a lixeira.');
  const records = [...(data.trash || [])].sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
  return `${subPageHeading('Lixeira', 'Itens podem ser restaurados por 30 dias.')}<div class="record-list">${records.map((item) => `<article class="record-card"><span class="record-icon">⌫</span><div><h2>${escape(item.label || item.record?.fullName || item.record?.title || 'Registro')}</h2><p>${escape(item.collection)}</p><small>Apagado em ${item.deletedAt ? formatDateTime(item.deletedAt) : ''} · exclusão definitiva após ${item.purgeAfter ? formatDate(item.purgeAfter.slice(0,10)) : '30 dias'}</small></div><button class="button button--secondary button--small" data-action="restore-trash" data-id="${item.id}">Restaurar</button></article>`).join('') || emptyState('Lixeira vazia.', 'Itens apagados aparecerão aqui.', '')}</div>`;
}

function personTypes() {
  return [
    ['mother','Mãe'],['father','Pai'],['grandmother','Avó'],['grandfather','Avô'],['relative','Parente'],
    ['babysitter','Babá'],['caregiver','Cuidador(a)'],['pediatrician','Pediatra'],['doctor','Médico(a)'],
    ['specialist','Especialista'],['therapist','Terapeuta'],['school','Escola'],['emergency-contact','Contato de emergência'],
    ['pickup-authorized','Autorizada a buscar'],['pickup-denied','Não autorizada'],['guardian','Responsável (geral)'],
    ['grandparent','Avó/avô ou familiar'],['visitor','Visitante'],['contact','Contato'],['other','Outro']
  ];
}
function personTypeLabel(type) { return Object.fromEntries(personTypes())[type] || 'Pessoa'; }
function personTypeIcon(type) {
  if (['mother','father','grandmother','grandfather','relative','guardian','grandparent'].includes(type)) return '♧';
  if (['babysitter','caregiver'].includes(type)) return '♥';
  if (['pediatrician','doctor','specialist','therapist'].includes(type)) return '⚕';
  if (type === 'school') return '⌂';
  if (type === 'emergency-contact' || type === 'pickup-denied') return '!';
  if (type === 'pickup-authorized') return '✓';
  return '◉';
}
function canCurrent(permission) {
  if (isRestrictedDeviceMode() && (/^(people|users|caregivers|permissions|child|reports|migration|trash):/.test(permission) || permission === 'tasks:create')) return false;
  return can(user?.role || user?.roleId, permission, user?.permissions || []);
}
function activePeople() { return (data.people || []).filter((person) => person.active !== false); }
function personVisibleToCurrent(person) { return canCurrent('people:manage') || isEmergencyPerson(person) || person?.types?.includes('pickup-authorized') || ['school','doctor','specialist','therapist'].includes(person?.primaryType); }
function personById(id) { return (data.people || []).find((person) => person.id === id); }
function isCaregiverPerson(person) { return (person?.types || [person?.primaryType]).some((type) => ['babysitter','caregiver'].includes(type)); }
function isEmergencyPerson(person) { return person?.types?.includes('emergency-contact') || ['mother','father','grandmother','grandfather','pediatrician'].includes(person?.primaryType); }
function caregiverProfileFor(personId) { return (data.caregiverProfiles || []).find((item) => item.personId === personId); }
function mapsUrl(person, directions) {
  const address = person.address || {};
  const query = address.latitude != null && address.longitude != null ? address.latitude + ',' + address.longitude : address.formatted || '';
  return 'https://www.google.com/maps/' + (directions ? 'dir/?api=1&destination=' : 'search/?api=1&query=') + encodeURIComponent(query);
}
function renderMigration() {
  const canImport = canCurrent('tasks:create');
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
  const preview = privateImageMarkup(photo.syncStatus === 'synced' ? photo.filePath : '', photo.thumbnailUrl || 'assets/icons/child-avatar.svg', 'Prévia de foto registrada: ' + (photo.caption || photo.category));
  return `<figure class="photo-card">${preview}<figcaption>${escape(photo.caption || photo.category)} ${status}</figcaption></figure>`;
}
function privateImageMarkup(path, fallback, alt, className = '') {
  const source = path && privateImageUrls.get(path) || fallback || 'assets/icons/child-avatar.svg';
  return `<img src="${escape(source)}" alt="${escape(alt)}"${className ? ` class="${escape(className)}"` : ''}${path ? ` data-private-image="${escape(path)}"` : ''}>`;
}

async function hydratePrivateImages() {
  const elements = [...document.querySelectorAll('img[data-private-image]')];
  await Promise.allSettled(elements.map(async (element) => {
    const path = element.dataset.privateImage;
    if (!path) return;
    let source = privateImageUrls.get(path);
    if (!source) {
      let loading = privateImageLoads.get(path);
      if (!loading) {
        loading = downloadFile(path).then((blob) => {
          const url = URL.createObjectURL(blob);
          privateImageUrls.set(path, url);
          privateImageLoads.delete(path);
          return url;
        }).catch((error) => { privateImageLoads.delete(path); throw error; });
        privateImageLoads.set(path, loading);
      }
      source = await loading;
    }
    if (element.isConnected && element.dataset.privateImage === path) element.src = source;
  }));
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

document.addEventListener('visibilitychange', () => { if (document.hidden && isRestrictedDeviceMode()) lockDeviceNow(); });
document.addEventListener('pointerdown', recordDeviceActivity, { passive: true });
document.addEventListener('keydown', recordDeviceActivity);
document.addEventListener('click', async (event) => {
  const control = event.target.closest('[data-page], [data-quick], [data-register-type], [data-action]');
  if (!control || control.disabled) return;
  recordDeviceActivity();
  if (control.dataset.page) {
    if (!canOpenPage(control.dataset.page)) { notify('Esta tela não está disponível no Modo Babá.', 'error'); return; }
    currentPage = control.dataset.page; if (currentPage !== 'task-detail') selectedTaskId = null; if (currentPage !== 'vaccine-detail') selectedVaccineId = null; if (currentPage !== 'person-detail') selectedPersonId = null; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (control.dataset.quick) { selectedRegisterType = control.dataset.quick; currentPage = 'register'; render(); return; }
  if (control.dataset.registerType) { selectedRegisterType = control.dataset.registerType; render(); return; }
  try {
    assertDeviceAction(control.dataset.action);
    switch (control.dataset.action) {
      case 'select-device-person': selectedDevicePersonId = control.dataset.id || ''; renderDeviceEnrollment(); break;
      case 'request-admin-mode': renderAdminPinPrompt(); break;
      case 'back-to-device-lock': returnToDeviceLock(); break;
      case 'continue-admin-mode': if ((user?.role || user?.roleId) !== 'admin' || restrictedDeviceMode) throw new Error('Confirme o PIN do administrador para continuar.'); render(); break;
      case 'lock-device-now': lockDeviceNow(); break; case 'revoke-device': revokeCurrentDevice(); break;
      case 'reload': window.location.reload(); break;
      case 'toggle-theme': toggleTheme(); break;
      case 'microsoft-login': await signInMicrosoft(); break;
      case 'sign-out-microsoft': {
        const pendingPhotos = dataNamespace ? await listPendingPhotos(dataNamespace) : [];
        if ((hasPendingChanges() || pendingPhotos.length) && !window.confirm('Há alterações ou fotos pendentes. Elas serão preservadas neste aparelho e só voltarão a sincronizar com esta mesma conta e pasta. Deseja sair?')) break;
        await signOutMicrosoft();
        break;
      }
      case 'reconfigure-onedrive': {
        const pendingPhotos = dataNamespace ? await listPendingPhotos(dataNamespace) : [];
        if (hasPendingChanges() || pendingPhotos.length) {
          if (data) exportBackup(data);
          notify('A conexão não foi alterada porque há dados pendentes. Uma cópia local foi baixada; sincronize antes de trocar a pasta.', 'warning');
          break;
        }
        if (window.confirm('Alterar a conexão neste aparelho? Os dados no OneDrive não serão apagados.')) { clearOneDriveConfig(); resetLocalCache(); window.location.reload(); }
        break;
      }
      case 'sync-now': await syncNow(); notify('Sincronização concluída.'); break;
      case 'open-onedrive': window.open(await getRootWebUrl(), '_blank', 'noopener'); break;
      case 'open-document': if (isRestrictedDeviceMode() && !canOpenDocumentPath(control.dataset.path)) throw new Error('Este documento não foi liberado para o Modo Babá.'); window.open(await getFileUrl(control.dataset.path), '_blank', 'noopener'); break;
      case 'setup-admin-area': await setupAdminArea(); break;
      case 'open-admin-file': window.open(await getAdminFileUrl(control.dataset.path), '_blank', 'noopener'); break;
      case 'open-vaccine-proof': window.open(await getFileUrl(control.dataset.path), '_blank', 'noopener'); break;
      case 'open-vaccine': selectedVaccineId = control.dataset.id; currentPage = 'vaccine-detail'; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); break;
      case 'edit-vaccine': openVaccineEditor(control.dataset.id); break;
      case 'delete-vaccine': deleteVaccine(control.dataset.id); break;
      case 'clear-example-vaccines': clearExampleVaccines(); break;
      case 'clear-example-data': clearAllExampleData(); break;
      case 'confirm-avatar-crop': await confirmAvatarCrop(); break;
      case 'restore-backup': await restoreBackupFromPrompt(); break;
      case 'open-task': selectedTaskId = control.dataset.id; currentPage = 'task-detail'; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); break;
      case 'toggle-checklist': toggleTaskChecklist(control.dataset.taskId, Number(control.dataset.index), control.checked); break;
      case 'complete-task': completeTask(control.dataset.id); break;
      case 'edit-task': openTaskEditor(control.dataset.id); break;
      case 'delete-task': deleteTask(control.dataset.id); break;
      case 'open-photo': openPhotoModal(control.dataset.taskId || ''); break;
      case 'add-person': openPersonEditor(); break;
      case 'open-person': selectedPersonId = control.dataset.id; currentPage = 'person-detail'; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); break;
      case 'edit-person': openPersonEditor(control.dataset.id); break;
      case 'filter-people': peopleFilter = control.dataset.filter || 'active'; render(); break;
      case 'toggle-person-active': togglePersonActive(control.dataset.id); break;
      case 'delete-person': await deletePerson(control.dataset.id); break;
      case 'open-caregiver-step': openCaregiverStep(control.dataset.id, control.dataset.step); break;
      case 'person-documents': await showPersonDocuments(control.dataset.id); break;
      case 'manage-person-access': openAccessEditor(control.dataset.id); break;
      case 'edit-user-access': { const access = (data.users || []).find((item) => item.id === control.dataset.id); if (access) openAccessEditor(access.personId, access.id); break; }
      case 'revoke-user-access': revokeUserAccess(control.dataset.id); break;
      case 'restore-trash': await restoreTrash(control.dataset.id); break;
      case 'add-growth': openGrowthEditor(); break;
      case 'edit-growth': openGrowthEditor(control.dataset.id); break;
      case 'delete-growth': deleteGrowth(control.dataset.id); break;
      case 'close-modal': document.querySelector('#modal-root').innerHTML = ''; break;
      case 'print-report': if (!printDailyReport(data, localDate())) notify('O navegador bloqueou a janela do relatório.', 'error'); break;
      case 'export-backup': exportBackup(data); notify('Cópia local baixada.'); break;
      case 'export-pending-conflict': if (pendingConflict?.state) { exportBackup(pendingConflict.state); notify('Cópia pendente baixada. Guarde o arquivo antes de continuar.'); } break;
      case 'discard-pending-conflict': if (window.confirm('Você já baixou a cópia deste aparelho? Continuar removerá apenas a fila local e abrirá a versão do OneDrive.')) { resetLocalCache(); pendingConflict = null; window.location.reload(); } break;
    }
  } catch (error) { notify(error.message, 'error'); }
});
document.addEventListener('submit', async (event) => {
  event.preventDefault();
  recordDeviceActivity();
  try {
    if (event.target.id === 'admin-pin-setup-form') { await saveAdminPin(event.target); return; }
    if (event.target.id === 'device-enrollment-form') { await enrollDeviceUser(event.target); return; }
    if (event.target.id === 'device-unlock-form') { await unlockDevice(event.target); return; }
    if (event.target.id === 'admin-unlock-form') { await unlockAdministrator(event.target); return; }
    assertDeviceForm(event.target.id);
    if (event.target.id === 'onedrive-setup-form') { const formData = new FormData(event.target); saveOneDriveConfig({ clientId: formData.get('clientId'), tenantId: formData.get('tenantId'), folderName: formData.get('folderName') }); window.location.reload(); return; }
    if (event.target.id === 'task-form') await saveTask(event.target);
    if (event.target.id === 'quick-form') await saveQuickRecord(event.target);
    if (event.target.id === 'task-note-form') saveTaskNote(event.target);
    if (event.target.id === 'photo-form') await savePhotoRecord(event.target);
    if (event.target.id === 'attachment-form') await saveAttachment(event.target);
    if (event.target.id === 'child-profile-form') await saveChildProfile(event.target);
    if (event.target.id === 'person-form') await savePerson(event.target);
    if (event.target.id === 'caregiver-form') await saveCaregiverStep(event.target, event.submitter);
    if (event.target.id === 'access-form') await saveAccess(event.target);
    if (event.target.id === 'growth-form') saveGrowth(event.target);
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
  if (!canCurrent('tasks:create')) throw new Error('Seu perfil não pode criar ou editar afazeres.');
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
  if (!canCurrent('tasks:complete') && !canCurrent('logs:create')) throw new Error('Seu perfil não pode registrar observações.');
  updateRecord('dailyTasks', taskId, { caregiverNote: note, caregiverNoteAt: new Date().toISOString(), caregiverNoteBy: user.id }, user.id); render(); notify('Observação salva.');
}

function toggleTaskChecklist(taskId, index, checked) {
  if (!canCurrent('tasks:complete') && !canCurrent('logs:create')) return notify('Seu perfil não pode atualizar o checklist.', 'error');
  const task = data.dailyTasks.find((item) => item.id === taskId); if (!task) return;
  const checklist = normalizedChecklist(task); if (!checklist[index]) return;
  checklist[index] = { ...checklist[index], checked, checkedAt: checked ? new Date().toISOString() : null, checkedBy: checked ? user.id : null };
  updateRecord('dailyTasks', taskId, { checklist }, user.id); render();
}

function openTaskEditor(id) {
  if (!canCurrent('tasks:create')) return notify('Seu perfil não pode editar afazeres.', 'error');
  const task = data.dailyTasks.find((item) => item.id === id); if (!task) return;
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()"><button class="modal__close" data-action="close-modal" aria-label="Fechar">×</button><h2>Editar afazer</h2><form id="task-form"><input type="hidden" name="taskId" value="${task.id}"><label>Data<input name="date" type="date" value="${escape(task.date)}" required></label><div class="form-grid"><label>Horário<input name="scheduledTime" type="time" value="${escape(task.scheduledTime)}" required></label><label>Tipo<select name="taskType">${taskTypes().map((type) => `<option value="${type}" ${(task.taskType || task.category) === type ? 'selected' : ''}>${type}</option>`).join('')}</select></label></div><label>Título<input name="title" value="${escape(task.title)}" required></label><label>Orientação da família<textarea name="familyNote" rows="4">${escape(task.familyNote || task.description || '')}</textarea></label><label>Checklist (um item por linha)<textarea name="checklistText" rows="5">${escape(normalizedChecklist(task).map((item) => item.label).join('\n'))}</textarea></label><label class="check-row"><input type="checkbox" name="requiresPhoto" ${task.requiresPhoto ? 'checked' : ''}> Solicitar foto</label><button class="button button--wide" type="submit">Salvar alterações</button></form></section></div>`;
}

function deleteTask(id) {
  if (!canCurrent('tasks:create')) return notify('Seu perfil não pode apagar afazeres.', 'error');
  const task = data.dailyTasks.find((item) => item.id === id); if (!task) return;
  if (!window.confirm('Mover o afazer “' + task.title + '” para a lixeira por 30 dias?')) return;
  moveToTrash('dailyTasks', id, task.title); selectedTaskId = null; currentPage = 'tasks'; render(); notify('Afazer movido para a lixeira.');
}

function openPersonEditor(id = '') {
  if (!canCurrent('people:manage')) return notify('Seu perfil não pode alterar pessoas.', 'error');
  const person = id ? personById(id) : null;
  const types = new Set(person?.types || []);
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()"><button class="modal__close" data-action="close-modal" aria-label="Fechar">×</button><p class="eyebrow">${person ? 'Editar' : 'Nova pessoa'}</p><h2>${person ? escape(person.fullName) : 'Quem você quer cadastrar?'}</h2><form id="person-form"><input type="hidden" name="personId" value="${escape(person?.id || '')}"><label>Nome completo<input name="fullName" value="${escape(person?.fullName || '')}" required autofocus></label><label>Tipo principal<select name="primaryType">${personTypes().map(([value,label]) => `<option value="${value}" ${person?.primaryType === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Vínculo ou função<input name="relationship" value="${escape(person?.relationship || '')}" placeholder="Ex.: avó materna, pediatra"></label><div class="form-grid"><label>Telefone<input name="phone" inputmode="tel" value="${escape(person?.phone || '')}"></label><label>WhatsApp<input name="whatsapp" inputmode="tel" value="${escape(person?.whatsapp || '')}"></label></div><label>E-mail<input name="email" type="email" value="${escape(person?.email || '')}"></label><label>Foto<input name="personPhoto" type="file" accept="image/*"></label><details class="advanced-fields"><summary>Mais informações</summary><label>Endereço<input name="address" value="${escape(person?.address?.formatted || '')}"></label><div class="form-grid"><label>Latitude<input name="latitude" inputmode="decimal" value="${escape(person?.address?.latitude ?? '')}"></label><label>Longitude<input name="longitude" inputmode="decimal" value="${escape(person?.address?.longitude ?? '')}"></label></div><label>Prioridade<input name="priority" type="number" min="0" max="99" value="${escape(person?.priority ?? 0)}"></label><label>Observações<textarea name="notes" rows="3">${escape(person?.notes || '')}</textarea></label><fieldset class="choice-field"><legend>Também é</legend><label class="check-row"><input type="checkbox" name="extraTypes" value="emergency-contact" ${types.has('emergency-contact') ? 'checked' : ''}> Contato de emergência</label><label class="check-row"><input type="checkbox" name="extraTypes" value="pickup-authorized" ${types.has('pickup-authorized') ? 'checked' : ''}> Autorizada a buscar</label><label class="check-row"><input type="checkbox" name="extraTypes" value="pickup-denied" ${types.has('pickup-denied') ? 'checked' : ''}> Não autorizada a buscar</label></fieldset><label class="check-row"><input type="checkbox" name="active" ${person?.active === false ? '' : 'checked'}> Cadastro ativo</label><label class="check-row"><input type="checkbox" name="deviceEnabled" ${person?.deviceEnabled ? 'checked' : ''}> Pode usar este dispositivo</label></details><button class="button button--wide" type="submit">${person ? 'Salvar alterações' : 'Salvar pessoa'}</button></form></section></div>`;
}

async function savePerson(form) {
  if (!canCurrent('people:manage')) throw new Error('Seu perfil não pode alterar pessoas.');
  const values = new FormData(form);
  const id = String(values.get('personId') || '');
  const current = id ? personById(id) : null;
  const adminAccess = current ? (data.users || []).find((item) => item.personId === current.id && (item.role || item.roleId) === 'admin') : null;
  const fullName = String(values.get('fullName') || '').trim();
  const primaryType = String(values.get('primaryType') || 'other');
  if (adminAccess && (primaryType !== current.primaryType || String(values.get('email') || '').trim().toLowerCase() !== String(current.email || '').toLowerCase() || values.get('active') !== 'on')) throw new Error('O administrador principal não pode mudar de tipo, e-mail ou ficar inativo nesta tela.');
  if (current && caregiverProfileFor(current.id) && !['babysitter', 'caregiver'].includes(primaryType)) throw new Error('Um cuidador com perfil vinculado não pode perder esse tipo. Desative ou apague o cadastro pelo fluxo próprio.');
  if (!fullName) throw new Error('Informe o nome da pessoa.');
  const extraTypes = values.getAll('extraTypes').map(String);
  const types = [...new Set([primaryType, ...extraTypes])];
  let photoUrl = current?.photoUrl || '';
  let photoPath = current?.photoPath || '';
  const photo = values.get('personPhoto');
  if (photo?.size) {
    const compressed = await resizeImage(photo, 720, 0.82);
    photoPath = 'Anexos/Pessoas/' + (id || 'nova') + '/foto_' + Date.now() + '.jpg';
    await uploadFile(photoPath, compressed.blob, 'image/jpeg');
    photoUrl = '';
  }
  const latitudeText = String(values.get('latitude') || '').replace(',', '.');
  const longitudeText = String(values.get('longitude') || '').replace(',', '.');
  const record = {
    entityKind: primaryType === 'school' ? 'organization' : 'person',
    primaryType,
    types,
    fullName,
    relationship: String(values.get('relationship') || '').trim(),
    photoPath,
    photoUrl,
    phone: String(values.get('phone') || '').trim(),
    whatsapp: String(values.get('whatsapp') || '').trim(),
    email: String(values.get('email') || '').trim().toLowerCase(),
    address: {
      formatted: String(values.get('address') || '').trim(),
      latitude: latitudeText ? Number(latitudeText) : null,
      longitude: longitudeText ? Number(longitudeText) : null
    },
    priority: Number(values.get('priority') || 0),
    notes: String(values.get('notes') || '').trim(),
    active: values.get('active') === 'on',
    relatedPersonIds: current?.relatedPersonIds || [],
    documentIds: current?.documentIds || [],
    permissions: current?.permissions || [],
    deviceEnabled: values.get('deviceEnabled') === 'on'
  };
  const saved = current ? updateRecord('people', current.id, record, user.id) : addRecord('people', record, user.id);
  if (current && current.active !== false && saved.active === false) (data.users || []).filter((item) => item.personId === saved.id && item.active).forEach((item) => updateRecord('users', item.id, { active: false }, user.id));
  if (isCaregiverPerson(saved) && !caregiverProfileFor(saved.id)) addRecord('caregiverProfiles', { personId: saved.id, status: 'active', workSchedule: [], courses: [], completedSteps: [] }, user.id);
  document.querySelector('#modal-root').innerHTML = '';
  selectedPersonId = saved.id; currentPage = 'person-detail'; render(); notify(current ? 'Pessoa atualizada.' : 'Pessoa cadastrada.');
}

function openCaregiverStep(personId, step = 1) {
  if (!canCurrent('caregivers:manage')) return notify('Seu perfil não pode alterar cuidadores.', 'error');
  const person = personById(personId); if (!person) return;
  if ((data.users || []).some((item) => item.personId === personId && (item.role || item.roleId) === 'admin')) return notify('O administrador principal não pode ser transformado em cuidador.', 'error');
  selectedPersonId = personId; caregiverStep = Math.min(5, Math.max(1, Number(step) || 1));
  const caregiver = caregiverProfileFor(personId) || {};
  const isAdmin = (user.role || user.roleId) === 'admin';
  const privateRecord = adminData?.caregivers?.[personId] || {};
  const privateReady = isAdmin && Boolean(adminData);
  const adminUnavailable = isAdmin
    ? '<section class="restricted-card"><h3>Área administrativa necessária</h3><p>Ative a pasta protegida para preencher estes dados.</p><button type="button" class="button button--secondary button--wide" data-action="setup-admin-area">Ativar área administrativa</button></section>'
    : '<section class="restricted-card"><h3>Somente administrador</h3><p>Dados pessoais, referências, documentos e contatos particulares não ficam no arquivo compartilhado.</p></section>';
  const headings = ['Identificação', 'Dados profissionais', 'Documentos protegidos', 'Contato pessoal de emergência', 'Controle e acesso'];
  let fields = '';
  if (caregiverStep === 1) fields = `<label>Nome completo<input name="fullName" value="${escape(person.fullName || '')}" required></label><div class="form-grid"><label>Telefone<input name="phone" value="${escape(person.phone || '')}"></label><label>WhatsApp<input name="whatsapp" value="${escape(person.whatsapp || '')}"></label></div><label>E-mail<input name="email" type="email" value="${escape(person.email || '')}"></label><label>Endereço<input name="address" value="${escape(person.address?.formatted || '')}"></label>`;
  if (caregiverStep === 2) {
    const references = privateReady ? `<label>Referências profissionais (uma por linha)<textarea name="professionalReferences" rows="3">${escape((privateRecord.professionalReferences || []).join('\n'))}</textarea></label><p class="permission-note">As referências ficam somente na área administrativa.</p>` : '';
    fields = `<div class="form-grid"><label>Data de início<input name="startDate" type="date" value="${escape(caregiver.startDate || '')}"></label><label>Função<input name="function" value="${escape(caregiver.function || 'Babá')}"></label></div><label>Dias e horários<textarea name="workSchedule" rows="4" placeholder="Segunda a sexta | 08:00 às 17:00">${escape((caregiver.workSchedule || []).join('\n'))}</textarea></label><label>Experiência<textarea name="experience" rows="3">${escape(caregiver.experience || '')}</textarea></label><label>Cursos (um por linha)<textarea name="courses" rows="3">${escape((caregiver.courses || []).join('\n'))}</textarea></label><label class="check-row"><input type="checkbox" name="firstAidTraining" ${caregiver.firstAidTraining?.completed ? 'checked' : ''}> Treinamento de primeiros socorros</label>${references}`;
  }
  if (caregiverStep === 3) {
    const privateDocuments = privateRecord.documents || [];
    fields = privateReady ? `<section class="restricted-card"><h3>Dados administrativos protegidos</h3><div class="form-grid"><label>CPF<input name="cpf" inputmode="numeric" value="${escape(privateRecord.cpf || '')}"></label><label>RG<input name="rg" value="${escape(privateRecord.rg || '')}"></label></div><label>Data de nascimento<input name="privateBirthDate" type="date" value="${escape(privateRecord.birthDate || '')}"></label><label>Salário mensal (R$)<input name="salary" inputmode="decimal" value="${privateRecord.salaryCents != null && Number.isFinite(Number(privateRecord.salaryCents)) ? escape((Number(privateRecord.salaryCents) / 100).toFixed(2).replace('.', ',')) : ''}"></label><label>Resumo dos documentos e certificados<textarea name="documentNotes" rows="4">${escape(privateRecord.documentNotes || '')}</textarea></label><label>Próxima validade<input name="documentExpiry" type="date" value="${escape(privateRecord.documentExpiry || '')}"></label><label>Contrato, documento pessoal ou comprovante<input name="privateFiles" type="file" multiple></label>${privateDocuments.length ? `<div class="private-document-list">${privateDocuments.map((document) => `<button type="button" class="text-button" data-action="open-admin-file" data-path="${escape(document.path)}">Abrir ${escape(document.name)}</button>`).join('')}</div>` : ''}<p class="permission-note">Estes campos são gravados somente em ${escape(DEFAULT_ADMIN_FOLDER)}.</p></section>` : adminUnavailable;
  }
  if (caregiverStep === 4) {
    const emergency = privateRecord.emergencyContact || {};
    fields = privateReady ? `<label>Nome do contato<input name="emergencyName" value="${escape(emergency.name || '')}"></label><label>Parentesco<input name="emergencyRelationship" value="${escape(emergency.relationship || '')}"></label><div class="form-grid"><label>Telefone<input name="emergencyPhone" value="${escape(emergency.phone || '')}"></label><label>WhatsApp<input name="emergencyWhatsapp" value="${escape(emergency.whatsapp || '')}"></label></div><label>Endereço<input name="emergencyAddress" value="${escape(emergency.address || '')}"></label><label>Observações<textarea name="emergencyNotes" rows="3">${escape(emergency.notes || '')}</textarea></label><p class="permission-note">Este contato pessoal fica somente na área administrativa.</p>` : adminUnavailable;
  }
  if (caregiverStep === 5) {
    const access = (data.users || []).find((item) => item.personId === personId);
    const termination = privateReady ? `<label>Data de desligamento<input name="terminationDate" type="date" value="${escape(privateRecord.terminationDate || '')}"></label>` : '';
    fields = `<label>Status<select name="status"><option value="active" ${caregiver.status !== 'inactive' ? 'selected' : ''}>Ativo</option><option value="inactive" ${caregiver.status === 'inactive' ? 'selected' : ''}>Inativo/desligado</option></select></label>${termination}<label class="check-row"><input type="checkbox" name="appAccess" ${access?.active ? 'checked' : ''}> Pode entrar no app</label><label>Papel no app<select name="role"><option value="caregiver" ${(access?.role || access?.roleId) === 'caregiver' ? 'selected' : ''}>Babá/cuidador(a)</option><option value="grandparent" ${(access?.role || access?.roleId) === 'grandparent' ? 'selected' : ''}>Avó/avô ou familiar</option><option value="visitor" ${(access?.role || access?.roleId) === 'visitor' ? 'selected' : ''}>Visitante</option></select></label><p class="permission-note">Dar acesso aqui não compartilha o OneDrive automaticamente. Use o mesmo e-mail cadastrado na etapa 1.</p>`;
  }
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal caregiver-wizard" role="dialog" aria-modal="true"><button class="modal__close" data-action="close-modal" aria-label="Fechar">×</button><p class="eyebrow">Etapa ${caregiverStep} de 5</p><h2>${headings[caregiverStep - 1]}</h2><div class="wizard-progress"><span style="width: ${caregiverStep * 20}%"></span></div><form id="caregiver-form"><input type="hidden" name="personId" value="${personId}"><input type="hidden" name="step" value="${caregiverStep}">${fields}<div class="wizard-actions">${caregiverStep > 1 ? `<button type="button" class="button button--secondary" data-action="open-caregiver-step" data-id="${personId}" data-step="${caregiverStep - 1}">Voltar</button>` : '<span></span>'}<button class="button button--secondary" type="submit" name="intent" value="exit">Salvar e sair</button><button class="button" type="submit" name="intent" value="next">${caregiverStep === 5 ? 'Concluir' : 'Continuar'}</button></div></form></section></div>`;
}

function ensureCaregiverProfile(personId) {
  return caregiverProfileFor(personId) || addRecord('caregiverProfiles', { personId, status: 'active', workSchedule: [], courses: [], completedSteps: [] }, user.id);
}

async function savePrivateCaregiverPatch(personId, patch) {
  if ((user.role || user.roleId) !== 'admin' || !adminData) throw new Error('Ative a área administrativa para salvar estes dados protegidos.');
  const current = adminData.caregivers[personId] || { documents: [] };
  adminData.caregivers[personId] = { ...current, ...patch, updatedAt: new Date().toISOString(), updatedBy: user.id };
  adminData = await saveAdminData(adminData);
}

async function saveCaregiverStep(form, submitter) {
  if (!canCurrent('caregivers:manage')) throw new Error('Seu perfil não pode alterar cuidadores.');
  const values = new FormData(form); const personId = String(values.get('personId')); const step = Number(values.get('step')); const person = personById(personId); if (!person) throw new Error('Cuidador não encontrado.');
  if ((data.users || []).some((item) => item.personId === personId && (item.role || item.roleId) === 'admin')) throw new Error('O administrador principal não pode ser alterado pelo cadastro de cuidador.');
  const caregiver = ensureCaregiverProfile(personId);
  const privateReady = (user.role || user.roleId) === 'admin' && Boolean(adminData);
  if (step === 1) updateRecord('people', personId, { fullName: String(values.get('fullName') || '').trim(), phone: String(values.get('phone') || '').trim(), whatsapp: String(values.get('whatsapp') || '').trim(), email: String(values.get('email') || '').trim().toLowerCase(), address: { ...(person.address || {}), formatted: String(values.get('address') || '').trim() } }, user.id);
  if (step === 2) {
    updateRecord('caregiverProfiles', caregiver.id, { startDate: String(values.get('startDate') || ''), function: String(values.get('function') || '').trim(), workSchedule: lines(values.get('workSchedule')), experience: String(values.get('experience') || '').trim(), courses: lines(values.get('courses')), firstAidTraining: { completed: values.get('firstAidTraining') === 'on' } }, user.id);
    if (privateReady && values.has('professionalReferences')) await savePrivateCaregiverPatch(personId, { professionalReferences: lines(values.get('professionalReferences')) });
  }
  if (step === 3) {
    if (!privateReady) throw new Error('Somente o administrador, com a área protegida ativa, pode salvar documentos e dados pessoais.');
    const currentPrivate = adminData.caregivers[personId] || { documents: [] };
    const salaryRaw = String(values.get('salary') || '').trim();
    const salaryNormalized = salaryRaw.includes(',') ? salaryRaw.replace(/\./g, '').replace(',', '.') : salaryRaw;
    const documents = [...(currentPrivate.documents || [])];
    for (const file of values.getAll('privateFiles')) {
      if (!file?.size) continue;
      const filePath = 'Documentos/Cuidadores/' + personId + '/' + Date.now() + '_' + safeFileName(file.name);
      await uploadAdminFile(filePath, file, file.type || 'application/octet-stream');
      documents.push({ name: file.name, path: filePath, uploadedAt: new Date().toISOString(), uploadedBy: user.id });
    }
    await savePrivateCaregiverPatch(personId, { cpf: String(values.get('cpf') || '').trim(), rg: String(values.get('rg') || '').trim(), birthDate: String(values.get('privateBirthDate') || ''), salaryCents: salaryNormalized && Number.isFinite(Number(salaryNormalized)) ? Math.round(Number(salaryNormalized) * 100) : null, documentNotes: String(values.get('documentNotes') || '').trim(), documentExpiry: String(values.get('documentExpiry') || ''), documents });
  }
  if (step === 4) {
    if (!privateReady) throw new Error('Somente o administrador, com a área protegida ativa, pode salvar o contato pessoal de emergência.');
    await savePrivateCaregiverPatch(personId, { emergencyContact: { name: String(values.get('emergencyName') || '').trim(), relationship: String(values.get('emergencyRelationship') || '').trim(), phone: String(values.get('emergencyPhone') || '').trim(), whatsapp: String(values.get('emergencyWhatsapp') || '').trim(), address: String(values.get('emergencyAddress') || '').trim(), notes: String(values.get('emergencyNotes') || '').trim() } });
  }
  if (step === 5) {
    const status = String(values.get('status') || 'active');
    updateRecord('caregiverProfiles', caregiver.id, { status }, user.id);
    updateRecord('people', personId, { active: status === 'active' }, user.id);
    const access = (data.users || []).find((item) => item.personId === personId);
    if (status === 'active' && values.get('appAccess') === 'on') upsertPersonAccess(person, access, String(values.get('role') || 'caregiver'), true);
    else if (access) updateRecord('users', access.id, { active: false }, user.id);
    if (privateReady && values.has('terminationDate')) await savePrivateCaregiverPatch(personId, { terminationDate: String(values.get('terminationDate') || '') || null });
  }
  const completedSteps = [...new Set([...(caregiver.completedSteps || []), step])].sort((a, b) => a - b);
  updateRecord('caregiverProfiles', caregiver.id, { completedSteps, onboardingCompletedAt: step === 5 ? new Date().toISOString() : caregiver.onboardingCompletedAt || null }, user.id);
  const intent = submitter?.value || 'exit';
  if (intent === 'next' && step < 5) { openCaregiverStep(personId, step + 1); notify('Etapa salva.'); return; }
  document.querySelector('#modal-root').innerHTML = ''; selectedPersonId = personId; currentPage = 'person-detail'; render(); notify(step === 5 ? 'Cadastro do cuidador concluído.' : 'Cadastro salvo.');
}
function openAccessEditor(personId, userId = '') {
  if (!canCurrent('permissions:manage')) return notify('Seu perfil não pode administrar permissões.', 'error');
  const access = userId ? (data.users || []).find((item) => item.id === userId) : (data.users || []).find((item) => item.personId === personId);
  if (access?.id === user.id) return notify('Para sua segurança, seu próprio acesso não pode ser alterado nesta tela.', 'error');
  if ((access?.role || access?.roleId) === 'admin') return notify('O administrador principal não pode ser alterado ou revogado nesta tela.', 'error');
  const person = personById(personId || access?.personId); if (!person) return notify('Pessoa não encontrada.', 'error');
  const grants = new Set(access?.permissions || []);
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()"><button class="modal__close" data-action="close-modal" aria-label="Fechar">×</button><p class="eyebrow">Acesso ao app</p><h2>${escape(person.fullName)}</h2><form id="access-form"><input type="hidden" name="personId" value="${person.id}"><input type="hidden" name="userId" value="${escape(access?.id || '')}"><label>E-mail Microsoft<input name="email" type="email" value="${escape(access?.email || person.email || '')}"></label><label>Papel<select name="role"><option value="guardian" ${(access?.role || access?.roleId) === 'guardian' ? 'selected' : ''}>Responsável</option><option value="caregiver" ${(access?.role || access?.roleId) === 'caregiver' ? 'selected' : ''}>Babá/cuidador(a)</option><option value="grandparent" ${(access?.role || access?.roleId) === 'grandparent' ? 'selected' : ''}>Avó/avô ou familiar</option><option value="visitor" ${(access?.role || access?.roleId) === 'visitor' ? 'selected' : ''}>Visitante</option><option value="custom" ${(access?.role || access?.roleId) === 'custom' ? 'selected' : ''}>Personalizado</option></select></label><details class="advanced-fields"><summary>Permissões personalizadas</summary><label class="check-row"><input type="checkbox" name="permissions" value="documents:view" ${grants.has('documents:view') ? 'checked' : ''}> Ver documentos liberados</label><label class="check-row"><input type="checkbox" name="permissions" value="vaccines:view" ${grants.has('vaccines:view') ? 'checked' : ''}> Ver vacinas</label><label class="check-row"><input type="checkbox" name="permissions" value="appointments:view" ${grants.has('appointments:view') ? 'checked' : ''}> Ver consultas</label><label class="check-row"><input type="checkbox" name="permissions" value="people:view" ${grants.has('people:view') ? 'checked' : ''}> Ver contatos essenciais</label></details><label>PIN de acesso (deixe vazio para manter)<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,6}" minlength="4" maxlength="6" autocomplete="new-password"></label><label>Confirmar PIN<input name="pinConfirmation" type="password" inputmode="numeric" pattern="[0-9]{4,6}" minlength="4" maxlength="6" autocomplete="new-password"></label><label class="check-row"><input type="checkbox" name="deviceEnabled" ${access?.deviceEnabled ? 'checked' : ''}> Pode usar este dispositivo</label><label class="check-row"><input type="checkbox" name="active" ${access?.active === false ? '' : 'checked'}> Acesso ativo</label><button class="button button--wide" type="submit">Salvar acesso</button>${access ? `<button class="button button--danger button--wide" type="button" data-action="revoke-user-access" data-id="${access.id}">Revogar acesso</button>` : ''}</form><p class="permission-note">Você também precisa compartilhar ou remover a pasta no OneDrive manualmente.</p></section></div>`;
}


async function saveAccess(form) {
  if (!canCurrent('permissions:manage')) throw new Error('Seu perfil não pode administrar permissões.');
  const values = new FormData(form); const person = personById(String(values.get('personId'))); if (!person) throw new Error('Pessoa não encontrada.');
  const existing = String(values.get('userId') || '') ? (data.users || []).find((item) => item.id === String(values.get('userId'))) : (data.users || []).find((item) => item.personId === person.id);
  if (existing?.id === user.id || (existing?.role || existing?.roleId) === 'admin') throw new Error('O acesso do administrador principal não pode ser alterado nesta tela.');
  const pin = String(values.get('pin') || ''); const confirmation = String(values.get('pinConfirmation') || '');
  if ((pin || confirmation) && (!validPin(pin) || pin !== confirmation)) throw new Error('Informe e confirme um PIN numérico igual, de 4 a 6 dígitos.');
  const saved = upsertPersonAccess(person, existing, String(values.get('role') || 'visitor'), values.get('active') === 'on', String(values.get('email') || '').trim().toLowerCase(), values.getAll('permissions').map(String), values.get('deviceEnabled') === 'on');
  if (pin) updateRecord('users', saved.id, { pinHash: await createPinHash(pin), pinUpdatedAt: new Date().toISOString() }, user.id);
  updateRecord('people', person.id, { deviceEnabled: values.get('deviceEnabled') === 'on' }, user.id); if (getDeviceBinding()?.personId === person.id && values.get('deviceEnabled') !== 'on') { clearDeviceBinding(); deviceBinding = null; }
  document.querySelector('#modal-root').innerHTML = ''; render(); notify('Permissões e acesso do dispositivo atualizados.');
}

function upsertPersonAccess(person, existing, role, active, email = person.email, permissions = existing?.permissions || [], deviceEnabled = existing?.deviceEnabled === true) {
  if (role === 'admin' || existing?.id === user.id || (existing?.role || existing?.roleId) === 'admin') throw new Error('O administrador principal não pode ser alterado por este fluxo.');
  if (!email && !deviceEnabled) throw new Error('Informe o e-mail Microsoft ou habilite o uso somente neste dispositivo.');
  const duplicate = email ? (data.users || []).find((item) => item.email?.toLowerCase() === email.toLowerCase() && item.id !== existing?.id) : null;
  if (duplicate) throw new Error('Este e-mail já está associado a outro usuário.');
  const normalizedEmail = email ? email.toLowerCase() : '';
  const record = { personId: person.id, name: person.fullName, email: normalizedEmail, normalizedEmail, role, roleId: role, permissions, phone: person.phone || '', active, deviceEnabled };
  const saved = existing ? updateRecord('users', existing.id, record, user.id) : addRecord('users', record, user.id);
  if (email && person.email !== email) updateRecord('people', person.id, { email }, user.id);
  return saved;
}

function revokeUserAccess(id) {
  if (!canCurrent('users:manage')) return notify('Seu perfil não pode revogar acessos.', 'error');
  const access = (data.users || []).find((item) => item.id === id); if (!access) return;
  if (access.id === user.id || (access.role || access.roleId) === 'admin') return notify('O acesso do administrador principal não pode ser revogado nesta tela.', 'error');
  if (!window.confirm('Revogar o acesso ao app? Remova também o compartilhamento no OneDrive.')) return;
  updateRecord('users', id, { active: false }, user.id); document.querySelector('#modal-root').innerHTML = ''; render(); notify('Acesso revogado.');
}

function togglePersonActive(id) {
  if (!canCurrent('people:manage')) return notify('Seu perfil não pode alterar pessoas.', 'error');
  const person = personById(id); if (!person) return;
  const linkedUsers = (data.users || []).filter((item) => item.personId === id);
  if (linkedUsers.some((item) => (item.role || item.roleId) === 'admin')) return notify('O administrador principal não pode ser desativado.', 'error');
  const activating = person.active === false;
  updateRecord('people', id, { active: activating }, user.id);
  if (!activating) linkedUsers.filter((item) => item.active).forEach((item) => updateRecord('users', item.id, { active: false }, user.id));
  render(); notify(activating ? 'Pessoa reativada. Libere o acesso ao app separadamente, se necessário.' : 'Pessoa e acesso ao app desativados.');
}

async function deletePerson(id) {
  if (!canCurrent('people:manage')) return notify('Seu perfil não pode apagar pessoas.', 'error');
  const person = personById(id); if (!person) return;
  const linkedUsers = (data.users || []).filter((item) => item.personId === id);
  if (linkedUsers.some((item) => item.id === user.id)) return notify('Você não pode apagar seu próprio cadastro.', 'error');
  if (linkedUsers.some((item) => (item.role || item.roleId) === 'admin')) return notify('O administrador principal não pode ser apagado.', 'error');
  if (isCaregiverPerson(person) && (user.role || user.roleId) !== 'admin') return notify('Somente o administrador pode apagar um cuidador com dados protegidos.', 'error');
  if (isCaregiverPerson(person) && adminAreaStatus === 'error') return notify('Reconecte a área administrativa antes de apagar este cuidador.', 'error');
  if (!window.confirm('Mover ' + person.fullName + ' e seus vínculos para a lixeira por 30 dias?')) return;
  const purgeAt = new Date(); purgeAt.setDate(purgeAt.getDate() + 30);
  if (isCaregiverPerson(person) && adminData?.caregivers?.[id]) await savePrivateCaregiverPatch(id, { scheduledPurgeAfter: purgeAt.toISOString() });
  movePersonToTrash(person, linkedUsers, purgeAt.toISOString());
  selectedPersonId = null; currentPage = 'people'; render(); notify('Pessoa e vínculos movidos para a lixeira.');
}
function moveToTrash(collection, id, label) {
  const record = (data[collection] || []).find((item) => item.id === id); if (!record) return;
  const deletedAt = new Date(); const purgeAt = new Date(deletedAt); purgeAt.setDate(purgeAt.getDate() + 30);
  addRecord('trash', { collection, originalId: id, label, record: structuredClone(record), deletedAt: deletedAt.toISOString(), purgeAfter: purgeAt.toISOString() }, user.id);
  removeRecord(collection, id, user.id);
}

function movePersonToTrash(person, linkedUsers = [], scheduledPurgeAfter = '') {
  const deletedAt = new Date();
  const purgeAt = scheduledPurgeAfter ? new Date(scheduledPurgeAfter) : new Date(deletedAt);
  if (!scheduledPurgeAfter) purgeAt.setDate(purgeAt.getDate() + 30);
  const userIds = new Set(linkedUsers.map((item) => item.id));
  const relatedRecords = {
    users: linkedUsers.map((item) => structuredClone(item)),
    caregiverProfiles: (data.caregiverProfiles || []).filter((item) => item.personId === person.id).map((item) => structuredClone(item)),
    accessGrants: (data.accessGrants || []).filter((item) => item.personId === person.id || item.subjectPersonId === person.id || userIds.has(item.userId)).map((item) => structuredClone(item))
  };
  const trashItem = addRecord('trash', { collection: 'people', originalId: person.id, label: person.fullName, record: structuredClone(person), relatedRecords, deletedAt: deletedAt.toISOString(), purgeAfter: purgeAt.toISOString() }, user.id);
  for (const [collection, records] of Object.entries(relatedRecords)) {
    for (const record of records) if ((data[collection] || []).some((item) => item.id === record.id)) removeRecord(collection, record.id, user.id);
  }
  removeRecord('people', person.id, user.id);
  return trashItem;
}
function collectStoredPaths(value, result = new Set(), seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return result;
  if (seen.has(value)) return result;
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (['filePath', 'photoPath', 'avatarPath'].includes(key) && typeof item === 'string' && item) result.add(item);
    else if (key === 'proofFilePaths' && Array.isArray(item)) item.filter(Boolean).forEach((path) => result.add(path));
    else if (item && typeof item === 'object') collectStoredPaths(item, result, seen);
  }
  return result;
}

async function purgeExpiredTrash() {
  if (!canCurrent('people:manage')) return false;
  const records = Array.isArray(data.trash) ? data.trash : [];
  const now = Date.now();
  const expired = records.filter((item) => {
    const expiresAt = Date.parse(item?.purgeAfter || '');
    return Number.isFinite(expiresAt) && expiresAt <= now;
  });
  if (!expired.length) return false;
  const protectedPaths = new Set();
  for (const [key, value] of Object.entries(data)) if (key !== 'trash') collectStoredPaths(value, protectedPaths);
  for (const item of records) if (!expired.includes(item)) collectStoredPaths(item, protectedPaths);
  const purgedIds = new Set();
  for (const item of expired) {
    try {
      for (const path of collectStoredPaths(item)) if (!protectedPaths.has(path)) await deleteFile(path);
      purgedIds.add(item.id);
    } catch (error) {
      notify('Um item vencido permaneceu na lixeira porque o arquivo não pôde ser excluído: ' + error.message, 'warning');
    }
  }
  if (!purgedIds.size) return false;
  data.trash = records.filter((item) => !purgedIds.has(item.id));
  saveData(data);
  return true;
}
async function restoreTrash(id) {
  if (!canCurrent('people:manage')) return notify('Seu perfil não pode restaurar itens.', 'error');
  const item = (data.trash || []).find((entry) => entry.id === id); if (!item) return;
  if ((data[item.collection] || []).some((record) => record.id === item.originalId)) return notify('Já existe um registro com este identificador.', 'error');
  if (item.collection === 'people' && item.relatedRecords?.users) {
    const conflict = item.relatedRecords.users.find((restored) => (data.users || []).some((current) => current.id === restored.id || (current.email && restored.email && current.email.toLowerCase() === restored.email.toLowerCase())));
    if (conflict) return notify('Não foi possível restaurar: o ID ou e-mail ' + (conflict.email || conflict.id) + ' já está em uso.', 'error');
  }
  if (item.collection === 'people' && adminData?.caregivers?.[item.originalId]) await savePrivateCaregiverPatch(item.originalId, { scheduledPurgeAfter: null });
  addRecord(item.collection, { ...item.record, id: item.originalId }, user.id);
  if (item.collection === 'people' && item.relatedRecords) {
    for (const collection of ['users', 'caregiverProfiles', 'accessGrants']) {
      for (const record of item.relatedRecords[collection] || []) {
        if (!(data[collection] || []).some((current) => current.id === record.id)) addRecord(collection, record, user.id);
      }
    }
  }
  removeRecord('trash', id, user.id); render(); notify(item.collection === 'people' ? 'Pessoa e vínculos restaurados. Confira o compartilhamento do OneDrive.' : 'Item restaurado.');
}

async function showPersonDocuments(personId) {
  if (!canCurrent('documents:view')) return notify('Seu perfil não pode abrir documentos.', 'error');
  const person = personById(personId); if (!person) return;
  const documents = (data.documents || []).filter((document) => document.personId === personId || person.documentIds?.includes(document.id));
  document.querySelector('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()"><button class="modal__close" data-action="close-modal" aria-label="Fechar">×</button><h2>Documentos de ${escape(person.fullName)}</h2><div class="record-list">${documents.map((document) => `<article class="record-card"><span class="record-icon">▣</span><div><h2>${escape(document.title)}</h2><small>${escape(document.category || 'Documento')}</small></div>${document.filePath ? `<button class="icon-button" data-action="open-document" data-path="${escape(document.filePath)}">›</button>` : ''}</article>`).join('') || emptyState('Nenhum documento relacionado.', 'Use Documentos para enviar e relacionar um arquivo.', '')}</div></section></div>`;
}
function lines(value) { return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }

async function saveChildProfile(form) {
  if (!canCurrent('child:edit')) throw new Error('Seu perfil não pode editar os dados da criança.');
  const values = new FormData(form);
  const updated = {
    ...profile(),
    name: String(values.get('name')).trim(),
    birthDate: String(values.get('birthDate') || ''),
    allergies: String(values.get('allergies') || '').split(',').map((item) => item.trim()).filter(Boolean),
    criticalNotes: String(values.get('criticalNotes') || '').trim(),
    healthPlan: String(values.get('healthPlan') || '').trim(),
    bloodType: String(values.get('bloodType') || '').trim(),
    address: String(values.get('address') || '').trim(),
    pediatricianPersonId: String(values.get('pediatricianPersonId') || '') || null,
    emergencyPersonIds: values.getAll('emergencyPersonIds').map(String)
  };
  const avatar = values.get('avatar');
  if (avatar?.size) {
    if (!pendingAvatarCrop?.blob || pendingAvatarCrop.fileName !== avatar.name) throw new Error('Abra a foto e confirme o enquadramento antes de salvar.');
    const filePath = 'Anexos/Perfil/avatar_' + Date.now() + '.jpg';
    await uploadFile(filePath, pendingAvatarCrop.blob, 'image/jpeg');
    updated.photoUrl = '';
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
  if (!canCurrent('users:manage')) throw new Error('Seu perfil não pode adicionar usuários.');
  const values = new FormData(form); const email = String(values.get('email')).trim().toLowerCase();
  if ((data.users || []).some((item) => item.email?.toLowerCase() === email)) throw new Error('Este e-mail já está cadastrado.');
  addRecord('users', { name: String(values.get('name')).trim(), email, role: String(values.get('role')), phone: '', active: true }, user.id); render(); notify('Usuário autorizado adicionado.');
}

async function importMigrationBundle(form) {
  if (!canCurrent('tasks:create')) throw new Error('Seu perfil não pode importar dados.');
  const file = new FormData(form).get('legacyBundle'); if (!file?.size) throw new Error('Selecione um pacote JSON.');
  const bundle = JSON.parse(await file.text()); lastMigrationReport = importLegacyBundle(data, bundle, user.id); saveData(data); render(); notify(lastMigrationReport.skipped ? 'Este pacote já tinha sido importado.' : 'Importação concluída.');
}

function saveHistoryFilter(form) { const values = new FormData(form); historyFilter = { period: String(values.get('period')), date: String(values.get('date') || localDate()), type: String(values.get('type') || '') }; render(); }
async function saveQuickRecord(form) {
  if (!canCurrent('logs:create')) return notify('Seu perfil não pode criar registros.', 'error');
  const formData = new FormData(form); const type = String(formData.get('type') || 'Observação'); const description = String(formData.get('description') || '').trim();
  if (!description) return notify('Escreva uma observação antes de salvar.', 'error');
  const file = formData.get('photo'); if (file?.size) await createPhoto({ file, caption: description, category: type });
  addRecord('dailyLogs', { date: localDate(), time: String(formData.get('time') || currentTime()), type, description, mood: '', symptoms: '', fileUrl: null, isImportant: false }, user.id);
  currentPage = 'home'; render(); notify('Registro salvo.');
}
function confirmReading() {
  const instruction = data.dailyInstructions.find((item) => item.date === localDate());
  if (!instruction || !canCurrent('instructions:confirm')) return notify('Seu perfil não pode confirmar a leitura.', 'error');
  addRecord('dailyConfirmations', { instructionId: instruction.id, userId: user.id, confirmedAt: new Date().toISOString(), message: 'Li e entendi as orientações do dia.' }, user.id);
  render(); notify('Leitura confirmada para os responsáveis.');
}

function completeTask(id, comment = '') {
  if (!canCurrent('tasks:complete')) return notify('Seu perfil não pode concluir tarefas.', 'error');
  const task = data.dailyTasks.find((item) => item.id === id); if (!task) return;
  const comments = comment ? [...(task.comments || []), { userId: user.id, comment, createdAt: new Date().toISOString() }] : task.comments || [];
  updateRecord('dailyTasks', id, { status: 'completed', completedBy: user.id, completedAt: new Date().toISOString(), comments }, user.id);
  render(); notify('Afazer marcado como feito.');
}
function openPhotoModal(taskId) {
  if (!canCurrent('photos:attach')) return notify('Seu perfil não pode enviar fotos.', 'error');
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
  const { blob } = await resizeImage(file);
  const id = `photo-${crypto.randomUUID()}`;
  const storageKey = eventPhotoPath(category, capturedAt);
  const record = {
    id,
    taskId,
    instructionId: data.dailyInstructions.find((item) => item.date === localDate())?.id || null,
    date: localDate(),
    category,
    filePath: storageKey,
    fileName: storageKey.split('/').at(-1),
    fileUrl: null,
    thumbnailUrl: '',
    caption,
    uploadedBy: user.id,
    uploadedAt: capturedAt.toISOString(),
    isImportant
  };
  try {
    await uploadFile(storageKey, blob, 'image/jpeg');
    addRecord('dailyPhotos', { ...record, syncStatus: 'synced', syncedAt: new Date().toISOString() }, user.id);
    return { pending: false };
  } catch (uploadError) {
    try {
      await queuePendingPhoto({ id: `pending-${id}`, namespace: dataNamespace, photoId: id, storageKey, blob, mimeType: 'image/jpeg', createdAt: capturedAt.toISOString() });
      addRecord('dailyPhotos', { ...record, syncStatus: 'pending' }, user.id);
      setSyncState('Pendente');
      return { pending: true };
    } catch {
      throw new Error('A foto não pôde ser enviada nem guardada na fila deste aparelho. Mantenha o arquivo original e tente novamente.');
    }
  }
}
async function offerLegacyPendingPhotoRecovery() {
  let legacy = [];
  try { legacy = await listPendingPhotos(); } catch { return false; }
  if (!legacy.length) return false;
  if (!window.confirm('Existem ' + legacy.length + ' foto(s) pendente(s) criadas por uma versão antiga. Elas pertencem a esta mesma conta e pasta do OneDrive?')) {
    notify('As fotos antigas foram preservadas neste aparelho e não foram enviadas para evitar a pasta errada.', 'warning');
    return false;
  }
  for (const item of legacy) await queuePendingPhoto({ ...item, namespace: dataNamespace });
  notify('Fotos antigas associadas a esta pasta. A sincronização será tentada agora.');
  return true;
}
async function syncPendingPhotoUploads() {
  let pending;
  try { pending = await listPendingPhotos(dataNamespace); }
  catch { return; }
  for (const item of pending) {
    if (!data.dailyPhotos?.some((photo) => photo.id === item.photoId)) { setSyncState('Pendente'); continue; }
    try {
      await uploadFile(item.storageKey, item.blob, item.mimeType || 'image/jpeg');
      if (data.dailyPhotos?.some((photo) => photo.id === item.photoId)) {
        updateRecord('dailyPhotos', item.photoId, { syncStatus: 'synced', syncedAt: new Date().toISOString(), thumbnailUrl: '' }, user.id);
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
  setSyncState(hasPendingChanges() ? 'Pendente' : 'Sincronizado');
  render();
}

async function restoreBackupFromPrompt() {
  if ((user.role || user.roleId) !== 'admin') throw new Error('Somente o administrador pode restaurar backups.');
  await flushPersistence();
  if (hasPendingChanges()) throw new Error('Existem alterações pendentes. Sincronize ou exporte uma cópia antes de restaurar.');
  const suggested = `Backup/dados_${localDate()}.json`;
  const path = window.prompt('Informe o caminho do backup no OneDrive:', suggested);
  if (!path) return;
  const normalizedPath = path.trim().replace(/\\/g, '/');
  if (!/^Backup\/[^/]+\.json$/i.test(normalizedPath)) throw new Error('Escolha somente um arquivo JSON diretamente dentro de Backup/.');
  const previousData = structuredClone(data);
  const previousUser = user;
  setPersistence({});
  try {
    const candidate = await restoreDB(normalizedPath);
    data = structuredClone(candidate);
    prepareCurrentData();
    assertAccountAuthorized(microsoftAccount, data);
    const email = String(previousUser.email || microsoftAccount.username || '').toLowerCase();
    const preservedAdmin = (data.users || []).find((item) => String(item.email || '').toLowerCase() === email && item.active && (item.role || item.roleId) === 'admin');
    if (!preservedAdmin) throw new Error('Este backup não mantém o administrador atual ativo. A restauração foi cancelada.');
    await loadData(data);
    user = preservedAdmin;
    await tryLoadAdminArea(false);
    await migrateLegacyPrivateCaregiverData();
    await migrateEmbeddedImages();
    cleanupOrphanCaregiverProfiles();
    await purgeExpiredTrash();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeJsonFile(`Backup/antes_restauracao_${stamp}.json`, previousData);
    const saved = await saveDB(data, { skipBackup: true });
    data.meta = saved.meta;
    setDataBaseVersion(getDBVersion());
    data = await loadData(data);
    user = resolveAuthorizedUser(microsoftAccount);
    microsoftUser = user;
    configurePersistence();
    saveData(data);
    render();
    notify('Backup validado, protegido e restaurado.');
  } catch (error) {
    data = previousData;
    user = previousUser;
    await loadData(previousData);
    configurePersistence();
    throw error;
  }
}
async function saveVaccine(form) {
  const values = new FormData(form); const vaccineId = String(values.get('vaccineId') || ''); const appliedDate = String(values.get('appliedDate') || '');
  if (!canCurrent(vaccineId ? 'vaccines:edit' : 'vaccines:create')) throw new Error('Seu perfil não pode alterar vacinas.');
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
  if (!canCurrent('vaccines:edit')) throw new Error('Seu perfil não pode anexar comprovantes.');
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
  if (!canCurrent('vaccines:edit')) return notify('Seu perfil não pode editar vacinas.', 'error');
  const vaccine = data.vaccines.find((item) => item.id === id); if (!vaccine) return;
  const proofCount = (vaccine.proofFilePaths || []).length;
  document.querySelector('#modal-root').innerHTML = '<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()"><button class="modal__close" data-action="close-modal" aria-label="Fechar">×</button><h2>Editar vacina</h2><form id="vaccine-form"><input type="hidden" name="vaccineId" value="' + vaccine.id + '"><label>Data da aplicação<input name="appliedDate" type="date" value="' + escape(vaccine.appliedDate || '') + '" required></label><div class="form-grid"><label>Vacina<input name="name" value="' + escape(vaccine.name) + '" required></label><label>Dose<input name="dose" value="' + escape(vaccine.dose) + '" required></label></div><div class="form-grid"><label>Lote<input name="batch" value="' + escape(vaccine.batch || '') + '"></label><label>Local<input name="location" value="' + escape(vaccine.location || '') + '"></label></div><label>Observação<textarea name="notes" rows="3">' + escape(vaccine.notes || '') + '</textarea></label><label>Adicionar comprovantes (pode escolher vários)<input name="proofs" type="file" accept="image/*,application/pdf" multiple></label><p class="permission-note">' + proofCount + ' comprovante(s) já anexado(s).</p><button class="button button--wide" type="submit">Salvar alterações</button></form></section></div>';
}

function deleteVaccine(id) {
  if (!canCurrent('vaccines:delete')) return notify('Seu perfil não pode apagar vacinas.', 'error');
  const vaccine = data.vaccines.find((item) => item.id === id); if (!vaccine) return;
  if (!window.confirm('Mover ' + vaccine.name + ' (' + vaccine.dose + ') para a lixeira por 30 dias?')) return;
  moveToTrash('vaccines', id, vaccine.name + ' ' + vaccine.dose); selectedVaccineId = null; currentPage = 'vaccines'; render(); notify('Vacina movida para a lixeira.');
}

function clearExampleVaccines() {
  if (!canCurrent('vaccines:delete')) return notify('Seu perfil não pode apagar vacinas.', 'error');
  const examples = data.vaccines.filter(isExampleVaccine); if (!examples.length) return notify('Não há vacinas de exemplo.');
  if (!window.confirm('Apagar ' + examples.length + ' vacina(s) de exemplo?')) return;
  examples.forEach((item) => removeRecord('vaccines', item.id, user.id)); render(); notify('Vacinas de exemplo apagadas.');
}

function clearAllExampleData() {
  if ((user.role || user.roleId) !== 'admin') return notify('Somente o administrador pode remover exemplos.', 'error');
  const count = DATA_COLLECTIONS.reduce((total, collection) => total + (data[collection] || []).filter(isDemoRecord).length, 0);
  const childIsDemo = data.childProfile?.isDemo === true || /exemplo|demonstra|demo/i.test(String(data.childProfile?.name || ''));
  if (!count && !childIsDemo) return notify('Nenhum dado de exemplo foi encontrado.');
  if (!window.confirm('Remover definitivamente ' + (count + (childIsDemo ? 1 : 0)) + ' dado(s) de exemplo? Registros reais não serão alterados.')) return;
  for (const collection of DATA_COLLECTIONS) data[collection] = (data[collection] || []).filter((item) => !isDemoRecord(item));
  if (childIsDemo) data.childProfile = { id: 'child-maria-elis', name: 'Maria Elis', birthDate: '', photoUrl: 'assets/icons/child-avatar.svg', healthPlan: '', bloodType: '', allergies: [], criticalNotes: '', address: '' };
  if (!(data.users || []).length) data.meta.bootstrapCompleted = false;
  data.meta.demoCleanupAt = new Date().toISOString();
  saveData(data); render(); notify('Dados de exemplo removidos.');
}
function isExampleVaccine(vaccine) { return String(vaccine.id || '').includes('-demo') || /exemplo/i.test(String(vaccine.name || '') + ' ' + String(vaccine.notes || '')); }
function vaccineProofPath(fileName, date) { const parts = date.split('-'); return 'Anexos/Vacinas/' + parts[0] + '/' + parts[1] + '/' + date + '_' + safeFileName(fileName); }
async function saveAttachment(form) {
  if (!canCurrent('documents:create')) throw new Error('Seu perfil não pode enviar documentos.');
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
    sensitivity: 'sensitive',
    caregiverVisible: formData.get('caregiverVisible') === 'on'
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js?v=16').catch(() => {});
}


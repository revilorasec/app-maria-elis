const SCHEMA_VERSION = 2;

/**
 * Migra, em memória, um banco legado para o schema 2.
 * É idempotente e preserva as coleções legadas durante a transição da UI.
 *
 * @param {Record<string, any>} data
 * @returns {Record<string, any>} o mesmo objeto, migrado
 */
export function migrateSchemaV2(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('Os dados precisam ser um objeto JSON válido.');
  }

  data.meta = isObject(data.meta) ? data.meta : {};
  for (const name of ['people', 'caregiverProfiles', 'accessGrants', 'trash']) {
    data[name] = Array.isArray(data[name]) ? data[name] : [];
  }

  // Compatibilidade temporária com as telas que ainda leem o schema 1.
  for (const name of ['emergencyContacts', 'doctors', 'users']) {
    data[name] = Array.isArray(data[name]) ? data[name] : [];
  }

  data.people = data.people
    .filter((person) => isObject(person))
    .map(normalizePerson);

  for (const contact of data.emergencyContacts) {
    const person = upsertPerson(data.people, 'emergencyContacts', contact, {
      primaryType: 'emergency-contact',
      types: ['emergency-contact']
    });
    if (person && !contact.personId) contact.personId = person.id;
  }

  for (const doctor of data.doctors) {
    const primaryType = /pediatr|neonat/i.test(
      String(doctor?.specialty || '') + ' ' + String(doctor?.role || '')
    ) ? 'pediatrician' : 'doctor';
    const person = upsertPerson(data.people, 'doctors', doctor, {
      primaryType,
      types: [primaryType, 'doctor']
    });
    if (person && !doctor.personId) doctor.personId = person.id;
  }

  for (const user of data.users) {
    const primaryType = typeForRole(user.role);
    const person = upsertPerson(data.people, 'users', user, {
      primaryType,
      types: unique(['user', primaryType, user.role]),
      permissions: user.permissions
    });
    if (!person) continue;
    user.personId = person.id;
    if (text(user.role).toLowerCase() === 'caregiver') {
      ensureCaregiverProfile(data.caregiverProfiles, user, person);
    }
  }

  removeEmptyPrivateCaregiverFields(data);

  if (typeof data.meta.bootstrapCompleted !== 'boolean') {
    data.meta.bootstrapCompleted = data.users.some(isRealUser);
  }
  data.meta.schemaVersion = SCHEMA_VERSION;
  return data;
}

const IDENTITY_PRIVATE_KEYS = ['cpf', 'rg', 'birthDate', 'dateOfBirth', 'privateBirthDate', 'salary', 'salaryCents', 'contract', 'contracts', 'personalData', 'employment', 'privateDocuments', 'personalDocuments'];
const PROFILE_PRIVATE_KEYS = [...IDENTITY_PRIVATE_KEYS, 'documents', 'documentIds', 'professionalReferences', 'documentNotes', 'documentExpiry', 'emergencyContact', 'terminationDate', 'notes'];

function removeEmptyPrivateCaregiverFields(data) {
  const ids = caregiverPersonIds(data);
  const clean = (record, keys) => {
    if (!record) return;
    for (const key of keys) if (Object.prototype.hasOwnProperty.call(record, key) && !meaningful(record[key])) delete record[key];
  };
  for (const record of data?.people || []) if (ids.has(record.id)) clean(record, IDENTITY_PRIVATE_KEYS);
  for (const record of data?.users || []) if (ids.has(record.personId)) clean(record, IDENTITY_PRIVATE_KEYS);
  for (const record of data?.caregiverProfiles || []) clean(record, PROFILE_PRIVATE_KEYS);
  visitTrashCaregiverRecords(data, clean);
}
export function hasLegacyPrivateCaregiverData(data) {
  const ids = caregiverPersonIds(data);
  let trashHasPrivateData = false;
  visitTrashCaregiverRecords(data, (record, keys) => { if (hasAnyKey(record, keys)) trashHasPrivateData = true; });
  return (data?.people || []).some((record) => ids.has(record.id) && hasAnyKey(record, IDENTITY_PRIVATE_KEYS))
    || (data?.users || []).some((record) => ids.has(record.personId) && hasAnyKey(record, IDENTITY_PRIVATE_KEYS))
    || (data?.caregiverProfiles || []).some((record) => hasAnyKey(record, PROFILE_PRIVATE_KEYS))
    || trashHasPrivateData;
}

export function extractLegacyPrivateCaregiverData(data) {
  const ids = caregiverPersonIds(data);
  const caregivers = {};
  let changed = false;
  const move = (record, personId, keys) => {
    if (!record || !personId) return;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const value = record[key];
      delete record[key];
      changed = true;
      if (!meaningful(value)) continue;
      const target = caregivers[personId] ||= {};
      assignPrivateValue(target, key, value);
    }
  };
  for (const record of data?.people || []) if (ids.has(record.id)) move(record, record.id, IDENTITY_PRIVATE_KEYS);
  for (const record of data?.users || []) if (ids.has(record.personId)) move(record, record.personId, IDENTITY_PRIVATE_KEYS);
  for (const record of data?.caregiverProfiles || []) move(record, record.personId, PROFILE_PRIVATE_KEYS);
  visitTrashCaregiverRecords(data, (record, keys, personId) => move(record, personId, keys));
  return { changed, caregivers };
}

function caregiverPersonIds(data) {
  const ids = new Set((data?.caregiverProfiles || []).map((record) => record?.personId).filter(Boolean));
  for (const user of data?.users || []) if (text(user.role || user.roleId).toLowerCase() === 'caregiver' && user.personId) ids.add(user.personId);
  for (const person of data?.people || []) {
    const types = unique([person.primaryType, ...(Array.isArray(person.types) ? person.types : [])]);
    if (types.some((type) => type === 'caregiver' || type === 'babysitter')) ids.add(person.id);
  }
  for (const entry of data?.trash || []) {
    const record = entry?.record || {};
    if (entry.collection === 'caregiverProfiles' && record.personId) ids.add(record.personId);
    if (entry.collection === 'users' && text(record.role || record.roleId).toLowerCase() === 'caregiver' && record.personId) ids.add(record.personId);
    if (entry.collection === 'people') {
      const types = unique([record.primaryType, ...(Array.isArray(record.types) ? record.types : [])]);
      if (types.some((type) => type === 'caregiver' || type === 'babysitter')) ids.add(record.id || entry.originalId);
    }
    for (const profile of entry.relatedRecords?.caregiverProfiles || []) if (profile.personId) ids.add(profile.personId);
    for (const user of entry.relatedRecords?.users || []) if (text(user.role || user.roleId).toLowerCase() === 'caregiver' && user.personId) ids.add(user.personId);
  }
  return ids;
}

function visitTrashCaregiverRecords(data, callback) {
  const ids = caregiverPersonIds(data);
  for (const entry of data?.trash || []) {
    const record = entry?.record;
    if (entry.collection === 'people' && record && ids.has(record.id || entry.originalId)) callback(record, IDENTITY_PRIVATE_KEYS, record.id || entry.originalId);
    if (entry.collection === 'users' && record && ids.has(record.personId)) callback(record, IDENTITY_PRIVATE_KEYS, record.personId);
    if (entry.collection === 'caregiverProfiles' && record?.personId) callback(record, PROFILE_PRIVATE_KEYS, record.personId);
    for (const user of entry.relatedRecords?.users || []) if (ids.has(user.personId)) callback(user, IDENTITY_PRIVATE_KEYS, user.personId);
    for (const profile of entry.relatedRecords?.caregiverProfiles || []) if (profile.personId) callback(profile, PROFILE_PRIVATE_KEYS, profile.personId);
  }
}

function hasAnyKey(record, keys) {
  return Boolean(record) && keys.some((key) => Object.prototype.hasOwnProperty.call(record, key) && meaningful(record[key]));
}

function meaningful(value) {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

function assignPrivateValue(target, key, value) {
  if (key === 'dateOfBirth' || key === 'privateBirthDate') { target.birthDate = value; return; }
  if (key === 'salary') {
    const parsed = Number(String(value).replace(/\./g, '').replace(',', '.'));
    target.salaryCents = Number.isFinite(parsed) ? Math.round(parsed * 100) : value;
    return;
  }
  if (key === 'contract' || key === 'contracts') {
    const values = Array.isArray(value) ? value : [value];
    target.legacyContracts = [...(target.legacyContracts || []), ...values];
    return;
  }
  if (['documents', 'documentIds', 'privateDocuments', 'personalDocuments'].includes(key)) {
    const values = Array.isArray(value) ? value : [value];
    target.legacyDocuments = [...(target.legacyDocuments || []), ...values];
    return;
  }
  if (key === 'personalData' || key === 'employment') {
    const details = isObject(value) ? value : { legacyValue: value };
    target[key] = { ...(isObject(target[key]) ? target[key] : {}), ...details };
    if (key === 'personalData') {
      if (meaningful(details.cpf) && !meaningful(target.cpf)) target.cpf = details.cpf;
      if (meaningful(details.rg) && !meaningful(target.rg)) target.rg = details.rg;
      if (meaningful(details.birthDate || details.dateOfBirth) && !meaningful(target.birthDate)) target.birthDate = details.birthDate || details.dateOfBirth;
    }
    if (key === 'employment') {
      if (meaningful(details.salaryCents) && !meaningful(target.salaryCents)) target.salaryCents = details.salaryCents;
      if (meaningful(details.salary) && !meaningful(target.salaryCents)) {
        const parsed = Number(String(details.salary).replace(/\./g, '').replace(',', '.'));
        if (Number.isFinite(parsed)) target.salaryCents = Math.round(parsed * 100);
      }
    }
    return;
  }
  if (key === 'notes') { target.administrativeNotes = value; return; }
  target[key] = value;
}
function upsertPerson(people, legacySource, source, options) {
  if (!isObject(source)) return null;
  const legacyId = text(source.id);
  const email = text(source.email).toLowerCase();
  const fullName = sourceName(source);
  const nameKey = lookup(fullName);

  let person = people.find((item) => source.personId && item.id === source.personId);
  if (!person && legacyId) {
    person = people.find(
      (item) => item.legacySource === legacySource && String(item.legacyId) === legacyId
    );
  }
  if (!person && email) {
    person = people.find((item) => text(item.email).toLowerCase() === email);
  }
  const phoneKey = digits(source.phone || source.whatsapp);
  if (!person && nameKey && phoneKey) {
    person = people.find((item) => lookup(item.fullName) === nameKey && digits(item.phone || item.whatsapp) === phoneKey);
  }

  if (!person) {
    person = normalizePerson({
      id: personIdFor(legacySource, source),
      entityKind: 'person',
      primaryType: options.primaryType,
      types: options.types,
      fullName,
      relationship: source.relationship,
      photoPath: source.photoPath || source.avatarPath,
      photoUrl: source.photoUrl || source.avatarUrl,
      phone: source.phone,
      whatsapp: source.whatsapp,
      email: source.email,
      address: source.address,
      priority: source.priority,
      notes: source.notes,
      active: source.active,
      relatedPersonIds: source.relatedPersonIds,
      documentIds: source.documentIds,
      permissions: options.permissions ?? source.permissions,
      legacySource,
      legacyId: legacyId || null,
      timestamps: {
        createdAt: source.createdAt || new Date().toISOString(),
        updatedAt: source.updatedAt || source.createdAt || null
      }
    });
    people.push(person);
    return person;
  }

  mergePerson(person, source, legacySource, legacyId, options);
  return person;
}

function normalizePerson(person) {
  const createdAt = person.timestamps?.createdAt || person.createdAt || null;
  const updatedAt = person.timestamps?.updatedAt || person.updatedAt || createdAt;
  return {
    ...person,
    id: text(person.id) || 'person-' + token(JSON.stringify(person)),
    entityKind: text(person.entityKind) || 'person',
    primaryType: text(person.primaryType) || 'contact',
    types: unique([person.primaryType, ...(Array.isArray(person.types) ? person.types : [])]),
    fullName: text(person.fullName || person.name),
    relationship: text(person.relationship),
    photoPath: text(person.photoPath),
    photoUrl: text(person.photoUrl),
    phone: text(person.phone),
    whatsapp: whatsapp(person.whatsapp, person.phone),
    email: text(person.email),
    address: address(person.address),
    priority: person.priority === undefined || person.priority === '' ? null : person.priority,
    notes: text(person.notes),
    active: person.active !== false,
    relatedPersonIds: unique(person.relatedPersonIds),
    documentIds: unique(person.documentIds),
    permissions: permissions(person.permissions),
    legacySource: text(person.legacySource) || null,
    legacyId: person.legacyId === undefined || person.legacyId === '' ? null : person.legacyId,
    timestamps: { createdAt, updatedAt }
  };
}

function mergePerson(person, source, legacySource, legacyId, options) {
  person.entityKind = 'person';
  person.types = unique([...(person.types || []), ...(options.types || [])]);
  if (!person.primaryType || person.primaryType === 'contact') {
    person.primaryType = options.primaryType || person.primaryType;
  }
  fill(person, 'fullName', sourceName(source));
  fill(person, 'relationship', source.relationship);
  fill(person, 'photoPath', source.photoPath || source.avatarPath);
  fill(person, 'photoUrl', source.photoUrl || source.avatarUrl);
  fill(person, 'phone', source.phone);
  fill(person, 'whatsapp', whatsapp(source.whatsapp, source.phone));
  fill(person, 'email', source.email);
  if (emptyAddress(person.address) && source.address) person.address = address(source.address);
  if (person.priority === null && source.priority !== undefined && source.priority !== '') {
    person.priority = source.priority;
  }
  fill(person, 'notes', source.notes);
  if (source.active === false) person.active = false;
  person.relatedPersonIds = unique([
    ...(person.relatedPersonIds || []),
    ...(source.relatedPersonIds || [])
  ]);
  person.documentIds = unique([
    ...(person.documentIds || []),
    ...(source.documentIds || [])
  ]);
  person.permissions = mergePermissions(
    person.permissions,
    options.permissions ?? source.permissions
  );
  if (!person.legacySource) person.legacySource = legacySource;
  if (!person.legacyId && legacyId) person.legacyId = legacyId;
}

function ensureCaregiverProfile(profiles, user, person) {
  const userId = text(user.id) || null;
  let profile = profiles.find(
    (item) => item?.personId === person.id || (userId && String(item?.userId) === userId)
  );
  if (profile) {
    if (!profile.personId) profile.personId = person.id;
    if (!profile.userId && userId) profile.userId = userId;
    return profile;
  }

  const createdAt = user.createdAt || person.timestamps.createdAt || new Date().toISOString();
  profile = {
    id: 'caregiver-profile-' + token(userId || person.id),
    personId: person.id,
    userId,
    status: user.active === false ? 'inactive' : 'active',
    startDate: '',
    function: '',
    workSchedule: [],
    experience: '',
    courses: [],
    firstAidTraining: { completed: false },
    completedSteps: [],
    onboardingCompletedAt: null,
    timestamps: { createdAt, updatedAt: user.updatedAt || null },
    legacySource: 'users',
    legacyId: userId
  };
  profiles.push(profile);
  return profile;
}

function address(value) {
  if (isObject(value)) {
    return {
      line1: text(value.line1 || value.street || value.addressLine),
      line2: text(value.line2 || value.complement),
      district: text(value.district || value.neighborhood),
      city: text(value.city),
      state: text(value.state),
      postalCode: text(value.postalCode || value.zipCode || value.cep),
      country: text(value.country),
      formatted: text(value.formatted),
      latitude: value.latitude == null || value.latitude === '' ? null : Number(value.latitude),
      longitude: value.longitude == null || value.longitude === '' ? null : Number(value.longitude)
    };
  }
  return {
    line1: '',
    line2: '',
    district: '',
    city: '',
    state: '',
    postalCode: '',
    country: '',
    formatted: text(value),
    latitude: null,
    longitude: null
  };
}

function typeForRole(role) {
  const value = text(role).toLowerCase();
  if (value === 'caregiver') return 'caregiver';
  if (value === 'guardian' || value === 'admin') return 'guardian';
  if (value === 'grandparent') return 'grandparent';
  if (value === 'visitor') return 'visitor';
  return 'contact';
}

function isRealUser(user) {
  if (!isObject(user)) return false;
  const identity = (
    String(user.id || '') + ' ' + String(user.name || '') + ' ' + String(user.email || '')
  ).toLowerCase();
  if (/\b(demo|example|exemplo|teste|test)\b/.test(identity) || /\.invalid\b/.test(identity)) {
    return false;
  }
  return Boolean(text(user.email) || text(user.name));
}

function personIdFor(source, item) {
  const basis = text(item.id) || text(item.email) || sourceName(item) || JSON.stringify(item);
  return 'person-' + source.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-' + token(basis);
}

function sourceName(source) {
  return text(source.fullName || source.name || source.doctorName);
}

function permissions(value) {
  if (Array.isArray(value)) return unique(value);
  if (isObject(value)) return { ...value };
  return [];
}

function mergePermissions(current, incoming) {
  if (Array.isArray(current) || Array.isArray(incoming)) {
    return unique([
      ...(Array.isArray(current) ? current : []),
      ...(Array.isArray(incoming) ? incoming : [])
    ]);
  }
  if (isObject(current) || isObject(incoming)) {
    return {
      ...(isObject(current) ? current : {}),
      ...(isObject(incoming) ? incoming : {})
    };
  }
  return [];
}

function digits(value) {
  return text(value).replace(/\D/g, '');
}

function whatsapp(value, phone) {
  if (value === true) return text(phone);
  if (value === false || value === undefined || value === null) return '';
  return text(value);
}

function fill(target, field, value) {
  if (!text(target[field]) && text(value)) target[field] = text(value);
}

function emptyAddress(value) {
  return !value || Object.values(value).every((item) => !text(item));
}

function unique(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(text).filter(Boolean))];
}

function lookup(value) {
  return text(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function token(value) {
  const source = text(value);
  const slug = source
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (slug || 'item') + '-' + (hash >>> 0).toString(36);
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
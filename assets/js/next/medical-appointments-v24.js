
import { supabase, currentSession } from './supabase.js?v=20';
import { uploadFile } from './file-picker.js?v=20';
import { syncMedicationTasks } from './care-service.js?v=20';
import { enableMedicationAlerts, scheduleMedicationRemindersForMedication } from './medication-reminders.js?v=1';

let overlay = null;
let appointments = [];
let context = null;
let saving = false;
let nextMedicationIndex = 0;
let nextExamIndex = 0;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
}[c]));
const attr = esc;

function localDateTimeValue(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16);
}
function isoOrEmpty(raw) {
  if (!raw) return '';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
function numText(raw) {
  const v = String(raw ?? '').trim().replace(',','.');
  if (!v) return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '';
}
function todayIso() { return new Date().toISOString().slice(0,10); }
function tomorrowNine() {
  const d = new Date();
  d.setDate(d.getDate()+1); d.setHours(9,0,0,0);
  return localDateTimeValue(d);
}
function formatDateTime(value) {
  if (!value) return 'Data não informada';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Data não informada';
  return new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(d);
}
function toast(message, error=false) {
  let region = document.querySelector('#medical-v24-toast');
  if (!region) {
    region = document.createElement('div');
    region.id = 'medical-v24-toast';
    region.className = 'medical-v24-toast-region';
    document.body.append(region);
  }
  const box = document.createElement('div');
  box.className = 'medical-v24-toast' + (error ? ' medical-v24-toast--error' : '');
  box.textContent = message;
  region.append(box);
  setTimeout(()=>box.remove(), error ? 7000 : 3500);
}
async function getContext(force=false) {
  if (context && !force) return context;
  const session = await currentSession();
  if (!session) throw new Error('Sua sessão expirou. Entre novamente no app.');
  const result = await supabase.rpc('my_access_context');
  if (result.error) throw result.error;
  if (!result.data?.active || !result.data?.family_id) throw new Error('Não foi possível identificar sua família ativa.');
  context = {...result.data, session};
  return context;
}
async function loadAppointments() {
  const ctx = await getContext();
  const result = await supabase.from('medical_appointments').select('*').eq('family_id',ctx.family_id).order('appointment_at',{ascending:false});
  if (result.error) throw result.error;
  appointments = result.data || [];
}
async function loadCareItems(appointmentId) {
  if (!appointmentId) return { medications: [], exams: [] };
  const [meds, exams] = await Promise.all([
    supabase.from('medications').select('*,medication_schedules(*)').eq('source_appointment_id',appointmentId).order('created_at',{ascending:true}),
    supabase.from('medical_appointment_exams').select('*').eq('appointment_id',appointmentId).order('created_at',{ascending:true}),
  ]);
  if (meds.error) throw meds.error;
  if (exams.error) throw exams.error;
  return { medications: meds.data || [], exams: exams.data || [] };
}
function closeOverlay() {
  overlay?.remove();
  document.querySelectorAll('.medical-v24-overlay').forEach((n)=>n.remove());
  overlay = null;
}
function card(row) {
  const details = [row.specialty,row.doctor_name].filter(Boolean).join(' · ') || 'Consulta médica';
  const hasOutcome = Boolean(row.diagnosis || row.medical_notes || row.recommendations || row.prescribed_medications || row.ordered_exams || row.vaccines_guidance || row.parent_notes);
  return `<article class="medical-v24-card">
    <div><small>${esc(formatDateTime(row.appointment_at))}</small><h3>${esc(details)}</h3>
    ${row.reason ? `<p>${esc(row.reason)}</p>` : ''}
    <span>${hasOutcome ? 'Registro preenchido' : (new Date(row.appointment_at)<new Date() ? 'Aguardando registro' : 'Agendada')}</span></div>
    <button type="button" class="button button--secondary button--small" data-medical-edit="${attr(row.id)}">Editar</button>
  </article>`;
}
async function openList() {
  try {
    await getContext(true);
    await loadAppointments();
    closeOverlay();
    overlay = document.createElement('div');
    overlay.className = 'medical-v24-overlay';
    overlay.innerHTML = `<section class="medical-v24-panel">
      <header class="medical-v24-header"><div><p class="medical-v24-eyebrow">Saúde</p><h2>Consultas médicas</h2><p>Histórico completo antes, durante e depois da consulta.</p></div><button type="button" class="medical-v24-close" data-medical-close>×</button></header>
      <div class="medical-v24-toolbar"><button type="button" class="button" data-medical-new>＋ Nova consulta</button></div>
      <section class="medical-v24-list">${appointments.length ? appointments.map(card).join('') : '<div class="medical-v24-empty"><strong>Nenhuma consulta cadastrada.</strong></div>'}</section>
    </section>`;
    document.body.append(overlay);
  } catch(e) { console.error(e); toast(e.message || 'Não foi possível abrir as consultas.',true); }
}
function section(title,subtitle,body) {
  return `<section class="medical-v24-section"><div class="medical-v24-section-head"><h3>${esc(title)}</h3>${subtitle?`<p>${esc(subtitle)}</p>`:''}</div>${body}</section>`;
}
function medicationItemMarkup(item={}, index=nextMedicationIndex++) {
  const times = (item.medication_schedules || []).filter(x=>x.active!==false).map(x=>String(x.time_of_day||'').slice(0,5));
  const renderTimes = (times.length ? times : ['']).map((time)=>`<div class="medical-v24-time-row"><input type="time" data-med-time value="${attr(time)}"><button type="button" class="medical-v24-icon-btn" data-med-remove-time aria-label="Remover horário">×</button></div>`).join('');
  const photos = Array.isArray(item.photo_file_ids) ? item.photo_file_ids.length : 0;
  return `<article class="medical-v24-item" data-med-item data-index="${index}">
    <input type="hidden" data-med-id value="${attr(item.id||'')}">
    <div class="medical-v24-item-head"><strong>Medicamento</strong><button type="button" class="medical-v24-remove" data-med-remove>Remover</button></div>
    <div class="medical-v24-grid medical-v24-grid--2">
      <label>Nome do medicamento<input data-med-name value="${attr(item.name||'')}" placeholder="Ex.: Amoxicilina"></label>
      <label>Dose<input data-med-dose value="${attr(item.dose||'')}" placeholder="Ex.: 5 ml"></label>
    </div>
    <div class="medical-v24-grid medical-v24-grid--2">
      <label>Via<input data-med-route value="${attr(item.route||'')}" placeholder="Ex.: Oral"></label>
      <label>Início<input type="date" data-med-start value="${attr(item.starts_on||todayIso())}"></label>
    </div>
    <label>Instruções de uso<textarea data-med-guidance rows="2" placeholder="Ex.: após alimentação, agitar antes de usar...">${esc(item.guidance||'')}</textarea></label>
    <div class="medical-v24-grid medical-v24-grid--2">
      <label>Término <span class="medical-v24-optional">opcional</span><input type="date" data-med-end value="${attr(item.ends_on||'')}"></label>
      <div><span class="medical-v24-field-label">Horários</span><div data-med-times>${renderTimes}</div><button type="button" class="button button--secondary button--small" data-med-add-time>＋ Horário</button></div>
    </div>
    <div class="medical-v24-attachments">
      <label class="medical-v24-file">Fotos do remédio <small>${photos ? photos+' foto(s) já anexada(s)' : 'Você pode selecionar mais de uma'}</small><input type="file" data-med-photos accept="image/*" multiple></label>
      <label class="medical-v24-file">Bula <small>${item.leaflet_file_id ? 'Bula já anexada' : 'PDF ou imagem'}</small><input type="file" data-med-leaflet accept="application/pdf,image/*"></label>
    </div>
    <p class="medical-v24-helper">Ao salvar, os horários viram tarefas e lembretes de medicamento.</p>
  </article>`;
}
function examItemMarkup(item={}, index=nextExamIndex++) {
  return `<article class="medical-v24-item" data-exam-item data-index="${index}">
    <input type="hidden" data-exam-id value="${attr(item.id||'')}">
    <input type="hidden" data-exam-task-id value="${attr(item.task_id||'')}">
    <div class="medical-v24-item-head"><strong>Exame solicitado</strong><button type="button" class="medical-v24-remove" data-exam-remove>Remover</button></div>
    <label>Exame<input data-exam-name value="${attr(item.name||'')}" placeholder="Ex.: Hemograma"></label>
    <label>Orientações<textarea data-exam-instructions rows="2" placeholder="Jejum, laboratório, preparo...">${esc(item.instructions||'')}</textarea></label>
    <label>Prazo / quando fazer<input type="datetime-local" data-exam-due value="${attr(item.due_at ? localDateTimeValue(item.due_at) : tomorrowNine())}"></label>
    <p class="medical-v24-helper">Este exame aparecerá como tarefa até ser concluído.</p>
  </article>`;
}
function formMarkup(row, care) {
  nextMedicationIndex = 0; nextExamIndex = 0;
  const meds = care.medications || [];
  const exams = care.exams || [];
  return `<form id="medical-v24-form" class="medical-v24-form">
    <input type="hidden" name="id" value="${attr(row?.id||'')}">
    <input type="hidden" name="legacy_prescribed_medications" value="${attr(row?.prescribed_medications||'')}">
    <input type="hidden" name="legacy_ordered_exams" value="${attr(row?.ordered_exams||'')}">

    ${section('1. Consulta','Informações do agendamento.',`
      <div class="medical-v24-grid medical-v24-grid--2">
        <label>Data e horário <span class="medical-v24-optional">opcional</span><input name="appointment_at" type="datetime-local" value="${attr(row?.appointment_at ? localDateTimeValue(row.appointment_at) : '')}"></label>
        <label>Especialidade <span class="medical-v24-required">obrigatório</span><input name="specialty" required value="${attr(row?.specialty||'')}" placeholder="Ex.: Pediatria"></label>
      </div>
      <div class="medical-v24-grid medical-v24-grid--2">
        <label>Médico(a) / profissional<input name="doctor_name" value="${attr(row?.doctor_name||'')}"></label>
        <label>Clínica / hospital<input name="clinic_or_hospital" value="${attr(row?.clinic_or_hospital||'')}"></label>
      </div>
      <label>Motivo da consulta<textarea name="reason" rows="2">${esc(row?.reason||'')}</textarea></label>`)}

    ${section('2. Durante a consulta','As medidas são formatadas automaticamente.',`
      <label>Queixa principal<textarea name="chief_complaint" rows="2">${esc(row?.chief_complaint||'')}</textarea></label>
      <label>Histórico relatado<textarea name="history_reported" rows="3">${esc(row?.history_reported||'')}</textarea></label>
      <div class="medical-v24-grid medical-v24-grid--4">
        <label>Peso (kg)<input name="weight_kg" data-format="measure-3" inputmode="decimal" value="${attr(row?.weight_kg??'')}"></label>
        <label>Altura (cm)<input name="height_cm" data-format="measure-1" inputmode="decimal" value="${attr(row?.height_cm??'')}"></label>
        <label>Perímetro cefálico (cm)<input name="head_circumference_cm" data-format="measure-1" inputmode="decimal" value="${attr(row?.head_circumference_cm??'')}"></label>
        <label>Temperatura (°C)<input name="temperature_c" data-format="measure-1" inputmode="decimal" value="${attr(row?.temperature_c??'')}"></label>
      </div>`)}

    ${section('3. Como foi a consulta','Medicamentos e exames agora são listas estruturadas e geram tarefas.',`
      <label>Diagnóstico / avaliação<textarea name="diagnosis" rows="2">${esc(row?.diagnosis||'')}</textarea></label>
      <label>Anotações médicas<textarea name="medical_notes" rows="3">${esc(row?.medical_notes||'')}</textarea></label>
      <label>Orientações e recomendações<textarea name="recommendations" rows="3">${esc(row?.recommendations||'')}</textarea></label>

      <div class="medical-v24-subsection">
        <div class="medical-v24-subsection-head"><div><h4>Medicamentos prescritos</h4><p>Adicione um por um, com horários e instruções.</p></div><button type="button" class="button button--secondary button--small" data-med-add>＋ Medicamento</button></div>
        ${(!meds.length && row?.prescribed_medications) ? `<div class="medical-v24-legacy"><strong>Registro anterior:</strong> ${esc(row.prescribed_medications)}</div>` : ''}
        <div data-med-list>${meds.map((m)=>medicationItemMarkup(m)).join('')}</div>
      </div>

      <div class="medical-v24-subsection">
        <div class="medical-v24-subsection-head"><div><h4>Exames solicitados</h4><p>Cada exame vira uma tarefa com prazo.</p></div><button type="button" class="button button--secondary button--small" data-exam-add>＋ Exame</button></div>
        ${(!exams.length && row?.ordered_exams) ? `<div class="medical-v24-legacy"><strong>Registro anterior:</strong> ${esc(row.ordered_exams)}</div>` : ''}
        <div data-exam-list>${exams.map((x)=>examItemMarkup(x)).join('')}</div>
      </div>

      <label>Orientações sobre vacinas<textarea name="vaccines_guidance" rows="2">${esc(row?.vaccines_guidance||'')}</textarea></label>
      <div class="medical-v24-grid medical-v24-grid--2">
        <label>Próximo retorno<input name="return_at" type="datetime-local" value="${attr(row?.return_at?localDateTimeValue(row.return_at):'')}"></label>
        <label>Observações dos pais<textarea name="parent_notes" rows="2">${esc(row?.parent_notes||'')}</textarea></label>
      </div>`)}

    <div class="medical-v24-footer"><button type="button" class="button button--secondary" data-medical-back>Voltar</button><button type="submit" class="button" data-medical-save>Salvar consulta</button></div>
  </form>`;
}
async function openEditor(id='') {
  const row = id ? appointments.find(x=>x.id===id) : null;
  if (id && !row) return toast('Consulta não encontrada.',true);
  try {
    const care = await loadCareItems(id);
    closeOverlay();
    overlay = document.createElement('div');
    overlay.className = 'medical-v24-overlay';
    overlay.innerHTML = `<section class="medical-v24-panel medical-v24-panel--form"><header class="medical-v24-header"><div><p class="medical-v24-eyebrow">Consultas médicas</p><h2>${row?'Editar consulta':'Nova consulta'}</h2><p>Você pode salvar rápido e completar os dados depois.</p></div><button type="button" class="medical-v24-close" data-medical-close>×</button></header>${formMarkup(row,care)}</section>`;
    document.body.append(overlay);
  } catch(e) { console.error(e); toast(e.message || 'Não foi possível abrir a consulta.',true); }
}
function readMedicationItems(form) {
  return [...form.querySelectorAll('[data-med-item]')].map((node)=>({
    node,
    id: node.querySelector('[data-med-id]')?.value || '',
    name: node.querySelector('[data-med-name]')?.value.trim() || '',
    dose: node.querySelector('[data-med-dose]')?.value.trim() || '',
    route: node.querySelector('[data-med-route]')?.value.trim() || '',
    guidance: node.querySelector('[data-med-guidance]')?.value.trim() || '',
    starts_on: node.querySelector('[data-med-start]')?.value || todayIso(),
    ends_on: node.querySelector('[data-med-end]')?.value || '',
    times: [...node.querySelectorAll('[data-med-time]')].map(x=>x.value).filter(Boolean),
    photoInput: node.querySelector('[data-med-photos]'),
    leafletInput: node.querySelector('[data-med-leaflet]'),
  })).filter(x=>x.name || x.dose || x.guidance || x.times.length);
}
function readExamItems(form) {
  return [...form.querySelectorAll('[data-exam-item]')].map((node)=>({
    node,
    id: node.querySelector('[data-exam-id]')?.value || '',
    task_id: node.querySelector('[data-exam-task-id]')?.value || '',
    name: node.querySelector('[data-exam-name]')?.value.trim() || '',
    instructions: node.querySelector('[data-exam-instructions]')?.value.trim() || '',
    due_at: isoOrEmpty(node.querySelector('[data-exam-due]')?.value || ''),
  })).filter(x=>x.name || x.instructions);
}
async function uploadMedicationAttachments(item, medication, session) {
  const updates = {};
  const existingPhotos = Array.isArray(medication.photo_file_ids) ? medication.photo_file_ids : [];
  const newPhotoIds = [];
  for (const file of [...(item.photoInput?.files || [])]) {
    const uploaded = await uploadFile(file,{fileType:'medication-photo',category:'medication',relatedRecordType:'medication',relatedRecordId:medication.id});
    if (uploaded?.id) newPhotoIds.push(uploaded.id);
  }
  if (newPhotoIds.length) updates.photo_file_ids = [...existingPhotos,...newPhotoIds];
  const leaflet = item.leafletInput?.files?.[0];
  if (leaflet) {
    const uploaded = await uploadFile(leaflet,{fileType:'medication-leaflet',category:'medication',relatedRecordType:'medication',relatedRecordId:medication.id});
    if (uploaded?.id) updates.leaflet_file_id = uploaded.id;
  }
  if (Object.keys(updates).length) {
    updates.updated_by = session.user.id;
    const result = await supabase.from('medications').update(updates).eq('id',medication.id).select('*').single();
    if (result.error) throw result.error;
    return result.data;
  }
  return medication;
}
async function syncMedications(appointment, items, ctx) {
  const existingResult = await supabase.from('medications').select('*,medication_schedules(*)').eq('source_appointment_id',appointment.id);
  if (existingResult.error) throw existingResult.error;
  const existing = existingResult.data || [];
  const kept = new Set();
  for (const item of items) {
    if (!item.name) throw new Error('Informe o nome de cada medicamento adicionado.');
    if (!item.times.length) throw new Error(`Informe pelo menos um horário para ${item.name}.`);
    const payload = {
      family_id: ctx.family_id,
      name: item.name,
      kind: item.ends_on ? 'temporary' : 'continuous',
      dose: item.dose,
      route: item.route,
      guidance: item.guidance,
      starts_on: item.starts_on || todayIso(),
      ends_on: item.ends_on || null,
      frequency: 'scheduled',
      frequency_description: item.times.join(', '),
      active: true,
      source_appointment_id: appointment.id,
      updated_by: ctx.session.user.id,
    };
    let medication;
    if (item.id) {
      const result = await supabase.from('medications').update(payload).eq('id',item.id).eq('family_id',ctx.family_id).select('*').single();
      if (result.error) throw result.error;
      medication = result.data;
    } else {
      const result = await supabase.from('medications').insert({...payload,created_by:ctx.session.user.id}).select('*').single();
      if (result.error) throw result.error;
      medication = result.data;
    }
    kept.add(medication.id);
    await supabase.from('care_tasks').delete().eq('medication_id',medication.id).eq('status','pending').gte('due_at',new Date().toISOString());
    const delSchedules = await supabase.from('medication_schedules').delete().eq('medication_id',medication.id);
    if (delSchedules.error) throw delSchedules.error;
    const scheduleResult = await supabase.from('medication_schedules').insert(item.times.map(time=>({medication_id:medication.id,time_of_day:time,active:true}))).select('*');
    if (scheduleResult.error) throw scheduleResult.error;
    medication = await uploadMedicationAttachments(item, medication, ctx.session);
    const rangeStart = item.starts_on || todayIso();
    const end = item.ends_on ? new Date(item.ends_on+'T23:59:59') : new Date();
    if (!item.ends_on) end.setDate(end.getDate()+30);
    await syncMedicationTasks(supabase,medication,scheduleResult.data||[],rangeStart,end.toISOString().slice(0,10));
    await scheduleMedicationRemindersForMedication(medication.id).catch(()=>{});
  }
  for (const old of existing) {
    if (kept.has(old.id)) continue;
    await supabase.from('care_tasks').delete().eq('medication_id',old.id).eq('status','pending').gte('due_at',new Date().toISOString());
    await supabase.from('medication_schedules').delete().eq('medication_id',old.id);
    await supabase.from('medications').update({active:false,updated_by:ctx.session.user.id}).eq('id',old.id);
  }
}
async function syncExams(appointment, items, ctx) {
  const existingResult = await supabase.from('medical_appointment_exams').select('*').eq('appointment_id',appointment.id);
  if (existingResult.error) throw existingResult.error;
  const existing = existingResult.data || [];
  const kept = new Set();
  for (const item of items) {
    if (!item.name) throw new Error('Informe o nome de cada exame adicionado.');
    const dueAt = item.due_at || isoOrEmpty(tomorrowNine());
    let taskId = item.task_id || null;
    const taskPayload = {
      family_id: ctx.family_id,
      title: 'Realizar exame: ' + item.name,
      due_at: dueAt,
      status: 'pending',
      note: '',
      task_kind: 'other',
      instructions: item.instructions,
      assigned_role: 'all',
      requires_photo: false,
      requires_note: false,
      priority: 2,
    };
    if (taskId) {
      const taskUpdate = await supabase.from('care_tasks').update(taskPayload).eq('id',taskId).select('id').maybeSingle();
      if (taskUpdate.error) throw taskUpdate.error;
      if (!taskUpdate.data?.id) taskId = null;
    }
    if (!taskId) {
      const taskInsert = await supabase.from('care_tasks').insert(taskPayload).select('id').single();
      if (taskInsert.error) throw taskInsert.error;
      taskId = taskInsert.data.id;
    }
    const examPayload = {
      family_id: ctx.family_id,
      appointment_id: appointment.id,
      name: item.name,
      instructions: item.instructions,
      due_at: dueAt,
      task_id: taskId,
      updated_by: ctx.session.user.id,
    };
    let exam;
    if (item.id) {
      const result = await supabase.from('medical_appointment_exams').update(examPayload).eq('id',item.id).select('*').single();
      if (result.error) throw result.error;
      exam = result.data;
    } else {
      const result = await supabase.from('medical_appointment_exams').insert({...examPayload,created_by:ctx.session.user.id}).select('*').single();
      if (result.error) throw result.error;
      exam = result.data;
    }
    kept.add(exam.id);
  }
  for (const old of existing) {
    if (kept.has(old.id)) continue;
    if (old.task_id) await supabase.from('care_tasks').delete().eq('id',old.task_id);
    await supabase.from('medical_appointment_exams').delete().eq('id',old.id);
  }
}
async function save(form) {
  if (saving) return;
  saving = true;
  const button = form.querySelector('[data-medical-save]');
  if (button) { button.disabled=true; button.textContent='Salvando…'; }
  const medicationItems = readMedicationItems(form);
  const examItems = readExamItems(form);
  const alertsPromise = medicationItems.length ? enableMedicationAlerts().catch(()=>false) : Promise.resolve(false);
  try {
    const ctx = await getContext(true);
    const f = new FormData(form);
    const specialty = String(f.get('specialty')||'').trim();
    if (!specialty) throw new Error('Informe pelo menos a especialidade.');
    const medSummary = medicationItems.length ? medicationItems.map(x=>[x.name,x.dose,x.times.join('/')].filter(Boolean).join(' — ')).join('\n') : String(f.get('legacy_prescribed_medications')||'').trim();
    const examSummary = examItems.length ? examItems.map(x=>x.name).join('\n') : String(f.get('legacy_ordered_exams')||'').trim();
    const payload = {
      id: String(f.get('id')||'').trim() || null,
      family_id: ctx.family_id,
      doctor_name: String(f.get('doctor_name')||'').trim(),
      specialty,
      clinic_or_hospital: String(f.get('clinic_or_hospital')||'').trim(),
      appointment_at: isoOrEmpty(f.get('appointment_at')) || new Date().toISOString(),
      reason: String(f.get('reason')||'').trim(),
      chief_complaint: String(f.get('chief_complaint')||'').trim(),
      history_reported: String(f.get('history_reported')||'').trim(),
      weight_kg: numText(f.get('weight_kg')),
      height_cm: numText(f.get('height_cm')),
      head_circumference_cm: numText(f.get('head_circumference_cm')),
      temperature_c: numText(f.get('temperature_c')),
      diagnosis: String(f.get('diagnosis')||'').trim(),
      medical_notes: String(f.get('medical_notes')||'').trim(),
      recommendations: String(f.get('recommendations')||'').trim(),
      prescribed_medications: medSummary,
      ordered_exams: examSummary,
      vaccines_guidance: String(f.get('vaccines_guidance')||'').trim(),
      return_at: isoOrEmpty(f.get('return_at')),
      parent_notes: String(f.get('parent_notes')||'').trim(),
    };
    const result = await supabase.rpc('save_medical_appointment',{payload});
    if (result.error) throw result.error;
    const appointment = result.data;
    await syncMedications(appointment,medicationItems,ctx);
    await syncExams(appointment,examItems,ctx);
    await alertsPromise;
    toast(payload.id ? 'Consulta atualizada com tarefas e lembretes.' : 'Consulta salva com tarefas e lembretes.');
    await openList();
  } catch(e) {
    console.error('Falha ao salvar consulta',e);
    toast('Erro ao salvar: ' + (e?.message || 'falha desconhecida'),true);
    if (button) { button.disabled=false; button.textContent='Salvar consulta'; }
  } finally { saving=false; }
}
function enhance() {
  const main = document.querySelector('#main-content');
  const heading = main?.querySelector('.page-heading h1,.next-page-heading h1');
  const title = heading?.textContent?.trim();
  if (title==='Mais') {
    const grid = main.querySelector('.next-feature-grid');
    if (grid && !grid.querySelector('[data-medical-open]')) {
      const b=document.createElement('button'); b.type='button'; b.className='medical-v24-feature'; b.dataset.medicalOpen='1';
      b.innerHTML='<span>✚</span><div><strong>Consultas médicas</strong><small>Agendar, registrar, medicamentos e exames</small></div>';
      grid.prepend(b);
    }
  }
  if (title==='Agenda') {
    const ph=heading.closest('.page-heading,.next-page-heading');
    if (ph && !ph.querySelector('[data-medical-open]')) {
      const b=document.createElement('button'); b.type='button'; b.className='button button--secondary button--small'; b.dataset.medicalOpen='1'; b.textContent='Consultas médicas'; ph.append(b);
    }
  }
}
function consume(e){e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();}
document.addEventListener('click',async(e)=>{
  if(e.target.closest('[data-medical-open]')){consume(e);return openList();}
  if(e.target.closest('[data-medical-close]')){consume(e);return closeOverlay();}
  if(e.target.closest('[data-medical-new]')){consume(e);return openEditor();}
  const edit=e.target.closest('[data-medical-edit]'); if(edit){consume(e);return openEditor(edit.dataset.medicalEdit||'');}
  if(e.target.closest('[data-medical-back]')){consume(e);return openList();}
  if(e.target.closest('[data-med-add]')){consume(e);const list=overlay?.querySelector('[data-med-list]');if(list)list.insertAdjacentHTML('beforeend',medicationItemMarkup());return;}
  if(e.target.closest('[data-exam-add]')){consume(e);const list=overlay?.querySelector('[data-exam-list]');if(list)list.insertAdjacentHTML('beforeend',examItemMarkup());return;}
  const medRemove=e.target.closest('[data-med-remove]'); if(medRemove){consume(e);medRemove.closest('[data-med-item]')?.remove();return;}
  const examRemove=e.target.closest('[data-exam-remove]'); if(examRemove){consume(e);examRemove.closest('[data-exam-item]')?.remove();return;}
  const addTime=e.target.closest('[data-med-add-time]'); if(addTime){consume(e);const times=addTime.closest('[data-med-item]')?.querySelector('[data-med-times]');if(times)times.insertAdjacentHTML('beforeend','<div class="medical-v24-time-row"><input type="time" data-med-time><button type="button" class="medical-v24-icon-btn" data-med-remove-time>×</button></div>');return;}
  const removeTime=e.target.closest('[data-med-remove-time]'); if(removeTime){consume(e);const wrap=removeTime.closest('[data-med-times]');const rows=wrap?.querySelectorAll('.medical-v24-time-row')||[];if(rows.length>1)removeTime.closest('.medical-v24-time-row')?.remove();else{const input=removeTime.parentElement?.querySelector('input');if(input)input.value='';}return;}
},true);
document.addEventListener('change',(e)=>{
  const input=e.target;
  if (!(input instanceof HTMLInputElement) || input.type!=='file') return;
  const label=input.closest('label');
  const small=label?.querySelector('small');
  if (!small || !input.files?.length) return;
  small.textContent = input.files.length===1 ? input.files[0].name : input.files.length+' arquivos selecionados';
},true);
document.addEventListener('submit',async(e)=>{
  if(e.target?.id!=='medical-v24-form') return;
  consume(e);
  await save(e.target);
},true);

function styles(){
  if(document.querySelector('#medical-v24-styles'))return;
  const s=document.createElement('style');s.id='medical-v24-styles';s.textContent=`
.medical-v24-feature{appearance:none;border:1px solid var(--border,rgba(58,87,82,.18));background:var(--surface,#fff);border-radius:18px;padding:1rem;text-align:left;display:flex;align-items:center;gap:.8rem;min-height:92px;color:inherit;font:inherit;cursor:pointer;width:100%;box-shadow:0 8px 24px rgba(41,62,58,.06)}.medical-v24-feature>span{width:42px;height:42px;border-radius:14px;display:grid;place-items:center;background:rgba(47,111,102,.12);font-size:1.25rem;color:#2f6f66}.medical-v24-feature strong,.medical-v24-feature small{display:block}.medical-v24-feature small{margin-top:.28rem;opacity:.72}
.medical-v24-overlay{position:fixed;inset:0;z-index:10000;background:var(--surface,#fff);overflow:auto}.medical-v24-panel{width:min(1160px,100%);min-height:100dvh;margin:0 auto;padding:clamp(1rem,3vw,2rem) clamp(1rem,4vw,2.5rem) max(2rem,env(safe-area-inset-bottom));color:var(--text,#20302d)}.medical-v24-panel--form{width:min(1040px,100%)}.medical-v24-header{display:flex;justify-content:space-between;gap:1rem;position:sticky;top:0;background:var(--surface,#fff);z-index:4;padding:.75rem 0;border-bottom:1px solid var(--border,rgba(58,87,82,.12))}.medical-v24-header h2{margin:.1rem 0 .25rem}.medical-v24-header p{margin:0;opacity:.7}.medical-v24-eyebrow{text-transform:uppercase;letter-spacing:.09em;font-size:.72rem;font-weight:800;color:#2f6f66!important;opacity:1!important}.medical-v24-close{border:0;background:transparent;font-size:2rem;color:inherit}.medical-v24-toolbar{display:flex;justify-content:flex-end;padding:1rem 0}.medical-v24-list{display:grid;gap:.75rem}.medical-v24-card{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:1rem;border:1px solid var(--border,rgba(58,87,82,.15));border-radius:16px}.medical-v24-card small{font-weight:700;color:#2f6f66}.medical-v24-card h3{margin:.25rem 0}.medical-v24-card p{margin:.2rem 0 .5rem}.medical-v24-card span{font-size:.76rem;font-weight:700;color:#2f6f66}.medical-v24-empty{text-align:center;padding:2rem;border:1px dashed var(--border,rgba(58,87,82,.25));border-radius:16px}
.medical-v24-form{display:grid;gap:1rem;padding-top:1rem}.medical-v24-section{display:grid;gap:1rem;border:1px solid var(--border,rgba(58,87,82,.15));border-radius:18px;padding:1rem}.medical-v24-section-head h3{margin:0}.medical-v24-section-head p{margin:.2rem 0 0;opacity:.68}.medical-v24-form label{display:grid;gap:.38rem;font-weight:650;font-size:.88rem}.medical-v24-form input,.medical-v24-form textarea{width:100%;box-sizing:border-box;border:1px solid var(--border,rgba(58,87,82,.2));border-radius:12px;padding:.78rem .85rem;background:var(--surface,#fff);color:inherit;font:inherit}.medical-v24-required,.medical-v24-optional{font-size:.72rem;font-weight:600}.medical-v24-required{color:#2f6f66}.medical-v24-optional{opacity:.6}.medical-v24-grid{display:grid;gap:.75rem}.medical-v24-grid--2{grid-template-columns:repeat(2,minmax(0,1fr))}.medical-v24-grid--4{grid-template-columns:repeat(4,minmax(0,1fr))}
.medical-v24-subsection{display:grid;gap:.75rem;padding:1rem;border-radius:16px;background:rgba(47,111,102,.045)}.medical-v24-subsection-head{display:flex;align-items:center;justify-content:space-between;gap:1rem}.medical-v24-subsection-head h4{margin:0}.medical-v24-subsection-head p{margin:.15rem 0 0;font-size:.85rem;opacity:.7}.medical-v24-item{display:grid;gap:.75rem;padding:1rem;border:1px solid var(--border,rgba(58,87,82,.15));border-radius:14px;background:var(--surface,#fff)}.medical-v24-item-head{display:flex;justify-content:space-between;align-items:center}.medical-v24-remove{border:0;background:transparent;color:#9b2c2c;font-weight:700}.medical-v24-field-label{display:block;font-weight:650;font-size:.88rem;margin-bottom:.38rem}.medical-v24-time-row{display:grid;grid-template-columns:1fr auto;gap:.5rem;margin-bottom:.45rem}.medical-v24-icon-btn{width:42px;border:1px solid var(--border,rgba(58,87,82,.2));border-radius:10px;background:#fff;font-size:1.2rem}.medical-v24-attachments{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem}.medical-v24-file{border:1px dashed var(--border,rgba(58,87,82,.25));border-radius:12px;padding:.8rem}.medical-v24-file small{font-weight:400;opacity:.65}.medical-v24-helper{margin:0;font-size:.8rem;opacity:.65}.medical-v24-legacy{padding:.75rem;border-radius:10px;background:#fff8df;font-size:.85rem}
.medical-v24-footer{display:flex;justify-content:flex-end;gap:.75rem;position:sticky;bottom:0;background:var(--surface,#fff);padding:1rem 0 calc(1rem + env(safe-area-inset-bottom));border-top:1px solid var(--border,rgba(58,87,82,.12))}.medical-v24-toast-region{position:fixed;z-index:12000;top:calc(.8rem + env(safe-area-inset-top));left:50%;transform:translateX(-50%);width:min(92vw,560px);display:grid;gap:.5rem}.medical-v24-toast{background:#225d54;color:#fff;padding:.9rem 1rem;border-radius:12px;font-weight:700;box-shadow:0 12px 32px rgba(0,0,0,.25)}.medical-v24-toast--error{background:#8b2f2f}
@media(max-width:700px){.medical-v24-panel{padding-top:max(1rem,env(safe-area-inset-top))}.medical-v24-grid--2,.medical-v24-grid--4,.medical-v24-attachments{grid-template-columns:1fr}.medical-v24-card{align-items:flex-start}.medical-v24-subsection-head{align-items:flex-start;flex-direction:column}.medical-v24-subsection-head .button{width:100%}.medical-v24-footer .button{flex:1}}
`;document.head.append(s);
}
styles();
new MutationObserver(()=>requestAnimationFrame(enhance)).observe(document.querySelector('#app'),{childList:true,subtree:true});
enhance();
console.info('APP MARIA consultas v24 ativa');

import { supabase } from './supabase.js?v=20';

function throwIfError(result) {
  if (result.error) throw result.error;
  return result.data;
}

export async function listRoutineTasks(from, to, { includeAllAssignments = false, statuses = null, limit = 500 } = {}) {
  let query = supabase.from('care_tasks')
    .select('*,care_task_items(*)')
    .order('due_at', { ascending: true })
    .limit(limit);
  if (from) query = query.gte('due_at', from);
  if (to) query = query.lte('due_at', to);
  if (Array.isArray(statuses) && statuses.length) query = query.in('status', statuses);
  if (!includeAllAssignments) query = query.in('assigned_role', ['caregiver', 'all']);
  return throwIfError(await query) || [];
}

export async function listOpenRoutineTasks({ includeAllAssignments = false, limit = 500 } = {}) {
  return listRoutineTasks(null, null, {
    includeAllAssignments,
    statuses: ['pending', 'in_progress', 'late'],
    limit,
  });
}

export async function loadRoutineTask(id) {
  const task = throwIfError(await supabase.from('care_tasks').select('*,care_task_items(*)').eq('id', id).single());
  const updates = throwIfError(await supabase.from('care_task_updates').select('*').eq('task_id', id).order('created_at', { ascending: true })) || [];
  return { ...task, care_task_updates: updates };
}

export async function createRoutineTask(task, checklist = []) {
  const created = throwIfError(await supabase.from('care_tasks').insert(task).select().single());
  const items = checklist.map((label, index) => ({ task_id: created.id, label, position: index + 1 }));
  if (items.length) throwIfError(await supabase.from('care_task_items').insert(items));
  return created;
}

export async function respondRoutineTask(taskId, status, note = '', fileId = null) {
  const result = await supabase.rpc('respond_to_care_task', {
    target_task_id: taskId,
    target_status: status,
    target_note: note,
    target_file_id: fileId,
  });
  if (result.error) throw result.error;
}

export async function toggleRoutineItem(itemId, completed) {
  const result = await supabase.rpc('set_care_task_item_completed', {
    target_item_id: itemId,
    target_completed: Boolean(completed),
  });
  if (result.error) throw result.error;
}

export async function startRoutineTask(taskId) {
  const result = await supabase.rpc('start_care_task', { target_task_id: taskId });
  if (result.error) throw result.error;
}

export async function stopRoutineTask(taskId) {
  const result = await supabase.rpc('stop_care_task', { target_task_id: taskId });
  if (result.error) throw result.error;
}

export async function listRoutineTemplates() {
  return throwIfError(await supabase.from('routine_templates')
    .select('*,routine_template_items(*)')
    .eq('active', true)
    .order('sort_order')
    .order('title')) || [];
}

export async function loadRoutineTemplate(id) {
  return throwIfError(await supabase.from('routine_templates')
    .select('*,routine_template_items(*)')
    .eq('id', id)
    .single());
}

export async function saveRoutineTemplate(template, checklist = []) {
  const payload = { ...template };
  const id = payload.id;
  delete payload.id;
  let saved;
  if (id) saved = throwIfError(await supabase.from('routine_templates').update(payload).eq('id', id).select().single());
  else saved = throwIfError(await supabase.from('routine_templates').insert(payload).select().single());
  if (id) throwIfError(await supabase.from('routine_template_items').delete().eq('template_id', saved.id));
  const items = checklist.map((label, index) => ({ template_id: saved.id, label, position: index + 1, active: true }));
  if (items.length) throwIfError(await supabase.from('routine_template_items').insert(items));
  return saved;
}

export async function listDailyLogs(from, to) {
  return throwIfError(await supabase.from('daily_logs').select('*').gte('occurred_at', from).lte('occurred_at', to).order('occurred_at', { ascending: false })) || [];
}

export async function createDailyLog(payload) {
  return throwIfError(await supabase.from('daily_logs').insert(payload).select().single());
}

export async function attachDailyLogFile(logId, fileId) {
  const result = await supabase.from('daily_logs').update({ photo_file_id: fileId }).eq('id', logId);
  if (result.error) throw result.error;
}

export async function listEmergencyHospitals() {
  return throwIfError(await supabase.from('emergency_hospitals').select('*').eq('active', true).order('priority').order('name')) || [];
}

export async function createEmergencyHospital(payload) {
  return throwIfError(await supabase.from('emergency_hospitals').insert(payload).select().single());
}

export async function listUpcomingEvents({ from = null, to = null, limit = 500 } = {}) {
  let query = supabase.from('calendar_events')
    .select('*')
    .eq('active', true)
    .order('starts_at', { ascending: true })
    .limit(limit);
  if (from) query = query.or(`starts_at.gte.${from},ends_at.gte.${from}`);
  if (to) query = query.lte('starts_at', to);
  const events = throwIfError(await query) || [];
  if (!events.length) return events;
  const acknowledgementsResult = await supabase.from('event_acknowledgements')
    .select('event_id,user_id,acknowledged_at')
    .in('event_id', events.map((event) => event.id));
  const acknowledgements = acknowledgementsResult.error ? [] : (acknowledgementsResult.data || []);
  return events.map((event) => ({
    ...event,
    event_acknowledgements: acknowledgements.filter((item) => item.event_id === event.id),
  }));
}

export async function acknowledgeEvent(eventId) {
  const result = await supabase.rpc('acknowledge_calendar_event', { target_event_id: eventId });
  if (result.error) throw result.error;
  return result.data;
}

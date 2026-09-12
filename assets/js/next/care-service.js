const isoDay = (value) => new Date(value).toISOString().slice(0,10);
const at = (day,time) => new Date(day+'T'+time+':00').toISOString();
export function buildMedicationTasks(medication, schedules, from, to) {
  if (!medication?.active || !medication?.id) return [];
  const start=new Date(Math.max(new Date(medication.starts_on||medication.startsOn||from),new Date(from)));
  const end=new Date(Math.min(new Date(medication.ends_on||medication.endsOn||to),new Date(to)));
  const allowed=Array.isArray(medication.weekdays)&&medication.weekdays.length?new Set(medication.weekdays.map(Number)):null;
  const rows=[];
  for(let cursor=new Date(start);cursor<=end;cursor.setDate(cursor.getDate()+1)){
    if(allowed&&!allowed.has(cursor.getDay()))continue;
    for(const schedule of schedules.filter(item=>item.active!==false)){
      rows.push({family_id:medication.family_id,medication_id:medication.id,schedule_id:schedule.id,due_at:at(isoDay(cursor),String(schedule.time_of_day||schedule.timeOfDay).slice(0,5)),title:'Administrar '+medication.name,task_kind:'medication',assigned_role:'caregiver',instructions:medication.guidance||medication.instructions||'',status:'pending'});
    }
  }
  return rows;
}
export function futureOnly(tasks, now=new Date()) { return tasks.filter(task=>new Date(task.due_at)>now&&task.status==='pending'); }
export async function syncMedicationTasks(supabase, medication, schedules, from, to) {
  const candidates=buildMedicationTasks(medication,schedules,from,to);
  if(!candidates.length)return {created:0,skipped:0};
  const {data:existing,error}=await supabase.from('care_tasks').select('medication_id,schedule_id,due_at').eq('medication_id',medication.id).gte('due_at',from).lte('due_at',to);
  if(error)throw error;
  const keys=new Set((existing||[]).map(item=>item.medication_id+'|'+item.schedule_id+'|'+item.due_at));
  const insert=candidates.filter(item=>!keys.has(item.medication_id+'|'+item.schedule_id+'|'+item.due_at));
  if(insert.length){const {error:insertError}=await supabase.from('care_tasks').insert(insert);if(insertError)throw insertError;}
  return {created:insert.length,skipped:candidates.length-insert.length};
}
export async function completeCareTask(supabase,id,{status='completed',note='',proof_file_id=null}={}) {
  if(!['completed','late','refused','unable','in_progress'].includes(status))throw new Error('Status inválido.');
  const {error}=await supabase.rpc('respond_to_care_task',{target_task_id:id,target_status:status,target_note:note,target_file_id:proof_file_id});
  if(error)throw error;
}

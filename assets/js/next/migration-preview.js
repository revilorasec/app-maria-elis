const stable = (value) => JSON.stringify(value,Object.keys(value||{}).sort());
const hash = (value) => {let code=2166136261;for(const char of stable(value)){code^=char.charCodeAt(0);code=Math.imul(code,16777619);}return (code>>>0).toString(36);};
export function planLegacyImport(source,{knownHashes=new Set()}={}) {
  const collections=['people','documents','vaccines','appointments','medications','dailyTasks','dailyPhotos'];
  const items=[];
  for(const collection of collections)for(const record of Array.isArray(source?.[collection])?source[collection]:[]){
    const sourceId=String(record?.id||hash(record));const sourceHash=hash(record);const status=knownHashes.has(collection+':'+sourceId+':'+sourceHash)?'duplicate':'review';
    items.push({collection,sourceId,sourceHash,status,reason:status==='duplicate'?'Já importado em execução anterior':'Requer validação antes da importação'});
  }
  return {summary:items.reduce((acc,item)=>{acc[item.status]=(acc[item.status]||0)+1;return acc;},{}),items};
}
export function rollbackPlan(plan){return {safe:true,actions:(plan?.items||[]).filter(item=>item.status==='imported').map(item=>({collection:item.collection,sourceId:item.sourceId,action:'delete_target_created_by_run'}))};}

import { FILE_GATEWAY_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js?v=20';
import { supabase, currentSession } from './supabase.js?v=20';
async function request(action, options={}) {
  const session = await currentSession();
  if(!session)throw new Error('Sessão expirada.');
  const response=await fetch(FILE_GATEWAY_URL+'?action='+action,{...options,headers:{apikey:SUPABASE_PUBLISHABLE_KEY,Authorization:'Bearer '+session.access_token,...(options.headers||{})}});
  if(!response.ok)throw new Error('Operação de documento não autorizada.');
  return response;
}
export async function listDocuments(status='active',scope='documents'){const response=await request('list&status='+encodeURIComponent(status)+'&scope='+encodeURIComponent(scope));return (await response.json()).files||[];}
export async function archiveDocument(fileId,reason=''){await request('archive',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fileId,reason})});}
export async function restoreDocument(fileId){await request('restore',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fileId})});}
export async function updateDocumentMetadata(fileId,metadata){await request('metadata',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fileId,...metadata})});}
export async function openDocument(fileId){return request('download?fileId='+encodeURIComponent(fileId));}
export async function replaceDocument(fileId,file){const form=new FormData();form.set('fileId',fileId);form.set('file',file);return request('replace',{method:'POST',body:form});}

export async function cropImage(file, { zoom = 1, x = 0.5, y = 0.5, size = 640 } = {}) {
  if (!file?.type?.startsWith('image/')) throw new Error('Selecione uma imagem.');
  const source=URL.createObjectURL(file);
  try {
    const image=await new Promise((resolve,reject)=>{const value=new Image();value.onload=()=>resolve(value);value.onerror=reject;value.src=source;});
    const side=Math.min(image.width,image.height)/Math.max(1,Number(zoom));
    const left=Math.max(0,Math.min(image.width-side,(image.width-side)*Number(x)));
    const top=Math.max(0,Math.min(image.height-side,(image.height-side)*Number(y)));
    const canvas=document.createElement('canvas');canvas.width=size;canvas.height=size;
    canvas.getContext('2d').drawImage(image,left,top,side,side,0,0,size,size);
    const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('Falha ao editar foto.')),'image/jpeg',0.9));
    return new File([blob],file.name.replace(/\.[^.]+$/,'')+'.jpg',{type:'image/jpeg'});
  } finally { URL.revokeObjectURL(source); }
}
export function bindPhotoEditor({ input, zoom, preview }) {
  const draw=async()=>{const file=input?.files?.[0];if(!file||!preview)return;const edited=await cropImage(file,{zoom:Number(zoom?.value||1)});preview.src=URL.createObjectURL(edited);};
  input?.addEventListener('change',draw);zoom?.addEventListener('input',draw);
}

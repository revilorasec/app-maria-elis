import { supabase } from './supabase.js?v=20';

function dataOrThrow(result) {
  if (result.error) throw result.error;
  return result.data;
}

export async function listRecipes() {
  return dataOrThrow(await supabase.from('recipes')
    .select('*')
    .eq('active', true)
    .order('category')
    .order('title')) || [];
}

export async function loadRecipe(id) {
  return dataOrThrow(await supabase.from('recipes').select('*').eq('id', id).single());
}

export async function saveRecipe(payload) {
  const id = payload.id;
  const data = { ...payload, updated_at: new Date().toISOString() };
  delete data.id;
  if (id) return dataOrThrow(await supabase.from('recipes').update(data).eq('id', id).select().single());
  return dataOrThrow(await supabase.from('recipes').insert(data).select().single());
}

export async function deleteRecipe(id) {
  dataOrThrow(await supabase.from('recipes').delete().eq('id', id));
}

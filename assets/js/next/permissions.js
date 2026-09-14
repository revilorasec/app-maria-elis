export function normalizeRole(role) { return ['admin', 'father', 'mother'].includes(role) ? role : (role || 'visitor'); }
export function roleLabel(role) { return ({ admin: 'Administrador', father: 'Pai', mother: 'Mãe', guardian: 'Responsável', caregiver: 'Babá', grandparent: 'Familiar', doctor: 'Médico(a)', friend: 'Amigo(a)', visitor: 'Visitante', custom: 'Personalizado' })[role] || 'Usuário'; }
export function createPermissionChecker({ role, rolePermissions = [], overrides = [] }) {
  const effective = new Map(rolePermissions.filter((item) => item.allowed).map((item) => [item.permission_code, true]));
  for (const item of overrides) effective.set(item.permission_code, Boolean(item.allowed));
  return (code) => ['admin', 'father', 'mother'].includes(normalizeRole(role)) || effective.get(code) === true;
}
export const permissionLabel = (code) => ({
  'contacts.view':'Ver contatos e emergência','contacts.create':'Adicionar contatos','contacts.edit':'Editar contatos','contacts.delete':'Excluir contatos',
  'files.view':'Ver documentos','files.create':'Adicionar documentos','files.download':'Abrir e baixar documentos','files.edit':'Editar documentos','files.delete':'Excluir documentos',
  'photos.view':'Ver fotos','photos.create':'Adicionar fotos','photos.edit':'Editar fotos','photos.delete':'Excluir fotos',
  'recipes.view':'Ver receitas culinárias','recipes.create':'Adicionar receitas culinárias','recipes.edit':'Editar receitas culinárias','recipes.delete':'Excluir receitas culinárias',
  'users.manage':'Administrar usuários e categorias','child.view':'Ver dados da criança','child.edit':'Editar dados da criança',
  'tasks.view':'Ver afazeres','tasks.complete':'Concluir afazeres','tasks.manage':'Planejar e editar afazeres',
  'daily_logs.view':'Ver registros diários','daily_logs.create':'Fazer registros diários',
  'events.view':'Ver agenda','events.edit':'Editar agenda',
  'medications.view':'Ver medicamentos','medications.administer':'Registrar medicamento administrado','medications.edit':'Editar medicamentos',
  'health.view':'Ver saúde e desenvolvimento','health.edit':'Registrar e editar saúde','health.manage':'Excluir registros de saúde',
})[code] || code;

export function normalizeRole(role) { return role === 'admin' ? 'admin' : (role || 'visitor'); }
export function roleLabel(role) { return ({ admin: 'Administrador', guardian: 'Responsável', caregiver: 'Perfil Babá', grandparent: 'Familiar', visitor: 'Visitante', custom: 'Personalizado' })[role] || 'Usuário'; }
export function createPermissionChecker({ role, rolePermissions = [], overrides = [] }) {
  const effective = new Map(rolePermissions.filter((item) => item.allowed).map((item) => [item.permission_code, true]));
  for (const item of overrides) effective.set(item.permission_code, Boolean(item.allowed));
  return (code) => normalizeRole(role) === 'admin' || effective.get(code) === true;
}
export const permissionLabel = (code) => ({ 'contacts.view':'Ver contatos','contacts.create':'Criar contatos','contacts.edit':'Editar contatos','contacts.delete':'Excluir contatos','files.view':'Ver arquivos','files.create':'Enviar arquivos','files.download':'Baixar arquivos','files.edit':'Editar metadados','files.delete':'Excluir arquivos','users.manage':'Administrar usuários','child.view':'Ver dados da criança','child.edit':'Editar dados da criança','tasks.view':'Ver afazeres','tasks.complete':'Concluir afazeres' })[code] || code;

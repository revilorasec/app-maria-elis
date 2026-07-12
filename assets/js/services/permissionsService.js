const ACTIONS = {
  admin: ['*'],
  guardian: [
    'dashboard:view', 'instructions:*', 'tasks:*', 'logs:*', 'documents:*',
    'vaccines:*', 'appointments:*', 'growth:*', 'medications:*', 'emergency:*',
    'photos:*', 'reports:*', 'people:view', 'people:manage', 'contacts:view',
    'contacts:manage', 'users:view', 'users:manage', 'caregivers:view',
    'caregivers:manage', 'permissions:manage', 'child:view', 'child:edit'
  ],
  caregiver: [
    'dashboard:view', 'instructions:view', 'instructions:confirm', 'tasks:view',
    'tasks:complete', 'logs:create', 'photos:attach', 'emergency:view',
    'people:view', 'contacts:view', 'child:view'
  ],
  grandparent: [
    'dashboard:view', 'child:view', 'instructions:view', 'photos:view',
    'emergency:view', 'contacts:view'
  ],
  visitor: ['dashboard:view', 'child:view', 'instructions:view', 'emergency:view']
};

export function can(role, permission, grants = []) {
  const explicitGrants = Array.isArray(grants) ? grants : [];
  const granted = [...(ACTIONS[role] || []), ...explicitGrants];
  if (granted.includes('*') || granted.includes(permission)) return true;
  const [resource] = permission.split(':');
  return granted.includes(`${resource}:*`);
}

export function getRoleLabel(role) {
  return ({
    admin: 'Admin',
    guardian: 'Responsável',
    caregiver: 'Cuidador(a)',
    grandparent: 'Avó/Avô ou Familiar',
    visitor: 'Visitante',
    custom: 'Personalizado'
  })[role] || 'Sem papel';
}

export function allowedActions(role) {
  return ACTIONS[role] || [];
}

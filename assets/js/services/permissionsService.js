const ACTIONS = {
  admin: ['*'],
  guardian: [
    'dashboard:view', 'instructions:*', 'tasks:*', 'logs:*', 'documents:*',
    'vaccines:*', 'appointments:*', 'growth:*', 'medications:*', 'emergency:view',
    'reports:export', 'photos:attach'
  ],
  caregiver: [
    'dashboard:view', 'instructions:view', 'instructions:confirm', 'tasks:view',
    'tasks:complete', 'logs:create', 'photos:attach', 'emergency:view'
  ],
  visitor: ['dashboard:view', 'instructions:view', 'emergency:view']
};

export function can(role, permission) {
  const granted = ACTIONS[role] || [];
  if (granted.includes('*') || granted.includes(permission)) return true;
  const [resource] = permission.split(':');
  return granted.includes(`${resource}:*`);
}

export function getRoleLabel(role) {
  return ({ admin: 'Admin', guardian: 'Responsável', caregiver: 'Cuidador(a)', visitor: 'Visitante' })[role] || 'Sem papel';
}

export function allowedActions(role) {
  return ACTIONS[role] || [];
}

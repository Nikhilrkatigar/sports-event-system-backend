const ROLE_DEFINITIONS = [
  {
    key: 'super_admin',
    label: 'Super Admin',
    description: 'Full system access including setup, users, settings, and audit logs.',
    permissions: [
      'view_dashboard',
      'manage_events',
      'view_registrations',
      'manage_registrations',
      'check_in',
      'manage_leaderboard',
      'manage_gallery',
      'manage_settings',
      'manage_users',
      'manage_tournaments',
      'view_audit'
    ]
  },
  {
    key: 'principal',
    label: 'Principal',
    description: 'Full system access similar to Super Admin.',
    permissions: [
      'view_dashboard',
      'manage_events',
      'view_registrations',
      'manage_registrations',
      'check_in',
      'manage_leaderboard',
      'manage_gallery',
      'manage_settings',
      'manage_users',
      'manage_tournaments',
      'view_audit'
    ]
  },
  {
    key: 'hod',
    label: 'HOD',
    description: 'Manage events, registrations, galleries, leaderboard entries, and brackets.',
    permissions: [
      'view_dashboard',
      'manage_events',
      'view_registrations',
      'manage_registrations',
      'check_in',
      'manage_leaderboard',
      'manage_gallery',
      'manage_tournaments'
    ]
  },
  {
    key: 'coordinator',
    label: 'Coordinator',
    description: 'Manage events, registrations, galleries, leaderboard entries, and brackets.',
    permissions: [
      'view_dashboard',
      'manage_events',
      'view_registrations',
      'manage_registrations',
      'check_in',
      'manage_leaderboard',
      'manage_gallery',
      'manage_tournaments'
    ]
  },
  {
    key: 'faculty',
    label: 'Faculty',
    description: 'Manage events, registrations, galleries, leaderboard entries, and brackets.',
    permissions: [
      'view_dashboard',
      'manage_events',
      'view_registrations',
      'manage_registrations',
      'check_in',
      'manage_leaderboard',
      'manage_gallery',
      'manage_tournaments'
    ]
  },
  {
    key: 'student_gs',
    label: 'Student GS',
    description: 'Manage events, registrations, galleries, leaderboard entries, and brackets.',
    permissions: [
      'view_dashboard',
      'manage_events',
      'view_registrations',
      'manage_registrations',
      'check_in',
      'manage_leaderboard',
      'manage_gallery',
      'manage_tournaments'
    ]
  },
  {
    key: 'student_sports',
    label: 'Student Sports',
    description: 'Manage events, registrations, galleries, leaderboard entries, and brackets.',
    permissions: [
      'view_dashboard',
      'manage_events',
      'view_registrations',
      'manage_registrations',
      'check_in',
      'manage_leaderboard',
      'manage_gallery',
      'manage_tournaments'
    ]
  },
  {
    key: 'organizer',
    label: 'Organizer',
    description: 'Limited access - can only access Scanner, Leaderboard, and Registrations.',
    permissions: [
      'view_dashboard',
      'view_registrations',
      'check_in',
      'manage_leaderboard'
    ]
  },
  {
    key: 'event_manager',
    label: 'Event Manager',
    description: 'Manage events, registrations, galleries, leaderboard entries, and brackets.',
    permissions: [
      'view_dashboard',
      'manage_events',
      'view_registrations',
      'manage_registrations',
      'check_in',
      'manage_leaderboard',
      'manage_gallery',
      'manage_tournaments'
    ]
  },
  {
    key: 'score_manager',
    label: 'Score Manager',
    description: 'Update leaderboard standings and match results.',
    permissions: [
      'view_dashboard',
      'view_registrations',
      'manage_leaderboard',
      'manage_tournaments'
    ]
  },
  {
    key: 'checkin_staff',
    label: 'Check-in Staff',
    description: 'Handle event-day attendance and registration lookups.',
    permissions: [
      'view_dashboard',
      'view_registrations',
      'check_in'
    ]
  }
];

const LEGACY_ROLE_ALIASES = {
  admin: 'super_admin',
  principal: 'principal',
  hod: 'hod',
  coordinator: 'coordinator',
  faculty: 'faculty',
  'student gs': 'student_gs',
  'student sports': 'student_sports',
  organizer: 'organizer',
  'super admin': 'super_admin',
  'event manager': 'event_manager',
  'score manager': 'score_manager',
  'check-in staff': 'checkin_staff',
  'check in staff': 'checkin_staff'
};

const normalizeRole = (role) => String(role || '').trim().toLowerCase();

const getRoleDefinition = (role) => {
  const normalized = normalizeRole(role);
  const canonicalKey = LEGACY_ROLE_ALIASES[normalized] || normalized;
  return ROLE_DEFINITIONS.find((item) => item.key === canonicalKey) || null;
};

const getCanonicalRole = (role) => getRoleDefinition(role)?.label || String(role || '').trim();

const getRolePermissions = (role) => getRoleDefinition(role)?.permissions || [];

const hasPermission = (role, permission) => getRolePermissions(role).includes(permission);

const hasFullCmsAccess = (role) => hasPermission(role, 'manage_users');

const isValidCmsRole = (role) => Boolean(getRoleDefinition(role));

const CMS_ROLES = ROLE_DEFINITIONS.map(({ label }) => label);

module.exports = {
  CMS_ROLES,
  ROLE_DEFINITIONS,
  normalizeRole,
  getCanonicalRole,
  getRolePermissions,
  hasPermission,
  hasFullCmsAccess,
  isValidCmsRole
};

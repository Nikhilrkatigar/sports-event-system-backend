const CMS_ROLES = [
  'Admin',
  'HOD',
  'Coordinator',
  'Faculty',
  'Principal',
  'Student GS',
  'Student Sports',
  'Organizer'
];

const normalizeRole = (role) => String(role || '').trim().toLowerCase();

const isOrganizerRole = (role) => normalizeRole(role) === 'organizer';

const hasFullCmsAccess = (role) => !isOrganizerRole(role);

const isValidCmsRole = (role) => CMS_ROLES.some((r) => normalizeRole(r) === normalizeRole(role));

module.exports = {
  CMS_ROLES,
  normalizeRole,
  isOrganizerRole,
  hasFullCmsAccess,
  isValidCmsRole
};

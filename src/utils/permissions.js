// permissions.js - Enhanced Role-based access control for TheRxOS
// Roles: super_admin, admin, pharmacist, technician
// Permissions are configurable per pharmacy by admin

export const ROLES = {
  SUPER_ADMIN: 'super_admin', // Platform owner (Stan) - can access any pharmacy
  ADMIN: 'admin',             // Pharmacy owner/manager
  PHARMACIST: 'pharmacist',   // Licensed pharmacist
  TECHNICIAN: 'technician',   // Pharmacy technician
};

// Base permissions that can be granted
export const PERMISSIONS = {
  // Super Admin only
  ACCESS_ALL_PHARMACIES: 'access_all_pharmacies',
  MANAGE_PLATFORM: 'manage_platform',
  VIEW_PLATFORM_ANALYTICS: 'view_platform_analytics',
  IMPERSONATE_USER: 'impersonate_user',
  
  // Pharmacy Admin
  MANAGE_PHARMACY_USERS: 'manage_pharmacy_users',
  MANAGE_PHARMACY_SETTINGS: 'manage_pharmacy_settings',
  MANAGE_BILLING: 'manage_billing',
  CONFIGURE_PERMISSIONS: 'configure_permissions',
  
  // Opportunities
  VIEW_OPPORTUNITIES: 'view_opportunities',
  ACTION_OPPORTUNITIES: 'action_opportunities',
  DELETE_OPPORTUNITIES: 'delete_opportunities',
  SEND_FAX_DIRECTLY: 'send_fax_directly',        // Can be toggled by admin
  SUBMIT_TO_APPROVAL: 'submit_to_approval',       // For approval queue
  APPROVE_FAX_REQUESTS: 'approve_fax_requests',   // Can approve queued faxes
  
  // Patients
  VIEW_PATIENTS: 'view_patients',
  VIEW_PATIENT_DETAILS: 'view_patient_details',   // Can be toggled by admin
  EXPORT_PATIENT_DATA: 'export_patient_data',
  
  // Analytics
  VIEW_ANALYTICS: 'view_analytics',
  VIEW_FINANCIAL_DATA: 'view_financial_data',           // Full financial access (annual values, totals)
  VIEW_LIMITED_FINANCIAL_DATA: 'view_limited_financial_data', // Single fill values only (no annual/totals)
  
  // Data
  UPLOAD_DATA: 'upload_data',
  
  // Audit
  VIEW_AUDIT_RISKS: 'view_audit_risks',
};

// Default permissions by role (before pharmacy-specific overrides)
export const DEFAULT_ROLE_PERMISSIONS = {
  [ROLES.SUPER_ADMIN]: Object.values(PERMISSIONS), // All permissions
  
  [ROLES.ADMIN]: [
    PERMISSIONS.MANAGE_PHARMACY_USERS,
    PERMISSIONS.MANAGE_PHARMACY_SETTINGS,
    PERMISSIONS.MANAGE_BILLING,
    PERMISSIONS.CONFIGURE_PERMISSIONS,
    PERMISSIONS.VIEW_OPPORTUNITIES,
    PERMISSIONS.ACTION_OPPORTUNITIES,
    PERMISSIONS.DELETE_OPPORTUNITIES,
    PERMISSIONS.SEND_FAX_DIRECTLY,
    PERMISSIONS.APPROVE_FAX_REQUESTS,
    PERMISSIONS.VIEW_PATIENTS,
    PERMISSIONS.VIEW_PATIENT_DETAILS,
    PERMISSIONS.EXPORT_PATIENT_DATA,
    PERMISSIONS.VIEW_ANALYTICS,
    PERMISSIONS.VIEW_FINANCIAL_DATA,
    PERMISSIONS.UPLOAD_DATA,
    PERMISSIONS.VIEW_AUDIT_RISKS,
  ],
  
  [ROLES.PHARMACIST]: [
    PERMISSIONS.VIEW_OPPORTUNITIES,
    PERMISSIONS.ACTION_OPPORTUNITIES,
    PERMISSIONS.SEND_FAX_DIRECTLY,        // Default ON, admin can turn off
    PERMISSIONS.APPROVE_FAX_REQUESTS,     // Can approve tech submissions
    PERMISSIONS.VIEW_PATIENTS,
    PERMISSIONS.VIEW_PATIENT_DETAILS,     // Default ON, admin can turn off
    PERMISSIONS.VIEW_ANALYTICS,
    PERMISSIONS.VIEW_FINANCIAL_DATA,      // Default ON, admin can turn off
    PERMISSIONS.UPLOAD_DATA,
    PERMISSIONS.VIEW_AUDIT_RISKS,
  ],
  
  [ROLES.TECHNICIAN]: [
    PERMISSIONS.VIEW_OPPORTUNITIES,
    PERMISSIONS.ACTION_OPPORTUNITIES,
    PERMISSIONS.SUBMIT_TO_APPROVAL,       // Must submit for approval (no direct fax)
    PERMISSIONS.VIEW_PATIENTS,
    PERMISSIONS.VIEW_PATIENT_DETAILS,     // Default ON, admin can turn off
    // No: SEND_FAX_DIRECTLY, APPROVE_FAX_REQUESTS, VIEW_ANALYTICS, VIEW_FINANCIAL_DATA
  ],
};

// Permissions that admin can toggle for pharmacist/technician roles
export const CONFIGURABLE_PERMISSIONS = {
  [ROLES.PHARMACIST]: [
    { key: PERMISSIONS.SEND_FAX_DIRECTLY, label: 'Send faxes directly', default: true },
    { key: PERMISSIONS.VIEW_PATIENT_DETAILS, label: 'View patient details', default: true },
    { key: PERMISSIONS.VIEW_FINANCIAL_DATA, label: 'View full financial data (annual values)', default: true },
    { key: PERMISSIONS.VIEW_LIMITED_FINANCIAL_DATA, label: 'View limited financial data (single fill only)', default: false },
    { key: PERMISSIONS.UPLOAD_DATA, label: 'Upload data files', default: true },
  ],
  [ROLES.TECHNICIAN]: [
    { key: PERMISSIONS.SEND_FAX_DIRECTLY, label: 'Send faxes directly (skip approval)', default: false },
    { key: PERMISSIONS.VIEW_PATIENT_DETAILS, label: 'View patient details', default: true },
    { key: PERMISSIONS.VIEW_FINANCIAL_DATA, label: 'View full financial data (annual values)', default: false },
    { key: PERMISSIONS.VIEW_LIMITED_FINANCIAL_DATA, label: 'View limited financial data (single fill only)', default: false },
    { key: PERMISSIONS.VIEW_ANALYTICS, label: 'View analytics', default: false },
    { key: PERMISSIONS.UPLOAD_DATA, label: 'Upload data files', default: false },
  ],
};

// Default pharmacy settings
export const DEFAULT_PHARMACY_SETTINGS = {
  fax_limits: {
    max_per_day: 10,
    same_prescriber_cooldown_days: 7,
    require_approval_for_technicians: true,
  },
  permission_overrides: {
    // Role-specific permission overrides
    // e.g., { technician: { view_patient_details: false } }
  },
};

// Check if user has permission (considering pharmacy overrides)
export function hasPermission(user, permission, pharmacySettings = {}) {
  if (!user || !user.role) return false;
  
  const role = user.role;
  const basePermissions = DEFAULT_ROLE_PERMISSIONS[role] || [];
  
  // Super admin has all permissions
  if (role === ROLES.SUPER_ADMIN) return true;
  
  // Check base permissions
  let hasBasePermission = basePermissions.includes(permission);
  
  // Check pharmacy-specific overrides
  const overrides = pharmacySettings?.permission_overrides?.[role] || {};
  if (permission in overrides) {
    hasBasePermission = overrides[permission];
  }
  
  return hasBasePermission;
}

// Middleware to check permissions
export function requirePermission(permission) {
  return async (req, res, next) => {
    const user = req.user;
    
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Get pharmacy settings for permission overrides
    let pharmacySettings = {};
    if (user.pharmacy_id && req.pharmacySettings) {
      pharmacySettings = req.pharmacySettings;
    }
    
    if (!hasPermission(user, permission, pharmacySettings)) {
      return res.status(403).json({ 
        error: 'Access denied',
        message: `This action requires ${permission} permission`,
      });
    }
    
    next();
  };
}

// Check fax limits
export function checkFaxLimits(pharmacySettings, prescriberHistory) {
  const limits = pharmacySettings?.fax_limits || DEFAULT_PHARMACY_SETTINGS.fax_limits;

  const today = new Date().toISOString().split('T')[0];
  const faxesToday = prescriberHistory.filter(f => {
    if (!f.sent_date) return false;
    // Handle both Date objects and strings
    const dateStr = f.sent_date instanceof Date
      ? f.sent_date.toISOString().split('T')[0]
      : String(f.sent_date).split('T')[0];
    return dateStr === today;
  }).length;

  if (faxesToday >= limits.max_per_day) {
    return {
      allowed: false,
      reason: `Daily fax limit reached (${limits.max_per_day}/day)`
    };
  }

  return { allowed: true };
}

// Check if can fax specific prescriber
export function canFaxPrescriber(pharmacySettings, prescriberId, faxHistory) {
  const limits = pharmacySettings?.fax_limits || DEFAULT_PHARMACY_SETTINGS.fax_limits;
  const cooldownDays = limits.same_prescriber_cooldown_days;
  
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - cooldownDays);
  
  const recentFaxToProvider = faxHistory.find(f => 
    f.prescriber_id === prescriberId && 
    new Date(f.sent_date) > cutoffDate
  );
  
  if (recentFaxToProvider) {
    const daysSince = Math.ceil((new Date() - new Date(recentFaxToProvider.sent_date)) / (1000 * 60 * 60 * 24));
    return {
      allowed: false,
      reason: `Already faxed this prescriber ${daysSince} day(s) ago. Must wait ${cooldownDays} days between faxes.`,
      lastFaxDate: recentFaxToProvider.sent_date,
    };
  }
  
  return { allowed: true };
}

// Role display info
export const ROLE_INFO = {
  [ROLES.SUPER_ADMIN]: {
    name: 'Super Admin',
    description: 'Platform administrator with access to all pharmacies',
    color: 'text-red-400 bg-red-500/20',
  },
  [ROLES.ADMIN]: {
    name: 'Administrator',
    description: 'Pharmacy owner/manager with full access and user management',
    color: 'text-purple-400 bg-purple-500/20',
  },
  [ROLES.PHARMACIST]: {
    name: 'Pharmacist',
    description: 'Licensed pharmacist with clinical access',
    color: 'text-blue-400 bg-blue-500/20',
  },
  [ROLES.TECHNICIAN]: {
    name: 'Technician',
    description: 'Pharmacy technician with workflow access',
    color: 'text-teal-400 bg-teal-500/20',
  },
};

export default {
  ROLES,
  PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  CONFIGURABLE_PERMISSIONS,
  DEFAULT_PHARMACY_SETTINGS,
  hasPermission,
  requirePermission,
  checkFaxLimits,
  canFaxPrescriber,
  ROLE_INFO,
};

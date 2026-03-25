/**
 * Password validation utility
 * Enforces strong password complexity requirements
 */

const validatePassword = (password) => {
  const errors = [];
  
  if (!password || password.length < 12) {
    errors.push('Password must be at least 12 characters long');
  }
  
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter (A-Z)');
  }
  
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter (a-z)');
  }
  
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number (0-9)');
  }
  
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    errors.push('Password must contain at least one special character (!@#$%^&*()_+-=[]{};\':"|,.<>/?');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
};

const getPasswordStrengthMessage = () => {
  return 'Password must be at least 12 characters and contain uppercase, lowercase, number, and special character.';
};

module.exports = {
  validatePassword,
  getPasswordStrengthMessage
};

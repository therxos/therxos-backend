// Utility functions for formatting data

/**
 * Format a patient name properly - converts "LAST,FIRST" or truncated names to proper format
 * @param {string|null} firstName - Patient first name (may be truncated to 3 chars)
 * @param {string|null} lastName - Patient last name (may be truncated to 3 chars)
 * @returns {string} Formatted patient name as "First Last" or "Patient" if both are null
 */
export function formatPatientName(firstName, lastName) {
  const first = properCase(firstName);
  const last = properCase(lastName);

  if (first && last) {
    return `${first} ${last}`;
  } else if (last) {
    return last;
  } else if (first) {
    return first;
  }
  return 'Patient';
}

/**
 * Convert a string to proper case (first letter uppercase, rest lowercase)
 * @param {string|null} str - Input string
 * @returns {string} Properly cased string
 */
export function properCase(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * Format prescriber name properly
 * Handles formats like "LAST, FIRST MD" or "DR FIRST LAST"
 * @param {string|null} name - Raw prescriber name
 * @returns {string} Formatted prescriber name
 */
export function formatPrescriberName(name) {
  if (!name) return 'Unknown Prescriber';
  if (name.toUpperCase() === 'UNKNOWN' || name.trim() === '') return 'Unknown Prescriber';

  // Remove common suffixes for cleaner display
  let cleaned = name.trim();

  // Handle "LAST, FIRST" format
  if (cleaned.includes(',')) {
    const parts = cleaned.split(',').map(p => p.trim());
    if (parts.length >= 2) {
      // Extract first name (without credentials like MD, DO)
      const firstName = parts[1].split(/\s+/)[0];
      const lastName = parts[0];
      cleaned = `${firstName} ${lastName}`;
    }
  }

  // Proper case each word
  return cleaned.split(/\s+/)
    .map(word => {
      // Keep credentials uppercase
      if (['MD', 'DO', 'NP', 'PA', 'RN', 'DR', 'APRN', 'DNP', 'PHARMD'].includes(word.toUpperCase())) {
        return word.toUpperCase();
      }
      return properCase(word);
    })
    .join(' ');
}

/**
 * Format currency value
 * @param {number|string|null} value - The value to format
 * @param {boolean} showCents - Whether to show cents (default: true)
 * @returns {string} Formatted currency string like "$1,234.56"
 */
export function formatCurrency(value, showCents = true) {
  const num = parseFloat(value) || 0;
  if (showCents) {
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return '$' + Math.round(num).toLocaleString('en-US');
}

/**
 * Format drug name for display
 * @param {string|null} drugName - Raw drug name
 * @returns {string} Formatted drug name
 */
export function formatDrugName(drugName) {
  if (!drugName) return 'Unknown Drug';

  // Split into base drug and dosage info
  const parts = drugName.split(/\s+/);

  return parts.map((part, i) => {
    // Check if it's a dosage (contains numbers followed by units)
    if (/^\d/.test(part) || /^\d+(mg|mcg|ml|g|mg\/|mcg\/)/.test(part.toLowerCase())) {
      return part.toLowerCase();
    }
    // Keep first part proper case, rest lowercase
    return i === 0 ? properCase(part) : part.toLowerCase();
  }).join(' ');
}

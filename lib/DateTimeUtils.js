/**
 * DateTimeUtils - Utility functions for consistent UTC date-time handling
 *
 * All timestamps in the Airbrx Proxy system MUST be in UTC using ISO 8601 format.
 * This module provides standardized functions to ensure consistency across the codebase.
 *
 * ISO 8601 Format: YYYY-MM-DDTHH:mm:ss.sssZ
 * Example: 2025-10-08T12:34:56.789Z
 *
 * @module DateTimeUtils
 */

class DateTimeUtils {
  /**
   * Get the current UTC timestamp as ISO 8601 string
   * @returns {string} Current UTC timestamp (e.g., "2025-10-08T12:34:56.789Z")
   */
  static now() {
    return new Date().toISOString();
  }

  /**
   * Get current UTC timestamp truncated to seconds (no milliseconds)
   * @returns {string} UTC timestamp without milliseconds (e.g., "2025-10-08T12:34:56Z")
   */
  static nowSeconds() {
    return `${new Date().toISOString().split('.')[0]}Z`;
  }

  /**
   * Get current UTC timestamp formatted for filenames (safe for all filesystems)
   * Replaces colons and periods with hyphens
   * @returns {string} Filesystem-safe timestamp (e.g., "2025-10-08T12-34-56-789Z")
   */
  static nowForFilename() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  /**
   * Get just the time portion (HH:MM:SS.sss) from current UTC timestamp
   * Useful for console logging
   * @returns {string} Time portion (e.g., "12:34:56.789")
   */
  static nowTimeOnly() {
    return new Date().toISOString().substring(11, 23);
  }

  /**
   * Convert any date value to UTC ISO string
   * @param {Date|string|number} date - Date object, ISO string, or timestamp
   * @returns {string} UTC ISO 8601 string
   */
  static toUTC(date) {
    if (!date) {
      return null;
    }
    if (typeof date === 'string' && date.endsWith('Z')) {
      // Already in UTC ISO format
      return date;
    }
    return new Date(date).toISOString();
  }

  /**
   * Calculate age in seconds from a UTC timestamp
   * @param {string} utcTimestamp - ISO 8601 UTC timestamp
   * @returns {number} Age in seconds (returns 0 if invalid)
   */
  static ageInSeconds(utcTimestamp) {
    if (!utcTimestamp) {
      return 0;
    }
    try {
      const then = new Date(utcTimestamp);
      const now = new Date();
      return Math.floor((now - then) / 1000);
    } catch (error) {
      return 0;
    }
  }

  /**
   * Calculate age in milliseconds from a UTC timestamp
   * @param {string} utcTimestamp - ISO 8601 UTC timestamp
   * @returns {number} Age in milliseconds (returns 0 if invalid)
   */
  static ageInMilliseconds(utcTimestamp) {
    if (!utcTimestamp) {
      return 0;
    }
    try {
      const then = new Date(utcTimestamp);
      const now = new Date();
      return now - then;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Check if a timestamp is older than a given number of seconds
   * @param {string} utcTimestamp - ISO 8601 UTC timestamp
   * @param {number} seconds - Age threshold in seconds
   * @returns {boolean} True if timestamp is older than threshold
   */
  static isOlderThan(utcTimestamp, seconds) {
    return this.ageInSeconds(utcTimestamp) > seconds;
  }

  /**
   * Add seconds to a UTC timestamp
   * @param {string} utcTimestamp - ISO 8601 UTC timestamp
   * @param {number} seconds - Seconds to add (can be negative)
   * @returns {string} New UTC ISO 8601 string
   */
  static addSeconds(utcTimestamp, seconds) {
    const date = new Date(utcTimestamp);
    date.setSeconds(date.getSeconds() + seconds);
    return date.toISOString();
  }

  /**
   * Validate if a string is a valid ISO 8601 UTC timestamp
   * @param {string} str - String to validate
   * @returns {boolean} True if valid UTC timestamp
   */
  static isValidUTC(str) {
    if (typeof str !== 'string') {
      return false;
    }
    try {
      const date = new Date(str);
      return date.toISOString() === str;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get date-based hierarchy path for organizing files (YYYY/MM/DD/HH)
   * Useful for log files and time-series data organization
   * @param {Date|string|null} date - Optional date (defaults to now)
   * @returns {string} Path string like "2025/10/09/14"
   */
  static getDateHierarchyPath(date = null) {
    const d = date ? new Date(date) : new Date();
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const hour = String(d.getUTCHours()).padStart(2, '0');
    return `${year}/${month}/${day}/${hour}`;
  }
}

module.exports = DateTimeUtils;

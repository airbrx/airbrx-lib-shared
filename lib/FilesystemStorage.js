const fs = require('fs').promises;
const path = require('path');

/**
 * File system storage backend implementation
 */
class FilesystemStorage {
  /**
   * @param {string|Object} config - Base path string or config object with basePath
   */
  constructor(config) {
    this.logger = require('./WinstonLogger')('FilesystemStorage');

    if (typeof config === 'string') {
      this.basePath = config;
    } else {
      // Use baseDir (matches config property name)
      const baseDir = config.storage.baseDir || config.storage.basePath;
      if (!baseDir) {
        throw new Error('storage.baseDir is required for FilesystemStorage');
      }
      // Only append tenantId if it's not empty
      this.basePath = config.tenantId
        ? path.join(baseDir, config.tenantId)
        : baseDir;
    }
  }

  /**
   * Get full file path from storage key
   * @param {string} key - Storage key
   * @returns {string} Full file path
   */
  _getPath(key) {
    return path.join(this.basePath, key);
  }

  /**
   * Ensure directory exists for the given file path
   * @param {string} filePath - Full file path
   */
  async _ensureDir(filePath) {
    const dir = path.dirname(filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  /**
   * Read file contents
   * @param {string} key - Storage key
   * @returns {Promise<string>} File contents
   * @throws {Error} If file doesn't exist
   */
  async read(key) {
    const filePath = this._getPath(key);
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`File not found: ${key}`);
      }
      throw error;
    }
  }

  /**
   * Read raw binary file contents (no utf8 decode — for Parquet etc.)
   * @param {string} key - Storage key
   * @returns {Promise<Buffer>} File contents as a Buffer
   * @throws {Error} If file doesn't exist
   */
  async readBuffer(key) {
    const filePath = this._getPath(key);
    try {
      return await fs.readFile(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`File not found: ${key}`);
      }
      throw error;
    }
  }

  /**
   * Write file contents
   * @param {string} key - Storage key
   * @param {string} data - Data to write
   */
  async write(key, data) {
    const filePath = this._getPath(key);

    await this._ensureDir(filePath);
    await fs.writeFile(filePath, data, 'utf8');
  }

  /**
   * Delete file
   * @param {string} key - Storage key
   */
  async delete(key) {
    const filePath = this._getPath(key);
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * Rename file (used for cache invalidation)
   * @param {string} oldKey - Current storage key
   * @param {string} newKey - New storage key
   */
  async rename(oldKey, newKey) {
    const oldPath = this._getPath(oldKey);
    const newPath = this._getPath(newKey);

    try {
      await fs.rename(oldPath, newPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Check if source file exists
        const sourceExists = await this.exists(oldKey);
        if (!sourceExists) {
          // Source file doesn't exist - silently succeed (already invalidated/deleted)
          return;
        }
        // Source exists but destination directory doesn't - create it and retry
        await this._ensureDir(newPath);
        await fs.rename(oldPath, newPath);
      } else {
        throw error;
      }
    }
  }

  /**
   * List files with given prefix
   *
   * IMPORTANT: Advanced options (delimiter, maxKeys) are for specialized use cases only
   * (e.g., bulk operations, admin scripts). Standard proxy operations should use
   * default recursive listing without options.
   *
   * @param {string} prefix - Key prefix to filter by
   * @param {Object} options - ADVANCED: Optional parameters (use with caution)
   * @param {string} options.delimiter - ADVANCED: Delimiter for non-recursive listing (e.g., '/')
   *                                      Returns only immediate children instead of all files
   *                                      WARNING: Changes behavior significantly, use only when needed
   * @param {number} options.maxKeys - ADVANCED: Maximum number of keys to return
   *                                   WARNING: May return incomplete results
   * @param {string} options.startAfter - Return only keys sorting strictly after
   *                                      this key (exclusive, matching S3
   *                                      StartAfter). Directories whose entire
   *                                      subtree sorts at or below it are pruned
   *                                      without being read.
   * @returns {Promise<string[]>} Array of matching keys
   */
  async list(prefix = '', options = {}) {
    const prefixPath = this._getPath(prefix);
    const results = [];

    try {
      if (options.delimiter) {
        // Non-recursive listing - only immediate children
        await this._listWithDelimiter(prefixPath, prefix, results, options);
      } else {
        // Recursive listing (default behavior)
        await this._listRecursive(prefixPath, prefix, results, options);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    return results;
  }

  /**
   * List immediate children with delimiter (non-recursive)
   * When delimiter is used, ONLY return directories (to match S3 CommonPrefixes behavior)
   * @param {string} dirPath - Directory path to search
   * @param {string} currentPrefix - Current prefix being processed
   * @param {string[]} results - Array to collect results
   * @param {Object} options - Options with delimiter and maxKeys
   */
  async _listWithDelimiter(dirPath, currentPrefix, results, options) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (options.maxKeys && results.length >= options.maxKeys) {
          return;
        }

        // When delimiter is used, ONLY return directories (matches S3 CommonPrefixes)
        if (entry.isDirectory()) {
          const entryKey = currentPrefix ? path.join(currentPrefix, entry.name) : entry.name;
          results.push(entryKey);
        }
        // Files are NOT included when delimiter is used (matches S3 behavior)
      }
    } catch (error) {
      // Skip directories we can't read
      if (error.code !== 'ENOENT' && error.code !== 'EACCES') {
        throw error;
      }
    }
  }

  /**
   * Recursively list files
   * @param {string} dirPath - Directory path to search
   * @param {string} currentPrefix - Current prefix being processed
   * @param {string[]} results - Array to collect results
   * @param {Object} options - Options with maxKeys
   */
  async _listRecursive(dirPath, currentPrefix, results, options = {}) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      // Client-side StartAfter (exclusive, matching S3 semantics). Keys are
      // built with path.join, so compare with normalized separators — on
      // Windows '\' sorts above '/'.
      const startAfter = options.startAfter
        ? String(options.startAfter).replace(/\\/g, '/')
        : null;

      for (const entry of entries) {
        if (options.maxKeys && results.length >= options.maxKeys) {
          return;
        }

        const entryPath = path.join(dirPath, entry.name);
        const entryKey = path.join(currentPrefix, entry.name);
        const normKey = entryKey.replace(/\\/g, '/');

        if (entry.isDirectory()) {
          // Prune: if the directory key isn't a prefix of the cursor and sorts
          // below it, every key in the subtree also sorts below it.
          if (startAfter) {
            const dirKey = normKey + '/';
            if (dirKey < startAfter && !startAfter.startsWith(dirKey)) {
              continue;
            }
          }
          await this._listRecursive(entryPath, entryKey, results, options);
        } else {
          if (startAfter && normKey <= startAfter) {
            continue;
          }
          results.push(entryKey);
        }
      }
    } catch (error) {
      // Skip directories we can't read
      if (error.code !== 'ENOENT' && error.code !== 'EACCES') {
        throw error;
      }
    }
  }

  /**
   * Check if file exists
   * @param {string} key - Storage key
   * @returns {Promise<boolean>} True if file exists
   */
  async exists(key) {
    const filePath = this._getPath(key);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = FilesystemStorage;

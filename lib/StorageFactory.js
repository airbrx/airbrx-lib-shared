const EnvironmentDetector = require('./EnvironmentDetector');

/**
 * Factory for creating storage backend instances with environment-aware auto-selection
 */
class StorageFactory {
  /**
   * Create a storage backend instance
   * @param {Object} config - Configuration for the backend
   * @param {Object} config.storage - Storage configuration
   * @param {string} config.storage.type - Backend type (filesystem, s3, etc.)
   * @returns {Object} Storage backend instance
   */
  static create(config) {
    let type; // Declare at function scope so catch block can access it

    try {
      type = config.storage.type;

      // Environment-aware storage validation and auto-selection
      if (type === 'filesystem') {
        const defaults = EnvironmentDetector.getStorageDefaults();

        if (!defaults.allowFilesystem) {
          // Lambda environment - filesystem not allowed
          const logger = require('./WinstonLogger')('StorageFactory');
          logger.warn(
            `Filesystem storage not supported in ${EnvironmentDetector.environmentName} environment. ` +
            `Reason: ${defaults.reason}. Switching to S3 storage.`
          );

          // Auto-switch to S3
          type = 's3';

          // Validate S3 configuration exists
          if (!config.storage.bucket) {
            throw new Error(
              `Cannot use S3 storage in ${EnvironmentDetector.environmentName} environment: ` +
              'AIRBRX_S3_BUCKET not configured. Set AIRBRX_S3_BUCKET environment variable.'
            );
          }
        } else if (EnvironmentDetector.isDocker) {
          // Docker environment - warn if using filesystem (usually needs volume mounts)
          const logger = require('./WinstonLogger')('StorageFactory');
          logger.info(
            'Using filesystem storage in Docker environment. ' +
            'Ensure volume mounts are configured for persistence.'
          );
        }
      }

      // Convert type to PascalCase and append 'Storage'
      const className = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase() + 'Storage';
      const BackendClass = require(`./${className}`);

      const logger = require('./WinstonLogger')('StorageFactory');
      logger.debug(`Creating ${className} instance`, {
        environment: EnvironmentDetector.environmentName,
        type: type
      });

      return new BackendClass(config);
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') {
        throw new Error(`Unknown storage backend type: ${type}. Available types: filesystem, s3, s3express`);
      }
      throw error;
    }
  }

  /**
   * Validate storage configuration against environment constraints
   * @param {Object} config - Storage configuration
   * @throws {Error} If configuration is invalid for current environment
   */
  static validate(config) {
    const type = config.storage.type;

    try {
      EnvironmentDetector.validateStorageType(type);
    } catch (error) {
      // Add more context to error
      throw new Error(
        `Storage validation failed: ${error.message}. ` +
        'Update AIRBRX_STORAGE_TYPE environment variable or configuration.'
      );
    }

    // Validate S3-specific configuration
    if (type === 's3' && !config.storage.bucket) {
      throw new Error(
        'S3 storage requires bucket configuration. ' +
        'Set AIRBRX_S3_BUCKET environment variable.'
      );
    }

    // Validate S3 Express-specific configuration
    if (type === 's3express') {
      if (!config.storage.bucket) {
        throw new Error(
          'S3 Express storage requires bucket configuration. ' +
          'Set AIRBRX_S3EXPRESS_BUCKET environment variable.'
        );
      }

      // Validate directory bucket naming format
      const bucket = config.storage.bucket;
      if (!bucket.includes('--') || !bucket.endsWith('--x-s3')) {
        throw new Error(
          `S3 Express bucket must follow directory bucket naming format: bucket-name--zone-id--x-s3. ` +
          `Got: ${bucket}`
        );
      }
    }

    return true;
  }
}

module.exports = StorageFactory;

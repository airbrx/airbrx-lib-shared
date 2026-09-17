const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand, CopyObjectCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const path = require('path');
const fs = require('fs').promises;

/**
 * S3 storage backend implementation
 */
class S3Storage {
  /**
   * @param {Object} config - Configuration object
   * @param {Object} config.storage - Storage configuration
   * @param {string} config.storage.basePath - Base path/prefix for keys
   * @param {string} config.tenantId - Tenant identifier
   *
   * Environment variables used:
   * - AIRBRX_S3_BUCKET or AWS_S3_BUCKET: S3 bucket name (required)
   * - AIRBRX_AWS_REGION or AWS_REGION: AWS region (default: us-east-1)
   * - AIRBRX_AWS_ACCESS_KEY_ID: AWS access key ID (optional - only for explicit credentials)
   * - AIRBRX_AWS_SECRET_ACCESS_KEY: AWS secret access key (optional - only for explicit credentials)
   * - AWS_S3_ENDPOINT: Custom S3 endpoint for S3-compatible services (optional)
   * - AIRBRX_S3_MIRROR_TO_FILESYSTEM: Enable filesystem mirroring (optional, default: false)
   * - AIRBRX_S3_MIRROR_DIR: Filesystem mirror base directory (optional, defaults to same as S3 baseDir)
   *
   * Note: Do NOT use AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY - Lambda sets these with temporary
   * STS credentials that require AWS_SESSION_TOKEN. If no AIRBRX_AWS_* credentials are set,
   * the SDK uses its default credential chain (IAM roles, instance profiles, etc.).
   */
  constructor(config) {
    this.logger = require('./WinstonLogger')('S3Storage');

    // Get bucket from config first, fallback to environment variable for backwards compatibility
    // Check for AIRBRX_* variables first (Lambda-safe) then fall back to AWS_* variables
    const bucket = config.storage.bucket || process.env.AIRBRX_S3_BUCKET || process.env.AWS_S3_BUCKET;
    const region = config.storage.region || process.env.AIRBRX_AWS_REGION || process.env.AWS_REGION || 'us-east-1';
    // Check for AIRBRX_AWS_* variables only - do NOT fall back to AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
    // IMPORTANT: Lambda sets AWS_* with temporary STS credentials that require AWS_SESSION_TOKEN.
    // If no explicit credentials are provided, let the SDK use its default credential chain
    // which properly handles Lambda IAM roles, EC2 instance profiles, etc.
    const accessKeyId = process.env.AIRBRX_AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AIRBRX_AWS_SECRET_ACCESS_KEY;
    const endpoint = process.env.AWS_S3_ENDPOINT;

    // Validate required configuration
    if (!bucket) {
      throw new Error('S3 bucket is required (config.storage.bucket or AIRBRX_S3_BUCKET/AWS_S3_BUCKET environment variable)');
    }

    this.bucket = bucket;
    // Use baseDir (matches config property name), fall back to basePath for compatibility
    const baseDir = config.storage.baseDir || config.storage.basePath || '';
    // Only append tenantId if it's not empty
    if (config.tenantId) {
      this.basePath = baseDir
        ? path.join(baseDir, config.tenantId)
        : config.tenantId;
    } else {
      this.basePath = baseDir;
    }

    // Initialize S3 client configuration
    const clientConfig = {
      region: region
    };

    // Add credentials if provided (otherwise SDK will use IAM roles, environment, or AWS config)
    if (accessKeyId && secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey
      };
    }

    // Add custom endpoint if provided (for S3-compatible services like MinIO)
    if (endpoint) {
      clientConfig.endpoint = endpoint;
      clientConfig.forcePathStyle = true; // Required for some S3-compatible services
    }

    // Configure HTTP handler with increased socket pool for high-concurrency operations
    clientConfig.requestHandler = new NodeHttpHandler({
      maxSockets: 200,
      socketAcquisitionWarningTimeout: 10000
    });

    this.s3Client = new S3Client(clientConfig);

    // Filesystem mirroring configuration
    this.mirrorToFilesystem = process.env.AIRBRX_S3_MIRROR_TO_FILESYSTEM === 'true';
    if (this.mirrorToFilesystem) {
      // Default to same base directory as S3, but allow override
      const mirrorBaseDir = process.env.AIRBRX_S3_MIRROR_DIR || baseDir;
      // Build mirror path with same structure as S3 basePath
      if (config.tenantId) {
        this.mirrorBasePath = mirrorBaseDir
          ? path.join(mirrorBaseDir, config.tenantId)
          : config.tenantId;
      } else {
        this.mirrorBasePath = mirrorBaseDir;
      }

      this.logger.info('S3Storage initialized with filesystem mirroring enabled', {
        bucket: this.bucket,
        s3BasePath: this.basePath,
        mirrorBasePath: this.mirrorBasePath
      });
    }

    // this.logger.info('S3Storage initialized', {
    //   bucket: this.bucket,
    //   region: region,
    //   basePath: this.basePath,
    //   hasCredentials: !!(accessKeyId && secretAccessKey),
    //   hasCustomEndpoint: !!endpoint
    // });
  }

  /**
   * Get full S3 key from storage key
   * @param {string} key - Storage key
   * @returns {string} Full S3 key with base path
   */
  _getKey(key) {
    // Normalize path separators for S3 (always use forward slashes)
    const normalizedKey = key.replace(/\\/g, '/');
    let normalizedBasePath = this.basePath.replace(/\\/g, '/');

    // Strip leading ./ for S3 (used in filesystem configs but not valid for S3 keys)
    if (normalizedBasePath.startsWith('./')) {
      normalizedBasePath = normalizedBasePath.substring(2);
    }

    return path.posix.join(normalizedBasePath, normalizedKey);
  }

  /**
   * Get full filesystem path from storage key (for mirroring)
   * @param {string} key - Storage key
   * @returns {string} Full filesystem path
   */
  _getMirrorPath(key) {
    return path.join(this.mirrorBasePath, key);
  }

  /**
   * Ensure directory exists for the given file path
   * @param {string} filePath - Full file path
   */
  async _ensureMirrorDir(filePath) {
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
   * Stream to string helper
   * @param {ReadableStream} stream - Readable stream
   * @returns {Promise<string>} Stream contents as string
   */
  async _streamToString(stream) {
    const chunks = [];
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  /**
   * Stream to Buffer helper (binary-safe, no utf8 decode)
   * @param {ReadableStream} stream - Readable stream
   * @returns {Promise<Buffer>} Stream contents as a Buffer
   */
  async _streamToBuffer(stream) {
    const chunks = [];
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  /**
   * Read raw binary file contents from S3 (no utf8 decode — for Parquet etc.)
   * @param {string} key - Storage key
   * @returns {Promise<Buffer>} File contents as a Buffer
   * @throws {Error} If file doesn't exist
   */
  async readBuffer(key) {
    const s3Key = this._getKey(key);

    try {
      const command = new GetObjectCommand({ Bucket: this.bucket, Key: s3Key });
      const response = await this.s3Client.send(command);
      return await this._streamToBuffer(response.Body);
    } catch (error) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        throw new Error(`File not found: ${key}`);
      }
      this.logger.error('Failed to read binary from S3', { key: s3Key, error: error.message });
      throw error;
    }
  }

  /**
   * Read file contents from S3
   * @param {string} key - Storage key
   * @returns {Promise<string>} File contents
   * @throws {Error} If file doesn't exist
   */
  async read(key) {
    const s3Key = this._getKey(key);
    const startTime = Date.now();

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: s3Key
      });

      const response = await this.s3Client.send(command);
      const data = await this._streamToString(response.Body);
      const duration = Date.now() - startTime;

      this.logger.trace('S3 read completed', {
        key: s3Key,
        bucket: this.bucket,
        durationMs: duration,
        sizeBytes: data.length
      });

      return data;
    } catch (error) {
      const duration = Date.now() - startTime;
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        this.logger.trace('S3 read failed - not found', { key: s3Key, durationMs: duration });
        throw new Error(`File not found: ${key}`);
      }
      this.logger.error('Failed to read from S3', { key: s3Key, durationMs: duration, error: error.message });
      throw error;
    }
  }

  /**
   * Write file contents to S3 (and optionally to filesystem mirror)
   * @param {string} key - Storage key
   * @param {string} data - Data to write
   * @param {Object} [options] - Write options
   * @param {boolean} [options.ifNotExists=false] - Only write if key doesn't exist (S3 conditional put)
   * @throws {Error} With code CONDITION_FAILED if ifNotExists and key already exists
   */
  async write(key, data, options = {}) {
    const s3Key = this._getKey(key);
    const startTime = Date.now();

    try {
      const commandParams = {
        Bucket: this.bucket,
        Key: s3Key,
        Body: data,
        ContentType: options.contentType || 'application/json'
      };

      if (options.ifNotExists) {
        commandParams.IfNoneMatch = '*';
      }

      const command = new PutObjectCommand(commandParams);
      const ret = await this.s3Client.send(command);
      const duration = Date.now() - startTime;

      this.logger.trace('S3 write completed', {
        key: s3Key,
        bucket: this.bucket,
        durationMs: duration,
        sizeBytes: data.length,
        conditional: !!options.ifNotExists
      });

      // Mirror to filesystem if enabled
      if (this.mirrorToFilesystem) {
        try {
          const mirrorPath = this._getMirrorPath(key);
          await this._ensureMirrorDir(mirrorPath);
          await fs.writeFile(mirrorPath, data, 'utf8');
        } catch (mirrorError) {
          this.logger.error('Failed to write to filesystem mirror', {
            key,
            mirrorPath: this._getMirrorPath(key),
            error: mirrorError.message
          });
        }
      }
    } catch (error) {
      const duration = Date.now() - startTime;

      // Handle conditional write failure (412 Precondition Failed)
      if (options.ifNotExists && error.$metadata?.httpStatusCode === 412) {
        const err = new Error(`File already exists: ${key}`);
        err.code = 'CONDITION_FAILED';
        throw err;
      }

      this.logger.error('Failed to write to S3', { key: s3Key, durationMs: duration, error: error.message });
      throw error;
    }
  }

  /**
   * Delete file from S3 (and optionally from filesystem mirror)
   * @param {string} key - Storage key
   */
  async delete(key) {
    const s3Key = this._getKey(key);

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: s3Key
      });

      await this.s3Client.send(command);

      // Mirror deletion to filesystem if enabled
      if (this.mirrorToFilesystem) {
        try {
          const mirrorPath = this._getMirrorPath(key);
          await fs.unlink(mirrorPath);
        } catch (mirrorError) {
          // Ignore ENOENT errors (file already deleted), log others
          if (mirrorError.code !== 'ENOENT') {
            this.logger.error('Failed to delete from filesystem mirror', {
              key,
              mirrorPath: this._getMirrorPath(key),
              error: mirrorError.message
            });
          }
        }
      }
    } catch (error) {
      // S3 delete is idempotent - it succeeds even if object doesn't exist
      // Only throw on actual errors
      if (error.$metadata?.httpStatusCode !== 404) {
        this.logger.error('Failed to delete from S3', { key: s3Key, error: error.message });
        throw error;
      }
    }
  }

  /**
   * Rename file (used for cache invalidation)
   * S3 doesn't have native move, so we copy then delete
   * @param {string} oldKey - Current storage key
   * @param {string} newKey - New storage key
   */
  async rename(oldKey, newKey) {
    const oldS3Key = this._getKey(oldKey);
    const newS3Key = this._getKey(newKey);

    try {
      // Copy object to new location
      const copyCommand = new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${oldS3Key}`,
        Key: newS3Key
      });

      await this.s3Client.send(copyCommand);

      // Delete original object
      const deleteCommand = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: oldS3Key
      });

      await this.s3Client.send(deleteCommand);

      // Mirror rename to filesystem if enabled
      if (this.mirrorToFilesystem) {
        try {
          const oldMirrorPath = this._getMirrorPath(oldKey);
          const newMirrorPath = this._getMirrorPath(newKey);
          await this._ensureMirrorDir(newMirrorPath);
          await fs.rename(oldMirrorPath, newMirrorPath);
        } catch (mirrorError) {
          // Ignore ENOENT errors (file already deleted/renamed), log others
          if (mirrorError.code !== 'ENOENT') {
            this.logger.error('Failed to rename in filesystem mirror', {
              oldKey,
              newKey,
              error: mirrorError.message
            });
          }
        }
      }
    } catch (error) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        // Source file doesn't exist - silently succeed (already invalidated/deleted)
        return;
      }
      this.logger.error('Failed to rename in S3', { oldKey: oldS3Key, newKey: newS3Key, error: error.message });
      throw error;
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
   *                                      Returns only CommonPrefixes instead of all files
   *                                      WARNING: Changes behavior significantly, use only when needed
   * @param {number} options.maxKeys - ADVANCED: Maximum number of keys to return per page
   *                                   WARNING: May return incomplete results
   * @returns {Promise<string[]>} Array of matching keys or prefixes (with basePath removed)
   */
  async list(prefix = '', options = {}) {
    let s3Prefix = this._getKey(prefix);

    // When using delimiter, ensure prefix ends with delimiter for proper directory listing
    // This prevents matching unrelated keys (e.g., 'storage' matching 'storage-test')
    if (options.delimiter && s3Prefix && !s3Prefix.endsWith(options.delimiter)) {
      s3Prefix = s3Prefix + options.delimiter;
    }

    const results = [];
    let continuationToken = null;

    try {
      do {
        const commandParams = {
          Bucket: this.bucket,
          Prefix: s3Prefix,
          ContinuationToken: continuationToken
        };

        // Add delimiter if provided (for efficient directory listing)
        if (options.delimiter) {
          commandParams.Delimiter = options.delimiter;
        }

        // Add maxKeys if provided
        if (options.maxKeys) {
          commandParams.MaxKeys = options.maxKeys;
        }

        // Add startAfter if provided (skip keys lexicographically before this value)
        // Only applies to the first request (not paginated continuations)
        if (options.startAfter && !continuationToken) {
          commandParams.StartAfter = this._getKey(options.startAfter);
        }

        const command = new ListObjectsV2Command(commandParams);
        const response = await this.s3Client.send(command);

        // When using delimiter, S3 returns CommonPrefixes for "directories"
        if (options.delimiter && response.CommonPrefixes) {
          for (const prefix of response.CommonPrefixes) {
            // Remove the basePath prefix to return relative keys
            const normalizedBasePath = this.basePath.replace(/\\/g, '/');
            let relativeKey = prefix.Prefix;

            if (relativeKey.startsWith(normalizedBasePath + '/')) {
              relativeKey = relativeKey.substring(normalizedBasePath.length + 1);
            } else if (relativeKey.startsWith(normalizedBasePath)) {
              relativeKey = relativeKey.substring(normalizedBasePath.length);
            }

            // Remove trailing delimiter
            if (relativeKey.endsWith(options.delimiter)) {
              relativeKey = relativeKey.slice(0, -1);
            }

            results.push(relativeKey);
          }
        }

        // Process Contents (files at this level)
        // When delimiter is used, this only includes files at the current level, not subdirectories
        if (response.Contents) {
          for (const object of response.Contents) {
            // Remove the basePath prefix to return relative keys
            const normalizedBasePath = this.basePath.replace(/\\/g, '/');
            let relativeKey = object.Key;

            if (relativeKey.startsWith(normalizedBasePath + '/')) {
              relativeKey = relativeKey.substring(normalizedBasePath.length + 1);
            } else if (relativeKey.startsWith(normalizedBasePath)) {
              relativeKey = relativeKey.substring(normalizedBasePath.length);
            }

            results.push(relativeKey);
          }
        }

        continuationToken = response.NextContinuationToken;
      } while (continuationToken);

      return results;
    } catch (error) {
      this.logger.error('Failed to list S3 objects', { prefix: s3Prefix, error: error.message });
      throw error;
    }
  }

  /**
   * Check if file exists in S3
   * @param {string} key - Storage key
   * @returns {Promise<boolean>} True if file exists
   */
  async exists(key) {
    const s3Key = this._getKey(key);

    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: s3Key
      });

      await this.s3Client.send(command);
      return true;
    } catch (error) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      // For other errors, throw them
      this.logger.error('Failed to check S3 object existence', { key: s3Key, error: error.message });
      throw error;
    }
  }
}

module.exports = S3Storage;

const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand, CopyObjectCommand, CreateSessionCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const path = require('path');
const fs = require('fs').promises;

/**
 * S3 Express One Zone storage backend implementation
 *
 * Provides single-digit millisecond latency for read-heavy workloads using directory buckets.
 *
 * Key differences from S3Storage:
 * - Uses CreateSession for session-based authentication
 * - Directory bucket naming: bucket-name--zone-id--x-s3
 * - Optimized for cache/sessions/tokens (read-heavy data)
 * - Higher per-request costs, lower storage costs
 * - Single AZ (acceptable for ephemeral cache data)
 *
 * Performance targets:
 * - Read latency: <10ms p50, <20ms p99
 * - Throughput: 200K read req/s, 100K write req/s per bucket
 */
class S3expressStorage {
  /**
   * @param {Object} config - Configuration object
   * @param {Object} config.storage - Storage configuration
   * @param {string} config.storage.basePath - Base path/prefix for keys
   * @param {string} config.tenantId - Tenant identifier
   *
   * Environment variables used:
   * - AIRBRX_S3EXPRESS_BUCKET: S3 Express directory bucket name (required)
   * - AIRBRX_S3EXPRESS_REGION: AWS region (default: us-east-1)
   * - AIRBRX_S3EXPRESS_AVAILABILITY_ZONE: Availability zone for bucket (optional)
   * - AIRBRX_AWS_ACCESS_KEY_ID: AWS access key ID (optional - only for explicit credentials)
   * - AIRBRX_AWS_SECRET_ACCESS_KEY: AWS secret access key (optional - only for explicit credentials)
   *
   * Note: Do NOT use AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY - Lambda sets these with temporary
   * STS credentials that require AWS_SESSION_TOKEN. If no AIRBRX_AWS_* credentials are set,
   * the SDK uses its default credential chain (IAM roles, instance profiles, etc.), matching
   * S3Storage's behavior.
   */
  constructor(config) {
    this.logger = require('./WinstonLogger')('S3expressStorage');

    // Get bucket from config first, fallback to environment variable
    const bucket = config.storage.bucket || process.env.AIRBRX_S3EXPRESS_BUCKET;
    const region = config.storage.region || process.env.AIRBRX_S3EXPRESS_REGION || 'us-east-1';
    const availabilityZone = config.storage.availabilityZone || process.env.AIRBRX_S3EXPRESS_AVAILABILITY_ZONE;

    // Check for AIRBRX_AWS_* variables only - do NOT fall back to AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY.
    // Lambda sets AWS_* with temporary STS credentials that require AWS_SESSION_TOKEN; if no explicit
    // AIRBRX_AWS_* credentials are provided, let the SDK use its default credential chain instead.
    const accessKeyId = process.env.AIRBRX_AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AIRBRX_AWS_SECRET_ACCESS_KEY;

    // Validate required configuration
    if (!bucket) {
      throw new Error('S3 Express bucket is required (config.storage.bucket or AIRBRX_S3EXPRESS_BUCKET environment variable)');
    }

    // Validate directory bucket naming format: bucket-name--zone-id--x-s3
    if (!bucket.includes('--') || !bucket.endsWith('--x-s3')) {
      this.logger.warn('S3 Express bucket name does not follow directory bucket format (bucket-name--zone-id--x-s3)', {
        bucket,
        expectedFormat: 'bucket-name--zone-id--x-s3'
      });
    }

    this.bucket = bucket;
    this.region = region;
    this.availabilityZone = availabilityZone;

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

    // Configure HTTP handler with increased socket pool for high-concurrency operations
    clientConfig.requestHandler = new NodeHttpHandler({
      maxSockets: 200,
      socketAcquisitionWarningTimeout: 10000
    });

    this.s3Client = new S3Client(clientConfig);

    // Session management
    this.sessionCredentials = null;
    this.sessionExpiration = null;
    this.sessionRefreshTimer = null;
    this.sessionRefreshInProgress = false;

    this.logger.info('S3expressStorage initialized', {
      bucket: this.bucket,
      region: region,
      basePath: this.basePath,
      availabilityZone: availabilityZone || 'not-specified',
      hasCredentials: !!(accessKeyId && secretAccessKey)
    });

    // Create initial session in background to avoid first-request latency
    this._createSession().catch(err => {
      this.logger.error('Failed to create initial S3 Express session', {
        bucket: this.bucket,
        error: err.message
      });
    });
  }

  /**
   * Create session for directory bucket operations
   * Sessions last ~4-5 minutes and are automatically refreshed in background
   * @private
   */
  async _createSession() {
    // Prevent concurrent session refresh attempts
    if (this.sessionRefreshInProgress) {
      this.logger.debug('Session refresh already in progress, skipping');
      return;
    }

    this.sessionRefreshInProgress = true;
    const startTime = Date.now();

    try {
      this.logger.trace('Creating S3 Express session', { bucket: this.bucket });

      const command = new CreateSessionCommand({
        Bucket: this.bucket,
        SessionMode: 'ReadWrite' // Default mode for cache operations
      });

      const response = await this.s3Client.send(command);
      const duration = Date.now() - startTime;

      // Store session credentials (SDK manages these automatically, but we track for logging)
      this.sessionCredentials = response.Credentials;

      // Calculate expiration time and schedule background refresh
      if (response.Credentials?.Expiration) {
        this.sessionExpiration = new Date(response.Credentials.Expiration).getTime();
        const expiresInMinutes = Math.floor((this.sessionExpiration - Date.now()) / 60000);
        const expiresInSeconds = Math.floor((this.sessionExpiration - Date.now()) / 1000);

        this.logger.trace('S3 Express session created successfully', {
          bucket: this.bucket,
          durationMs: duration,
          expiresInMinutes,
          expiresInSeconds,
          expirationTime: new Date(this.sessionExpiration).toISOString()
        });

        // Schedule background refresh 1 minute before expiration
        // Clear any existing timer first
        if (this.sessionRefreshTimer) {
          clearTimeout(this.sessionRefreshTimer);
        }

        const refreshDelay = Math.max(0, (this.sessionExpiration - Date.now() - 60000));
        const refreshInMinutes = Math.floor(refreshDelay / 60000);

        this.logger.trace('Scheduled background session refresh', {
          bucket: this.bucket,
          refreshInMinutes,
          refreshDelayMs: refreshDelay
        });

        this.sessionRefreshTimer = setTimeout(() => {
          this.logger.trace('Background session refresh triggered', { bucket: this.bucket });
          this._createSession().catch(err => {
            this.logger.error('Background session refresh failed', {
              bucket: this.bucket,
              error: err.message
            });
          });
        }, refreshDelay);

        // Prevent timer from keeping process alive
        if (this.sessionRefreshTimer.unref) {
          this.sessionRefreshTimer.unref();
        }
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error('Failed to create S3 Express session', {
        bucket: this.bucket,
        durationMs: duration,
        error: error.message
      });
      throw error;
    } finally {
      this.sessionRefreshInProgress = false;
    }
  }

  /**
   * Ensure session is valid before operations
   * With background refresh, this should rarely need to create a new session
   * @private
   */
  async _ensureSession() {
    // Check if session exists and is not expired
    if (this.sessionCredentials && this.sessionExpiration) {
      const now = Date.now();
      const timeUntilExpiration = this.sessionExpiration - now;
      const timeUntilExpirationSeconds = Math.floor(timeUntilExpiration / 1000);

      // Session is still valid (has more than 30 seconds remaining)
      if (timeUntilExpiration > 30000) {
        this.logger.trace('Session is valid', {
          bucket: this.bucket,
          timeUntilExpirationSeconds
        });
        return;
      }

      // Session expired or about to expire - create new one synchronously
      this.logger.warn('Session expired or about to expire, creating new session synchronously', {
        bucket: this.bucket,
        timeUntilExpirationMs: timeUntilExpiration,
        timeUntilExpirationSeconds
      });
    } else {
      // No valid session - create one (should only happen on first request or if background refresh failed)
      this.logger.trace('No active session, creating new session', { bucket: this.bucket });
    }

    await this._createSession();
  }

  /**
   * Cleanup method to clear timers
   * Call this when shutting down the storage instance
   */
  destroy() {
    if (this.sessionRefreshTimer) {
      clearTimeout(this.sessionRefreshTimer);
      this.sessionRefreshTimer = null;
    }
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
   * Read raw binary file contents from S3 Express (no utf8 decode — for Parquet etc.)
   * @param {string} key - Storage key
   * @returns {Promise<Buffer>} File contents as a Buffer
   * @throws {Error} If file doesn't exist
   */
  async readBuffer(key) {
    await this._ensureSession();

    const s3Key = this._getKey(key);

    try {
      const command = new GetObjectCommand({ Bucket: this.bucket, Key: s3Key });
      const response = await this.s3Client.send(command);
      return await this._streamToBuffer(response.Body);
    } catch (error) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        throw new Error(`File not found: ${key}`);
      }
      this.logger.error('Failed to read binary from S3 Express', { key: s3Key, error: error.message });
      throw error;
    }
  }

  /**
   * Read file contents from S3 Express
   * @param {string} key - Storage key
   * @returns {Promise<string>} File contents
   * @throws {Error} If file doesn't exist
   */
  async read(key) {
    await this._ensureSession();

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

      this.logger.trace('S3 Express read completed', {
        key: s3Key,
        bucket: this.bucket,
        durationMs: duration,
        sizeBytes: data.length
      });

      return data;
    } catch (error) {
      const duration = Date.now() - startTime;
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        this.logger.trace('S3 Express read failed - not found', { key: s3Key, durationMs: duration });
        throw new Error(`File not found: ${key}`);
      }
      this.logger.error('Failed to read from S3 Express', { key: s3Key, durationMs: duration, error: error.message });
      throw error;
    }
  }

  /**
   * Write file contents to S3 Express
   *
   * Directory buckets support conditional writes, so `ifNotExists` behaves exactly
   * as it does on S3Storage. This matters beyond convenience: state-manager's
   * processing lock and delta-writer's Delta commit are both atomic *only* because
   * of it. Silently dropping the condition would leave the lock always "acquired"
   * and let concurrent Delta commits overwrite each other. (Ported from the
   * airbrx-api copy of StorageFactory, which already carried this; the two copies
   * are separate vendored forks.)
   *
   * @param {string} key - Storage key
   * @param {string} data - Data to write
   * @param {Object} [options] - Write options
   * @param {string} [options.contentType] - Content type (Parquet writes rely on this)
   * @param {boolean} [options.ifNotExists=false] - Only write if key doesn't exist (S3 If-None-Match: *)
   * @throws {Error} With code CONDITION_FAILED if ifNotExists and key already exists
   */
  async write(key, data, options = {}) {
    await this._ensureSession();

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

      await this.s3Client.send(command);
      const duration = Date.now() - startTime;

      this.logger.trace('S3 Express write completed', {
        key: s3Key,
        bucket: this.bucket,
        durationMs: duration,
        sizeBytes: data.length,
        conditional: !!options.ifNotExists
      });
    } catch (error) {
      const duration = Date.now() - startTime;

      // Conditional write failure (412 Precondition Failed)
      if (options.ifNotExists && error.$metadata?.httpStatusCode === 412) {
        const err = new Error(`File already exists: ${key}`);
        err.code = 'CONDITION_FAILED';
        throw err;
      }

      this.logger.error('Failed to write to S3 Express', { key: s3Key, durationMs: duration, error: error.message });
      throw error;
    }
  }

  /**
   * Delete file from S3 Express
   * @param {string} key - Storage key
   */
  async delete(key) {
    await this._ensureSession();

    const s3Key = this._getKey(key);

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: s3Key
      });

      await this.s3Client.send(command);
    } catch (error) {
      // S3 delete is idempotent - it succeeds even if object doesn't exist
      // Only throw on actual errors
      if (error.$metadata?.httpStatusCode !== 404) {
        this.logger.error('Failed to delete from S3 Express', { key: s3Key, error: error.message });
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
    await this._ensureSession();

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
    } catch (error) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        // Source file doesn't exist - silently succeed (already invalidated/deleted)
        return;
      }
      this.logger.error('Failed to rename in S3 Express', { oldKey: oldS3Key, newKey: newS3Key, error: error.message });
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
   * Note: S3 Express directory buckets return unsorted results from ListObjectsV2
   *
   * @param {string} prefix - Key prefix to filter by
   * @param {Object} options - ADVANCED: Optional parameters (use with caution)
   * @param {string} options.delimiter - ADVANCED: Delimiter for non-recursive listing (e.g., '/')
   *                                      Returns only CommonPrefixes instead of all files
   *                                      WARNING: Changes behavior significantly, use only when needed
   * @param {number} options.maxKeys - ADVANCED: Maximum number of keys to return per page
   *                                   WARNING: May return incomplete results
   * @param {string} options.startAfter - Drop keys lexicographically <= this value.
   *                                       Applied client-side because S3 Express directory
   *                                       buckets reject the native ListObjectsV2 StartAfter
   *                                       parameter. Compared against the relative key form
   *                                       this method returns (basePath stripped), matching
   *                                       what the caller passes in.
   * @returns {Promise<string[]>} Array of matching keys or prefixes (with basePath removed)
   */
  async list(prefix = '', options = {}) {
    await this._ensureSession();

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

      // S3 Express directory buckets reject the native StartAfter parameter on
      // ListObjectsV2 ("This bucket does not support start-after query parameter
      // for ListObjectsV2 API"), so apply it client-side. Exclusive of the anchor,
      // matching S3's native StartAfter semantics.
      if (options.startAfter) {
        return results.filter(key => key > options.startAfter);
      }

      return results;
    } catch (error) {
      this.logger.error('Failed to list S3 Express objects', { prefix: s3Prefix, error: error.message });
      throw error;
    }
  }

  /**
   * Check if file exists in S3 Express
   * @param {string} key - Storage key
   * @returns {Promise<boolean>} True if file exists
   */
  async exists(key) {
    await this._ensureSession();

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
      this.logger.error('Failed to check S3 Express object existence', { key: s3Key, error: error.message });
      throw error;
    }
  }
}

module.exports = S3expressStorage;

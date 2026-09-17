const fs = require('fs');
const path = require('path');

/**
 * EnvironmentDetector - Detects runtime environment and provides environment-specific defaults
 *
 * Supports detection of:
 * - AWS Lambda (serverless function)
 * - Containers: Docker, Kubernetes, and ECS/Fargate (isDocker covers all three)
 * - Local (development/traditional server)
 *
 * Usage:
 *   if (EnvironmentDetector.isLambda) {
 *     // Lambda-specific configuration
 *   }
 *
 *   const defaults = EnvironmentDetector.getStorageDefaults();
 */
class EnvironmentDetector {
  /**
   * Detect if running in AWS Lambda environment
   * @returns {boolean} True if running in Lambda
   */
  static get isLambda() {
    return !!process.env.AWS_LAMBDA_FUNCTION_NAME;
  }

  /**
   * Detect if running under ECS or Fargate.
   *
   * Fargate runs containerd, so it has no /.dockerenv, and its task cgroups sit
   * under /ecs/... — neither of the signals isDocker looks for. The task metadata
   * endpoint variable is injected by the agent on every ECS/Fargate task and is
   * the reliable signal.
   *
   * @returns {boolean} True if running as an ECS/Fargate task
   */
  static get isEcs() {
    return !!(
      process.env.ECS_CONTAINER_METADATA_URI_V4 ||
      process.env.ECS_CONTAINER_METADATA_URI
    );
  }

  /**
   * Detect if running in a container (Docker, Kubernetes, or ECS/Fargate)
   *
   * Misdetection is not cosmetic: a container that reads as "local" turns on
   * colorized console output (escape codes into the log aggregator) and the
   * rotating-file transport, which writes to ephemeral storage nothing collects.
   *
   * @returns {boolean} True if running in a container
   */
  static get isDocker() {
    if (this.isEcs) {
      return true;
    }

    // Kubernetes always injects the service host for the API server. Checked
    // before filesystem inspection so a cgroup/procfs read failure (e.g. a pod
    // whose security policy blocks /proc/self/cgroup) can't suppress a valid
    // Kubernetes detection by throwing before this signal is ever seen.
    if (process.env.KUBERNETES_SERVICE_HOST) {
      return true;
    }

    try {
      // Check for .dockerenv file (most reliable indicator under Docker proper)
      if (fs.existsSync('/.dockerenv')) {
        return true;
      }

      // Fallback: cgroup inspection. Under cgroup v1 the container runtime shows
      // up in the path. Under cgroup v2 the in-container view collapses to a
      // single "0::/" line with the identifying path stripped, so absence of a
      // match here is not evidence of running on a host.
      if (fs.existsSync('/proc/self/cgroup')) {
        const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
        if (
          cgroup.includes('docker') ||
          cgroup.includes('kubepods') ||
          cgroup.includes('containerd') ||
          cgroup.includes('/ecs/')
        ) {
          return true;
        }
      }

      return false;
    } catch (error) {
      // If we can't read filesystem, assume not a container
      return false;
    }
  }

  /**
   * Detect if running in local development environment
   * @returns {boolean} True if running locally (not Lambda or Docker)
   */
  static get isLocal() {
    return !this.isLambda && !this.isDocker;
  }

  /**
   * Get human-readable environment name
   * @returns {string} Environment name (lambda, docker, or local)
   */
  static get environmentName() {
    if (this.isLambda) return 'lambda';
    if (this.isEcs) return 'ecs';
    if (this.isDocker) return 'docker';
    return 'local';
  }

  /**
   * Get storage configuration defaults based on environment
   * @returns {Object} Storage defaults for current environment
   */
  static getStorageDefaults() {
    if (this.isLambda) {
      // Lambda: Force S3 storage (no filesystem persistence)
      return {
        type: 's3',
        allowFilesystem: false,
        reason: 'Lambda /tmp is ephemeral and limited to 512MB-10GB',
      };
    }

    if (this.isDocker) {
      // Docker: Prefer S3 but allow filesystem with volume mounts
      return {
        type: 's3',
        allowFilesystem: true,
        reason: 'Docker containers should use S3 for production, filesystem for development with volumes',
      };
    }

    // Local: Default to filesystem for development convenience
    return {
      type: 'filesystem',
      allowFilesystem: true,
      reason: 'Local development defaults to filesystem storage',
    };
  }

  /**
   * Get logging configuration defaults based on environment
   * @returns {Object} Logging defaults for current environment
   */
  static getLoggingDefaults() {
    if (this.isLambda) {
      // Lambda: Console-only with JSON format (CloudWatch ingestion)
      return {
        enableConsole: true,
        enableDisk: false,
        format: 'json',
        reason: 'Lambda logs go to CloudWatch; disk logging not supported',
      };
    }

    if (this.isDocker) {
      // Docker: Console-only (collected by Docker logs or log driver)
      return {
        enableConsole: true,
        enableDisk: false,
        format: 'json',
        reason: 'Docker logs collected via stdout/stderr',
      };
    }

    // Local: Console + disk with human-readable format
    return {
      enableConsole: true,
      enableDisk: true,
      format: 'pretty',
      reason: 'Local development uses both console and disk logging',
    };
  }

  /**
   * Check if a .env file should be loaded
   * Lambda provides environment variables natively, so a .env file is not needed
   * @returns {boolean} True if a .env file should be loaded
   */
  static get shouldLoadDotenv() {
    // Lambda has environment variables pre-configured
    if (this.isLambda) return false;

    // Docker and local can use .env files
    return true;
  }

  /**
   * Validate storage configuration against environment constraints
   * @param {string} storageType - Requested storage type (filesystem or s3)
   * @throws {Error} If storage type is incompatible with environment
   */
  static validateStorageType(storageType) {
    const defaults = this.getStorageDefaults();

    if (storageType === 'filesystem' && !defaults.allowFilesystem) {
      throw new Error(
        `Filesystem storage not supported in ${this.environmentName} environment. ` +
          `Reason: ${defaults.reason}. Use S3 storage instead.`
      );
    }
  }

  /**
   * Get environment information for debugging
   * @returns {Object} Environment details
   */
  static getEnvironmentInfo() {
    return {
      environment: this.environmentName,
      isLambda: this.isLambda,
      isDocker: this.isDocker,
      isLocal: this.isLocal,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      // Lambda-specific info
      ...(this.isLambda && {
        functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
        functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION,
        memorySize: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE,
        region: process.env.AWS_REGION,
      }),
    };
  }
}

module.exports = EnvironmentDetector;

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const DateTimeUtils = require('./DateTimeUtils');
const EnvironmentDetector = require('./EnvironmentDetector');

/**
 * Custom format for console output (human-readable)
 */
const consoleFormat = winston.format.printf(({ timestamp, level, message, module, ...metadata }) => {
  const modulePadded = (module || 'Airbrx').padEnd(24);
  const levelUpper = level.toUpperCase().padEnd(5);
  const time = DateTimeUtils.nowTimeOnly();

  let metaStr = '';
  const filtered = Object.keys(metadata)
    .filter((key) => !['timestamp', 'level', 'message', 'module', 'splat', Symbol.for('splat')].includes(key))
    .reduce((obj, key) => {
      obj[key] = metadata[key];
      return obj;
    }, {});

  if (Object.keys(filtered).length > 0) {
    metaStr = ` ${JSON.stringify(filtered)}`;
  }

  return `[${time}] [${modulePadded}] [${levelUpper}] ${message}${metaStr}`;
});

/**
 * Custom format for file output (structured JSON)
 */
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: () => DateTimeUtils.now() }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

/**
 * Sanitize sensitive data from logs
 */
const sanitizeFormat = winston.format((info) => {
  const sensitiveFields = ['password', 'token', 'secret', 'authorization'];

  const sanitize = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;

    const sanitized = Array.isArray(obj) ? [...obj] : { ...obj };

    for (const [key, value] of Object.entries(sanitized)) {
      if (sensitiveFields.some((field) => key.toLowerCase().includes(field))) {
        sanitized[key] = '[REDACTED]';
      } else if (Buffer.isBuffer(value)) {
        sanitized[key] = `[BUFFER:${value.length}bytes]`;
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = sanitize(value);
      }
    }

    return sanitized;
  };

  return sanitize(info);
});

/**
 * Per-module log level overrides
 * Map<string, string> - moduleName -> logLevel
 */
const moduleLevels = new Map();

/**
 * Module-level filtering format
 * Filters log messages based on per-module log level configuration
 */
const moduleLevelFilter = winston.format((info) => {
  // If no module specified, use global level
  if (!info.module) {
    return info;
  }

  // Check if this module has a specific level override
  const moduleLevel = moduleLevels.get(info.module);
  if (!moduleLevel) {
    return info; // No override, use global level
  }

  // Get numeric priority for levels
  const levelPriority = {
    critical: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5,
  };

  const messagePriority = levelPriority[info.level] || 999;
  const moduleLevelPriority = levelPriority[moduleLevel] || 3;

  // Filter out if message priority is lower (higher number) than module level
  if (messagePriority > moduleLevelPriority) {
    return false; // Filter out this message
  }

  return info;
});

/**
 * Create transports based on configuration and environment
 */
function createTransports(config) {
  const transports = [];

  // If module-level overrides exist, use most permissive level to let module filter handle it
  // Otherwise use global config level
  const effectiveLevel = moduleLevels.size > 0 ? 'trace' : config.logLevel;

  // Environment-specific logging defaults are applied where globalConfig is built,
  // so they are already reflected in `config` by the time transports are assembled.

  // Lambda/container: Use JSON format for structured logging (CloudWatch, Docker logs)
  // Local: Use pretty format for human readability
  const shouldUseJsonFormat = EnvironmentDetector.isLambda || EnvironmentDetector.isDocker;

  // Console transport - always enabled (required for Lambda/Docker log collection)
  if (config.enableConsole) {
    const consoleTransportFormat = shouldUseJsonFormat
      ? winston.format.combine(
          winston.format.timestamp({ format: () => DateTimeUtils.now() }),
          moduleLevelFilter(),
          sanitizeFormat(),
          winston.format.json() // JSON for Lambda/Docker
        )
      : winston.format.combine(
          moduleLevelFilter(),
          sanitizeFormat(),
          consoleFormat,
          winston.format.colorize({ all: true }) // Pretty for local
        );

    transports.push(
      new winston.transports.Console({
        level: effectiveLevel,
        format: consoleTransportFormat,
      })
    );
  }

  // Daily rotate file transport - ONLY for local development
  // Lambda: Disk logging not supported (ephemeral /tmp)
  // Docker: Logs collected via stdout/stderr (disk logging optional but discouraged)
  if (config.enableDisk && !EnvironmentDetector.isLambda) {
    if (EnvironmentDetector.isDocker) {
      console.warn(
        '[WinstonLogger] Disk logging enabled in Docker environment. ' +
          'Consider using stdout/stderr and Docker log drivers instead.'
      );
    }

    transports.push(
      new DailyRotateFile({
        dirname: path.join(config.logDir, 'daily'),
        filename: 'airbrx-%DATE%.log',
        datePattern: 'YYYY-MM-DD-HH',
        zippedArchive: false,
        maxSize: '20m',
        maxFiles: '14d',
        format: winston.format.combine(
          moduleLevelFilter(), // Apply module-level filtering
          sanitizeFormat(),
          fileFormat
        ),
      })
    );
  } else if (config.enableDisk && EnvironmentDetector.isLambda) {
    console.warn(
      '[WinstonLogger] Disk logging disabled in Lambda environment. ' +
        'All logs go to CloudWatch via console output. ' +
        `Environment: ${EnvironmentDetector.environmentName}`
    );
  }

  return transports;
}

// Global configuration
const globalConfig = {
  logLevel: process.env.AIRBRX_LOG_LEVEL || 'info',
  logDir: process.env.AIRBRX_LOG_DIR || path.join(process.cwd(), 'logs'),
  enableConsole: process.env.AIRBRX_LOG_CONSOLE !== 'false',
  // Environment decides, AIRBRX_LOG_DISK overrides. Previously this was
  // `!== 'false'`, i.e. on everywhere unless explicitly disabled, so
  // getLoggingDefaults() was computed and then ignored.
  //
  // Note this repo's own entry points never reach the fallback arm:
  // config-loader's CONFIG_DEFAULTS sets AIRBRX_LOG_DISK='false' and
  // index.js runs initialize() before anything requires this module, so disk
  // logging is off here regardless. The fallback is for other StorageFactory
  // consumers that load the logger without config-loader. Deliberately left
  // that way — activating it would turn on a 14-day rotating file transport
  // for every local run.
  enableDisk:
    process.env.AIRBRX_LOG_DISK !== undefined
      ? process.env.AIRBRX_LOG_DISK !== 'false'
      : EnvironmentDetector.getLoggingDefaults().enableDisk,
  slackWebhookUrl: process.env.AIRBRX_SLACK_WEBHOOK_URL || null,
};

/**
 * Initialize module-level log configuration from environment variable
 * Format: AIRBRX_MODULE_LOG_LEVELS="ModuleName1:debug,ModuleName2:trace"
 */
function initializeModuleLevelsFromEnv() {
  const envModuleLevels = process.env.AIRBRX_MODULE_LOG_LEVELS;
  if (!envModuleLevels) {
    console.log('[WinstonLogger] No AIRBRX_MODULE_LOG_LEVELS configured - using global level for all modules');
    return;
  }

  console.log(
    `[WinstonLogger] Initializing module-level log overrides from: AIRBRX_MODULE_LOG_LEVELS="${envModuleLevels}"`
  );

  const validLevels = ['critical', 'error', 'warn', 'info', 'debug', 'trace'];
  const pairs = envModuleLevels
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const pair of pairs) {
    const [moduleName, level] = pair.split(':').map((s) => s.trim());
    if (moduleName && level && validLevels.includes(level)) {
      moduleLevels.set(moduleName, level);
      console.log(`[WinstonLogger]   ✓ ${moduleName}: ${level}`);
    } else {
      console.warn(
        `[WinstonLogger]   ✗ Invalid module log level configuration: ${pair} (expected format: ModuleName:level)`
      );
    }
  }

  console.log(`[WinstonLogger] Module-level overrides configured: ${moduleLevels.size} module(s)`);
}

// Initialize module levels from environment on load
initializeModuleLevelsFromEnv();

/**
 * Single Winston logger instance
 */
let loggerInstance = null;

/**
 * Winston-based logger for Airbrx Data Proxy
 *
 * Replaces ProxyLogger with production-grade Winston implementation.
 *
 * Features:
 * - Async, non-blocking logging
 * - Automatic log rotation
 * - Multiple transports (console, file, Slack)
 * - Child loggers for per-request/per-context logging
 * - Structured logging with sanitization
 *
 * Usage:
 *   const logger = require('./WinstonLogger')('ModuleName');
 *   logger.info('Message', { key: 'value' });
 *   logger.error('Error occurred', { error: err.message });
 *
 *   // Or get base logger
 *   const logger = require('./WinstonLogger')();
 *   logger.info('Message', { module: 'MyModule' });
 */
function createLogger(moduleName = null) {
  // Initialize logger on first use
  if (!loggerInstance) {
    // If module-level overrides exist, set logger to most permissive level
    // to allow module filter to do the actual filtering
    const effectiveLevel = moduleLevels.size > 0 ? 'trace' : globalConfig.logLevel;

    loggerInstance = winston.createLogger({
      level: effectiveLevel,
      levels: {
        critical: 0, // Highest priority - triggers Slack alerts
        error: 1,
        warn: 2,
        info: 3,
        debug: 4,
        trace: 5,
      },
      transports: createTransports(globalConfig),
      exitOnError: false,
    });

    // Add custom level colors
    winston.addColors({
      critical: 'red bold',
      error: 'red',
      warn: 'yellow',
      info: 'green',
      debug: 'blue',
      trace: 'gray',
    });
  }

  // If module name provided, return child logger with module metadata
  if (moduleName) {
    return loggerInstance.child({ module: moduleName });
  }

  // Otherwise return base logger
  return loggerInstance;
}

/**
 * Set global log level
 */
createLogger.setLevel = function (level) {
  globalConfig.logLevel = level;
  process.env.AIRBRX_LOG_LEVEL = level;
  if (loggerInstance) {
    loggerInstance.level = level;
  }
};

/**
 * Get current log level
 */
createLogger.getLevel = function () {
  return globalConfig.logLevel;
};

/**
 * Configure global logging settings
 */
createLogger.configure = function (config) {
  Object.assign(globalConfig, config);

  // Recreate logger with new config if it exists
  if (loggerInstance) {
    loggerInstance.close();
    loggerInstance = null;
  }
};

/**
 * Add Slack transport for critical alerts
 */
createLogger.addSlackTransport = function (webhookUrl, options = {}) {
  if (!loggerInstance) {
    createLogger(); // Initialize logger
  }

  const SlackTransport = require('./transports/SlackTransport');
  loggerInstance.add(
    new SlackTransport({
      webhookUrl,
      level: options.level || 'critical', // Default to critical level
      ...options,
    })
  );
};

/**
 * Add custom transport
 */
createLogger.addTransport = function (transport) {
  if (!loggerInstance) {
    createLogger(); // Initialize logger
  }
  loggerInstance.add(transport);
};

/**
 * Remove a transport
 */
createLogger.removeTransport = function (transport) {
  if (loggerInstance) {
    loggerInstance.remove(transport);
  }
};

/**
 * Shutdown logger gracefully
 */
createLogger.shutdown = async function () {
  if (loggerInstance) {
    return new Promise((resolve) => {
      loggerInstance.on('finish', resolve);
      loggerInstance.end();
    });
  }
};

/**
 * Get the base logger instance (for advanced usage)
 */
createLogger.getInstance = function () {
  if (!loggerInstance) {
    createLogger(); // Initialize logger
  }
  return loggerInstance;
};

/**
 * Set log level for a specific module
 * @param {string} moduleName - Module name to configure
 * @param {string} level - Log level (error, warn, info, debug, trace)
 */
createLogger.setModuleLevel = function (moduleName, level) {
  const validLevels = ['critical', 'error', 'warn', 'info', 'debug', 'trace'];
  if (!validLevels.includes(level)) {
    throw new Error(`Invalid log level: ${level}. Valid levels: ${validLevels.join(', ')}`);
  }
  moduleLevels.set(moduleName, level);
};

/**
 * Get all module-level log configurations
 * @returns {Object} Map of module names to log levels
 */
createLogger.getModuleLevels = function () {
  return Object.fromEntries(moduleLevels);
};

/**
 * Clear log level override for a specific module
 * @param {string} moduleName - Module name to clear
 */
createLogger.clearModuleLevel = function (moduleName) {
  moduleLevels.delete(moduleName);
};

/**
 * Clear all module-level overrides
 */
createLogger.clearAllModuleLevels = function () {
  moduleLevels.clear();
};

// Legacy compatibility
createLogger.forModule = (moduleName) => createLogger(moduleName);
createLogger.setGlobalLevel = createLogger.setLevel;

module.exports = createLogger;

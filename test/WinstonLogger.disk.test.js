// AIR-1596: getLoggingDefaults() was computed and then ignored — enableDisk came
// from `AIRBRX_LOG_DISK !== 'false'`, which is true unless explicitly disabled.
// These pin that the environment now decides and the env var only overrides.
//
// Scope: these deliberately run with AIRBRX_LOG_DISK unset, which this repo's own
// entry points never do — config-loader defaults it to 'false' before WinstonLogger
// loads, so disk logging is off here whatever the environment says. What's pinned is
// the module's own contract, which other StorageFactory consumers do reach.
//
// The real transport is mocked out: instantiating it creates log directories, which
// a test run should never do.

jest.mock('winston-daily-rotate-file', () => {
  const Transport = require('winston-transport');
  return class MockDailyRotateFile extends Transport {
    static instances = [];
    constructor(opts) {
      super(opts);
      MockDailyRotateFile.instances.push(opts);
    }
    log(info, next) { next(); }
  };
});

const CONTAINER_ENV_VARS = [
  'AWS_LAMBDA_FUNCTION_NAME',
  'ECS_CONTAINER_METADATA_URI_V4',
  'KUBERNETES_SERVICE_HOST',
  'AIRBRX_LOG_DISK'
];

/**
 * Re-require WinstonLogger so its module-level globalConfig re-evaluates against
 * the current environment, then build a logger and report whether the rotating
 * file transport was constructed.
 */
function diskTransportUsed() {
  let used;
  jest.isolateModules(() => {
    const MockRotate = require('winston-daily-rotate-file');
    MockRotate.instances.length = 0;
    const createLogger = require('../lib/WinstonLogger');
    createLogger('DiskGatingTest');
    used = MockRotate.instances.length > 0;
  });
  return used;
}

describe('WinstonLogger disk transport gating', () => {
  let saved;

  beforeEach(() => {
    saved = {};
    for (const key of CONTAINER_ENV_VARS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of CONTAINER_ENV_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test('a Fargate task gets no rotating file transport', () => {
    process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://169.254.170.2/v4/abc';
    expect(diskTransportUsed()).toBe(false);
  });

  test('a Kubernetes pod gets no rotating file transport', () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1';
    expect(diskTransportUsed()).toBe(false);
  });

  test('Lambda gets no rotating file transport', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'log-summary';
    expect(diskTransportUsed()).toBe(false);
  });

  test('AIRBRX_LOG_DISK=true still overrides in a container', () => {
    process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://169.254.170.2/v4/abc';
    process.env.AIRBRX_LOG_DISK = 'true';
    expect(diskTransportUsed()).toBe(true);
  });

  test('AIRBRX_LOG_DISK=false still disables on a host', () => {
    process.env.AIRBRX_LOG_DISK = 'false';
    expect(diskTransportUsed()).toBe(false);
  });
});

// AIR-1596: a container that reads as "local" turns on colorized console output
// and the rotating-file transport, writing 14 days of logs to storage that nothing
// collects and that dies with the task. These pin the signals that prevent that.

const fs = require('fs');

const EnvironmentDetector = require('../lib/EnvironmentDetector');

const CONTAINER_ENV_VARS = [
  'AWS_LAMBDA_FUNCTION_NAME',
  'ECS_CONTAINER_METADATA_URI_V4',
  'ECS_CONTAINER_METADATA_URI',
  'KUBERNETES_SERVICE_HOST'
];

describe('EnvironmentDetector container detection', () => {
  let saved;

  beforeEach(() => {
    saved = {};
    for (const key of CONTAINER_ENV_VARS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // Default to a host with no container filesystem markers.
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of CONTAINER_ENV_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  /** Simulate /proc/self/cgroup with the given contents. */
  function withCgroup(contents) {
    fs.existsSync.mockImplementation(p => p === '/proc/self/cgroup');
    fs.readFileSync.mockReturnValue(contents);
  }

  test('a plain host is not a container', () => {
    expect(EnvironmentDetector.isDocker).toBe(false);
    expect(EnvironmentDetector.environmentName).toBe('local');
  });

  test('detects Fargate via the task metadata endpoint', () => {
    // Fargate runs containerd: no /.dockerenv, and cgroups under /ecs/.
    process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://169.254.170.2/v4/abc123';
    expect(EnvironmentDetector.isEcs).toBe(true);
    expect(EnvironmentDetector.isDocker).toBe(true);
    expect(EnvironmentDetector.environmentName).toBe('ecs');
  });

  test('detects the older ECS metadata endpoint', () => {
    process.env.ECS_CONTAINER_METADATA_URI = 'http://169.254.170.2/v3/abc123';
    expect(EnvironmentDetector.isEcs).toBe(true);
    expect(EnvironmentDetector.isDocker).toBe(true);
  });

  test('detects Docker via /.dockerenv', () => {
    fs.existsSync.mockImplementation(p => p === '/.dockerenv');
    expect(EnvironmentDetector.isDocker).toBe(true);
    expect(EnvironmentDetector.environmentName).toBe('docker');
  });

  test('detects Kubernetes via cgroup v1 kubepods path', () => {
    withCgroup('12:memory:/kubepods/besteffort/pod123/abc\n');
    expect(EnvironmentDetector.isDocker).toBe(true);
  });

  test('detects an ECS task via its cgroup path', () => {
    withCgroup('11:memory:/ecs/task-id/container-id\n');
    expect(EnvironmentDetector.isDocker).toBe(true);
  });

  test('detects containerd without a docker path', () => {
    withCgroup('0::/system.slice/containerd.service\n');
    expect(EnvironmentDetector.isDocker).toBe(true);
  });

  // cgroup v2 collapses the in-container view to "0::/" with the identifying
  // path stripped, so the cgroup check alone cannot see it.
  test('detects Kubernetes on cgroup v2 despite an opaque cgroup file', () => {
    withCgroup('0::/\n');
    expect(EnvironmentDetector.isDocker).toBe(false); // cgroup alone is blind here

    process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1';
    expect(EnvironmentDetector.isDocker).toBe(true);
  });

  test('Lambda still takes precedence over container signals', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'log-summary';
    process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://169.254.170.2/v4/abc';
    expect(EnvironmentDetector.isLambda).toBe(true);
    expect(EnvironmentDetector.environmentName).toBe('lambda');
  });

  test('an unreadable cgroup file does not throw', () => {
    fs.existsSync.mockImplementation(p => p === '/proc/self/cgroup');
    fs.readFileSync.mockImplementation(() => { throw new Error('EACCES'); });
    expect(EnvironmentDetector.isDocker).toBe(false);
  });

  describe('logging defaults', () => {
    test('containers get console-only, no disk', () => {
      process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://169.254.170.2/v4/abc';
      const defaults = EnvironmentDetector.getLoggingDefaults();
      expect(defaults.enableDisk).toBe(false);
      expect(defaults.enableConsole).toBe(true);
      expect(defaults.format).toBe('json');
    });

    test('a real host still gets disk logging', () => {
      const defaults = EnvironmentDetector.getLoggingDefaults();
      expect(defaults.enableDisk).toBe(true);
      expect(defaults.format).toBe('pretty');
    });
  });
});

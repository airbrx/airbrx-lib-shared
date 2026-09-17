// AIR-1594: S3expressStorage.write() silently ignored `ifNotExists`, so on a
// directory bucket the processing lock always appeared acquired and Delta
// commits could overwrite each other. Directory buckets do support conditional
// writes — these pin that the condition is actually sent and that a 412 surfaces
// as CONDITION_FAILED, which is what state-manager and delta-writer branch on.

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  class FakeCommand {
    constructor(input) { this.input = input; }
  }
  return {
    S3Client: jest.fn(() => ({ send: mockSend })),
    PutObjectCommand: class PutObjectCommand extends FakeCommand {},
    CreateSessionCommand: class CreateSessionCommand extends FakeCommand {},
    GetObjectCommand: class GetObjectCommand extends FakeCommand {},
    DeleteObjectCommand: class DeleteObjectCommand extends FakeCommand {},
    ListObjectsV2Command: class ListObjectsV2Command extends FakeCommand {},
    HeadObjectCommand: class HeadObjectCommand extends FakeCommand {},
    CopyObjectCommand: class CopyObjectCommand extends FakeCommand {}
  };
});

const S3expressStorage = require('../lib/S3expressStorage');

const BUCKET = 'test-bucket--use1-az4--x-s3';

/** Sessions always succeed; only the PutObject outcome varies per test. */
function withPutResult(handler) {
  mockSend.mockImplementation(async (command) => {
    if (command.constructor.name === 'CreateSessionCommand') {
      return { Credentials: { Expiration: new Date(Date.now() + 5 * 60 * 1000).toISOString() } };
    }
    return handler(command);
  });
}

function makeStorage() {
  return new S3expressStorage({
    storage: { bucket: BUCKET, region: 'us-east-1', basePath: 'storage' },
    tenantId: ''
  });
}

function lastPut() {
  const calls = mockSend.mock.calls.filter(([c]) => c.constructor.name === 'PutObjectCommand');
  return calls[calls.length - 1][0].input;
}

describe('S3expressStorage conditional writes', () => {
  let storage;

  beforeEach(() => {
    mockSend.mockReset();
    withPutResult(async () => ({}));
    storage = makeStorage();
  });

  afterEach(() => {
    if (storage) storage.destroy();
  });

  test('sends If-None-Match when ifNotExists is set', async () => {
    await storage.write('.lock', 'data', { ifNotExists: true });
    expect(lastPut().IfNoneMatch).toBe('*');
  });

  test('omits If-None-Match on an ordinary write', async () => {
    await storage.write('summary.json', 'data');
    expect(lastPut().IfNoneMatch).toBeUndefined();
  });

  test('translates a 412 into CONDITION_FAILED so the lock can detect contention', async () => {
    withPutResult(async () => {
      const err = new Error('Precondition Failed');
      err.$metadata = { httpStatusCode: 412 };
      throw err;
    });

    await expect(storage.write('.lock', 'data', { ifNotExists: true }))
      .rejects.toMatchObject({ code: 'CONDITION_FAILED' });
  });

  test('does not disguise non-conditional failures as CONDITION_FAILED', async () => {
    withPutResult(async () => {
      const err = new Error('Internal Error');
      err.$metadata = { httpStatusCode: 500 };
      throw err;
    });

    const err = await storage.write('.lock', 'data', { ifNotExists: true }).catch(e => e);
    expect(err.message).toBe('Internal Error');
    expect(err.code).toBeUndefined();
  });

  test('preserves contentType, which the Parquet writes depend on', async () => {
    await storage.write('part-0.parquet', Buffer.from('x'), { contentType: 'application/vnd.apache.parquet' });
    expect(lastPut().ContentType).toBe('application/vnd.apache.parquet');
  });
});

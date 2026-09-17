// test/StorageFactory/FilesystemStorage.test.js
// list() startAfter support: FilesystemStorage must honor the shared
// list(prefix, {startAfter}) contract like the S3 backends do — exclusive,
// lexicographic on the forward-slash key — and prune whole directories that
// sort at or below the cursor instead of walking all log history every run.
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const FilesystemStorage = require('../lib/FilesystemStorage');

describe('FilesystemStorage.list startAfter', () => {
  let tmpDir, storage;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-storage-'));
    storage = new FilesystemStorage(tmpDir);
    // Date-partitioned layout, like tenant logs
    await storage.write('logs/2026/05/01/2026-05-01T100000-a.json', '{}');
    await storage.write('logs/2026/05/02/2026-05-02T100000-b.json', '{}');
    await storage.write('logs/2026/05/03/2026-05-03T100000-c.json', '{}');
    await storage.write('logs/2026/05/03/2026-05-03T110000-d.json', '{}');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const norm = (k) => k.replace(/\\/g, '/');

  test('returns only keys strictly after the cursor (exclusive, like S3)', async () => {
    const cursor = 'logs/2026/05/03/2026-05-03T100000-c.json';
    const keys = (await storage.list('logs/', { startAfter: cursor })).map(norm);
    expect(keys).toEqual(['logs/2026/05/03/2026-05-03T110000-d.json']);
  });

  test('a directory-boundary cursor (reset-from style) returns that day onward', async () => {
    const keys = (await storage.list('logs/', { startAfter: 'logs/2026/05/02/' })).map(norm);
    expect(keys.sort()).toEqual([
      'logs/2026/05/02/2026-05-02T100000-b.json',
      'logs/2026/05/03/2026-05-03T100000-c.json',
      'logs/2026/05/03/2026-05-03T110000-d.json'
    ]);
  });

  test('without startAfter, lists everything (unchanged default)', async () => {
    const keys = await storage.list('logs/');
    expect(keys).toHaveLength(4);
  });

  test('prunes directories below the cursor without reading them', async () => {
    const readdirSpy = jest.spyOn(fsp, 'readdir');
    const cursor = 'logs/2026/05/03/2026-05-03T100000-c.json';
    await storage.list('logs/', { startAfter: cursor });

    const readDirs = readdirSpy.mock.calls.map(([dir]) => norm(String(dir)));
    readdirSpy.mockRestore();

    // Days wholly behind the cursor must never be readdir'd
    expect(readDirs.some(d => d.endsWith('2026/05/01'))).toBe(false);
    expect(readDirs.some(d => d.endsWith('2026/05/02'))).toBe(false);
    // The cursor's own day still is (it can hold newer keys)
    expect(readDirs.some(d => d.endsWith('2026/05/03'))).toBe(true);
  });
});

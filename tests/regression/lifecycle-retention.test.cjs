const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { LifecycleService } = require('../../apps/api/src/lifecycle/lifecycle.service.ts');

function fixture(retentionDays, action = 'RECYCLE') {
  const rows = [
    { id: 'old-1', projectId: 'project', status: 'ACTIVE', folderPath: null, storageKey: 'key-1', currentVersion: 1, originalName: 'first.txt' },
    { id: 'old-2', projectId: 'project', status: 'ACTIVE', folderPath: null, storageKey: 'key-2', currentVersion: 1, originalName: 'second.txt' },
  ];
  const settingsReads = [], events = [], writes = [];
  const db = {
    managedFile: {
      findMany: async () => rows.map(row => ({ ...row })),
      updateMany: async ({ where, data }) => {
        writes.push({ where, data });
        const row = rows.find(row => row.id === where.id);
        if (!row || Object.entries(where).some(([key, value]) => row[key] !== value)) return { count: 0 };
        Object.assign(row, data); return { count: 1 };
      },
    },
    lifecyclePolicy: { update: async () => ({}) },
  };
  const settings = { getRecycleRetentionDays: async () => { settingsReads.push(true); if (retentionDays instanceof Error) throw retentionDays; return retentionDays; } };
  const service = new LifecycleService(db, {}, {}, { emit: (...args) => events.push(args) }, settings);
  const policy = { id: 'policy', projectId: 'project', folderPath: null, category: null, ttlDays: 2, action };
  return { service, policy, rows, settingsReads, events, writes };
}

for (const days of [1, 30, 45]) {
  test(`lifecycle recycling schedules cleanup after the configured ${days} day retention`, async () => {
    const f = fixture(days);
    const result = await f.service.executePolicy(f.policy);
    assert.deepEqual(result, { affected: 2 });
    for (const row of f.rows) {
      assert.equal(row.status, 'RECYCLED');
      assert.equal(row.purgeAt.getTime() - row.deletedAt.getTime(), days * 24 * 60 * 60 * 1000);
    }
    assert.equal(f.settingsReads.length, 1, 'read settings once for the entire policy batch');
    assert.equal(f.events.length, 2);
  });
}

test('a PURGE lifecycle policy still schedules immediate cleanup without a retention lookup', async () => {
  const f = fixture(new Error('settings unavailable'), 'PURGE');
  const result = await f.service.executePolicy(f.policy);
  assert.equal(result.affected, 2);
  assert.equal(f.settingsReads.length, 0);
  assert.ok(f.rows.every(row => row.purgeAt.getTime() === row.deletedAt.getTime()));
});

test('a failed retention lookup cannot silently recycle a batch with the old fixed deadline', async () => {
  const f = fixture(new Error('settings unavailable'));
  await assert.rejects(f.service.executePolicy(f.policy), /settings unavailable/);
  assert.ok(f.rows.every(row => row.status === 'ACTIVE'));
  assert.equal(f.writes.length, 0);
  assert.equal(f.events.length, 0);
});

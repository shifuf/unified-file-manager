const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
const { AuditService } = require('../../apps/api/src/audit/audit.service.ts');
const { TasksService } = require('../../apps/api/src/tasks/tasks.service.ts');

test('audit cleanup can explicitly clear all matching logs without a cutoff and rejects ambiguous deletion', async () => {
  const calls = [];
  const service = new AuditService({ auditLog: {
    deleteMany: async options => { calls.push(options); return { count: 3 }; },
    create: async () => {},
  } });
  await assert.rejects(service.cleanup({}), /截止时间|明确/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await service.cleanup({ all: true, projectId: 'project' }, 'admin'), { success: true, deleted: 3 });
  assert.deepEqual(calls[0].where, { projectId: 'project' });
  await assert.rejects(service.cleanup({ beforeAt: '2026-11-18T22:00:00' }), /时区/);
});

test('task cleanup has no time condition and only removes finished records after authorization', async () => {
  const calls = [];
  const tx = {
    task: { deleteMany: async options => { calls.push(options); return { count: 6 }; } },
    auditLog: { create: async () => {} },
  };
  const service = new TasksService({}, { $transaction: async fn => fn(tx) }, {
    assertProjectAccess: async () => {},
  });
  await assert.rejects(service.cleanup({ projectId: 'project' }, { id: 'u', role: 'PROJECT_ADMIN' }));
  assert.equal(calls.length, 0);
  assert.deepEqual(await service.cleanup({ projectId: 'project' }, { id: 'root', role: 'SUPER_ADMIN' }), { success: true, deleted: 6 });
  assert.deepEqual(calls[0].where, { projectId: 'project', status: { in: ['COMPLETED', 'FAILED', 'CANCELED'] } });
});

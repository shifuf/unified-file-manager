const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const load = () => {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../apps/web/src/utils/storage-replica-view.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports: module.exports, module });
  return module.exports;
};
const location = (status, extra = {}) => ({ configId: 'cloud', configName: '云一', provider: 'QINIU', enabled: true, assigned: true, desired: true, priority: 1, status, attempts: 0, lastError: null, verifiedAt: null, ...extra });

test('preferred download names cloud priority independently of upload status', () => {
  const view = load();
  const items = [location('READY', { configId: 'local', provider: 'LOCAL', configName: '本地', priority: 0 }), location('PENDING'), location('READY', { configId: 'second', configName: '云二', priority: 2 }), location('READY', { configId: 'disabled', enabled: false, priority: 0 })];
  assert.equal(view.preferredDownloadLabel(items), '优先下载：云一（七牛云）');
  assert.equal(view.downloadOrderLabel(items), '云一 → 云二 → 本地（兜底）');
  assert.equal(view.preferredDownloadLabel([items[0]]), '下载存储：本地（本地存储）');
  assert.equal(view.preferredDownloadLabel(null), '下载优先存储待确认');
});

test('backup-only locations display uploaded backup but never appear in the download order', () => {
  const view = load(), backup = location('READY', { backupOnly: true, provider: 'ALIYUN_DRIVE', configName: '网盘' });
  const local = location('READY', { provider: 'LOCAL', configName: '本地', configId: 'local' });
  assert.equal(view.downloadOrderLabel([backup, local]), '本地（兜底）');
  assert.equal(view.replicaLabel(backup), '已备份');
  assert.equal(view.storageProviderLabel(backup.provider), '阿里云盘');
});

// Execute the actual Files methods/template with only API/data boundaries
// substituted, so the pre-fix merge and upload claims also fail behaviorally.
const filesSource = () => fs.readFileSync(path.resolve(__dirname, '../../apps/web/src/views/Files.vue'), 'utf8');
function filesStorageMethods(existing) {
  const script = filesSource().match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const parsed = ts.createSourceFile('Files.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const methods = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && ['acceptStorageDetails', 'fetchStorageSummaries'].includes(node.name.text)).map(node => node.getText(parsed)).join('\n');
  const context = { ...load(), storageSummaries: { value: existing ? { f: existing } : {} }, pageResult: { items: [] }, uploadResults: { files: [] }, fileStorageApi: {} };
  vm.runInNewContext(ts.transpileModule(methods, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context;
}
function uploadResultText(locations) {
  const compiler = require('@vue/compiler-dom'), vue = require('vue');
  const template = filesSource().match(/<template>([\s\S]*?)<\/template>\s*<script/)[1];
  const root = compiler.parse(template);
  let panel;
  function find(node) {
    if (node.type === 1 && node.props.some(prop => prop.type === 6 && prop.name === 'class' && prop.value?.content === 'upload-results')) panel = node.loc.source;
    for (const child of node.children || []) find(child);
  }
  find(root);
  assert.ok(panel, 'upload result panel renders retained results');
  const code = compiler.compile(panel, { mode: 'function' }).code;
  const render = new Function('Vue', code)({ ...vue, resolveComponent: name => ({ name }), withDirectives: vnode => vnode });
  const file = { id: 'legacy', originalName: 'legacy.txt', duplicateReused: true };
  const context = { ...load(), uploadResults: { projectName: '项目', files: [file] }, visibleUploadResults: [file], uploadResultsLoading: false, uploadResultsError: false, uploadResultPage: 1, storageLocations: () => locations, loadUploadResultStorage() {}, openStorageDetails() {} };
  const rendered = render(context, []);
  function text(node) {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(text).join('');
    if (!node) return '';
    if (node.children?.default) return text(node.children.default({ row: file }));
    return text(node.children);
  }
  return text(rendered);
}

test('a pending copy is labelled waiting rather than uploaded', () => {
  assert.equal(load().replicaLabel(location('PENDING')), '等待同步');
  assert.equal(load().replicaLabel(location('NOT_SYNCED')), '未同步');
  assert.equal(load().replicaLabel(location('UNVERIFIED')), '待校验');
});
test('ready indexed bytes remain distinguishable when their target was disabled or detached', () => {
  assert.equal(load().replicaLabel(location('READY', { enabled: false })), '已上传 · 已停用');
  assert.equal(load().replicaLabel(location('READY', { assigned: false, desired: false })), '已上传 · 未绑定');
});
test('only missing or failed desired enabled copies can be manually synchronized', () => {
  const { canSyncReplica } = load();
  assert.equal(canSyncReplica(location('NOT_SYNCED')), true);
  assert.equal(canSyncReplica(location('FAILED')), true);
  for (const entry of [location('READY'), location('SYNCING'), location('PENDING'), location('MISSING', { enabled: false }), location('FAILED', { desired: false })]) assert.equal(canSyncReplica(entry), false);
});
test('pending copy polling stops when all copies are complete or terminal', () => {
  assert.equal(load().hasPendingReplicas([location('READY'), location('SYNCING')]), true);
  assert.equal(load().hasPendingReplicas([location('READY'), location('FAILED')]), false);
});
test('file snapshot guard rejects another project, file or source version', () => {
  const file = { id: 'f', projectId: 'p', currentVersion: 2 };
  const snapshot = { fileId: 'f', projectId: 'p', currentVersion: 2 };
  assert.equal(load().replicaSnapshotMatches(file, snapshot), true);
  assert.equal(load().replicaSnapshotMatches(file, { ...snapshot, projectId: 'other' }), false);
  assert.equal(load().replicaSnapshotMatches(file, { ...snapshot, fileId: 'other' }), false);
  assert.equal(load().replicaSnapshotMatches(file, { ...snapshot, currentVersion: 1 }), false);
});

test('a desired enabled target keeps polling before automatic backfill creates its row', () => {
  const { hasPendingReplicas } = load();
  assert.equal(hasPendingReplicas([location('NOT_SYNCED')]), true);
  assert.equal(hasPendingReplicas([location('NOT_SYNCED', { enabled: false })]), false);
  assert.equal(hasPendingReplicas([location('NOT_SYNCED', { desired: false })]), false);
  assert.equal(hasPendingReplicas([location('NOT_SYNCED', { assigned: false, provider: 'LOCAL' })]), true);
});

test('concurrent summary merge rejects older and tied observations while file version remains an independent guard', async () => {
  const file = { id: 'f', projectId: 'p', currentVersion: 2 };
  const ready = { fileId: 'f', projectId: 'p', storageKey: 'f/v2', currentVersion: 2, updatedAt: '2030-01-01T00:00:01Z', items: [location('READY')] };
  const slowPending = { ...ready, updatedAt: '2030-01-01T00:00:00Z', items: [location('PENDING')] };
  for (const [incoming, existing, accepted] of [
    [slowPending, ready, false], [{ ...slowPending, updatedAt: ready.updatedAt }, ready, false],
    [ready, slowPending, true], [{ ...ready, projectId: 'other' }, ready, false],
    [{ ...ready, currentVersion: 1, updatedAt: '2030-01-01T00:00:02Z' }, ready, false],
    [ready, { ...ready, currentVersion: 3 }, false], [slowPending, { ...ready, currentVersion: 1 }, true],
    [ready, { ...ready, storageKey: 'other-key' }, false],
  ]) {
    const context = filesStorageMethods(existing);
    context.acceptStorageDetails(incoming, file);
    assert.equal(context.storageSummaries.value.f === incoming, accepted, 'dialog merge must preserve newer observations and versions');
    const batchContext = filesStorageMethods(existing);
    batchContext.fileStorageApi.batch = async () => ({ items: [incoming] });
    await batchContext.fetchStorageSummaries([file], {}, () => true);
    assert.equal(batchContext.storageSummaries.value.f === incoming, accepted, 'batch merge must use the same freshness/version policy');
  }
});

test('upload reuse only reports local saving with an enabled desired verified local replica', () => {
  assert.ok(uploadResultText(null).includes('本地状态待确认'));
  assert.ok(uploadResultText([location('READY', { verifiedAt: '2030-01-01T00:00:00Z' })]).includes('本地未同步'));
  for (const [status, verifiedAt, want] of [
    ['NOT_SYNCED', null, '本地未同步'], ['UNVERIFIED', null, '本地待校验'],
    ['READY', null, '本地待校验'], ['PENDING', null, '本地等待同步'],
    ['FAILED', null, '本地失败'], ['READY', '2030-01-01T00:00:00Z', '本地已保存'],
  ]) {
    assert.ok(uploadResultText([location(status, { provider: 'LOCAL', verifiedAt })]).includes(want), `${status} should render ${want}`);
  }
  assert.ok(uploadResultText([location('READY', { provider: 'LOCAL', desired: false, verifiedAt: '2030-01-01T00:00:00Z' })]).includes('本地未同步'));
  assert.ok(uploadResultText([location('READY', { provider: 'LOCAL', enabled: false, verifiedAt: '2030-01-01T00:00:00Z' })]).includes('本地未同步'));
});

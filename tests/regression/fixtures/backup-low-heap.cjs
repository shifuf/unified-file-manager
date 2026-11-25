const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createReadStream } = require('node:fs');
const { createGunzip } = require('node:zlib');
const { createHash } = require('node:crypto');
require('ts-node').register({ project: path.resolve(__dirname, '../../../apps/api/tsconfig.json'), transpileOnly: true });
require('@nestjs/common').Logger.overrideLogger(false);
const { BackupService } = require('../../../apps/api/src/backup/backup.service.ts');

async function main() {
  const root = process.argv[2];
  const count = 25000;
  const objectSize = 48 * 1024 * 1024 + 5;
  const rows = [];
  const prisma = {
    systemSetting: { findMany: async (args = {}) => {
      const start = args.where?.key?.gt ? Number(args.where.key.gt.slice(4)) + 1 : 0;
      const end = Math.min(count, start + (args.take ?? count));
      return Array.from({ length: end - start }, (_, i) => ({ key: `row-${String(start + i).padStart(8, '0')}`, value: { text: `${start + i}:` + 'x'.repeat(4096) } }));
    } },
    project: { findMany: async () => [] }, managedFolder: { findMany: async () => [] },
    fileDerivative: { findMany: async () => [] }, fileVersion: { findMany: async () => [] },
    managedFile: { findMany: async args => args?.include?.cdnConfig
      ? args.where?.id?.gt ? [] : [{ id: 'local', cdnConfigId: 'local-config', storageKey: 'large.bin', mimeType: 'application/octet-stream', originalName: 'large.bin', size: BigInt(objectSize) }]
      : [] },
    backup: {
      create: async ({ data }) => { const row = { id: 'low-heap', createdAt: new Date(), updatedAt: new Date(), fileName: null, fileSize: 0n, objectCount: 0, objectBytes: 0n, ...data }; rows.push(row); return { ...row }; },
      update: async ({ data }) => { Object.assign(rows[0], data); return { ...rows[0] }; },
    },
  };
  const service = new BackupService({ write: async () => {} }, { get: key => key === 'BACKUP_ROOT' ? root : undefined }, prisma, {
    getDownloadTarget: async () => ({ type: 'stream', contentLength: objectSize, stream: Readable.from((async function* () {
      const chunk = Buffer.alloc(65533, 0xa5);
      for (let remaining = objectSize; remaining > 0; remaining -= chunk.length) yield chunk.subarray(0, Math.min(remaining, chunk.length));
    })()) }),
  });
  const result = await service.create({ scopes: ['settings', 'projects'], includeObjects: true }, { id: 'admin', role: 'SUPER_ADMIN' });
  let expandedBytes = 0, foundLastRow = false, tail = '';
  for await (const chunk of createReadStream(path.join(root, result.fileName)).pipe(createGunzip())) {
    expandedBytes += chunk.length;
    const text = tail + chunk.toString('utf8');
    if (text.includes('row-00024999')) foundLastRow = true;
    tail = text.slice(-64);
  }
  const checksum = createHash('sha256');
  for await (const chunk of createReadStream(path.join(root, result.fileName))) checksum.update(chunk);
  process.stdout.write(JSON.stringify({ status: result.status, settings: result.tableCounts.systemSetting, objectCount: result.objectCount, objectBytes: result.objectBytes, expandedBytes, foundLastRow, checksumValid: checksum.digest('hex') === result.checksum, files: await fs.readdir(root) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });

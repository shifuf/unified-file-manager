const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('replica full-key uniqueness fits MySQL 8 utf8mb4 index budget without shortening object keys',()=>{
 const sql=fs.readFileSync(path.resolve(__dirname,'../../apps/api/prisma/migrations/20261113020000_storage_replicas_and_share_sessions/migration.sql'),'utf8');
 const table=sql.match(/CREATE TABLE `StorageReplica` \(([\s\S]*?)\) DEFAULT/)[1];
 const columns=Object.fromEntries([...table.matchAll(/`(\w+)` VARCHAR\((\d+)\)/g)].map(m=>[m[1],Number(m[2])]));
 const unique=table.match(/UNIQUE INDEX[^\n]*\(([^\n]+)\)/)[1];
 const keys=[...unique.matchAll(/`(\w+)`/g)].map(m=>m[1]);
 assert.deepEqual(keys,['projectId','storageKey','configId']);assert.equal(columns.storageKey,512);
 assert.ok(keys.reduce((bytes,k)=>bytes+columns[k]*4,0)<=3072,'MySQL InnoDB utf8mb4 unique index exceeds 3072 bytes');
});

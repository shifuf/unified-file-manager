// Creates a dedicated database; never migrates the developer's existing database.
const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
for(const line of fs.readFileSync(path.join(root,'.env'),'utf8').split(/\r?\n/)){const m=line.match(/^(\w+)=(.*)$/);if(m)process.env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'');}
if(!process.env.UFM_PLUGIN_TEST_DATABASE_URL)throw new Error('请设置独立测试数据库 UFM_PLUGIN_TEST_DATABASE_URL');
process.env.DATABASE_URL=process.env.UFM_PLUGIN_TEST_DATABASE_URL;
const {PrismaClient}=require('@prisma/client');
(async()=>{const admin=new PrismaClient();const database='ufm_plugins_acceptance_20261116';await admin.$executeRawUnsafe(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);await admin.$disconnect();const url=new URL(process.env.DATABASE_URL);url.pathname='/'+database;
 const env={...process.env,DATABASE_URL:url.toString(),NODE_ENV:'test',APP_PORT:'3016',PUBLIC_URL:'http://localhost:5176',REQUIRE_HTTPS:'false',LOCAL_STORAGE_ROOT:path.join(root,'.runtime/plugin-work/local-storage'),STORAGE_PLUGIN_DIR:path.join(root,'.runtime/plugin-work/installed'),ADMIN_USERNAME:'plugin-admin',ADMIN_PASSWORD:'PluginAcceptance2026!Local',ADMIN_PASSWORD_SYNC:'false',REPLICA_WORKER_ENABLED:'false',MEILI_HOST:'',MEILI_URL:'',VIDEO_TRANSCODE_ENABLED:'false',VIDEO_HLS_ENABLED:'false'};
 fs.writeFileSync(path.join(root,'.runtime/plugin-work/environment.json'),JSON.stringify(env));
 const result=spawnSync(process.execPath,[path.join(root,'node_modules/prisma/build/index.js'),'migrate','deploy','--schema',path.join(root,'apps/api/prisma/schema.prisma')],{env,encoding:'utf8'});if(result.status!==0)throw new Error('Isolated migration failed: '+result.stderr);console.log('Dedicated database migrated: '+database);
})().catch(e=>{console.error(e.message.replace(/mysql:\/\/[^\s]+/g,'[database URL]'));process.exitCode=1});

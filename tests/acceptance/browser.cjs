/* Local legacy acceptance: creates projects and retains all data. Never prints credentials. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const envFile = path.join(root, '.env');
const env = fs.existsSync(envFile) ? Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/).filter(x => /^[A-Z_]+=/.test(x)).map(x => { const n=x.indexOf('='); return [x.slice(0,n),x.slice(n+1).replace(/^['"]|['"]$/g,'')]; })) : {};
const base = process.env.ACCEPTANCE_WEB_URL || 'http://localhost:5175';
const site = new URL(base);
assert.ok(['localhost','127.0.0.1','[::1]'].includes(site.hostname) && site.protocol === 'http:', 'Acceptance browser tests require a local HTTP site');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/shifuf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const run = Date.now().toString(36);
const out = path.join(root, '.runtime/acceptance-20261113/primary', run);
fs.mkdirSync(out, {recursive:true});
const result = {startedAt:new Date().toISOString(),base,projects:[],checks:[],pageErrors:[],requestsFailed:[],retained:true};
const save = () => fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2));
const check = async (name, fn) => { try { const evidence=await fn(); result.checks.push({name,status:'PASS',evidence}); } catch(e) { result.checks.push({name,status:'FAIL',error:String(e.message).slice(0,1600)}); } save(); console.log(name, result.checks.at(-1).status); };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const wait = ms => new Promise(r=>setTimeout(r,ms));
(async()=>{
  const browser=await playwright.chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const context=await browser.newContext({viewport:{width:1600,height:1000},acceptDownloads:true});
  const page=await context.newPage();
  page.on('pageerror',e=>result.pageErrors.push(String(e.message)));
  page.on('requestfailed',r=>result.requestsFailed.push({url:new URL(r.url()).pathname,error:r.failure()?.errorText}));
  const api=async(method,p,data)=>{ const r=await context.request.fetch(base+'/api'+p,{method,data,timeout:45000}); assert.ok(r.ok(),method+' '+p+' returned '+r.status()); return r.json(); };
  await check('浏览器登录',async()=>{
    await page.goto(base+'/console-login');
    await page.locator('input[autocomplete="username"]').fill(process.env.ACCEPTANCE_USERNAME || env.ADMIN_USERNAME || 'admin');
    await page.locator('input[autocomplete="current-password"]').fill(process.env.ACCEPTANCE_PASSWORD || env.ADMIN_PASSWORD || '');
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.waitForURL('**/dashboard',{timeout:30000});
    return {profile:(await api('GET','/auth/profile')).username,url:page.url()};
  });
  const a=await api('POST','/projects',{name:'验收-网页流程-A-'+run,description:'保留供人工验收：小文件、分片、重命名、浏览器下载、切换竞争。'});
  const b=await api('POST','/projects',{name:'验收-网页流程-B-'+run,description:'保留供人工验收：项目切换对照文件。'});
  result.projects=[a,b].map(p=>({id:p.id,name:p.name,url:base+'/files?projectId='+p.id})); save();
  const small=Buffer.from('浏览器上传下载验收 '+run+'\n中文文件名与 UTF-8 内容。\n');
  const smallName='网页-A-'+run+'.txt';
  const bName='网页-B-'+run+'.txt';
  fs.writeFileSync(path.join(out,smallName),small);
  await context.request.post(base+'/api/projects/'+b.id+'/files',{multipart:{files:{name:bName,mimeType:'text/plain',buffer:Buffer.from('项目B唯一内容 '+run)}}});
  let uploaded;
  await check('网页小文件上传及列表显示',async()=>{
    await page.goto(base+'/files?projectId='+a.id);
    await page.getByRole('button',{name:'上传文件',exact:true}).waitFor();
    const pending=page.waitForResponse(r=>r.url().includes('/projects/'+a.id+'/files') && r.request().method()==='POST');
    await page.locator('input[type=file]').first().setInputFiles({name:smallName,mimeType:'text/plain',buffer:small});
    const r=await pending; assert.equal(r.status(),201); uploaded=(await r.json())[0];
    await page.locator('.file-title').filter({hasText:smallName}).waitFor();
    return {fileId:uploaded.id,bytes:small.length,sha256:sha(small)};
  });
  await check('网页下载与SHA256一致',async()=>{
    const pending=page.waitForEvent('download');
    await page.locator('.el-table__body tr').filter({hasText:smallName}).getByRole('button',{name:'下载',exact:true}).click();
    const d=await pending; const f=path.join(out,'download-'+smallName); await d.saveAs(f);
    const content=fs.readFileSync(f); assert.equal(sha(content),sha(small)); return {filename:d.suggestedFilename(),bytes:content.length,sha256:sha(content)};
  });
  const renamed='重命名后-'+run+'.txt';
  await check('网页编辑名称并按新名称搜索',async()=>{
    await page.locator('.el-table__body tr').filter({hasText:smallName}).getByRole('button',{name:'编辑',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'文件信息'});
    await dialog.locator('.el-form-item').filter({hasText:'文件名'}).locator('input').fill(renamed);
    await dialog.locator('textarea').fill('网页验收备注 '+run);
    await dialog.getByRole('button',{name:'保存',exact:true}).click(); await dialog.waitFor({state:'hidden'});
    const input=page.getByPlaceholder('文件名、备注、标签'); await input.fill(renamed); await input.press('Enter');
    await page.locator('.file-title').filter({hasText:renamed}).waitFor({timeout:10000});
    return {fileId:uploaded.id,newName:renamed};
  });
  await check('分片上传遇到一次503自动重试并完成',async()=>{
    await page.goto(base+'/files?projectId='+a.id); await page.getByRole('button',{name:'上传文件',exact:true}).waitFor();
    const large=crypto.randomBytes(11*1024*1024+31); const name='网页-重试-'+run+'.bin'; fs.writeFileSync(path.join(out,name),large);
    let hits=0; let fault=false;
    const pattern='**/api/projects/'+a.id+'/uploads/*/chunks/0';
    await page.route(pattern,async route=>{hits++; if(!fault){fault=true; await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'验收注入：一次短暂503'})});}else await route.continue();});
    const completed=page.waitForResponse(r=>r.url().includes('/projects/'+a.id+'/uploads/') && r.url().endsWith('/complete'),{timeout:90000});
    await page.locator('input[type=file]').first().setInputFiles({name,mimeType:'application/octet-stream',buffer:large});
    const response=await completed; assert.ok(response.ok()); const f=await response.json();
    await page.unroute(pattern); const download=await context.request.get(base+'/api/files/'+f.id+'/download'); assert.ok(download.ok()); assert.equal(sha(await download.body()),sha(large));
    return {fileId:f.id,firstChunkAttempts:hits,bytes:large.length,sha256:sha(large)};
  });
  await check('登录访问cookie失效自动刷新后继续请求',async()=>{
    let refreshes=0; const fn=r=>{if(r.url().endsWith('/api/auth/refresh')) refreshes++;}; page.on('request',fn);
    await context.clearCookies({name:'ufm_access'});
    const refreshed=page.waitForResponse(r=>r.url().endsWith('/api/auth/refresh'));
    await page.getByRole('button',{name:'刷新',exact:true}).click(); const r=await refreshed;
    assert.equal(r.status(),201); await page.locator('.file-title').filter({hasText:renamed}).waitFor(); page.off('request',fn); assert.equal(refreshes,1); return {refreshRequests:refreshes,status:r.status()};
  });
  await check('快速切换项目迟到响应不覆盖当前项目',async()=>{
    await page.goto(base+'/files?projectId='+b.id); await page.locator('.file-title').filter({hasText:bName}).waitFor();
    let held; let ready; const intercepted=new Promise(r=>ready=r); let release; const gate=new Promise(r=>release=r);
    const pattern='**/api/files?**';
    await page.route(pattern,async route=>{
      const u=new URL(route.request().url());
      if(u.searchParams.get('projectId')===a.id && !held){held=true; const response=await route.fetch(); ready(); await gate; await route.fulfill({response});} else await route.continue();
    });
    const select=async(name)=>{await page.locator('.filter-project').click(); await page.getByRole('option',{name,exact:true}).click();};
    await select(a.name); await intercepted; await select(b.name);
    await page.locator('.file-title').filter({hasText:bName}).waitFor(); await wait(300); release(); await wait(1800); await page.unroute(pattern);
    const names=await page.locator('.file-title').allTextContents();
    const selected=await page.locator('.filter-project').innerText();
    result.race={selected,names,url:page.url(),lateResponseProject:a.id}; save();
    await page.screenshot({path:path.join(out,'project-switch.png'),fullPage:true});
    assert.ok(names.some(n=>n.includes(bName)) && names.every(n=>!n.includes(renamed)),JSON.stringify(result.race));
    return result.race;
  });
  await check('主要管理页面正常加载',async()=>{
    const pages=[];
    for(const p of ['/dashboard','/projects','/recycle-bin','/shares','/storage-configs','/tasks','/backups','/settings']){
      const start=result.pageErrors.length; await page.goto(base+p); await page.locator('.page-title').waitFor({timeout:15000}); await wait(400); assert.equal(result.pageErrors.length,start,p+' has runtime error'); pages.push({path:p,title:await page.locator('.page-title').innerText()});
    } return pages;
  });
  await page.goto(base+'/files?projectId='+a.id); await page.locator('.file-title').filter({hasText:renamed}).waitFor();
  await page.screenshot({path:path.join(out,'retained-project.png'),fullPage:true});
  await check('浏览器损坏的缓存用户资料仍可打开登录页',async()=>{
    const damaged=await browser.newContext(); await damaged.addInitScript(()=>localStorage.setItem('ufm_user_profile','{invalid-json'));
    const p=await damaged.newPage(); const errors=[]; p.on('pageerror',e=>errors.push(String(e.message))); p.on('console',m=>{if(m.type()==='error') errors.push(m.text().slice(0,1200));}); await p.goto(base+'/console-login'); try{await p.locator('input[autocomplete="username"]').waitFor({timeout:10000});}catch{}
    const forms=await p.locator('input[autocomplete="username"]').count(); const evidence={loginInputs:forms,pageErrors:errors}; result.corruptProfile=evidence; await p.screenshot({path:path.join(out,'corrupt-profile.png'),fullPage:true}); await damaged.close(); assert.equal(forms,1,JSON.stringify(evidence)); return evidence;
  });
  await api('POST','/auth/logout',{}); await browser.close();
  result.completedAt=new Date().toISOString(); result.summary={passed:result.checks.filter(c=>c.status==='PASS').length,failed:result.checks.filter(c=>c.status==='FAIL').length}; save();
  fs.writeFileSync(path.join(root,'.runtime/acceptance-20261113/primary/latest.json'),JSON.stringify({results:path.join(out,'results.json'),...result.summary,projects:result.projects},null,2));
  console.log(JSON.stringify({out,...result.summary,projects:result.projects})); process.exitCode=result.summary.failed?1:0;
})().catch(e=>{result.fatal=String(e.message);save();console.error(result.fatal);process.exitCode=2;});

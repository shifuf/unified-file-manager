/* Local real DB/storage + browser acceptance. Retains its uniquely named project for inspection. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter(s => /^\w+=/.test(s)).map(s => { const i=s.indexOf('='); return [s.slice(0,i),s.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]; }));
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/shifuf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.ACCEPTANCE_WEB || 'http://localhost:5175';
assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname));
const output=path.join(root,'.runtime/text-acceptance'); fs.mkdirSync(output,{recursive:true});
(async()=>{
  const browser = await chromium.launch({ headless:true, executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const context=await browser.newContext();
    const api=context.request;
    const json=async(route,method='GET',data)=>{const r=await api.fetch(base+'/api'+route,{method,data});assert.ok(r.ok(),method+' '+route+': '+r.status()+' '+(r.ok()?'':await r.text()));return r.json();};
    const login=await json('/auth/login','POST',{username:env.ADMIN_USERNAME,password:env.ADMIN_PASSWORD});
    await context.addInitScript(u=>localStorage.setItem('ufm_user_profile',JSON.stringify(u)),login.user);
    const project=await json('/projects','POST',{name:'文本编辑验收-'+Date.now().toString(36)});
    const content='{"versionCode":32,"statusCode":500,"message":"正常 JSON 内容"}\n';
    const uploaded=await api.post(base+`/api/projects/${project.id}/files`,{multipart:{files:{name:'update.json',mimeType:'application/octet-stream',buffer:Buffer.from(content)}}});
    assert.ok(uploaded.ok(),await uploaded.text());const file=(await uploaded.json())[0];
    await json(`/files/${file.id}`,'PUT',{isPublic:true});
    const share=await json(`/files/${file.id}/shares`,'POST',{});
    const direct=base+`/api/public/files/${file.id}`;
    const raw=base+`/api/shares/${share.token}/raw`;
    let response=await api.get(direct);assert.equal(await response.text(),content);assert.match(response.headers()['content-type'],/^application\/json/);
    response=await api.get(raw,{headers:{Accept:'application/json'}});assert.equal(await response.text(),content);assert.match(response.headers()['content-disposition'],/^inline/);
    const page=await context.newPage();await page.goto(base+`/files?projectId=${project.id}`);
    const row=page.locator('.el-table__body tr').filter({hasText:'update.json'});await row.getByRole('button',{name:'编辑内容',exact:true}).click();
    const editor=page.getByRole('textbox',{name:'文件内容'});await editor.waitFor();
    await page.waitForFunction(expected=>document.querySelector('textarea[aria-label="文件内容"]')?.value===expected,content);
    const changed='{"versionCode":33,"statusCode":500,"message":"在线修改成功"}\n';
    await editor.fill(changed);
    const saveResponse=page.waitForResponse(r=>r.url().endsWith(`/files/${file.id}/content`)&&r.request().method()==='PUT');
    await page.getByRole('button',{name:'保存新版本',exact:true}).click();assert.ok((await saveResponse).ok());
    await page.getByText('已保存为 v2，直链和分享链接保持不变。',{exact:true}).waitFor();
    assert.equal(await (await api.get(direct)).text(),changed);assert.equal(await (await api.get(raw)).text(),changed);
    await page.screenshot({path:path.join(output,'editor.png'),fullPage:true});
    await page.getByRole('button',{name:'关闭',exact:true}).last().click();
    const guest=await browser.newContext();const publicPage=await guest.newPage();
    await publicPage.goto(base+'/shares/'+share.token);await publicPage.locator('.text-preview-body').waitFor();
    assert.equal(await publicPage.locator('.text-preview-body').textContent(),changed);
    assert.equal(await publicPage.getByRole('link',{name:'查看原始文件'}).getAttribute('href'),`/api/shares/${share.token}/raw`);
    await publicPage.screenshot({path:path.join(output,'share-json.png'),fullPage:true});
    const stale=await api.put(base+`/api/files/${file.id}/content`,{data:{content:'stale',expectedVersion:1}});assert.equal(stale.status(),409);
    const large='中'.repeat(50000)+'\n';
    let saved=await json(`/files/${file.id}/content`,'PUT',{content:large,expectedVersion:2});assert.equal(saved.currentVersion,3);
    assert.equal(await (await api.get(direct)).text(),large);
    saved=await json(`/files/${file.id}/content`,'PUT',{content:'',expectedVersion:3});assert.equal(saved.currentVersion,4);
    assert.equal(await (await api.get(direct)).text(),'');
    saved=await json(`/files/${file.id}/content`,'PUT',{content:'',expectedVersion:4});assert.equal(saved.currentVersion,5);
    const versions=await json(`/files/${file.id}/versions`);assert.ok(versions.some(v=>v.version===1));assert.ok(versions.some(v=>v.version===4));
    saved=await json(`/files/${file.id}/versions/1/restore`,'POST',{});assert.equal(saved.currentVersion,6);
    assert.equal(saved.id,file.id);assert.equal(await (await api.get(raw)).text(),content);
    const denied=await guest.request.put(base+`/api/files/${file.id}/content`,{data:{content:'bad',expectedVersion:6}});assert.equal(denied.status(),401);
    const protectedShare=await json(`/files/${file.id}/shares`,'POST',{password:'test-password'});
    assert.equal((await guest.request.get(base+`/api/shares/${protectedShare.token}/raw`)).status(),400);
    await json(`/file-shares/${share.id}`,'PUT',{enabled:false});
    assert.ok((await guest.request.get(raw)).status()>=400);
    await json(`/file-shares/${share.id}`,'PUT',{enabled:true});
    const cloudChecks=[];
    if (process.env.ACCEPTANCE_TEXT_CLOUD === '1') {
      const configs=await json('/storage-configs');
      const clouds=configs.filter(c=>c.enabled && ['CLOUDFLARE_R2','UPYUN'].includes(c.provider));
      assert.ok(clouds.length,'No configured R2/Upyun plugins available');
      for (const cloud of clouds) {
        const bindings=await json(`/storage-configs/${cloud.id}/projects`);
        await json(`/storage-configs/${cloud.id}/projects`,'PUT',{projectIds:[...new Set([...bindings.map(p=>p.id),project.id])]});
      }
      saved=await json(`/files/${file.id}/content`,'PUT',{content:changed,expectedVersion:6});assert.equal(saved.currentVersion,7);
      const deadline=Date.now()+180000;
      let detail;
      do {
        detail=await json(`/files/${file.id}/storage-replicas`);
        if(clouds.every(c=>detail.items.some(i=>i.configId===c.id&&i.status==='READY'))) break;
        await new Promise(resolve=>setTimeout(resolve,2000));
      } while(Date.now()<deadline);
      for(const cloud of clouds) {
        const replica=detail.items.find(i=>i.configId===cloud.id);
        assert.equal(replica?.status,'READY',`${cloud.provider} edited content replica`);
        cloudChecks.push({provider:cloud.provider,status:replica.status,verifiedAt:replica.verifiedAt});
      }
      response=await api.get(direct);assert.equal(await response.text(),changed);
      const storageHeader=response.headers()['x-ufm-download-storage'];
      const source=JSON.parse(decodeURIComponent(storageHeader));assert.ok(source.selected.provider!=='LOCAL');
      cloudChecks.push({downloadProvider:source.selected.provider});
    }
    const report={status:'PASS',projectId:project.id,fileId:file.id,version:saved.currentVersion,direct,shareUrl:base+'/shares/'+share.token,raw,cloudChecks,checks:['JSON raw MIME','browser edit','version +1','stable direct and share URLs','JSON containing statusCode previews','stale save 409','150KB body','empty content','unchanged save +1','version restore','unauthorized save rejected','password and disabled-share enforcement']};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

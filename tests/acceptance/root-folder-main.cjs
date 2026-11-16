const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('C:/Users/shifuf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const env = Object.fromEntries(fs.readFileSync('.env','utf8').split(/\r?\n/).filter(s=>/^\w+=/.test(s)).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
(async()=>{
  const browser = await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  try {
    const context = await browser.newContext({baseURL:'http://localhost:5175',viewport:{width:1440,height:1000}});
    const auth=await context.request.post('/api/auth/login',{data:{username:env.ADMIN_USERNAME,password:env.ADMIN_PASSWORD}});
    assert.equal(auth.status(),201);const {user}=await auth.json();
    await context.addInitScript(p=>localStorage.setItem('ufm_user_profile',JSON.stringify(p)),user);
    const projectResponse=await context.request.post('/api/projects',{data:{name:'根目录回归-'+Date.now()}});
    assert.equal(projectResponse.status(),201);const project=await projectResponse.json();
    const uploaded=await context.request.post(`/api/projects/${project.id}/files`,{multipart:{files:{name:'中文类型测试.txt',mimeType:'text/plain',buffer:Buffer.from('type label')}}});
    assert.equal(uploaded.status(),201);const [testFile]=await uploaded.json();
    const page=await context.newPage();await page.goto('/projects');
    const row=page.getByRole('row').filter({hasText:project.name});await row.waitFor();
    assert.equal(await row.getByRole('button',{name:'新建根目录',exact:true}).count(),1,'project list must expose root creation');
    await row.getByRole('button',{name:'新建根目录',exact:true}).click();
    let dialog=page.getByRole('dialog',{name:'新建根目录',exact:true});await dialog.getByRole('textbox').fill('一级目录');
    await Promise.all([page.waitForResponse(r=>r.url().includes('/files/folders')&&r.request().method()==='POST'),dialog.getByRole('button',{name:'创建',exact:true}).click()]);
    await page.goto('/projects/'+project.id);
    await page.getByText('中文类型测试.txt',{exact:true}).first().waitFor();
    const fileRows=page.getByRole('row').filter({hasText:'中文类型测试.txt'});
    for(const fileRow of await fileRows.all()){assert.match(await fileRow.innerText(),/文档/);assert.doesNotMatch(await fileRow.innerText(),/DOCUMENT/);}
    const node=page.locator('.directory-node').filter({hasText:'一级目录'});await node.getByRole('button',{name:'新建子目录'}).click();
    dialog=page.getByRole('dialog',{name:'新建子目录',exact:true});await dialog.getByRole('textbox').fill('二级目录');
    await Promise.all([page.waitForResponse(r=>r.url().includes('/files/folders')&&r.request().method()==='POST'),dialog.getByRole('button',{name:'创建',exact:true}).click()]);
    await page.getByRole('button',{name:'新建根目录',exact:true}).click();
    dialog=page.getByRole('dialog',{name:'新建根目录',exact:true});await dialog.getByRole('textbox').fill('另一个根目录');
    await Promise.all([page.waitForResponse(r=>r.url().includes('/files/folders')&&r.request().method()==='POST'),dialog.getByRole('button',{name:'创建',exact:true}).click()]);
    const tree=await (await context.request.get(`/api/projects/${project.id}/files/folder-tree`)).json();
    assert(tree.some(n=>n.path==='一级目录'));assert(tree.some(n=>n.path==='另一个根目录'));
    assert.equal(tree.find(n=>n.path==='一级目录').children[0].path,'一级目录/二级目录');
    const blocked=await context.request.delete(`/api/projects/${project.id}/files/folders`,{data:{folderPath:'一级目录'}});assert.equal(blocked.status(),409);
    await page.screenshot({path:'.runtime/plugin-work/root-folder-fixed.png',fullPage:true});
    for(const folderPath of ['一级目录/二级目录','一级目录','另一个根目录'])assert.equal((await context.request.delete(`/api/projects/${project.id}/files/folders`,{data:{folderPath}})).status(),200);
    await context.request.delete('/api/files/'+testFile.id);
    await page.goto('/recycle-bin');
    await page.getByText('确认彻底删除后清理',{exact:true}).first().waitFor();
    assert.doesNotMatch(await page.locator('body').innerText(),/到期清理|即将清理/);
    assert.equal((await context.request.delete('/api/files/'+testFile.id+'/purge')).status(),200);
    await context.request.delete('/api/projects/'+project.id);await context.request.post('/api/auth/logout');
    console.log('PASS: project list root creation, detail root and child creation, nested parent refusal and empty directory deletion.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e.message);process.exitCode=1;});

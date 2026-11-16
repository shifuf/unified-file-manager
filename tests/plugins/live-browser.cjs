const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/shifuf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'../..');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});try{
 const context=await browser.newContext({viewport:{width:1500,height:1100}});
 const auth=await context.request.post('http://127.0.0.1:3016/api/auth/login',{data:{username:'plugin-admin',password:'PluginAcceptance2026!Local'}});assert.equal(auth.status(),201);const profile=(await auth.json()).user;
 await context.addInitScript(p=>localStorage.setItem('ufm_user_profile',JSON.stringify(p)),profile);
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',async r=>{if(r.status()>=400)console.error('HTTP',r.status(),r.url(),(await r.text()).slice(0,200));});
 await page.goto('http://127.0.0.1:5176/storage-configs');await page.getByRole('heading',{name:'存储配置',exact:true}).waitFor();await page.getByText('CLOUDFLARE_R2',{exact:true}).first().waitFor();
 const pluginPanel=page.locator('.plugin-panel');await pluginPanel.locator('input[type=file]').setInputFiles(path.join(root,'plugins/cloudflare-r2/CLOUDFLARE_R2-1.0.0.zip'));await page.getByText(/插件.*安装|安装.*成功/).first().waitFor({timeout:15000});
 const row=pluginPanel.getByRole('row').filter({hasText:'CLOUDFLARE_R2'});const download=page.waitForEvent('download');await row.getByRole('button',{name:'下载包'}).click();assert.match((await download).suggestedFilename(),/CLOUDFLARE_R2/);
 await page.screenshot({path:path.join(root,'.runtime/plugin-work/live-plugins.png'),fullPage:true});
 const data=JSON.parse(await fs.readFile(path.join(root,'.runtime/plugin-work/integration.json'),'utf8'));
 await page.goto('http://127.0.0.1:5176/projects/'+data.projectId);const create=page.getByRole('button',{name:'新建根目录',exact:true});await create.waitFor();await create.click();const dialog=page.getByRole('dialog',{name:'新建根目录'});const name='浏览器根目录'+Date.now();await dialog.getByRole('textbox').fill(name);await dialog.getByRole('button',{name:'创建',exact:true}).click();await page.getByText(name,{exact:false}).first().waitFor();
 const node=page.locator('.directory-node').filter({hasText:name});await node.getByRole('button',{name:'新建子目录'}).click();const child=page.getByRole('dialog',{name:'新建子目录'});await child.getByRole('textbox').fill('子目录');await Promise.all([page.waitForResponse(r=>r.url().includes('/folder-tree')&&r.request().method()==='GET'),child.getByRole('button',{name:'创建',exact:true}).click()]);await Promise.all([page.waitForResponse(r=>r.url().includes('/folder-tree')),page.getByRole('button',{name:'刷新目录',exact:true}).click()]);
 await node.getByRole('button',{name:'删除目录'}).click();await page.getByText('目录中存在子目录，请先删除子目录。',{exact:true}).waitFor();
 await page.screenshot({path:path.join(root,'.runtime/plugin-work/live-directories.png'),fullPage:true});assert.deepEqual(errors,[]);
 console.log('Live browser PASS: real plugin ZIP upgrade/download; root and child directory creation; nonempty-parent refusal; no page errors.');
}finally{await browser.close();}})().catch(e=>{console.error(e.message);process.exitCode=1});

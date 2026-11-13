/* Real Chrome checks for custom DAV addresses; retains project changes and screenshots. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/shifuf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'../..'),base=process.env.UFM_TEST_BASE||'http://localhost:5175';
const latest=JSON.parse(fs.readFileSync(path.join(root,'.runtime/acceptance-20261114-webdav',base.startsWith('https:')?'public-latest.json':'local-latest.json'),'utf8')),out=path.join(latest.out,'browser');fs.mkdirSync(out,{recursive:true});
const report={base,checks:[],screenshots:[],retained:true};let browser;
const check=(name,evidence)=>{report.checks.push({name,pass:true,evidence});console.log(JSON.stringify({name,pass:true}));};
async function credentials(){if(process.env.UFM_TEST_AUTH_STDIN==='1'){let input='';for await(const c of process.stdin)input+=c;return JSON.parse(input);}const env=Object.fromEntries(fs.readFileSync(path.join(root,'.env'),'utf8').split(/\r?\n/).filter(s=>/^\w+=/.test(s)).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]}));return {username:env.ADMIN_USERNAME,password:env.ADMIN_PASSWORD};}
(async()=>{try{
 const auth=await credentials();browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/console-login');await page.locator('input[autocomplete="username"]').fill(auth.username);await page.locator('input[autocomplete="current-password"]').fill(auth.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/dashboard');
 await page.getByRole('heading',{name:'系统概览',exact:true}).waitFor();
 await page.goto(base+'/projects');
 const row=name=>page.locator('.el-table__row').filter({hasText:name});const dialog=page.getByRole('dialog',{name:'编辑项目'});const slugInput=()=>dialog.locator('input[placeholder*="英文或数字"]');
 async function open(project){await Promise.all([page.waitForResponse(r=>r.url().endsWith('/projects/'+project.id+'/webdav')&&r.status()===200),row(project.name).getByRole('button',{name:'编辑',exact:true}).click()]);await slugInput().waitFor();await page.waitForFunction(()=>{const input=document.querySelector('input[placeholder*="英文或数字"]');return input&&!input.disabled;});}
 const first=latest.projects[0],second=latest.projects[1];await open(first);await slugInput().fill('bad/path');await slugInput().blur();await dialog.getByText('DAV 地址后缀只能填写英文或数字。',{exact:true}).waitFor();check('真实表单拒绝非法 DAV 后缀');
 const custom='Ui'+Date.now().toString(36);await slugInput().fill(custom);await slugInput().blur();await dialog.getByText(base+'/api/dav/'+custom.toLowerCase(),{exact:false}).waitFor();
 const screenshot=path.join(out,'custom-dav-address.png');await page.screenshot({path:screenshot,fullPage:true});report.screenshots.push(screenshot);
 const saved=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/projects/'+first.id)&&r.request().method()==='PUT'&&r.status()===200),dialog.getByRole('button',{name:'保存',exact:true}).click()]);const savedProject=await saved[0].json();assert.equal(savedProject.webdavSlug,custom.toLowerCase());check('真实表单保存英文数字混合地址并显示小写预览',{slug:savedProject.webdavSlug});
 await dialog.waitFor({state:'hidden'});await open(first);assert.equal(await slugInput().inputValue(),custom.toLowerCase());await slugInput().fill('');await dialog.getByText('保存后随机生成',{exact:false}).waitFor();
 const regenerated=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/projects/'+first.id)&&r.request().method()==='PUT'&&r.status()===200),dialog.getByRole('button',{name:'保存',exact:true}).click()]);const random=await regenerated[0].json();assert.match(random.webdavSlug,/^[a-f0-9]{24}$/);assert.notEqual(random.webdavSlug,custom.toLowerCase());check('真实表单清空地址后随机生成',{slug:random.webdavSlug});
 await dialog.waitFor({state:'hidden'});
 let delayed=false;await page.route('**/projects/'+first.id+'/webdav',async route=>{if(!delayed){delayed=true;await new Promise(r=>setTimeout(r,1200));}await route.continue().catch(()=>{});});
 await row(first.name).getByRole('button',{name:'编辑',exact:true}).click();await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});await open(second);await page.waitForTimeout(1400);assert.equal(await slugInput().inputValue(),second.slug);check('项目编辑切换隔离迟到的 DAV 设置响应',{projectId:second.id});
 await dialog.getByRole('button',{name:'取消',exact:true}).click();await page.unroute('**/projects/'+first.id+'/webdav');
 assert.deepEqual(errors,[]);check('无未处理浏览器异常');await page.getByRole('button',{name:'退出',exact:true}).click();report.counts={passed:report.checks.length,failed:0};
}catch(error){report.error=error.message;report.counts={passed:report.checks.length,failed:1};console.error(error.message);process.exitCode=1;}finally{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));if(browser)await browser.close();}})();

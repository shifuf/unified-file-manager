const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const script=path.resolve(__dirname,'../../scripts/install-storage-plugins.cjs');
test('installer logs in, installs all six archives, verifies versions and logs out without printing secrets',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ufm-install-')),installed=[],requests=[];
 const names=['qiniu','upyun','aliyun','s3','cloudflare-r2','aliyun-drive'];
 for(const name of names){const dir=path.join(root,'plugins',name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'storage-plugin.json'),JSON.stringify({id:name,version:'1.0.0'}));fs.writeFileSync(path.join(dir,`${name}-1.0.0.zip`),'fixture');}
 const server=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;requests.push(req.url);res.setHeader('content-type','application/json');
 if(req.url==='/api/auth/login'){assert.equal(JSON.parse(body).password,'private-password');res.setHeader('set-cookie','access=test; HttpOnly');res.end('{}');}
 else if(req.url==='/api/storage-plugins'&&req.method==='POST'){assert.equal(req.headers.cookie,'access=test');const id=names[installed.length];installed.push({id,version:'1.0.0',available:true,sha256:require('node:crypto').createHash('sha256').update('fixture').digest('hex')});res.end(JSON.stringify(installed.at(-1)));}
 else if(req.url==='/api/storage-plugins')res.end(JSON.stringify(installed));else res.end('{}');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const child=spawn(process.execPath,[script,'--root',root,'--url',`http://127.0.0.1:${server.address().port}`],{env:{...process.env,ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'private-password'}});let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);const code=await new Promise(r=>child.on('close',r));assert.equal(code,0,output);assert.equal(installed.length,6);assert.equal(requests.at(-1),'/api/auth/logout');assert(!output.includes('private-password'));}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});

test('installer skips identical verified archives on rerun and logs out',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ufm-install-')),requests=[];
 const installed=['qiniu','upyun','aliyun','s3','cloudflare-r2','aliyun-drive'].map(name=>({id:name,version:'1.0.0',available:true,sha256:require('node:crypto').createHash('sha256').update('fixture').digest('hex')}));
 for(const item of installed){const dir=path.join(root,'plugins',item.id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'storage-plugin.json'),JSON.stringify(item));fs.writeFileSync(path.join(dir,`${item.id}-1.0.0.zip`),'fixture');}
 const server=http.createServer(async(req,res)=>{for await(const _ of req){} requests.push(req.method+' '+req.url);res.setHeader('content-type','application/json');
 if(req.url==='/api/auth/login'){res.setHeader('set-cookie','access=test; HttpOnly');res.end('{}');}else if(req.url==='/api/storage-plugins'&&req.method==='GET')res.end(JSON.stringify(installed));else if(req.url==='/api/storage-plugins'){res.writeHead(500).end('{}');}else res.end('{}');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const child=spawn(process.execPath,[script,'--root',root,'--url',`http://127.0.0.1:${server.address().port}`],{env:{...process.env,ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'private-password'}});let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);const code=await new Promise(r=>child.on('close',r));assert.equal(code,0,output);assert(!requests.includes('POST /api/storage-plugins'));assert.equal(requests.at(-1),'POST /api/auth/logout');}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});

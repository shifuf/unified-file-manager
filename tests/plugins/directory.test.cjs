const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const vm=require('node:vm');
test('project root creation is explicit and submits no currently selected parent',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../../apps/web/src/views/ProjectDetail.vue'),'utf8');
 assert.match(source,/@click="createDirectory\(\)">新建根目录<\/el-button>/);
 const script=source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
 const parsed=ts.createSourceFile('view.ts',script,ts.ScriptTarget.Latest,true);
 const fn=parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='createDirectory');
 const calls=[];const context={project:{value:{canManage:true}},captureContext:()=>({id:'p',current:()=>true}),ElMessageBox:{prompt:async()=>({value:'一级目录'})},ElMessage:{warning(){},success(){}},fileApi:{createFolder:async(...args)=>calls.push(args)},loadDirectories:async()=>{},selectedFolder:'旧目录/子目录'};
 vm.runInNewContext(ts.transpileModule(fn.getText(parsed),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
 await context.createDirectory();assert.deepEqual(Array.from(calls[0]),['p','一级目录']);
 await context.createDirectory('父目录');assert.deepEqual(Array.from(calls[1]),['p','父目录/一级目录']);
});

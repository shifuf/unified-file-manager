const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
test('copying a file public link produces a complete URL usable outside the site',()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../../apps/web/src/views/Files.vue'),'utf8');
 const fn=source.match(/function copyPublicUrl\([\s\S]*?\n\}/)[0],copied=[];
 const context={URL,window:{location:{origin:'https://files.shifuf.com'}},copyText:v=>{copied.push(v);return Promise.resolve(true);},ElMessage:{success:()=>{}}};vm.createContext(context);
 vm.runInContext(ts.transpileModule(fn,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
 context.copyPublicUrl({id:'f',accessUrl:'/api/public/files/f',isPublic:true});assert.equal(copied.pop(),'https://files.shifuf.com/api/public/files/f');
 context.copyPublicUrl({id:'f',publicUrl:'/api/public/files/f',isPublic:true});assert.equal(copied.pop(),'https://files.shifuf.com/api/public/files/f');
 context.copyPublicUrl({id:'f',accessUrl:'https://files.shifuf.com/api/public/files/f',isPublic:true});assert.equal(copied.pop(),'https://files.shifuf.com/api/public/files/f');
 context.copyPublicUrl({id:'f',isPublic:true});assert.equal(copied.pop(),'https://files.shifuf.com/api/public/files/f');
});

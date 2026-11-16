const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('ts-node').register({ project: path.resolve(__dirname, '../../apps/api/tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const { Module, Controller, Post, Body } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { registerJsonBodyParsers } = require('../../apps/api/src/common/utils/json-body.util.ts');

test('large text parser leaves normal JSON routes working and retains their size limit', async t => {
  class Echo { normal(body) { return { value: body }; } content(body) { return { length: body.content.length }; } }
  Controller()(Echo);
  for(const [name,route] of [['normal','auth/login'],['content','files/:fileId/content']]) {
    Post(route)(Echo.prototype,name,Object.getOwnPropertyDescriptor(Echo.prototype,name));
    Body()(Echo.prototype,name,0);
  }
  class Fixture {}
  Module({controllers:[Echo]})(Fixture);
  const app=await NestFactory.create(Fixture,{logger:false,rawBody:true});
  app.setGlobalPrefix('api');registerJsonBodyParsers(app);await app.listen(0,'127.0.0.1');
  t.after(()=>app.close());const base=await app.getUrl();
  const post=(route,body)=>fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let r=await post('auth/login',{username:'fixture',password:'fixture-password'});
  assert.deepEqual(await r.json(),{value:{username:'fixture',password:'fixture-password'}});
  r=await post('files/f/content',{content:'中'.repeat(50000)});assert.equal(r.status,201);assert.equal((await r.json()).length,50000);
  r=await post('auth/login',{content:'x'.repeat(150000)});await r.text();assert.equal(r.status,413);
});

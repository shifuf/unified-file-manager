const path=require('node:path');
const root=path.resolve(__dirname,'../..');
Object.assign(process.env,require(path.join(root,'.runtime/plugin-work/environment.json')));
require(path.join(root,'apps/api/dist/main.js'));

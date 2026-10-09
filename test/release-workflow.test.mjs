import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const yml = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const script = yml.split('          script: |\n')[1].split('\n').map(l=>l.slice(12)).join('\n');
const run = new Function('require','github','context','core',`return (async()=>{${script}})()`);
let count=0;
for (const mode of ['create','retry','conflict','failed-ci','invalid-version']) {
 let writes=0;
 const github={paginate:async()=>mode==='failed-ci'?[]:[{head_branch:'main',status:'completed',conclusion:'success'}],rest:{actions:{listWorkflowRuns(){}},git:{getRef:async()=>{
 if(mode==='create') throw Object.assign(new Error('missing'),{status:404});
 return {data:{object:{type:'commit',sha:mode==='conflict'?'other':'abc'}}};
 },createRef:async args=>{assert.equal(args.sha,'abc');assert.equal(args.ref,'refs/tags/v0.2.5');writes++;}}}};
 const call=()=>run(()=>({readFileSync:()=>JSON.stringify({version:mode==='invalid-version'?'bad':'0.2.5'})}),github,{repo:{owner:'Azeajr',repo:'web-harness'},sha:'abc'},{notice(){}});
 if(['conflict','failed-ci','invalid-version'].includes(mode)) await assert.rejects(call); else await call();
 assert.equal(writes,mode==='create'?1:0);count++;
}
console.log(`${count} release workflow cases passed`);

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { register } from 'tsx/esm/api';
register();
const { openYuanpuMetadataDatabase } = await import('../../../packages/yuanpu-runtime/src/persistence/index.ts');
const { WorkDirectoryMoveCoordinator } = await import('../src/work-directory-move.ts');
import { SessionManager } from '@earendil-works/pi-coding-agent';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'yuanpu-move-')));
  const workspaceRoot = join(root, 'workspace');
  const sessionsRoot = join(root, 'sessions');
  const toolStateRoot = join(root, 'tools');
  for (const directory of [workspaceRoot,sessionsRoot,toolStateRoot]) await mkdir(directory);
  const file = join(root,'metadata.sqlite');
  let db = openYuanpuMetadataDatabase(file);
  t.after(async () => { db.close(); await rm(root,{recursive:true,force:true}); });
  const scope = '/scope';
  const targetId = `folder:${randomUUID()}`;
  const targetPath = `f-${targetId.slice(7)}`;
  await mkdir(join(workspaceRoot,targetPath));
  db.workConversations.createFolder(scope,targetId,null,'Destination','folder',targetPath);
  const id = `work:${randomUUID()}`;
  const old = join(workspaceRoot,`c-${id.slice(5)}`);
  await mkdir(old); await writeFile(join(old,'hello.txt'),'preserved');
  const conversation = db.workConversations.create(scope,old,null,id);
  const pi = db.workConversations.sessionId(scope,id);
  const manager = SessionManager.create(old,sessionsRoot,{id:pi});
  manager.appendMessage({role:'user',content:'hello',timestamp:Date.now()});
  manager.appendMessage({role:'assistant',content:[{type:'text',text:'world'}],api:'openai-completions',provider:'test',model:'test',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
  const jsonl = manager.getSessionFile();
  const options = () => ({store:db.workConversations,workspaceId:scope,workspaceRoot,sessionsRoot,toolStateRoot,
    verifySession(cwd, piId, expected) { assert.equal(SessionManager.findById(cwd,piId,sessionsRoot),expected); }});
  return { root,workspaceRoot,sessionsRoot,toolStateRoot,scope,id,pi,old,jsonl,targetId,targetPath,conversation,
    get db(){return db;}, options, restart(){ db.close(); db=openYuanpuMetadataDatabase(file); },
    request:()=>({requestId:randomUUID(),kind:'conversation',id,targetFolderId:targetId}) };
}

test('real SQLite and Pi JSONL move preserves transcript, appends and cached identities after restart',async t=>{
  const f=await fixture(t); const original=await readFile(f.jsonl,'utf8');
  const request=f.request(); const mover=new WorkDirectoryMoveCoordinator(f.options());
  const result=await mover.move(request);
  const next=join(f.workspaceRoot,f.targetPath,`c-${f.id.slice(5)}`);
  assert.equal(await readFile(join(next,'hello.txt'),'utf8'),'preserved');
  await assert.rejects(stat(f.old),{code:'ENOENT'});
  assert.equal(f.db.workConversations.row(f.scope,f.id).working_directory,next);
  assert.equal(SessionManager.findById(f.old,f.pi,f.sessionsRoot),undefined);
  assert.equal(SessionManager.findById(next,f.pi,f.sessionsRoot),f.jsonl);
  assert.equal((await readFile(f.jsonl,'utf8')).split('\n').slice(1).join('\n'),original.split('\n').slice(1).join('\n'));
  f.restart(); await new WorkDirectoryMoveCoordinator(f.options()).recover();
  const reopened=SessionManager.open(f.jsonl,f.sessionsRoot,next);
  assert.equal(reopened.getSessionId(),f.pi); assert.equal(reopened.getBranch().length,2);
  reopened.appendMessage({role:'user',content:'next turn',timestamp:Date.now()});
  assert.equal(JSON.parse((await readFile(f.jsonl,'utf8')).split('\n')[0]).cwd,next);
  assert.deepEqual(await new WorkDirectoryMoveCoordinator(f.options()).move(request),result);
});

test('read leases protect previews and searches, and move rejects new readers until settled',async t=>{
  const f=await fixture(t); const mover=new WorkDirectoryMoveCoordinator(f.options());
  const release=mover.acquireRead();
  await assert.rejects(mover.move(f.request()),/正被读取/);
  assert.equal(f.db.workConversations.moveRecords().length,0);
  release(); release();
  let releaseCheckpoint; let entered;
  const waiting=new Promise(resolve=>{entered=resolve;});
  const blocking=new WorkDirectoryMoveCoordinator({...f.options(),checkpoint:async name=>{
    if(name==='prepared'){entered();await new Promise(resolve=>{releaseCheckpoint=resolve;});}
  }});
  const moving=blocking.move(f.request()); await waiting;
  assert.equal(blocking.busy,true); assert.throws(()=>blocking.acquireRead(),/搬迁/);
  releaseCheckpoint(); await moving;
  assert.equal(blocking.busy,false); blocking.acquireRead()();
});

test('rollback after a header write restores disk, header and SQLite together',async t=>{
  const f=await fixture(t); const original=await readFile(f.jsonl);
  const mover=new WorkDirectoryMoveCoordinator({...f.options(),checkpoint(name){if(name==='header:0')throw new Error('injected');}});
  await assert.rejects(mover.move(f.request()),/injected/);
  assert.equal(f.db.workConversations.row(f.scope,f.id).working_directory,f.old);
  assert.deepEqual(await readFile(f.jsonl),original);
  assert.equal(await readFile(join(f.old,'hello.txt'),'utf8'),'preserved');
  assert.equal(mover.busy,false);
});

function addRun(f,status='succeeded') {
  const database=f.db.database;
  const binding=database.prepare('SELECT binding_id FROM yp_conversation_bindings WHERE conversation_id=?').get(f.id).binding_id;
  const id=randomUUID();
  database.prepare(`INSERT INTO yp_agent_runs(run_id,entry_point,authority_id,subject_id,idempotency_key,request_fingerprint,input_digest,request_metadata_json,binding_id,status,created_at,updated_at)
    VALUES (?,'desktop','local-desktop','local-user',?,?,?,?,?,?,?,?)`)
    .run(id,id,'a'.repeat(64),createHash('sha256').update('hello').digest('hex'),JSON.stringify({workspaceId:f.old}),binding,status==='waiting_approval'?'running':status,'2026-09-27T00:00:00Z','2026-09-27T00:00:00Z');
  if(status==='waiting_approval') database.prepare("UPDATE yp_agent_runs SET status='waiting_approval',approval_request_id='approval',approval_session_id=?,approval_workspace_id=?,approval_expires_at='2099-01-01T00:00:00Z' WHERE run_id=?").run(f.pi,f.old,id);
  database.prepare('INSERT INTO yp_agent_run_outputs(run_id,output_json,created_at) VALUES(?,?,?)').run(id,JSON.stringify({message:'world',tools:[]}), '2026-09-27T00:00:00Z');
  return id;
}

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { symlink, rename } from 'node:fs/promises';

for(const phase of ['prepared','directory:0','header:0','committed','settled']) {
  test(`process death at ${phase} recovers exactly one authoritative location`,async t=>{
    const f=await fixture(t); const request=f.request();
    const script=join(f.root,'crash.mjs');
    await writeFile(script,`
      import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register();
      const {openYuanpuMetadataDatabase}=await import(${JSON.stringify(new URL('../../../packages/yuanpu-runtime/src/persistence/index.ts',import.meta.url).href)});
      const {WorkDirectoryMoveCoordinator}=await import(${JSON.stringify(new URL('../src/work-directory-move.ts',import.meta.url).href)});
      const db=openYuanpuMetadataDatabase(${JSON.stringify(join(f.root,'metadata.sqlite'))});
      await new WorkDirectoryMoveCoordinator({store:db.workConversations,workspaceId:${JSON.stringify(f.scope)},workspaceRoot:${JSON.stringify(f.workspaceRoot)},sessionsRoot:${JSON.stringify(f.sessionsRoot)},toolStateRoot:${JSON.stringify(f.toolStateRoot)},checkpoint(name){if(name===${JSON.stringify(phase)})process.kill(process.pid,'SIGKILL');}}).move(${JSON.stringify(request)});
    `);
    const child=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:15_000});
    assert.equal(child.signal,'SIGKILL',child.stderr);
    f.restart();
    const mover=new WorkDirectoryMoveCoordinator(f.options()); await mover.recover();
    const next=join(f.workspaceRoot,f.targetPath,`c-${f.id.slice(5)}`);
    const committed=phase==='committed'||phase==='settled';
    const authoritative=committed?next:f.old;
    assert.equal(f.db.workConversations.row(f.scope,f.id).working_directory,authoritative);
    assert.equal(await readFile(join(authoritative,'hello.txt'),'utf8'),'preserved');
    await assert.rejects(stat(committed?f.old:next),{code:'ENOENT'});
    assert.equal(SessionManager.findById(authoritative,f.pi,f.sessionsRoot),f.jsonl);
    await mover.recover();
    await mover.move(request);
    assert.equal(f.db.workConversations.row(f.scope,f.id).working_directory,next);
  });
}

test('folder subtree moves nested, archived and empty sessions and preserves source ledger',async t=>{
  const f=await fixture(t); const store=f.db.workConversations;
  const rootId=`folder:${randomUUID()}`; const rootPath=`f-${rootId.slice(7)}`;
  const childId=`folder:${randomUUID()}`; const childPath=`${rootPath}/f-${childId.slice(7)}`;
  await mkdir(join(f.workspaceRoot,childPath),{recursive:true});
  store.createFolder(f.scope,rootId,null,'source','folder',rootPath);
  store.createFolder(f.scope,childId,rootId,'nested','folder',childPath);
  // First exercise an ordinary leaf move into the source subtree.
  await new WorkDirectoryMoveCoordinator(f.options()).move({...f.request(),targetFolderId:childId});
  const before=store.row(f.scope,f.id).working_directory;
  const emptyId=`work:${randomUUID()}`; const empty=join(f.workspaceRoot,rootPath,`c-${emptyId.slice(5)}`);
  await mkdir(empty); store.create(f.scope,empty,rootId,emptyId);
  store.updateConversation(f.scope,f.id,{archived:true});
  const runId=addRun(f);
  const entries=SessionManager.open(f.jsonl,f.sessionsRoot,before).getBranch();
  const messages=entries.map(entry=>({id:entry.id,role:entry.message.role,text:entry.message.role==='user'?'hello':'world',at:entry.timestamp}));
  assert.equal(store.recordSavedTurns(f.id,messages),1);
  const sources=store.sources(f.id); const page=store.sourcePage(0,50);
  const toolPath=join(f.toolStateRoot,createHash('sha256').update(JSON.stringify([before,f.pi])).digest('hex'));
  await mkdir(toolPath); await writeFile(join(toolPath,'goals.json'),JSON.stringify({version:1,goals:[{id:'kept',status:'paused'}]}));
  const result=await new WorkDirectoryMoveCoordinator(f.options()).move({requestId:randomUUID(),kind:'folder',id:rootId,targetFolderId:f.targetId});
  assert.deepEqual(result.conversationIds.sort(),[f.id,emptyId].sort());
  const after=store.row(f.scope,f.id).working_directory;
  assert.equal(after,join(f.workspaceRoot,f.targetPath,childPath,`c-${f.id.slice(5)}`));
  assert.equal(store.row(f.scope,f.id).archived_at!==null,true);
  assert.equal(store.folderRow(f.scope,childId).relative_directory,`${f.targetPath}/${childPath}`);
  assert.equal(await readFile(join(f.toolStateRoot,createHash('sha256').update(JSON.stringify([after,f.pi])).digest('hex'),'goals.json'),'utf8'),JSON.stringify({version:1,goals:[{id:'kept',status:'paused'}]}));
  assert.equal(store.recordSavedTurns(f.id,messages),0); assert.deepEqual(store.sources(f.id),sources);
  assert.deepEqual(store.sourcePage(0,50),page);
  assert.equal(JSON.parse(f.db.database.prepare('SELECT request_metadata_json FROM yp_agent_runs WHERE run_id=?').get(runId).request_metadata_json).workspaceId,f.old);
  assert.equal(f.db.database.prepare('SELECT workspace_id FROM yp_conversation_bindings WHERE conversation_id=?').get(f.id).workspace_id,after);
});

for(const status of ['queued','running','waiting_approval'])test(`rejects ${status} before writing intent`,async t=>{
  const f=await fixture(t); addRun(f,status); const original=await readFile(f.jsonl);
  await assert.rejects(new WorkDirectoryMoveCoordinator(f.options()).move(f.request()),/run/);
  assert.equal(f.db.workConversations.moveRecords().length,0); assert.deepEqual(await readFile(f.jsonl),original);
  assert.equal(await readFile(join(f.old,'hello.txt'),'utf8'),'preserved');
});

test('rejects cycle, occupied destination, symlink and external cwd without partial writes',async t=>{
  const f=await fixture(t); const mover=new WorkDirectoryMoveCoordinator(f.options());
  await assert.rejects(mover.move({requestId:randomUUID(),kind:'folder',id:f.targetId,targetFolderId:f.targetId}),/itself/);
  const occupied=join(f.workspaceRoot,f.targetPath,`c-${f.id.slice(5)}`);
  await mkdir(occupied); await writeFile(join(occupied,'keep'),'untouched');
  await assert.rejects(mover.move(f.request()),/已存在/); await rm(occupied,{recursive:true});
  await symlink(f.targetPath,join(f.old,'link'));
  await assert.rejects(mover.move(f.request()),/符号链接/); await rm(join(f.old,'link'));
  const external=join(f.root,'external'); await rename(f.old,external);
  f.db.database.prepare('UPDATE yp_work_conversations SET working_directory=? WHERE conversation_id=?').run(external,f.id);
  await assert.rejects(mover.move(f.request()),/outside/);
  assert.equal(await readFile(join(external,'hello.txt'),'utf8'),'preserved');
  assert.equal(f.db.workConversations.moveRecords().length,0);
});

test('rejects moving a five-level folder subtree below another folder',async t=>{
  const f=await fixture(t); const store=f.db.workConversations;
  let parentId=null; let path=''; let rootId='';
  for(let level=1;level<=5;level++){
    const id=`folder:${randomUUID()}`;
    if(level===1)rootId=id;
    path=[path,`f-${id.slice(7)}`].filter(Boolean).join('/');
    await mkdir(join(f.workspaceRoot,path),{recursive:true});
    store.createFolder(f.scope,id,parentId,`level-${level}`,'folder',path);
    parentId=id;
  }
  await assert.rejects(new WorkDirectoryMoveCoordinator(f.options()).move({
    requestId:randomUUID(),kind:'folder',id:rootId,targetFolderId:f.targetId,
  }),/五级/);
  assert.equal(store.listFolders(f.scope).find((folder)=>folder.id===rootId).parentId,null);
  assert.equal(store.moveRecords().length,0);
});

import { createServer } from 'node:http';
const { RuntimeAgentExecutor } = await import('../src/agent-runtime.ts');
import { PersistentAgentService, readYuanpuChatTranscript } from '@yuanpu-agent/runtime-kit';
import { AGENT_CONTRACT_VERSION } from '@yuanpu-agent/protocol';
const { readWorkspaceFile } = await import('../src/workspace-files.ts');

test('pooled Pi session is drained before move and the next model tool writes at new cwd',async t=>{
  const f=await fixture(t); const agentDir=join(f.root,'agent'); await mkdir(agentDir);
  let calls=0;
  const server=createServer(async(req,res)=>{
    for await(const _ of req) { /* consume fixture prompt */ }
    calls++;
    res.writeHead(200,{'content-type':'text/event-stream'});
    const chunk=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:`fixture-${calls}`,object:'chat.completion.chunk',created:0,model:'fixture-model',choices:[{index:0,delta,finish_reason}]})}\n\n`);
    if(calls%2===1){
      chunk({role:'assistant',tool_calls:[{index:0,id:`write-${calls}`,type:'function',function:{name:'write',arguments:JSON.stringify({path:`model-${calls}.txt`,content:`written-${calls}`})}}]});
      chunk({},'tool_calls');
    }else{chunk({role:'assistant',content:`Done ${calls}.`});chunk({},'stop');}
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  await writeFile(join(agentDir,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',models:[{id:'fixture-model',name:'Fixture model',reasoning:false,input:['text'],contextWindow:128000,maxTokens:1024}]}}}));
  const executor=new RuntimeAgentExecutor({sessionsPath:f.sessionsRoot,
    getCapabilityClient:()=>({async search(){return {matches:[]};},async execute(){throw new Error('unexpected capability');}}),
    approvals:{get(){return undefined;}},chat:{agentDir,modelConfigDir:agentDir,cwd:f.old,provider:'fixture',model:'fixture-model',apiKey:'fixture-only'}});
  const service=await PersistentAgentService.open({store:f.db.agentRuns,executor});
  const identity={kind:'local_user',subjectId:'local-user',authorityId:'local-desktop',authenticatedBy:'electron'};
  const caller={entryPoint:'desktop',identity,authorizeWorkspace:()=>true,authorizeConversation:()=>true,authorizeDelivery:()=>true};
  const submit=async(message)=>{
    const receipt=await service.submit(caller,{contractVersion:AGENT_CONTRACT_VERSION,entryPoint:'desktop',identity,
      workspaceId:f.db.workConversations.row(f.scope,f.id).working_directory,
      conversation:{namespace:'desktop',conversationId:f.id},input:{type:'text',text:message},idempotencyKey:randomUUID(),delivery:{kind:'none'}});
    assert.equal(receipt.accepted,true); await service.waitForIdle();
    const run=await service.get(caller,receipt.runId); assert.equal(run.status,'succeeded',JSON.stringify(run.failure)); return run;
  };
  try {
    const first=await submit('Write the first file.');
    const beforeTranscript=readYuanpuChatTranscript(f.old,f.pi,f.sessionsRoot,100_000,true);
    f.db.workConversations.recordSavedTurns(f.id,beforeTranscript);
    const beforeSources=f.db.workConversations.sources(f.id);
    assert.equal(await readFile(join(f.old,'model-1.txt'),'utf8'),'written-1');
    await new WorkDirectoryMoveCoordinator({...f.options(),drainSessions:ids=>executor.drainSessions(ids)}).move(f.request());
    const next=f.db.workConversations.row(f.scope,f.id).working_directory;
    const second=await submit('Write the second file.');
    assert.equal(second.context.workspaceId,next); assert.equal(first.context.workspaceId,f.old);
    assert.equal(second.context.conversation.sessionBindingId,first.context.conversation.sessionBindingId);
    assert.equal((await readWorkspaceFile(next,'model-3.txt')).content,'written-3');
    await assert.rejects(stat(f.old),{code:'ENOENT'});
    assert.equal(SessionManager.findById(next,f.pi,f.sessionsRoot),f.jsonl);
    const afterTranscript=readYuanpuChatTranscript(next,f.pi,f.sessionsRoot,100_000,true);
    assert.deepEqual(afterTranscript.slice(0,beforeTranscript.length),beforeTranscript);
    f.db.workConversations.recordSavedTurns(f.id,afterTranscript);
    assert.deepEqual(f.db.workConversations.sources(f.id).slice(0,beforeSources.length),beforeSources);
  } finally { await service.close(); await executor.close(); }
});

import { chmod } from 'node:fs/promises';
test('JSONL permission bits survive both successful migration and rollback',async t=>{
  if(process.platform==='win32')return t.skip('POSIX mode check');
  const f=await fixture(t); await chmod(f.jsonl,0o660);
  const mover=new WorkDirectoryMoveCoordinator({...f.options(),checkpoint(name){if(name==='header:0')throw new Error('rollback');}});
  await assert.rejects(mover.move(f.request()),/rollback/);
  assert.equal((await stat(f.jsonl)).mode&0o777,0o660);
  await new WorkDirectoryMoveCoordinator(f.options()).move(f.request());
  assert.equal((await stat(f.jsonl)).mode&0o777,0o660);
});

for(const state of [{status:'paused',checkpoint:{index:'1',prompt:'approve'}},{status:'needs_approval'},{status:'running'}])test(`uncached persisted ${state.status} workflow prevents a move`,async t=>{
  const f=await fixture(t); const toolPath=join(f.toolStateRoot,createHash('sha256').update(JSON.stringify([f.old,f.pi])).digest('hex'));
  await mkdir(join(toolPath,'runs','fixture'),{recursive:true});
  await writeFile(join(toolPath,'runs','fixture','run.json'),JSON.stringify(state));
  f.restart();
  await assert.rejects(new WorkDirectoryMoveCoordinator(f.options()).move(f.request()),/Persisted workflow/);
  assert.equal(f.db.workConversations.moveRecords().length,0);
  assert.equal(await readFile(join(f.old,'hello.txt'),'utf8'),'preserved');
});

test('linked Git worktree is rejected before disk or metadata writes',async t=>{
  const f=await fixture(t); await writeFile(join(f.old,'.git'),'gitdir: /some/repository/.git/worktrees/kept\n');
  await assert.rejects(new WorkDirectoryMoveCoordinator(f.options()).move(f.request()),/Git.*relocation/);
  assert.equal(f.db.workConversations.moveRecords().length,0);
  assert.equal(f.db.workConversations.row(f.scope,f.id).working_directory,f.old);
});

test('SQLite commit failure rolls back already moved disk and header',async t=>{
  const f=await fixture(t); const original=await readFile(f.jsonl);
  f.db.database.exec(`CREATE TRIGGER reject_move BEFORE UPDATE OF working_directory ON yp_work_conversations BEGIN SELECT RAISE(ABORT,'injected SQLite failure'); END`);
  await assert.rejects(new WorkDirectoryMoveCoordinator(f.options()).move(f.request()),/injected SQLite failure/);
  assert.equal(f.db.workConversations.row(f.scope,f.id).working_directory,f.old);
  assert.deepEqual(await readFile(f.jsonl),original);
  assert.equal(await readFile(join(f.old,'hello.txt'),'utf8'),'preserved');
  assert.equal(f.db.database.prepare('SELECT workspace_id FROM yp_conversation_bindings WHERE conversation_id=?').get(f.id).workspace_id,f.old);
});

test('partial subtree header updates roll back all descendants',async t=>{
  const f=await fixture(t); const store=f.db.workConversations;
  await new WorkDirectoryMoveCoordinator(f.options()).move(f.request());
  const firstOld=store.row(f.scope,f.id).working_directory;
  const secondId=`work:${randomUUID()}`; const secondOld=join(f.workspaceRoot,f.targetPath,`c-${secondId.slice(5)}`);
  await mkdir(secondOld); store.create(f.scope,secondOld,f.targetId,secondId);
  const pi=store.sessionId(f.scope,secondId);
  const original=await readFile(f.jsonl,'utf8'); const [header,...rest]=original.split('\n');
  const secondFile=join(f.sessionsRoot,`fixture_${pi}.jsonl`);
  await writeFile(secondFile,[JSON.stringify({...JSON.parse(header),id:pi,cwd:secondOld}),...rest].join('\n'));
  const destinationId=`folder:${randomUUID()}`; const destinationPath=`f-${destinationId.slice(7)}`;
  await mkdir(join(f.workspaceRoot,destinationPath)); store.createFolder(f.scope,destinationId,null,'destination','folder',destinationPath);
  const mover=new WorkDirectoryMoveCoordinator({...f.options(),checkpoint(name){if(name==='header:0')throw new Error('partial headers');}});
  await assert.rejects(mover.move({requestId:randomUUID(),kind:'folder',id:f.targetId,targetFolderId:destinationId}),/partial headers/);
  assert.equal(store.row(f.scope,f.id).working_directory,firstOld);
  assert.equal(store.row(f.scope,secondId).working_directory,secondOld);
  assert.equal(SessionManager.findById(firstOld,f.pi,f.sessionsRoot),f.jsonl);
  assert.equal(SessionManager.findById(secondOld,pi,f.sessionsRoot),secondFile);
});

test('additional same-cwd bindings cannot hide an untracked session from migration',async t=>{
  const f=await fixture(t);
  f.db.database.prepare(`INSERT INTO yp_conversation_bindings(binding_id,entry_point,authority_id,subject_id,namespace,conversation_id,thread_id,pi_session_id,workspace_id,created_at,updated_at)
    VALUES ('extra','desktop','local-desktop','local-user','desktop','other','',?,?,'now','now')`).run(randomUUID(),f.old);
  await assert.rejects(new WorkDirectoryMoveCoordinator(f.options()).move(f.request()),/additional session bindings/);
  assert.equal(f.db.workConversations.moveRecords().length,0);
});

for(const [file,data] of [['goals.json',{version:1,goals:[null]}],['runs/fixture/run.json',{}]])test(`invalid persisted ${file} fails closed`,async t=>{
  const f=await fixture(t); const toolPath=join(f.toolStateRoot,createHash('sha256').update(JSON.stringify([f.old,f.pi])).digest('hex'));
  await mkdir(join(toolPath,'runs','fixture'),{recursive:true}); await writeFile(join(toolPath,file),JSON.stringify(data));
  await assert.rejects(new WorkDirectoryMoveCoordinator(f.options()).move(f.request()),/Persisted/);
  assert.equal(f.db.workConversations.moveRecords().length,0);
});

/** 隔离浏览器夹具：真实 bundle/React/RPC，只读仓库，文件操作全部留在浏览器内存。 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createEditorRpcHandler } from '../../src/editor/rpc.ts'
import { minimalConfigOf } from '../../web-client/src/edits.js'
import { buildClientBundle } from '../../web-client/build.mjs'
import { stringify } from 'yaml'

const reactDir = process.argv[2]
if (!reactDir) throw Error('用法: node scripts/editor-ui-smoke/server.mjs <包含 react.js / react-dom.js 的 React 18 UMD 目录>')
// 显式依赖由测试者提供；不联网下载，不增加生产依赖。
const assets = new Map([
  ['/react.js', readFileSync(resolve(reactDir, 'react.js'))],
  ['/react-dom.js', readFileSync(resolve(reactDir, 'react-dom.js'))],
])
const outDir = mkdtempSync(join(tmpdir(), 'workflow-editor-ui-'))
assets.set('/client.js', readFileSync(buildClientBundle({ outDir })))
process.on('exit', () => rmSync(outDir, { recursive: true, force: true }))
const rpc = createEditorRpcHandler()
/* #179 启动弹窗夹具：受控目录源（ok/empty/error 三态）+ 真实 bundle 接线。
   弹窗经 `conversation.input.left` 注册捕获挂载，目录走只读 catalog RPC，
   命令走页面 `__runCommand` 受控桩（success/command-error/transport-fail/
   throw/hang），绝不建 Run、不碰真实 DSH home。模式经 POST /start-control
  （目录）与页面 `__execMode`（命令）分别控制。 */
let startCatalogMode = 'ok'
const startRpc = createEditorRpcHandler({ listCatalog: async () => {
  if (startCatalogMode === 'error') throw new Error('EACCES')
  if (startCatalogMode === 'empty') return { entries: [], diagnostics: [] }
  return {
    entries: [{ workflowId: 'demo' }, { workflowId: 'warned' }],
    diagnostics: [
      { workflowId: 'warned', path: '/iso/workflows/warned.yaml', reason: 'hand-written protocol keyword', severity: 'warning' },
      { workflowId: 'broken', path: '/iso/workflows/broken.yaml', reason: 'bad yaml: top must be mapping', severity: 'error' },
    ],
  }
}})
const startHtml = `<!doctype html><meta charset="utf-8"><title>Workflow start isolated test</title><style>body{margin:0;font:14px system-ui;background:#fff;color:#171717}#root{padding:24px}</style><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
window.__execMode='success';
window.__execCalls=[];
window.__hangQueue=[];
window.__runCommand=async (sid,line)=>{
  window.__execCalls.push({sessionId:sid,line});
  const mode=window.__execMode;
  if(mode==='hang') return new Promise((resolve)=>window.__hangQueue.push(resolve));
  if(mode==='command-error') return {ok:true,value:{commandId:'c1',result:{kind:'error',text:'start \\u5931\\u8d25\\uff1a\\u5df2\\u6709\\u6d3b\\u52a8 Run'}}};
  if(mode==='transport-fail') return {ok:false,error:{code:'session/gone',message:'session gone'}};
  if(mode==='throw') throw new Error('timeout');
  return {ok:true,value:{commandId:'c1',result:{kind:'success',text:'started'}}};
};
window.__resolveHang=(result)=>{const r=window.__hangQueue.shift();if(r)r(result??{ok:true,value:{commandId:'c1',result:{kind:'success',text:'started'}}})};
window.__sessionId='sess-1';
window.__session={sessionId:'sess-1',running:false,subagent:null,removed:false};
window.__input={phase:'plain'};
window.__workspaces={items:[{workspaceId:'w1',sessionIds:['sess-1','sess-2']}]};
window.__renderStart=(nextId)=>{
  if(nextId!==undefined){window.__sessionId=nextId;window.__session={...window.__session,sessionId:nextId}}
  window.__root.render(React.createElement(window.__startComponent,{
    sessionId:window.__sessionId,
    useSession:(sel)=>sel(window.__session),
    useInput:(sel)=>sel(window.__input),
    useWorkspaces:(sel)=>sel(window.__workspaces),
  }));
};
window.__setSessionState=(patch)=>{window.__session={...window.__session,...patch};window.__renderStart()};
window.__setInputPhase=(phase)=>{window.__input={phase};window.__renderStart()};
window.__ModuleLoader__={load:({factory})=>{const plugin=factory(name=>{if(name==='react')return React;throw Error(name)});const ctx={layout:{},connection:{rpc:{call:async(channel,endpoint,payload)=>{const r=await fetch('/start-rpc',{method:'POST',body:JSON.stringify({endpoint,payload})});return r.json()}}},remote:{commands:{execute:(sid,line)=>window.__runCommand(sid,line)}},slots:{inject:(name,fn)=>fn(),register:(spec,component)=>{if(spec.name==='conversation.input.left'){window.__startSpec=spec;window.__startComponent=component}return component}}};plugin.apply(ctx);window.__root=ReactDOM.createRoot(document.getElementById('root'));window.__renderStart()}};
</script><script src="/client.js"></script>`
const config = minimalConfigOf()
config.workflow.nodes.review = structuredClone(config.workflow.nodes.main)
config.workflow.nodes.main.results.done.target = { node: 'review' }
const html = `<!doctype html><meta charset="utf-8"><title>Workflow editor isolated test</title><style>body{margin:0;font:14px system-ui;background:#fff;color:#171717}#root{height:100vh}</style><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
window.files={'demo.yaml':${JSON.stringify(stringify(config))}};
const handle=name=>({kind:'file',name,getFile:async()=>new File([files[name]],name),createWritable:async()=>({write:async text=>{files[name]=text},close:async()=>{}})});
window.showDirectoryPicker=async()=>({name:'isolated-fixture',requestPermission:async()=> 'granted',queryPermission:async()=> 'granted',async *values(){for(const name of Object.keys(files))yield handle(name)},getFileHandle:async(name,opts)=>{if(!(name in files)){if(opts?.create)files[name]='';else throw new DOMException('Missing','NotFoundError')}return handle(name)}});
window.__ModuleLoader__={load:({factory})=>{const plugin=factory(name=>{if(name==='react')return React;throw Error(name)});const ctx={layout:{selectPanel:(id)=>{window.__selectedPanel=id}},remote:{session:{modelCatalog:async()=>({ok:true,value:{groups:[{id:'deepseek',name:'DeepSeek',models:[{id:'demo-model',name:'Demo model'}]}],failures:[]}})}},slots:{inject:(name,fn)=>fn(),register:(spec,component)=>{if(spec.name==='main')ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(component,spec.inject()))}},connection:{rpc:{call:async(channel,endpoint,payload)=>{const r=await fetch('/rpc',{method:'POST',body:JSON.stringify({endpoint,payload})});return r.json()}}}};plugin.apply(ctx)}};
</script><script src="/client.js"></script>`
const server = createServer(async(req,res)=>{
  try {
    if(req.url==='/start-rpc' && req.method==='POST') {
      let body=''
      for await(const chunk of req) {
        body+=chunk
        if(body.length>1024*1024) { res.writeHead(413).end(); return }
      }
      const {endpoint,payload}=JSON.parse(body)
      res.setHeader('Content-Type','application/json')
      res.end(JSON.stringify(await startRpc(endpoint,payload,new AbortController().signal)))
      return
    }
    if(req.url==='/start-control' && req.method==='POST') {
      let body=''
      for await(const chunk of req) {
        body+=chunk
        if(body.length>64*1024) { res.writeHead(413).end(); return }
      }
      const {mode}=JSON.parse(body)
      if(!['ok','empty','error'].includes(mode)) { res.writeHead(400).end('bad mode'); return }
      startCatalogMode=mode
      res.setHeader('Content-Type','application/json')
      res.end(JSON.stringify({ok:true,mode}))
      return
    }
    if(req.url==='/start') {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(startHtml);return}
    if(req.url==='/rpc' && req.method==='POST') {
      let body=''
      for await(const chunk of req) {
        body+=chunk
        if(body.length>1024*1024) { res.writeHead(413).end(); return }
      }
      const {endpoint,payload}=JSON.parse(body)
      res.setHeader('Content-Type','application/json')
      res.end(JSON.stringify(await rpc(endpoint,payload,new AbortController().signal)))
      return
    }
    if(req.url==='/') {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return}
    if(req.url==='/favicon.ico') {res.writeHead(204).end();return}
    if(!assets.has(req.url)) {res.writeHead(404).end();return}
    res.setHeader('Content-Type','text/javascript; charset=utf-8')
    res.end(assets.get(req.url))
  } catch(error) {res.statusCode=500;res.end(String(error))}
})
server.listen(43852,'127.0.0.1',()=>console.log('http://127.0.0.1:43852'))
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>process.exit(0)))

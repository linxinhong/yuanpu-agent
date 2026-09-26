/** Self-contained worker source so the same code works inside the SEA bundle. */
export const WORKFLOW_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
let next = 0;
const pending = new Map();
parentPort.on('message', message => {
  const pair = pending.get(message.id);
  if (!pair) return;
  pending.delete(message.id);
  message.error ? pair.reject(new Error(message.error)) : pair.resolve(message.value);
});
function call(kind, payload) {
  return new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'call', id, kind, payload });
  });
}
const context = vm.createContext({ bridge: call, argsJSON: JSON.stringify(workerData.args ?? null) }, { codeGeneration: { strings: false, wasm: false } });
const setup = new vm.Script(
  "const args = JSON.parse(argsJSON); delete globalThis.argsJSON;" +
  "const agent = (prompt, options = {}) => bridge('agent', { prompt, options });" +
  "const phase = title => bridge('phase', {title});" +
  "const log = message => bridge('log', {message: String(message)});" +
  "const checkpoint = (prompt) => bridge('checkpoint', {prompt: String(prompt)});" +
  "const parallel = thunks => Promise.all(thunks.map(fn => fn()));" +
  "const pipeline = async (items, ...stages) => { let values = items; for (const stage of stages) values = await parallel(values.map((v, i) => () => stage(v, i))); return values; };" +
  "const verify = async (item, options = {}) => { const count = Math.min(3, Math.max(1, options.reviewers ?? 2)); const votes = await parallel(Array.from({length:count}, () => async () => { const text = await agent('Independently verify this claim. Return only JSON {real:boolean,reason:string}. Claim: ' + JSON.stringify(item), {agentType:'reviewer'}); try { return JSON.parse(text); } catch { return {real:false,reason:'Invalid verdict'}; } })); const realCount = votes.filter(v => v.real === true).length; return {real:realCount/count >= (options.threshold ?? 1),realCount,total:count,votes}; };"
);
setup.runInContext(context, { timeout: 1000 });
(async () => {
  try {
    const script = workerData.script.replace(/export\s+const\s+meta\s*=/, 'const meta =');
    const value = await new vm.Script('(async () => {\n' + script + '\n})()', { filename: 'yuanpu-workflow.js' }).runInContext(context, { timeout: 1000 });
    parentPort.postMessage({ type: 'done', value });
  } catch (error) { parentPort.postMessage({ type: 'failed', error: error.message }); }
})();
`;

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import worker from '../src/index.js';

class Bucket {
  objects = new Map();
  async put(key, value, options = {}) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { key, size: bytes.length, uploaded: new Date(), ...options, body: bytes, text: async () => new TextDecoder().decode(bytes) });
  }
  async get(key) { return this.objects.get(key) || null; }
  async delete(key) { for (const k of Array.isArray(key) ? key : [key]) this.objects.delete(k); }
  async list({ prefix = '', delimiter } = {}) {
    const objects = [], folders = new Set();
    for (const [key, object] of this.objects) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (delimiter && rest.includes(delimiter)) folders.add(prefix + rest.split(delimiter)[0] + delimiter);
      else objects.push(object);
    }
    return { objects, delimitedPrefixes: [...folders], truncated: false };
  }
}
function setup() {
  const env = { AUTH_USER: 'test-admin', AUTH_PASSWORD: 'test-password-only', FILES: new Bucket(), ASSETS: { fetch: async () => new Response('static page') } };
  const call = (path, method = 'GET', body, token) => worker.fetch(new Request('https://example.workers.dev' + path, {
    method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {})
  }), env);
  return { env, call };
}
async function login(call) {
  const res = await call('/api/login', 'POST', { username: 'test-admin', password: 'test-password-only' });
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

test('static pages, preflight, missing credentials and unauthorized API', async () => {
  const {env, call} = setup();
  assert.equal(await (await call('/')).text(), 'static page');
  assert.equal((await call('/api/files', 'OPTIONS')).status, 204);
  assert.equal((await call('/api/files')).status, 401);
  delete env.AUTH_PASSWORD;
  assert.equal((await call('/api/guest', 'POST')).status, 503);
});

test('admin login and guest permissions', async () => {
  const {call} = setup();
  assert.equal((await call('/api/login', 'POST', {username:'test-admin', password:'wrong'})).status, 401);
  const admin = await login(call);
  assert.equal((await (await call('/api/me', 'GET', null, admin)).json()).role, 'admin');
  const guest = (await (await call('/api/guest', 'POST')).json()).token;
  assert.equal((await (await call('/api/me', 'GET', null, guest)).json()).role, 'guest');
  assert.equal((await call('/api/files', 'GET', null, guest)).status, 200);
  for (const path of ['/api/upload','/api/folder','/api/move','/api/move-folder','/api/rename-folder','/api/notes','/api/events','/api/dreams']) {
    assert.equal((await call(path, 'POST', {title:'forbidden'}, guest)).status, 403, path);
  }
  assert.equal((await call('/api/me', 'GET', null, admin + 'tampered')).status, 401);
  assert.equal((await call('/api/unknown', 'GET', null, admin)).status, 404);
});

test('R2 file upload, listing, download and password-confirmed deletion', async () => {
  const {call, env} = setup(); const token = await login(call);
  assert.equal((await call('/api/folder','POST',{name:'자료'},token)).status,200);
  const form = new FormData(); form.set('file', new File(['hello R2'], '메모.txt', {type:'text/plain'})); form.set('folder','자료');
  const uploaded = await (await call('/api/upload','POST',form,token)).json();
  assert.ok(env.FILES.objects.has(uploaded.key));
  const listed = await (await call('/api/files?prefix=' + encodeURIComponent('자료/'),'GET',null,token)).json();
  assert.equal(listed.files[0].name,'메모.txt');
  const download = await call('/api/download?key=' + encodeURIComponent(uploaded.key),'GET',null,token);
  assert.equal(await download.text(),'hello R2');
  assert.ok(download.headers.get('content-disposition').includes(encodeURIComponent('메모.txt')));
  const path='/api/file?key='+encodeURIComponent(uploaded.key);
  assert.equal((await call(path+'&password=wrong','DELETE',null,token)).status,403);
  assert.ok(env.FILES.objects.has(uploaded.key));
  assert.equal((await call(path+'&password=test-password-only','DELETE',null,token)).status,200);
  assert.equal(env.FILES.objects.has(uploaded.key),false);
});

test('notes, calendar events and dreams persist and support edits/deletion', async () => {
  const {call, env} = setup(); const token = await login(call);
  const items = [
    ['notes','note',{title:'메모',text:'본문',color:'blue'},'__notes__/'],
    ['events','event',{date:'2026-10-03',time:'09:00',title:'일정',text:'내용'},'__calendar__/'],
    ['dreams','dream',{date:'2026.10.03',title:'꿈',content:'기록',image:''},'__dreams__/']
  ];
  for (const [route,singular,body,prefix] of items) {
    const created = await call('/api/'+route,'POST',body,token);
    assert.equal(created.status,200,route);
    const record=(await created.json())[singular];
    assert.ok(env.FILES.objects.has(prefix+record.id+'.json'));
    const edited=await call('/api/'+route,'POST',{...body,id:record.id,title:'수정'},token);
    assert.equal(edited.status,200);
    const list=await (await call('/api/'+route,'GET',null,token)).json();
    assert.equal(list[route][0].title,'수정');
    assert.equal((await call('/api/'+route+'?id='+record.id,'DELETE',null,token)).status,200);
    assert.equal(env.FILES.objects.has(prefix+record.id+'.json'),false);
  }
});

test('frontend scripts parse and use the owner Worker only; no copied personal dream data', async () => {
  for (const page of ['index.html','work.html','hobby.html','dream.html']) {
    const html=await readFile(new URL('../'+page,import.meta.url),'utf8');
    for (const [,script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script,{filename:page});
    assert.ok(!html.includes('ikjoo123'));
    assert.ok(!html.includes('ju_files_'));
    assert.ok(!html.includes('익주'));
  }
  const config=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  assert.equal(config.r2_buckets[0].bucket_name,'ssaayy-files');
  assert.equal(config.assets.directory,'./public');
});

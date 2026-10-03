import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createHmac } from 'node:crypto';
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
  assert.equal((await call('/api/me')).status, 503);
});

test('owner login works and new/previous guest access is rejected', async () => {
  const {call, env} = setup();
  assert.equal((await call('/api/login', 'POST', {username:'test-admin', password:'wrong'})).status, 401);
  const admin = await login(call);
  assert.equal((await (await call('/api/me', 'GET', null, admin)).json()).role, 'admin');
  assert.equal((await call('/api/guest', 'POST')).status, 404);
  const payload = Buffer.from(JSON.stringify({user:'guest',role:'guest',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
  const guest = payload + '.' + createHmac('sha256',env.AUTH_PASSWORD).update(payload).digest('base64url');
  for (const path of ['/api/me','/api/files','/api/notes','/api/events','/api/dreams']) {
    assert.equal((await call(path, 'GET', null, guest)).status, 401, path);
  }
  for (const path of ['/api/upload','/api/folder','/api/move','/api/move-folder','/api/rename-folder','/api/notes','/api/events','/api/dreams']) {
    assert.equal((await call(path, 'POST', {title:'forbidden'}, guest)).status, 401, path);
  }
  assert.equal((await call('/api/files', 'GET', null, admin)).status, 200);
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
  for (const page of ['index.html','work.html']) {
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

test('entry opens work directly without a guest button or menu choice', async () => {
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  let target;
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script,{location:{replace: value => {target=value;}}});
  assert.equal(target,'work.html');
  assert.ok(!html.includes('guestButton'));
  assert.ok(!html.includes('hobby.html'));
});

test('folder creation and UI rename preserve nested file contents and metadata', async () => {
  const html = await readFile(new URL('../work.html', import.meta.url), 'utf8');
  const renameCode = html.slice(html.indexOf('async function renameFolder(source)'), html.indexOf('/*\n * DOWNLOAD', html.indexOf('async function renameFolder(source)')));
  for (const populated of [false, true]) {
    const { call, env } = setup(); const token = await login(call);
    assert.equal((await call('/api/folder', 'POST', { name: '새 폴더' }, token)).status, 200);
    if (populated) await env.FILES.put('새 폴더/하위/자료.txt', '내용 보존', { customMetadata: { originalName: '자료.txt' }, httpMetadata: { contentType: 'text/plain' } });
    const alerts = []; let reloads = 0;
    const context = vm.createContext({
      currentPrefix: '새 폴더/', prompt: () => '변경한 폴더', confirm: () => true,
      alert: message => alerts.push(message), loadFiles: async () => { reloads++; },
      apiFetch: async (path, options) => call(path, options.method, JSON.parse(options.body), token)
    });
    vm.runInContext(renameCode, context);
    await context.renameFolder('새 폴더/');
    assert.deepEqual(alerts, []);
    assert.equal(reloads, 1);
    assert.equal(context.currentPrefix, '변경한 폴더/');
    const list = await (await call('/api/files', 'GET', null, token)).json();
    assert.deepEqual(list.folders.map(f => f.name), ['변경한 폴더']);
    assert.ok(!env.FILES.objects.has('새 폴더/'));
    if (populated) {
      const moved = await env.FILES.get('변경한 폴더/하위/자료.txt');
      assert.equal(await moved.text(), '내용 보존');
      assert.equal(moved.customMetadata.originalName, '자료.txt');
      assert.equal(moved.httpMetadata.contentType, 'text/plain');
      assert.ok(!env.FILES.objects.has('새 폴더/하위/자료.txt'));
    }
  }
});

test('cached frontend source field remains compatible for renaming and moving folders', async () => {
  const { call, env } = setup(); const token = await login(call);
  await call('/api/folder', 'POST', { name: '원본' }, token);
  assert.equal((await call('/api/rename-folder', 'POST', { source: '원본/', newName: '수정' }, token)).status, 200);
  assert.equal((await call('/api/move-folder', 'POST', { source: '수정/', destinationFolder: '상위' }, token)).status, 200);
  assert.ok(env.FILES.objects.has('상위/수정/'));
  assert.ok(!env.FILES.objects.has('수정/'));
});

test('photo gallery lists the same R2 originals across folders and excludes internal records', async () => {
  const {call, env} = setup(); const token = await login(call);
  await env.FILES.put('사진/123-풍경.jpg', 'original bytes', {customMetadata:{originalName:'풍경.jpg'},httpMetadata:{contentType:'image/jpeg'}});
  await env.FILES.put('자료/이미지.png', 'second original');
  await env.FILES.put('자료/문서.pdf', 'document');
  await env.FILES.put('__dreams__/hidden.jpg', 'private record');
  assert.equal((await call('/api/photos')).status, 401);
  const photos = await (await call('/api/photos','GET',null,token)).json();
  assert.deepEqual(photos.photos.map(p=>p.name).sort(), ['이미지.png','풍경.jpg']);
  assert.equal(photos.cursor, null);
  const files = await (await call('/api/files?prefix='+encodeURIComponent('사진/'),'GET',null,token)).json();
  assert.equal(files.files[0].key, photos.photos.find(p=>p.name==='풍경.jpg').key);
  assert.equal(await (await env.FILES.get('사진/123-풍경.jpg')).text(), 'original bytes');
});

test('photo gallery carries R2 cursors even when a page contains no images', async () => {
  const {call, env} = setup(); const token=await login(call);
  let receivedCursor;
  env.FILES.list=async options => {
    receivedCursor=options.cursor;
    return {objects:[],truncated:!options.cursor,cursor:'r2-next-page'};
  };
  const first=await (await call('/api/photos','GET',null,token)).json();
  assert.equal(first.cursor,'r2-next-page');
  const second=await (await call('/api/photos?cursor='+first.cursor,'GET',null,token)).json();
  assert.equal(receivedCursor,'r2-next-page');
  assert.equal(second.cursor,null);
});

test('low-size download decodes the original, scales proportionally and exports JPG without uploading', async () => {
  const code=await readFile(new URL('../photos.js',import.meta.url),'utf8');
  const functions=code.slice(0,code.indexOf('let photoCursor'));
  let imageWidth=1200, imageHeight=800, drawSize, jpegOptions, downloaded, closed=0;
  const calls=[];
  const context=vm.createContext({
    Blob, URL, setTimeout: fn=>fn(), alert: message=>{throw new Error(message);},
    createImageBitmap: async()=>({width:imageWidth,height:imageHeight,close:()=>{closed++;}}),
    document:{createElement:()=>({
      getContext:()=>({fillRect:()=>{},drawImage:(_image,_x,_y,w,h)=>{drawSize=[w,h];}}),
      toBlob:(callback,type,quality)=>{jpegOptions=[type,quality];callback(new Blob(['reduced'],{type}));}
    })},
    apiFetch:async(path,options)=>{
      calls.push({path,options});return {ok:true,blob:async()=>new Blob(['original bytes'],{type:'image/jpeg'})};
    }
  });
  vm.runInContext(functions,context);
  context.savePhotoBlob=(blob,name)=>{downloaded={blob,name};};
  const button={disabled:false};
  await context.downloadSmallPhoto('사진/원본.jpg','원본.jpg',button);
  assert.deepEqual(drawSize,[500,333]);
  assert.deepEqual(jpegOptions,['image/jpeg',0.82]);
  assert.equal(downloaded.name,'원본_500px.jpg');
  assert.equal(downloaded.blob.type,'image/jpeg');
  assert.equal(button.disabled,false);
  assert.equal(closed,1);
  assert.equal(calls.length,1);
  assert.ok(calls[0].path.startsWith('/api/download?key='));
  assert.equal(calls[0].options,undefined);
  imageWidth=800;imageHeight=1200;
  await context.resizePhotoBlob(new Blob(['portrait']));assert.deepEqual(drawSize,[500,750]);
  imageWidth=320;imageHeight=240;
  await context.resizePhotoBlob(new Blob(['small']));assert.deepEqual(drawSize,[320,240]);
});

test('desktop tickets download one Unicode-named file and cannot authorize other operations', async () => {
  const {call, env} = setup(); const admin = await login(call);
  const key='자료/123-응급 사진.jpg';
  await env.FILES.put(key,'original picture',{customMetadata:{originalName:'응급 사진.jpg'}});
  assert.equal((await call('/api/download-links','POST',{keys:[key]})).status,401);
  const response=await call('/api/download-links','POST',{keys:[key]},admin);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const link=(await response.json()).links[0];
  assert.ok(link.expiresAt <= Date.now()+300000);
  const downloaded=await call(link.path);
  assert.equal(downloaded.status,200);
  assert.equal(await downloaded.text(),'original picture');
  const url=new URL('https://example.workers.dev'+link.path);
  const ticket=url.searchParams.get('ticket');
  url.searchParams.set('key','자료/another.jpg');
  assert.equal((await call(url.pathname+url.search)).status,401);
  assert.equal((await call('/api/files?ticket='+encodeURIComponent(ticket))).status,401);
  assert.equal((await call('/api/me','GET',null,ticket)).status,401);
  assert.equal((await call('/api/download-links','POST',{keys:[key]},ticket)).status,401);
  const expiredPayload=Buffer.from(JSON.stringify({kind:'file-download',key,exp:Math.floor(Date.now()/1000)-1})).toString('base64url');
  const expired=expiredPayload+'.'+createHmac('sha256',env.AUTH_PASSWORD).update(expiredPayload).digest('base64url');
  assert.equal((await call('/api/download?key='+encodeURIComponent(key)+'&ticket='+encodeURIComponent(expired))).status,401);
  assert.equal((await call('/api/download-links','POST',{keys:Array(31).fill(key)},admin)).status,400);
});

test('desktop drag preserves internal move data and adds DownloadURL with no admin token', async () => {
  const code=await readFile(new URL('../desktop-downloads.js',import.meta.url),'utf8');
  const context=vm.createContext({
    Map, Set, URL, Date, API:'https://example.workers.dev',getToken:()=> 'owner-login-token',
    document:{getElementById:()=>({addEventListener:()=>{}})},window:{addEventListener:()=>{}},
    apiFetch:async()=>({ok:true,json:async()=>({links:[{key:'写真.jpg',path:'/api/download?key=photo&ticket=scoped',expiresAt:Date.now()+300000}]})})
  });
  vm.runInContext(code,context);
  const file={key:'写真.jpg',name:'写真.jpg'};
  await context.prepareDesktopDownloads([file]);
  const data=new Map([['text/plain',file.key]]);
  const transfer={setData:(type,value)=>data.set(type,value)};
  assert.equal(context.addDesktopDownloadData(transfer,file),true);
  assert.equal(data.get('text/plain'),file.key);
  assert.ok(data.get('DownloadURL').includes('ticket=scoped'));
  assert.ok(!data.get('DownloadURL').includes('owner-login-token'));
  assert.equal(transfer.effectAllowed,'copyMove');
});

test('photo drop uploads only photos and preserves folder-relative paths', async () => {
  const code=await readFile(new URL('../photos.js',import.meta.url),'utf8');
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,{disabled:false,events:{},classList:{add:()=>{},remove:()=>{}},addEventListener(type,fn){this.events[type]=fn;}});
    return elements.get(id);
  };
  let uploaded, refreshed=0;const alerts=[];
  const context=vm.createContext({
    document:{getElementById:element},window:{addEventListener:()=>{}},
    alert:message=>alerts.push(message),
    uploadFiles:async(files,folder)=>{uploaded={files,folder};},
    collectDroppedEntry:async(_entry,_path,output)=>{
      output.push({file:{name:'풍경.jpg',type:'image/jpeg'},relativePath:'휴가/풍경.jpg'});
      output.push({file:{name:'설명.pdf',type:'application/pdf'},relativePath:'휴가/설명.pdf'});
    }
  });
  vm.runInContext(code,context);context.loadPhotos=async()=>{refreshed++;};
  await element('photoDropzone').events.drop.call(element('photoDropzone'),{
    preventDefault:()=>{},stopPropagation:()=>{},dataTransfer:{items:[{kind:'file',webkitGetAsEntry:()=>({isDirectory:true}),getAsFile:()=>null}],files:[]}
  });
  assert.equal(uploaded.folder,'사진');
  assert.equal(uploaded.files.length,1);
  assert.equal(uploaded.files[0].relativePath,'휴가/풍경.jpg');
  assert.equal(refreshed,1);
  assert.equal(alerts.length,1);
  assert.equal(element('photoUploadButton').disabled,false);
});

test('double-click on file name downloads that file', async () => {
  const html=await readFile(new URL('../work.html',import.meta.url),'utf8');
  const start=html.indexOf('      const fileName = row.querySelector');
  const code=html.slice(start,html.indexOf('      row.querySelector(".fileIcon")',start));
  const handlers={};let downloaded,stopped=false;
  const name={addEventListener:(type,fn)=>handlers[type]=fn};
  vm.runInNewContext(code,{row:{querySelector:()=>name,addEventListener:()=>{}},file:{key:'my-file'},downloadFile:key=>{downloaded=key;},prepareDesktopDownloads:()=>{}});
  handlers.dblclick({stopPropagation:()=>{stopped=true;}});
  assert.equal(downloaded,'my-file');assert.equal(stopped,true);
});

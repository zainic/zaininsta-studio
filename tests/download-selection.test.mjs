import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=(await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\ninit\(\);\s*$/,'');
function dashboard({confirmResult=true,fetchImpl}={}) {
  const elements=new Map(), calls=[], confirmations=[];
  function element(selector) {
    if(!elements.has(selector)) elements.set(selector,{
      innerHTML:'',textContent:'',disabled:false,checked:false,indeterminate:false,listeners:{},
      classList:{toggle(){},remove(){},add(){}},
      addEventListener(type,handler){this.listeners[type]=handler;}
    });
    return elements.get(selector);
  }
  const context=vm.createContext({
    document:{querySelector:element,querySelectorAll:()=>[],addEventListener(){}},
    confirm:message=>{confirmations.push(message);return confirmResult;},
    fetch:async(url,options)=>{calls.push({url,method:options.method});return fetchImpl(url,options);},
    setTimeout:()=>1,clearTimeout(){}
  });
  vm.runInContext(source+'\nglobalThis.downloadUI={state,renderDownloads,clearSelectedDownloads,bindEvents};',context);
  return {...context.downloadUI,element,calls,confirmations};
}
const row=(id,status)=>({id,status,sourceUrl:'https://www.instagram.com/reel/'+id+'/',createdAt:'2026-11-15T00:00:00Z'});

test('download selection survives refresh, excludes active jobs, and supports select all', () => {
  const ui=dashboard();
  ui.state.downloads=[row('ready','ready'),row('failed','failed'),row('active','downloading')];
  for(const id of ['ready','active','gone']) ui.state.selectedDownloads.add(id);
  ui.renderDownloads();
  assert.deepEqual([...ui.state.selectedDownloads],['ready']);
  assert.equal(ui.element('#clear-downloads').disabled,false);
  assert.equal(ui.element('#select-all-downloads').indeterminate,true);
  assert.match(ui.element('#downloads-list').innerHTML,/data-select-download="active"[^>]*disabled/);
  ui.renderDownloads();
  assert.deepEqual([...ui.state.selectedDownloads],['ready']);
  ui.bindEvents();
  ui.element('#downloads-list').listeners.change({target:{id:'select-all-downloads',checked:true}});
  assert.deepEqual([...ui.state.selectedDownloads],['ready','failed']);
  assert.equal(ui.element('#select-all-downloads').checked,true);
  assert.equal(ui.element('#downloads-selection-count').textContent,'2 selected');
  ui.element('#downloads-list').listeners.change({target:{id:'select-all-downloads',checked:false}});
  assert.equal(ui.element('#clear-downloads').disabled,true);
});

test('canceling clear preserves selection and sends no delete requests', async () => {
  const ui=dashboard({confirmResult:false});
  ui.state.downloads=[row('saved','ready')];
  ui.state.selectedDownloads.add('saved');
  await ui.clearSelectedDownloads();
  assert.equal(ui.calls.length,0);
  assert.equal(ui.state.downloads.length,1);
  assert.equal(ui.state.selectedDownloads.has('saved'),true);
  assert.match(ui.confirmations[0],/permanently deleted/);
});

test('clear selected deletes each selected finished download and updates the list', async () => {
  const rows=[row('one','ready'),row('two','failed'),row('active','downloading')];
  const ui=dashboard({fetchImpl:async(url,options)=>{
    assert.equal(ui.state.clearingDownloads,true);
    assert.equal(ui.element('#clear-downloads').disabled,true);
    if(options.method==='DELETE') {
      const index=rows.findIndex(row=>url.endsWith('/'+row.id));
      assert.notEqual(index,-1);
      rows.splice(index,1);
      return {ok:true,json:async()=>({ok:true})};
    }
    return {ok:true,json:async()=>({downloads:rows})};
  }});
  ui.state.downloads=[...rows];
  for(const id of ['one','two','active']) ui.state.selectedDownloads.add(id);
  await ui.clearSelectedDownloads();
  assert.deepEqual(ui.calls.map(call=>call.method),['DELETE','DELETE','GET']);
  assert.deepEqual(ui.state.downloads.map(row=>row.id),['active']);
  assert.equal(ui.state.selectedDownloads.size,0);
  assert.equal(ui.state.clearingDownloads,false);
  assert.equal(ui.element('#clear-downloads').disabled,true);
  assert.equal(ui.element('#toast').textContent,'2 downloads cleared.');
});

test('partial clear failures remain selected for retry and report an accurate count', async () => {
  const ui=dashboard({fetchImpl:async(url,options)=>{
    if(options.method==='DELETE') {
      const failed=url.endsWith('/locked');
      return {ok:!failed,status:failed?503:200,json:async()=>failed?{error:'Could not delete the saved files.'}:{ok:true}};
    }
    return {ok:true,json:async()=>({downloads:[row('locked','ready')]})};
  }});
  ui.state.downloads=[row('deleted','ready'),row('locked','ready')];
  ui.state.selectedDownloads.add('deleted');ui.state.selectedDownloads.add('locked');
  await ui.clearSelectedDownloads();
  assert.deepEqual([...ui.state.selectedDownloads],['locked']);
  assert.equal(ui.state.clearingDownloads,false);
  assert.equal(ui.element('#clear-downloads').disabled,false);
  assert.match(ui.element('#toast').textContent,/1 download cleared\. Could not clear 1: Could not delete/);
});

const fs=require('fs'), vm=require('vm');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
class CL { constructor(){this.s=new Set()} add(v){this.s.add(v)} remove(v){this.s.delete(v)} contains(v){return this.s.has(v)} toggle(v,force){const on=force===undefined?!this.s.has(v):force;on?this.s.add(v):this.s.delete(v);return on} }
class E { constructor(id='',attrs={}){this.id=id;this.attrs=attrs;this.value=attrs.value||'';this.checked=attrs.checked!==undefined;this.inner='';this.textContent='';this.className=attrs.class||'';this.classList=new CL();(this.className||'').split(/\s+/).filter(Boolean).forEach(x=>this.classList.add(x));this.dataset={};if(attrs['data-tab'])this.dataset.tab=attrs['data-tab'];this.listeners={};this.style={};this.options=[];this.disabled=false;this.children=[];this.files=[];this.hidden=false;this._innerHTML='';}
 addEventListener(n,fn){(this.listeners[n]??=[]).push(fn)} querySelector(sel){if(sel==='tbody')return this.children.find(x=>x.tag==='tbody')||new E(this.id+'-tbody');return new E(this.id+sel)} querySelectorAll(){return []} appendChild(e){this.children.push(e);return e} remove(){} click(){} scrollIntoView(){} setAttribute(k,v){this.attrs[k]=v} get innerHTML(){return this._innerHTML} set innerHTML(s){this._innerHTML=s;if(this.tag==='select'||this.id==='incentiveGrader'){const opts=[...String(s).matchAll(/<option value="([^"]*)"[^>]*>(.*?)<\/option>/g)];this.options=opts.map(o=>({value:o[1],text:o[2]}));if(this.options.length&&!this.options.some(o=>o.value===this.value))this.value=this.options[0].value;}}
}
const ids=new Map();
for(const m of html.matchAll(/<([a-zA-Z0-9-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){
  const tag=m[1], at=m[2], id=m[3], attrs={};
  for(const a of at.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]]=a[2];
  if(/\bchecked\b/.test(at)) attrs.checked='checked';
  const e=new E(id,attrs); e.tag=tag; ids.set(id,e);
}
// Populate select defaults using selected option in the authored HTML.
for(const [id,e] of ids){if(e.tag==='select'){
 const outer=html.match(new RegExp(`<select\\b[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/select>`));
 if(outer){const opts=[...outer[1].matchAll(/<option([^>]*)value="([^"]+)"[^>]*>(.*?)<\/option>/g)];e.options=opts.map(o=>({value:o[2],text:o[3]}));const selected=opts.find(o=>/\bselected\b/.test(o[1]));e.value=selected?selected[2]:(e.options[0]?.value||'');}
}}
for(const [tableId,bodyId] of [['peopleTable','peopleBody'],['reportPreviewTable','reportBody'],['estimatesTable','estBody']]) {const table=ids.get(tableId);const body=new E(bodyId);body.tag='tbody';table.children.push(body);}
const tabs=[];for(const m of html.matchAll(/<button\b([^>]*class="[^"]*\btab\b[^"]*"[^>]*data-tab="([^"]+)"[^>]*)>/g)){const e=new E('',{});e.tag='button';e.dataset.tab=m[2];e.classList.add('tab');tabs.push(e)}
const panels=[];for(const [id,e] of ids)if(id.startsWith('panel-')){e.id=id;panels.push(e)}
const document={getElementById(id){return ids.get(id)||(ids.set(id,new E(id)),ids.get(id))},querySelectorAll(sel){if(sel==='.tab')return tabs;if(sel==='.tab-panel')return panels;return []},createElement(tag){const e=new E();e.tag=tag;return e},body:new E('body')};
const window={setTimeout(){return 1}};
const URL={createObjectURL(){return 'blob:mock'},revokeObjectURL(){}};
const ctx={document,window,URL,console,Blob:class Blob{},Math,Date,Map,Set,Array,Number,String,Boolean,JSON,parseInt,Error,Infinity};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname+'/../app.js','utf8'),ctx,{timeout:10000});
for(const id of ['metricPeqa','metricBaseline','metricBias','metricCoverage','healthList','assignmentSummary','footerSeed']) console.log(id, String(ids.get(id).textContent||ids.get(id).innerHTML).slice(0,200));
if(ids.get('metricPeqa').textContent==='—') throw Error('app failed to render metrics');
if(!ids.get('healthList').innerHTML.includes('Passed')) throw Error('health checks not rendered');
if(!ids.get('assignmentSummary').textContent.includes('96 assignments')) throw Error('assignment did not render');
const initialMetric=ids.get('metricPeqa').textContent;
ids.get('runButton').listeners.click[0]();
if(ids.get('metricPeqa').textContent!==initialMetric) throw Error('same seed not reproducible');
ids.get('runIncentiveButton').listeners.click[0]();
if(!ids.get('incentiveChart').innerHTML.includes('<svg')) throw Error('incentive curve not rendered');
console.log('PASS UI bootstrap, deterministic rerun, incentive sweep mock');

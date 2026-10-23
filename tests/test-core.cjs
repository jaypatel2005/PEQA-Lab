const fs=require('fs');
const source=fs.readFileSync(__dirname+'/../app.js','utf8');
const start=source.indexOf('  const DEFAULTS =');
const end=source.indexOf('  function markResultsStale()');
const core=source.slice(start,end)+`\nmodule.exports={DEFAULTS,makeRng,validateConfig,constructExperiment,evaluateScenario,createAssignment,chooseProbes,scoreMetrics,createNoiseMatrix};`;
const mod={exports:{}};
new Function('module', core)(mod);
const {DEFAULTS,makeRng,validateConfig,constructExperiment,createAssignment,createNoiseMatrix}=mod.exports;
function row(i){return {id:i,score:'',probe:'auto',bias:'',tau:''}}
for (const n of [12,24,60,100]) {
  for (const K of [4,6,8]) {
    const q=K/2, min=q+1, max=Math.floor(n/(q+1));
    if(max<min) continue;
    for (const probes of [min,Math.max(min,Math.min(max,Math.floor((min+max)/2))),max]) {
      const c={...DEFAULTS,n,K,probes,seed:n*100+K*10+probes};
      const res=constructExperiment(c,Array.from({length:n},(_,i)=>row(i+1)));
      if (!Object.values(res.data.assignmentChecks).every(Boolean)) throw Error('bad checks');
      if (res.data.assignmentsByGrader.some((a,i)=>a.length!==K||a.includes(i))) throw Error('bad grader assignments');
      const np=res.data.nonprobes.map(p=>res.data.gradersByPaper[p].length);
      if(np.some(load=>load<q||load>q+1)) throw Error('bad paper loads');
      console.log('PASS', {n,K,probes,peqaRMSE:res.metrics.PEQA.rmse.toFixed(3),grades:res.data.assignmentsByGrader.reduce((s,a)=>s+a.length,0)});
    }
  }
}
// Hybrid override and incentive sweep diagnostics.
const c={...DEFAULTS,n:24,K:4,probes:6,seed:42,mu:70,gamma:.04,scoreMin:0,scoreMax:100,clampReports:false,biasMax:8,biasDistribution:'uniform',tauMin:.02,tauMax:1.5,alpha:1,competitiveWeight:.02};
const rows=Array.from({length:24},(_,i)=>row(i+1));
rows[0]={...rows[0],score:'88',probe:'probe',bias:'3.5',tau:'1.2'};
rows[1]={...rows[1],score:'74',probe:'auto',bias:'-4.0',tau:'0.55'};
rows[2]={...rows[2],score:'62',probe:'nonprobe',bias:'5.5',tau:'0.28'};
rows[4]={...rows[4],score:'56',probe:'probe',bias:'-2.5'};
const hybrid=constructExperiment(c,rows);
if(!hybrid.data.probeSet.has(0)||!hybrid.data.probeSet.has(4)||hybrid.data.probeSet.has(2)) throw Error('probe override mismatch');
if(hybrid.data.people[0].trueScore!==88||hybrid.data.people[0].bias!==3.5||hybrid.data.people[0].tau!==1.2) throw Error('manual override mismatch');
console.log('PASS hybrid overrides', {probes:[...hybrid.data.probeSet].map(i=>i+1),biasHat:hybrid.estimates[0].bHat.toFixed(3),utility:hybrid.utilities[0].toFixed(3)});
const rng=makeRng(777);
const z=createNoiseMatrix(hybrid.data,rng);
for(const tau of [.02,.1,.5,1.5]){
 const ev=mod.exports.evaluateScenario(c,hybrid.data,z,0,tau);
 if(!Number.isFinite(ev.utilities[0])||!ev.estimates.every(e=>Number.isFinite(e.bHat)&&Number.isFinite(e.tauHat))) throw Error('non-finite incentive run');
 console.log('PASS utility eval',tau,ev.utilities[0].toFixed(3));
}

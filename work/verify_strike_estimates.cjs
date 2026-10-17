const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const ROOT=path.resolve(__dirname,'..');
const names=['pelvis','left_hip','right_hip','spine1','left_knee','right_knee','spine2','left_ankle','right_ankle','spine3','left_foot','right_foot','neck','left_collar','right_collar','head','left_shoulder','right_shoulder','left_elbow','right_elbow','left_wrist','right_wrist'];
const index=Object.fromEntries(names.map((name,i)=>[name,i]));
const body={pelvis:[0,.9,0],left_hip:[0,.85,-.1],right_hip:[0,.85,.1],spine1:[0,1.03,0],spine2:[0,1.17,0],spine3:[0,1.3,0],neck:[0,1.43,0],head:[0,1.58,0],
  left_collar:[0,1.35,-.08],right_collar:[0,1.35,.08],left_shoulder:[0,1.35,-.16],right_shoulder:[0,1.35,.16],left_elbow:[0,1.1,-.28],right_elbow:[0,1.1,.28],left_wrist:[0,.87,-.31],right_wrist:[0,.87,.31],
  left_knee:[0,.5,-.1],right_knee:[0,.5,.1],left_ankle:[0,.1,-.1],right_ankle:[0,.1,.1],left_foot:[.1,.04,-.1],right_foot:[.1,.04,.1]};
const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
function makeMotion({kind='approach',overlap=false,start=14,travelFrames=11,count=65,targetMoves=false}={}){
  const frames=Array.from({length:count},(_,frame)=>{
    const striker={id:1,xyz:names.map(name=>body[name].map((v,i)=>v+(i===0?-1.1:0))),sourceTrackPresent:true,sourceBoxInterpolated:false,overlappingSourceBoxes:overlap?[2]:[]};
    const target={id:2,xyz:names.map(name=>[...body[name]]),sourceTrackPresent:true,sourceBoxInterpolated:false,overlappingSourceBoxes:overlap?[1]:[]};
    let x=-.9;
    const fraction=Math.max(0,Math.min(1,(frame-start)/travelFrames));
    if(kind==='approach')x=frame<=start+travelFrames?-.9+.79*fraction:-.11-.79*Math.max(0,Math.min(1,(frame-start-travelFrames)/travelFrames));
    if(kind==='static')x=-.14;
    if(kind==='recede')x=-.11-.79*Math.min(1,frame/20);
    if(kind==='jitter')x=-.14+Math.sin(frame*2.1)*.014;
    if(kind==='spike')x=frame===25?-.11:-.9;
    striker.xyz[index.left_wrist]=[x,1.28,0];
    if(targetMoves){
      // Both bodies walk together while the hand remains held relative to its pelvis.
      const move=frame<=25?.5*(frame/25):.5*Math.max(0,1-(frame-25)/25);
      striker.xyz=striker.xyz.map(point=>point.map((v,i)=>v+(i===0?move:0)));
      target.xyz=target.xyz.map(point=>point.map((v,i)=>v+(i===0?move:0)));
    }
    return {frame,people:[striker,target]};
  });
  return {fps:30,sourceStart:0,sourceEnd:count/30,scaleVerified:false,units:'model-meters',jointNames:names,people:[{id:1,name:'Mover'},{id:2,name:'Receiver'}],frames};
}

(async()=>{
  const {detectMotionStrikes,estimateStrikes}=await import(pathToFileURL(path.join(ROOT,'teaching_suite/public/strike-estimates.mjs')));
  const checks=[];
  function check(name,fn){fn();checks.push(name);}
  let event;
  check('An active hand approach produces one near-chest candidate at closest approach',()=>{
    const events=detectMotionStrikes(makeMotion());assert.equal(events.length,1);[event]=events;
    assert.equal(event.strikerId,'1');assert.equal(event.targetId,'2');assert.equal(event.limb,'left_wrist');
    assert.equal(event.region,'Chest');assert.ok(Math.abs(event.frame-25)<=1);
    assert.ok(event.startFrame<event.frame&&event.endFrame>event.frame);assert.equal(event.kind,'motion-estimate');
    assert.ok(event.speedMps>1&&event.closingSpeedMps>1);assert.ok(event.confidence>0&&event.confidence<.8);
  });
  check('Capsule surface anchor follows the captured target segment',()=>{
    const motion=makeMotion(),pose=motion.frames[event.frame].people[1].xyz;
    const [a,b]=event.targetSegment.map(name=>pose[index[name]]);
    const anchor=a.map((v,i)=>v+(b[i]-v)*event.targetFraction+event.surfaceOffset[i]);
    assert.ok(distance(anchor,event.point)<1e-10);
    assert.ok(Math.abs(Math.hypot(...event.surfaceOffset)-event.targetRadius)<1e-10);
    assert.ok(distance(pose[index[event.targetJoint]].map((v,i)=>v+event.offset[i]),event.point)<1e-10);
  });
  for(const kind of ['static','recede','jitter','spike'])check(`Reject ${kind} near-contact motion`,()=>assert.deepEqual(detectMotionStrikes(makeMotion({kind})),[]));
  check('Held hand while bodies walk does not become a strike',()=>{
    const motion=makeMotion({kind:'static',targetMoves:true});assert.deepEqual(detectMotionStrikes(motion),[]);
  });
  check('Interpolated tracking boxes are excluded, including their derivative window',()=>{
    const motion=makeMotion();motion.frames[23].people[0].sourceBoxInterpolated=true;
    assert.deepEqual(detectMotionStrikes(motion),[]);
  });
  check('A missing target frame cannot be bridged into a contact',()=>{
    const motion=makeMotion();motion.frames[25].people.splice(1,1);assert.deepEqual(detectMotionStrikes(motion),[]);
  });
  check('Non-finite joints are excluded without emitting corrupt events',()=>{
    const motion=makeMotion();motion.frames[24].people[1].xyz[index.head][0]=NaN;
    assert.deepEqual(detectMotionStrikes(motion),[]);
  });
  check('Explicit invalid or source-track-missing status is excluded',()=>{
    for(const key of ['valid','poseValid','sourceTrackPresent']){
      const motion=makeMotion();motion.frames[24].people[0][key]=false;assert.deepEqual(detectMotionStrikes(motion),[]);
    }
    const motion=makeMotion();motion.frames[24].people[0].status=['invalid_pose'];assert.deepEqual(detectMotionStrikes(motion),[]);
  });
  check('Overlapping footage lowers confidence and explains uncertainty',()=>{
    const [overlap]=detectMotionStrikes(makeMotion({overlap:true}));assert.ok(overlap);
    assert.ok(overlap.confidence<event.confidence&&overlap.confidence<=.55);
    assert.match(overlap.uncertainty,/Overlapping/);assert.match(overlap.intensityBasis,/not measured force/);
    assert.equal(overlap.scaleVerified,false);
  });
  check('The relative intensity index rises with approach speed, without inventing force',()=>{
    const [slow]=detectMotionStrikes(makeMotion({travelFrames:19}));
    const [fast]=detectMotionStrikes(makeMotion({travelFrames:7}));assert.ok(slow&&fast);
    assert.ok(slow.closingSpeedMps<fast.closingSpeedMps);assert.ok(slow.intensity<fast.intensity);
    for(const candidate of [slow,fast]){assert.ok(Number.isInteger(candidate.intensity)&&candidate.intensity>=1&&candidate.intensity<=5);assert.ok(!('force' in candidate));}
  });
  check('Results are deterministic, independent of scrub order, and leave captured motion untouched',()=>{
    const motion=makeMotion(),before=JSON.stringify(motion),first=detectMotionStrikes(motion);
    assert.deepEqual(detectMotionStrikes(motion),first);assert.equal(JSON.stringify(motion),before);
    assert.equal(estimateStrikes,detectMotionStrikes);
  });
  check('Missing prerequisites return no invented estimates',()=>{
    for(const value of [null,{},makeMotion({count:3}),{...makeMotion(),fps:0},{...makeMotion(),jointNames:[]}])assert.deepEqual(detectMotionStrikes(value),[]);
  });
  const clipPath=path.join(ROOT,'outputs/3d-pilot/scene.json');
  let clipReport;
  if(fs.existsSync(clipPath))check('Prepared clip has finite, conservative, distinct candidates away from tracking gaps',()=>{
    const clip=JSON.parse(fs.readFileSync(clipPath,'utf8')),events=detectMotionStrikes(clip);
    assert.ok(events.length>=3&&events.length<=40);assert.equal(new Set(events.map(item=>item.id)).size,events.length);
    assert.ok(events.some(item=>['Chest','Lower torso','Head'].includes(item.region)));
    for(const item of events){
      assert.ok(item.point.every(Number.isFinite)&&item.offset.every(Number.isFinite));
      assert.ok(item.frame>=0&&item.frame<clip.frames.length&&item.speedMps<8&&item.confidence<=.77);
      for(let frame=item.frame-7;frame<=item.frame+5;frame++)for(const id of [item.strikerId,item.targetId]){
        const person=clip.frames[frame]?.people.find(person=>String(person.id)===id);
        assert.ok(person&&!person.sourceBoxInterpolated&&person.sourceTrackPresent!==false);
      }
      assert.ok(!events.some(other=>other!==item&&item.strikerId===other.targetId&&item.targetId===other.strikerId&&Math.abs(item.frame-other.frame)<clip.fps*.16));
    }
    clipReport={count:events.length,events:events.map(({frame,strikerId,limb,targetId,region,intensity,confidence})=>({frame,strikerId,limb,targetId,region,intensity,confidence}))};
  });
  console.log(JSON.stringify({ok:true,checks:checks.length,passed:checks,clip:clipReport},null,2));
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});

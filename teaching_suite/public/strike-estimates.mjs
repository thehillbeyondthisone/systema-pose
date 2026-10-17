// Motion candidates are geometric teaching aids, never confirmed impacts or force measurements.
import {closestSegmentPoints} from './contact_geometry.mjs';

const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const mul=(a,s)=>a.map(v=>v*s);
const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
const norm=a=>Math.hypot(...a);
const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const finitePoint=p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite);
const LIMBS=['left_wrist','right_wrist','left_foot','right_foot'];
const LIMB_LABELS={left_wrist:'Left hand',right_wrist:'Right hand',left_foot:'Left foot',right_foot:'Right foot'};
const REGIONS=[
  ['pelvis','spine2','Lower torso',.14,'spine1'],
  ['spine2','neck','Chest',.145,'spine3'],
  ['neck','head','Head',.105,'head'],
  ['left_shoulder','left_elbow','Left upper arm',.05,'left_elbow'],
  ['right_shoulder','right_elbow','Right upper arm',.05,'right_elbow'],
  ['left_elbow','left_wrist','Left forearm',.043,'left_elbow'],
  ['right_elbow','right_wrist','Right forearm',.043,'right_elbow'],
  ['left_hip','left_knee','Left thigh',.075,'left_knee'],
  ['right_hip','right_knee','Right thigh',.075,'right_knee'],
  ['left_knee','left_ankle','Left shin',.055,'left_knee'],
  ['right_knee','right_ankle','Right shin',.055,'right_knee']
];

function personValid(person,jointCount){
  if(!person||person.sourceBoxInterpolated||person.interpolated||person.sourceTrackPresent===false||
    person.valid===false||person.poseValid===false||!Array.isArray(person.xyz)||person.xyz.length<jointCount)return false;
  if(Array.isArray(person.status)&&person.status.some(value=>/invalid|missing|interpolat|gap/i.test(value)))return false;
  return person.xyz.every(finitePoint);
}

function smoothTrack(frames,id,jointCount){
  const track=frames.map(frame=>frame.people?.find(person=>String(person.id)===id));
  const valid=track.map(person=>personValid(person,jointCount));
  const smooth=track.map((person,frame)=>{
    if(!valid[frame])return null;
    const result=person.xyz.map(()=>[0,0,0]);let total=0;
    for(let delta=-2;delta<=2;delta++){
      const index=frame+delta;if(index<0||index>=track.length||!valid[index])return null;
      const weight=3-Math.abs(delta);total+=weight;
      track[index].xyz.forEach((point,joint)=>point.forEach((value,axis)=>result[joint][axis]+=value*weight));
    }
    return result.map(point=>mul(point,1/total));
  });
  return {track,valid,smooth};
}

function capsuleAt(point,pose,region,scale,limbRadius){
  const a=pose[region.a],b=pose[region.b];
  const closest=closestSegmentPoints(point,point,a,b);
  const delta=sub(b,a),denominator=dot(delta,delta);
  const fraction=denominator>1e-12?clamp(dot(sub(closest.pointB,a),delta)/denominator,0,1):0;
  const distance=Math.sqrt(closest.distanceSquared),radius=region.radius*scale;
  const normal=distance>1e-8?mul(sub(point,closest.pointB),1/distance):[0,1,0];
  return {region,fraction,distance,radius,gap:distance-radius-limbRadius,
    axisPoint:closest.pointB,point:add(closest.pointB,mul(normal,radius)),normal};
}

/**
 * Find deterministic local minima where a hand/foot actively approaches a body capsule.
 * Units follow the reconstruction: speedMps is an estimated scene-metres/second value.
 * confidence is a heuristic ranking, not a calibrated probability. intensity is a 1–5
 * relative motion proxy; no body mass, force, impact, or injury severity is inferred.
 * Missing/interpolated pose windows, discontinuous jumps, and static proximity are rejected.
 */
export function detectMotionStrikes(motion,options={}){
  if(!motion||!Array.isArray(motion.frames)||!Array.isArray(motion.jointNames)||
    !Number.isFinite(motion.fps)||motion.fps<=0||motion.fps>240)return [];
  const {frames,jointNames,fps}=motion,index=Object.fromEntries(jointNames.map((name,i)=>[name,i]));
  if(index.pelvis===undefined)return [];
  const people=[...new Set(frames.flatMap(frame=>(frame.people||[]).map(person=>String(person.id))))].sort();
  const tracks=new Map(people.map(id=>[id,smoothTrack(frames,id,jointNames.length)]));
  const regions=REGIONS.filter(([a,b,, ,joint])=>index[a]!==undefined&&index[b]!==undefined&&index[joint]!==undefined)
    .map(([a,b,name,radius,joint])=>({a:index[a],b:index[b],names:[a,b],name,radius,joint,jointIndex:index[joint]}));
  const limbs=LIMBS.filter(name=>index[name]!==undefined);
  const back=Math.max(3,Math.round(fps*.16)),ahead=Math.max(2,Math.round(fps*.1));
  const minClosingSpeed=Number.isFinite(options.minClosingSpeed)?Math.max(.2,options.minClosingSpeed):.42;
  const candidates=[];
  for(const strikerId of people)for(const targetId of people){
    if(strikerId===targetId)continue;
    const striker=tracks.get(strikerId),target=tracks.get(targetId);
    for(const limb of limbs){
      const limbIndex=index[limb],limbRadius=limb.endsWith('foot') ? .065 : .045;
      const samples=frames.map((_,frame)=>{
        const a=striker.smooth[frame],b=target.smooth[frame];if(!a||!b)return null;
        const shoulder=index.left_shoulder!==undefined&&index.right_shoulder!==undefined?
          norm(sub(b[index.left_shoulder],b[index.right_shoulder])):.32;
        const scale=clamp(shoulder/.32,.75,1.25);
        let closest=null;
        for(const region of regions){const capsule=capsuleAt(a[limbIndex],b,region,scale,limbRadius);
          if(!closest||capsule.gap<closest.gap)closest=capsule;}
        return closest?{...closest,scale}:null;
      });
      for(let frame=back+2;frame<frames.length-ahead-2;frame++){
        const hit=samples[frame];if(!hit||hit.gap>.075||hit.gap<-.24)continue;
        // Compare neighboring distance minima; equal plateaus select their first frame.
        let valid=true;
        for(let f=frame-back;f<=frame+ahead;f++){
          if(!samples[f]||!striker.valid[f]||!target.valid[f]){valid=false;break;}
          if(f>=frame-ahead&&f!==frame&&(samples[f].gap<hit.gap-1e-5||f<frame&&Math.abs(samples[f].gap-hit.gap)<=1e-5)){valid=false;break;}
        }
        if(!valid)continue;
        const earlier=frame-back,elapsed=back/fps;
        const prior=capsuleAt(striker.smooth[earlier][limbIndex],target.smooth[earlier],hit.region,hit.scale,limbRadius);
        const closure=prior.gap-hit.gap,closingSpeed=closure/elapsed;
        if(closure<.075||closingSpeed<minClosingSpeed)continue;
        const relativeNow=sub(striker.smooth[frame][limbIndex],mix(target.smooth[frame][hit.region.a],target.smooth[frame][hit.region.b],hit.fraction));
        const relativeBefore=sub(striker.smooth[earlier][limbIndex],mix(target.smooth[earlier][hit.region.a],target.smooth[earlier][hit.region.b],hit.fraction));
        const speedMps=norm(sub(relativeNow,relativeBefore))/elapsed;
        const localNow=sub(striker.smooth[frame][limbIndex],striker.smooth[frame][index.pelvis]);
        const localBefore=sub(striker.smooth[earlier][limbIndex],striker.smooth[earlier][index.pelvis]);
        const activeTravel=norm(sub(localNow,localBefore));
        // Someone walking past a held hand, or an inactive foot, is not an active strike candidate.
        if(activeTravel<.045||speedMps>8||closingSpeed/speedMps<.32)continue;
        let approachingSteps=0,rawTravel=0;
        for(let f=earlier+1;f<=frame;f++){
          const previous=capsuleAt(striker.smooth[f-1][limbIndex],target.smooth[f-1],hit.region,hit.scale,limbRadius);
          const current=capsuleAt(striker.smooth[f][limbIndex],target.smooth[f],hit.region,hit.scale,limbRadius);
          if(previous.gap-current.gap>.002)approachingSteps++;
          const limbStep=norm(sub(striker.track[f].xyz[limbIndex],striker.track[f-1].xyz[limbIndex]));
          const rootStep=norm(sub(striker.track[f].xyz[index.pelvis],striker.track[f-1].xyz[index.pelvis]));
          const targetStep=norm(sub(target.track[f].xyz[index.pelvis],target.track[f-1].xyz[index.pelvis]));
          rawTravel+=limbStep;
          if(limbStep*fps>10||rootStep*fps>7||targetStep*fps>7){valid=false;break;}
        }
        if(!valid||approachingSteps<Math.ceil(back*.6)||rawTravel>norm(sub(striker.track[frame].xyz[limbIndex],striker.track[earlier].xyz[limbIndex]))*3+.06)continue;
        const overlapping=Array.from({length:back+ahead+1},(_,delta)=>frame-back+delta).some(f=>
          striker.track[f].overlappingSourceBoxes?.length||target.track[f].overlappingSourceBoxes?.length);
        const proximity=clamp(1-Math.max(0,hit.gap)/.1,0,1);
        let confidence=clamp(.31+.22*proximity+.14*clamp(closingSpeed/2,0,1)+.1*clamp(activeTravel/.2,0,1),.2,.77);
        if(overlapping)confidence=Math.min(.55,confidence*.76);
        const intensity=clamp(1+[.65,1,1.5,2.2].filter(threshold=>closingSpeed>=threshold).length,1,5);
        const surfaceOffset=mul(hit.normal,hit.radius);
        const point=add(mix(target.track[frame].xyz[hit.region.a],target.track[frame].xyz[hit.region.b],hit.fraction),surfaceOffset);
        const offset=sub(point,target.track[frame].xyz[hit.region.jointIndex]);
        const startFrame=Math.max(0,frame-Math.round(fps*.28)),endFrame=Math.min(frames.length-1,frame+Math.round(fps*.42));
        candidates.push({id:`estimate_${strikerId}_${targetId}_${limb}_${frame}`,kind:'motion-estimate',
          name:`Likely ${LIMB_LABELS[limb].toLowerCase()} → ${hit.region.name.toLowerCase()}`,frame,startFrame,endFrame,
          strikerId,limb,targetId,targetJoint:hit.region.joint,offset,point,region:hit.region.name,
          targetSegment:hit.region.names,targetFraction:hit.fraction,targetRadius:hit.radius,surfaceOffset,
          intensity,speedMps,closingSpeedMps:closingSpeed,confidence,duration:.7,
          uncertainty:overlapping?'Overlapping people in the source; depth and contact are unverified.':'Estimated monocular depth; contact is unverified.',
          scaleVerified:motion.scaleVerified===true,intensityBasis:'Relative approach speed; not measured force.'});
      }
    }
  }
  // Rank before debouncing so several minima from one approach produce one useful moment.
  candidates.sort((a,b)=>b.confidence-a.confidence||b.closingSpeedMps-a.closingSpeedMps||a.frame-b.frame||a.id.localeCompare(b.id));
  const selected=[];
  for(const candidate of candidates){
    const duplicate=selected.some(event=>{
      const elapsed=Math.abs(event.frame-candidate.frame)/fps;
      if(event.strikerId===candidate.strikerId&&event.targetId===candidate.targetId)
        return elapsed<(event.limb===candidate.limb ? .65 : .26);
      // Hands meeting can produce symmetric approaches. Keep the stronger candidate,
      // rather than describing the same uncertain contact as two opposing strikes.
      return event.strikerId===candidate.targetId&&event.targetId===candidate.strikerId&&elapsed<.16;
    });
    if(!duplicate)selected.push(candidate);
  }
  return selected.sort((a,b)=>a.frame-b.frame||a.id.localeCompare(b.id));
}

export const estimateStrikes=detectMotionStrikes;

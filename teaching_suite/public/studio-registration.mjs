export const DEFAULT_ALIGNMENT={x:2,y:1.8,z:2,pitch:180,yaw:0,roll:0,scale:1};
export function validAlignment(value){
  if(!value||typeof value!=='object')return false;
  return ['x','y','z'].every(k=>Number.isFinite(value[k])&&Math.abs(value[k])<=1000)
    &&['pitch','yaw','roll'].every(k=>Number.isFinite(value[k])&&Math.abs(value[k])<=360)
    &&Number.isFinite(value.scale)&&value.scale>=.01&&value.scale<=100;
}

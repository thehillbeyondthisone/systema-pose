import * as THREE from 'three';
import {RectAreaLightUniformsLib} from './vendor/three/addons/lights/RectAreaLightUniformsLib.js';

/** Ceiling fixtures located in the scan, with a visual exposure match.
 * The Gaussian colors are baked radiance, so fixture power is an approximation.
 */
export class StudioLighting{
  constructor(world){
    RectAreaLightUniformsLib.init();this.world=world;this.fixtures=[];this.signature='';
    this.fill=new THREE.HemisphereLight('#dfdce2','#8a8183',.95);this.fill.name='Neutral room bounce';world.add(this.fill);
    this.fallback=new THREE.DirectionalLight('#f5f5fa',.7);this.fallback.position.set(0,5,0);this.fallback.name='Unregistered room light';world.add(this.fallback);
  }
  sync(studio){
    const config=studio?.ready&&studio.config?.lighting;
    if(!config?.fixtures?.length){
      for(const light of this.fixtures)light.visible=false;
      this.signature='';this.fallback.intensity=.7;return;
    }
    studio.group.updateWorldMatrix(true,false);
    const matrix=studio.group.matrixWorld,signature=JSON.stringify([config,matrix.elements]);
    if(signature===this.signature)return;this.signature=signature;
    for(const light of this.fixtures)light.removeFromParent();this.fixtures=[];
    this.fill.intensity=.95;this.fallback.intensity=0;
    const rotation=studio.group.getWorldQuaternion(new THREE.Quaternion());
    const down=new THREE.Vector3().fromArray(config.down||[0,1,0]).applyQuaternion(rotation),up=new THREE.Vector3().fromArray(config.up||[0,0,1]).applyQuaternion(rotation);
    const scale=studio.group.getWorldScale(new THREE.Vector3()).x;
    for(const [index,fixture] of config.fixtures.entries()){
      const light=new THREE.RectAreaLight(fixture.color||'#fffdfb',fixture.intensity??18,fixture.width*scale,fixture.height*scale);
      light.name=`Scanned ceiling fixture ${index+1}`;light.userData.studioFixture=true;
      light.position.fromArray(fixture.position).applyMatrix4(matrix);light.up.copy(up);light.lookAt(light.position.clone().add(down));
      this.world.add(light);this.fixtures.push(light);
    }
    this.world.userData.studioLighting={mode:'scan-fixtures',fixtures:this.fixtures.length,power:'visual estimate'};
  }
}

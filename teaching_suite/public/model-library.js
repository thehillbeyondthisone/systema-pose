import {loadCustomModel, SOURCE_JOINTS} from './custom-figure.js';

const DATABASE='systema-local-models-v1', STORE='models';
const MAX_MODELS=8, MAX_BYTES=50*1024*1024;
const LABELS={pelvis:'Pelvis / hips',left_hip:'Left upper leg',right_hip:'Right upper leg',
  spine1:'Lower spine',left_knee:'Left lower leg',right_knee:'Right lower leg',spine2:'Middle spine',
  left_ankle:'Left ankle',right_ankle:'Right ankle',spine3:'Chest / upper spine',left_foot:'Left toes',
  right_foot:'Right toes',neck:'Neck',left_collar:'Left collarbone',right_collar:'Right collarbone',
  head:'Head',left_shoulder:'Left upper arm',right_shoulder:'Right upper arm',left_elbow:'Left forearm',
  right_elbow:'Right forearm',left_wrist:'Left hand',right_wrist:'Right hand'};
let libraryCount=0;

function element(tag,className='',text){
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined)node.textContent=text;
  return node;
}
function button(text,action,kind){
  const node=element('button','',text);node.type='button';
  if(kind)node.dataset.modelAction=kind;
  node.addEventListener('click',action);return node;
}
function cleanName(value){
  return String(value||'Custom model').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,120);
}
function errorMessage(error){return error?.message||'The model could not be opened.';}
function missing(asset){return Array.isArray(asset?.missingRequired)?asset.missingRequired:[];}
function id(){
  return globalThis.crypto?.randomUUID?.()||`model-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,12)}`;
}

/**
 * Browser-local GLB assets shared by every clip on this origin. Model bytes are
 * stored only in IndexedDB; selecting a file never sends it to a server.
 *
 * onChange({type,id}) announces add/remove/mapping/settings; onApply(id,personId)
 * requests a figure swap (an omitted personId means all participants).
 */
export class ModelLibrary{
  constructor({container,motion,onChange=()=>{},onApply=()=>{}}={}){
    if(!container||!motion?.people)throw Error('The model library needs a scene and a container.');
    this.motion=motion;this.onChange=onChange;this.onApply=onApply;
    this.assets=new Map();this.records=new Map();this.failures=new Map();this.cards=new Map();
    this.db=null;this.storageAvailable=true;this.busy=false;this.destroyed=false;this.restored=false;
    this.prefix=libraryCount++?`model${libraryCount}`:'model';
    this.mount(container);
  }

  get(modelId){return this.assets.get(modelId);}
  hasReady(modelId){const asset=this.get(modelId);return Boolean(asset&&missing(asset).length===0);}
  setStatus(message,isError=false){
    if(!this.status)return;
    this.status.textContent=message;this.status.dataset.kind=isError?'error':'info';this.status.dataset.error=String(isError);
  }
  storageNote(){return this.storageAvailable?'':' Browser storage is unavailable; changes last for this tab only. Keep your original GLB file.';}
  changed(type,modelId){
    if(!this.destroyed)this.onChange({type,id:modelId});
  }

  mount(container){
    this.container=container;this.root=element('div','model-library');container.replaceChildren(this.root);
    this.root.append(element('p','model-help','Upload a humanoid GLB, map its bones, then use it for any participant while motion keeps playing.'));
    const toolbar=element('div','model-toolbar');
    const uploadLabel=element('label','model-upload','Add rigged models ');
    this.upload=element('input');this.upload.type='file';this.upload.multiple=true;this.upload.id=this.prefix+'Upload';
    this.upload.accept='.glb,model/gltf-binary';
    this.upload.addEventListener('change',async()=>{
      const files=[...(this.upload.files||[])];
      try{await this.addFiles(files);}finally{this.upload.value='';}
    });
    uploadLabel.append(this.upload);toolbar.append(uploadLabel);this.root.append(toolbar);
    this.root.append(element('p','model-help','Self-contained .glb only, up to 50 MB each and 8 models. Export a skinned humanoid in its rest pose with embedded textures; turn off Draco, Meshopt, and texture compression. Fingers and facial animation are not captured.'));
    this.root.append(element('p','model-help','Files stay in this browser. Supported rigs are matched automatically; unfamiliar bone names need manual mapping. Your model keeps its own proportions and materials.'));
    this.list=element('div','model-list');this.list.id=this.prefix+'List';this.list.setAttribute('aria-label','Your rigged models');
    this.empty=element('p','model-empty','No custom models yet. Add a rigged GLB to get started.');
    this.status=element('p','model-status');this.status.id=this.prefix+'Status';this.status.setAttribute('role','status');
    this.status.setAttribute('aria-live','polite');this.root.append(this.list,this.empty,this.status);
  }

  async openDatabase(){
    if(!globalThis.indexedDB)throw Error('Browser storage is unavailable.');
    return await new Promise((resolve,reject)=>{
      let request,settled=false;
      const finish=(error,db)=>{
        if(settled){db?.close();return;}
        settled=true;clearTimeout(timer);if(error)reject(error);else resolve(db);
      };
      const timer=setTimeout(()=>finish(Error('Browser storage did not respond.')),6000);
      try{request=indexedDB.open(DATABASE,1);}catch(error){finish(error);return;}
      request.onupgradeneeded=()=>{
        if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE,{keyPath:'id'});
      };
      request.onsuccess=()=>finish(null,request.result);
      request.onerror=()=>finish(request.error||Error('Browser storage could not be opened.'));
      request.onblocked=()=>finish(Error('Close another viewer tab to update browser storage.'));
    });
  }

  async storage(action,record){
    if(!this.db||!this.storageAvailable)throw Error('Browser storage is unavailable.');
    return await new Promise((resolve,reject)=>{
      let transaction,request,result;
      try{
        transaction=this.db.transaction(STORE,action==='read'?'readonly':'readwrite');
        const store=transaction.objectStore(STORE);
        request=action==='read'?store.getAll():action==='delete'?store.delete(record.id):store.put(record);
        request.onsuccess=()=>{result=request.result;};
        transaction.oncomplete=()=>resolve(result);
        transaction.onerror=()=>reject(transaction.error||request.error||Error('Browser storage failed.'));
        transaction.onabort=()=>reject(transaction.error||Error('Browser storage was interrupted.'));
      }catch(error){reject(error);}
    });
  }

  async persist(record,remove=false){
    if(!this.storageAvailable||this.destroyed)return false;
    try{await this.storage(remove?'delete':'write',record);return true;}
    catch{
      this.storageAvailable=false;
      this.setStatus('The model is available in this tab, but browser storage failed. Keep the original GLB file; reloading may restore an older saved version.',true);
      return false;
    }
  }

  async restore(){
    if(this.restored||this.destroyed)return;
    this.restored=true;this.busy=true;this.upload.disabled=true;
    let records=[];
    try{
      this.db=await this.openDatabase();
      if(this.destroyed){this.db.close();return;}
      this.db.onversionchange=()=>{
        this.db?.close();this.db=null;this.storageAvailable=false;
        this.setStatus('Browser storage changed in another tab. Models stay available in this tab; reload to reconnect.',true);
      };
      records=await this.storage('read');
    }catch{
      this.storageAvailable=false;
      this.setStatus('Browser storage is unavailable. You can still add models for this tab; keep your original GLB files.',true);
    }
    let restored=0;
    try{
      for(const record of records.slice(0,MAX_MODELS)){
        if(this.destroyed)break;
        if(!record||typeof record.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(record.id))continue;
        record.name=cleanName(record.name);this.records.set(record.id,record);
        try{
          if(!(record.bytes instanceof ArrayBuffer)||record.bytes.byteLength>MAX_BYTES)throw Error('Saved GLB data is missing or too large. Add the original file again.');
          const asset=await loadCustomModel(record.bytes,{name:record.name,mapping:record.mapping,settings:record.settings});
          if(this.destroyed){asset.dispose();break;}
          asset.id=record.id;this.assets.set(record.id,asset);restored++;this.changed('add',record.id);
        }catch(error){this.failures.set(record.id,errorMessage(error));}
      }
      if(!this.destroyed){
        this.renderList();
        if(this.failures.size)this.setStatus('Some saved models could not be restored. Remove the failed entries and add the original files again.',true);
        else if(restored)this.setStatus(`${restored} saved model${restored===1?'':'s'} restored. Choose a model to apply.${this.storageNote()}`);
      }
    }finally{this.busy=false;if(!this.destroyed)this.upload.disabled=false;}
  }

  async addFiles(files){
    if(this.busy||this.destroyed||!files.length)return;
    if(!this.restored)await this.restore();
    if(this.destroyed)return;
    this.busy=true;this.upload.disabled=true;
    let added=0;const errors=[];
    try{
      for(const file of files){
        if(this.destroyed)break;
        const name=cleanName(file.name);
        try{
          if(this.records.size>=MAX_MODELS)throw Error('The library has 8 models. Remove one before adding another.');
          if(!/\.glb$/i.test(file.name))throw Error('Choose a .glb file. Export your rig as glTF Binary (.glb).');
          if(file.size>MAX_BYTES)throw Error('This file is larger than 50 MB. Reduce texture sizes or mesh detail and export again.');
          if(file.size<20)throw Error('This is not a complete GLB file. Export the rig as glTF Binary (.glb).');
          this.setStatus(`Opening ${name}…`);
          const bytes=await file.arrayBuffer();
          const asset=await loadCustomModel(bytes,{name:name.replace(/\.glb$/i,'')});
          if(this.destroyed){asset.dispose();break;}
          const modelId=id();asset.id=modelId;
          const record={id:modelId,name:asset.name||name.replace(/\.glb$/i,''),bytes,
            mapping:{...asset.mapping},settings:{...asset.settings},addedAt:Date.now()};
          this.records.set(modelId,record);this.assets.set(modelId,asset);
          await this.persist(record);added++;this.renderList();this.changed('add',modelId);
        }catch(error){errors.push(`${name}: ${errorMessage(error)}`);}
      }
      if(!this.destroyed){
        const result=added?`${added} model${added===1?'':'s'} added. Apply a ready model, or open Bone mapping to finish setup.`:'';
        this.setStatus([result,...errors].filter(Boolean).join(' ')+this.storageNote(),errors.length>0||!this.storageAvailable);
      }
    }finally{this.busy=false;if(!this.destroyed)this.upload.disabled=false;}
  }

  renderList(){
    this.list.replaceChildren();this.cards.clear();this.empty.hidden=this.records.size>0;
    for(const [modelId,record] of this.records){
      const asset=this.get(modelId),card=element('article','model-card');card.dataset.modelId=modelId;
      card.append(element('h3','model-name',asset?.name||record.name));
      const state=element('p','model-status');state.dataset.modelReadiness='';state.setAttribute('role','status');
      card.append(state);const controls={card,state,applyButtons:[]};this.cards.set(modelId,controls);
      if(asset){
        const actions=element('div','model-actions');
        const all=button('Apply to all',()=>this.apply(modelId),'apply-all');actions.append(all);controls.applyButtons.push(all);
        const personLabel=element('label','model-participant');personLabel.append(element('span','','Participant '));
        const personSelect=element('select');personSelect.dataset.modelParticipant='';
        for(const person of this.motion.people){const option=element('option','',person.name||`Participant ${person.id}`);option.value=String(person.id);personSelect.append(option);}
        personLabel.append(personSelect);actions.append(personLabel);
        const one=button('Apply to participant',()=>this.apply(modelId,personSelect.value),'apply-person');
        actions.append(one);controls.applyButtons.push(one);card.append(actions);
        card.append(this.mappingEditor(modelId,asset,controls),this.settingsEditor(modelId,asset));
      }
      const remove=button('Remove model',()=>this.remove(modelId),'remove');card.append(remove);
      this.list.append(card);this.refreshReadiness(modelId);
    }
  }

  refreshReadiness(modelId){
    const asset=this.get(modelId),controls=this.cards.get(modelId);if(!controls)return;
    const absent=missing(asset),ready=this.hasReady(modelId);
    controls.state.dataset.modelReadiness=ready?'ready':asset?'missing':'error';
    controls.state.dataset.error=String(!asset);
    controls.state.textContent=!asset?this.failures.get(modelId)||'This model is unavailable.':ready?
      `Ready · ${asset.boneNames.length} bones. Captured body motion drives this rig.`:
      `Map these bones to animate: ${absent.map(joint=>LABELS[joint]||joint).join(', ')}.`;
    for(const control of controls.applyButtons)control.disabled=!ready;
  }

  mappingEditor(modelId,asset,controls){
    const details=element('details','model-mapping');details.open=!this.hasReady(modelId);
    details.append(element('summary','','Bone mapping'));
    details.append(element('p','model-help','Match each captured joint to the bone that starts that body part. For example, Left upper arm maps to UpperArm, not Shoulder/Clavicle. Optional spine, collar, toe, and neck bones may be left unset.'));
    const grid=element('div','model-mapping-grid'),fields=new Map();
    for(const joint of SOURCE_JOINTS){
      const label=element('label','model-field');label.append(element('span','',LABELS[joint]||joint));
      const select=element('select');select.dataset.sourceJoint=joint;select.name=joint;
      const unset=element('option','','— Unset —');unset.value='';select.append(unset);
      for(const boneName of asset.boneNames){const option=element('option','',boneName);option.value=boneName;select.append(option);}
      select.value=asset.mapping[joint]||'';fields.set(joint,select);label.append(select);grid.append(label);
    }
    details.append(grid);controls.mappingFields=fields;
    const feedback=element('p','model-status');feedback.setAttribute('role','status');
    const save=button('Save mapping',async()=>{
      save.disabled=true;
      try{
        asset.setMapping(Object.fromEntries([...fields].map(([joint,select])=>[joint,select.value])));
        const record=this.records.get(modelId);if(!record)return;record.mapping={...asset.mapping};
        const saved=await this.persist(record);this.refreshReadiness(modelId);this.changed('mapping',modelId);
        feedback.textContent=(this.hasReady(modelId)?'Mapping saved. This model is ready.':'Mapping saved. Complete the missing bones above to apply this model.')+(saved?'':this.storageNote());
        this.setStatus(`Mapping updated for ${asset.name}.${this.storageNote()}`,!this.storageAvailable);
      }catch(error){feedback.textContent=errorMessage(error);this.setStatus(errorMessage(error),true);}
      finally{save.disabled=false;}
    },'save-mapping');
    details.append(save,feedback);return details;
  }

  settingsEditor(modelId,asset){
    const details=element('details','model-calibration');details.append(element('summary','','Adjust fit'));
    details.append(element('p','model-help','Height fits the captured person automatically. Use size and facing adjustments if your export needs correction.'));
    const grid=element('div','model-settings');
    const fields={};
    for(const [key,labelText,min,max,step,fallback] of [
      ['scaleMultiplier','Size multiplier',.1,10,.05,1],['yawDegrees','Facing correction (degrees)',-180,180,5,0]]){
      const label=element('label','model-field'),input=element('input');input.type='number';input.min=String(min);
      input.max=String(max);input.step=String(step);input.required=true;input.value=String(asset.settings?.[key]??fallback);input.dataset.modelSetting=key;
      label.append(element('span','',labelText),input);grid.append(label);fields[key]=input;
    }
    details.append(grid);const feedback=element('p','model-status');feedback.setAttribute('role','status');
    const save=button('Save fit',async()=>{
      if(!Object.values(fields).every(input=>input.reportValidity()))return;
      save.disabled=true;
      try{
        asset.setSettings({scaleMultiplier:Number(fields.scaleMultiplier.value),yawDegrees:Number(fields.yawDegrees.value)});
        const record=this.records.get(modelId);if(!record)return;record.settings={...asset.settings};
        await this.persist(record);this.changed('settings',modelId);feedback.textContent=`Fit updated.${this.storageNote()}`;
      }catch(error){feedback.textContent=errorMessage(error);this.setStatus(errorMessage(error),true);}
      finally{save.disabled=false;}
    },'save-settings');details.append(save,feedback);return details;
  }

  async apply(modelId,participantId){
    if(!this.hasReady(modelId)){this.setStatus('Finish the required bone mappings before applying this model.',true);return;}
    try{
      if(await this.onApply(modelId,participantId)===false)return;
      const person=this.motion.people.find(person=>String(person.id)===participantId);
      this.setStatus(`${this.get(modelId).name} applied to ${participantId===undefined?'all participants':person?.name||`participant ${participantId}`}.${this.storageNote()}`);
    }catch(error){this.setStatus(errorMessage(error),true);}
  }

  async remove(modelId){
    const record=this.records.get(modelId);if(!record)return;
    const asset=this.get(modelId);this.records.delete(modelId);this.assets.delete(modelId);this.failures.delete(modelId);
    // Tell the viewer to release live instances before disposing shared resources.
    this.changed('remove',modelId);asset?.dispose();this.renderList();
    const saved=await this.persist(record,true);
    this.setStatus(`${record.name} removed.${saved?'':this.storageNote()}`,!this.storageAvailable);
  }

  destroy(){
    this.destroyed=true;this.db?.close();this.db=null;
    for(const asset of this.assets.values())asset.dispose();
    this.assets.clear();this.records.clear();this.failures.clear();this.cards.clear();this.root.remove();
  }
}

const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const fs = require('node:fs');

(async () => {
  const {findBoneContacts, closestSegmentPoints} = await import(pathToFileURL(path.resolve(__dirname,'../teaching_suite/public/contact_geometry.mjs')));
  const bone = [[0,1]], radius = .02;
  const contacts = (a,b) => findBoneContacts([{id:1,xyz:a},{id:2,xyz:b}],bone,radius);
  const horizontal = [[-1,0,0],[1,0,0]];
  assert.equal(contacts(horizontal,[[0,-1,0],[0,1,0]]).length,1,'Crossing segments in the same 3D plane');
  assert.equal(contacts(horizontal,[[0,-1,.2],[0,1,.2]]).length,0,'Matching screen crossing but separated in depth');
  assert.equal(contacts(horizontal,[[-.5,.03,0],[.5,.03,0]]).length,1,'Parallel capsule volumes intersect');
  assert.equal(contacts(horizontal,[[-.5,.041,0],[.5,.041,0]]).length,0,'Parallel capsule volumes do not intersect');
  assert.equal(contacts(horizontal,[[1,0,0],[2,0,0]]).length,1,'Endpoint contact');
  assert.equal(contacts(horizontal,[[2,-1,0],[2,1,0]]).length,0,'Infinite lines cross but finite bones do not');
  assert.equal(contacts([[0,0,0],[0,0,0]],[[.01,0,0],[.01,0,0]]).length,1,'Zero-length bone endpoint spheres');
  assert.equal(contacts([[0,0,0],[0,0,0]],[[1,0,0],[1,0,0]]).length,0,'Separate zero-length bones');
  assert.equal(findBoneContacts([{id:1,xyz:horizontal}],bone,radius).length,0,'Shared joints within one person are excluded');
  assert.equal(findBoneContacts([{id:1,xyz:horizontal},{id:2,xyz:horizontal}],bone,0).length,0,'Invalid thickness is excluded');
  const known = closestSegmentPoints([0,0,0],[1,0,0],[.5,-1,.2],[.5,1,.2]);
  assert(Math.abs(known.distanceSquared-.04)<1e-12,'Analytical perpendicular segment distance');
  const rotate = ([x,y,z]) => [z+4,x-3,y+2];
  assert.equal(contacts(horizontal.map(rotate),[[0,-1,0],[0,1,0]].map(rotate)).length,1,'Rotation and translation preserve contact');
  const scene = JSON.parse(fs.readFileSync(path.resolve(__dirname,'../outputs/3d-pilot/scene.json'),'utf8'));
  const started = performance.now();
  const counts = scene.frames.map(frame=>findBoneContacts(frame.people,scene.edges,radius).length);
  assert(counts.some(count=>count>0),'Included sample has model intersections at thin thickness');
  const milliseconds = performance.now()-started;
  console.log('PASS Known 3D crossings, depth separation, parallel bones, endpoints, degenerate bones, and rotation invariance');
  console.log(JSON.stringify({sampleFrames:counts.length,framesWithContacts:counts.filter(Boolean).length,
    firstContactFrame:counts.findIndex(Boolean),maxContacts:Math.max(...counts),millisecondsPerFrame:milliseconds/counts.length}));
})().catch(error=>{console.error(error);process.exitCode=1;});

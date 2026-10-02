import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {chooseResult,snapshotMetadata,captureReport,reportZip,crc32} from '../web/incident.mjs';
const r={t:10000,w:100,h:50,dets:[[1,2,3,4,'car',.8,'cached']],motion:[],regions:[],stats:{frames:1},mb:16};
const input=()=>({choice:chooseResult([r],10),results:[r],show:{boxes:true,motion:false,regions:true},wanted:true,camera:'driveway',events:[]});
test('selection preserves existing matching slack and all fallback paths',()=>{
 assert.equal(chooseResult([r],10).selection,'matched');
 assert.equal(chooseResult([r],9).selection,'matched');
 assert.equal(chooseResult([r],8).selection,'no_result_at_or_before_frame');
 assert.equal(chooseResult([r],undefined).selection,'no_renderer_timestamp');
 assert.equal(chooseResult([],10).selection,'no_results');
 assert.equal(chooseResult([r],8).result,r);
});
test('AI off is explicit, capture keeps independent timing and dimensions',()=>{
 const i=input();i.wanted=false;i.results=[];i.choice=chooseResult([],10);
 const m=snapshotMetadata(i);assert.equal(m.detections.reason,'ai_off');assert.equal(m.timing.result_minus_video_ms,null);assert.equal(i.wanted,false);
 const x=snapshotMetadata(input());assert.equal(x.timing.result_minus_video_ms,0);assert.equal(x.detection_size.width,100);assert.equal(x.box_coordinate_space,'detection_size');
});
test('metadata allowlist excludes URLs and raw extra fields',()=>{
 const i=input();i.url='https://relay/?token=SECRET';i.choice={...i.choice,result:{...r,url:i.url}};i.events=[{id:1,start:1,url:i.url,token:'SECRET'}];
 const s=JSON.stringify(snapshotMetadata(i));assert.ok(!s.includes('SECRET'));assert.ok(!s.includes('https://'));assert.ok(!s.includes('token'));
});
test('history, events, toggles and selected record survive later mutation',()=>{
 const i=input();i.results=structuredClone(i.results);i.choice=chooseResult(i.results,10);i.events=[{id:7,start:1,labels:['car']}];
 const m=snapshotMetadata(i);i.results[0].dets[0][0]=99;i.results.length=0;i.show.boxes=false;i.events[0].labels.push('truck');
 assert.equal(m.detections.selected.dets[0][0],1);assert.equal(m.layers.boxes,true);assert.deepEqual(m.events[0].labels,['car']);
});
test('missing pixels still produce portable ZIP with explicit absence',async()=>{
 const report=await captureReport(input(),null,null);assert.equal(report.metadata.frame.available,false);
 const zip=await reportZip(report,{note:'Please inspect'});assert.equal(zip.type,'application/zip');
 await writeFile('/tmp/codec-incident-test.zip',new Uint8Array(await zip.arrayBuffer()));
});
test('slow toBlob cannot mix later source pixels, toggles or histories',async()=>{
 const old=globalThis.document;let copies=[];
 globalThis.document={createElement(){const c={width:0,height:0,pixel:null,getContext(){return {drawImage(src){c.pixel=src.pixel},getImageData(){return {}}}},toBlob(cb){copies.push(()=>cb(new Blob([c.pixel])))}};return c;}};
 try{const i=input(),frame={width:200,height:100,pixel:'old-frame'},overlay={width:100,height:50,pixel:'old-overlay'};
 const promise=captureReport(i,frame,overlay);frame.pixel='new';overlay.pixel='new';i.show.boxes=false;i.results=[];copies.forEach(f=>f());
 const report=await promise;assert.equal(await report.frame.text(),'old-frame');assert.equal(await report.overlay.text(),'old-overlay');assert.equal(report.metadata.layers.boxes,true);assert.equal(report.metadata.video_size.width,200);assert.equal(report.metadata.overlay.width,100);
 }finally{globalThis.document=old;}
});
test('tainted readback produces metadata instead of aborting capture',async()=>{
 const old=globalThis.document;globalThis.document={createElement(){return {getContext(){return {drawImage(){throw Object.assign(new Error(),{name:'SecurityError'})}}}}}};
 try{const report=await captureReport(input(),{width:100,height:50},null);assert.equal(report.metadata.frame.reason,'SecurityError');}finally{globalThis.document=old;}
});
test('CRC matches known ZIP polynomial',()=>assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926));
test('integration captures inside draw and does not add inference/subscription code',async()=>{
 const camera=await readFile(new URL('../web/camera.js',import.meta.url),'utf8');
 const reporter=await readFile(new URL('../web/incident.mjs',import.meta.url),'utf8');
 assert.ok(camera.includes('finishCapture(choice);'));
 assert.ok(camera.includes('Camera switched before capture'));
 assert.ok(!/fetch\(|subscribe\(|setAI\(|follow\(/.test(reporter));
 assert.ok(!reporter.includes('location.search'));
});

test('selection matches original viewer on unsorted and coerced timestamps',()=>{
 const rows=[{t:30000},{t:10000},{t:20000}];
 const original=ms=>{if(ms===undefined||!rows.length)return rows.at(-1);let best;for(const r of rows)if(r.t<=ms*1000+1000&&(!best||r.t>best.t))best=r;return best??rows.at(-1);};
 for(const ms of [0,10,20,29,undefined,null,NaN,Infinity,-Infinity,'20',''])assert.equal(chooseResult(rows,ms).result,original(ms));
 assert.equal(chooseResult(rows,'20').timestamp_type,'string');
});
test('AI off or absent result never exports default or stale overlay canvas',async()=>{
 const i=input();i.wanted=false;i.choice=chooseResult([],10);
 const r=await captureReport(i,null,{width:300,height:150});
 assert.equal(r.overlay,null);assert.equal(r.metadata.overlay.reason,'no_detection_result');
});
test('Cosmos analyzing is not evidence of a Weave call; completed intervals get relation',()=>{
 const i=input();i.events=[{id:1,state:'analyzing',start:1},{id:2,state:'done',start:9000,end:11000},{id:3,state:'done',start:50000,end:60000}];
 const m=snapshotMetadata(i);
 assert.ok(m.events.every(e=>e.trace.state==='unavailable'));
 assert.equal(m.events.find(e=>e.id===2).relation,'overlaps_capture');
 assert.equal(m.events.find(e=>e.id===3).relation,'recent_context_only');
});
test('training candidates never treat predictions or missing images as reviewed labels',async()=>{
 const {trainingCandidate}=await import('../web/incident.mjs');
 const m={...snapshotMetadata(input()),frame:{available:true},video_size:{width:200,height:100}};
 const c=trainingCandidate(m,'abc');
 assert.equal(c.image.file,'frame.png');assert.equal(c.eligible_for_training,false);
 assert.equal(c.annotation.reviewed_boxes,null);assert.equal(c.annotation.confirmed_background,false);
 assert.equal(c.predictions.coordinate_space,'detection_size');assert.equal(c.predictions.frame_mapping_verified,false);
 assert.equal(c.provenance.suggested_split,null);assert.equal(c.provenance.source_recording_id,null);
 assert.equal(c.image.sha256,'abc');assert.equal(c.annotation.class_schema,null);
 const missing=trainingCandidate({...m,frame:{available:false}},null);
 assert.equal(missing.image.file,null);assert.ok(missing.blockers.includes('clean_image_missing'));
 assert.ok(missing.blockers.includes('image_hash_missing'));
});
test('status describes timing direction instead of raw machine codes',async()=>{
 const {describeCapture}=await import('../web/incident.mjs');const m=snapshotMetadata(input());
 m.timing.result_minus_video_ms=-10;assert.match(describeCapture(m),/10.0 ms before/);
 m.timing.result_minus_video_ms=20;assert.match(describeCapture(m),/20.0 ms after/);
});

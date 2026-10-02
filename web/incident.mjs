// Portable local incident reports. No network, model calls, or stream subscriptions.
const finite = n => Number.isFinite(n) ? n : null;
export function chooseResult(results, raw) {
  // Preserve the original viewer's coercion/selection, including unusual timestamp values.
  const timestamp = raw == null ? null : finite(Number(raw));
  const type = typeof raw;
  const common = {timestamp, timestamp_type: type,
    timestamp_raw: typeof raw === "string" ? raw.slice(0,80) : finite(raw)};
  if (!results.length) return {...common, result: null, selection: "no_results"};
  if (raw === undefined) return {...common, result: results.at(-1), selection: "no_renderer_timestamp"};
  let best;
  for (const r of results) if (r.t <= raw * 1000 + 1000 && (!best || r.t > best.t)) best = r;
  return {...common, result: best ?? results.at(-1), selection: best ? "matched" : "no_result_at_or_before_frame"};
}
export function selectEvents(events, t) {
  const tail = events.slice(-3);
  const overlaps = e => Number.isFinite(t) && Number.isFinite(e.start) && Number.isFinite(e.end) && e.start <= t && t <= e.end;
  return [...events.filter(overlaps).slice(-7), ...tail.filter(e => !overlaps(e))].slice(-10)
    .map(e => ({...e, relation: overlaps(e) ? "overlaps_capture" : "recent_context_only"}));
}

function record(r) {
  if (!r) return null;
  return {t: finite(r.t), w: finite(r.w), h: finite(r.h), full: !!r.full,
    dets: (r.dets ?? []).slice(0, 1000).map(d => d.slice(0, 7)),
    regions: (r.regions ?? []).slice(0, 1000).map(d => d.slice(0, 4)),
    motion: (r.motion ?? []).slice(0, 2000).map(d => d.slice(0, 4)), mb: finite(r.mb),
    truncated: (r.dets?.length ?? 0) > 1000 || (r.regions?.length ?? 0) > 1000 || (r.motion?.length ?? 0) > 2000,
    stats: Object.fromEntries(["frames", "inferred", "held", "ms", "full_ms"].map(k => [k, finite(r.stats?.[k])]))};
}
export function snapshotMetadata({choice, results, show, wanted, camera, events = [], viewerSession = null}) {
  const selected = record(choice.result);
  return {schema_version: 1, kind: "viewer_report", captured_at: new Date().toISOString(),
    report_id: globalThis.crypto?.randomUUID?.() ?? null, viewer_session_id: viewerSession,
    selection_method: "human_reported_incident", camera: String(camera).slice(0, 128), video_clip: {available: false, reason: "viewer_has_no_video_history"},
    timing: {renderer_timestamp_raw: choice.timestamp_raw ?? null, renderer_timestamp_type: choice.timestamp_type ?? "unknown", renderer_timestamp_ms: choice.timestamp, renderer_unit_assumed: "milliseconds",
      renderer_source: "moq-watch renderer.out.timestamp", presentation_semantics_verified: false,
      detection_timestamp_us: selected?.t ?? null,
      result_minus_video_ms: selected?.t != null && choice.timestamp != null ? selected.t / 1000 - choice.timestamp : null,
      note: "Alignment using the viewer's existing unit assumption; not end-to-end latency."},
    detection_size: selected ? {width: selected.w, height: selected.h} : null,
    box_coordinate_space: "detection_size", coordinate_mapping: "Not calibrated; preserve independent image dimensions.",
    ai_on: !!wanted, layers: {boxes: !!show.boxes, motion: !!show.motion, regions: !!show.regions},
    detections: {available: !!selected && wanted, reason: !wanted ? "ai_off" : selected ? null : "no_results", selection: choice.selection,
      selected, history: results.slice(-30).map(record), history_truncated: results.length > 30},
    events: selectEvents(events, selected?.t).map(e => ({camera: String(camera).slice(0,128), id: e.id, start: finite(e.start), end: finite(e.end),
      state: e.state, relation: e.relation, labels: (e.labels ?? []).slice(0,100), summary: String(e.summary ?? "").slice(0,4000),
      trace: {state: "unavailable", reason: "not_instrumented", access: "unknown"}})),
    human: {issue: null, note: "", region: null}, source_revision: null};
}
// This copy is synchronous: later rendering, camera switches and slow PNG encoding cannot alter it.
function copyCanvas(source) {
  if (!source?.width || !source?.height) return {available: false, reason: "canvas_unavailable"};
  if (source.width * source.height > 8388608) return {available: false, reason: "pixel_limit"};
  try {
    const canvas = document.createElement("canvas"); canvas.width = source.width; canvas.height = source.height;
    const ctx = canvas.getContext("2d"); ctx.drawImage(source, 0, 0);
    ctx.getImageData(0, 0, 1, 1); // Detect tainted readback before async encoding.
    return {available: true, width: canvas.width, height: canvas.height, canvas};
  } catch (e) { return {available: false, reason: e.name || "readback_failed"}; }
}
async function encode(copy) {
  if (!copy.available) return {info: copy, blob: null};
  try {
    const blob = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("encoding_timeout")), 5000);
      copy.canvas.toBlob(b => {clearTimeout(timer); b ? resolve(b) : reject(new Error("encoding_failed"));}, "image/png");
    });
    if (blob.size > 16 * 1024 * 1024) throw new Error("image_byte_limit");
    return {info: {available: true, width: copy.width, height: copy.height}, blob};
  } catch (e) { return {info: {available: false, reason: e.message}, blob: null}; }
}
export function captureReport(input, frame, overlay) {
  const metadata = snapshotMetadata(input);
  const clean = copyCanvas(frame), painted = input.choice.result && input.wanted ? copyCanvas(overlay) : {available:false, reason:"no_detection_result"};
  return Promise.all([encode(clean), encode(painted)]).then(([a,b]) => {
    metadata.frame = {...a.info, readback_content_verified: false}; metadata.overlay = b.info;
    metadata.video_size = a.info.available ? {width: a.info.width, height: a.info.height} : null;
    return {metadata, frame: a.blob, overlay: b.blob};
  });
}
const encoder = new TextEncoder();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) { c ^= b; for (let i=0;i<8;i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (c ^ 0xffffffff) >>> 0;
}
export function zipStore(files) {
  const local=[], central=[]; let offset=0, centralSize=0;
  for (const [name, bytes] of files) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error("Unsafe archive filename");
    const n=encoder.encode(name), crc=crc32(bytes), h=new Uint8Array(30+n.length), v=new DataView(h.buffer);
    v.setUint32(0,0x04034b50,true); v.setUint16(4,20,true); v.setUint32(14,crc,true);
    v.setUint32(18,bytes.length,true); v.setUint32(22,bytes.length,true); v.setUint16(26,n.length,true); h.set(n,30);
    const c=new Uint8Array(46+n.length), d=new DataView(c.buffer);
    d.setUint32(0,0x02014b50,true); d.setUint16(4,20,true); d.setUint16(6,20,true); d.setUint32(16,crc,true);
    d.setUint32(20,bytes.length,true); d.setUint32(24,bytes.length,true); d.setUint16(28,n.length,true); d.setUint32(42,offset,true); c.set(n,46);
    local.push(h,bytes); central.push(c); offset+=h.length+bytes.length; centralSize+=c.length;
  }
  if(offset+centralSize>40*1024*1024) throw new Error("Report exceeds 40 MiB");
  const end=new Uint8Array(22), v=new DataView(end.buffer); v.setUint32(0,0x06054b50,true);
  v.setUint16(8,files.length,true); v.setUint16(10,files.length,true); v.setUint32(12,centralSize,true); v.setUint32(16,offset,true);
  return new Blob([...local,...central,end],{type:"application/zip"});
}
export function trainingCandidate(m, imageHash) {
  return {schema_version:1, role:"annotation_candidate", eligible_for_training:false,
    sample_id:imageHash ? "sha256:"+imageHash : null,
    image:{file:m.frame.available ? "frame.png" : null, sha256:imageHash,
      width:m.video_size?.width ?? null, height:m.video_size?.height ?? null,
      source:"browser_decoded_canvas", content_verified:false, overlay_burned_in:false},
    provenance:{report_id:m.report_id, camera:m.camera, viewer_session_id:m.viewer_session_id,
      source_recording_id:null, source_video_sha256:null, source_frame_pts:null,
      grouping_status:"source_recording_unresolved", suggested_split:null},
    selection:{method:"human_reported_incident", issue:m.human.issue,
      representative_sample:false, note:"Reported failures are biased; add ordinary scenes and reviewed negatives."},
    annotation:{status:"unreviewed", class_schema:null, reviewed_boxes:null,
      all_target_classes_reviewed:false, confirmed_background:false, reviewer:null},
    predictions:{file:"detections.json", role:"unverified_suggestions", coordinate_space:"detection_size",
      frame_mapping_verified:false, model_id:null, weights_sha256:null},
    training_use_permission:{status:"unreviewed"},
    blockers:[...(!m.frame.available ? ["clean_image_missing"] : []), ...(!imageHash ? ["image_hash_missing"] : []),
      "clean_image_content_unverified", "annotations_unreviewed", "class_schema_unassigned",
      "source_group_unresolved", "training_use_unreviewed"],
    export_policy:"Never train on overlay.png or unreviewed predictions. No labels file is emitted. Label every target-class object in the clean image; a missing label is not confirmed background."};
}
export async function reportZip(report, human) {
  const m=structuredClone(report.metadata);
  const issues=new Set(["missing_detection","wrong_box_or_class","overlay_timing","other"]);
  m.human={issue:issues.has(human.issue)?human.issue:null, note:String(human.note||"").slice(0,2000), region:null};
  const files=[]; let frameHash=null;
  const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(b=>b.toString(16).padStart(2,"0")).join("");
  for(const [name,blob] of [["frame.png",report.frame],["overlay.png",report.overlay]]) if(blob) {
    const bytes=new Uint8Array(await blob.arrayBuffer()); files.push([name,bytes]);
    if(name==="frame.png" && globalThis.crypto?.subtle) frameHash=await digest(bytes);
  }
  const json=(name,data)=>files.push([name,encoder.encode(JSON.stringify(data,null,2))]);
  const {detections,events,...incident}=m;
  json("incident.json",incident); json("detections.json",detections); json("events.json",events);
  json("training-candidate.json",trainingCandidate(m,frameHash));
  const readme=`Codec Vision incident report\nCamera: ${m.camera}\nCaptured: ${m.captured_at}\nVideo clip: absent. This viewer keeps detection metadata, not rewindable video.\nClean frame: ${m.frame.available ? 'included; player readback content not independently verified' : m.frame.reason}\nOverlay: ${m.overlay.available ? 'included' : m.overlay.reason}\nBox coordinates: detection_size. Frame and overlay may have different dimensions.\nTiming: renderer unit follows existing viewer assumption; alignment delta is not live latency.\nWeave: no trace references recorded by this viewer version.\nPredictions are not reviewed labels. Human notes are separate in incident.json.\nTraining: training-candidate.json is an UNREVIEWED annotation candidate, NOT a YOLO label file. Verify clean pixels, annotate all target objects, choose a class schema and source-group split before training. Never use overlay.png as a training image.\nNo Breakpoint or Weave account required to inspect this archive.\n`;
  files.push(["README.txt",encoder.encode(readme)]);
  if(globalThis.crypto?.subtle) {const hashes={};for(const [name,bytes] of files)hashes[name]=await digest(bytes);json("sha256.json",hashes);}
  return zipStore(files);
}
export function describeCapture(m) {
  const delta=m.timing.result_minus_video_ms;
  const timing=delta==null ? "Timing alignment unavailable." : delta===0 ? "Result and video timestamps match." :
    `Result is ${Math.abs(delta).toFixed(1)} ms ${delta<0?'before':'after'} the video timestamp (viewer assumption).`;
  const selection={no_results:"No detection result available.",no_renderer_timestamp:"Video timestamp unavailable; latest result used.",
    no_result_at_or_before_frame:"No result matched the video time; latest result used.",matched:"Result selected using the viewer's timing rule."}[m.detections.selection];
  return `${m.camera} — captured ${new Date(m.captured_at).toLocaleString()}. ${m.ai_on?selection:'AI was off; no detection result.'} ${timing} Boxes ${m.layers.boxes?'on':'off'}; motion ${m.layers.motion?'on':'off'}.`;
}
export function mountReporter(parent, getCamera, getContext) {
  const button=document.createElement("button");button.textContent="Report incident (R)";button.type="button";
  const panel=document.createElement("section");panel.className="incident-panel";panel.hidden=true;
  panel.innerHTML=`<h2 tabindex="-1">Capture incident</h2><p class="incident-status" role="status" aria-live="polite"></p><div class="incident-preview"></div><fieldset hidden><legend>Optional context</legend><label>Issue <select><option value="">Unspecified</option><option value="missing_detection">Missing detection</option><option value="wrong_box_or_class">Wrong box or class</option><option value="overlay_timing">Overlay timing</option><option value="other">Other</option></select></label><label>Note <textarea maxlength="2000" rows="2"></textarea></label></fieldset><button type="button" class="incident-download" disabled>Download report</button> <button type="button" class="incident-discard">Discard</button><p>No video clip is recorded. Images and predictions need review before training. Nothing is uploaded.</p>`;
  parent.append(button,panel);
  let report=null,urls=[],busy=false,generation=0;
  const viewerSession=globalThis.crypto?.randomUUID?.()??null;
  const status=panel.querySelector(".incident-status"),heading=panel.querySelector("h2"),fields=panel.querySelector("fieldset"),download=panel.querySelector(".incident-download");
  const clear=()=>{for(const u of urls)URL.revokeObjectURL(u);urls=[];};
  button.onclick=async()=>{
    if(busy)return;
    // Keep an existing draft intact; the user explicitly discards it before replacing it.
    if(report){panel.hidden=false;heading.focus();status.textContent="Your captured incident and notes are preserved. Download or discard it before capturing another.";return;}
    busy=true;const gen=++generation;button.setAttribute("aria-disabled","true");panel.hidden=false;
    heading.textContent="Capturing incident";heading.focus();fields.hidden=true;download.disabled=true;
    status.textContent="Capturing on the next rendered frame. Keep this tab visible.";
    clear();panel.querySelector(".incident-preview").replaceChildren();
    try {
      const context=()=>({...getContext(),viewerSession});
      const captured=await getCamera().capture(context);
      if(gen!==generation)return;
      report=captured;const m=report.metadata;heading.textContent="Incident captured";status.textContent=describeCapture(m);
      for(const [label,blob,info] of [["Clean frame",report.frame,m.frame],["Overlay · detection coordinates; not aligned to clean frame",report.overlay,m.overlay]]) if(blob){
        const fig=document.createElement("figure"),img=document.createElement("img"),cap=document.createElement("figcaption");
        img.src=URL.createObjectURL(blob);urls.push(img.src);img.alt=label;cap.textContent=`${label} — ${info.width} × ${info.height}`;fig.append(img,cap);panel.querySelector(".incident-preview").append(fig);
      }
      fields.hidden=false;download.disabled=false;
    }catch(e){if(gen===generation){heading.textContent="Capture unavailable";status.textContent=e.message+". Keep the tab visible and try again.";}}
    finally{if(gen===generation){busy=false;button.removeAttribute("aria-disabled");}}
  };
  download.onclick=async()=>{
    if(!report||download.disabled)return;download.disabled=true;const gen=generation;
    try{
      const captured=report,zip=await reportZip(captured,{issue:panel.querySelector("select").value,note:panel.querySelector("textarea").value});
      if(gen!==generation)return;
      const a=document.createElement("a"),u=URL.createObjectURL(zip);a.href=u;
      const camera=captured.metadata.camera.replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,50);
      a.download=`codec-incident-${camera}-${captured.metadata.captured_at.replace(/[:.]/g,'-')}.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);
      status.textContent="Report download requested. Review the archive before sharing or adding images to a training dataset.";
    }catch(e){if(gen===generation)status.textContent="Download failed: "+e.message;}
    finally{if(gen===generation)download.disabled=false;}
  };
  panel.querySelector(".incident-discard").onclick=()=>{generation++;busy=false;report=null;clear();panel.hidden=true;fields.hidden=true;download.disabled=true;panel.querySelector("select").value="";panel.querySelector("textarea").value="";button.removeAttribute("aria-disabled");button.focus();};
  addEventListener("keydown",e=>{if(e.key.toLowerCase()==="r"&&!e.repeat&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.target.closest?.("input,textarea,select,[contenteditable]")){e.preventDefault();button.click();}});
}

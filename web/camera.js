import { chooseResult, captureReport } from "./incident.mjs";
// One camera: the MoQ player, an overlay synced to the frame on screen, and its AI tracks.
import "https://esm.sh/@moq/watch@0.6.1/element";
import * as Moq from "https://esm.sh/@moq/net@0.4.1";

const COLORS = { fresh: "#ff3b5c", cached: "#5ac85a", shifted: "#ffc800" };

// One connection per relay, shared by every subscription on the page.
const origins = new Map();
const connections = [];
function origin(url) {
  if (!origins.has(url)) {
    const o = new Moq.Origin.Producer();
    connections.push(Moq.Connection.connect({ url: new URL(url), consume: o }).catch((err) => console.error("connect", err)));
    origins.set(url, o);
  }
  return origins.get(url);
}

// Close connections on the way out, so the relay sees every unsubscribe now instead of after the
// QUIC idle timeout (which would keep the worker's models running for another ~30s).
export function closeAll() {
  for (const c of connections) c.then((conn) => conn?.close());
}

// Calls onText for every frame of a raw track. Resubscribes whenever the subscription ends or
// fails (publisher restarting, track not ready yet), so the page never needs a reload.
export async function follow(url, path, name, onText, priority = 0) {
  const broadcast = origin(url).request(Moq.Path.from(path));
  for (;;) {
    try {
      let active = broadcast.active.peek();
      while (!active) { await broadcast.active.changed(); active = broadcast.active.peek(); }
      const track = active.track(name).subscribe({ priority });
      for (;;) {
        const group = await track.recvGroup();
        if (!group) break;
        for (;;) {
          const text = await group.readString().catch(() => undefined);
          if (!text) break;
          onText(text);
        }
      }
    } catch (err) {
      console.warn(`${path}/${name}: ${err.message}; retrying`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// name: the camera's video broadcast; ai: the broadcast with its detections track.
export function mountCamera(root, { url, name, ai = `${name}-ai`, show = { motion: true, regions: true, boxes: true } }) {
  root.classList.add("stage");
  const watch = document.createElement("moq-watch");
  watch.setAttribute("url", url);
  watch.setAttribute("name", name);
  watch.setAttribute("muted", "");
  watch.append(document.createElement("canvas"));
  const overlay = document.createElement("canvas");
  overlay.className = "overlay";
  root.append(watch, overlay);
  const ctx = overlay.getContext("2d");

  const results = [];
  const cam = { name, show };

  // Subscribing to `detections` is what tells the worker someone wants AI on this camera (MoQ
  // demand); closing the subscription is what stops the models. cam.setAI(false) does that.
  let wanted = true, dead = false, sub, wake, pendingCapture;
  cam.capture = (context) => new Promise((resolve, reject) => {
    if (dead || pendingCapture) { reject(new Error("Camera unavailable or capture pending")); return; }
    const readContext = typeof context === "function" ? context : () => context;
    const camera = readContext().camera;
    const timer = setTimeout(() => { if (pendingCapture?.reject === reject) pendingCapture = null; reject(new Error("No rendered frame available")); }, 2000);
    pendingCapture = {readContext, camera, resolve, reject, timer};
  });
  function finishCapture(choice) {
    if (!pendingCapture) return;
    const p = pendingCapture; pendingCapture = null; clearTimeout(p.timer);
    try {
      const context = p.readContext();
      if (context.camera !== p.camera) throw new Error("Camera switched before capture");
      captureReport({choice, results, show: cam.show, wanted, ...context}, watch.querySelector("canvas"), choice.result ? overlay : null).then(p.resolve,p.reject);
    }
    catch(e) { p.reject(e); }
  }
  cam.setAI = (on) => {
    wanted = on;
    if (on) wake?.();
    else { sub?.close(); results.length = 0; }
  };
  // Tear down for a camera switch: unsubscribe detections (stops the models) and the video.
  cam.destroy = () => {
    dead = true;
    if (pendingCapture) { clearTimeout(pendingCapture.timer); pendingCapture.reject(new Error("Camera switched before capture")); pendingCapture = null; }
    cam.setAI(false);
    wake?.();
    watch.remove();
    overlay.remove();
  };
  (async () => {
    const broadcast = origin(url).request(Moq.Path.from(ai));
    for (;;) {
      while (!wanted && !dead) await new Promise((r) => (wake = r));
      if (dead) return;
      try {
        let active = broadcast.active.peek();
        while (!active) { await broadcast.active.changed(); active = broadcast.active.peek(); }
        sub = active.track("detections").subscribe({ priority: 0 });
        for (;;) {
          const group = await sub.recvGroup();
          if (!group) break;
          const text = await group.readString().catch(() => undefined);
          if (text && wanted) {
            results.push(JSON.parse(text));
            if (results.length > 600) results.splice(0, results.length - 600);
          }
        }
      } catch (err) {
        if (wanted) console.warn(`${ai}/detections: ${err.message}; retrying`);
      }
      sub = undefined;
      if (wanted) await new Promise((r) => setTimeout(r, 1000));
    }
  })();

  // The newest result at or before the frame on screen; falls back to the newest overall.
  function current() {
    return chooseResult(results, watch.renderer?.out?.timestamp?.peek?.());
  }

  function draw() {
    if (dead) return;
    requestAnimationFrame(draw);
    const choice = current(), r = choice.result;
    if (!r) { ctx.clearRect(0, 0, overlay.width, overlay.height); finishCapture(choice); return; }
    if (overlay.width !== r.w || overlay.height !== r.h) { overlay.width = r.w; overlay.height = r.h; }
    ctx.clearRect(0, 0, r.w, r.h);
    const scale = r.w / 1280; // keep strokes and labels readable at any resolution
    if (cam.show.motion) {
      ctx.fillStyle = "rgba(255, 40, 80, 0.35)";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
      ctx.lineWidth = 1.5 * scale;
      for (const [bx, by, dx, dy] of r.motion) {
        const x = bx * r.mb, y = by * r.mb;
        ctx.fillRect(x, y, r.mb, r.mb);
        ctx.beginPath();
        ctx.moveTo(x + r.mb / 2, y + r.mb / 2);
        ctx.lineTo(x + r.mb / 2 - dx * 3, y + r.mb / 2 - dy * 3);
        ctx.stroke();
      }
    }
    if (cam.show.regions) {
      ctx.strokeStyle = "#00e5ff";
      ctx.lineWidth = 3 * scale;
      ctx.setLineDash([10 * scale, 6 * scale]);
      for (const [x0, y0, x1, y1] of r.regions) ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
    }
    if (cam.show.boxes) {
      ctx.font = `bold ${Math.round(16 * scale)}px ui-sans-serif, system-ui`;
      for (const [x0, y0, x1, y1, label, conf, state] of r.dets) {
        ctx.strokeStyle = ctx.fillStyle = COLORS[state];
        ctx.lineWidth = 3 * scale;
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        const text = `${label} ${Math.round(conf * 100)}%`;
        const th = 22 * scale;
        ctx.fillRect(x0, Math.max(0, y0 - th), ctx.measureText(text).width + 8 * scale, th);
        ctx.fillStyle = "#000";
        ctx.fillText(text, x0 + 4 * scale, Math.max(th - 6 * scale, y0 - 6 * scale));
      }
    }
    finishCapture(choice);
  }
  draw();
  return cam;
}

export function renderEvents(el, list, { camera } = {}) {
  if (!list.length) {
    el.replaceChildren(Object.assign(document.createElement("div"), { className: "event", textContent: "No events yet" }));
    return;
  }
  el.replaceChildren(...list.slice().reverse().map((e) => {
    const div = document.createElement("div");
    div.className = `event ${e.state}`;
    const badge = { analyzing: "Analyzing...", alert: "ALERT", done: "Event", error: "Error", "no-agent": "Motion" }[e.state] ?? e.state;
    const meta = document.createElement("div");
    meta.className = "meta";
    const parts = [camera, e.end ? `${((e.end - e.start) / 1e6).toFixed(1)}s` : "", e.labels?.join(", "), e.ms ? `Cosmos ${(e.ms / 1000).toFixed(1)}s` : ""];
    meta.textContent = parts.filter(Boolean).join(" · ");
    const body = document.createElement("div");
    const b = Object.assign(document.createElement("span"), { className: "badge", textContent: badge });
    body.append(b, e.summary ?? "");
    div.append(meta, body);
    return div;
  }));
}

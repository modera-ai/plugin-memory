// This document runs only inside the plugin sandbox.
export const activityDocument = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; form-action 'none'; base-uri 'none'"><style>
html{color-scheme:light dark}
html,body{margin:0;background:transparent;font-family:system-ui;overflow:hidden} [hidden]{display:none!important}/* Background work stays outside layout and never intercepts input. */
.plugin-activity-edge {
  position: fixed;
  inset: 0;
  z-index: 100;
  pointer-events: none;
}
.plugin-activity-edge.waiting {
  height: 3px;
  bottom: auto;
  background: #779ce46b;
  box-shadow: 0 0 6px #6b96f655;
  overflow: hidden;
}
.plugin-activity-fill {
  height: 100%;
  width: 100%;
  transform-origin: left;
  background: linear-gradient(90deg, #779ce477, #6b96f6, #b6cfff);
  box-shadow: 0 0 7px #6b96f655;
  transition: transform .5s linear;
}
@property --plugin-orbit-angle {
  syntax: "<angle>";
  initial-value: 0deg;
  inherits: false;
}
.plugin-activity-edge.running {
  border-radius: 8px;
  box-shadow: inset 0 0 16px 2px #7697f044;
  background: conic-gradient(from var(--plugin-orbit-angle),
    #6498f044, #79caffcc 12%, #a89afff0 20%, #6498f044 34%,
    #6498f044 50%, #79caffcc 62%, #a89afff0 70%, #6498f044 84%);
  mask-image: linear-gradient(to bottom, black, transparent 24px),
    linear-gradient(to top, black, transparent 24px),
    linear-gradient(to right, black, transparent 24px),
    linear-gradient(to left, black, transparent 24px);
  animation: plugin-activity-orbit 1.4s linear infinite;
}
@keyframes plugin-activity-orbit {
  to { --plugin-orbit-angle: 360deg; }
}
@media (prefers-reduced-motion: reduce) {
  .plugin-activity-edge.running { animation: none; }
  .plugin-activity-fill { transition: none; }
}
.result{position:fixed;right:80px;top:58px;font-size:12px;color:#438b73}.result[data-state="error"]{color:#a87936}
 :root[data-theme="dark"] .result{color:#88cbb0}:root[data-theme="dark"] .result[data-state="error"]{color:#e9bc76}
</style></head><body><div class="plugin-activity-edge" hidden role="status"><div class="plugin-activity-fill"></div></div><span class="result" role="status" hidden></span><script>
let snapshot, started=0, previous='', terminalAt=0;
function render(){if(!snapshot)return;const a=snapshot.view.data.activity, now=Date.now();
if(a.state!==previous){if(a.state==='running')started=now;if(a.state==='success'||a.state==='error')terminalAt=Math.max(now,started+3000);previous=a.state;}
const running=a.state==='running'||(started>0&&now-started<3000), waiting=a.state==='waiting'&&!running;
const edge=document.querySelector('.plugin-activity-edge');edge.hidden=!running&&!waiting;edge.className='plugin-activity-edge '+(running?'running':'waiting');
const seconds=a.checkAt===undefined?0:Math.max(0,Math.ceil((a.checkAt-now)/1000));edge.setAttribute('aria-label',running?'正在提取记忆':snapshot.view.title+' · '+seconds+'s');
const fill=document.querySelector('.plugin-activity-fill');fill.hidden=!waiting;fill.style.transform='scaleX('+(a.checkAt&&a.queuedAt!==undefined?Math.max(0,Math.min(1,(now-a.queuedAt)/Math.max(1,a.checkAt-a.queuedAt))):0)+')';
const status=document.querySelector('.result');status.hidden=running||waiting||a.state==='idle'||now-terminalAt>4000;status.textContent=snapshot.view.title;status.dataset.state=a.state;}
addEventListener('message',event=>{if(event.source!==parent||event.data?.type!=='plugin:snapshot')return;snapshot=event.data;document.documentElement.dataset.theme=snapshot.context.theme;render()});setInterval(render,100);parent.postMessage({type:'plugin:ready'},'*');
</script></body></html>`;

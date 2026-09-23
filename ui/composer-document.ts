// This document runs only inside the plugin sandbox.
export const composerDocument = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; form-action 'none'; base-uri 'none'"><style>
html,body{margin:0;background:transparent;font-family:system-ui;overflow:hidden} [hidden]{display:none!important}.plugin-lever-wrap { position: relative; }
.plugin-lever { width: 70px; padding: 0; border: 0; background: transparent; cursor: pointer; color: var(--text-secondary, #65718a); -webkit-app-region: no-drag; }
.lever-well { display: block; position: relative; width: 60px; height: 88px; margin: 0 auto 4px; border-radius: 18px; background: linear-gradient(125deg,#fbfdff,#c3cedc); border: 1px solid #b6c4d6; box-shadow: inset 1px 1px 2px #fff, inset -2px -2px 4px #9caec455, 0 5px 8px #1d35531a; perspective: 250px; }
.lever-well::before { content: ""; position: absolute; inset: 12px 18px 17px; border-radius: 14px; background: linear-gradient(90deg,#5d6a7c,#192636 45%,#6f7d90); box-shadow: inset 0 2px 5px #101b30; }
.lever-indicator { position: absolute; bottom: 7px; left: 23px; width: 12px; height: 3px; border-radius: 3px; background: #72a4f7; box-shadow: 0 0 5px #729bf8; }
.lever-socket { position: absolute; left: 18px; bottom: 20px; width: 22px; height: 15px; border-radius: 50%; background: linear-gradient(#9facbd,#43546b); border: 1px solid #c9d4df; }
.lever-arm { position: absolute; left: 16px; bottom: 27px; width: 28px; height: 52px; transform-origin: 50% 100%; transform: rotateX(-12deg); filter: drop-shadow(2px 3px 2px #26395355); }
.lever-shaft { position: absolute; left: 10px; bottom: 0; width: 8px; height: 40px; border-radius: 4px; background: linear-gradient(90deg,#54677e,#f8fcff 35%,#adbfce 65%,#45556a); }
.lever-knob { position: absolute; top: 0; left: 0; width: 28px; height: 28px; border-radius: 50%; background: radial-gradient(circle at 32% 24%,#fff0f2 0%,#ffadb9 12%,#ed526f 35%,#a62048 76%,#621b39); box-shadow: inset -2px -3px 4px #64193366, inset 1px 1px 2px #fff8; }
.plugin-lever:hover:not(:disabled) .lever-knob { filter: brightness(1.12); }
.plugin-lever:focus-visible { outline: 2px solid #7c9cf0; outline-offset: 4px; border-radius: 14px; }
.plugin-lever.pulled .lever-arm { animation: lever-pull .85s cubic-bezier(.25,.8,.3,1); }
.plugin-lever.working .lever-indicator { background: #ab8cff; box-shadow: 0 0 8px #a67fff; animation: lever-status 1s ease-in-out infinite alternate; }
.plugin-lever:disabled { cursor: default; }
.plugin-lever:disabled:not(.working):not(.pulled) { opacity: .55; }
.lever-error { position: absolute; bottom: 115px; right: 0; width: 210px; padding: 8px; border-radius: 8px; background: var(--surface,#fff); color: #b45151; font-size: 11px; box-shadow: 0 3px 15px #18283c22; }
@keyframes lever-pull { 0% { transform: rotateX(-12deg); } 35%,55% { transform: rotateX(-115deg) translateY(3px); } 78% { transform: rotateX(8deg); } 100% { transform: rotateX(-12deg); } }
@keyframes lever-status { to { opacity: .4; } }
@media (prefers-reduced-motion: reduce) { .plugin-lever.pulled .lever-arm, .plugin-lever.working .lever-indicator { animation: none; } .plugin-lever.pulled .lever-arm { transform: rotateX(-65deg); } }
:root[data-theme="dark"] { --text-secondary:#b5bbc8;--surface:#252a34;color-scheme:dark }
:root[data-theme="dark"] .lever-error { color:#f28d98; }
:root[data-theme="dark"] .lever-well { background: linear-gradient(125deg,#465366,#202a39); border-color: #536077; box-shadow: inset 1px 1px 2px #8190a344,0 5px 8px #0004; }


</style></head><body><div class="plugin-lever-wrap"><button type="button" class="plugin-lever"><span class="lever-well" aria-hidden="true"><span class="lever-indicator"></span><span class="lever-socket"></span><span class="lever-arm"><span class="lever-shaft"></span><span class="lever-knob"></span></span></span></button><span class="lever-error" role="alert"></span></div><script>
let snapshot, pulled=false;
const button=document.querySelector('button');
function render(){if(!snapshot)return; const {view,context,busy,error}=snapshot;
const running=view.data.running; button.className='plugin-lever '+(pulled?'pulled ':'')+(running?'working':'');
button.disabled=!!(busy||running||pulled||context.disabled||!context.selection?.profileId||!context.selection?.model);
const zh=context.locale?.startsWith('zh');
button.title=error||(running?(zh?'正在提取记忆…':'Extracting memories…'):(zh?'拉动摇杆，从当前对话提取值得记住的信息':'Pull to extract useful memories from this conversation'));button.setAttribute('aria-label',view.title);button.setAttribute('aria-busy',String(running));
document.querySelector('.lever-error').textContent=error||'';
document.documentElement.dataset.theme=context.theme;}
addEventListener('message',event=>{if(event.source!==parent||event.data?.type!=='plugin:snapshot')return;snapshot=event.data;render()});
button.onclick=()=>{pulled=true;render();parent.postMessage({type:'plugin:action',action:'extract',value:JSON.stringify(snapshot.context.selection)},'*');setTimeout(()=>{pulled=false;render()},850)};
parent.postMessage({type:'plugin:ready'},'*');
</script></body></html>`;

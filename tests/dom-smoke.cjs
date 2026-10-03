// npm install --no-save jsdom; node tests/dom-smoke.cjs
// DOM/event integration checks. Canvas is mocked; this is not a browser pixel/gesture test.
const {JSDOM,VirtualConsole}=require('jsdom');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const delay=()=>new Promise(r=>setTimeout(r,70));
function open(source) {
    const errors=[],vconsole=new VirtualConsole();vconsole.on('jsdomError',e=>errors.push(e));
    source=source.replace(/<script src="\.\/([^"]+)"><\/script>/g,(_,file)=>'<script>'+fs.readFileSync(path.join(root,file.split('?')[0]),'utf8').replace(/<\/script/gi,'<\\/script')+'</script>');
    const dom=new JSDOM(source,{url:'https://test.invalid/font-editor/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vconsole,beforeParse(w){
        w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;w.alert=()=>{};w.confirm=()=>true;
        w.fetch=async url=>{const file=path.join(root,new URL(String(url),w.document.baseURI).pathname.replace(/^\/font-editor\//,''));return new Response(fs.readFileSync(file));};
        w.HTMLCanvasElement.prototype.getContext=function(){return new Proxy({canvas:this,getImageData:(x,y,width,height)=>({data:new Uint8ClampedArray(width*height*4).fill(255)}),createLinearGradient:()=>({addColorStop(){}}),measureText:()=>({width:20})},{get:(o,k)=>k in o?o[k]:()=>{}});};
        w.HTMLCanvasElement.prototype.toDataURL=()=> 'data:image/png;base64,';
    }});
    return {dom,w:dom.window,errors};
}
async function importFont(w,name){const input=w.document.getElementById('fontFileInput');Object.defineProperty(input,'files',{configurable:true,value:[new w.File([fs.readFileSync(path.join(__dirname,'generated',name+'.ttf'))],name+'.ttf')]});input.dispatchEvent(new w.Event('change'));await delay();}
(async()=>{
    const {dom,w,errors}=open(html);await delay();await delay();assert.equal(errors.length,0,errors.map(e=>e.message).join('\n'));
    assert.equal(w.document.querySelectorAll('.workspace-header').length,1);
    assert.equal(w.document.querySelector('[href="./legacy.html"]'),null);
    await importFont(w,'plain');assert.equal(w.eval('state.fontName'),'plain.ttf');
    const size=w.document.getElementById('globalSize');size.value='96';size.dispatchEvent(new w.Event('input'));await delay();assert.equal(w.eval('state.global.size'),96);
    const buffer=await w.eval('runExport({capture:true})');fs.writeFileSync(path.join(__dirname,'generated','dom-export.ttf'),Buffer.from(buffer));
    await importFont(w,'source');assert.equal(w.eval('state.global.size'),48);assert.equal(w.document.getElementById('globalSizeNum').value,'48');
    await importFont(w,'source');assert.equal(w.eval('state.fontName'),'source.ttf');assert.equal(w.document.getElementById('fontFileInput').value,'');
    w.eval('state.mainSwapUndo=[{buffer:state.fontBuffer}]');
    w.eval('state.replacementTarget={buffer:state.fontBuffer,font:state.font,name:"target.ttf",type:"ttf"};setReplacementTargetAsMain()');
    assert.equal(w.eval('state.mainSwapUndo.length'),0);assert.equal(w.eval('state.replacementTarget'),null);
    // Bundle all real scripts/CSS; mock only the unchanged optional WASM payload.
    let saved='';w.fontStudioTemplate=html;w.downloadText=(text)=>saved=text;w.readVfPayloadResources=async()=>({'fixture.wasm':'Zml4dHVyZQ=='});
    await w.saveThemeToHtml();assert(saved.includes('fixture.wasm'));assert(!saved.includes('<script src='));assert(!saved.includes('href="./assets/styles.css"'));
    const packaged=open(saved);await delay();await delay();assert.equal(packaged.errors.length,0,packaged.errors.map(e=>e.message).join('\n'));assert.equal(packaged.w.document.querySelectorAll('.workspace-header').length,1);
    await importFont(packaged.w,'plain');assert.equal(packaged.w.eval('state.fontName'),'plain.ttf');
    assert.equal(errors.length,0,errors.map(e=>e.message).join('\n'));
    packaged.dom.window.close();dom.window.close();console.log('PASS DOM initialization, import/reset, same-file import, export, target switch and self-contained HTML reload');
})().catch(e=>{console.error(e);process.exitCode=1});

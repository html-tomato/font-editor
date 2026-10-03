// Run after: python tests/make-fixtures.py
// Exercises the shipped font libraries and export functions without a browser DOM.
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert/strict');
const {execFileSync}=require('child_process');
const root = path.join(__dirname, '..'), generated = path.join(__dirname, 'generated');
const controls = new Map(), frames = [];
function element(id) {
    if (!controls.has(id)) controls.set(id, { id, value: id === 'workspaceZoom' ? 70 : '', textContent:'', disabled:false,
        style:{}, classList:{remove(){},add(){},toggle(){}}, parentElement:{getBoundingClientRect:()=>({width:320,height:100})} });
    return controls.get(id);
}
function context2d() { return new Proxy({draws:[], getImageData:(x,y,w,h)=>({data:new Uint8ClampedArray(w*h*4)})}, {get(o,k){return k in o ? o[k] : (...args)=>{if(k==='moveTo')o.draws.push(args);}}}); }
const sandbox = {console, setTimeout, clearTimeout, Uint8Array, Uint8ClampedArray, ArrayBuffer, DataView,
    TextEncoder, TextDecoder, atob, btoa, Map, Set, Blob, Response, URL,
    navigator:{userAgent:'Regression'}, alert:msg=>{throw Error(msg)}, confirm:()=>true,
    requestAnimationFrame:fn=>{frames.push(fn);return frames.length;}, cancelAnimationFrame(){},
    document:{getElementById:element, querySelectorAll:()=>[...controls.values()]},
    logStatus(){}, uiText:x=>x, ImageTracer:{},
    state:{font:null,fontBuffer:null,fontType:'ttf',fontName:'test',specific:{},glyphs:[],replacementFonts:[]},
    ADJUSTMENT_DEFAULTS:{size:48,letterSpacing:0,weight:400,lineHeight:1.4,baseline:0},
    v5SwapRows:[], v5SwapApplied:{}, v5PreviewColorCache:{buffer:null,data:null}, ordinaryExportBusy:false, previewFrame:0,
    V5_LANGUAGE_CODE_SET:new Set(), v5ScriptRegex:new Map(), originEditState:{session:0},
    V5_COLOR_TABLE_TAGS:['COLR','CPAL','SVG ','sbix','CBDT','CBLC','EBDT','EBLC'],
};
sandbox.CTRL_DEFAULTS={...sandbox.ADJUSTMENT_DEFAULTS,fine:50,brightness:100,hue:0};
sandbox.GLOBAL_EXCLUDE_DEFAULTS={...sandbox.CTRL_DEFAULTS,color:'#000000'};
sandbox.$=element; sandbox.window=sandbox; sandbox.self=sandbox;
const ctx=vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root,'assets/00.js'),'utf8'),ctx);
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
vm.runInContext(html.match(/<script[^>]*id="fecSrc"[^>]*>([\s\S]*?)<\/script>/)[1],ctx);
for (const file of ['03.js','04.js']) {
    const source=fs.readFileSync(path.join(root,'assets',file),'utf8');
    for (const match of source.matchAll(/^        (?:async )?function [A-Za-z\d_]+[^\n]*/gm)) {
        const first=match[0], end=first.endsWith('}') ? match.index+first.length : source.indexOf('\n        }',match.index)+10;
        assert(end>match.index,'function boundary'); vm.runInContext(source.slice(match.index,end),ctx);
    }
}
ctx.loadCore=async()=>ctx.FontEditorCore;
ctx.logStatus=()=>{}; ctx.uiText=x=>x;
ctx.previewOrig=element('previewOrig');ctx.previewMod=element('previewMod');ctx.ctxOrig=context2d();ctx.ctxMod=context2d();
function bytes(name){ const b=fs.readFileSync(path.join(generated,name+'.ttf'));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength); }
function load(name='plain') {
    ctx.state.fontBuffer=bytes(name);ctx.state.font=ctx.opentype.parse(ctx.state.fontBuffer);ctx.state.fontType='ttf';
    ctx.state.global={...ctx.GLOBAL_EXCLUDE_DEFAULTS,exclude:''};ctx.state.specific={};ctx.state.glyphs=[];
    ctx.state.replacementFonts=[];ctx.state.replacementTarget=null;
}
function save(name,b){fs.writeFileSync(path.join(generated,name+'.ttf'),Buffer.from(b));}
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS',name);}
(async()=>{
    await test('no edits preserve original bytes',async()=>{load();assert.equal(await ctx.runExport({capture:true}),ctx.state.fontBuffer);});
    await test('scale and preserve original layout/name/UVS',async()=>{load();ctx.state.global.size=96;const b=await ctx.runExport({capture:true});save('scaled',b);const p=ctx.opentype.parse(b);assert.equal(p.charToGlyph('A').advanceWidth,1200);for(const tag of ['GSUB','GDEF','GPOS','name'])assert.deepEqual(ctx.readTableBytes(b,tag),ctx.readTableBytes(ctx.state.fontBuffer,tag));});
    await test('baseline export translates outlines',async()=>{load();ctx.state.global.baseline=12;const b=await ctx.runExport({capture:true});save('baseline',b);assert.equal(ctx.opentype.parse(b).charToGlyph('A').getBoundingBox().y1,-250);});
    await test('specific adjustment leaves compound-dependent glyph unchanged',async()=>{load();ctx.state.specific.A={...ctx.GLOBAL_EXCLUDE_DEFAULTS,size:96};const b=await ctx.runExport({capture:true});save('specific',b);const p=ctx.opentype.parse(b);assert.equal(p.charToGlyph('A').advanceWidth,1200);assert.equal(p.charToGlyph('Á').getBoundingBox().y2,800);assert.equal(p.charToGlyphIndex('A'),ctx.state.font.charToGlyphIndex('A'));});
    await test('shared aliases: no double-scale; excluded alias unchanged',async()=>{load('alias');ctx.state.global.size=96;ctx.state.specific.A={...ctx.GLOBAL_EXCLUDE_DEFAULTS,size:72};let b=await ctx.runExport({capture:true});save('alias-specific',b);let p=ctx.opentype.parse(b);assert.equal(p.charToGlyph('A').advanceWidth,900);assert.equal(p.charToGlyph('B').advanceWidth,1200);load('alias');ctx.state.global.size=96;ctx.state.global.exclude='A';b=await ctx.runExport({capture:true});p=ctx.opentype.parse(b);assert.equal(p.charToGlyph('A').advanceWidth,600);assert.equal(p.charToGlyph('B').advanceWidth,1200);});
    await test('layout aliases fail explicitly rather than lose shaping',async()=>{load('alias-layout');ctx.state.global.size=96;ctx.state.global.exclude='A';await assert.rejects(ctx.runExport({capture:true}),/共用/);assert.equal(ctx.ordinaryExportBusy,false);});
    await test('line spacing uses the same UPM distance in preview and output',async()=>{load();ctx.state.global.lineHeight=.8;const b=await ctx.runExport({capture:true});save('lineheight',b);const h=ctx.opentype.parse(b).tables.hhea;assert.equal(h.ascender-h.descender+h.lineGap,800);assert(Math.abs(ctx.previewLineMetrics(ctx.state.font,ctx.state.global).boxHeight-38.4)<1e-9);assert(Math.abs(ctx.previewLineMetrics(ctx.state.font,{lineHeight:1.4}).boxHeight-62.4)<1e-9);});
    await test('contrast alone creates an exported color instead of original bytes',async()=>{load();ctx.state.global.fine=0;const b=await ctx.runExport({capture:true});save('contrast',b);assert.notEqual(b,ctx.state.fontBuffer);const c=ctx.parseColrCpalV0(b);assert.equal(c.cpal.palettes[0][0].r,128);});
    await test('specific black overrides global red',async()=>{load();ctx.state.global.color='#ff0000';ctx.state.specific.A={...ctx.GLOBAL_EXCLUDE_DEFAULTS};const b=await ctx.runExport({capture:true});const c=ctx.parseColrCpalV0(b);assert.equal(c.entries.has(ctx.state.font.charToGlyphIndex('A')),false);assert(c.entries.has(ctx.state.font.charToGlyphIndex('V')));});
    await test('native color shared layers scale once and retain palettes',async()=>{load('color');ctx.state.global.size=96;const b=await ctx.runExport({capture:true});save('color-scaled',b);const c=ctx.parseColrCpalV0(b);assert.equal(c.cpal.numPalettes,2);const a=c.entries.get(ctx.state.font.charToGlyphIndex('A')),v=c.entries.get(ctx.state.font.charToGlyphIndex('V'));const p=ctx.opentype.parse(b);assert.equal(p.glyphs.get(a.layerGlyphIds[0]).getBoundingBox().x2,1000);assert.equal(p.glyphs.get(v.layerGlyphIds[0]).getBoundingBox().x2,1000);});
    await test('replacement keeps glyph ID and target layout/name',async()=>{load();const source={buffer:bytes('source'),type:'ttf',chars:'A',languages:[]};source.font=ctx.opentype.parse(source.buffer);const b=(await ctx.v5BuildReplacedBuffer({buffer:ctx.state.fontBuffer,type:'ttf'},[source])).buffer;save('replaced',b);const p=ctx.opentype.parse(b);assert.equal(p.charToGlyphIndex('A'),ctx.state.font.charToGlyphIndex('A'));assert.equal(p.charToGlyph('A').advanceWidth,800);assert.deepEqual(ctx.readTableBytes(b,'GSUB'),ctx.readTableBytes(ctx.state.fontBuffer,'GSUB'));});
    await test('native color filtering retains alpha and every palette',async()=>{load('color');ctx.state.global.brightness=50;const b=await ctx.runExport({capture:true});save('color-filtered',b);const c=ctx.parseColrCpalV0(b),e=c.entries.get(ctx.state.font.charToGlyphIndex('A'));assert.equal(c.cpal.palettes[0][e.paletteIndices[0]].a,128);assert.equal(c.cpal.palettes[0][e.paletteIndices[0]].r,128);assert.equal(c.cpal.palettes[1][e.paletteIndices[0]].b,128);});
    await test('swap keeps IDs and original shaping rules',async()=>{load();const b=await ctx.v5BuildSwappedBuffer({buffer:ctx.state.fontBuffer,type:'ttf'},new Map([['A','V'],['V','A']]));save('swapped',b);const p=ctx.opentype.parse(b);assert.equal(p.charToGlyphIndex('A'),ctx.state.font.charToGlyphIndex('A'));assert.equal(p.charToGlyph('A').getBoundingBox().x2,450);assert.equal(p.charToGlyph('V').getBoundingBox().x2,500);});
    await test('swap of self-referencing color layers uses original shapes',async()=>{load('color-self');const b=await ctx.v5BuildSwappedBuffer({buffer:ctx.state.fontBuffer,type:'ttf'},new Map([['A','V'],['V','A']]));save('color-swapped',b);const p=ctx.opentype.parse(b),c=ctx.parseColrCpalV0(b);assert.equal(p.glyphs.get(c.entries.get(p.charToGlyphIndex('A')).layerGlyphIds[0]).getBoundingBox().x2,450);assert.equal(p.glyphs.get(c.entries.get(p.charToGlyphIndex('V')).layerGlyphIds[0]).getBoundingBox().x2,500);});
    await test('VF instancing runs shipped Python job and removes variable layout data',async()=>{
        const globals={};
        ctx.loadVfCompiler=async()=>({FS:{writeFile:(file,b)=>save('static-source',b),readFile:()=>new Uint8Array(bytes('static-output')),unlink(){}},globals:{set:(k,v)=>globals[k]=v,delete:k=>delete globals[k]},runPythonAsync:async code=>{
            code=code.replaceAll('/static-source.ttf',path.join(generated,'static-source.ttf')).replaceAll('/static-output.ttf',path.join(generated,'static-output.ttf'));
            execFileSync('python',['-c',`static_coords_json=${JSON.stringify(globals.static_coords_json)}\n${code}`]);
        }});
        const b=await ctx.v5VfSolidify(ctx.FontEditorCore,bytes('variable'),{wght:600},()=>{});save('staticized',b);
        assert.equal(ctx.v5SfntTags(b).has('fvar'),false);assert.equal(ctx.v5SfntTags(b).has('HVAR'),false);assert.equal(ctx.opentype.parse(b).charToGlyph('A').advanceWidth,750);
        assert(ctx.readTableBytes(b,'GSUB'));assert(ctx.readTableBytes(b,'GPOS'));
    });
    await test('preview wraps and bounds allocations under extreme input',async()=>{load();ctx.state.global.size=120;ctx.state.global.baseline=30;const canvas=element('testPreview');ctx.renderText(context2d(),canvas,'A'.repeat(2000),ctx.state.font,ctx.state,true);assert(canvas.width<=2048);assert(canvas.height<=4096);assert(canvas.width*canvas.height<=4*1024*1024);const c=context2d();ctx.renderText(c,canvas,'A\nV',ctx.state.font,ctx.state,true);assert(c.draws.length>0);});
    await test('high-frequency redraws coalesce in one frame',async()=>{frames.length=0;ctx.previewFrame=0;for(let i=0;i<100;i++)ctx.renderAll();assert.equal(frames.length,1);});
    await test('bad config rejected before state changes',async()=>{load();assert.throws(()=>ctx.normalizeConfig({global:{size:100000}}),/超出/);assert.equal(ctx.state.global.size,48);assert.throws(()=>ctx.normalizeConfig({specific:{A:{baseline:1e9}}}),/超出/);});
    const realFont=process.env.FONT_TEST_SAMPLE;
    if(realFont) await test('real multi-thousand-glyph font preserves layout and glyph IDs',async()=>{
        load();const raw=fs.readFileSync(realFont);ctx.state.fontBuffer=raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength);ctx.state.font=ctx.opentype.parse(ctx.state.fontBuffer);ctx.state.global.size=72;
        const b=await ctx.runExport({capture:true});save('real-font',b);const p=ctx.opentype.parse(b);
        assert.equal(p.numGlyphs,ctx.state.font.numGlyphs);for(const ch of ['A','V','é','ﬃ']){assert.equal(p.charToGlyphIndex(ch),ctx.state.font.charToGlyphIndex(ch));assert(Math.abs(p.charToGlyph(ch).advanceWidth-ctx.state.font.charToGlyph(ch).advanceWidth*1.5)<=1);}
        for(const tag of ['name','GSUB','GDEF','GPOS','kern'])assert.deepEqual(ctx.readTableBytes(b,tag),ctx.readTableBytes(ctx.state.fontBuffer,tag));
    });
    await test('switching fonts clears edits, repairs, swap and replacement state',async()=>{load();ctx.state.global.size=96;ctx.state.specific.A={size:96};ctx.state.glyphs=[{char:'A'}];ctx.state.replacementTarget={};ctx.state.replacementFonts=[{}];ctx.state.mainSwapUndo=[{}];for(const fn of ['syncGlobalControls','renderGlyphList','renderReplacementFonts','renderReplacementTarget','renderSwapRows'])ctx[fn]=()=>{};ctx.resetFontEdits();assert.equal(ctx.state.global.size,48);assert.equal(ctx.state.glyphs.length,0);assert.equal(ctx.state.replacementFonts.length,0);assert.equal(ctx.state.mainSwapUndo.length,0);assert.equal(Object.keys(ctx.state.specific).length,0);});
    console.log(`Passed ${passed} regression cases`);
})().catch(e=>{console.error(e);process.exitCode=1});

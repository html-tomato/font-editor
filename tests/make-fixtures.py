from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
from fontTools.colorLib.builder import buildCOLR, buildCPAL
from fontTools.designspaceLib import DesignSpaceDocument, AxisDescriptor, SourceDescriptor
from fontTools.varLib import build

OUT = Path(__file__).parent / 'generated'
OUT.mkdir(exist_ok=True)

def make(name, width=600, layout=True, alias=False, color=False):
    glyphs = ['.notdef','space','A','V','f','i','fi','Aacute','layer']
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(glyphs)
    mapping = {32:'space',65:'A',86:'V',102:'f',105:'i',193:'Aacute'}
    if alias: mapping[66] = 'A'
    fb.setupCharacterMap(mapping)
    outlines = {}
    for glyph in glyphs:
        pen = TTGlyphPen(outlines)
        if glyph == 'Aacute':
            pen.addComponent('A', (1,0,0,1,0,100))
        elif glyph != 'space':
            right = width - (150 if glyph == 'V' else 100)
            pen.moveTo((50,0)); pen.lineTo((right,0)); pen.lineTo((right,700)); pen.lineTo((50,700)); pen.closePath()
        outlines[glyph] = pen.glyph()
    fb.setupGlyf(outlines)
    fb.setupHorizontalMetrics({g:(width,50) for g in glyphs})
    fb.setupHorizontalHeader(ascent=900, descent=-300, lineGap=100)
    fb.setupNameTable({'familyName':'Regression字体','styleName':'Regular','uniqueFontIdentifier':name,'fullName':name,'psName':name})
    fb.setupOS2(sTypoAscender=800,sTypoDescender=-200,sTypoLineGap=150,usWinAscent=1000,usWinDescent=300)
    fb.setupPost(); fb.setupMaxp()
    font = fb.font
    uvs = CmapSubtable.newSubtable(14); uvs.platformID=0; uvs.platEncID=5; uvs.language=0; uvs.cmap={}; uvs.uvsDict={0xFE00:[(65,'V')]}
    font['cmap'].tables.append(uvs)
    if layout:
        addOpenTypeFeaturesFromString(font, 'feature liga { sub f i by fi; } liga; feature kern { pos A V %d; } kern; table GDEF { GlyphClassDef [A V f i], [fi], [], []; } GDEF;' % -int(width*80/600))
    if color:
        font['COLR'] = buildCOLR({'A':[('layer',0)], 'V':[('layer',0)]}, version=0, glyphMap=font.getReverseGlyphMap())
        font['CPAL'] = buildCPAL([[(1,0,0,.5)],[(0,0,1,.5)]])
    font.save(OUT / (name+'.ttf'))
    return font

make('plain'); make('alias',layout=False,alias=True); make('alias-layout',alias=True)
make('source',width=800); make('color',color=True)
selfcolor=make('color-self',color=True)
selfcolor['COLR']=buildCOLR({'A':[('A',0)],'V':[('V',0)]},version=0,glyphMap=selfcolor.getReverseGlyphMap())
selfcolor.save(OUT/'color-self.ttf')
ds = DesignSpaceDocument(); axis=AxisDescriptor();axis.name='Weight';axis.tag='wght';axis.minimum=400;axis.default=400;axis.maximum=800;ds.addAxis(axis)
for weight,width in [(400,600),(800,900)]:
    source=SourceDescriptor();source.name=str(weight);source.location={'Weight':weight};source.font=make('master-'+str(weight),width=width);source.copyInfo=weight==400;source.copyFeatures=weight==400;ds.addSource(source)
vf,_,_=build(ds);vf.save(OUT/'variable.ttf')
print('Generated regression fonts in', OUT)

from pathlib import Path
from fontTools.ttLib import TTFont
import struct

folder = Path(__file__).parent / 'generated'
outputs = ['scaled','baseline','specific','alias-specific','lineheight','contrast','color-scaled','replaced','color-filtered','swapped','color-swapped','staticized']
for name in outputs:
    file = folder / (name + '.ttf')
    raw = file.read_bytes()
    padded = raw + b'\0' * (-len(raw) % 4)
    assert sum(struct.unpack('>%dI' % (len(padded)//4), padded)) & 0xFFFFFFFF == 0xB1B0AFBA, name
    font = TTFont(file, lazy=False, checkChecksums=2)
    order = font.getGlyphOrder()
    for tag in font.keys():
        if tag != 'GlyphOrder': font[tag]  # Force independent decompilation of every table.
    for glyph in font['glyf'].glyphs.values():
        if glyph.isComposite():
            assert all(c.glyphName in order for c in glyph.components), name
    uvs = next(t for t in font['cmap'].tables if t.format == 14)
    assert uvs.uvsDict[0xFE00][0][0] == 65
    assert font.getGlyphID(uvs.uvsDict[0xFE00][0][1]) == 3, name
    if name == 'staticized':
        assert not {'fvar','gvar','HVAR','MVAR','avar'} & set(font.keys())
        assert font['GPOS'].table.LookupList.Lookup[0].SubTable[0].PairSet[0].PairValueRecord[0].Value1.XAdvance == -100
    font.close()
    print('PASS independent table/checksum validation:', name)

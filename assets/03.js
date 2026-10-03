
        // ============================================================
        //  完整 JavaScript
        // ============================================================
        const logEl = document.getElementById('statusLog');

        function logStatus(msg, type = 'info') {
            const time = new Date().toLocaleTimeString();
            const cls = type === 'error' ? 'error' : (type === 'success' ? 'success' : 'info');
            const row = document.createElement('div');
            row.className = cls;
            row.textContent = `[${time}] ${msg}`;
            logEl.appendChild(row);
            logEl.scrollTop = logEl.scrollHeight;
            console.log(`[${type}] ${msg}`);
        }
        logStatus('页面加载完成，检测库...');

        if (typeof opentype === 'undefined') logStatus('❌ opentype.js 未加载', 'error');
        else logStatus('✅ opentype.js 已加载', 'success');
        if (typeof ImageTracer === 'undefined') logStatus('❌ 矢量化组件未加载', 'error');
        else logStatus('✅ 矢量化组件已加载', 'success');

        // ===== 状态 =====
        const state = {
            font: null,
            fontBuffer: null,
            fontType: 'ttf',
            fontName: '未加载',
            global: { size: 48, letterSpacing: 0, weight: 400, lineHeight: 1.4, baseline: 0, color: '#000000',
                fine: 50, brightness: 100, hue: 0, exclude: '' },
            specific: {},
            glyphs: [],
            _glyphId: 0,
            originEdit: {
                glyphId: null,
                glyphData: null,
                referenceCanvas: null,
                originalCanvas: null,
                repairCanvas: null,
                extraCanvas: null,
                refVisible: true,
                boundsVisible: true,
                tool: 'brush',
                layer: 'repair',
                color: '#000000',
                brushSize: 6,
                selectionMask: null,
                selectionLayer: null,
                selectMode: 'new',
                lockTransparency: false,
                shapeType: 'rect',
                shapeFill: true,
                fontBounds: null,
                view: { panX: 0, panY: 0, zoom: 1, rotate: 0 },
                transforms: {
                    original: { x: 0, y: 0, scale: 1, rotate: 0 },
                    repair: { x: 0, y: 0, scale: 1, rotate: 0 },
                    extra: { x: 0, y: 0, scale: 1, rotate: 0 }
                },
                char: '',
                initialized: false,
                session: 0
            }
        };
        const ADJUSTMENT_DEFAULTS = Object.freeze({ size: 48, letterSpacing: 0, weight: 400, lineHeight: 1.4, baseline: 0 });
        // 「未调整」的哨兵值：控件停在这些值上就表示不写、不参与任何计算（导出即原字体）
        const CTRL_DEFAULTS = Object.freeze({ ...ADJUSTMENT_DEFAULTS, fine: 50, brightness: 100, hue: 0 });
        const ctrlValText = (key, v) => (CTRL_DEFAULTS[key] !== undefined && Number(v) === CTRL_DEFAULTS[key]) ? '原样' : String(v);

        const $ = id => document.getElementById(id);
        const previewOrig = $('previewOrig');
        const previewMod = $('previewMod');
        const ctxOrig = previewOrig.getContext('2d', { willReadFrequently: true });
        const ctxMod = previewMod.getContext('2d', { willReadFrequently: true });

        // ===== 颜色工具 =====
        function hexToRgb(hex) {
            const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
            return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } :
            null;
        }

        function rgbToHex(r, g, b) {
            return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
        }

        function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

        // 与预览 ctx.filter = hue-rotate(H) brightness(B) contrast(C) 一致（C = fine/50）
        function applyColorStyle(color, hue, brightness, fine) {
            let { r, g, b } = color;
            if (hue) {
                const angle = hue * Math.PI / 180, c = Math.cos(angle), t = Math.sin(angle);
                const nr = (.213 + .787*c - .213*t)*r + (.715 - .715*c - .715*t)*g + (.072 - .072*c + .928*t)*b;
                const ng = (.213 - .213*c + .143*t)*r + (.715 + .285*c + .140*t)*g + (.072 - .072*c - .283*t)*b;
                const nb = (.213 - .213*c - .787*t)*r + (.715 - .715*c + .715*t)*g + (.072 + .928*c + .072*t)*b;
                r = clamp(nr,0,255); g = clamp(ng,0,255); b = clamp(nb,0,255);
            }
            if (brightness !== undefined && brightness !== 100) {
                const f = brightness / 100;
                r = clamp(r*f,0,255); g = clamp(g*f,0,255); b = clamp(b*f,0,255);
            }
            const ct = (fine ?? 50) / 50;
            if (ct !== 1) {
                r = (r - 127.5) * ct + 127.5; g = (g - 127.5) * ct + 127.5; b = (b - 127.5) * ct + 127.5;
            }
            return { r: Math.round(clamp(r, 0, 255)), g: Math.round(clamp(g, 0, 255)), b: Math.round(clamp(b, 0, 255)), a: color.a ?? 255 };
        }

        function escapeAttribute(value) {
            return String(value ?? '').replace(/[&"'<>`]/g, ch => ({
                '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;', '`': '&#96;'
            })[ch]);
        }

        function singleCharacter(value) {
            const chars = [...String(value ?? '')];
            return chars.length === 1 ? chars[0] : null;
        }

        function moveArrayItem(list, from, to) {
            if (!Array.isArray(list) || from < 0 || from >= list.length) return false;
            const target = clamp(to, 0, list.length - 1);
            if (from === target) return false;
            const [item] = list.splice(from, 1);
            list.splice(target, 0, item);
            return true;
        }

        function gestureGeometry(points) {
            const [a, b] = points;
            const dx = b.x - a.x, dy = b.y - a.y;
            return { centerX: (a.x + b.x) / 2, centerY: (a.y + b.y) / 2,
                distance: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) * 180 / Math.PI };
        }

        function inverseTransformPoint(point, transform, centerX, centerY) {
            const dx = point.x - centerX - (transform.x ?? transform.panX ?? 0);
            const dy = point.y - centerY - (transform.y ?? transform.panY ?? 0);
            const angle = -(transform.rotate || 0) * Math.PI / 180;
            const cos = Math.cos(angle), sin = Math.sin(angle);
            const scale = transform.scale ?? transform.zoom ?? 1;
            return { x: (dx * cos - dy * sin) / scale + centerX,
                y: (dx * sin + dy * cos) / scale + centerY };
        }

        function transformPoint(point, transform, centerX, centerY) {
            const scale = transform.scale ?? transform.zoom ?? 1;
            const angle = (transform.rotate || 0) * Math.PI / 180;
            const dx = (point.x - centerX) * scale, dy = (point.y - centerY) * scale;
            const cos = Math.cos(angle), sin = Math.sin(angle);
            return { x: dx * cos - dy * sin + centerX + (transform.x ?? transform.panX ?? 0),
                y: dx * sin + dy * cos + centerY + (transform.y ?? transform.panY ?? 0) };
        }

        function applyCanvasTransform(ctx, transform, centerX, centerY) {
            ctx.translate(centerX + (transform.x ?? transform.panX ?? 0), centerY + (transform.y ?? transform.panY ?? 0));
            ctx.rotate((transform.rotate || 0) * Math.PI / 180);
            const scale = transform.scale ?? transform.zoom ?? 1;
            ctx.scale(scale, scale);
            ctx.translate(-centerX, -centerY);
        }

        function syncColorGroup(pickerId, rId, gId, bId, hexId, callback) {
            const picker = $(pickerId);
            const rInput = $(rId);
            const gInput = $(gId);
            const bInput = $(bId);
            const hexInput = $(hexId);
            if (!picker) return;
            const updateFromPicker = function() {
                const hex = picker.value;
                const rgb = hexToRgb(hex);
                if (rgb) { rInput.value = rgb.r;
                    gInput.value = rgb.g;
                    bInput.value = rgb.b;
                    hexInput.value = hex; if (callback) callback(hex); }
            };
            const updateFromRGB = function() {
                let r = clamp(parseInt(rInput.value) || 0, 0, 255);
                let g = clamp(parseInt(gInput.value) || 0, 0, 255);
                let b = clamp(parseInt(bInput.value) || 0, 0, 255);
                rInput.value = r;
                gInput.value = g;
                bInput.value = b;
                const hex = rgbToHex(r, g, b);
                picker.value = hex;
                hexInput.value = hex;
                if (callback) callback(hex);
            };
            const updateFromHex = function() {
                let val = hexInput.value.trim();
                if (!val.startsWith('#')) val = '#' + val;
                if (/^#[0-9a-f]{6}$/i.test(val)) {
                    const rgb = hexToRgb(val);
                    if (rgb) { rInput.value = rgb.r;
                        gInput.value = rgb.g;
                        bInput.value = rgb.b;
                        picker.value = val; if (callback) callback(val); }
                }
            };
            picker.addEventListener('input', updateFromPicker);
            rInput.addEventListener('input', updateFromRGB);
            gInput.addEventListener('input', updateFromRGB);
            bInput.addEventListener('input', updateFromRGB);
            hexInput.addEventListener('change', updateFromHex);
            hexInput.addEventListener('input', function() {
                let val = this.value.trim();
                if (val.length === 7 && /^#[0-9a-f]{6}$/i.test(val)) updateFromHex();
            });
            updateFromPicker();
        }

        // ===== 渲染 =====
        function drawPlaceholder(ctx, canvas, msg, bg = '#f8fafc') {
            const rect = canvas.parentElement.getBoundingClientRect();
            const w = rect.width || 300;
            const h = rect.height || 100;
            canvas.width = w;
            canvas.height = h;
            ctx.clearRect(0, 0, w, h);
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = '#94a3b8';
            ctx.font = '15px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(msg, w / 2, h / 2);
        }

        function getGlyphImage(glyph) {
            if (glyph._image && glyph._imageSource === glyph.imgData) return glyph._image;
            const img = new Image();
            glyph._image = img;
            glyph._imageSource = glyph.imgData;
            img.onload = () => renderAll();
            img.onerror = () => logStatus('❌ 修符图片无法显示，请重新导入该修符', 'error');
            img.src = glyph.imgData;
            return img;
        }

        // 图片修符导出会先二值化；预览改粗细时复用同一前景判定，白底图片不能直接按 alpha 膨胀成整块黑色。
        function getGlyphMonoPreview(glyph, img) {
            if (glyph._monoPreview && glyph._monoPreviewSource === glyph.imgData) return glyph._monoPreview;
            const canvas = document.createElement('canvas');
            const scale = Math.min(256 / img.naturalWidth, 256 / img.naturalHeight, 1);
            canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
            const cx = canvas.getContext('2d');
            cx.drawImage(img, 0, 0, canvas.width, canvas.height);
            binarizeForMonochrome(cx, canvas.width, canvas.height);
            const pixels = cx.getImageData(0, 0, canvas.width, canvas.height);
            for (let i = 0; i < pixels.data.length; i += 4) {
                pixels.data[i + 3] = 255 - pixels.data[i];
                pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 0;
            }
            cx.putImageData(pixels, 0, 0);
            glyph._monoPreview = canvas;
            glyph._monoPreviewSource = glyph.imgData;
            return canvas;
        }

        // 单色修符的粗细预览：在目标显示尺寸上对 alpha 做一圈膨胀/收缩，量级与普通字形描边一致。
        function drawWeightedSymbol(ctx, img, dx, dy, dw, dh, color, weight) {
            const w = Math.max(1, Math.round(dw)), h = Math.max(1, Math.round(dh));
            const strokeW = ((Number(weight) || 400) - 400) * (Math.max(w, h) || 48) / 10000;
            const radius = Math.round(Math.abs(strokeW) / 2);
            const pad = radius;
            const off = document.createElement('canvas');
            off.width = w + pad * 2; off.height = h + pad * 2;
            const octx = off.getContext('2d');
            octx.drawImage(img, pad, pad, w, h);
            octx.globalCompositeOperation = 'source-in';
            octx.fillStyle = color; octx.fillRect(0, 0, off.width, off.height);
            if (radius > 0) {
                const image = octx.getImageData(0, 0, off.width, off.height);
                const src = new Uint8ClampedArray(image.data), rgb = hexToRgb(color) || { r: 0, g: 0, b: 0 };
                const grow = strokeW > 0, ow = off.width, oh = off.height;
                for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
                    let alpha = grow ? 0 : 255;
                    for (let yy = y - radius; yy <= y + radius; yy++) for (let xx = x - radius; xx <= x + radius; xx++) {
                        const a = (xx < 0 || yy < 0 || xx >= ow || yy >= oh) ? 0 : src[(yy * ow + xx) * 4 + 3];
                        alpha = grow ? Math.max(alpha, a) : Math.min(alpha, a);
                    }
                    const i = (y * ow + x) * 4;
                    image.data[i] = rgb.r; image.data[i + 1] = rgb.g; image.data[i + 2] = rgb.b; image.data[i + 3] = alpha;
                }
                octx.globalCompositeOperation = 'source-over';
                octx.putImageData(image, 0, 0);
            }
            ctx.drawImage(off, dx - pad, dy - pad);
        }

        function renderText(ctx, canvas, text, font, stateObj, isModified) {
            const rect = canvas.parentElement.getBoundingClientRect();
            const minWidth = Math.max(1, Math.floor((rect.width || 300) / (Number(document.getElementById('workspaceZoom')?.value || 100) / 100)));
            const viewScale = Number(document.getElementById('workspaceZoom')?.value || 100) / 100;
            const styles = [state.global, ...Object.values(state.specific)];
            const previewSize = Math.max(48, ...styles.map(s => Number(s.size) || 48));
            const previewShift = Math.max(0, ...styles.map(s => Math.abs(Number(s.baseline) || 0)));
            const previewLines = String(text).split('\n').length;
            const fontHeightRatio = font ? ((font.ascender || 800) + Math.abs(font.descender || -200)) / (font.unitsPerEm || 1000) : 1.2;
            const desiredHeight = Math.ceil(Math.max((rect.height || 100) / viewScale, previewLines * previewSize * Math.max(fontHeightRatio, Number(state.global.lineHeight) || 1.4) + previewShift * 2 + 48));
            if (!font || text === '') {
                canvas.width = minWidth;
                canvas.height = Math.min(4096, desiredHeight);
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, minWidth, canvas.height);
                return;
            }

            const gs = stateObj ? stateObj.global : { size: 48, letterSpacing: 0, weight: 400, lineHeight: 1.4,
                baseline: 0, color: '#000000', fine: 50, brightness: 100, hue: 0 };
            const upm = font.unitsPerEm || 1000;
            const ascentRatio = (font.ascender ?? upm * 0.8) / upm;
            const descentRatio = Math.abs(font.descender ?? -upm * 0.2) / upm;
            const lines = String(text).slice(0, 2000).split('\n').map(line => [...line]);
            const excludeCodes = v5GlobalExcludeCodes();

            function recordFor(ch) {
                const glyph = isModified && stateObj ? stateObj.glyphs.find(g => g.char === ch) : null;
                const spec = isModified && stateObj ? stateObj.specific[ch] : null;
                const replacement = isModified && typeof window.replacementSourceForChar === 'function' ? window.replacementSourceForChar(ch) : null;
                const drawFont = replacement?.font || font;
                // 互换还没执行时，主页面预览里先按互换结果画（见 window.previewSwapChar）；只作用在“修改后”预览
                const drawChar = isModified && typeof window.previewSwapChar === 'function' ? window.previewSwapChar(ch, replacement) : ch;
                const style = { ...gs };
                // 「排除」里的字不套用全局调整：回落到未调整哨兵，再由修符自身参数与「指定」覆盖
                if (excludeCodes.has(ch.codePointAt(0))) Object.assign(style, GLOBAL_EXCLUDE_DEFAULTS);
                if (glyph) Object.assign(style, {
                    size: glyph.size, letterSpacing: glyph.letterSpacing,
                    baseline: glyph.yOffset, color: glyph.color,
                    fine: glyph.fine, brightness: glyph.brightness, hue: glyph.hue
                });
                // 字体调整里的“指定”优先级最高：修符/符号也必须能被单个或批量调整，不能被修符自身参数盖回去。
                if (spec) Object.assign(style, spec);
                const size = Number(style.size) || 48;
                let width;
                if (glyph) {
                    const iw = glyph.width || 48, ih = glyph.height || 48;
                    width = iw * size / Math.max(iw, ih, 1);
                } else {
                    try { width = drawFont.getAdvanceWidth(drawChar, size, { kerning: false }); }
                    catch (_) { width = size * 0.6; }
                }
                return { ch: drawChar, glyph, drawFont, style, size,
                    advance: Math.max(48 / upm, width + (Number(style.letterSpacing) || 0)) };
            }

            // 固定画布宽度，长文本按可见宽度换行；不创建数万像素宽的移动端画布。
            const w = Math.min(2048, Math.max(96, minWidth));
            const rows = [];
            const metrics = previewLineMetrics(font, gs);
            for (const line of lines) {
                let records = [], width = 0;
                const pushRow = () => { rows.push({ records, width, ...metrics }); records = []; width = 0; };
                const inputRecords = line.map(recordFor);
                for (let i = 0; i < inputRecords.length; i++) {
                    const r = inputRecords[i], next = inputRecords[i + 1];
                    if (!r.glyph && next && !next.glyph && r.drawFont === next.drawFont) {
                        try {
                            // 字形缩放不改写原 GPOS/kern 数值；预览也使用原字号下的字偶距。
                            const kern = r.drawFont.getKerningValue(r.drawFont.charToGlyph(r.ch), r.drawFont.charToGlyph(next.ch));
                            r.advance = Math.max(48 / upm, r.advance + kern * 48 / (r.drawFont.unitsPerEm || upm));
                        } catch (_) {}
                    }
                    if (records.length && width + r.advance > w - 24) pushRow();
                    records.push(r); width += r.advance;
                }
                pushRow();
            }
            const totalHeight = rows.length * metrics.boxHeight;
            const h = Math.min(4096, Math.floor(4 * 1024 * 1024 / w), Math.ceil(Math.max(desiredHeight, totalHeight + 48)));
            canvas.width = w;
            canvas.height = h;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            const visibleRows = rows.slice(0, Math.max(1, Math.floor((h - 24) / metrics.boxHeight)));
            let rowTop = Math.max(24, (h - totalHeight) / 2);

            for (const row of visibleRows) {
                const baselineY = rowTop + (row.boxHeight - row.contentHeight) / 2 + row.ascent;
                let x = (w - row.width) / 2;
                for (const record of row.records) {
                    const { glyph, drawFont, style, size, ch } = record;
                    const y = baselineY + (Number(style.baseline) || 0);
                    const color = style.color || '#000000';
                    const contrast = (Number(style.fine ?? 50)) / 50;
                    const brightness = Number(style.brightness ?? 100) / 100;
                    const hue = Number(style.hue) || 0;
                    ctx.save();
                    ctx.filter = (hue === 0 && brightness === 1 && contrast === 1) ? "none" : `hue-rotate(${hue}deg) brightness(${brightness}) contrast(${contrast})`;
                    if (glyph) {
                        const img = getGlyphImage(glyph);
                        if (img.complete && img.naturalWidth) {
                            const ratio = size / Math.max(img.naturalWidth, img.naturalHeight, 1);
                            const dw = img.naturalWidth * ratio, dh = img.naturalHeight * ratio;
                            const dx = x + (record.advance - (Number(style.letterSpacing) || 0) - dw) / 2 +
                                (Number(glyph.xOffset) || 0), dy = y - dh;
                            if (glyph.isSymbol) {
                                // 单色符号：按颜色重染，并让“指定粗细”在修改后预览里即时可见。
                                drawWeightedSymbol(ctx, img, dx, dy, dw, dh, color, style.weight);
                            } else if (!glyph.exportAsColor && Number(style.weight ?? 400) !== 400) {
                                // 图片导入的单色修符也会在导出时改轮廓；预览须用同一二值化前景，再模拟粗细。
                                drawWeightedSymbol(ctx, getGlyphMonoPreview(glyph, img), dx, dy, dw, dh, color, style.weight);
                            } else {
                                ctx.drawImage(img, dx, dy, dw, dh);
                            }
                        }
                    } else {
                        try {
                            const strokeW = ((Number(style.weight) || 400) - 400) * size / 10000;
                            // 字体自带彩色的字（COLR v0 + CPAL）：按原色逐层画，颜色不再被压成纯黑；粗细沿用同一套描边/侵蚀模拟
                            const colorInfo = v5PreviewColorLayers(v5PreviewBufferFor(drawFont));
                            const colorGid = colorInfo ? drawFont.charToGlyphIndex(ch) : 0;
                            if (!(colorInfo && colorGid && v5DrawColorGlyph(ctx, drawFont, colorInfo, colorGid, x, y, size, strokeW, color))) {
                                const path = drawFont.getPath(ch, x, y, size);
                                if (strokeW < 0) {
                                    drawThinnedPath(ctx, path, color, strokeW);
                                } else {
                                    path.fill = color;
                                    if (strokeW > 0) {
                                        path.stroke = color;
                                        path.strokeWidth = strokeW;
                                    }
                                    path.draw(ctx);
                                }
                            }
                        } catch (_) {
                            ctx.fillStyle = color;
                            ctx.font = `${Number(style.weight) || 400} ${size}px sans-serif`;
                            ctx.textBaseline = 'alphabetic';
                            ctx.fillText(ch, x, y);
                        }
                    }
                    ctx.restore();
                    x += record.advance;
                }
                rowTop += row.boxHeight;
            }
        }

        // ponytail: 预览的加粗靠给轮廓描边（描边宽 sw → 轮廓外扩 sw/2，正好等于导出里 delta 的像素值）；
        // 变细没有等价的“填色”写法，改为离屏绘制后按同一外扩量向内侵蚀，不用白描边擦，免得误伤相邻字形。
        function drawThinnedPath(ctx, path, color, strokeW) {
            const bb = path.getBoundingBox();
            const pad = Math.ceil(-strokeW) + 2;
            const ox = Math.floor(bb.x1 - pad), oy = Math.floor(bb.y1 - pad);
            const w = Math.ceil(bb.x2 + pad) - ox, h = Math.ceil(bb.y2 + pad) - oy;
            if (!(w > 0) || !(h > 0)) return;   // 空字形（如空格）的 bbox 是 NaN，这里一并挡掉
            const off = document.createElement('canvas');
            off.width = w;
            off.height = h;
            const octx = off.getContext('2d');
            octx.translate(-ox, -oy);
            path.fill = color;
            path.draw(octx);
            octx.globalCompositeOperation = 'destination-out';
            path.fill = null;
            path.stroke = '#000000';
            path.strokeWidth = -strokeW;
            path.draw(octx);
            ctx.drawImage(off, ox, oy);
        }

        // 墨迹纵向边界：扫画布非白像素的最上/最下，红蓝参考线共用
        function inkBoundsY(ctx, canvas) {
            const w = canvas.width, h = canvas.height;
            if (!w || !h) return null;
            const d = ctx.getImageData(0, 0, w, h).data;
            let top = -1, bottom = -1;
            for (let y = 0; y < h; y++) {
                const row = y * w * 4;
                for (let x = 0; x < w; x += 2) {
                    const i = row + x * 4;
                    if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) { if (top < 0) top = y; bottom = y; break; }
                }
            }
            return top < 0 ? null : { top, bottom };
        }

        // 边界参考线，只画在“修改后”画布：红=原字形最上/最下（仅参考，不限制突破），蓝=修改后预览文字全体最上/最下
        function drawBoundsLines(orig, mod) {
            const w = previewMod.width;
            const line = (y, color, dashOffset) => {
                ctxMod.strokeStyle = color;
                ctxMod.lineDashOffset = dashOffset;   // 蓝线错开半个虚线周期，与红线重合时两条都看得见
                ctxMod.beginPath();
                ctxMod.moveTo(0, y + 0.5);
                ctxMod.lineTo(w, y + 0.5);
                ctxMod.stroke();
            };
            ctxMod.save();
            ctxMod.setLineDash([6, 4]);
            ctxMod.lineWidth = 1;
            if (orig) { line(orig.top, '#dc2626', 0); line(orig.bottom, '#dc2626', 0); }
            if (mod) { line(mod.top, '#1d4ed8', 5); line(mod.bottom, '#1d4ed8', 5); }
            ctxMod.restore();
        }

        let previewFrame = 0;
        function renderAll() {
            if (previewFrame) return;
            previewFrame = requestAnimationFrame(() => {
                previewFrame = 0;
                renderAllNow();
            });
        }
        function renderAllNow() {
            if (!state.font) {
                drawPlaceholder(ctxOrig, previewOrig, uiText('请导入字体'), '#f8fafc');
                drawPlaceholder(ctxMod, previewMod, uiText('请导入字体'), '#f8fafc');
                return;
            }
            const text = $('previewText').value || ' ';
            renderText(ctxOrig, previewOrig, text, state.font, null, false);
            const showBounds = Boolean($('previewBoundsToggle') && $('previewBoundsToggle').checked);
            let origInk = null;
            if (showBounds) {
                // 未调整的原字形渲染进“修改后”画布同一布局量一次，红线与蓝线共用同一度量函数
                renderText(ctxMod, previewMod, text, state.font, null, false);
                origInk = inkBoundsY(ctxMod, previewMod);
            }
            renderText(ctxMod, previewMod, text, state.font, state, true);
            if (showBounds) drawBoundsLines(origInk, inkBoundsY(ctxMod, previewMod));
        }

        function previewLineMetrics(font, settings) {
            const upm = font.unitsPerEm || 1000;
            const ascent = (font.ascender ?? upm * .8) * 48 / upm;
            const descent = Math.abs(font.descender ?? -upm * .2) * 48 / upm;
            const sourceGap = Number(font.tables?.hhea?.lineGap || 0) * 48 / upm;
            const boxHeight = settings.lineHeight === 1.4 ? ascent + descent + sourceGap : settings.lineHeight * 48;
            return { ascent, descent, contentHeight: ascent + descent, boxHeight: Math.max(1, boxHeight) };
        }

        function resetFontEdits() {
            closeOriginEdit();
            state.global = { ...GLOBAL_EXCLUDE_DEFAULTS, exclude: '' };
            state.specific = {}; state.glyphs = []; state._glyphId = 0;
            state.replacementTarget = null; state.replacementFonts = [];
            state.replacementDirty = false;
            v5SwapRows = [{ from: '', to: '' }]; v5SwapApplied = {};
            v5ResetMainSwapUndo('已载入新字体');
            syncGlobalControls(); renderGlyphList(); renderReplacementFonts();
            renderReplacementTarget(); renderSwapRows();
        }

        // ===== 字体加载 =====
        let fontImportTicket = 0;
        const fileInput = $('fontFileInput');
        fileInput.addEventListener('change', function(e) {
            const file = e.target.files[0];
            e.target.value = '';
            const ticket = ++fontImportTicket;
            if (!file) { logStatus('未选择文件', 'error'); return; }
            logStatus(`📁 选择了文件: ${file.name} (${(file.size/1024).toFixed(1)} KB)`);
            if (typeof opentype === 'undefined') { logStatus('❌ opentype库未加载', 'error'); return; }
            const reader = new FileReader();
            reader.onload = function(ev) {
                if (ticket !== fontImportTicket) return;
                try {
                    const buffer = ev.target.result;
                    const outlineReason = v5NoVectorOutlineReason(buffer);
                    if (outlineReason) throw new Error(outlineReason);
                    const font = opentype.parse(buffer);
                    resetFontEdits();
                    state.font = font;
                    state.fontBuffer = buffer;
                    state.fontType = v5FontType(buffer, file.name);
                    state.fontName = file.name;
                    $('fontStatus').textContent = `✅ ${file.name} (${font.familyName || '未知'})`;
                    logStatus(`✅ 字体解析成功！家族名: ${font.familyName || '未知'}`, 'success');
                    renderAll();
                    renderSwapFontOptions();
                    v5ResetMainSwapUndo(uiText('已载入新字体'));
                    v5RefreshSpecificTargets();
                    v5VfAfterLoad(buffer);   // 可变字体：亮出「🎚️ 可变字体」入口（非 VF 直接返回）
                } catch (err) {
                    logStatus(`❌ 解析失败: ${err.message}`, 'error');
                    alert(`导入失败：${err.message}`);
                }
            };
            reader.onerror = function() { logStatus('❌ 读取文件错误', 'error'); };
            reader.readAsArrayBuffer(file);
        });

        // 预览文字输入即时刷新
        $('previewText').addEventListener('input', renderAll);

        // ===== 控件绑定 =====
        function bindSliderAndNumber(sliderId, numId, valId, stateKey, isGlobal, isNum = true) {
            const slider = $(sliderId);
            const num = $(numId);
            const val = $(valId);
            if (!slider || !num) return;
            const update = function() {
                let v = isNum ? parseFloat(slider.value) : slider.value;
                if (isNum && isNaN(v)) v = 0;
                num.value = v;
                if (val) val.textContent = ctrlValText(stateKey, v);
                if (isGlobal) { state.global[stateKey] = v; }
                renderAll();
            };
            slider.addEventListener('input', update);
            num.addEventListener('input', function() {
                let v = isNum ? parseFloat(this.value) : this.value;
                if (isNum && isNaN(v)) return;
                if (isNum) { const min = parseFloat(slider.min),
                        max = parseFloat(slider.max); if (!isNaN(min) && !isNaN(max)) v = clamp(v, min, max); }
                slider.value = v;
                this.value = v;
                if (val) val.textContent = ctrlValText(stateKey, v);
                if (isGlobal) { state.global[stateKey] = v; }
                renderAll();
            });
            update();
        }

        bindSliderAndNumber('globalSize', 'globalSizeNum', 'globalSizeVal', 'size', true);
        bindSliderAndNumber('globalLetterSpacing', 'globalLetterSpacingNum', 'globalLetterSpacingVal', 'letterSpacing',
            true);
        bindSliderAndNumber('globalWeight', 'globalWeightNum', 'globalWeightVal', 'weight', true);
        bindSliderAndNumber('globalLineHeight', 'globalLineHeightNum', 'globalLineHeightVal', 'lineHeight', true);
        bindSliderAndNumber('globalBaseline', 'globalBaselineNum', 'globalBaselineVal', 'baseline', true);
        bindSliderAndNumber('globalFine', 'globalFineNum', 'globalFineVal', 'fine', true);
        bindSliderAndNumber('globalBrightness', 'globalBrightnessNum', 'globalBrightnessVal', 'brightness', true);
        bindSliderAndNumber('globalHue', 'globalHueNum', 'globalHueVal', 'hue', true);

        bindSliderAndNumber('specificSize', 'specificSizeNum', 'specificSizeVal', 'size', false);
        bindSliderAndNumber('specificLetterSpacing', 'specificLetterSpacingNum', 'specificLetterSpacingVal', 'letterSpacing', false);
        bindSliderAndNumber('specificWeight', 'specificWeightNum', 'specificWeightVal', 'weight', false);
        bindSliderAndNumber('specificBaseline', 'specificBaselineNum', 'specificBaselineVal', 'baseline', false);
        bindSliderAndNumber('specificFine', 'specificFineNum', 'specificFineVal', 'fine', false);
        bindSliderAndNumber('specificBrightness', 'specificBrightnessNum', 'specificBrightnessVal', 'brightness', false);
        bindSliderAndNumber('specificHue', 'specificHueNum', 'specificHueVal', 'hue', false);

        syncColorGroup('globalColor', 'globalColorR', 'globalColorG', 'globalColorB', 'globalColorHex', (hex) => { state
                .global.color = hex;
            renderAll(); });
        syncColorGroup('specificColor', 'specificColorR', 'specificColorG', 'specificColorB', 'specificColorHex');

        function specificControlValues() {
            return {
                size: parseFloat($('specificSize').value),
                letterSpacing: parseFloat($('specificLetterSpacing').value),
                weight: parseFloat($('specificWeight').value),
                baseline: parseFloat($('specificBaseline').value),
                color: $('specificColor').value,
                fine: parseFloat($('specificFine').value),
                brightness: parseFloat($('specificBrightness').value),
                hue: parseFloat($('specificHue').value),
            };
        }

        function selectedSpecificTargets() {
            const grouped = typeof window.v5SpecificTargetCharacters === 'function' ? window.v5SpecificTargetCharacters() : null;
            if (grouped?.active) return grouped;
            const ch = singleCharacter($('specificChar').value);
            return { active: false, chars: ch ? [ch] : [], label: '字符' };
        }

        function applySpecific() {
            const targets = selectedSpecificTargets();
            if (!targets.chars.length) { alert(targets.active ? '当前字体里没有符合所选分组的字符' : '请输入任意单个 Unicode 字符（空格也可以）'); return; }
            const values = specificControlValues();
            targets.chars.forEach(ch => { state.specific[ch] = { ...values }; });
            renderAll();
            if (!targets.active) updateSpecificUI();
            if (targets.active) logStatus(`✅ 已把当前调整应用到${targets.label}，共 ${targets.chars.length} 个字符`, 'success');
        }

        function clearSpecific() {
            const targets = selectedSpecificTargets();
            if (!targets.chars.length) { alert(targets.active ? '当前字体里没有符合所选分组的字符' : '请输入任意单个 Unicode 字符（空格也可以）'); return; }
            targets.chars.forEach(ch => delete state.specific[ch]);
            renderAll();
            if (!targets.active) updateSpecificUI();
            if (targets.active) logStatus(`✅ 已清除${targets.label}的指定调整，共 ${targets.chars.length} 个字符`, 'success');
        }

        function updateSpecificUI() {
            const ch = singleCharacter($('specificChar').value);
            if (!ch) return;
            const spec = state.specific[ch];
            if (spec) {
                const map = { 'specificSize': 'size', 'specificLetterSpacing': 'letterSpacing',
                    'specificWeight': 'weight', 'specificBaseline': 'baseline', 'specificColor': 'color',
                    'specificFine': 'fine', 'specificBrightness': 'brightness', 'specificHue': 'hue' };
                for (const [id, key] of Object.entries(map)) {
                    const el = $(id);
                    if (el && spec[key] !== undefined) {
                        el.value = spec[key];
                        const numId = id + 'Num';
                        const numEl = $(numId);
                        if (numEl) numEl.value = spec[key];
                        const valId = id + 'Val';
                        const valEl = $(valId);
                        if (valEl) valEl.textContent = ctrlValText(key, spec[key]);
                    }
                }
                if (spec.color) {
                    const picker = $('specificColor');
                    picker.value = spec.color;
                    const rgb = hexToRgb(spec.color);
                    if (rgb) {
                        $('specificColorR').value = rgb.r;
                        $('specificColorG').value = rgb.g;
                        $('specificColorB').value = rgb.b;
                        $('specificColorHex').value = spec.color;
                    }
                }
            }
        }
        $('specificChar').addEventListener('input', updateSpecificUI);

        // ===== 修符管理 =====
        function importImages(event) {
            const files = event.target.files;
            if (!files.length) return;
            for (const file of files) {
                if (!(String(file.type || '').startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg|heic|heif|avif)$/i.test(file.name))) {
                    logStatus(`❌ “${file.name}”不是支持的图片或 SVG 文件`, 'error');
                    continue;
                }
                const reader = new FileReader();
                reader.onload = function(ev) {
                    const dataURL = ev.target.result;
                    if (file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')) {
                        const img = new Image();
                        img.onload = function() {
                            addGlyph({ imgData: dataURL, width: img.width, height: img.height, char: '',
                                size: 48, letterSpacing: 0, xOffset: 0, yOffset: 0, color: '#000000',
                                fine: 50, brightness: 100, hue: 0, isSymbol: false });
                        };
                        img.onerror = function() {
                            try {
                                const blob = new Blob([ev.target.result], { type: 'image/svg+xml' });
                                const url = URL.createObjectURL(blob);
                                const img2 = new Image();
                                img2.onload = function() {
                                    addGlyph({ imgData: url, width: img2.width, height: img2.height,
                                        char: '', size: 48, letterSpacing: 0, xOffset: 0,
                                        yOffset: 0, color: '#000000', fine: 50, brightness: 100,
                                        hue: 0, isSymbol: false });
                                };
                                img2.onerror = function() { URL.revokeObjectURL(url); logStatus(`❌ SVG“${file.name}”无法解码`, 'error'); };
                                img2.src = url;
                            } catch (e2) { logStatus('❌ SVG加载失败: ' + e2.message, 'error'); }
                        };
                        img.src = dataURL;
                    } else {
                        const img = new Image();
                        img.onload = function() {
                            addGlyph({ imgData: dataURL, width: img.width, height: img.height, char: '',
                                size: 48, letterSpacing: 0, xOffset: 0, yOffset: 0, color: '#000000',
                                fine: 50, brightness: 100, hue: 0, isSymbol: false });
                        };
                        img.onerror = function() { logStatus(`❌ 图片“${file.name}”无法解码`, 'error'); };
                        img.src = dataURL;
                    }
                };
                reader.onerror = function() { logStatus(`❌ 图片“${file.name}”读取失败`, 'error'); };
                reader.readAsDataURL(file);
            }
            event.target.value = '';
        }

        // 判断符号渲染结果是否带彩色（emoji 彩色、普通符号单色）；彩色则不再重染
        function glyphHasColor(data) {
            for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] < 8) continue;
                const r = data[i], g = data[i + 1], b = data[i + 2];
                if (Math.abs(r - g) > 16 || Math.abs(g - b) > 16 || Math.abs(r - b) > 16) return true;
            }
            return false;
        }

        function createSymbolGlyph() {
            askSymbolPrompt('请输入符号（如 ❅）：', '例如 ❅、★、♡', (v) => (v.trim() === '' ? '不能为空' : ''), (symbol) => {
                if (symbol === null) return;
                askSymbolPrompt('要替换的字符（如 的）：', '一次只能指定一个字符或符号', (v) => (singleCharacter(v) ? '' : '一次只能指定一个字符或符号'), (target) => {
                    if (target === null) return;
                    const targetChar = singleCharacter(target);
                    const canvas = document.createElement('canvas');
                    const size = 200;
                    canvas.width = size;
                    canvas.height = size;
                    const ctx = canvas.getContext('2d');
                    ctx.clearRect(0, 0, size, size);
                    ctx.fillStyle = '#000000';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.font = `160px sans-serif`;
                    ctx.fillText(symbol, size / 2, size / 2 + 10);
                    const colorful = glyphHasColor(ctx.getImageData(0, 0, size, size).data);
                    const dataURL = canvas.toDataURL('image/png');
                    addGlyph({ imgData: dataURL, width: size, height: size, char: targetChar, size: 48,
                        letterSpacing: 0, xOffset: 0, yOffset: 0, color: '#000000', fine: 50, brightness: 100,
                        hue: 0, isSymbol: !colorful });
                    logStatus(`✅ 新建符号: "${symbol}" → "${target}"`, 'success');
                });
            });
        }

        // 自定义居中文本输入（替代原生 prompt：iOS 横屏原生弹窗贴底被截断、连续两次弹窗丢失）
        let _askCb = null, _askValidate = null;
        function askSymbolPrompt(title, hint, validate, cb) {
            $('textPromptTitle').textContent = title;
            const input = $('textPromptInput');
            input.value = '';
            input.placeholder = hint || '';
            $('textPromptHint').textContent = hint || '';
            $('textPromptError').textContent = '';
            $('textPromptError').style.display = 'none';
            $('textPromptModal').classList.add('active');
            _askCb = cb;
            _askValidate = validate || null;
            input.focus();
        }
        function closeSymbolPrompt(value) {
            if (!$('textPromptModal').classList.contains('active')) return;
            $('textPromptModal').classList.remove('active');
            const cb = _askCb;
            _askCb = null;
            _askValidate = null;
            if (cb) cb(value);
        }
        function confirmSymbolPrompt() {
            const v = $('textPromptInput').value;
            const err = _askValidate ? _askValidate(v) : (v === '' ? '不能为空' : '');
            if (err) {
                const e = $('textPromptError');
                e.textContent = err;
                e.style.display = 'block';
                return;
            }
            closeSymbolPrompt(v);
        }

        function normalizeLayerTransform(value) {
            return { x: Number(value?.x) || 0, y: Number(value?.y) || 0,
                scale: clamp(Number(value?.scale) || 1, 0.05, 5),
                rotate: clamp(Number(value?.rotate) || 0, -180, 180) };
        }

        function addGlyph(data) {
            const id = ++state._glyphId;
            const glyph = { id, char: singleCharacter(data.char) || '', imgData: data.imgData,
                width: data.width ?? 48, height: data.height ?? 48, size: data.size ?? 48,
                letterSpacing: data.letterSpacing ?? 0, xOffset: data.xOffset ?? 0, yOffset: data.yOffset ?? 0,
                color: data.color || '#000000', fine: data.fine ?? 50, brightness: data.brightness ?? 100,
                hue: data.hue ?? 0, isSymbol: Boolean(data.isSymbol), exportAsColor: Boolean(data.exportAsColor) };
            if (data.layers) glyph.layers = {
                sourceChar: data.layers.sourceChar || null,
                originalData: data.layers.originalData || null,
                repairData: data.layers.repairData || null,
                extraData: data.layers.extraData || null,
                originalTransform: normalizeLayerTransform(data.layers.originalTransform),
                repairTransform: normalizeLayerTransform(data.layers.repairTransform),
                extraTransform: normalizeLayerTransform(data.layers.extraTransform)
            };
            state.glyphs.push(glyph);
            renderGlyphList();
            renderAll();
            return glyph;
        }

        function removeGlyph(id) {
            state.glyphs = state.glyphs.filter(g => g.id !== id);
            renderGlyphList();
            renderAll();
        }

        function showGlyphTargetError(id, invalid) {
            const input = document.querySelector(`.glyph-target-input[data-id="${id}"]`);
            const error = document.querySelector(`.glyph-target-error[data-id="${id}"]`);
            if (input) {
                input.classList.toggle('invalid', invalid);
                input.setAttribute('aria-invalid', String(invalid));
            }
            if (error) error.classList.toggle('active', invalid);
        }

        function setGlyphTarget(idOrGlyph, value, input = null) {
            const glyph = typeof idOrGlyph === 'object' ? idOrGlyph : state.glyphs.find(item => item.id === idOrGlyph);
            if (!glyph) return false;
            const char = singleCharacter(value);
            glyph.char = char || '';
            if (input) showGlyphTargetError(glyph.id, !char);
            renderAll();
            return Boolean(char);
        }

        function updateGlyph(id, key, value) {
            const g = state.glyphs.find(item => item.id === id);
            if (!g) return;
            if (key === 'char') { setGlyphTarget(g, value); return; }
            g[key] = value;
            if (key === 'imgData') { delete g._image; delete g._imageSource; }
            renderAll();
        }

        function moveGlyph(id, action) {
            const from = state.glyphs.findIndex(g => g.id === id);
            const to = action === 'top' ? 0 : action === 'up' ? from - 1 : from + 1;
            if (!moveArrayItem(state.glyphs, from, to)) return;
            renderGlyphList();
            renderAll();
            requestAnimationFrame(() => document.querySelector(`.glyph-item[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
        }

        function setupGlyphColorSync(glyphId, pickerId, rId, gId, bId, hexId) {
            syncColorGroup(pickerId, rId, gId, bId, hexId, (hex) => { updateGlyph(glyphId, 'color', hex); });
        }

        function renderGlyphList() {
            const container = $('glyphListContainer');
            const count = state.glyphs.length;
            $('glyphCount').textContent = count;
            if (count === 0) { container.innerHTML = '<div class="empty-state">暂无修符</div>'; return; }
            let html = '';
            for (const g of state.glyphs) {
                const prefix = 'glyph_' + g.id;
                const rgb = hexToRgb(g.color) || { r: 0, g: 0, b: 0 };
                const charAttr = escapeAttribute(g.char);
                const imageAttr = escapeAttribute(g.imgData);
                const colorAttr = escapeAttribute(g.color);
                html += `<div class="glyph-item" data-id="${g.id}">
                    <div class="preview-img">
                        <img src="${imageAttr}" alt="修符">
                        <span class="px-info">${g.width}×${g.height}</span>
                    </div>
                    <div class="controls">
                        <div class="ctrl-row"><label>目标</label><input type="text" class="glyph-target-input${g.char ? '' : ' invalid'}" data-id="${g.id}" aria-label="要替换或新增的字符或符号" aria-invalid="${g.char ? 'false' : 'true'}" value="${charAttr}" maxlength="2" oninput="setGlyphTarget(${g.id},this.value,this)" style="width:52px;"></div>
                        <div class="glyph-target-error${g.char ? '' : ' active'}" data-id="${g.id}">请选择要替换或新增的字符/符号</div>
                        <div class="ctrl-row"><label>大小</label><input type="range" min="8" max="120" value="${g.size}" oninput="updateGlyph(${g.id},'size',parseFloat(this.value)); this.nextElementSibling.value=this.value; this.nextElementSibling.nextElementSibling.textContent=this.value;"><input type="number" min="8" max="120" value="${g.size}" oninput="updateGlyph(${g.id},'size',parseFloat(this.value)); this.previousElementSibling.value=this.value; this.nextElementSibling.textContent=this.value;"><span class="val">${g.size}</span></div>
                        <div class="ctrl-row"><label>字距</label><input type="range" min="-10" max="30" value="${g.letterSpacing}" oninput="updateGlyph(${g.id},'letterSpacing',parseFloat(this.value)); this.nextElementSibling.value=this.value; this.nextElementSibling.nextElementSibling.textContent=this.value;"><input type="number" min="-10" max="30" value="${g.letterSpacing}" oninput="updateGlyph(${g.id},'letterSpacing',parseFloat(this.value)); this.previousElementSibling.value=this.value; this.nextElementSibling.textContent=this.value;"><span class="val">${g.letterSpacing}</span></div>
                        <div class="ctrl-row"><label>左右</label><input type="range" min="-40" max="40" value="${g.xOffset}" oninput="updateGlyph(${g.id},'xOffset',parseFloat(this.value)); this.nextElementSibling.value=this.value; this.nextElementSibling.nextElementSibling.textContent=this.value;"><input type="number" min="-40" max="40" value="${g.xOffset}" oninput="updateGlyph(${g.id},'xOffset',parseFloat(this.value)); this.previousElementSibling.value=this.value; this.nextElementSibling.textContent=this.value;"><span class="val">${g.xOffset}</span></div>
                        <div class="ctrl-row"><label>上下</label><input type="range" min="-40" max="40" value="${g.yOffset}" oninput="updateGlyph(${g.id},'yOffset',parseFloat(this.value)); this.nextElementSibling.value=this.value; this.nextElementSibling.nextElementSibling.textContent=this.value;"><input type="number" min="-40" max="40" value="${g.yOffset}" oninput="updateGlyph(${g.id},'yOffset',parseFloat(this.value)); this.previousElementSibling.value=this.value; this.nextElementSibling.textContent=this.value;"><span class="val">${g.yOffset}</span></div>
                        <div class="ctrl-row"><label>颜色</label><div class="color-group"><input type="color" id="${prefix}_picker" value="${colorAttr}"><div class="rgb-inputs"><span>R</span><input type="number" id="${prefix}_r" min="0" max="255" value="${rgb.r}"><span>G</span><input type="number" id="${prefix}_g" min="0" max="255" value="${rgb.g}"><span>B</span><input type="number" id="${prefix}_b" min="0" max="255" value="${rgb.b}"></div><input type="text" class="hex-input" id="${prefix}_hex" value="${colorAttr}" maxlength="7"></div></div>
                        <div class="ctrl-row"><label>对比度</label><input type="range" min="0" max="100" value="${g.fine}" oninput="updateGlyph(${g.id},'fine',parseFloat(this.value)); this.nextElementSibling.value=this.value; this.nextElementSibling.nextElementSibling.textContent=this.value;"><input type="number" min="0" max="100" value="${g.fine}" oninput="updateGlyph(${g.id},'fine',parseFloat(this.value)); this.previousElementSibling.value=this.value; this.nextElementSibling.textContent=this.value;"><span class="val">${g.fine}</span></div>
                        <div class="ctrl-row"><label>亮度</label><input type="range" min="0" max="200" value="${g.brightness}" oninput="updateGlyph(${g.id},'brightness',parseFloat(this.value)); this.nextElementSibling.value=this.value; this.nextElementSibling.nextElementSibling.textContent=this.value;"><input type="number" min="0" max="200" value="${g.brightness}" oninput="updateGlyph(${g.id},'brightness',parseFloat(this.value)); this.previousElementSibling.value=this.value; this.nextElementSibling.textContent=this.value;"><span class="val">${g.brightness}</span></div>
                        <div class="ctrl-row"><label>色相</label><input type="range" min="0" max="360" value="${g.hue}" oninput="updateGlyph(${g.id},'hue',parseFloat(this.value)); this.nextElementSibling.value=this.value; this.nextElementSibling.nextElementSibling.textContent=this.value;"><input type="number" min="0" max="360" value="${g.hue}" oninput="updateGlyph(${g.id},'hue',parseFloat(this.value)); this.previousElementSibling.value=this.value; this.nextElementSibling.textContent=this.value;"><span class="val">${g.hue}</span></div>
                    </div>
                    <div class="actions">
                        <button class="btn btn-sm glyph-order-btn" aria-label="置顶此修符" title="置顶" onclick="moveGlyph(${g.id},'top')">置顶</button>
                        <button class="btn btn-sm glyph-order-btn" aria-label="上移此修符" title="上移" onclick="moveGlyph(${g.id},'up')">↑</button>
                        <button class="btn btn-sm glyph-order-btn" aria-label="下移此修符" title="下移" onclick="moveGlyph(${g.id},'down')">↓</button>
                        <label style="display:flex;align-items:center;gap:3px;font-size:11px;white-space:nowrap;"><input type="checkbox" ${g.exportAsColor ? 'checked' : ''} onchange="updateGlyph(${g.id},'exportAsColor',this.checked)"> 导出为彩图</label>
                        <button class="btn btn-sm btn-outline" aria-label="导出为彩图说明" onclick="alert('勾选后，本ttf导入阅读软件时，此字符将会永久保留导入时的颜色，不会随字体颜色变色')">?</button>
                        <button class="btn btn-sm btn-primary" onclick="openOriginEdit(${g.id})">原始</button>
                        <button class="del-btn" aria-label="删除此修符" onclick="removeGlyph(${g.id})">✕</button>
                    </div>
                </div>`;
            }
            container.innerHTML = html;
            for (const g of state.glyphs) {
                const prefix = 'glyph_' + g.id;
                setupGlyphColorSync(g.id, prefix + '_picker', prefix + '_r', prefix + '_g', prefix + '_b', prefix +
                    '_hex');
            }
        }

        // ===== 画板 =====
        let drawCtx, drawCanvas, drawHistory = [];

        function openDrawModal() {
            const modal = $('drawModal');
            modal.classList.add('active');
            drawCanvas = $('drawCanvas');
            const w = parseInt($('drawWidth').value) || 200;
            const h = parseInt($('drawHeight').value) || 200;
            drawCanvas.width = w;
            drawCanvas.height = h;
            drawCtx = drawCanvas.getContext('2d');
            drawCtx.clearRect(0, 0, w, h);
            drawHistory = [];
            if (drawCanvas._drawCleanup) drawCanvas._drawCleanup();
            setupDrawEvents();
        }

        function resizeDrawCanvas() {
            if (!drawCanvas) return;
            const w = parseInt($('drawWidth').value) || 200;
            const h = parseInt($('drawHeight').value) || 200;
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = drawCanvas.width;
            tempCanvas.height = drawCanvas.height;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(drawCanvas, 0, 0);
            drawCanvas.width = w;
            drawCanvas.height = h;
            drawCtx.clearRect(0, 0, w, h);
            drawCtx.drawImage(tempCanvas, 0, 0);
            drawHistory = [];
        }

        function closeDrawModal() {
            if (drawCanvas?._drawCleanup) { drawCanvas._drawCleanup(); drawCanvas._drawCleanup = null; }
            $('drawModal').classList.remove('active');
        }

        function setupDrawEvents() {
            const canvas = drawCanvas;
            let isDown = false,
                lastX, lastY;

            function getPos(e) {
                const rect = canvas.getBoundingClientRect();
                const scaleX = canvas.width / rect.width,
                    scaleY = canvas.height / rect.height;
                const clientX = e.touches ? e.touches[0].clientX : e.clientX;
                const clientY = e.touches ? e.touches[0].clientY : e.clientY;
                return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
            }

            function startDraw(e) {
                e.preventDefault();
                isDown = true;
                const pos = getPos(e);
                lastX = pos.x;
                lastY = pos.y;
                drawHistory.push(drawCanvas.toDataURL());
                if (drawHistory.length > 30) drawHistory.shift();
            }

            function draw(e) {
                e.preventDefault();
                if (!isDown) return;
                const pos = getPos(e);
                const color = $('drawColor').value,
                    size = parseFloat($('drawSize').value);
                drawCtx.beginPath();
                drawCtx.moveTo(lastX, lastY);
                drawCtx.lineTo(pos.x, pos.y);
                drawCtx.strokeStyle = color;
                drawCtx.lineWidth = size;
                drawCtx.lineCap = 'round';
                drawCtx.lineJoin = 'round';
                drawCtx.stroke();
                lastX = pos.x;
                lastY = pos.y;
            }

            function endDraw(e) { e.preventDefault();
                isDown = false; }
            canvas.addEventListener('mousedown', startDraw);
            canvas.addEventListener('mousemove', draw);
            canvas.addEventListener('mouseup', endDraw);
            canvas.addEventListener('mouseleave', endDraw);
            canvas.addEventListener('touchstart', startDraw, { passive: false });
            canvas.addEventListener('touchmove', draw, { passive: false });
            canvas.addEventListener('touchend', endDraw, { passive: false });
            canvas._drawCleanup = function() {
                canvas.removeEventListener('mousedown', startDraw);
                canvas.removeEventListener('mousemove', draw);
                canvas.removeEventListener('mouseup', endDraw);
                canvas.removeEventListener('mouseleave', endDraw);
                canvas.removeEventListener('touchstart', startDraw);
                canvas.removeEventListener('touchmove', draw);
                canvas.removeEventListener('touchend', endDraw);
            };
        }

        function clearDrawCanvas() {
            if (!drawCtx) return;
            drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
            drawHistory = [];
        }

        function undoDraw() {
            if (drawHistory.length === 0) return;
            const prev = drawHistory.pop();
            const img = new Image();
            img.onload = function() {
                drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
                drawCtx.drawImage(img, 0, 0);
            };
            img.src = prev;
        }

        function confirmDraw() {
            const dataURL = drawCanvas.toDataURL('image/png');
            const img = new Image();
            img.onload = function() {
                addGlyph({ imgData: dataURL, width: img.width, height: img.height, char: '', size: 48,
                    letterSpacing: 0, xOffset: 0, yOffset: 0, color: $('drawColor').value || '#000000', fine: 50, brightness: 100,
                    hue: 0, isSymbol: false });
                closeDrawModal();
            };
            img.src = dataURL;
        }

        $('drawSize').addEventListener('input', function() { $('drawSizeVal').textContent = this.value; });

        // ===== 原始编辑（三层模型：参考/原字/修符） =====
        const EDIT_W = 600,
            EDIT_H = 400;
        let originEditState = state.originEdit;
        let originCtx = null;
        let originHistory = [];
        let activePointers = new Map(); // pointerId -> {x,y}（canvas 坐标）
        let gestureStart = null; // {centerX, centerY, distance, angle, view:{...}}
        let strokeDown = false;
        let strokeLast = null;
        let strokeHistoryPushed = false;
        let transformGestureDirty = false;

        function newCanvas(w, h) {
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            return c;
        }

        function canvasFromDataURL(dataURL) {
            return new Promise((resolve) => {
                if (!dataURL) return resolve(null);
                const img = new Image();
                img.onload = () => {
                    try {
                        const c = newCanvas(img.naturalWidth || 1, img.naturalHeight || 1);
                        c.getContext('2d').drawImage(img, 0, 0);
                        resolve(c);
                    } catch (_) { resolve(null); }
                };
                img.onerror = () => resolve(null);
                img.src = dataURL;
            });
        }

        function cloneCanvas(src) {
            if (!src) return null;
            const c = newCanvas(src.width, src.height);
            c.getContext('2d').drawImage(src, 0, 0);
            return c;
        }

        // 生成只读参考层 + 精确边界（alpha 扫描，仅此一次；缺字返回 null 无假边界）
        function buildReferenceCanvas(char) {
            const c = newCanvas(EDIT_W, EDIT_H);
            const ctx = c.getContext('2d');
            let path;
            try {
                if (!state.font.charToGlyphIndex(char)) return { canvas: null, bounds: null };
                path = state.font.getPath(char, 0, 0, 100);
            } catch (_) { return { canvas: null, bounds: null }; }
            if (!path || !path.commands || !path.commands.length) return { canvas: null, bounds: null };
            let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
            for (const cmd of path.commands) {
                for (const k of ['x', 'x1', 'x2']) if (cmd[k] !== undefined) { xMin = Math.min(xMin, cmd[k]); xMax = Math.max(xMax, cmd[k]); }
                for (const k of ['y', 'y1', 'y2']) if (cmd[k] !== undefined) { yMin = Math.min(yMin, cmd[k]); yMax = Math.max(yMax, cmd[k]); }
            }
            if (xMin === Infinity || xMax - xMin <= 0 || yMax - yMin <= 0) return { canvas: null, bounds: null };
            const fw = xMax - xMin, fh = yMax - yMin;
            const pad = 30;
            const scale = Math.min((EDIT_W - 2 * pad) / fw, (EDIT_H - 2 * pad) / fh);
            const cx = (xMin + xMax) / 2, cy = (yMin + yMax) / 2;
            path.fill = '#000000';
            path.stroke = null;
            ctx.save();
            ctx.translate(EDIT_W / 2, EDIT_H / 2);
            ctx.scale(scale, scale);
            ctx.translate(-cx, -cy);
            path.draw(ctx);
            ctx.restore();
            const data = ctx.getImageData(0, 0, EDIT_W, EDIT_H).data;
            let bxMin = EDIT_W, bxMax = -1, byMin = EDIT_H, byMax = -1;
            for (let y = 0; y < EDIT_H; y++) {
                const row = y * EDIT_W;
                for (let x = 0; x < EDIT_W; x++) {
                    if (data[(row + x) * 4 + 3] > 0) {
                        if (x < bxMin) bxMin = x;
                        if (x > bxMax) bxMax = x;
                        if (y < byMin) byMin = y;
                        if (y > byMax) byMax = y;
                    }
                }
            }
            const bounds = bxMin <= bxMax ? { x: bxMin, y: byMin, w: bxMax - bxMin, h: byMax - byMin } : null;
            return { canvas: c, bounds };
        }

        function currentLayerKey() { return originEditState.layer; }

        function layerCanvasForKey(key) {
            if (key === 'original') return originEditState.originalCanvas;
            if (key === 'repair') return originEditState.repairCanvas;
            return originEditState.extraCanvas;
        }

        function currentLayerCanvas() {
            return layerCanvasForKey(currentLayerKey());
        }

        function layerTransform() { return originEditState.transforms[currentLayerKey()]; }

        function drawLayer(ctx, canvas, transform) {
            if (!canvas) return;
            const iw = canvas.width, ih = canvas.height;
            ctx.save();
            ctx.translate(EDIT_W / 2 + transform.x, EDIT_H / 2 + transform.y);
            ctx.rotate(transform.rotate * Math.PI / 180);
            ctx.scale(transform.scale, transform.scale);
            ctx.translate(-iw / 2, -ih / 2);
            ctx.drawImage(canvas, 0, 0);
            ctx.restore();
        }

        function worldPoint(canvasPoint) {
            return inverseTransformPoint(canvasPoint, originEditState.view, EDIT_W / 2, EDIT_H / 2);
        }

        function layerLocalPoint(world, key) {
            const c = layerCanvasForKey(key);
            if (!c) return world;
            const t = originEditState.transforms[key];
            const dx = world.x - (EDIT_W / 2 + t.x);
            const dy = world.y - (EDIT_H / 2 + t.y);
            const ang = -t.rotate * Math.PI / 180;
            const cos = Math.cos(ang), sin = Math.sin(ang);
            return { x: (dx * cos - dy * sin) / t.scale + c.width / 2, y: (dx * sin + dy * cos) / t.scale + c.height / 2 };
        }

        function layerLocalToWorld(local, key) {
            const c = layerCanvasForKey(key);
            if (!c) return local;
            const t = originEditState.transforms[key];
            const x = local.x - c.width / 2, y = local.y - c.height / 2;
            const ang = t.rotate * Math.PI / 180;
            const cos = Math.cos(ang), sin = Math.sin(ang);
            return { x: EDIT_W / 2 + t.x + (x * cos - y * sin) * t.scale, y: EDIT_H / 2 + t.y + (x * sin + y * cos) * t.scale };
        }

        function getCanvasPoint(e) {
            const canvas = $('originEditCanvas');
            const rect = canvas.getBoundingClientRect();
            const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
            return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
        }

        function getSelectionMask() {
            const key = currentLayerKey();
            const c = currentLayerCanvas();
            if (!c) return null;
            if (!originEditState.selectionMask || originEditState.selectionLayer !== key || originEditState.selectionMask.width !== c.width || originEditState.selectionMask.height !== c.height) {
                originEditState.selectionMask = newCanvas(c.width, c.height);
                originEditState.selectionLayer = key;
            }
            return originEditState.selectionMask;
        }

        function activeSelectionMask() {
            return (originEditState.selectionMask && originEditState.selectionLayer === currentLayerKey()) ? originEditState.selectionMask : null;
        }

        // 把形状路径按当前模式（新建/增加/减少）写入选区遮罩
        function applySelectionShape(drawFn) {
            const m = getSelectionMask();
            if (!m) return;
            const ctx = m.getContext('2d');
            if (originEditState.selectMode === 'new') ctx.clearRect(0, 0, m.width, m.height);
            ctx.save();
            ctx.globalCompositeOperation = originEditState.selectMode === 'subtract' ? 'destination-out' : 'source-over';
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            drawFn(ctx);
            ctx.fill();
            ctx.restore();
        }

        // 画笔/形状/涂抹共用：画到临时层 → 选区限定 → 锁定透明限定 → 合成回图层
        function paintWithMaskAndLock(drawContent) {
            const c = currentLayerCanvas();
            if (!c) return;
            const selMask = activeSelectionMask();
            const lock = originEditState.lockTransparency;
            const isEraser = originEditState.tool === 'eraser';
            const ctx = c.getContext('2d');
            ctx.save();
            if (selMask || lock) {
                const tmp = newCanvas(c.width, c.height);
                const tctx = tmp.getContext('2d');
                drawContent(tctx);
                if (selMask) {
                    tctx.globalCompositeOperation = 'destination-in';
                    tctx.drawImage(selMask, 0, 0);
                }
                if (lock) {
                    tctx.globalCompositeOperation = 'destination-in';
                    tctx.drawImage(c, 0, 0);
                }
                ctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
                ctx.drawImage(tmp, 0, 0);
            } else {
                ctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
                drawContent(ctx);
            }
            ctx.restore();
        }

        function paintStroke(fromCanvas, toCanvas) {
            const key = currentLayerKey();
            const c = currentLayerCanvas();
            if (!c) return;
            const from = layerLocalPoint(worldPoint(fromCanvas), key);
            const to = layerLocalPoint(worldPoint(toCanvas), key);
            const isEraser = originEditState.tool === 'eraser';
            const lw = originEditState.brushSize / Math.max(originEditState.transforms[key].scale, 0.001);
            paintWithMaskAndLock((ctx) => {
                ctx.lineCap = 'round'; ctx.lineJoin = 'round';
                ctx.lineWidth = lw;
                ctx.strokeStyle = isEraser ? '#ffffff' : originEditState.color;
                ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
            });
        }

        function shapeRectFor(x0, y0, x1, y1, type) {
            let w = x1 - x0, h = y1 - y0;
            if (type === 'square' || type === 'circle') {
                const s = Math.max(Math.abs(w), Math.abs(h));
                w = (w < 0 ? -s : s);
                h = (h < 0 ? -s : s);
            }
            return { x: x0, y: y0, w, h };
        }

        function commitShape(fromLocal, toLocal) {
            const key = currentLayerKey();
            const type = originEditState.shapeType;
            const fill = originEditState.shapeFill;
            const r = shapeRectFor(fromLocal.x, fromLocal.y, toLocal.x, toLocal.y, type);
            const lw = originEditState.brushSize / Math.max(originEditState.transforms[key].scale, 0.001);
            paintWithMaskAndLock((ctx) => {
                ctx.lineWidth = lw;
                ctx.lineJoin = 'round';
                ctx.strokeStyle = originEditState.color;
                ctx.fillStyle = originEditState.color;
                ctx.beginPath();
                if (type === 'ellipse' || type === 'circle') {
                    ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.abs(r.w) / 2, Math.abs(r.h) / 2, 0, 0, Math.PI * 2);
                } else {
                    ctx.rect(r.x, r.y, r.w, r.h);
                }
                if (fill) ctx.fill(); else ctx.stroke();
            });
        }

        function smudgeColorAt(localPt) {
            const c = currentLayerCanvas();
            if (!c) return null;
            const x = Math.round(localPt.x), y = Math.round(localPt.y);
            if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
            const d = c.getContext('2d').getImageData(x, y, 1, 1).data;
            return d[3] > 0 ? rgbToHex(d[0], d[1], d[2]) : null;
        }

        function smudgeStrokeFrom(from, to, color) {
            const key = currentLayerKey();
            const lw = originEditState.brushSize / Math.max(originEditState.transforms[key].scale, 0.001);
            paintWithMaskAndLock((ctx) => {
                ctx.lineCap = 'round'; ctx.lineJoin = 'round';
                ctx.lineWidth = lw;
                ctx.strokeStyle = color;
                ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
            });
        }

        function mirrorOriginLayer(dir) {
            const c = currentLayerCanvas();
            if (!c) return;
            pushHistory();
            const tmp = newCanvas(c.width, c.height);
            tmp.getContext('2d').drawImage(c, 0, 0);
            const ctx = c.getContext('2d');
            ctx.save();
            ctx.clearRect(0, 0, c.width, c.height);
            if (dir === 'h') { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
            else { ctx.translate(0, c.height); ctx.scale(1, -1); }
            ctx.drawImage(tmp, 0, 0);
            ctx.restore();
            renderOriginEdit();
        }

        function eyedropperPick(canvasPoint) {
            const key = currentLayerKey();
            const c = currentLayerCanvas();
            if (!c) return;
            const p = layerLocalPoint(worldPoint(canvasPoint), key);
            const x = Math.round(p.x), y = Math.round(p.y);
            if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
            const d = c.getContext('2d').getImageData(x, y, 1, 1).data;
            if (d[3] === 0) return;
            applyHex(rgbToHex(d[0], d[1], d[2]));
        }

        function liquifyStroke(fromCanvas, toCanvas) {
            const key = currentLayerKey();
            const c = currentLayerCanvas();
            if (!c) return;
            const from = layerLocalPoint(worldPoint(fromCanvas), key);
            const to = layerLocalPoint(worldPoint(toCanvas), key);
            const scale = Math.max(originEditState.transforms[key].scale, 0.001);
            const r = Math.max(2, originEditState.brushSize / scale / 2);
            const dx = to.x - from.x, dy = to.y - from.y;
            const dist = Math.hypot(dx, dy);
            if (dist < 0.5) return;
            const strength = Math.min(dist * 0.5, r);
            const ux = dx / dist * strength, uy = dy / dist * strength;
            const d = Math.ceil(r * 2);
            const snip = newCanvas(d, d);
            snip.getContext('2d').drawImage(c, to.x - ux - r, to.y - uy - r, d, d, 0, 0, d, d);
            const ctx = c.getContext('2d');
            ctx.save();
            ctx.beginPath();
            ctx.arc(to.x, to.y, r, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(snip, to.x - r, to.y - r);
            ctx.restore();
        }

        function snapshotLayers() {
            return {
                original: originEditState.originalCanvas ? originEditState.originalCanvas.toDataURL() : null,
                repair: originEditState.repairCanvas ? originEditState.repairCanvas.toDataURL() : null,
                extra: originEditState.extraCanvas ? originEditState.extraCanvas.toDataURL() : null,
                transforms: {
                    original: { ...originEditState.transforms.original },
                    repair: { ...originEditState.transforms.repair },
                    extra: { ...originEditState.transforms.extra }
                }
            };
        }

        function pushHistory() {
            originHistory.push(snapshotLayers());
            if (originHistory.length > 30) originHistory.shift();
        }

        async function restoreSnapshot(snap) {
            const session = originEditState.session;
            const [o, r, e] = await Promise.all([
                snap.original ? canvasFromDataURL(snap.original) : Promise.resolve(null),
                snap.repair ? canvasFromDataURL(snap.repair) : Promise.resolve(null),
                snap.extra ? canvasFromDataURL(snap.extra) : Promise.resolve(null)
            ]);
            if (session !== originEditState.session) return;
            originEditState.originalCanvas = o;
            originEditState.repairCanvas = r;
            originEditState.extraCanvas = e;
            originEditState.transforms = {
                original: { ...snap.transforms.original },
                repair: { ...snap.transforms.repair },
                extra: { ...(snap.transforms.extra || { x: 0, y: 0, scale: 1, rotate: 0 }) }
            };
            syncLayerTransformControls();
            renderOriginEdit();
        }

        async function undoOriginEdit() {
            const snap = originHistory.pop();
            if (!snap) return;
            await restoreSnapshot(snap);
        }

        function syncViewControls() {
            const v = originEditState.view;
            $('viewZoom').value = v.zoom;
            $('viewZoomVal').textContent = v.zoom.toFixed(2);
            $('viewRotate').value = v.rotate;
            $('viewRotateVal').textContent = v.rotate.toFixed(0) + '°';
        }

        function syncLayerTransformControls() {
            const t = layerTransform();
            if (!$('originLayerX')) return;
            $('originLayerX').value = Math.round(t.x);
            $('originLayerY').value = Math.round(t.y);
            $('originGlyphScale').value = t.scale;
            $('originGlyphScaleNum').value = t.scale;
            $('originGlyphRotate').value = t.rotate;
            $('originGlyphRotateNum').value = t.rotate;
        }

        function drawSelectionOverlay(ctx) {
            const m = activeSelectionMask();
            if (!m) return;
            const overlay = newCanvas(m.width, m.height);
            const octx = overlay.getContext('2d');
            octx.drawImage(m, 0, 0);
            octx.globalCompositeOperation = 'source-in';
            octx.fillStyle = 'rgba(59, 130, 246, 0.35)';
            octx.fillRect(0, 0, m.width, m.height);
            drawLayer(ctx, overlay, originEditState.transforms[originEditState.selectionLayer]);
        }

        function drawSelectionPreview(ctx) {
            const p = originEditState._selectPreview;
            if (!p) return;
            const key = p.layer;
            ctx.save();
            ctx.setLineDash([5, 4]);
            ctx.strokeStyle = '#111111';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            if (p.type === 'rect') {
                const c0 = layerLocalToWorld({ x: p.x, y: p.y }, key);
                const c1 = layerLocalToWorld({ x: p.x + p.w, y: p.y }, key);
                const c2 = layerLocalToWorld({ x: p.x + p.w, y: p.y + p.h }, key);
                const c3 = layerLocalToWorld({ x: p.x, y: p.y + p.h }, key);
                ctx.moveTo(c0.x, c0.y); ctx.lineTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y); ctx.lineTo(c3.x, c3.y);
                ctx.closePath();
            } else if (p.type === 'poly') {
                p.points.forEach((pt, i) => {
                    const w = layerLocalToWorld(pt, key);
                    if (i === 0) ctx.moveTo(w.x, w.y); else ctx.lineTo(w.x, w.y);
                });
                ctx.closePath();
            }
            ctx.stroke();
            ctx.restore();
        }

        function drawShapePreview(ctx) {
            const p = originEditState._shapePreview;
            if (!p) return;
            const key = p.layer;
            const t = originEditState.transforms[key];
            const r = shapeRectFor(p.x0, p.y0, p.x1, p.y1, p.type);
            ctx.save();
            ctx.setLineDash([5, 4]);
            ctx.strokeStyle = originEditState.color;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            if (p.type === 'ellipse' || p.type === 'circle') {
                const cw = layerLocalToWorld({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, key);
                ctx.ellipse(cw.x, cw.y, Math.abs(r.w) / 2 * t.scale, Math.abs(r.h) / 2 * t.scale, t.rotate * Math.PI / 180, 0, Math.PI * 2);
            } else {
                const c0 = layerLocalToWorld({ x: r.x, y: r.y }, key);
                const c1 = layerLocalToWorld({ x: r.x + r.w, y: r.y }, key);
                const c2 = layerLocalToWorld({ x: r.x + r.w, y: r.y + r.h }, key);
                const c3 = layerLocalToWorld({ x: r.x, y: r.y + r.h }, key);
                ctx.moveTo(c0.x, c0.y); ctx.lineTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y); ctx.lineTo(c3.x, c3.y);
                ctx.closePath();
            }
            ctx.stroke();
            ctx.restore();
        }

        function renderOriginEdit() {
            const canvas = $('originEditCanvas');
            const ctx = canvas.getContext('2d');
            originCtx = ctx;
            ctx.clearRect(0, 0, EDIT_W, EDIT_H);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, EDIT_W, EDIT_H);
            ctx.save();
            applyCanvasTransform(ctx, originEditState.view, EDIT_W / 2, EDIT_H / 2);
            if (originEditState.refVisible && originEditState.referenceCanvas) {
                ctx.globalAlpha = 0.5;
                ctx.drawImage(originEditState.referenceCanvas, 0, 0);
                ctx.globalAlpha = 1;
            }
            drawLayer(ctx, originEditState.originalCanvas, originEditState.transforms.original);
            drawLayer(ctx, originEditState.repairCanvas, originEditState.transforms.repair);
            drawLayer(ctx, originEditState.extraCanvas, originEditState.transforms.extra);
            if (originEditState.boundsVisible && originEditState.fontBounds) {
                const b = originEditState.fontBounds;
                ctx.save();
                ctx.setLineDash([4, 4]);
                ctx.strokeStyle = '#3b82f6';
                ctx.lineWidth = 1.2;
                ctx.strokeRect(b.x, b.y, b.w, b.h);
                ctx.restore();
            }
            if (originEditState._selectPreview) {
                drawSelectionPreview(ctx);
            } else if (activeSelectionMask()) {
                drawSelectionOverlay(ctx);
            }
            if (originEditState._shapePreview) drawShapePreview(ctx);
            ctx.restore();
            ctx.fillStyle = 'rgba(0,0,0,0.45)';
            ctx.font = '11px sans-serif';
            const layerName = originEditState.layer === 'original' ? '原字层(可擦)' : originEditState.layer === 'repair' ? '修符层(可移动/缩放/旋转)' : '新建图层(可移动)';
            ctx.fillText(uiText(`图层: ${layerName}`), 8, 16);
            ctx.fillText(uiText(`视图 缩放 ${originEditState.view.zoom.toFixed(2)} 旋转 ${originEditState.view.rotate.toFixed(0)}°`), 8, 30);
        }

        function updateWheelDot(hex) {
            const rgb = hexToRgb(hex);
            if (!rgb) return;
            const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            let h = 0;
            if (max !== min) {
                const d = max - min;
                if (max === r) h = ((g - b) / d) % 6;
                else if (max === g) h = (b - r) / d + 2;
                else h = (r - g) / d + 4;
                h = (h * 60) % 360;
                if (h < 0) h += 360;
            }
            const ang = h / 360 * 2 * Math.PI, radius = 24, cx = 32, cy = 32;
            const dot = $('originWheelDot');
            if (!dot) return;
            dot.style.left = (cx + radius * Math.cos(ang)) + 'px';
            dot.style.top = (cy + radius * Math.sin(ang)) + 'px';
            dot.style.backgroundColor = hex;
        }

        function applyHex(hex) {
            const rgb = hexToRgb(hex);
            if (!rgb) return;
            originEditState.color = hex;
            const picker = $('originColor'), hexEl = $('originHex');
            const rEl = $('originR'), gEl = $('originG'), bEl = $('originB');
            const rnEl = $('originRNum'), gnEl = $('originGNum'), bnEl = $('originBNum');
            const rvEl = $('originRVal'), gvEl = $('originGVal'), bvEl = $('originBVal');
            if (picker) picker.value = hex;
            if (hexEl) hexEl.value = hex;
            if (rEl) { rEl.value = rgb.r; gEl.value = rgb.g; bEl.value = rgb.b; }
            if (rnEl) { rnEl.value = rgb.r; gnEl.value = rgb.g; bnEl.value = rgb.b; }
            if (rvEl) { rvEl.textContent = rgb.r; gvEl.textContent = rgb.g; bvEl.textContent = rgb.b; }
            updateWheelDot(hex);
        }

        function setupOriginColorControls(disposers) {
            const picker = $('originColor'), hexEl = $('originHex'), wheel = $('originWheel');
            const rEl = $('originR'), gEl = $('originG'), bEl = $('originB');
            const rnEl = $('originRNum'), gnEl = $('originGNum'), bnEl = $('originBNum');
            const rvEl = $('originRVal'), gvEl = $('originGVal'), bvEl = $('originBVal');

            function readRGB(r, g, b) {
                return rgbToHex(clamp(parseInt(r) || 0, 0, 255), clamp(parseInt(g) || 0, 0, 255), clamp(parseInt(b) || 0, 0, 255));
            }

            function fromHex() {
                let v = hexEl.value.trim();
                if (!v.startsWith('#')) v = '#' + v;
                if (/^#[0-9a-f]{6}$/i.test(v)) applyHex(v);
            }

            const bind = (el, type, fn) => { if (el) { el[type] = fn; disposers.push(() => { el[type] = null; }); } };
            bind(picker, 'oninput', function() { applyHex(this.value); });
            bind(rEl, 'oninput', () => applyHex(readRGB(rEl.value, gEl.value, bEl.value)));
            bind(gEl, 'oninput', () => applyHex(readRGB(rEl.value, gEl.value, bEl.value)));
            bind(bEl, 'oninput', () => applyHex(readRGB(rEl.value, gEl.value, bEl.value)));
            bind(rnEl, 'oninput', () => applyHex(readRGB(rnEl.value, gnEl.value, bnEl.value)));
            bind(gnEl, 'oninput', () => applyHex(readRGB(rnEl.value, gnEl.value, bnEl.value)));
            bind(bnEl, 'oninput', () => applyHex(readRGB(rnEl.value, gnEl.value, bnEl.value)));
            bind(hexEl, 'onchange', fromHex);
            bind(hexEl, 'oninput', function() { if (this.value.trim().length === 7) fromHex(); });
            bind(wheel, 'onclick', function(e) {
                const rect = this.getBoundingClientRect();
                const x = (e.clientX - rect.left) / rect.width * 64;
                const y = (e.clientY - rect.top) / rect.height * 64;
                const dx = x - 32, dy = y - 32;
                if (Math.sqrt(dx * dx + dy * dy) < 4) return;
                let deg = (Math.atan2(dy, dx) / Math.PI * 180 + 360) % 360;
                applyHex(hslToHex(deg, 1, 0.5));
            });

            applyHex(originEditState.color || '#000000');
        }

        function hslToHex(h, s, l) {
            h = h / 360;
            const a = s * Math.min(l, 1 - l);
            const f = (n) => { const k = (n + h * 12) % 12; return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1); };
            return rgbToHex(Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255));
        }

        function setupOriginEvents() {
            const canvas = $('originEditCanvas');
            const wrap = $('originCanvasWrap');
            const disposers = [];
            originEditState._disposers = disposers;

            function down(e) {
                e.preventDefault();
                try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
                activePointers.set(e.pointerId, getCanvasPoint(e));
                if (activePointers.size === 1) {
                    strokeDown = true;
                    strokeLast = getCanvasPoint(e);
                    strokeHistoryPushed = false;
                    const key = currentLayerKey();
                    if (originEditState.tool === 'eyedropper') {
                        eyedropperPick(strokeLast);
                        strokeDown = false;
                        return;
                    } else if (originEditState.tool === 'move') {
                        pushHistory();
                        strokeHistoryPushed = true;
                        originEditState._dragStart = worldPoint(strokeLast);
                        originEditState._moveStart = { ...originEditState.transforms[key] };
                    } else if (originEditState.tool === 'brush' || originEditState.tool === 'eraser') {
                        pushHistory();
                        strokeHistoryPushed = true;
                        paintStroke(strokeLast, strokeLast);
                    } else if (originEditState.tool === 'shape') {
                        pushHistory();
                        strokeHistoryPushed = true;
                        const sp = layerLocalPoint(worldPoint(strokeLast), key);
                        originEditState._shapeStart = sp;
                        originEditState._shapePreview = { layer: key, type: originEditState.shapeType, fill: originEditState.shapeFill, x0: sp.x, y0: sp.y, x1: sp.x, y1: sp.y };
                    } else if (originEditState.tool === 'smudge') {
                        pushHistory();
                        strokeHistoryPushed = true;
                        const p = layerLocalPoint(worldPoint(strokeLast), key);
                        originEditState._smudgeColor = smudgeColorAt(p) || originEditState.color;
                    } else if (originEditState.tool === 'select') {
                        const p = layerLocalPoint(worldPoint(strokeLast), key);
                        originEditState._selectStart = p;
                        originEditState._selectPreview = { layer: key, type: 'rect', x: p.x, y: p.y, w: 0, h: 0 };
                        renderOriginEdit();
                    } else if (originEditState.tool === 'lasso') {
                        const p = layerLocalPoint(worldPoint(strokeLast), key);
                        originEditState._lassoPoints = [p];
                        originEditState._selectPreview = { layer: key, type: 'poly', points: [p] };
                        renderOriginEdit();
                    } else if (originEditState.tool === 'liquify') {
                        pushHistory();
                        strokeHistoryPushed = true;
                    }
                } else if (activePointers.size === 2) {
                    // 第二指到达：丢弃第一指已开始的笔画/移动，避免双指手势污染图层
                    if (strokeDown && strokeHistoryPushed) {
                        strokeHistoryPushed = false;
                        const snap = originHistory.pop();
                        if (snap) restoreSnapshot(snap);
                    }
                    strokeDown = false;
                    strokeLast = null;
                    originEditState._selectPreview = null;
                    const g = gestureGeometry([...activePointers.values()]);
                    gestureStart = { ...g, view: { ...originEditState.view } };
                    wrap.style.cursor = 'grabbing';
                }
            }

            function move(e) {
                e.preventDefault();
                if (!activePointers.has(e.pointerId)) return;
                activePointers.set(e.pointerId, getCanvasPoint(e));
                if (activePointers.size === 2 && gestureStart) {
                    const g = gestureGeometry([...activePointers.values()]);
                    const v = originEditState.view;
                    v.panX = gestureStart.view.panX + (g.centerX - gestureStart.centerX);
                    v.panY = gestureStart.view.panY + (g.centerY - gestureStart.centerY);
                    const ratio = gestureStart.distance > 0 ? g.distance / gestureStart.distance : 1;
                    v.zoom = clamp(gestureStart.view.zoom * ratio, 0.2, 5);
                    let da = g.angle - gestureStart.angle;
                    if (da > 180) da -= 360;
                    if (da < -180) da += 360;
                    v.rotate = gestureStart.view.rotate + da;
                    syncViewControls();
                    renderOriginEdit();
                    return;
                }
                if (!strokeDown) return;
                const cur = getCanvasPoint(e);
                if (originEditState.tool === 'move') {
                    const t = originEditState.transforms[currentLayerKey()];
                    const world = worldPoint(cur);
                    t.x = originEditState._moveStart.x + (world.x - originEditState._dragStart.x);
                    t.y = originEditState._moveStart.y + (world.y - originEditState._dragStart.y);
                    syncLayerTransformControls();
                    renderOriginEdit();
                } else if (originEditState.tool === 'brush' || originEditState.tool === 'eraser') {
                    paintStroke(strokeLast, cur);
                    strokeLast = cur;
                    renderOriginEdit();
                } else if (originEditState.tool === 'select') {
                    const p = layerLocalPoint(worldPoint(cur), currentLayerKey());
                    const s = originEditState._selectStart;
                    originEditState._selectPreview = { layer: currentLayerKey(), type: 'rect', x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
                    renderOriginEdit();
                } else if (originEditState.tool === 'lasso') {
                    const p = layerLocalPoint(worldPoint(cur), currentLayerKey());
                    const pts = originEditState._lassoPoints;
                    const last = pts[pts.length - 1];
                    if (Math.hypot(p.x - last.x, p.y - last.y) > 2) pts.push(p);
                    originEditState._selectPreview = { layer: currentLayerKey(), type: 'poly', points: pts };
                    renderOriginEdit();
                } else if (originEditState.tool === 'liquify') {
                    liquifyStroke(strokeLast, cur);
                    strokeLast = cur;
                    renderOriginEdit();
                } else if (originEditState.tool === 'shape') {
                    const p = layerLocalPoint(worldPoint(cur), currentLayerKey());
                    const s = originEditState._shapeStart;
                    originEditState._shapePreview = { layer: currentLayerKey(), type: originEditState.shapeType, fill: originEditState.shapeFill, x0: s.x, y0: s.y, x1: p.x, y1: p.y };
                    renderOriginEdit();
                } else if (originEditState.tool === 'smudge') {
                    const from = layerLocalPoint(worldPoint(strokeLast), currentLayerKey());
                    const to = layerLocalPoint(worldPoint(cur), currentLayerKey());
                    const sc = smudgeColorAt(to);
                    if (sc) originEditState._smudgeColor = sc;
                    smudgeStrokeFrom(from, to, originEditState._smudgeColor);
                    strokeLast = cur;
                    renderOriginEdit();
                }
            }

            function up(e) {
                activePointers.delete(e.pointerId);
                if (activePointers.size < 2) { gestureStart = null; wrap.style.cursor = 'grab'; }
                if (activePointers.size === 0) {
                    if (originEditState.tool === 'select' && originEditState._selectPreview) {
                        const p = originEditState._selectPreview;
                        if (p.w >= 2 || p.h >= 2) applySelectionShape((ctx) => ctx.rect(p.x, p.y, p.w, p.h));
                        originEditState._selectPreview = null;
                        renderOriginEdit();
                    } else if (originEditState.tool === 'lasso' && originEditState._selectPreview) {
                        const pts = originEditState._selectPreview.points;
                        if (pts.length >= 3) {
                            applySelectionShape((ctx) => { ctx.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y); ctx.closePath(); });
                        }
                        originEditState._selectPreview = null;
                        renderOriginEdit();
                    }
                    if (originEditState.tool === 'shape' && originEditState._shapePreview) {
                        const p = originEditState._shapePreview;
                        commitShape({ x: p.x0, y: p.y0 }, { x: p.x1, y: p.y1 });
                        originEditState._shapePreview = null;
                        renderOriginEdit();
                    }
                    strokeDown = false; strokeLast = null; strokeHistoryPushed = false;
                }
            }

            function wheel(e) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -0.08 : 0.08;
                originEditState.view.zoom = clamp(originEditState.view.zoom + delta, 0.2, 5);
                syncViewControls();
                renderOriginEdit();
            }

            function keydown(e) {
                if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undoOriginEdit(); }
                else if (e.key === 'Escape') { clearOriginSelection(); }
            }

            canvas.addEventListener('pointerdown', down);
            canvas.addEventListener('pointermove', move);
            canvas.addEventListener('pointerup', up);
            canvas.addEventListener('pointercancel', up);
            canvas.addEventListener('wheel', wheel, { passive: false });
            document.addEventListener('keydown', keydown);

            disposers.push(() => canvas.removeEventListener('pointerdown', down));
            disposers.push(() => canvas.removeEventListener('pointermove', move));
            disposers.push(() => canvas.removeEventListener('pointerup', up));
            disposers.push(() => canvas.removeEventListener('pointercancel', up));
            disposers.push(() => canvas.removeEventListener('wheel', wheel));
            disposers.push(() => document.removeEventListener('keydown', keydown));

            const on = (el, type, fn) => { if (el) { el[type] = fn; disposers.push(() => { el[type] = null; }); } };
            on($('originLayerSelect'), 'onchange', function() { originEditState.layer = this.value; originEditState.selectionMask = null; originEditState.selectionLayer = null; originEditState._selectPreview = null; syncLayerTransformControls(); renderOriginEdit(); });
            on($('selectMode'), 'onchange', function() { originEditState.selectMode = this.value; });
            on($('originShowRef'), 'onchange', function() { originEditState.refVisible = this.checked; renderOriginEdit(); });
            on($('originShowBounds'), 'onchange', function() { originEditState.boundsVisible = this.checked; renderOriginEdit(); });
            on($('originLockTransp'), 'onchange', function() { originEditState.lockTransparency = this.checked; });
            on($('originShapeType'), 'onchange', function() { originEditState.shapeType = this.value; });
            on($('originShapeFill'), 'onchange', function() { originEditState.shapeFill = this.checked; });
            on($('originBrushSize'), 'oninput', function() { originEditState.brushSize = parseFloat(this.value) || 6; $('originBrushSizeNum').value = this.value; $('originBrushSizeVal').textContent = this.value; });
            on($('originBrushSizeNum'), 'oninput', function() { let v = clamp(parseFloat(this.value) || 6, 1, 500); originEditState.brushSize = v; this.value = v; $('originBrushSize').value = v; $('originBrushSizeVal').textContent = v; });
            on($('viewZoom'), 'oninput', function() { originEditState.view.zoom = clamp(parseFloat(this.value), 0.2, 5); $('viewZoomVal').textContent = originEditState.view.zoom.toFixed(2); renderOriginEdit(); });
            on($('viewRotate'), 'oninput', function() { originEditState.view.rotate = parseFloat(this.value); $('viewRotateVal').textContent = originEditState.view.rotate.toFixed(0) + '°'; renderOriginEdit(); });

            function bindTransform(el, key, isTranslate) {
                if (!el) return;
                const begin = () => { if (!transformGestureDirty) { pushHistory(); transformGestureDirty = true; } };
                on(el, 'oninput', function() {
                    begin();
                    const t = originEditState.transforms[currentLayerKey()];
                    let v = parseFloat(this.value);
                    if (isNaN(v)) return;
                    if (!isTranslate) v = key === 'scale' ? clamp(v, 0.05, 5) : clamp(v, -180, 180);
                    t[key] = v;
                    syncLayerTransformControls();
                    renderOriginEdit();
                });
                on(el, 'onchange', function() { transformGestureDirty = false; });
            }
            bindTransform($('originLayerX'), 'x', true);
            bindTransform($('originLayerY'), 'y', true);
            bindTransform($('originGlyphScale'), 'scale', false);
            bindTransform($('originGlyphScaleNum'), 'scale', false);
            bindTransform($('originGlyphRotate'), 'rotate', false);
            bindTransform($('originGlyphRotateNum'), 'rotate', false);

            setupOriginColorControls(disposers);
        }

        async function openOriginEdit(glyphId) {
            const glyph = state.glyphs.find(g => g.id === glyphId);
            if (!glyph) { alert('修符不存在'); return; }
            if (!state.font) { alert('请先加载字体'); return; }

            closeOriginEdit();
            const session = ++originEditState.session;

            const targetChar = singleCharacter(glyph.char) || '宇';
            const layers = glyph.layers || null;
            const ref = buildReferenceCanvas(targetChar);
            // 目标字符改变时丢弃旧原字层（避免旧目标原字误用于新目标）
            const useStoredOriginal = !!(layers && layers.originalData && layers.sourceChar === glyph.char);
            const [storedOrig, storedRepair, storedExtra] = await Promise.all([
                useStoredOriginal ? canvasFromDataURL(layers.originalData) : Promise.resolve(null),
                (layers && layers.repairData) ? canvasFromDataURL(layers.repairData) : canvasFromDataURL(glyph.imgData),
                (layers && layers.extraData) ? canvasFromDataURL(layers.extraData) : Promise.resolve(null)
            ]);
            if (session !== originEditState.session) return;

            originEditState.glyphId = glyphId;
            originEditState.glyphData = glyph;
            originEditState.char = targetChar;
            originEditState.color = glyph.color || '#000000';
            originEditState.brushSize = 6;
            originEditState.tool = 'brush';
            originEditState.layer = 'repair';
            originEditState.refVisible = true;
            originEditState.boundsVisible = true;
            originEditState.referenceCanvas = ref.canvas;
            originEditState.fontBounds = ref.bounds;
            originEditState.originalCanvas = storedOrig || (ref.canvas ? cloneCanvas(ref.canvas) : newCanvas(EDIT_W, EDIT_H));
            originEditState.repairCanvas = storedRepair || newCanvas(1, 1);
            originEditState.extraCanvas = storedExtra || null;
            originEditState.transforms = {
                original: normalizeLayerTransform(layers && layers.originalTransform),
                repair: normalizeLayerTransform(layers && layers.repairTransform),
                extra: normalizeLayerTransform(layers && layers.extraTransform)
            };
            originEditState.view = { panX: 0, panY: 0, zoom: 1, rotate: 0 };
            originHistory = [];
            activePointers = new Map();
            gestureStart = null;
            strokeDown = false;
            strokeLast = null;
            transformGestureDirty = false;
            originEditState.selectionMask = null;
            originEditState.selectionLayer = null;
            originEditState._selectPreview = null;
            originEditState._lassoPoints = null;
            originEditState._shapePreview = null;
            originEditState._shapeStart = null;
            originEditState._smudgeColor = null;
            originEditState.lockTransparency = false;
            originEditState.shapeType = 'rect';
            originEditState.shapeFill = true;
            originEditState.selectMode = $('selectMode') ? $('selectMode').value : 'new';

            $('originEditModal').classList.add('active');
            $('originEditTitle').textContent = `修符: "${glyph.char || '无'}"`;
            $('originBrushSize').value = 6;
            $('originBrushSizeNum').value = 6;
            $('originBrushSizeVal').textContent = '6';
            $('originShowRef').checked = true;
            $('originShowBounds').checked = true;
            $('originLockTransp').checked = false;
            $('originShapeType').value = 'rect';
            $('originShapeFill').checked = true;
            $('originLayerSelect').value = 'repair';
            $('viewZoom').value = 1;
            $('viewZoomVal').textContent = '1.00';
            $('viewRotate').value = 0;
            $('viewRotateVal').textContent = '0°';
            syncLayerTransformControls();
            updateOriginToolUI();
            setupOriginEvents();
            renderOriginEdit();
            logStatus(`🔧 打开原始编辑: ${glyph.char || '修符'}`, 'info');
        }

        function setOriginTool(tool) {
            originEditState.tool = tool;
            updateOriginToolUI();
            renderOriginEdit();
        }

        function updateOriginToolUI() {
            const tools = ['brush', 'eraser', 'move', 'select', 'lasso', 'liquify', 'shape', 'smudge', 'eyedropper'];
            for (const t of tools) {
                const btn = $(`tool${t.charAt(0).toUpperCase() + t.slice(1)}`);
                if (btn) btn.classList.toggle('active-tool', t === originEditState.tool);
            }
        }

        function resetView() {
            originEditState.view = { panX: 0, panY: 0, zoom: 1, rotate: 0 };
            syncViewControls();
            renderOriginEdit();
        }

        function resetCurrentLayer() {
            pushHistory();
            originEditState.transforms[currentLayerKey()] = { x: 0, y: 0, scale: 1, rotate: 0 };
            syncLayerTransformControls();
            renderOriginEdit();
        }

        function clearOriginSelection() {
            originEditState.selectionMask = null;
            originEditState.selectionLayer = null;
            originEditState._selectPreview = null;
            renderOriginEdit();
        }

        function newLayerFromSelection() {
            const key = currentLayerKey();
            const c = currentLayerCanvas();
            const mask = activeSelectionMask();
            if (!c || !mask) { alert('请先用选区框选要分离的区域'); return; }
            pushHistory();
            // 提取选区内容到新建图层
            const extra = newCanvas(c.width, c.height);
            const ectx = extra.getContext('2d');
            ectx.drawImage(c, 0, 0);
            ectx.globalCompositeOperation = 'destination-in';
            ectx.drawImage(mask, 0, 0);
            ectx.globalCompositeOperation = 'source-over';
            // 从原图层移除选区内容
            const sctx = c.getContext('2d');
            sctx.globalCompositeOperation = 'destination-out';
            sctx.drawImage(mask, 0, 0);
            sctx.globalCompositeOperation = 'source-over';
            // 新建图层沿用原图层变换，保持视觉位置不变
            originEditState.extraCanvas = extra;
            originEditState.transforms.extra = { ...originEditState.transforms[key] };
            originEditState.layer = 'extra';
            $('originLayerSelect').value = 'extra';
            clearOriginSelection();
            syncLayerTransformControls();
            renderOriginEdit();
            logStatus('⊞ 已从选区新建图层', 'success');
        }

        function closeOriginEdit() {
            originEditState.session++;
            if (originEditState._disposers) {
                originEditState._disposers.forEach(fn => { try { fn(); } catch (_) {} });
                originEditState._disposers = null;
            }
            $('originEditModal').classList.remove('active');
            originEditState.referenceCanvas = null;
            originEditState.originalCanvas = null;
            originEditState.repairCanvas = null;
            originEditState.extraCanvas = null;
            originEditState.fontBounds = null;
            originEditState.initialized = false;
        }

        function confirmOriginEdit() {
            const glyph = state.glyphs.find(g => g.id === originEditState.glyphId);
            if (!glyph) { alert('修符已丢失'); closeOriginEdit(); return; }

            const out = newCanvas(EDIT_W, EDIT_H);
            const ctx = out.getContext('2d');
            drawLayer(ctx, originEditState.originalCanvas, originEditState.transforms.original);
            drawLayer(ctx, originEditState.repairCanvas, originEditState.transforms.repair);
            drawLayer(ctx, originEditState.extraCanvas, originEditState.transforms.extra);

            glyph.imgData = out.toDataURL('image/png');
            glyph.width = EDIT_W;
            glyph.height = EDIT_H;
            glyph.layers = {
                sourceChar: originEditState.char,
                originalData: originEditState.originalCanvas ? originEditState.originalCanvas.toDataURL() : null,
                repairData: originEditState.repairCanvas ? originEditState.repairCanvas.toDataURL() : null,
                extraData: originEditState.extraCanvas ? originEditState.extraCanvas.toDataURL() : null,
                originalTransform: { ...originEditState.transforms.original },
                repairTransform: { ...originEditState.transforms.repair },
                extraTransform: { ...originEditState.transforms.extra }
            };
            glyph.color = originEditState.color;
            delete glyph._image;
            delete glyph._imageSource;

            closeOriginEdit();
            renderGlyphList();
            renderAll();
            logStatus('✅ 原始编辑完成并保存', 'success');
        }
        // Otsu 自动阈值：按亮度自适应二值化，避免固定阈值把浅色描黑（导出偏暗）
        function binarizeOtsu(ctx, w, h) {
            const imageData = ctx.getImageData(0, 0, w, h);
            const data = imageData.data, N = w * h;
            const hist = new Array(256).fill(0);
            for (let i = 0; i < data.length; i += 4) {
                const a = data[i + 3] / 255;
                const lum = Math.round(a * (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) + (1 - a) * 255);
                hist[lum]++;
            }
            let sum = 0;
            for (let i = 0; i < 256; i++) sum += i * hist[i];
            let sumB = 0, wB = 0, maxVar = -1, thr = 128;
            for (let t = 0; t < 256; t++) {
                wB += hist[t];
                if (wB === 0) continue;
                const wF = N - wB;
                if (wF === 0) break;
                sumB += t * hist[t];
                const mB = sumB / wB, mF = (sum - sumB) / wF;
                const between = wB * wF * (mB - mF) * (mB - mF);
                if (between > maxVar) { maxVar = between; thr = t; }
            }
            for (let i = 0; i < data.length; i += 4) {
                const a = data[i + 3] / 255;
                const lum = Math.round(a * (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) + (1 - a) * 255);
                const v = lum <= thr ? 0 : 255;
                data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
            }
            ctx.putImageData(imageData, 0, 0);
        }

        // ===== 核心：导出TTF（修复版） =====
        // 图片 → 256×256 canvas（fillWhite=true 填白底用于单色；false 保留透明用于彩色分层）
        function loadImageToCanvas(dataURL, fillWhite = true) {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = function() {
                    try {
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');
                        const w = 256, h = 256;
                        canvas.width = w; canvas.height = h;
                        if (fillWhite) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
                        const ratio = Math.min(w / img.width, h / img.height);
                        const dw = img.width * ratio, dh = img.height * ratio;
                        ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
                        resolve(canvas);
                    } catch (e) { reject(e); }
                };
                img.onerror = () => reject(new Error('图片加载失败'));
                img.src = dataURL;
            });
        }

        // 矢量化：canvas → path d 字符串（只取前景黑色区域的轮廓；无轮廓返回 null）
        // ponytail: 参数是 2026-09-19 对拍实测最优档（9 组样本 / 56 层遮罩：IoU 0.959、最差 0.873、47ms；
        // 换掉前的 potrace 是 0.842 / 0.609 / 129ms）。要再调画质或速度只改这里，调用方不感知。
        const TRACE_OPTS = {
            ltres: 0.1, qtres: 0.5, pathomit: 0, rightangleenhance: false, blurradius: 1, blurdelta: 20,
            colorsampling: 0, numberofcolors: 2, mincolorratio: 0, colorquantcycles: 1,
            layering: 0, strokewidth: 0, linefilter: false, scale: 1, roundcoords: 2, viewbox: true, desc: false,
            pal: [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }]
        };
        function traceCanvasToPathD(canvas) {
            const ctx = canvas.getContext('2d');
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const svg = ImageTracer.imagedataToSVG(imageData, TRACE_OPTS);
            const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
            const d = [...doc.querySelectorAll('path')]
                .filter(p => (p.getAttribute('fill') || '').replace(/\s/g, '') === 'rgb(0,0,0)')
                .map(p => p.getAttribute('d'))
                .join(' ');
            return d || null;
        }

        // path d 字符串 → opentype.Path
        function pathDToPath(pathD) {
            const path = new opentype.Path();
            const commands = pathD.match(/[MLCQZ][^MLCQZ]*/g) || [];
            for (const cmd of commands) {
                const type = cmd[0];
                const nums = cmd.slice(1).trim().split(/[\s,]+/).filter(s => s !== '').map(Number);
                switch (type) {
                    case 'M': path.moveTo(nums[0], nums[1]); break;
                    case 'L': for (let i = 0; i < nums.length; i += 2) path.lineTo(nums[i], nums[i + 1]); break;
                    case 'C': for (let i = 0; i < nums.length; i += 6) path.bezierCurveTo(nums[i], nums[i + 1], nums[i + 2], nums[i + 3], nums[i + 4], nums[i + 5]); break;
                    case 'Q': for (let i = 0; i < nums.length; i += 4) path.quadraticCurveTo(nums[i], nums[i + 1], nums[i + 2], nums[i + 3]); break;
                    case 'Z': path.closePath(); break;
                }
            }
            return path;
        }

        // 非透明像素（alpha>=128）的 bbox，作为 base 与彩色层的统一缩放基准
        function computeOpaqueBox(imageData, w, h) {
            const d = imageData.data;
            let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                if (d[(y * w + x) * 4 + 3] < 128) continue;
                if (x < x1) x1 = x; if (x > x2) x2 = x;
                if (y < y1) y1 = y; if (y > y2) y2 = y;
            }
            if (x1 === Infinity) return null;
            return { x1, y1, x2, y2 };
        }

        // opentype.Path 按 bbox 缩放居中到 size 空间（原地修改）；box 可传入共享基准（非透明 bbox）
        function scalePathToSize(path, size, box) {
            const bbox = box || path.getBoundingBox();
            if (!bbox) return;
            const scale = size / Math.max(bbox.x2 - bbox.x1, bbox.y2 - bbox.y1);
            const cx = (bbox.x1 + bbox.x2) / 2, cy = (bbox.y1 + bbox.y2) / 2;
            for (const cmd of path.commands) {
                if (cmd.type === 'M' || cmd.type === 'L') {
                    cmd.x = (cmd.x - cx) * scale + size / 2;
                    cmd.y = (cmd.y - cy) * scale + size / 2;
                } else if (cmd.type === 'C') {
                    cmd.x = (cmd.x - cx) * scale + size / 2;
                    cmd.y = (cmd.y - cy) * scale + size / 2;
                    cmd.x1 = (cmd.x1 - cx) * scale + size / 2;
                    cmd.y1 = (cmd.y1 - cy) * scale + size / 2;
                    cmd.x2 = (cmd.x2 - cx) * scale + size / 2;
                    cmd.y2 = (cmd.y2 - cy) * scale + size / 2;
                } else if (cmd.type === 'Q') {
                    cmd.x = (cmd.x - cx) * scale + size / 2;
                    cmd.y = (cmd.y - cy) * scale + size / 2;
                    cmd.x1 = (cmd.x1 - cx) * scale + size / 2;
                    cmd.y1 = (cmd.y1 - cy) * scale + size / 2;
                }
            }
        }

        function imageToGlyph(dataURL, char, size, timeout = 15000) {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('矢量化超时（15秒）')), timeout);
                loadImageToCanvas(dataURL, false).then(canvas => {
                    const ctx = canvas.getContext('2d');
                    binarizeForMonochrome(ctx, canvas.width, canvas.height);
                    const pathD = traceCanvasToPathD(canvas);
                    clearTimeout(timer);
                    if (!pathD) throw new Error('没有识别到可用轮廓');
                    const path = pathDToPath(pathD);
                    if (!path.commands.length) throw new Error('没有识别到可用轮廓');
                    // 按整图（含透明边）缩放到 size，与预览 drawImage 一致，避免符号被裁掉透明边后放大到满 em
                    scalePathToSize(path, size, { x1: 0, y1: 0, x2: canvas.width, y2: canvas.height });
                    resolve(new opentype.Glyph({
                        name: char,
                        unicode: char.codePointAt(0),
                        advanceWidth: size,
                        path: path
                    }));
                }).catch(e => { clearTimeout(timer); reject(e); });
            });
        }

        // ===== COLR 彩色分层：PNG → 调色板 + 多层单色轮廓（每层一个 opentype.Path，统一缩放到 size 空间） =====
        // 检测实底背景色：四角均不透明且颜色相近时，视为纯色底（白底/纯色底 logo），返回平均色；透明或四角差异大返回 null
        function detectBackgroundColor(imageData, w, h, tol = 16) {
            const d = imageData.data;
            const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) => {
                const i = (y * w + x) * 4;
                return [d[i], d[i + 1], d[i + 2], d[i + 3]];
            });
            if (corners.some(c => c[3] < 128)) return null;
            const r = Math.round(corners.reduce((s, c) => s + c[0], 0) / 4);
            const g = Math.round(corners.reduce((s, c) => s + c[1], 0) / 4);
            const b = Math.round(corners.reduce((s, c) => s + c[2], 0) / 4);
            const spread = corners.reduce((m, c) => Math.max(m, Math.abs(c[0] - r) + Math.abs(c[1] - g) + Math.abs(c[2] - b)), 0);
            return spread > tol * 3 ? null : { r, g, b };
        }
        function isBackground(data, i, bg, tol = 16) {
            return bg && Math.abs(data[i] - bg.r) <= tol && Math.abs(data[i + 1] - bg.g) <= tol && Math.abs(data[i + 2] - bg.b) <= tol;
        }
        function binarizeForMonochrome(ctx, w, h) {
            const imageData = ctx.getImageData(0, 0, w, h);
            const data = imageData.data;
            const bg = detectBackgroundColor(imageData, w, h);
            let hasTransparent = false;
            for (let i = 0; i < data.length; i += 4) if (data[i + 3] < 128) { hasTransparent = true; break; }
            if (!hasTransparent && !bg) { binarizeOtsu(ctx, w, h); return; }
            let foreground = 0;
            for (let i = 0; i < data.length; i += 4) {
                const on = data[i + 3] >= 128 && !isBackground(data, i, bg);
                const v = on ? 0 : 255;
                data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
                if (on) foreground++;
            }
            if (!foreground && bg) {
                for (let i = 0; i < data.length; i += 4) {
                    const v = imageData.data[i + 3] >= 128 ? 0 : 255;
                    data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
                }
            }
            ctx.putImageData(imageData, 0, 0);
        }
        // 颜色量化：非透明像素按 5bit 预量化分桶，取高频 N 色；bg 非空时跳过背景色像素
        function quantizeColors(imageData, maxColors, bg) {
            const data = imageData.data;
            const buckets = new Map();
            for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] < 128) continue;
                if (isBackground(data, i, bg)) continue;
                const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
                let b = buckets.get(key);
                if (!b) { b = { r: 0, g: 0, b: 0, n: 0 }; buckets.set(key, b); }
                b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2]; b.n++;
            }
            // 按频率降序，贪心聚类合并相近色：渐变/抗锯齿会把同一色拆成多个近似 5bit 桶，挤掉其他颜色（如 😂 的褐/蓝/白被黄挤掉）
            const sorted = [...buckets.values()]
                .map(b => ({ r: Math.round(b.r / b.n), g: Math.round(b.g / b.n), b: Math.round(b.b / b.n), n: b.n }))
                .sort((a, b) => b.n - a.n);
            const clusters = [];
            const TOL2 = 48 * 48;
            for (const c of sorted) {
                let best = -1, bestD = TOL2 + 1;
                for (let j = 0; j < clusters.length; j++) {
                    const m = clusters[j];
                    const dr = m.r - c.r, dg = m.g - c.g, db = m.b - c.b;
                    const d2 = dr * dr + dg * dg + db * db;
                    if (d2 < bestD) { bestD = d2; best = j; }
                }
                if (best >= 0) {
                    const m = clusters[best];
                    const nn = m.n + c.n;
                    m.r = Math.round((m.r * m.n + c.r * c.n) / nn);
                    m.g = Math.round((m.g * m.n + c.g * c.n) / nn);
                    m.b = Math.round((m.b * m.n + c.b * c.n) / nn);
                    m.n = nn;
                } else if (clusters.length < maxColors) {
                    clusters.push({ r: c.r, g: c.g, b: c.b, n: c.n });
                }
            }
            return clusters.map(({ r, g, b }) => ({ r, g, b }));
        }

        // 图片 → 彩色分层；仅由每个修符的“导出为彩图”开关调用
        // 返回 { palette:[{r,g,b}], layers:[{ paletteIndex, path(opentype.Path, size 空间, 已对齐) }] }
        function imageToColrLayers(dataURL, size, maxColors = 12, timeout = 20000) {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('彩色矢量化超时')), timeout);
                loadImageToCanvas(dataURL, false).then(async canvas => {
                    try {
                        const w = canvas.width, h = canvas.height;
                        const imageData = canvas.getContext('2d').getImageData(0, 0, w, h);
                        // 检测实底背景色并在量化时跳过；若整图都是背景色（纯色图）则不排除，保留原色
                        let bg = detectBackgroundColor(imageData, w, h);
                        let palette = quantizeColors(imageData, maxColors, bg);
                        if (palette.length === 0 && bg) { bg = null; palette = quantizeColors(imageData, maxColors, null); }
                        if (palette.length < 1) {
                            clearTimeout(timer); resolve(null); return;
                        }

                        // 每个像素归到最近色索引（-1 = 透明/背景）
                        const data = imageData.data;
                        const pxCount = w * h;
                        const pxIdx = new Int16Array(pxCount).fill(-1);
                        for (let p = 0; p < pxCount; p++) {
                            const i = p * 4;
                            if (data[i + 3] < 128) continue;
                            if (isBackground(data, i, bg)) continue;
                            let best = 0, bestD = Infinity;
                            for (let c = 0; c < palette.length; c++) {
                                const dr = data[i] - palette[c].r, dg = data[i + 1] - palette[c].g, db = data[i + 2] - palette[c].b;
                                const d = dr * dr + dg * dg + db * db;
                                if (d < bestD) { bestD = d; best = c; }
                            }
                            pxIdx[p] = best;
                        }

                        // 每种颜色 → 掩码 canvas → 矢量化 → path
                        const layers = [];
                        for (let c = 0; c < palette.length; c++) {
                            const mc = document.createElement('canvas');
                            mc.width = w; mc.height = h;
                            const mimg = mc.getContext('2d').createImageData(w, h);
                            const md = mimg.data;
                            let has = false;
                            for (let p = 0; p < pxCount; p++) {
                                const o = p * 4;
                                if (pxIdx[p] === c) { md[o] = 0; md[o + 1] = 0; md[o + 2] = 0; md[o + 3] = 255; has = true; }
                                else { md[o] = 255; md[o + 1] = 255; md[o + 2] = 255; md[o + 3] = 255; }
                            }
                            if (!has) continue;
                            mc.getContext('2d').putImageData(mimg, 0, 0);
                            const pathD = traceCanvasToPathD(mc);
                            if (pathD) {
                                const path = pathDToPath(pathD);
                                if (path.commands.length) layers.push({ paletteIndex: c, path });
                            }
                        }
                        clearTimeout(timer);
                        if (layers.length < 1) { resolve(null); return; }

                        // 所有层统一按整图（含透明边）缩放到 size，与预览 drawImage 一致、与 base 共用同一基准保证对齐
                        const scale = size / Math.max(w, h);
                        const cx = w / 2, cy = h / 2;
                        const ax = x => (x - cx) * scale + size / 2;
                        const ay = y => (y - cy) * scale + size / 2;
                        for (const l of layers) {
                            for (const cmd of l.path.commands) {
                                if (cmd.type === 'M' || cmd.type === 'L') { cmd.x = ax(cmd.x); cmd.y = ay(cmd.y); }
                                else if (cmd.type === 'C') { cmd.x = ax(cmd.x); cmd.y = ay(cmd.y); cmd.x1 = ax(cmd.x1); cmd.y1 = ay(cmd.y1); cmd.x2 = ax(cmd.x2); cmd.y2 = ay(cmd.y2); }
                                else if (cmd.type === 'Q') { cmd.x = ax(cmd.x); cmd.y = ay(cmd.y); cmd.x1 = ax(cmd.x1); cmd.y1 = ay(cmd.y1); }
                            }
                        }
                        resolve({ palette, layers });
                    } catch (e) { clearTimeout(timer); reject(e); }
                }).catch(e => { clearTimeout(timer); reject(e); });
            });
        }

        function repairAdvanceWidth(glyphData, upm) {
            const w = Math.max(1, Number(glyphData.width) || 48);
            const h = Math.max(1, Number(glyphData.height) || 48);
            return upm * ((Number(glyphData.size) || 48) / 48) * w / Math.max(w, h);
        }

        function importPathToGlyf(core, path) {
            const imported = core.svg2ttfobject(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${path.toPathData(3)}"/></svg>`, { combinePath: true });
            return imported && imported.glyf ? imported.glyf.find(g => g.contours && g.contours.length) : null;
        }

        // glyf 点集的「曲线几何」包围盒（直线取端点、二次贝塞尔取真实极值），与 fonteditor-core computePath 同法
        function contoursGeomBox(contours) {
            let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
            const add = (x, y) => { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; };
            const bezT = (a, b, c) => { const d = a + c - 2 * b; return d === 0 ? 0.5 : Math.max(0, Math.min(1, (a - b) / d)); };
            const bezAt = (a, b, c, t) => { const m = 1 - t; return m * m * a + 2 * m * t * b + t * t * c; };
            for (const contour of contours) {
                const l = contour.length;
                if (!l) continue;
                let cursorPoint;
                for (let i = 0; i < l; i++) {
                    const curPoint = contour[i];
                    const prevPoint = i === 0 ? contour[l - 1] : contour[i - 1];
                    const nextPoint = i === l - 1 ? contour[0] : contour[i + 1];
                    if (i === 0) {
                        cursorPoint = curPoint.onCurve ? curPoint
                            : prevPoint.onCurve ? prevPoint
                            : { x: (prevPoint.x + curPoint.x) / 2, y: (prevPoint.y + curPoint.y) / 2 };
                    }
                    if (curPoint.onCurve && nextPoint.onCurve) {
                        add(curPoint.x, curPoint.y); add(nextPoint.x, nextPoint.y);
                        cursorPoint = nextPoint;
                    } else if (!curPoint.onCurve) {
                        const end = nextPoint.onCurve ? nextPoint : { x: (curPoint.x + nextPoint.x) / 2, y: (curPoint.y + nextPoint.y) / 2 };
                        const t1 = bezT(cursorPoint.x, curPoint.x, end.x), t2 = bezT(cursorPoint.y, curPoint.y, end.y);
                        add(bezAt(cursorPoint.x, curPoint.x, end.x, t1), bezAt(cursorPoint.y, curPoint.y, end.y, t1));
                        add(bezAt(cursorPoint.x, curPoint.x, end.x, t2), bezAt(cursorPoint.y, curPoint.y, end.y, t2));
                        add(end.x, end.y);
                        cursorPoint = end;
                    }
                }
            }
            return { x1, y1, x2, y2 };
        }

        // imported（svg2ttfobject 输出）→ font 空间轮廓。base 与彩色层必须共用这一条映射，否则各层各偏一点。
        // 库内会先绕「转换后轮廓的曲线包围盒中心」镜像 y，再整体按 S=1024/unitsPerEm 缩放；这里全部从 imported 自身反推：
        // S = 几何范围之比，镜像中心由上/下界给出。不要再用 path.getBoundingBox() 当基准——转换前后的点集不是同一套，会错位。
        function importContoursToFont(imported, path, size, upm, targetCenterX, targetCenterY) {
            const raw = path.getBoundingBox() || { x1: 0, y1: 0, x2: 1, y2: 1 };
            const geo = contoursGeomBox(imported.contours);
            const rx = raw.x2 - raw.x1, ry = raw.y2 - raw.y1;
            const gx = geo.x2 - geo.x1, gy = geo.y2 - geo.y1;
            const S = (rx >= ry ? gx / Math.max(1e-9, rx) : gy / Math.max(1e-9, ry)) || 1;
            const scale = upm * ((Number(size) || 48) / 48) / 48; // 48 空间 → font 单位
            return imported.contours.map(contour => contour.map(point => ({
                x: Math.round((point.x / S - 24) * scale + targetCenterX),
                y: Math.round((24 - (geo.y1 + geo.y2 - point.y) / S) * scale + targetCenterY),
                onCurve: point.onCurve
            })));
        }

        // 彩色 layer path（48 空间，已对齐）→ glyf 轮廓（与 base glyph 共用同一映射）
        function layerPathToGlyf(core, path, glyphData, sourceGlyph, fontObject) {
            const imported = importPathToGlyf(core, path);
            if (!imported) return null;
            const upm = fontObject.head.unitsPerEm || 1000;
            const advanceWidth = repairAdvanceWidth(glyphData, upm);
            const contours = importContoursToFont(imported, path, glyphData.size, upm,
                advanceWidth / 2 + (glyphData.xOffset || 0) * upm / 48,
                upm / 2 - (glyphData.yOffset || 0) * upm / 48);
            const points = contours.flat();
            const xMin = Math.min(...points.map(p => p.x));
            const xMax = Math.max(...points.map(p => p.x));
            const yMin = Math.min(...points.map(p => p.y));
            const yMax = Math.max(...points.map(p => p.y));
            return {
                contours, xMin, xMax, yMin, yMax, leftSideBearing: xMin,
                advanceWidth: Math.max(1, Math.round(advanceWidth + (glyphData.letterSpacing || 0) * upm / 48))
            };
        }

        function makeExportGlyph(core, vectorGlyph, glyphData, codePoint, sourceGlyph, fontObject) {
            const imported = importPathToGlyf(core, vectorGlyph.path);
            if (!imported) throw new Error('没有识别到可用轮廓');

            const upm = fontObject.head.unitsPerEm || 1000;
            const advanceWidth = repairAdvanceWidth(glyphData, upm);
            const contours = importContoursToFont(imported, vectorGlyph.path, glyphData.size, upm,
                advanceWidth / 2 + (glyphData.xOffset || 0) * upm / 48,
                upm / 2 - (glyphData.yOffset || 0) * upm / 48);
            const points = contours.flat();
            const xMin = Math.min(...points.map(point => point.x));
            const xMax = Math.max(...points.map(point => point.x));
            const yMin = Math.min(...points.map(point => point.y));
            const yMax = Math.max(...points.map(point => point.y));
            const unicode = [codePoint];

            return {
                name: sourceGlyph?.name || (codePoint <= 0xFFFF ? 'uni' : 'u') + codePoint.toString(16).toUpperCase().padStart(4, '0'),
                unicode,
                contours,
                xMin,
                xMax,
                yMin,
                yMax,
                leftSideBearing: xMin,
                advanceWidth: Math.max(1, Math.round(advanceWidth + (glyphData.letterSpacing || 0) * upm / 48))
            };
        }

        // ===== 全局「排除」：写在这里的字符不参与全局调整 =====
        // 只挡「全局」，不挡「指定」（要给排除的字单独调，用「指定」）。只按码点过滤、不做逐字形克隆：
        // 一个 glyf 被多个码点共用（罕见）时，只要其中还有未排除的码点，该字形仍按全局调整。
        const GLOBAL_EXCLUDE_DEFAULTS = Object.freeze({ ...CTRL_DEFAULTS, color: '#000000' });
        function v5GlobalExcludeCodes() {
            const set = new Set();
            for (const ch of String(state.global.exclude || '')) {
                const cp = ch.codePointAt(0);
                if (cp !== undefined) set.add(cp);
            }
            return set;
        }

        // ===== 几何写入辅助 =====
        function specificHasWritable() {
            for (const v of Object.values(state.specific)) {
                if (!v || typeof v !== 'object') continue;
                if ((v.size !== undefined && v.size !== 48) ||
                    (v.letterSpacing !== undefined && v.letterSpacing !== 0) ||
                    (v.weight !== undefined && v.weight !== 400) ||
                    (v.baseline !== undefined && v.baseline !== 0)) return true;
            }
            return false;
        }

        function hasWritableColor() {
            if (state.global.color && String(state.global.color).toLowerCase() !== '#000000') return true;
            for (const v of Object.values(state.specific)) {
                if (v && typeof v === 'object' && v.color && String(v.color).toLowerCase() !== '#000000') return true;
            }
            return false;
        }

        function hasWritableAdjustments() {
            const g = state.global;
            if ((g.size !== ADJUSTMENT_DEFAULTS.size) || (g.letterSpacing !== ADJUSTMENT_DEFAULTS.letterSpacing) ||
                (g.weight !== ADJUSTMENT_DEFAULTS.weight) || (g.baseline !== ADJUSTMENT_DEFAULTS.baseline) ||
                (g.lineHeight !== ADJUSTMENT_DEFAULTS.lineHeight)) return true;
            if (specificHasWritable()) return true;
            if (state.glyphs.length > 0) return true;
            if (hasWritableColor() || hasColorOnlyChanges()) return true;
            return false;
        }

        function hasColorOnlyChanges() {
            const g = state.global;
            if ((g.color && g.color !== '#000000') || (g.fine ?? 50) !== 50 || (g.brightness ?? 100) !== 100 || (g.hue ?? 0) !== 0) return true;
            for (const v of Object.values(state.specific)) {
                if (!v || typeof v !== 'object') continue;
                if ((v.color && v.color !== '#000000') || (v.fine !== undefined && v.fine !== 50) ||
                    (v.brightness !== undefined && v.brightness !== 100) || (v.hue !== undefined && v.hue !== 0)) return true;
            }
            for (const x of state.glyphs) {
                if ((x.color && x.color !== '#000000') || (x.fine !== undefined && x.fine !== 50) ||
                    (x.brightness !== undefined && x.brightness !== 100) || (x.hue !== undefined && x.hue !== 0)) return true;
            }
            return false;
        }

        function specificByCodePoint() {
            const map = new Map();
            for (const [ch, v] of Object.entries(state.specific)) {
                const cp = ch.codePointAt(0);
                if (cp !== undefined && v && typeof v === 'object') map.set(cp, v);
            }
            return map;
        }

        // 顶部优先：同一目标字符只保留数组中最靠前的修符
        function buildTopPriorityTargets(glyphList) {
            const map = new Map();
            for (const g of (Array.isArray(glyphList) ? glyphList : [])) {
                const char = singleCharacter(g && g.char);
                if (!char) continue;
                const cp = char.codePointAt(0);
                if (!map.has(cp)) map.set(cp, g);
            }
            return map;
        }

        function checksumOfBytes(bytes) {
            let sum = 0; const n = bytes.length; let i = 0;
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for (; i + 4 <= n; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
            let rem = 0;
            for (let j = i; j < n; j++) rem = (rem << 8) | bytes[j];
            for (let k = 0; k < ((4 - (n - i)) & 3); k++) rem <<= 8;
            return (sum + rem) >>> 0;
        }

        // 通用：给 TTF 追加若干表（重排 sfnt + 重算 head checkSumAdjustment）
        // newTables: [{ tag: 'COLR', data: Uint8Array }]
        function appendTables(ttfBuffer, newTables) {
            const arr = new Uint8Array(ttfBuffer);
            const dv = new DataView(arr.buffer);
            const numTables = dv.getUint16(4);
            const dirStart = 12;
            const tables = [];
            for (let i = 0; i < numTables; i++) {
                const o = dirStart + i * 16;
                tables.push({ tag: String.fromCharCode(arr[o], arr[o + 1], arr[o + 2], arr[o + 3]), checkSum: dv.getUint32(o + 4), offset: dv.getUint32(o + 8), length: dv.getUint32(o + 12) });
            }
            const replacementTags = new Set(newTables.map(t => t.tag));
            const unique = new Map();
            for (const t of tables) {
                if (!replacementTags.has(t.tag) && !unique.has(t.tag)) unique.set(t.tag, { ...t, data: arr.subarray(t.offset, t.offset + t.length) });
            }
            const tableData = [...unique.values()];
            const added = newTables.map(t => ({ tag: t.tag, checkSum: checksumOfBytes(t.data), length: t.data.length, data: t.data }));
            const newNumTables = tableData.length + added.length;
            const newDirLen = 12 + newNumTables * 16;
            const align4 = n => (n + 3) & ~3;
            const dataOrder = [...tableData].sort((a, b) => a.offset - b.offset);
            for (const t of added) dataOrder.push(t);
            let cursor = align4(newDirLen);
            const placedTables = dataOrder.map(t => { const offset = cursor; cursor = align4(cursor + t.data.length); return { ...t, offset }; });
            const out = new Uint8Array(cursor);
            const odv = new DataView(out.buffer);
            odv.setUint32(0, dv.getUint32(0));   // 保留源 sfnt 版本（OTTO / true / 0x00010000），改名链要原样传递
            odv.setUint16(4, newNumTables);
            const maxPow = Math.floor(Math.log2(newNumTables));
            odv.setUint16(6, (1 << maxPow) * 16);
            odv.setUint16(8, maxPow);
            odv.setUint16(10, newNumTables * 16 - (1 << maxPow) * 16);
            const dirOrder = [...placedTables].sort((a, b) => a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);
            dirOrder.forEach((t, i) => {
                const o = 12 + i * 16;
                odv.setUint8(o, t.tag.charCodeAt(0));
                odv.setUint8(o + 1, t.tag.charCodeAt(1));
                odv.setUint8(o + 2, t.tag.charCodeAt(2));
                odv.setUint8(o + 3, t.tag.charCodeAt(3));
                odv.setUint32(o + 4, t.checkSum);
                odv.setUint32(o + 8, t.offset);
                odv.setUint32(o + 12, t.length);
            });
            for (const t of placedTables) out.set(t.data, t.offset);
            const headEntry = placedTables.find(t => t.tag === 'head');
            const headDirIdx = dirOrder.findIndex(t => t.tag === 'head');
            const headData = out.subarray(headEntry.offset, headEntry.offset + headEntry.length);
            odv.setUint32(headEntry.offset + 8, 0);
            odv.setUint32(12 + headDirIdx * 16 + 4, checksumOfBytes(headData));
            const wholeSum = checksumOfBytes(out);
            odv.setUint32(headEntry.offset + 8, (0xB1B0AFBA - wholeSum) >>> 0);
            // head 的目录校验值按规范保持 checkSumAdjustment=0 时的结果
            return out.buffer;
        }

        // 取字体里某张表的原始字节（找不到返回 null）
        function readTableBytes(buffer, tag) {
            const arr = new Uint8Array(buffer), dv = new DataView(arr.buffer);
            if (arr.length < 12) return null;
            const numTables = dv.getUint16(4);
            for (let i = 0; i < numTables; i++) {
                const o = 12 + i * 16;
                if (String.fromCharCode(arr[o], arr[o + 1], arr[o + 2], arr[o + 3]) !== tag) continue;
                const offset = dv.getUint32(o + 8), length = dv.getUint32(o + 12);
                if (offset + length > arr.length) return null;
                return arr.slice(offset, offset + length);
            }
            return null;
        }

        // ponytail: 防漂移——编辑后重写字体时，把源字体的 name 表整表回填。
        // fonteditor-core 写回只重建它认识的那几条记录，中文家族名会整批丢掉（真机表现：Kindle 上退成
        // 公众号名或 FZSJ-XINKTDZK 这类 PostScript 代号）。整表回填比按 ID 逐条重写稳：原语言、原平台、
        // 厂商私有记录一律不动，代价只是多一次 sfnt 重排。
        function restoreOriginalNames(buffer) {
            const raw = state.fontBuffer ? readTableBytes(state.fontBuffer, 'name') : null;
            return appendTables(buffer, raw && raw.length ? [{ tag: 'name', data: raw }] : []);
        }

        // ===== P1 字体内部真名：name 表级重写（其它表原字节复用，只重排 sfnt） =====
        // 只覆盖 nameID 1/2/3/4/6/16/17（+ VF 的 25），其余平台/语言/私有记录原样保留；
        // Mac(platform 1) 记录只在能 ASCII 表示时才改写，写不了就原样留着。
        function parseNameTable(bytes) {
            if (!bytes || bytes.length < 6) return null;
            const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const format = dv.getUint16(0), count = dv.getUint16(2), stringOffset = dv.getUint16(4);
            const records = [];
            for (let i = 0; i < count; i++) {
                const o = 6 + i * 12;
                if (o + 12 > bytes.length) return null;
                const platformID = dv.getUint16(o), encodingID = dv.getUint16(o + 2), languageID = dv.getUint16(o + 4), nameID = dv.getUint16(o + 6);
                const length = dv.getUint16(o + 8), offset = dv.getUint16(o + 10);
                if (stringOffset + offset + length > bytes.length) return null;
                records.push({ platformID, encodingID, languageID, nameID, data: bytes.slice(stringOffset + offset, stringOffset + offset + length) });
            }
            const langTags = [];
            if (format === 1) {
                const lt = 6 + count * 12;
                if (lt + 2 > bytes.length) return null;
                const langTagCount = dv.getUint16(lt);
                for (let i = 0; i < langTagCount; i++) {
                    const o = lt + 2 + i * 4;
                    if (o + 4 > bytes.length) return null;
                    const length = dv.getUint16(o), offset = dv.getUint16(o + 2);
                    if (stringOffset + offset + length > bytes.length) return null;
                    langTags.push({ data: bytes.slice(stringOffset + offset, stringOffset + offset + length) });
                }
            }
            return { format, records, langTags };
        }

        function decodeNameRecord(rec) {
            const b = rec.data;
            if (rec.platformID === 0 || rec.platformID === 3) {
                let s = '';
                for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
                return s;
            }
            let s = '';
            for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
            return s;
        }

        function encodeNameRecord(text, platformID) {
            if (platformID === 0 || platformID === 3) {
                const out = new Uint8Array(text.length * 2);
                for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); out[i * 2] = c >> 8; out[i * 2 + 1] = c & 0xff; }
                return out;
            }
            for (const ch of text) { const c = ch.codePointAt(0); if (c < 0x20 || c > 0x7e) return null; }   // Mac/其它编码不承诺非 ASCII
            return new Uint8Array([...text].map(c => c.charCodeAt(0)));
        }

        function nameValue(parsed, nameID, platformID, languageID) {
            const hit = parsed.records.find(r => r.nameID === nameID && r.platformID === platformID && r.languageID === languageID);
            return hit ? decodeNameRecord(hit) : '';
        }

        // PostScript 名必须 ASCII、无空格；家族名本身没有 ASCII 内容（纯中文）时保留原记录，不编造代号
        function nameTableValues(parsed, family, subfamily) {
            const famAscii = String(family).replace(/[^A-Za-z0-9]/g, '');
            const raw = `${famAscii}-${String(subfamily).replace(/[^A-Za-z0-9]/g, '')}`.replace(/^-+|-+$/g, '');
            const originalPs = nameValue(parsed, 6, 3, 0x409) || nameValue(parsed, 6, 1, 0) || '';
            const ps = /[A-Za-z0-9]/.test(famAscii) ? raw.slice(0, 63) : originalPs;
            const values = new Map([[1, family], [2, subfamily], [3, `${family};${subfamily}`], [4, `${family} ${subfamily}`.trim()], [16, family], [17, subfamily]]);
            if (ps) { values.set(6, ps); if (parsed.records.some(r => r.nameID === 25)) values.set(25, ps); }
            return values;
        }

        function buildNameTable(source, family, subfamily) {
            const parsed = parseNameTable(source);
            if (!parsed || !parsed.records.length) throw new Error('这个字体的内部名称表无法解析，已阻断改名');
            const values = nameTableValues(parsed, family, subfamily);
            const out = [];
            for (const rec of parsed.records) {
                if (!values.has(rec.nameID)) { out.push(rec); continue; }
                const enc = encodeNameRecord(values.get(rec.nameID), rec.platformID);
                out.push(enc ? { ...rec, data: enc } : rec);
            }
            // 补 Windows Unicode 的 en-US / zh-CN（缺哪条补哪条，不动已存在的其它语言）
            for (const [nameID, text] of values) {
                for (const languageID of [0x0409, 0x0804]) {
                    if (parsed.records.some(r => r.platformID === 3 && r.encodingID === 1 && r.languageID === languageID && r.nameID === nameID)) continue;
                    out.push({ platformID: 3, encodingID: 1, languageID, nameID, data: encodeNameRecord(text, 3) });
                }
            }
            out.sort((a, b) => a.platformID - b.platformID || a.encodingID - b.encodingID || a.languageID - b.languageID || a.nameID - b.nameID);
            const langTags = parsed.langTags || [];
            const count = out.length;
            const headerLen = 6 + count * 12 + (langTags.length ? 2 + langTags.length * 4 : 0);
            let size = headerLen;
            for (const r of out) size += r.data.length;
            for (const t of langTags) size += t.data.length;
            // name 表字段是 uint16（stringOffset、每条记录 length/offset），超了就会写出坏表——宁可阻断也不产坏字体
            const stringStorage = size - headerLen;
            const maxLen = [...out.map(r => r.data.length), ...langTags.map(t => t.data.length)].reduce((n, v) => Math.max(n, v), 0);
            if (headerLen > 0xFFFF || stringStorage > 0xFFFF || maxLen > 0xFFFF) throw new Error('这个字体的名称表太大（超出 16 位字段上限），已阻断改名以免写出坏字体');
            const bytes = new Uint8Array(size);
            const dv = new DataView(bytes.buffer);
            dv.setUint16(0, langTags.length ? 1 : 0);
            dv.setUint16(2, count);
            dv.setUint16(4, headerLen);
            let p = headerLen;
            out.forEach((r, i) => {
                const o = 6 + i * 12;
                dv.setUint16(o, r.platformID); dv.setUint16(o + 2, r.encodingID); dv.setUint16(o + 4, r.languageID);
                dv.setUint16(o + 6, r.nameID); dv.setUint16(o + 8, r.data.length); dv.setUint16(o + 10, p - headerLen);
                bytes.set(r.data, p); p += r.data.length;
            });
            if (langTags.length) {   // format 1 的语言标签子表原字节保留
                const lt = 6 + count * 12;
                dv.setUint16(lt, langTags.length);
                langTags.forEach((t, i) => { const o = lt + 2 + i * 4; dv.setUint16(o, t.data.length); dv.setUint16(o + 2, p - headerLen); bytes.set(t.data, p); p += t.data.length; });
            }
            return bytes;
        }

        // 把新名字写回会话里的字体：只换 name 表，字形/布局表原字节复用（50MB 字体也不用重写字形）
        function applyInternalName(family, subfamily) {
            if (!state.fontBuffer) throw new Error('请先导入字体');
            const source = readTableBytes(state.fontBuffer, 'name');
            if (!source || !source.length) throw new Error('这个字体没有内部名称表，无法改名');
            const next = appendTables(state.fontBuffer, [{ tag: 'name', data: buildNameTable(source, family, subfamily) }]);
            const font = opentype.parse(next);
            if (!font || !(font.numGlyphs > 0)) throw new Error('改名后字体无法解析，已放弃（字体未改动）');
            state.fontBuffer = next; state.font = font;
            $('fontStatus').textContent = `✅ ${state.fontName} (${font.familyName || '未知'})`;
            renderAll();
            return font;
        }

        // COLR/CPAL 彩色分层：给导出 TTF 附加 COLR v0 + CPAL v0（iOS/Chrome 显示彩色，字体颜色不覆盖彩色层）
        // colrEntries: [{ baseGlyphId, layerGlyphIds:[...], paletteIndices:[...] }]
        // palette: [{ r, g, b }]（CPAL 调色板，跨所有修符共享）
        function buildColrV0Table(colrEntries) {
            const entries = [...colrEntries].sort((a, b) => a.baseGlyphId - b.baseGlyphId);
            let totalLayers = 0;
            for (const e of entries) {
                if (e.layerGlyphIds.length !== e.paletteIndices.length) throw new Error('彩色字体的图层与颜色数量不一致');
                totalLayers += e.layerGlyphIds.length;
            }
            const nBase = entries.length;
            if (nBase > 65535 || totalLayers > 65535) throw new Error('彩色图层数量超过 TTF 上限');
            const colr = new Uint8Array(14 + nBase * 6 + totalLayers * 4);
            const cv = new DataView(colr.buffer);
            cv.setUint16(0, 0); cv.setUint16(2, nBase); cv.setUint32(4, 14);
            cv.setUint32(8, 14 + nBase * 6); cv.setUint16(12, totalLayers);
            let p = 14, li = 0;
            for (const e of entries) {
                cv.setUint16(p, e.baseGlyphId); cv.setUint16(p + 2, li); cv.setUint16(p + 4, e.layerGlyphIds.length);
                p += 6; li += e.layerGlyphIds.length;
            }
            for (const e of entries) {
                for (let i = 0; i < e.layerGlyphIds.length; i++) {
                    cv.setUint16(p, e.layerGlyphIds[i]); cv.setUint16(p + 2, e.paletteIndices[i]); p += 4;
                }
            }
            return colr;
        }

        // fonteditor-core 写 format 4 只用 idDelta 分段：码点与字形号顺序不一致时会绽成上万段，
        // 而子表长度是 16 位字段，超过 65535 就溢出 → cmap 整张损坏（严格解析器直接报错；
        // 导出 VF 时 fontTools 编母版会 `IndexError: array index out of range` 失败）。
        // 这里按规范重建 cmap：BMP 用 format 4（段内用 idRangeOffset 指向 glyphIndexArray，
        // 段数只跟「码点是否连续」有关）＋ format 12 覆盖全部码点；子表数据由记录共享（源字体也这么排）。
        function buildCmapTable(glyfList) {
            const gidByCp = new Map();
            glyfList.forEach((g, gid) => {
                const codes = Array.isArray(g?.unicode) ? g.unicode : (g?.unicode === undefined || g?.unicode === null ? [] : [g.unicode]);
                for (const cp of codes) if (Number.isInteger(cp) && cp >= 0 && cp <= 0x10FFFF) gidByCp.set(cp, gid);
            });
            const cps = [...gidByCp.keys()].sort((a, b) => a - b);
            const runs = [];                                   // 码点连续段（段内字形号任意）
            for (const cp of cps) {
                const last = runs[runs.length - 1];
                if (last && cp === last.end + 1) last.end = cp; else runs.push({ start: cp, end: cp });
            }
            const groups = [];                                 // format 12 组：码点与字形号同时连续
            for (const cp of cps) {
                const last = groups[groups.length - 1], gid = gidByCp.get(cp);
                if (last && cp === last.end + 1 && gid === last.startId + (cp - last.start)) last.end = cp;
                else groups.push({ start: cp, end: cp, startId: gid });
            }
            const f12 = new Uint8Array(16 + groups.length * 12);
            const d12 = new DataView(f12.buffer);
            d12.setUint16(0, 12); d12.setUint32(4, f12.length); d12.setUint32(12, groups.length);
            groups.forEach((g, i) => { d12.setUint32(16 + i * 12, g.start); d12.setUint32(20 + i * 12, g.end); d12.setUint32(24 + i * 12, g.startId); });
            const bmp = runs.filter(r => r.start <= 0xFFFF).map(r => ({ start: r.start, end: Math.min(r.end, 0xFFFF) }));
            const chars = [];
            for (const r of bmp) for (let cp = r.start; cp <= r.end; cp++) chars.push(gidByCp.get(cp) & 0xFFFF);
            const segCount = bmp.length + 1;
            const f4len = 16 + 8 * segCount + 2 * chars.length;
            let f4 = null;
            // ponytail: 只有「BMP 码点极碎」的字体（码点数 ≳ 3 万）才会走到这里；那时只留 format 12，它本身也能表示 BMP
            if (f4len <= 0xFFFF) {
                f4 = new Uint8Array(f4len);
                const d4 = new DataView(f4.buffer);
                const maxExp = Math.floor(Math.log(segCount) / Math.LN2), searchRange = 2 * Math.pow(2, maxExp);
                d4.setUint16(0, 4); d4.setUint16(2, f4len); d4.setUint16(6, segCount * 2);
                d4.setUint16(8, searchRange); d4.setUint16(10, maxExp); d4.setUint16(12, 2 * segCount - searchRange);
                const endO = 14, startO = 16 + 2 * segCount, deltaO = startO + 2 * segCount, rangeO = deltaO + 2 * segCount, glyphO = rangeO + 2 * segCount;
                let ci = 0;
                bmp.forEach((r, i) => {
                    const n = r.end - r.start + 1;
                    d4.setUint16(endO + i * 2, r.end);
                    d4.setUint16(startO + i * 2, r.start);
                    d4.setUint16(deltaO + i * 2, 0);
                    d4.setUint16(rangeO + i * 2, 2 * (segCount - i + ci));
                    for (let k = 0; k < n; k++) d4.setUint16(glyphO + (ci + k) * 2, chars[ci + k]);
                    ci += n;
                });
                d4.setUint16(endO + bmp.length * 2, 0xFFFF);
                d4.setUint16(startO + bmp.length * 2, 0xFFFF);
                d4.setUint16(deltaO + bmp.length * 2, 1);
                d4.setUint16(rangeO + bmp.length * 2, 0);
            }
            const pad4 = n => (4 - (n % 4)) % 4;
            const records = f4 ? [[0, 3, 0], [0, 4, 1], [3, 1, 0], [3, 10, 1]] : [[0, 4, 1], [3, 10, 1]];
            const dirLen = 4 + records.length * 8;
            const offF4 = dirLen, offF12 = dirLen + (f4 ? f4.length + pad4(f4.length) : 0);
            const out = new Uint8Array(offF12 + f12.length);
            const dv = new DataView(out.buffer);
            dv.setUint16(0, 0); dv.setUint16(2, records.length);
            records.forEach(([platform, enc, which], i) => {
                dv.setUint16(4 + i * 8, platform); dv.setUint16(6 + i * 8, enc); dv.setUint32(8 + i * 8, which ? offF12 : offF4);
            });
            if (f4) out.set(f4, offF4);
            out.set(f12, offF12);
            return out;
        }

        // palettes 可以是单板 [{r,g,b,a}]，也可以是多板 [[…],[…]]（字体自带多套配色时按原样保留）
        function patchColrCpalTable(ttfBuffer, colrEntries, palettes) {
            if (!colrEntries || !colrEntries.length) return ttfBuffer;
            const colr = buildColrV0Table(colrEntries);
            const lists = Array.isArray(palettes?.[0]) ? palettes : [palettes || []];
            const m = lists.length;
            // CPAL 只有一个 numPaletteEntries，各板必须等长：短的补黑
            const n = Math.max(1, ...lists.map(p => p.length));
            if (n * m > 65535) throw new Error('彩色调色板容量超过 TTF 上限');
            const colorOffset = 12 + m * 2;
            const cpal = new Uint8Array(colorOffset + n * m * 4);
            const pv = new DataView(cpal.buffer);
            pv.setUint16(0, 0); pv.setUint16(2, n); pv.setUint16(4, m); pv.setUint16(6, n * m);
            pv.setUint32(8, colorOffset);
            let q = colorOffset;
            for (let i = 0; i < m; i++) {
                pv.setUint16(12 + i * 2, i * n);   // 每板用自己那一段颜色记录
                for (let k = 0; k < n; k++) {
                    const c = lists[i][k] || { r: 0, g: 0, b: 0, a: 255 };
                    pv.setUint8(q, c.b); pv.setUint8(q + 1, c.g); pv.setUint8(q + 2, c.r); pv.setUint8(q + 3, c.a ?? 255); q += 4;
                }
            }
            return appendTables(ttfBuffer, [{ tag: 'COLR', data: colr }, { tag: 'CPAL', data: cpal }]);
        }

        // 读取现有 COLR v0 / CPAL。字体替换与互换必须迁移这些记录，不能只搬 glyf 后让彩图退成黑色。
        function parseColrCpalV0(buffer) {
            const colr = readTableBytes(buffer, 'COLR');
            if (!colr) return null;
            if (colr.length < 14) throw new Error('COLR 表太短，已阻断以免写坏彩色字体');
            const cv = new DataView(colr.buffer, colr.byteOffset, colr.byteLength), version = cv.getUint16(0);
            if (version !== 0) return { version, entries: new Map(), cpal: null };
            const count = cv.getUint16(2), baseOffset = cv.getUint32(4), layerOffset = cv.getUint32(8), layerCount = cv.getUint16(12);
            if (baseOffset + count * 6 > colr.length || layerOffset + layerCount * 4 > colr.length) throw new Error('COLR 表越界，已阻断以免写坏彩色字体');
            const entries = new Map();
            for (let i = 0; i < count; i++) {
                const o = baseOffset + i * 6, baseGlyphId = cv.getUint16(o), first = cv.getUint16(o + 2), n = cv.getUint16(o + 4);
                if (first + n > layerCount) throw new Error('COLR 图层索引越界，已阻断以免写坏彩色字体');
                const layerGlyphIds = [], paletteIndices = [];
                for (let j = 0; j < n; j++) { const q = layerOffset + (first + j) * 4; layerGlyphIds.push(cv.getUint16(q)); paletteIndices.push(cv.getUint16(q + 2)); }
                entries.set(baseGlyphId, { baseGlyphId, layerGlyphIds, paletteIndices });
            }
            const cpalBytes = readTableBytes(buffer, 'CPAL');
            if (!cpalBytes) return { version, entries, cpal: null };
            if (cpalBytes.length < 12) throw new Error('CPAL 表太短，已阻断以免写坏彩色字体');
            const pv = new DataView(cpalBytes.buffer, cpalBytes.byteOffset, cpalBytes.byteLength);
            const numPaletteEntries = pv.getUint16(2), numPalettes = pv.getUint16(4), numColorRecords = pv.getUint16(6), colorOffset = pv.getUint32(8);
            if (12 + numPalettes * 2 > cpalBytes.length) throw new Error('CPAL 调色板索引越界，已阻断以免写坏彩色字体');
            const palettes = [];
            for (let p = 0; p < numPalettes; p++) {
                const first = pv.getUint16(12 + p * 2), colors = [];
                if (first + numPaletteEntries > numColorRecords || colorOffset + (first + numPaletteEntries) * 4 > cpalBytes.length) throw new Error('CPAL 颜色记录越界，已阻断以免写坏彩色字体');
                for (let i = 0; i < numPaletteEntries; i++) { const o = colorOffset + (first + i) * 4; colors.push({ b: pv.getUint8(o), g: pv.getUint8(o + 1), r: pv.getUint8(o + 2), a: pv.getUint8(o + 3) }); }
                palettes.push(colors);
            }
            return { version, entries, cpal: { bytes: cpalBytes, numPalettes, palettes } };
        }

        // 预览用：字体自带彩色层（COLR v0 + CPAL）。按 buffer 缓存解析结果——预览每帧都会问，别重复解析。
        let v5PreviewColorCache = { buffer: null, data: null };
        function v5PreviewBufferFor(font) {
            if (!font) return null;
            if (font === state.font) return state.fontBuffer;
            const item = (state.replacementFonts || []).find(x => x.font === font);
            return item ? item.buffer : null;
        }
        function v5PreviewColorLayers(buffer) {
            if (!buffer) return null;
            if (v5PreviewColorCache.buffer === buffer) return v5PreviewColorCache.data;
            let data = null;
            try {
                const parsed = parseColrCpalV0(buffer);
                if (parsed && parsed.version === 0 && parsed.entries.size && parsed.cpal && parsed.cpal.palettes.length) {
                    data = { entries: parsed.entries, palette: parsed.cpal.palettes[0] };
                }
            } catch (_) { data = null; }   // 彩色表异常时退回普通轮廓，不让预览整块挂掉
            v5PreviewColorCache = { buffer, data };
            return data;
        }
        // 画了彩色字形返回 true；该 gid 没有彩层记录则返回 false，交给普通轮廓分支。
        // 颜色取自字体自带调色板；paletteIndex=0xFFFF 表示「跟随当前文字颜色」。粗细沿用与普通字形同一套描边/侵蚀模拟。
        function v5DrawColorGlyph(ctx, font, info, gid, x, y, size, strokeW, fallbackColor) {
            const entry = info.entries.get(gid);
            if (!entry || !entry.layerGlyphIds.length) return false;
            for (let i = 0; i < entry.layerGlyphIds.length; i++) {
                let path;
                try { path = font.glyphs.get(entry.layerGlyphIds[i]).getPath(x, y, size); } catch (_) { continue; }
                const pi = entry.paletteIndices[i], c = pi === 0xFFFF ? null : info.palette[pi];
                const color = c ? `rgba(${c.r},${c.g},${c.b},${(c.a ?? 255) / 255})` : (fallbackColor || '#000000');
                if (strokeW < 0) {
                    drawThinnedPath(ctx, path, color, strokeW);
                } else {
                    path.fill = color;
                    if (strokeW > 0) { path.stroke = color; path.strokeWidth = strokeW; }
                    path.draw(ctx);
                }
            }
            return true;
        }

        // 位图彩色表（CBDT/CBLC/EBDT/EBLC）按 gid 区间索引，追加字形后仍安全；sbix 例外，见 v5RawColorTables。
        const V5_COLOR_TABLE_TAGS = ['COLR', 'CPAL', 'CBDT', 'CBLC', 'EBDT', 'EBLC', 'sbix', 'SVG '];
        // grewGlyphs=true（本次写过新字形）时丢掉 sbix：它的 strike 里 glyphDataOffsets 是定长 numGlyphs+1 的数组，
        // 原字节回放后与新 maxp.numGlyphs 不一致，渲染器会越界读。
        function v5RawColorTables(buffer, skip = new Set(), grewGlyphs = false) {
            const skips = grewGlyphs ? new Set([...skip, 'sbix']) : skip;
            return V5_COLOR_TABLE_TAGS.filter(tag => !skips.has(tag)).map(tag => ({ tag, data: readTableBytes(buffer, tag) })).filter(t => t.data?.length);
        }
        function v5UnsupportedColorFormats(buffer, colr) {
            const out = [];
            if (colr && colr.version !== 0) out.push(`COLR v${colr.version}`);
            for (const tag of ['CBDT', 'CBLC', 'sbix', 'SVG ']) if (readTableBytes(buffer, tag)) out.push(tag.trim());
            return [...new Set(out)];
        }
        function v5PaletteIndex(palette, color) {
            const key = c => `${c.r},${c.g},${c.b},${c.a ?? 255}`;
            const wanted = key(color), hit = palette.findIndex(c => key(c) === wanted);
            if (hit >= 0) return hit;
            if (palette.length >= 0xFFFF) throw new Error('彩色字体的调色板颜色太多，无法安全合并');
            palette.push({ ...color, a: color.a ?? 255 });
            return palette.length - 1;
        }

        // ponytail: 按轮廓左法线偏移，直接改变笔画厚度；极端自交字形若出问题再换完整布尔偏移。
        function offsetContour(contour, distance) {
            if (!distance || contour.length < 3) return;
            const src = contour.map(p => ({ x: p.x, y: p.y }));
            for (let i = 0; i < src.length; i++) {
                const p = src[i], prev = src[(i + src.length - 1) % src.length], next = src[(i + 1) % src.length];
                const ax = p.x - prev.x, ay = p.y - prev.y, bx = next.x - p.x, by = next.y - p.y;
                const al = Math.hypot(ax, ay), bl = Math.hypot(bx, by);
                if (al < 0.5 || bl < 0.5) continue;
                const n1x = -ay / al, n1y = ax / al, n2x = -by / bl, n2y = bx / bl;
                let nx = n1x + n2x, ny = n1y + n2y, nl = Math.hypot(nx, ny);
                if (nl < 0.01) { nx = n1x; ny = n1y; }
                else { nx /= nl; ny /= nl; }
                const dot = nx * n1x + ny * n1y;
                let move = Math.abs(dot) > 0.25 ? distance / dot : distance;
                // ponytail: 尖角处的 mitre（1/dot）会放大到 4 倍，位图分色出来的轮廓只要多一个尖角，
                // 加粗后彩层就会比 base 轮廓多伸出一截（真机上就是颜色鼓出一块）。封顶 1×＝按法线走圆角，
                // 任何点位移都不超过 delta，base 与各彩层因此不会再互相错位；要更锐的角再回来放宽上限。
                const limit = Math.abs(distance);
                move = clamp(move, -limit, limit);
                contour[i].x = Math.round(p.x + nx * move);
                contour[i].y = Math.round(p.y + ny * move);
            }
        }

        // 轮廓包含判断使用 TrueType 的真实二次曲线，不能把离线控制点当作折线顶点（凹曲线的孔会误判为独立部分）。
        function contourContainsPoint(contour, point) {
            const y = point.y + 1e-7; // 避开刚好经过顶点的水平射线
            let inside = false;
            const crossLine = (a, b) => {
                if ((a.y > y) !== (b.y > y) && point.x < a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y)) inside = !inside;
            };
            const last = contour[contour.length - 1], first = contour[0];
            let cursor = first.onCurve ? first : last.onCurve ? last : { x: (last.x + first.x) / 2, y: (last.y + first.y) / 2 };
            for (let i = 0; i < contour.length; i++) {
                const cur = contour[i], next = contour[(i + 1) % contour.length];
                if (cur.onCurve && next.onCurve) {
                    crossLine(cur, next); cursor = next;
                } else if (!cur.onCurve) {
                    const end = next.onCurve ? next : { x: (cur.x + next.x) / 2, y: (cur.y + next.y) / 2 };
                    const a = cursor.y - 2 * cur.y + end.y, b = 2 * (cur.y - cursor.y), c = cursor.y - y;
                    const roots = Math.abs(a) < 1e-9 ? (b ? [-c / b] : []) : (() => {
                        const d = b * b - 4 * a * c;
                        return d > 0 ? [(-b - Math.sqrt(d)) / (2 * a), (-b + Math.sqrt(d)) / (2 * a)] : [];
                    })();
                    for (const t of roots) {
                        if (t < 0 || t >= 1) continue;
                        const m = 1 - t, x = m * m * cursor.x + 2 * m * t * cur.x + t * t * end.x;
                        if (point.x < x) inside = !inside;
                    }
                    cursor = end;
                }
            }
            return inside;
        }
        function applyGlyphGeometry(g, opts, upm) {
            if (!g || !g.contours || !g.contours.length) {
                if (g && opts.letterSpacing) {
                    const aw = g.advanceWidth || 0;
                    g.advanceWidth = Math.max(1, Math.round(aw + opts.letterSpacing * upm / 48));
                    return true;
                }
                return false;
            }
            let changed = false;
            if (opts.size && opts.size !== 48) {
                const s = opts.size / 48;
                for (const contour of g.contours) for (const p of contour) { p.x = Math.round(p.x * s); p.y = Math.round(p.y * s); }
                if (g.advanceWidth) g.advanceWidth = Math.max(1, Math.round(g.advanceWidth * s));
                changed = true;
            }
            if (opts.baseline) {
                const dy = Math.round(opts.baseline * upm / 48);
                for (const contour of g.contours) for (const p of contour) p.y = Math.round(p.y - dy);
                changed = true;
            }
            if (opts.weight && opts.weight !== 400) {
                const delta = Math.round((opts.weight - 400) * upm / 20000);
                if (delta !== 0) {
                    // ponytail: 每条独立轮廓分别判方向；被另一轮廓包住的孔反向。只取最大轮廓的方向会让混合绕向的符号一半加粗、一半变细。
                    const shapes = g.contours.map(contour => {
                        let area = 0;
                        for (let i = 0; i < contour.length; i++) {
                            const p = contour[i], q = contour[(i + 1) % contour.length];
                            area += p.x * q.y - q.x * p.y;
                        }
                        const { x1: minX, x2: maxX, y1: minY, y2: maxY } = contoursGeomBox([contour]);
                        return { contour, area, minX, maxX, minY, maxY };
                    });
                    for (const shape of shapes) {
                        if (!shape.area) continue;
                        const points = shape.contour;
                        const p = points.find(v => v.onCurve) || { x: (points[0].x + points.at(-1).x) / 2, y: (points[0].y + points.at(-1).y) / 2 };
                        let depth = 0;
                        for (const parent of shapes) {
                            if (parent === shape || parent.minX >= shape.minX || parent.maxX <= shape.maxX ||
                                parent.minY >= shape.minY || parent.maxY <= shape.maxY) continue;
                            if (contourContainsPoint(parent.contour, p)) depth++;
                        }
                        const direction = (shape.area > 0 ? -1 : 1) * (depth % 2 ? -1 : 1);
                        offsetContour(shape.contour, delta * direction);
                    }
                    changed = true;
                }
            }
            if (changed) {
                delete g.instructions; // 原 hint 程序引用旧坐标，几何变化后不可继续套用。
                let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
                for (const contour of g.contours) for (const p of contour) {
                    if (p.x < xMin) xMin = p.x;
                    if (p.x > xMax) xMax = p.x;
                    if (p.y < yMin) yMin = p.y;
                    if (p.y > yMax) yMax = p.y;
                }
                g.xMin = xMin; g.xMax = xMax; g.yMin = yMin; g.yMax = yMax;
                g.leftSideBearing = xMin;
            }
            if (opts.letterSpacing) {
                const aw = g.advanceWidth || (g.xMax - g.xMin);
                g.advanceWidth = Math.max(1, Math.round(aw + opts.letterSpacing * upm / 48));
                changed = true;
            }
            return changed;
        }

        // 原编号上的轮廓替换不会使 GSUB/GPOS/kern 指向失效；别删除原布局表。
        function cloneFontGlyph(glyph) {
            return { ...glyph, unicode: [...(glyph.unicode || [])],
                contours: glyph.contours?.map(c => c.map(p => ({ ...p }))),
                glyfs: glyph.glyfs?.map(c => ({ ...c, transform: c.transform ? { ...c.transform } : c.transform })) };
        }
        function assertSafeAliasSplit(source, codes) {
            if (['GSUB','GPOS','kern','kerx','morx','mort'].some(tag => readTableBytes(source, tag))) {
                throw new Error(`字符 ${codes.map(cp => String.fromCodePoint(cp)).join('、')} 共用同一字形且带排版规则，当前无法安全分别调整，请给它们使用相同设置`);
            }
        }
        function installFontGlyph(object, cp, replacement, source) {
            const index = object.glyf.findIndex(g => (g.unicode || []).includes(cp));
            const previous = object.glyf[index];
            replacement.unicode = [cp];
            if (previous && previous.unicode.length === 1) {
                // 若复合字仍引用旧轮廓，把它独立保存，原编号留给该字符的排版规则。
                const dependents = object.glyf.filter(g => g.glyfs?.some(c => c.glyphIndex === index));
                if (dependents.length) {
                    const preserved = cloneFontGlyph(previous); preserved.unicode = [];
                    const id = object.glyf.length; object.glyf.push(preserved);
                    for (const g of dependents) for (const component of g.glyfs) if (component.glyphIndex === index) component.glyphIndex = id;
                }
                object.glyf[index] = replacement;
                return index;
            }
            if (previous) {
                assertSafeAliasSplit(source, previous.unicode);
                previous.unicode = previous.unicode.filter(c => c !== cp);
            }
            const id = object.glyf.length; object.glyf.push(replacement); return id;
        }
        function preserveCmapVariations(buffer, source) {
            const src = readTableBytes(source, 'cmap'), dst = readTableBytes(buffer, 'cmap');
            if (!src || !dst) return buffer;
            const sv = new DataView(src.buffer, src.byteOffset, src.byteLength), dv = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);
            const extra = [];
            for (let i = 0; i < sv.getUint16(2); i++) {
                const pos = 4 + i * 8, off = sv.getUint32(pos + 4);
                if (off + 6 <= src.length && sv.getUint16(off) === 14) {
                    const length = sv.getUint32(off + 2);
                    if (off + length > src.length) throw new Error('源字体的 Unicode 变体表越界');
                    extra.push({ platform: sv.getUint16(pos), encoding: sv.getUint16(pos + 2), bytes: src.slice(off, off + length) });
                }
            }
            if (!extra.length) return buffer;
            const count = dv.getUint16(2), growth = extra.length * 8;
            const result = new Uint8Array(dst.length + growth + extra.reduce((n, e) => n + e.bytes.length, 0));
            result.set(dst.subarray(0, 4 + count * 8));
            result.set(dst.subarray(4 + count * 8), 4 + count * 8 + growth);
            const view = new DataView(result.buffer); view.setUint16(2, count + extra.length);
            for (let i = 0; i < count; i++) view.setUint32(4 + i * 8 + 4, dv.getUint32(4 + i * 8 + 4) + growth);
            let offset = dst.length + growth;
            extra.forEach((entry, i) => {
                const pos = 4 + (count + i) * 8;
                view.setUint16(pos, entry.platform); view.setUint16(pos + 2, entry.encoding); view.setUint32(pos + 4, offset);
                result.set(entry.bytes, offset); offset += entry.bytes.length;
            });
            return appendTables(buffer, [{ tag: 'cmap', data: result }]);
        }
        function validateGeneratedFont(buffer) {
            const dv = new DataView(buffer);
            if (buffer.byteLength < 12 || dv.getUint32(0) !== 0x00010000) throw new Error('导出结果不是标准 TTF');
            const count = dv.getUint16(4), tags = new Set();
            if (12 + count * 16 > buffer.byteLength) throw new Error('导出字体目录越界');
            for (let i = 0; i < count; i++) {
                const pos = 12 + i * 16, tag = String.fromCharCode(...new Uint8Array(buffer, pos, 4));
                const offset = dv.getUint32(pos + 8), size = dv.getUint32(pos + 12);
                if (tags.has(tag) || offset + size > buffer.byteLength || offset % 4) throw new Error(`导出字体的 ${tag} 表无效`);
                tags.add(tag);
            }
            for (const tag of ['head','maxp','hhea','hmtx','cmap','loca','glyf']) if (!tags.has(tag)) throw new Error(`导出字体缺少 ${tag} 表`);
            const maxp = readTableBytes(buffer, 'maxp'), head = readTableBytes(buffer, 'head'), loca = readTableBytes(buffer, 'loca'), glyf = readTableBytes(buffer, 'glyf');
            const glyphCount = new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).getUint16(4);
            const long = new DataView(head.buffer, head.byteOffset, head.byteLength).getInt16(50) === 1;
            const lv = new DataView(loca.buffer, loca.byteOffset, loca.byteLength), size = long ? 4 : 2;
            if (loca.length < (glyphCount + 1) * size) throw new Error('导出字体的字形索引数量无效');
            let previous = 0;
            for (let i = 0; i <= glyphCount; i++) {
                const offset = long ? lv.getUint32(i * 4) : lv.getUint16(i * 2) * 2;
                if (offset < previous || offset > glyf.length) throw new Error('导出字体字形数据越界');
                previous = offset;
            }
            const parsed = opentype.parse(buffer);
            if (Object.values(parsed.tables.cmap.glyphIndexMap).some(id => id >= glyphCount)) throw new Error('导出字体字符映射越界');
            parseColrCpalV0(buffer);
            return buffer;
        }
        function finalizeGeneratedFont(buffer, source) {
            const tables = [];
            for (const tag of ['name','GSUB','GDEF','GPOS','kern','kerx','BASE','JSTF','MATH','STAT','meta','morx','mort','feat','trak']) {
                const data = readTableBytes(source, tag); if (data) tables.push({ tag, data });
            }
            buffer = appendTables(buffer, tables);
            buffer = preserveCmapVariations(buffer, source);
            return validateGeneratedFont(buffer);
        }

        function loadCore() {
            if (window.FontEditorCore) return Promise.resolve(window.FontEditorCore);
            return new Promise((resolve, reject) => {
                const src = document.getElementById('fecSrc');
                const fail = () => reject(new Error('导出核心加载失败，请重新打开本页面'));
                if (!src) { fail(); return; }
                const s = document.createElement('script');
                s.textContent = src.textContent;
                s.onload = s.onerror = () => (window.FontEditorCore ? resolve(window.FontEditorCore) : fail());
                document.head.appendChild(s);
                if (window.FontEditorCore) resolve(window.FontEditorCore);
            });
        }

        function downloadBuffer(buffer, filename, mime) {
            const blob = new Blob([buffer], { type: mime });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1500);
        }


        // ===== P3：静态字体 → 真 VF（JS 造母版 + 离线 Pyodide/FontTools 编译） =====
        let v5VfCompilerPromise = null;
        const V5_VF_RUNTIME_PREFIX = 'https://pyodide.local/';

        function toggleExportFormat() {
            const mode = document.querySelector('input[name="exportFormat"]:checked')?.value || 'ttf';
            $('vfExportOptions').hidden = mode !== 'vf';
            $('exportTTFButton').textContent = '📦导出';
        }
        function v5VfExportRange() {
            const min = Number($('vfExportMin').value), max = Number($('vfExportMax').value);
            if (!Number.isInteger(min) || !Number.isInteger(max)) throw new Error('最细端值和最粗端值必须是整数');
            if (min < 100 || min > 400 || max < 400 || max > 2000 || min >= max) {
                throw new Error('端点范围必须满足：100 ≤ 最细 ≤ 400 ≤ 最粗 ≤ 2000，而且最细必须小于最粗');
            }
            return { min, max };
        }
        function v5VfExportNote(msg) {
            const el = $('vfExportProgress');
            if (el) el.textContent = msg || '';
            if (msg) logStatus(`⏳ ${msg}`, 'info');
        }
        function v5BytesEqual(a, b) {
            if (!a || !b || a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
            return true;
        }
        const V5_VF_GEOMETRY_TABLES = ['glyf', 'loca', 'hmtx', 'cmap', 'maxp', 'gvar', 'HVAR', 'fvar', 'avar', 'MVAR', 'CFF2'];
        function v5VfTableSnapshot(buffer) {
            const out = {};
            for (const tag of V5_VF_GEOMETRY_TABLES) {
                const t = readTableBytes(buffer, tag);
                if (t) out[tag] = t;
            }
            return out;
        }
        function v5VfOriginalGeometryUnchanged() {
            const snap = state.vfSource?.sourceTables;
            if (!snap) return false;
            for (const tag of V5_VF_GEOMETRY_TABLES) {
                const now = readTableBytes(state.fontBuffer, tag), was = snap[tag];
                if (!!now !== !!was || (now && !v5BytesEqual(now, was))) return false;
            }
            return true;
        }
        function v5VfCapacityReason() {
            const bytes = state.fontBuffer?.byteLength || 0;
            const mobile = /iPad|iPhone|iPod|Android/i.test(navigator.userAgent);
            if (mobile && bytes > 25 * 1024 * 1024) return '这个字体超过 25MB，手机／平板导出 VF 可能让页面崩溃。请改用电脑导出。';
            if (!mobile && bytes > 60 * 1024 * 1024) return '这个字体超过 60MB，浏览器内生成多份母版可能耗尽内存，已停止。';
            return '';
        }
        function v5LockEditorForVfExport() {
            // 同一份 state 会被导入、配置恢复、滑杆和修符共同改写；编译期间统一锁住，避免三份母版来自不同快照。
            const prior = Array.from(document.querySelectorAll('button,input,select,textarea')).map(el => [el, el.disabled]);
            for (const [el] of prior) el.disabled = true;
            return () => { for (const [el, disabled] of prior) el.disabled = disabled; };
        }
        async function v5InflatePayload(b64) {
            if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器太旧，缺少本地解压能力，暂时不能导出 VF');
            const bin = atob(b64), gz = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) gz[i] = bin.charCodeAt(i);
            const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
            return new Uint8Array(await new Response(stream).arrayBuffer());
        }
        async function readVfPayloadResources() {
            const manifestResponse = await fetch('./assets/vf-payload-manifest.json');
            if (!manifestResponse.ok) throw new Error('VF 引擎资源清单加载失败');
            const manifest = await manifestResponse.json();
            const rawChunks = await Promise.all(manifest.map(async item => {
                const response = await fetch('./assets/' + item.file);
                if (!response.ok) throw new Error('VF 引擎资源加载失败：' + item.file);
                return response.text();
            }));
            const payload = {};
            manifest.forEach((item, index) => { payload[item.key] = (payload[item.key] || '') + rawChunks[index]; });
            return payload;
        }
        async function loadVfCompiler() {
            if (v5VfCompilerPromise) return v5VfCompilerPromise;
            v5VfCompilerPromise = (async () => {
                v5VfExportNote('正在启动本地 VF 引擎（第一次约需几秒）…');
                const node = $('vfPyPayload');
                if (!node) throw new Error('VF 引擎载荷缺失');
                if (!node.textContent.trim()) node.textContent = JSON.stringify(await readVfPayloadResources());
                if (!node) throw new Error('VF 引擎载荷缺失，请重新打开页面');
                let payload;
                try { payload = JSON.parse(node.textContent); }
                catch (e) { throw new Error('内置的 VF 引擎载荷读不出来（文件可能没下载完整），请重新获取这个 HTML 再试'); }
                const blobs = {}, mime = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.zip': 'application/zip', '.json': 'application/json' };
                for (const [name, b64] of Object.entries(payload)) {
                    if (name.endsWith('.whl')) continue;   // wheel 直接写进 Pyodide FS，不额外造一份 Blob
                    const ext = name.slice(name.lastIndexOf('.'));
                    blobs[name] = URL.createObjectURL(new Blob([await v5InflatePayload(b64)], { type: mime[ext] || 'application/octet-stream' }));
                }
                const origFetch = window.fetch;   // 原生引用：结束时必须原样还回去（连对象身份一起，见 P3c）
                const realFetch = (input, init) => origFetch.call(window, input, init);
                window.fetch = (input, init) => {
                    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
                    const name = url.startsWith(V5_VF_RUNTIME_PREFIX) ? url.slice(V5_VF_RUNTIME_PREFIX.length).split('?')[0] : null;
                    return name && blobs[name] ? realFetch(blobs[name]) : realFetch(input, init);
                };
                try {
                    const mod = await import(blobs['pyodide.mjs']);
                    // Pyodide 对 asm.js 用 import()，不会经过 fetch 拦截；先加载一次，让它挂出 _createPyodideModule。
                    await import(blobs['pyodide.asm.js']);
                    const py = await mod.loadPyodide({
                        indexURL: V5_VF_RUNTIME_PREFIX,
                        stdLibURL: blobs['python_stdlib.zip'],
                        lockFileContents: await (await realFetch(blobs['pyodide-lock.json'])).json()
                    });
                    py.FS.writeFile('/fonttools.whl', await v5InflatePayload(payload['fonttools-4.56.0-py3-none-any.whl']));
                    await py.runPythonAsync("import sys\nsys.path.append('/fonttools.whl')\nimport fontTools");
                    node.textContent = '';   // 运行时已进内存，释放 DOM 里 8.7MB 的 base64 文本
                    for (const url of Object.values(blobs)) URL.revokeObjectURL(url);
                    return py;
                } finally {
                    window.fetch = origFetch;
                }
            })();
            try { return await v5VfCompilerPromise; }
            catch (e) { v5VfCompilerPromise = null; throw e; }
        }
        function v5VfMasterWeights(weight) {
            const repairWeights = new Map();
            const restore = [];
            for (const [ch, v] of Object.entries(state.specific)) {
                if (!v || typeof v !== 'object') continue;
                const had = Object.prototype.hasOwnProperty.call(v, 'weight'), base = Number.isFinite(Number(v.weight)) ? Number(v.weight) : 400;
                repairWeights.set(ch.codePointAt(0), base);
                restore.push([v, had, v.weight]);
                v.weight = clamp(weight + (base - 400), 100, 900);
            }
            return { repairWeights, restore };
        }
        async function v5BuildStaticMaster(weight) {
            const oldGlobal = state.global.weight;
            const { repairWeights, restore } = v5VfMasterWeights(weight);
            state.global.weight = weight;
            try {
                return await runExport({ capture: true, forceRewrite: true, quiet: true, vfMaster: true, repairWeights });
            } finally {
                state.global.weight = oldGlobal;
                for (const [v, had, old] of restore) { if (had) v.weight = old; else delete v.weight; }
            }
        }
        async function v5CompileVariableFont(masters, range) {
            const py = await loadVfCompiler();
            const paths = [];
            for (const m of masters) {
                const path = `/vf-master-${m.weight}.ttf`;
                py.FS.writeFile(path, new Uint8Array(m.buffer));
                paths.push(path);
            }
            const config = { min: range.min, max: range.max, masters: masters.map((m, i) => ({ weight: m.weight, path: paths[i] })) };
            py.globals.set('vf_config_json', JSON.stringify(config));
            v5VfExportNote('正在编译连续粗细轴…大字体可能需要几分钟，请不要关闭页面');
            try {
                await py.runPythonAsync(`
import json, re
from io import BytesIO
from fontTools.ttLib import TTFont
from fontTools.designspaceLib import DesignSpaceDocument, AxisDescriptor, SourceDescriptor, InstanceDescriptor
from fontTools import varLib
cfg = json.loads(vf_config_json)
ds = DesignSpaceDocument()
axis = AxisDescriptor(); axis.name = 'Weight'; axis.tag = 'wght'; axis.minimum = cfg['min']; axis.default = 400; axis.maximum = cfg['max']; axis.labelNames = {'en': 'Weight', 'zh-Hans': '粗细'}
ds.addAxis(axis)
def load_master(item):
    f = TTFont(item['path'], recalcBBoxes=False, recalcTimestamp=False)
    os2 = f['OS/2']
    for attr in ('sxHeight', 'sCapHeight'):
        if not hasattr(os2, attr): setattr(os2, attr, 0)
    return f
base_family = None
for item in cfg['masters']:
    w = int(item['weight']); f = load_master(item)
    if w == 400: base_family = f['name'].getBestFamilyName() or 'Variable Font'
    src = SourceDescriptor(); src.name = f'm{w}'; src.location = {'Weight': w}; src.font = f
    src.copyInfo = (w == 400); src.copyLib = (w == 400); src.copyFeatures = (w == 400)
    ds.addSource(src)
base_family = base_family or 'Variable Font'
vals = {cfg['min'], 400, cfg['max']}
vals.update(range(((cfg['min'] + 99) // 100) * 100, cfg['max'] + 1, 100))
ps_family = re.sub(r'[^A-Za-z0-9]', '', base_family) or 'VariableFont'
for w in sorted(vals):
    inst = InstanceDescriptor(); inst.familyName = base_family; inst.location = {'Weight': w}
    if w == 400: style, ps = 'Regular', 'Regular'
    elif w == cfg['min'] and w % 100: style, ps = f'最细 {w}', f'Min{w}'
    elif w == cfg['max'] and w % 100: style, ps = f'最粗 {w}', f'Max{w}'
    else: style, ps = f'字重 {w}', f'W{w}'
    inst.styleName = style; inst.postScriptFontName = f'{ps_family}-{ps}'
    ds.addInstance(inst)
vf, _, _ = varLib.build(ds, optimize=True)
name = vf['name']
for pid, eid, lid in ((3,1,0x409),(0,3,0)):
    name.setName(base_family, 16, pid, eid, lid)
    name.setName('Regular', 17, pid, eid, lid)
    name.setName(ps_family[:63], 25, pid, eid, lid)
out = BytesIO(); vf.save(out); open('/vf-output.ttf','wb').write(out.getvalue())
`);
                return py.FS.readFile('/vf-output.ttf').slice().buffer;
            } finally {
                for (const p of paths) { try { py.FS.unlink(p); } catch (_) {} }
                try { py.FS.unlink('/vf-output.ttf'); } catch (_) {}
                py.globals.delete('vf_config_json');
            }
        }
        async function exportVariableFont() {
            const btn = $('exportTTFButton');
            let unlock = () => {};
            try {
                const range = v5VfExportRange();
                const cap = v5VfCapacityReason();
                if (cap) throw new Error(cap);
                const tags = v5SfntTags(state.fontBuffer);
                if (tags.has('fvar')) {
                    if (!v5VfOriginalGeometryUnchanged() || state.replacementDirty || hasWritableAdjustments()) {
                        throw new Error('这份原生可变字体已经做过字形或度量修改；当前版本不能安全重算原有变化数据。请先固化成普通字体，再从固化结果生成新的 VF。只改字体内部名称时可以原样导出 VF。');
                    }
                    btn.disabled = true; btn.textContent = '⏳ 导出中...';
                    downloadBuffer(state.fontBuffer, `edited_${state.font.familyName || 'font'}.ttf`, 'font/ttf');
                    logStatus('✅ 原生可变字体未改字形，已保留原变化数据导出', 'success');
                    return;
                }
                if (state.fontType !== 'ttf') throw new Error('生成 VF 目前只接受 TTF 轮廓；请先按 TTF 导出，再重新导入生成 VF');
                if (!(await v5EnsureReplacementApplied())) return;
                const sourceBuffer = state.fontBuffer;
                unlock = v5LockEditorForVfExport();
                const weights = [...new Set([range.min, 400, range.max])].sort((a, b) => a - b);
                btn.disabled = true;
                const masters = [];
                for (let i = 0; i < weights.length; i++) {
                    if (state.fontBuffer !== sourceBuffer) throw new Error('导出期间字体已更换，旧任务已停止');
                    v5VfExportNote(`正在生成母版 ${i + 1} / ${weights.length}（粗细 ${weights[i]}）…`);
                    masters.push({ weight: weights[i], buffer: await v5BuildStaticMaster(weights[i]) });
                }
                if (state.fontBuffer !== sourceBuffer) throw new Error('导出期间字体已更换，旧任务已停止');
                const masterCount = masters.length;
                const output = await v5CompileVariableFont(masters, range);
                masters.length = 0;
                if (state.fontBuffer !== sourceBuffer) throw new Error('导出期间字体已更换，旧任务已停止');
                const outTags = v5SfntTags(output);
                if (!outTags.has('fvar') || !outTags.has('gvar') || !outTags.has('HVAR') || !outTags.has('STAT')) throw new Error('输出缺少必要的可变字体表');
                const sanity = v5VfAxisSanity(output);
                if (!sanity.ok) throw new Error('输出没有真实字形变化，已停止下载');
                const parsed = opentype.parse(output);
                if (!parsed || !(parsed.numGlyphs > 0)) throw new Error('输出无法重新解析');
                downloadBuffer(output, `edited_${state.font.familyName || 'font'}.ttf`, 'font/ttf');
                v5VfExportNote('');
                logStatus(`✅ VF 导出成功：粗细 ${range.min}～${range.max}，默认 400，${masterCount} 个母版`, 'success');
                alert('VF 导出成功。\n400 是原字体粗细；中间档位可连续拖动。\n请再到 Kindle／Reeden 真机检查你选的最细和最粗效果。');
            } catch (e) {
                v5VfExportNote('');
                logStatus(`❌ VF 导出失败：${e.message}`, 'error');
                alert(`导出 VF 失败：${e.message}`);
            } finally {
                unlock();
                btn.disabled = false; btn.textContent = '📦导出';
            }
        }

        // 导出入口：先校验，然后执行导出
        async function exportTTF() {
            if (!state.font || !state.fontBuffer) { alert('请先重新加载字体'); return; }
            if (!['ttf', 'otf'].includes(state.fontType)) { alert('目前仅支持从 TTF 或 OTF 字体导出 TTF'); return; }
            const exportMode = document.querySelector('input[name="exportFormat"]:checked')?.value || 'ttf';
            if (exportMode === 'vf') { await exportVariableFont(); return; }
            // V5.2·P2-3：TTF 导出时，可变字体必须先固化。VF 导出由上面的 P3 分流负责。
            if (v5SfntTags(state.fontBuffer).has('fvar')) {
                alert('这是可变字体：导出 TTF 前，请先在顶栏「🎚️ 可变字体」里选好一档，点「固化这一档并进入编辑」。');
                logStatus('⚠️ 已阻止 TTF 导出：可变字体还没固化', 'error');
                return;
            }
            // 写入前统一 singleCharacter 校验，无效目标阻断
            const invalidTargets = state.glyphs.filter(g => !singleCharacter(g.char));
            if (invalidTargets.length > 0) {
                for (const g of invalidTargets) showGlyphTargetError(g.id, true);
                alert('有修符未设置有效的单个字符目标，请先修正后再导出');
                return;
            }
            if (!(await v5EnsureReplacementApplied())) return;
            await runExport();
        }

        let ordinaryExportBusy = false;
        async function runExport(options = {}) {
            if (ordinaryExportBusy) { if (options.capture) throw new Error('已有导出任务正在处理'); return; }
            ordinaryExportBusy = true;
            const unlock = v5LockEditorForVfExport();
            const sourceBuffer = state.fontBuffer;
            try { return await runExportLocked(options, sourceBuffer); }
            finally { ordinaryExportBusy = false; unlock(); }
        }
        async function runExportLocked(options = {}, sourceBuffer) {
            const btn = document.getElementById('exportTTFButton');
            if (hasColorOnlyChanges()) logStatus('ℹ️ 正在写入颜色调整', 'info');

            // 无修符、无可写几何调整：源 TTF 直接下载原字节；OTF 转 TTF
            if (!hasWritableAdjustments() && !options.forceRewrite) {
                btn.disabled = true;
                btn.textContent = '⏳ 导出中...';
                try {
                    if (state.fontType === 'ttf') {
                        if (options.capture) return state.fontBuffer;
                        downloadBuffer(state.fontBuffer, `edited_${state.font.familyName || 'font'}.ttf`, 'font/ttf');
                        if (!options.quiet) logStatus('✅ 无改动，已直接导出原 TTF', 'success');
                    } else {
                        const core = await loadCore();
                        const editor = core.createFont(state.fontBuffer, { type: 'otf', hinting: true, kerning: true });
                        const buffer = finalizeGeneratedFont(editor.write({ type: 'ttf', hinting: true, kerning: true }), sourceBuffer);
                        if (options.capture) return buffer;
                        downloadBuffer(buffer, `edited_${state.font.familyName || 'font'}.ttf`, 'font/ttf');
                        if (!options.quiet) logStatus('✅ OTF 已转换为 TTF 导出', 'success');
                    }
                } catch (e) {
                    logStatus(`❌ 导出失败：${e.message}`, 'error');
                    if (options.capture) throw e;
                    alert(`导出TTF失败：${e.message}`);
                } finally {
                    if (!options.capture) btn.disabled = false;
                    btn.textContent = '📦导出';
                }
                return;
            }

            btn.disabled = true;
            logStatus('⏳ 开始导出TTF...', 'info');
            try {
                btn.textContent = '⏳ 加载导出核心...';
                const core = await loadCore();
                if (state.glyphs.length > 0 && typeof ImageTracer === 'undefined') throw new Error('矢量化组件未加载，请重新打开本页面');

                btn.textContent = '⏳ 读取字体中...';
                await new Promise(resolve => setTimeout(resolve, 0));
                let editor;
                try {
                    editor = core.createFont(state.fontBuffer, { type: state.fontType, hinting: true, kerning: true });
                } catch (_) {
                    throw new Error('字体读取失败，可能不是标准的 TTF 或 OTF 文件');
                }

                const fontObject = editor.get();
                const upm = fontObject.head?.unitsPerEm || 1000;
                const glyphIndexByCodePoint = new Map();
                fontObject.glyf.forEach((glyph, index) => {
                    const codes = Array.isArray(glyph.unicode) ? glyph.unicode : (glyph.unicode === undefined ? [] : [glyph.unicode]);
                    codes.forEach(code => glyphIndexByCodePoint.set(code, index));
                });

                // 源字体自带的彩色表必须迁回：fonteditor-core 的 write() 只回写它认识的标准表，
                // COLR/CPAL 一律丢弃，所以走写回分支的导出（含 VF 各母版）会把彩字整批退成黑色。
                const srcGlyphCount = fontObject.glyf.length;
                const artwork = ['sbix','SVG ','CBDT','CBLC','EBDT','EBLC'].filter(tag => readTableBytes(sourceBuffer, tag));
                if (artwork.length && (state.glyphs.length || specificHasWritable() || state.global.size !== 48 || state.global.weight !== 400 || state.global.baseline !== 0 || hasColorOnlyChanges())) throw new Error(`当前字体包含 ${artwork.join('／')} 图像字形，无法同步修整图像与轮廓，请先使用普通轮廓字体`);
                const srcColor = parseColrCpalV0(state.fontBuffer);
                if (srcColor && srcColor.version !== 0) throw new Error(`当前字体使用 COLR v${srcColor.version} 彩色格式，本工具导出时会丢掉彩色图层（彩字会变黑），已停止；若只需要单色轮廓，请先换掉这些字符再导出`);
                const presetColorEntries = srcColor?.version === 0 ? [...srcColor.entries.values()].map(e => ({ ...e, layerGlyphIds: [...e.layerGlyphIds], paletteIndices: [...e.paletteIndices] })) : [];
                if (presetColorEntries.length && !srcColor.cpal) throw new Error('当前字体带 COLR 彩色记录但缺少 CPAL 调色板，已停止，避免写出坏彩色表');
                const presetColorByBase = new Map(presetColorEntries.map(e => [e.baseGlyphId, e]));
                // 本次新写的彩色记录（修符彩图 / 颜色调整 / 彩色字符单独缩放）与源字体现有调色板一起在结尾合并落盘。
                // 调色板按源顺序 1:1 复制，**每一块都复制**（CPAL 允许多套配色，色号在各板间同槽位对齐）：
                // 源记录的 paletteIndex 因此继续有效，新颜色在每一板尾部同步追加，槽位不会错位。
                const colrEntries = [];
                const cpalPalettes = (srcColor?.cpal?.palettes?.length ? srcColor.cpal.palettes : [[]]).map(p => p.map(c => ({ ...c })));
                const cpalIndexMap = new Map();
                cpalPalettes[0].forEach((c, i) => { const key = `${c.r},${c.g},${c.b},${c.a ?? 255}`; if (!cpalIndexMap.has(key) && cpalPalettes.every(p => p[i] && p[i].r === c.r && p[i].g === c.g && p[i].b === c.b && (p[i].a ?? 255) === (c.a ?? 255))) cpalIndexMap.set(key, i); });
                // 登记一个新颜色并返回槽位号（各板同步追加，保证槽位对齐）
                function cpalAddColor(color) {
                    const key = `${color.r},${color.g},${color.b},${color.a ?? 255}`;
                    let pi = cpalIndexMap.get(key);
                    if (pi === undefined) { pi = cpalPalettes[0].length; cpalPalettes.forEach(p => p.push({ ...color })); cpalIndexMap.set(key, pi); }
                    return pi;
                }

                const glyphTargets = buildTopPriorityTargets(state.glyphs);
                const specByCp = specificByCodePoint();

                const gDefault = state.global;
                const excludeCodes = v5GlobalExcludeCodes();   // 全局「排除」：这些码点不套用全局调整
                const globalGeometry = (gDefault.size !== 48 || gDefault.letterSpacing !== 0 || gDefault.baseline !== 0 || gDefault.weight !== 400);
                const globalOpts = {
                    size: gDefault.size, letterSpacing: gDefault.letterSpacing,
                    baseline: gDefault.baseline, weight: gDefault.weight
                };
                // 先展开全部复合字形，再逐个处理：组件修改不会连带改变未选中的字符。
                const compounds = fontObject.glyf.map((g, i) => g.compound ? i : -1).filter(i => i >= 0);
                if (compounds.length) editor.getHelper().compound2simple(compounds);
                const colorLayerIds = new Set(presetColorEntries.flatMap(e => e.layerGlyphIds).filter(i => !presetColorByBase.has(i)));
                let adjustedCount = 0;
                const originalCount = fontObject.glyf.length;
                btn.textContent = '⏳ 应用字体调整...';
                await new Promise(resolve => setTimeout(resolve, 0));
                for (let index = 0; index < originalCount; index++) {
                    const glyph = fontObject.glyf[index];
                    const codes = Array.isArray(glyph.unicode) ? [...glyph.unicode] : [];
                    if (!codes.length) {
                        // GSUB 生成的连字也参与全局修整；彩色层由 base 负责，不能重复变换。
                        if (globalGeometry && !colorLayerIds.has(index) && applyGlyphGeometry(glyph, globalOpts, upm)) adjustedCount++;
                        const preset = presetColorByBase.get(index);
                        if (preset) {
                            const layerGlyphIds = preset.layerGlyphIds.map(lid => {
                                if (lid === index) return index;
                                const layer = cloneFontGlyph(fontObject.glyf[lid]); layer.unicode = [];
                                const id = fontObject.glyf.length; fontObject.glyf.push(layer);
                                applyGlyphGeometry(layer, globalOpts, upm); return id;
                            });
                            colrEntries.push({ baseGlyphId: index, layerGlyphIds, paletteIndices: [...preset.paletteIndices] });
                        }
                        continue;
                    }
                    const groups = new Map();
                    for (const cp of codes) {
                        const style = specByCp.has(cp) ? { ...GLOBAL_EXCLUDE_DEFAULTS, ...specByCp.get(cp) } : excludeCodes.has(cp) ? GLOBAL_EXCLUDE_DEFAULTS : gDefault;
                        const key = glyphTargets.has(cp) ? 'repair' : JSON.stringify(['size','letterSpacing','weight','baseline','color','fine','brightness','hue'].map(k => style[k]));
                        if (!groups.has(key)) groups.set(key, { codes: [], style, repair: key === 'repair' });
                        groups.get(key).codes.push(cp);
                    }
                    if (groups.size > 1) assertSafeAliasSplit(sourceBuffer, codes);
                    const original = cloneFontGlyph(glyph);
                    let first = true;
                    for (const group of groups.values()) {
                        const targetIndex = first ? index : fontObject.glyf.length;
                        const target = first ? glyph : cloneFontGlyph(original);
                        if (!first) fontObject.glyf.push(target);
                        first = false; target.unicode = group.codes;
                        group.codes.forEach(cp => glyphIndexByCodePoint.set(cp, targetIndex));
                        if (group.repair) continue;
                        const preset = presetColorByBase.get(index);
                        if (preset) {
                            // 图层可能被多个彩字共用，每个 base 拷贝自己的层，避免重复缩放。
                            const layerGlyphIds = preset.layerGlyphIds.map(lid => {
                                if (lid === index) return targetIndex;
                                const layer = cloneFontGlyph(fontObject.glyf[lid]); layer.unicode = [];
                                const id = fontObject.glyf.length; fontObject.glyf.push(layer);
                                applyGlyphGeometry(layer, group.style, upm); return id;
                            });
                            colrEntries.push({ baseGlyphId: targetIndex, layerGlyphIds, paletteIndices: [...preset.paletteIndices] });
                        }
                        if (applyGlyphGeometry(target, group.style, upm)) adjustedCount++;
                    }
                }
                if (gDefault.lineHeight !== ADJUSTMENT_DEFAULTS.lineHeight) {
                    const ascent = fontObject.hhea?.ascent ?? Math.round(upm * 0.8);
                    const descent = Math.abs(fontObject.hhea?.descent ?? Math.round(upm * 0.2));
                    const lineGap = Math.round(gDefault.lineHeight * upm - ascent - descent);
                    if (fontObject.hhea) fontObject.hhea.lineGap = lineGap;
                    if (fontObject['OS/2']) {
                        const os2 = fontObject['OS/2'];
                        os2.sTypoLineGap = Math.round(gDefault.lineHeight * upm - os2.sTypoAscender + os2.sTypoDescender);
                    }
                }
                if (adjustedCount > 0) logStatus(`✅ 已调整 ${adjustedCount} 个字形`, 'success');

                let replaced = 0, added = 0;
                const repairedGlyphIds = new Set();
                const repairFailures = [];
                for (const glyphData of state.glyphs) {
                    const char = singleCharacter(glyphData.char);
                    if (!char) continue;
                    const codePoint = char.codePointAt(0);
                    if (glyphTargets.get(codePoint) !== glyphData) { logStatus(`⏭️ 忽略重复目标 "${char}"（顶部项优先）`, 'info'); continue; }
                    const existingIndex = glyphIndexByCodePoint.get(codePoint);
                    const sourceGlyph = existingIndex === undefined ? null : fontObject.glyf[existingIndex];
                    try {
                        btn.textContent = `⏳ 正在处理 ${char}`;
                        logStatus(`⏳ 正在矢量化 "${char}" ...`, 'info');
                        const spec = specByCp.get(codePoint);
                        // 指定调整对普通字形和修符使用同一份值；修符自身参数只是未指定时的回退。
                        const adjustedGlyphData = spec ? { ...glyphData,
                            size: spec.size ?? glyphData.size,
                            letterSpacing: spec.letterSpacing ?? glyphData.letterSpacing,
                            yOffset: spec.baseline ?? glyphData.yOffset,
                            color: spec.color ?? glyphData.color,
                            fine: spec.fine ?? glyphData.fine,
                            brightness: spec.brightness ?? glyphData.brightness,
                            hue: spec.hue ?? glyphData.hue } : glyphData;
                        const vectorGlyph = await imageToGlyph(adjustedGlyphData.imgData, char, 48);
                        const newGlyph = makeExportGlyph(core, vectorGlyph, adjustedGlyphData, codePoint, sourceGlyph, fontObject);
                        // VF 母版里，图片／修符字形固定在 400 档外观；否则不同图像轮廓无法保证点结构可插值。
                        const inheritedWeight = options.vfMaster ? (options.repairWeights?.get(codePoint) ?? 400) : (spec?.weight ?? (excludeCodes.has(codePoint) ? 400 : gDefault.weight));
                        applyGlyphGeometry(newGlyph, { size: 48, letterSpacing: 0, baseline: 0, weight: inheritedWeight }, upm);
                        sourceGlyph ? replaced++ : added++;
                        const newGlyphId = installFontGlyph(fontObject, codePoint, newGlyph, sourceBuffer);
                        glyphIndexByCodePoint.set(codePoint, newGlyphId);
                        repairedGlyphIds.add(newGlyphId);
                        // 只有显式勾选“导出为彩图”的修符才写 COLR/CPAL（固定原色）；
                        // 未勾选的就是普通字形轮廓，阅读软件按当前字体颜色渲染它（跟随主题/夜览换色）。
                        // 历史教训：给纯黑修符写 COLR 记录都不行——0xFFFF 前景色索引在目标阅读软件整批不可见，
                        // CPAL 固定黑能显示但永不跟字体颜色变。
                        if (adjustedGlyphData.exportAsColor) {
                            const colr = await imageToColrLayers(adjustedGlyphData.imgData, 48);
                            if (!colr) throw new Error('勾选了“导出为彩图”，但没有识别到可用颜色图层');
                            const layerGlyphIds = [];
                            const paletteIndices = [];
                            for (const layer of colr.layers) {
                                const color = colr.palette[layer.paletteIndex];
                                const pi = cpalAddColor(color);
                                const g = layerPathToGlyf(core, layer.path, adjustedGlyphData, sourceGlyph, fontObject);
                                if (!g) continue;
                                applyGlyphGeometry(g, { size: 48, letterSpacing: 0, baseline: 0, weight: inheritedWeight }, upm);
                                const lid = fontObject.glyf.length;
                                g.name = (codePoint <= 0xFFFF ? 'uni' : 'u') + codePoint.toString(16).toUpperCase().padStart(4, '0') + '.c' + lid;
                                g.unicode = [];
                                fontObject.glyf.push(g);
                                layerGlyphIds.push(lid);
                                paletteIndices.push(pi);
                            }
                            if (!layerGlyphIds.length) throw new Error('勾选了“导出为彩图”，但彩色轮廓生成失败');
                            colrEntries.push({ baseGlyphId: newGlyphId, layerGlyphIds, paletteIndices });
                        }
                        logStatus(`✅ 已${sourceGlyph ? '替换' : '新增'} "${char}"`, 'success');
                    } catch (e) {
                        logStatus(`❌ 处理 "${char}" 失败：${e.message}`, 'error');
                        repairFailures.push(char);
                    }
                }
                if (repairFailures.length) throw new Error(`有 ${repairFailures.length} 个修符处理失败，已停止导出：${repairFailures.join('、')}`);

                // 颜色调整写入（全局/指定）：通过 COLR/CPAL 落盘，不复原为 #000000
                {
                    const colorCpIndex = new Map();
                    fontObject.glyf.forEach((glyph, index) => {
                        const codes = Array.isArray(glyph.unicode) ? glyph.unicode : (glyph.unicode === undefined ? [] : [glyph.unicode]);
                        codes.forEach(code => colorCpIndex.set(code, index));
                    });
                    const gColorHex = String(state.global.color || '').toLowerCase();
                    const gCol = hexToRgb(gColorHex);
                    const colorPlan = [];
                    const coloredIdx = new Set();
                    for (const [ch, v] of Object.entries(state.specific)) {
                        if (!v || typeof v !== 'object') continue;
                        if (!v.color && v.fine === undefined && v.brightness === undefined && v.hue === undefined) continue;
                        const c = hexToRgb(v.color || '#000000');
                        if (!c) continue;
                        const cp = ch.codePointAt(0);
                        // 彩图修符保留原色；普通修符/符号允许“指定颜色”生成固定色层。
                        if (glyphTargets.get(cp)?.exportAsColor) continue;
                        const idx = colorCpIndex.get(cp);
                        if (idx === undefined) continue;
                        const effective = applyColorStyle(c, v.hue ?? 0, v.brightness ?? 100, v.fine ?? 50);
                        coloredIdx.add(idx);
                        if (!colrEntries.some(e => e.baseGlyphId === idx) && (effective.r || effective.g || effective.b)) colorPlan.push({ index: idx, color: effective });
                    }
                    if (gCol && (gColorHex !== '#000000' || hasColorOnlyChanges())) {
                        const gStyle = applyColorStyle(gCol, state.global.hue ?? 0, state.global.brightness ?? 100, state.global.fine ?? 50);
                        fontObject.glyf.forEach((glyph, index) => {
                            const codes = Array.isArray(glyph.unicode) ? glyph.unicode : (glyph.unicode === undefined ? [] : [glyph.unicode]);
                            if (!codes.length) return;
                            if (codes.some(cp => glyphTargets.has(cp))) return;
                            if (codes.some(cp => excludeCodes.has(cp))) return;   // 「排除」的字不上全局颜色
                            if (coloredIdx.has(index)) return;
                            if (!colrEntries.some(e => e.baseGlyphId === index) && (gStyle.r || gStyle.g || gStyle.b)) colorPlan.push({ index, color: gStyle });
                            coloredIdx.add(index);
                        });
                    }
                    if (colorPlan.length) {
                        const compoundIdx = colorPlan.map(p => p.index).filter(i => fontObject.glyf[i] && fontObject.glyf[i].compound);
                        if (compoundIdx.length) editor.getHelper().compound2simple(compoundIdx);
                        for (const p of colorPlan) {
                            const pi = cpalAddColor(p.color);
                            colrEntries.push({ baseGlyphId: p.index, layerGlyphIds: [p.index], paletteIndices: [pi] });
                        }
                    }
                }

                for (const entry of colrEntries) {
                    if (entry.layerGlyphIds.length === 1 && entry.layerGlyphIds[0] === entry.baseGlyphId) continue;
                    const cp = fontObject.glyf[entry.baseGlyphId]?.unicode?.[0];
                    if (cp !== undefined && glyphTargets.has(cp)) continue;
                    const style = specByCp.get(cp) || (excludeCodes.has(cp) ? GLOBAL_EXCLUDE_DEFAULTS : state.global);
                    if ((style.hue ?? 0) === 0 && (style.brightness ?? 100) === 100 && (style.fine ?? 50) === 50) continue;
                    entry.paletteIndices = entry.paletteIndices.map(pi => {
                        const slot = cpalPalettes[0].length;
                        for (const palette of cpalPalettes) palette.push(applyColorStyle(pi === 0xFFFF ? hexToRgb(style.color || '#000000') : palette[pi], style.hue ?? 0, style.brightness ?? 100, style.fine ?? 50));
                        return slot;
                    });
                }
                if (options.vfMaster) {
                    // TTF 单档导出有意保持原字宽；VF 需要各母版的 advance 跟着笔画粗细同步，
                    // 否则只有轮廓变、字距完全不变，HVAR 会成为空变化。图片修符继续固定在 400 档。
                    for (const glyph of fontObject.glyf) {
                        const codes = Array.isArray(glyph?.unicode) ? glyph.unicode : (glyph?.unicode === undefined ? [] : [glyph.unicode]);
                        if (!codes.length || !glyph?.contours?.length) continue;
                        const cp = codes[0], spec = specByCp.get(cp);
                        // 「排除」的字宽也不跟着粗细变；但共用字形（多个码点同一个 glyf）不能只看 codes[0]，
                        // 与上面几何计划同一口径：只要还有码点既没走「指定」也没被「排除」，这个字形的字宽就跟着粗细走。
                        if (!spec && !codes.some(c => !specByCp.has(c) && !excludeCodes.has(c))) continue;
                        const weight = glyphTargets.has(cp) ? (options.repairWeights?.get(cp) ?? 400) : (spec?.weight ?? gDefault.weight);
                        const delta = (weight - 400) * upm / 20000;
                        glyph.advanceWidth = Math.max(0, Math.round((glyph.advanceWidth || 0) + 2 * delta));
                    }
                }

                btn.textContent = '⏳ 生成字体中...';
                logStatus('⏳ 正在生成TTF文件...', 'info');
                await new Promise(resolve => setTimeout(resolve, 0));
                let buffer;
                try {
                    if (fontObject.glyf.length > 65535) throw new Error('字形数量超过 TTF 上限');
                    if (options.vfMaster) for (const glyph of fontObject.glyf) delete glyph.instructions;
                    buffer = editor.write({ type: 'ttf', hinting: true, kerning: true });
                    buffer = appendTables(buffer, [{ tag: 'cmap', data: buildCmapTable(fontObject.glyf) }]);
                } catch (_) {
                    throw new Error('字体生成失败，当前字体结构可能不兼容');
                }
                const glyphGrew = fontObject.glyf.length > srcGlyphCount;
                // 源字体自带记录 + 本次新写记录合并：同一 base 以本次新写为准（颜色调整会重写该 base 的那条记录）；
                // 已经被摘掉最后一个码点的旧 base 不再有字符指向它，顺手清掉。重复 baseGlyphId 是非法 COLR 表，必须去重。
                const mergedColorEntries = new Map(presetColorEntries.filter(e => !repairedGlyphIds.has(e.baseGlyphId)).map(e => [e.baseGlyphId, e]));
                for (const entry of colrEntries) mergedColorEntries.set(entry.baseGlyphId, entry);
                if (glyphGrew && readTableBytes(state.fontBuffer, 'sbix')) logStatus('ℹ️ 当前字体带 sbix 位图彩色，本次导出生成了新字形，位图彩色表无法随之保留（已跳过，避免渲染越界）', 'info');
                const rawColorTables = v5RawColorTables(state.fontBuffer, new Set(['COLR', 'CPAL']), glyphGrew);
                if (mergedColorEntries.size) {
                    if (rawColorTables.length) buffer = appendTables(buffer, rawColorTables);
                    buffer = patchColrCpalTable(buffer, [...mergedColorEntries.values()], cpalPalettes);
                } else if (rawColorTables.length) {
                    // 只有位图/矢量彩表（没有 COLR）的字体：原字节放回，别让 write() 把彩字整批丢掉
                    buffer = appendTables(buffer, rawColorTables);
                }
                buffer = finalizeGeneratedFont(buffer, sourceBuffer);
                if (state.fontBuffer !== sourceBuffer) throw new Error('字体已更换，旧导出任务已停止');
                if (options.capture) return buffer;
                downloadBuffer(buffer, `edited_${state.font.familyName || 'font'}.ttf`, 'font/ttf');
                if (!options.quiet) logStatus(`✅ TTF导出成功！替换 ${replaced} 个，新增 ${added} 个，调整 ${adjustedCount} 个${colrEntries.length ? `，彩色分层 ${colrEntries.length} 个` : ''}`, 'success');
            } catch (e) {
                logStatus(`❌ 导出失败：${e.message}`, 'error');
                if (options.capture) throw e;
                alert(`导出TTF失败：${e.message}`);
            } finally {
                if (!options.capture) btn.disabled = false;
                btn.textContent = '📦导出';
            }
        }
        // ===== 其他导出功能 =====
        function arrayBufferToBase64(buffer) {
            const bytes = new Uint8Array(buffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return btoa(binary);
        }

        function base64ToArrayBuffer(value) {
            const binary = atob(value);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return bytes.buffer;
        }

        function exportConfig() {
            const data = {
                font: state.fontBuffer ? {
                    name: state.fontName,
                    type: state.fontType,
                    data: arrayBufferToBase64(state.fontBuffer)
                } : null,
                global: state.global,
                specific: state.specific,
                glyphs: state.glyphs.map(g => {
                    const o = {
                        char: g.char, imgData: g.imgData, width: g.width, height: g.height,
                        size: g.size, letterSpacing: g.letterSpacing, xOffset: g.xOffset, yOffset: g.yOffset,
                        color: g.color, fine: g.fine, brightness: g.brightness, hue: g.hue,
                        isSymbol: g.isSymbol || false, exportAsColor: g.exportAsColor || false
                    };
                    if (g.layers) o.layers = g.layers;
                    return o;
                }),
                fontReplacement: serializeFontReplacementConfig(),
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'font-editor-config.json';
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            logStatus(`✅ 配置导出成功${state.fontBuffer ? '（已包含当前字体）' : ''}`, 'success');
        }

        function exportPreviewPNG() {
            if (previewFrame) { cancelAnimationFrame(previewFrame); previewFrame = 0; }
            renderAllNow();
            const canvas = previewMod;
            const link = document.createElement('a');
            link.download = 'modified_preview.png';
            link.href = canvas.toDataURL('image/png');
            link.click();
            logStatus('🖼️ 预览截图导出成功', 'success');
        }

        function importConfig() { $('configFileInput').click(); }

        function normalizeNumber(v, fallback) {
            const n = Number(v);
            return Number.isFinite(n) ? n : fallback;
        }

        function normalizeControlNumber(key, value, fallback, glyph = false) {
            const range = { size: [glyph ? 8 : 12,120], letterSpacing: [-10,30], weight: [100,2000], lineHeight: [.8,2.5], baseline: [-30,30], fine: [0,100], brightness: [0,200], hue: [0,360] }[key];
            const n = Number(value);
            if (!Number.isFinite(n) || (range && (n < range[0] || n > range[1]))) throw new Error(`配置中的 ${key} 超出允许范围`);
            return n;
        }

        function normalizeGlyphConfig(g) {
            if (!g || typeof g !== 'object' || Array.isArray(g)) throw new Error('修符条目格式错误');
            if (typeof g.imgData !== 'string' || !g.imgData) throw new Error('修符缺少图片数据');
            const glyph = {
                id: 0,
                char: typeof g.char === 'string' ? g.char : '',
                imgData: g.imgData,
                width: normalizeNumber(g.width, 48),
                height: normalizeNumber(g.height, 48),
                size: normalizeNumber(g.size, 48),
                letterSpacing: normalizeNumber(g.letterSpacing, 0),
                xOffset: normalizeNumber(g.xOffset, 0),
                yOffset: normalizeNumber(g.yOffset, 0),
                color: typeof g.color === 'string' ? g.color : '#000000',
                fine: normalizeNumber(g.fine, 50),
                brightness: normalizeNumber(g.brightness, 100),
                hue: normalizeNumber(g.hue, 0),
                isSymbol: Boolean(g.isSymbol),
                exportAsColor: Boolean(g.exportAsColor)
            };
            for (const key of ['size','letterSpacing','fine','brightness','hue']) glyph[key] = normalizeControlNumber(key, glyph[key], CTRL_DEFAULTS[key], true);
            if (glyph.width <= 0 || glyph.height <= 0 || glyph.width > 16384 || glyph.height > 16384 || Math.abs(glyph.xOffset) > 4096 || Math.abs(glyph.yOffset) > 4096) throw new Error('修符尺寸或偏移超出允许范围');
            glyph.char = singleCharacter(glyph.char) || '';
            if (g.layers && typeof g.layers === 'object' && !Array.isArray(g.layers)) {
                glyph.layers = {
                    sourceChar: typeof g.layers.sourceChar === 'string' ? g.layers.sourceChar : null,
                    originalData: typeof g.layers.originalData === 'string' ? g.layers.originalData : null,
                    repairData: typeof g.layers.repairData === 'string' ? g.layers.repairData : null,
                    extraData: typeof g.layers.extraData === 'string' ? g.layers.extraData : null,
                    originalTransform: normalizeLayerTransform(g.layers.originalTransform),
                    repairTransform: normalizeLayerTransform(g.layers.repairTransform),
                    extraTransform: normalizeLayerTransform(g.layers.extraTransform)
                };
            }
            return glyph;
        }

        function normalizeConfig(parsed) {
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置文件格式错误：顶层必须是对象');
            let embeddedFont = null;
            if (parsed.font !== undefined && parsed.font !== null) {
                if (!parsed.font || typeof parsed.font !== 'object' || Array.isArray(parsed.font)) throw new Error('内嵌字体格式错误');
                if (typeof parsed.font.data !== 'string' || !parsed.font.data) throw new Error('内嵌字体缺少数据');
                let buffer;
                try { buffer = base64ToArrayBuffer(parsed.font.data); }
                catch (_) { throw new Error('内嵌字体数据不是有效的 Base64'); }
                if (buffer.byteLength < 12) throw new Error('内嵌字体数据无效');
                let font;
                try { font = opentype.parse(buffer); }
                catch (_) { throw new Error('内嵌字体无法解析'); }
                const type = new DataView(buffer).getUint32(0) === 0x4F54544F ? 'otf' : 'ttf';
                const name = typeof parsed.font.name === 'string' && parsed.font.name ? parsed.font.name : `embedded-font.${type}`;
                embeddedFont = { font, buffer, type, name };
            }
            const global = { ...GLOBAL_EXCLUDE_DEFAULTS, exclude: '' };
            if (parsed.global !== undefined) {
                if (!parsed.global || typeof parsed.global !== 'object' || Array.isArray(parsed.global)) throw new Error('全局设置格式错误');
                for (const k of ['size', 'letterSpacing', 'weight', 'lineHeight', 'baseline', 'fine', 'brightness', 'hue']) {
                    if (parsed.global[k] !== undefined) global[k] = normalizeControlNumber(k, parsed.global[k], global[k]);
                }
                if (typeof parsed.global.color === 'string') global.color = parsed.global.color;
                if (parsed.global.exclude !== undefined) {
                    if (typeof parsed.global.exclude !== 'string') throw new Error('全局排除设置格式错误');
                    global.exclude = parsed.global.exclude.slice(0, 500);
                }
            }
            const specific = {};
            if (parsed.specific !== undefined) {
                if (!parsed.specific || typeof parsed.specific !== 'object' || Array.isArray(parsed.specific)) throw new Error('指定字符设置格式错误');
                for (const [ch, v] of Object.entries(parsed.specific)) {
                    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('指定字符设置格式错误');
                    const cp = singleCharacter(ch);
                    if (!cp) continue;
                    const entry = { ...GLOBAL_EXCLUDE_DEFAULTS };
                    for (const k of ['size', 'letterSpacing', 'weight', 'baseline', 'fine', 'brightness', 'hue']) {
                        if (v[k] !== undefined) entry[k] = normalizeControlNumber(k, v[k], CTRL_DEFAULTS[k]);
                    }
                    if (typeof v.color === 'string') entry.color = v.color;
                    specific[cp] = entry;
                }
            }
            const glyphs = [];
            if (parsed.glyphs !== undefined) {
                if (!Array.isArray(parsed.glyphs)) throw new Error('修符列表格式错误');
                for (const g of parsed.glyphs) glyphs.push(normalizeGlyphConfig(g));
            }
            return { global, specific, glyphs, font: embeddedFont, fontReplacement: normalizeFontReplacementConfig(parsed.fontReplacement) };
        }

        function syncGlobalControls() {
            const exInput = $('globalExcludeChars'), exToggle = $('globalExcludeToggle');
            if (exInput) exInput.value = String(state.global.exclude || '');
            if (exToggle) exToggle.checked = !!String(state.global.exclude || '').length;
            v5RenderGlobalExcludeUI();
            for (const key of Object.keys(state.global)) {
                const slider = $(`global${key.charAt(0).toUpperCase() + key.slice(1)}`);
                if (slider) {
                    slider.value = state.global[key];
                    const num = $(slider.id + 'Num');
                    if (num) num.value = state.global[key];
                    const val = $(slider.id + 'Val');
                    if (val) val.textContent = ctrlValText(key, state.global[key]);
                }
            }
            if (state.global.color) {
                const picker = $('globalColor');
                if (picker) {
                    picker.value = state.global.color;
                    const rgb = hexToRgb(state.global.color);
                    if (rgb) {
                        $('globalColorR').value = rgb.r;
                        $('globalColorG').value = rgb.g;
                        $('globalColorB').value = rgb.b;
                        $('globalColorHex').value = state.global.color;
                    }
                }
            }
        }

        function decodeImageDataURL(dataURL) {
            return new Promise((resolve, reject) => {
                if (!dataURL) return resolve(false);
                const img = new Image();
                img.onload = () => resolve(true);
                img.onerror = () => reject(new Error('配置中的图片数据无法解码'));
                img.src = dataURL;
            });
        }

        function importConfigFile(event) {
            const file = event.target.files[0];
            if (!file) return;
            const ticket = ++fontImportTicket;
            if (file.size > 100 * 1024 * 1024) { event.target.value = ''; alert('配置超过 100MB，请减少内嵌图片后重试'); return; }
            const reader = new FileReader();
            reader.onload = async function(ev) {
                try {
                    const parsed = JSON.parse(ev.target.result);
                    const candidate = normalizeConfig(parsed); // 全部校验通过才提交，失败不覆盖现有状态
                    // 异步解码校验所有图片字段，任何失效图片都不降级提交
                    for (const g of candidate.glyphs) {
                        await decodeImageDataURL(g.imgData);
                        if (g.layers) {
                            await decodeImageDataURL(g.layers.originalData);
                            await decodeImageDataURL(g.layers.repairData);
                            await decodeImageDataURL(g.layers.extraData);
                        }
                    }
                    if (ticket !== fontImportTicket) return;
                    closeOriginEdit();
                    if (candidate.font) {
                        state.font = candidate.font.font;
                        state.fontBuffer = candidate.font.buffer;
                        state.fontType = candidate.font.type;
                        state.fontName = candidate.font.name;
                        $('fontStatus').textContent = `✅ ${state.fontName} (${state.font.familyName || '未知'})`;
                        v5ResetMainSwapUndo(uiText('已从配置恢复字体'));
                        v5VfAfterLoad(state.fontBuffer, false);   // 恢复出来的若仍是可变字体：亮出入口但不自动弹面板（配置恢复流程还在跑）
                    }
                    state.global = candidate.global;
                    state.specific = candidate.specific;
                    state.glyphs = candidate.glyphs.map(g => { g.id = ++state._glyphId; return g; });
                    await restoreFontReplacementConfig(candidate.fontReplacement);
                    syncGlobalControls();
                    renderGlyphList();
                    renderAll();
                    logStatus(`✅ 配置导入成功${candidate.font ? '（已恢复内嵌字体）' : ''}`, 'success');
                    alert(`✅ 配置导入成功${candidate.font ? '，字体也已恢复！' : '！'}`);
                } catch (e) {
                    logStatus(`❌ 导入失败: ${e.message}`, 'error');
                    alert('❌ 配置解析失败: ' + e.message);
                }
            };
            reader.readAsText(file);
            event.target.value = '';
        }

        // ===== 最小自检 =====
        function runSelfTest() {
            const results = [];
            const check = (name, cond) => results.push({ name, pass: !!cond });

            check('singleCharacter 单码点', singleCharacter('a') === 'a');
            check('singleCharacter 空格', singleCharacter(' ') === ' ');
            check('singleCharacter 空串为 null', singleCharacter('') === null);
            check('singleCharacter 多码点为 null', singleCharacter('ab') === null);
            check('singleCharacter 非BMP', singleCharacter('𠮷') === '𠮷');
            check('属性转义', escapeAttribute('"<>&') === '&quot;&lt;&gt;&amp;');

            const arr = [1, 2, 3];
            moveArrayItem(arr, 0, 2);
            check('moveArrayItem 移动后顺序', JSON.stringify(arr) === JSON.stringify([2, 3, 1]));
            check('moveArrayItem 越界返回 false', moveArrayItem([1, 2], 5, 0) === false);
            check('moveArrayItem 相同位置返回 false', moveArrayItem([1, 2], 0, 0) === false);

            const g0 = gestureGeometry([{ x: 0, y: 0 }, { x: 2, y: 0 }]);
            check('gestureGeometry 中心', Math.abs(g0.centerX - 1) < 1e-9 && Math.abs(g0.centerY) < 1e-9);
            check('gestureGeometry 距离', Math.abs(g0.distance - 2) < 1e-9);
            check('gestureGeometry 角度', Math.abs(g0.angle) < 1e-9);
            const g90 = gestureGeometry([{ x: 0, y: 0 }, { x: 0, y: 2 }]);
            check('gestureGeometry 90°', Math.abs(g90.angle - 90) < 1e-9);

            const view = { panX: 12, panY: -7, zoom: 1.6, rotate: 33 };
            const centerX = 300, centerY = 200;
            const pt = { x: 77, y: 130 };
            const back = transformPoint(inverseTransformPoint(pt, view, centerX, centerY), view, centerX, centerY);
            check('逆变换往返', Math.abs(back.x - pt.x) < 1e-6 && Math.abs(back.y - pt.y) < 1e-6);

            const tops = buildTopPriorityTargets([
                { id: 1, char: '“' }, { id: 2, char: '“' }, { id: 3, char: '𠮷' }
            ]);
            check('顶部优先去重', tops.size === 2 && tops.get('“'.codePointAt(0)).id === 1 && tops.get('𠮷'.codePointAt(0)).id === 3);
            check('V5 批量字符去重', JSON.stringify(v5Characters('abca')) === JSON.stringify(['a','b','c']));
            check('V5 双向互换无冲突', v5SwapConflictGroups(new Map([['a', 'b'], ['b', 'a']])).length === 0);
            check('V5 “我爱你→爱你吗”这类连带相同不再拦', v5SwapConflictGroups(new Map([['我', '爱'], ['爱', '你'], ['你', '吗']])).length === 0);
            check('V5 两个字符指向同一图样才拦', v5SwapConflictGroups(new Map([['a', 'c'], ['b', 'c']])).length === 1);
            check('V5 递增字母', v5Letters(1) === 'A' && v5Letters(27) === 'AA');

            const passed = results.filter(r => r.pass).length;
            return { passed, total: results.length, results };
        }

        function maybeRunSelfTest() {
            const isSelfTest = /[?&]self-test=1/.test(location.search) || /#self-test/.test(location.hash);
            if (!isSelfTest) return;
            const res = runSelfTest();
            const detail = res.results.map(r => (r.pass ? '✅' : '❌') + ' ' + r.name).join(' · ');
            logStatus(`🔬 自检 ${res.passed}/${res.total} ${res.passed === res.total ? '通过' : '未通过'}：${detail}`, res.passed === res.total ? 'success' : 'error');
            console.log('[self-test]', res);
            window.__selfTestResults = res;
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', maybeRunSelfTest);
        else maybeRunSelfTest();
        // ===== 初始化 =====
        document.addEventListener('DOMContentLoaded', function() {
            // Tab切换修复
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                    this.classList.add('active');
                    const target = this.dataset.tab;
                    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
                    const panel = document.getElementById(target);
                    if (panel) panel.classList.add('active');
                });
            });

            (function initColors() {
                const picker = $('globalColor');
                const rgb = hexToRgb(picker.value);
                if (rgb) {
                    $('globalColorR').value = rgb.r;
                    $('globalColorG').value = rgb.g;
                    $('globalColorB').value = rgb.b;
                    $('globalColorHex').value = picker.value;
                }
                const specPicker = $('specificColor');
                const specRgb = hexToRgb(specPicker.value);
                if (specRgb) {
                    $('specificColorR').value = specRgb.r;
                    $('specificColorG').value = specRgb.g;
                    $('specificColorB').value = specRgb.b;
                    $('specificColorHex').value = specPicker.value;
                }
            })();

            renderAll();
            if (typeof opentype !== 'undefined' && typeof ImageTracer !== 'undefined') logStatus('✅ 所有功能就绪 · 可直接导出TTF', 'success');
            else logStatus('⚠️ 页面已打开，但字体组件未加载完整；请重新打开本页面', 'error');
        });

        // ===== 预览缩放 =====
        function toggleZoom(btn) {
            const box = btn.closest('.preview-box');
            const slider = box.querySelector('.zoom-slider');
            slider.style.display = slider.style.display === 'none' ? 'inline-flex' : 'none';
        }
        function applyPreviewZoom(slider) {
            const box = slider.closest('.preview-box');
            const canvas = box.querySelector('canvas');
            const z = parseFloat(slider.value);
            box.querySelector('.zoom-val').textContent = z.toFixed(1) + 'x';
            canvas.style.transform = 'scale(' + z + ')';
            // 放大时加高容器以便滚动查看
            box.querySelector('.preview-canvas-wrap').style.height = (z > 1 ? Math.round(100 * z) : 100) + 'px';
        }

        // ===== 快速匹配 =====
        function parseTargets(text) {
            const lines = String(text || '').split('\n').map(s => s.trim()).filter(s => s.length > 0);
            if (lines.length === 0) return [];
            if (lines.length === 1) return [...lines[0]];
            return lines.map(s => singleCharacter(s)).filter(Boolean);
        }
        function renderSymbolToGlyph(symbol, target) {
            const canvas = document.createElement('canvas');
            const size = 200;
            canvas.width = size; canvas.height = size;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, size, size);
            ctx.fillStyle = '#000000';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.font = '160px sans-serif';
            ctx.fillText(symbol, size / 2, size / 2 + 10);
            const colorful = glyphHasColor(ctx.getImageData(0, 0, size, size).data);
            const dataURL = canvas.toDataURL('image/png');
            return { imgData: dataURL, width: size, height: size, isSymbol: !colorful };
        }
        function openQuickMatch() {
            $('quickMatchModal').classList.add('active');
            switchQuickMatchMode();
        }
        function closeQuickMatch() { $('quickMatchModal').classList.remove('active'); }
        function switchQuickMatchMode() {
            const mode = (document.querySelector('input[name="qmMode"]:checked') || {}).value || 'png';
            $('qmPngCol').style.display = mode === 'png' ? '' : 'none';
            $('qmEmojiCol').style.display = mode === 'emoji' ? '' : 'none';
            $('qmEmojiCol2').style.display = mode === 'emoji' ? '' : 'none';
        }
        function openQuickMatchHelp() {
            alert('⚡ 快速匹配说明\n\n① 匹配当前 PNG/SVG：按当前导入图片的顺序，把输入框里的字符一一分配为替换目标（可整串输入，或一行一个字符）。\n\n② 批量匹配 emoji：左边输入 emoji/彩色图标，右边输入要替换的字符，按顺序一一对应生成修符。');
        }
        function confirmQuickMatch() {
            const mode = (document.querySelector('input[name="qmMode"]:checked') || {}).value || 'png';
            if (mode === 'png') {
                const targets = parseTargets($('qmPngText').value);
                if (!targets.length) { alert('请输入要替换的字符'); return; }
                // 只给尚未指定目标的修符按顺序分配
                const pending = state.glyphs.filter(g => !g.char);
                if (!pending.length) { alert('当前没有未指定目标的图片/SVG 修符，请先导入图片'); return; }
                let assigned = 0;
                for (let i = 0; i < Math.min(targets.length, pending.length); i++) {
                    pending[i].char = singleCharacter(targets[i]) || '';
                    assigned++;
                }
                if (targets.length > pending.length) logStatus(`⚠️ 输入 ${targets.length} 个字符，但只有 ${pending.length} 张未匹配图片，超出部分忽略`, 'info');
                renderGlyphList(); renderAll();
                logStatus(`✅ 快速匹配完成：${assigned} 个目标已分配`, 'success');
            } else {
                const emojis = [...String($('qmEmojiText').value || '')].filter(c => c.trim() !== '');
                const targets = parseTargets($('qmEmojiTarget').value);
                if (!emojis.length || !targets.length) { alert('左右两边都要输入'); return; }
                const n = Math.min(emojis.length, targets.length);
                for (let i = 0; i < n; i++) {
                    const sym = renderSymbolToGlyph(emojis[i], targets[i]);
                    addGlyph({ imgData: sym.imgData, width: sym.width, height: sym.height, char: singleCharacter(targets[i]) || '',
                        size: 48, letterSpacing: 0, xOffset: 0, yOffset: 0, color: '#000000', fine: 50, brightness: 100, hue: 0, isSymbol: sym.isSymbol });
                }
                if (emojis.length !== targets.length) logStatus(`⚠️ emoji ${emojis.length} 个、字符 ${targets.length} 个，按较短一侧匹配 ${n} 个`, 'info');
                logStatus(`✅ 批量 emoji 匹配完成：${n} 个`, 'success');
            }
            closeQuickMatch();
            $('qmPngText').value = ''; $('qmEmojiText').value = ''; $('qmEmojiTarget').value = '';
        }

        // ===== 自定义背景（IndexedDB：每个浏览器/域名单独保存，不上传） =====
        const BG_DB_NAME = 'fontEditorLocal', BG_DB_VERSION = 1;
        const BG_STORE = 'backgrounds', BG_META_STORE = 'meta', BG_MAX_BYTES = 20 * 1024 * 1024;
        let _bgList = [], _bgActive = null, _bgDbPromise = null, _bgReady = null;

        function bgRequest(req) {
            return new Promise((resolve, reject) => {
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error || new Error('浏览器本地存储失败'));
            });
        }
        function bgTxDone(tx) {
            return new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onabort = tx.onerror = () => reject(tx.error || new Error('浏览器本地存储失败'));
            });
        }
        function openBgDB() {
            if (_bgDbPromise) return _bgDbPromise;
            _bgDbPromise = new Promise((resolve, reject) => {
                if (!window.indexedDB) { reject(new Error('当前浏览器不支持本地背景库')); return; }
                const req = indexedDB.open(BG_DB_NAME, BG_DB_VERSION);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(BG_STORE)) db.createObjectStore(BG_STORE, { keyPath: 'id' });
                    if (!db.objectStoreNames.contains(BG_META_STORE)) db.createObjectStore(BG_META_STORE, { keyPath: 'key' });
                };
                req.onsuccess = () => {
                    const db = req.result;
                    db.onversionchange = () => { db.close(); _bgDbPromise = null; };
                    resolve(db);
                };
                req.onerror = () => reject(req.error || new Error('无法打开浏览器本地背景库'));
                req.onblocked = () => reject(new Error('本地背景库正在被其他页面占用，请关闭旧页面后重试'));
            }).catch(error => { _bgDbPromise = null; throw error; });
            return _bgDbPromise;
        }
        async function readBgDB(db) {
            const tx = db.transaction([BG_STORE, BG_META_STORE], 'readonly'), done = bgTxDone(tx);
            const recordsReq = tx.objectStore(BG_STORE).getAll();
            const activeReq = tx.objectStore(BG_META_STORE).get('active');
            const [records, active] = await Promise.all([bgRequest(recordsReq), bgRequest(activeReq), done]);
            return { records: records.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)), active: active ? active.value : null };
        }
        async function migrateLegacyBg(db) {
            let legacy = null;
            try { legacy = JSON.parse(localStorage.getItem('fontEditorBg') || 'null'); } catch (error) {
                logStatus('⚠️ 旧背景记录格式异常，已忽略；可重新选择背景', 'error');
            }
            const sources = legacy && Array.isArray(legacy.list) ? legacy.list.filter(x => typeof x === 'string' && x.startsWith('data:image/')) : [];
            if (legacy && typeof legacy.active === 'string' && legacy.active.startsWith('data:image/') && !sources.includes(legacy.active)) sources.push(legacy.active);
            if (!sources.length) return null;
            const now = Date.now(), records = [];
            for (let i = 0; i < sources.length; i++) {
                try {
                    const blob = await (await fetch(sources[i])).blob(); // data: URL，仅本地解码，不联网
                    if (blob.type.startsWith('image/') && blob.size <= BG_MAX_BYTES) records.push({ id: `legacy-${now}-${i}`, blob, name: `旧背景${i + 1}`, createdAt: now + i, legacyURL: sources[i] });
                } catch (error) { logStatus(`⚠️ 第 ${i + 1} 张旧背景无法迁移，已跳过`, 'error'); }
            }
            if (!records.length) return null;
            const activeRecord = records.find(r => r.legacyURL === legacy.active);
            const tx = db.transaction([BG_STORE, BG_META_STORE], 'readwrite'), done = bgTxDone(tx);
            for (const record of records) {
                const clean = { ...record }; delete clean.legacyURL;
                tx.objectStore(BG_STORE).put(clean);
            }
            tx.objectStore(BG_META_STORE).put({ key: 'active', value: activeRecord ? activeRecord.id : null });
            await done;
            localStorage.removeItem('fontEditorBg');
            logStatus(`✅ 已把 ${records.length} 张旧背景迁移到浏览器本地背景库`, 'success');
            return { records: records.map(({ legacyURL, ...record }) => record), active: activeRecord ? activeRecord.id : null };
        }
        function replaceBgMemory(records, active) {
            for (const item of _bgList) if (item.url && item.url.startsWith('blob:')) URL.revokeObjectURL(item.url);
            _bgList = records.map(record => ({ ...record, url: URL.createObjectURL(record.blob) }));
            _bgActive = _bgList.some(item => item.id === active) ? active : null;
            const item = _bgList.find(x => x.id === _bgActive);
            applyBg(item ? item.url : null);
            renderBgHistory();
        }
        async function loadBgState() {
            try {
                const db = await openBgDB();
                let state = await readBgDB(db);
                if (!state.records.length) state = await migrateLegacyBg(db) || state;
                else localStorage.removeItem('fontEditorBg');
                replaceBgMemory(state.records, state.active);
            } catch (error) {
                logStatus(`⚠️ ${error.message}；背景仍可临时使用，但无法长期保存`, 'error');
            }
        }
        function applyBg(url) {
            if (!url) { document.body.style.backgroundImage = ''; document.body.style.backgroundSize = ''; return; }
            document.body.style.backgroundImage = `url("${url}")`;
            document.body.style.backgroundSize = 'cover';
            document.body.style.backgroundAttachment = 'fixed';
        }
        function openBgModal() {
            $('bgModal').classList.add('active');
            renderBgHistory();
            if (_bgReady) _bgReady.then(renderBgHistory);
        }
        function closeBgModal() { $('bgModal').classList.remove('active'); }
        async function validateBgFile(file) {
            if (!file.type || !file.type.startsWith('image/')) throw new Error('请选择有效的图片文件');
            if (file.size > BG_MAX_BYTES) throw new Error('背景图片不能超过 20MB');
            const url = URL.createObjectURL(file);
            try {
                await new Promise((resolve, reject) => {
                    const img = new Image();
                    img.onload = resolve;
                    img.onerror = () => reject(new Error('这张图片无法读取，请换一张重试'));
                    img.src = url;
                });
            } finally { URL.revokeObjectURL(url); }
        }
        function bgErrorText(error) {
            return error && error.name === 'QuotaExceededError'
                ? '浏览器本地空间不足，请删除旧背景或清理设备空间后重试'
                : (error && error.message) || '背景保存失败';
        }
        async function addBgImage(event) {
            const file = event.target.files[0];
            event.target.value = '';
            if (!file) return;
            try {
                await validateBgFile(file);
                if (_bgReady) await _bgReady;
                const db = await openBgDB();
                const record = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, blob: file, name: file.name || '背景图片', createdAt: Date.now() };
                const tx = db.transaction([BG_STORE, BG_META_STORE], 'readwrite'), done = bgTxDone(tx);
                tx.objectStore(BG_STORE).put(record);
                tx.objectStore(BG_META_STORE).put({ key: 'active', value: record.id });
                await done;
                const item = { ...record, url: URL.createObjectURL(file) };
                _bgList.push(item); _bgActive = item.id;
                applyBg(item.url); renderBgHistory();
                if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
                logStatus('✅ 背景已仅保存在当前浏览器中，不会上传', 'success');
            } catch (error) { logStatus(`❌ ${bgErrorText(error)}`, 'error'); }
        }
        async function clearBg() {
            try {
                if (_bgReady) await _bgReady;
                const db = await openBgDB(), tx = db.transaction(BG_META_STORE, 'readwrite'), done = bgTxDone(tx);
                tx.objectStore(BG_META_STORE).put({ key: 'active', value: null });
                await done;
                _bgActive = null; applyBg(null); renderBgHistory();
            } catch (error) { logStatus(`❌ ${bgErrorText(error)}`, 'error'); }
        }
        function renderBgHistory() {
            const box = $('bgHistory');
            if (!box) return;
            if (!_bgList.length) { box.innerHTML = '<div style="font-size:12px;color:var(--muted);">暂无背景，点击上方「选择」添加</div>'; return; }
            box.innerHTML = _bgList.map((item, i) => `<div class="thumb${item.id === _bgActive ? ' active' : ''}" style="background-image:url('${item.url}')" onclick="pickBg(${i})"><button class="del" aria-label="删除背景" onclick="event.stopPropagation();delBg(${i})">×</button></div>`).join('');
        }
        async function pickBg(i) {
            const item = _bgList[i];
            if (!item) return;
            try {
                const db = await openBgDB(), tx = db.transaction(BG_META_STORE, 'readwrite'), done = bgTxDone(tx);
                tx.objectStore(BG_META_STORE).put({ key: 'active', value: item.id });
                await done;
                _bgActive = item.id; applyBg(item.url); renderBgHistory();
            } catch (error) { logStatus(`❌ ${bgErrorText(error)}`, 'error'); }
        }
        async function delBg(i) {
            const item = _bgList[i];
            if (!item) return;
            try {
                const db = await openBgDB(), tx = db.transaction([BG_STORE, BG_META_STORE], 'readwrite'), done = bgTxDone(tx);
                tx.objectStore(BG_STORE).delete(item.id);
                if (_bgActive === item.id) tx.objectStore(BG_META_STORE).put({ key: 'active', value: null });
                await done;
                _bgList.splice(i, 1);
                if (item.url.startsWith('blob:')) URL.revokeObjectURL(item.url);
                if (_bgActive === item.id) { _bgActive = null; applyBg(null); }
                renderBgHistory();
            } catch (error) { logStatus(`❌ ${bgErrorText(error)}`, 'error'); }
        }

        // ===== 配色方案 =====
        const THEME_PRESETS = [
            { id: 'def', name: '默认', bg: '#f5f7fa', surface: '#ffffff', surface2: '#f8fafc', border: '#e2e8f0', text: '#1e293b', muted: '#64748b', accent: '#3b82f6' },
            { id: 'bw', name: '黑白', bg: '#ffffff', surface: '#ffffff', surface2: '#f5f5f5', border: '#d4d4d8', text: '#111827', muted: '#6b7280', accent: '#111827' },
            { id: 'wb', name: '白蓝', bg: '#f0f6ff', surface: '#ffffff', surface2: '#f8fbff', border: '#dbeafe', text: '#1e293b', muted: '#64748b', accent: '#3b82f6' },
            { id: 'wp', name: '白粉', bg: '#fff0f5', surface: '#ffffff', surface2: '#fff5f8', border: '#fce7f3', text: '#4a1a2a', muted: '#9d174d', accent: '#ec4899' },
            { id: 'wg', name: '白绿', bg: '#f0fdf4', surface: '#ffffff', surface2: '#f7fef8', border: '#dcfce7', text: '#1e293b', muted: '#64748b', accent: '#16a34a' },
            { id: 'gg', name: '灰绿', bg: '#e8f0ec', surface: '#f5faf7', surface2: '#eef5f1', border: '#cbd5d0', text: '#1e293b', muted: '#52665c', accent: '#16a34a' },
            { id: 'gb', name: '灰蓝', bg: '#eef2f7', surface: '#f7fafc', surface2: '#eef3f8', border: '#d5dee8', text: '#1e293b', muted: '#64748b', accent: '#3b82f6' },
            { id: 'hb', name: '黑蓝', bg: '#0f172a', surface: '#1e293b', surface2: '#243449', border: '#334155', text: '#e2e8f0', muted: '#94a3b8', accent: '#3b82f6' },
            { id: 'hp', name: '黑粉', bg: '#1a0f1a', surface: '#241524', surface2: '#2c1c2c', border: '#4a2a4a', text: '#f1e6f0', muted: '#c9a8c9', accent: '#ec4899' },
        ];
        let _themes = [], _activeThemeId = null, _editingThemeId = null;
        function loadThemeState() {
            _themes = THEME_PRESETS.map(t => ({ ...t }));
            let seed = null;
            try { const s = document.getElementById('themeSeed'); if (s && s.textContent.trim() && s.textContent.trim() !== '{}') seed = JSON.parse(s.textContent); } catch (_) {}
            let ls = null;
            try { ls = JSON.parse(localStorage.getItem('fontEditorTheme') || 'null'); } catch (_) {}
            const src = ls || seed;
            if (src && Array.isArray(src.themes)) {
                for (const t of src.themes) {
                    const idx = _themes.findIndex(x => x.id === t.id);
                    if (idx >= 0) _themes[idx] = { ..._themes[idx], ...t };
                    else _themes.push({ ...t });
                }
            }
            if (src && src.activeThemeId) _activeThemeId = src.activeThemeId;
            const active = _themes.find(t => t.id === _activeThemeId) || _themes[0];
            applyTheme(active);
        }
        function applyTheme(t) {
            if (!t) return;
            _activeThemeId = t.id;
            const r = document.documentElement.style;
            r.setProperty('--bg', t.bg); r.setProperty('--surface', t.surface); r.setProperty('--surface2', t.surface2);
            r.setProperty('--border', t.border); r.setProperty('--text', t.text); r.setProperty('--muted', t.muted); r.setProperty('--accent', t.accent);
            try { localStorage.setItem('fontEditorTheme', JSON.stringify({ activeThemeId: t.id, themes: _themes })); } catch (_) {}
        }
        function openThemeModal() { renderThemeGrid(); $('themeModal').classList.add('active'); }
        function closeThemeModal() { $('themeModal').classList.remove('active'); }
        function switchTheme(id) {
            const t = _themes.find(x => x.id === id);
            if (t) { applyTheme(t); renderThemeGrid(); }
        }
        function renderThemeGrid() {
            $('themeGrid').innerHTML = _themes.map(t => `<div class="theme-chip${t.id === _activeThemeId ? ' active' : ''}" onclick="switchTheme('${t.id}')"><div class="sw"><span style="background:${t.bg}"></span><span style="background:${t.surface}"></span><span style="background:${t.accent}"></span></div>${escapeAttribute(t.name)}</div>`).join('');
            const editing = _themes.find(t => t.id === _activeThemeId);
            $('themeDelBtn').style.display = editing && !THEME_PRESETS.some(p => p.id === editing.id) ? '' : 'none';
            renderThemeEditor();
        }
        function renderThemeEditor() {
            const t = _themes.find(x => x.id === _activeThemeId);
            const box = $('themeEditor');
            if (!t) { box.style.display = 'none'; return; }
            box.style.display = 'grid';
            const fields = [['bg', '背景'], ['surface', '卡片'], ['surface2', '浅底'], ['border', '边框'], ['text', '文字'], ['muted', '次要文字'], ['accent', '强调色']];
            box.innerHTML = fields.map(([k, label]) => `<label>${label} <input type="color" value="${t[k]}" oninput="editThemeField('${k}', this.value)"></label>`).join('');
        }
        function editThemeField(key, val) {
            const t = _themes.find(x => x.id === _activeThemeId);
            if (!t) return;
            t[key] = val;
            applyTheme(t);
        }
        function newCustomTheme() {
            const base = _themes.find(x => x.id === _activeThemeId) || _themes[0];
            const id = 'custom' + Date.now();
            const t = { ...base, id, name: '自定义' };
            _themes.push(t);
            applyTheme(t);
            renderThemeGrid();
        }
        function deleteCurrentTheme() {
            const t = _themes.find(x => x.id === _activeThemeId);
            if (!t || THEME_PRESETS.some(p => p.id === t.id)) return;
            _themes = _themes.filter(x => x.id !== t.id);
            applyTheme(_themes[0]);
            renderThemeGrid();
        }
        async function saveThemeToHtml() {
            const seed = JSON.stringify({ activeThemeId: _activeThemeId, themes: _themes }).replace(/</g, '\\u003c');
            try {
                // 工作区重排前的模板只含一套 DOM；不能序列化已运行的界面后再次执行初始化。
                if (!window.fontStudioTemplate) throw new Error('页面模板尚未就绪，请重新打开页面');
                const doc = new DOMParser().parseFromString(window.fontStudioTemplate, 'text/html');
                logStatus('正在打包完整 HTML…', 'info');
                for (const script of doc.querySelectorAll('script[src]')) {
                    const response = await fetch(new URL(script.getAttribute('src'), document.baseURI));
                    if (!response.ok) throw new Error('脚本资源加载失败');
                    script.removeAttribute('src');
                    script.textContent = (await response.text()).replace(/<\/script/gi, '<\\/script');
                }
                for (const link of doc.querySelectorAll('link[rel="stylesheet"]')) {
                    const response = await fetch(new URL(link.getAttribute('href'), document.baseURI));
                    if (!response.ok) throw new Error('样式资源加载失败');
                    const style = doc.createElement('style'); style.textContent = await response.text(); link.replaceWith(style);
                }
                const payload = doc.getElementById('vfPyPayload');
                if (payload && !payload.textContent.trim()) payload.textContent = JSON.stringify(await readVfPayloadResources()).replace(/</g, '\\u003c');
                doc.getElementById('themeSeed').textContent = seed;
                downloadText('<!DOCTYPE html>\n' + doc.documentElement.outerHTML, '字屿_完整字体工具.html', 'text/html');
                logStatus('已生成包含当前配色、脚本和字体引擎的完整 HTML', 'success');
            } catch (e) { logStatus(`HTML 打包失败：${e.message}`, 'error'); alert(`HTML 打包失败：${e.message}`); }
        }
        function downloadText(text, filename, mime) {
            const blob = new Blob([text], { type: mime });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1500);
        }
        // ===== 更新日志 =====
        // 新版本加在数组最上面即可，按顺序渲染，每个版本自动带分隔线
        const CHANGELOG = [
            { ver: 'V5.2', date: '2026.9.19', items: [
                '标题旁补上署名和联系方式；修复部分字体能导入却无法导出的问题。',
                '修复了部分符号调粗细时，有的部分反而变细的问题；现在整枚符号会一起变粗或变细，导入的单色图片符号也能在预览中看到粗细变化。',
                "右上角新增语言切换：简体中文、English、日本語、한국어 四种语言点一下就能换，换完整页界面（包括各个功能页、弹窗和提示）都会跟着变；选过的语言会记住，下次打开还是它",
                '可以把字体导出成「可变字体」了：导出时选可变字体，再自己填最细、最粗两档。第一次导出要等二十秒左右（正在启动引擎），进度会显示出来',
                '可以直接导入可变字体：按轴拖动就能实时看效果，选中一档固化成普通字体，之后照常编辑、导出',
                '彩色字符不再变黑：彩色字符换到别的字体、字体内部互换、或直接导出时，彩色图案都会一起搬过去，并跟着大小和粗细一起缩放，不会再出现颜色和轮廓错位',
                '字体调整的「全局」新增【排除】：勾上后会出现输入框，写进去的字不跟着全局调整走（对单个字的「指定」调整仍然照常生效）',
                '可以直接改字体内部真名：改完导出的字体，在设备里显示的就是你写的这个名字',
                '新增「许可与来源」：源码公开、个人免费使用，可以修改后再发布（需要注明来自本项目），禁止倒卖',
                '修复了带多套配色的彩色字体一改就导不出来的问题：这类字体（自带几套配色方案的那种）现在加粗、调整后都能正常导出，几套配色都会原样保留下来',
                '修复了大字体导出的隐患：两万多个字的字体，导出的文件里以前有一处字符索引是坏的，少数软件打开会出现缺字或认不出字；现在正常了，这类字体也能顺利导出可变字体',
            ] },
            { ver: 'V5.1', date: '2026.9.17', items: [
                '修复了批量上颜色没有反应、符号单独调整不生效的问题；现在大小、位置、粗细和颜色都能正常应用',
                '「指定」调整新增数字、符号和已替换语言分组；选择日语等语言后，还能单独勾选平假名、片假名或漢字',
            ] },
            { ver: 'V5', date: '2026.9.15', items: [
                '离线也能用：第一次完整打开后，以后没网、关掉浏览器再打开，也能继续编辑和导出',
                '背景图片只保存在你自己的设备上，不会上传网站、不占服务器空间；以前存的背景会自动保留，图片多了也不会再保存失败',
                '字体替换：可以用多个替换字体，按指定字符、数字或语言，把图样批量换到另一个字体里',
                '替换结果会自动生效：「下载被替换字体」和主页面导出拿到的都是换好之后的字体，不用先手动点一次替换；替换区的界面也精简了，替换字体卡片能直接输入任意文字看效果',
                '含多种文字的语言可以分开选：选「日语」「韩语」这类语言时，下面会多一行提示和【筛选】键，点进去能把平假名、片假名、漢字（Kanji）分开勾选——不想让简体中文跟着被换，取消「漢字」就行',
                '字体内字符互换：默认操作主页面字体，也可以选导入进来的字体；逐行写，或一次输入两行快速匹配；是真互换（三行 a→b、b→c、c→a 是转一圈，不会变成三个一样的字），执行成功弹窗会自动关闭',
                '改完立刻看得见：互换还没执行也会同步显示在主页面的「修改后预览」里',
                '「上一步」：主界面和字体内替换面板各有一个，可以撤回刚才的互换；换了新字体会自动作废旧记录，不会莫名退回上一个字体',
                '不再误报重复：把「我爱你」换成「爱你吗」这类连带相同的写法，不会再被当成重复来提醒',
                '界面整理：字体调整、字体修符、字体替换三个大功能改成并排切换，一次只看一块，页面不再冗长（原来的「排序」功能去掉）；字体调整的「指定」页支持一次输入一串字符共用同一组调整；导出文件名可以用导入字体名、固定文字、递增数字或字母，并给变化的部分加自选的前后样式',
            ] },
            { ver: 'V4.1', date: '2026.9.14 14:07', items: [
                '修复了网络不稳定时部分功能可能加载失败的问题。现在需要用到的功能都放进网页里了，页面打开后断网也能继续编辑和导出字体',
            ] },
            { ver: 'V4', date: '2026.9.14 11:48', items: [
                '在「修改后预览」窗口新增了原字框线和现字框线，可以更直观地对比和原来字符的大小、上浮下沉的情况（灵感来自青柠宝宝，非常感谢）',
                '导出配置可以连同当前导入的字体一起导出了（灵感来自青柠宝宝，感谢！）',
                '修复了粗细无法更改的bug',
                '修复了在导入时不管什么字体都会变成大小48等等的问题，现在导入都是会原样显示各项参数（可以看到参数旁边写着“原样”，虽然大小等等还是显示48，但只是为了方便调整才写了个数，实际上还是原参数）',
                '修复了预览看不全的bug',
                '！兼容了苹果手机——主要是修改了字体的颜色导出逻辑。现在苹果也可以享受会变色的修符了',
            ], note: '详细版色彩逻辑：V3.2 的色彩逻辑是「只要修符的图有一点点非纯黑色的色彩，就会以彩色形式导出」。现在的逻辑是：无论导进去是有颜色还是没颜色，勾选了彩色导出才会以原本的颜色导出，未勾选则默认渲染一层纯黑色。也就是说哪怕导进去是彩色的，不勾选彩色导出就会使你的修符变成「在阅读软件里可以随字体颜色变色」的纯黑色，哪怕扣图不仔细、不小心留了点白边也没关系了。想让这个修符始终不变色、保持原来的样子 → 就勾选彩色导出；想让它随字体颜色变色 → 就别勾。' },
            { ver: 'V3.2', date: '2026.9.12', items: [
                '紧急修复了一下纯黑无法随阅读软件变色的问题。',
            ] },
            { ver: 'V3.1', date: '2026.9.12 16:38', items: [
                '新增了「原始」里选区、锁定透明度、对称翻转、吸色的功能，现在可以做到仅修改原字部分颜色了',
                '修复了预览里调整好大小的符号导出后变大的问题。',
            ] },
            { ver: 'V3', date: '2026.9.12 13:54', items: [
                '修复了彩色图或彩色符号导出时会自动变成黑色的bug',
                '新增了更改此文件配色的功能，新增了调整预览文字界面视图缩放的功能（感谢青柠宝宝给的灵感）',
                '新增了修符的「快速匹配」功能，允许多选图片导入后直接输入一行字去按顺序匹配导入的图，或是输入一串Emoji去匹配一行字的对应字符。',
            ] },
            { ver: 'V2', date: '2026.9.11 22:08', items: [
                '修复了ios系统里符号修符弹窗出框且无法生效的问题',
                '修复了全彩图案、符号导入后默认填色的问题',
                '调整了字体/图标导入的默认颜色，现在会直接默认为#000000了',
                '修复了选择键无法选择的问题',
                '修复了修改预览文本后不能马上生效、得先改某数值才会显示的问题',
                '在「原始」功能里增加了选区（允许新建图层）、液化的功能。',
            ] },
            { ver: 'V1', date: '2026.9.10 15:27', items: [
                '把上版本说过要优化的给优化了',
                '修复了修符功能的以符号替换和画板替换标点符号时无法导出的问题。',
            ] },
            { ver: '测试版', date: '2026.9.10 凌晨4:47', items: [
                '肘击鲸鱼做到结尾它崩了，紧急唤出G老师接着做。',
                '进度：各功能基本完善，测试了可以导入导出配置、基本的字体调整功能、修符的三种格式均适配透明底，并且能够导出ttf，所有工序均在本地进行。',
                '下一步计划：将输入预览文字的框另起一行并给足空间。优化预览文字所在位置。将版面调整为【字体调整】和【字体修符】两大块，均可以折叠。修符界面可以自由置顶或反正可以调整图片顺序，方便看到目前正在调整的图形的预览。优化原始界面的操作还有边界。',
            ] },
        ];
        function renderChangelog() {
            const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            $('changelogBody').innerHTML = CHANGELOG.map(v => `
                <div class="changelog-item">
                    <h3>${esc(v.ver)}<span class="cl-date">${esc(v.date || '')}</span></h3>
                    <ul>${v.items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
                    ${v.note ? `<div class="cl-note">${esc(v.note)}</div>` : ''}
                </div>`).join('');
        }
        function openChangelog() { renderChangelog(); $('changelogModal').classList.add('active'); }
        function closeChangelog() { $('changelogModal').classList.remove('active'); }
        window.openChangelog = openChangelog;
        window.closeChangelog = closeChangelog;

        // ===== 许可与来源（正文全部内联在页面里，转发文件时许可跟着走） =====
        function openLicense() { $('licenseModal').classList.add('active'); }
        function closeLicense() { $('licenseModal').classList.remove('active'); }
        window.openLicense = openLicense;
        window.closeLicense = closeLicense;

        _bgReady = loadBgState();
        loadThemeState();

        // 首次完整打开后缓存网页；在线时优先取最新版，断网时回退到本机缓存
        function enableOfflineMode() {
            const localSecure = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
            if (!('serviceWorker' in navigator) || (location.protocol !== 'https:' && !localSecure)) return;
            navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' })
                .then(reg => { reg.update().catch(() => {}); return navigator.serviceWorker.ready; })
                .then(() => {
                    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
                    logStatus('✅ 离线模式已启用：完整打开一次后，断网也能重新进入', 'success');
                })
                .catch(() => logStatus('⚠️ 离线模式暂未启用，请联网刷新一次', 'error'));
        }
        // Hosting does not ship the upstream service worker. Single HTML remains usable offline.

        // 暴露全局
        window.importImages = importImages;
        window.createSymbolGlyph = createSymbolGlyph;
        window.openDrawModal = openDrawModal;
        window.closeDrawModal = closeDrawModal;
        window.resizeDrawCanvas = resizeDrawCanvas;
        window.clearDrawCanvas = clearDrawCanvas;
        window.undoDraw = undoDraw;
        window.confirmDraw = confirmDraw;
        window.renderAll = renderAll;
        window.exportConfig = exportConfig;
        window.exportPreviewPNG = exportPreviewPNG;
        window.importConfig = importConfig;
        window.importConfigFile = importConfigFile;
        window.applySpecific = applySpecific;
        window.clearSpecific = clearSpecific;
        window.openOriginEdit = openOriginEdit;
        window.setOriginTool = setOriginTool;
        window.resetView = resetView;
        window.closeOriginEdit = closeOriginEdit;
        window.confirmOriginEdit = confirmOriginEdit;
        window.exportTTF = exportTTF;
        window.updateGlyph = updateGlyph;
        window.removeGlyph = removeGlyph;
        window.addGlyph = addGlyph;
        window.moveGlyph = moveGlyph;
        window.setGlyphTarget = setGlyphTarget;
        window.undoOriginEdit = undoOriginEdit;
        window.resetCurrentLayer = resetCurrentLayer;
        window.runSelfTest = runSelfTest;
        window.toggleZoom = toggleZoom;
        window.applyPreviewZoom = applyPreviewZoom;
        window.openQuickMatch = openQuickMatch;
        window.closeQuickMatch = closeQuickMatch;
        window.switchQuickMatchMode = switchQuickMatchMode;
        window.openQuickMatchHelp = openQuickMatchHelp;
        window.confirmQuickMatch = confirmQuickMatch;
        window.openBgModal = openBgModal;
        window.closeBgModal = closeBgModal;
        window.addBgImage = addBgImage;
        window.clearBg = clearBg;
        window.pickBg = pickBg;
        window.delBg = delBg;
        window.openThemeModal = openThemeModal;
        window.closeThemeModal = closeThemeModal;
        window.switchTheme = switchTheme;
        window.newCustomTheme = newCustomTheme;
        window.saveThemeToHtml = saveThemeToHtml;
        window.deleteCurrentTheme = deleteCurrentTheme;
        window.editThemeField = editThemeField;
    

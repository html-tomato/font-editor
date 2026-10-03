

        // ===== V5：字体替换、批量调整、排序、导出命名 =====
        state.replacementTarget = null;
        state.replacementFonts = [];
        state._replacementFontId = 0;

        const V5_LANGUAGE_CODES = ('aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zu').split(' ');
        const V5_ZH_NAMES = new Intl.DisplayNames(['zh-CN'], { type: 'language' });
        const V5_EN_NAMES = new Intl.DisplayNames(['en'], { type: 'language' });
        const V5_LANGUAGES = [
            { code: 'zh-Hans', zh: '简体中文', en: 'Simplified Chinese', script: 'Hani', aliases: '简体 简中 中文 汉字 Chinese Mandarin' },
            { code: 'zh-Hant', zh: '繁体中文', en: 'Traditional Chinese', script: 'Hani', aliases: '繁体 繁中 中文 漢字 Chinese Cantonese' },
            ...V5_LANGUAGE_CODES.map(code => {
                let script = '';
                try { script = new Intl.Locale(code).maximize().script || ''; } catch (_) {}
                return { code, zh: V5_ZH_NAMES.of(code) || code, en: V5_EN_NAMES.of(code) || code, script, aliases: '' };
            })
        ].sort((a, b) => a.zh.localeCompare(b.zh, 'zh-CN'));
        const V5_LANGUAGE_CODE_SET = new Set(V5_LANGUAGES.map(x => x.code));
        const v5ScriptRegex = new Map();
        let v5LanguageFontId = null;
        let v5SwapRows = [{ from: '', to: '' }, { from: '', to: '' }, { from: '', to: '' }];
        let v5DownloadContext = null;

        const v5Esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
        function v5Characters(value) {
            return [...new Set(Array.from(String(value || '')).filter(ch => !/\s/u.test(ch)))];
        }
        function v5FontType(buffer, name = '') {
            if (buffer && buffer.byteLength >= 4) {
                const signature = new DataView(buffer).getUint32(0);
                if (signature === 0x4F54544F) return 'otf';
                // ponytail: 文件名可改，已识别的 TrueType 文件头优先于 .otf 后缀
                if (signature === 0x00010000 || signature === 0x74727565) return 'ttf';
            }
            return String(name).toLowerCase().endsWith('.otf') ? 'otf' : 'ttf';
        }
        function v5ReadFileBuffer(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => resolve(e.target.result);
                reader.onerror = () => reject(new Error(`无法读取字体“${file.name || '未命名'}”`));
                reader.readAsArrayBuffer(file);
            });
        }
        async function v5ReadFontFile(file) {
            if (!file) throw new Error('没有选择字体文件');
            const buffer = await v5ReadFileBuffer(file);
            let font;
            try { font = opentype.parse(buffer); }
            catch (_) { throw new Error(v5NoVectorOutlineReason(buffer) || `“${file.name}”不是可读取的 TTF／OTF 字体`); }
            // 可变字体只当「静态默认档」用：既有的取字形链读不到 gvar，这里先说明白，别让用户以为选中的档生效了
            if (v5SfntTags(buffer).has('fvar')) logStatus(`ℹ️ “${file.name}”是可变字体：本工具取它默认那一档的字形，不会按轴实例化`, 'info');
            return { name: file.name || '未命名字体.ttf', type: v5FontType(buffer, file.name), buffer, font };
        }
        function v5ApplyMainFont(record, reset = false) {
            const font = record.font || opentype.parse(record.buffer);
            if (reset) resetFontEdits();
            state.font = font;
            state.fontBuffer = record.buffer;
            state.fontType = record.type || v5FontType(record.buffer, record.name);
            state.fontName = record.name || `replacement-result.${state.fontType}`;
            $('fontStatus').textContent = `✅ ${state.fontName} (${state.font.familyName || '未知'})`;
            renderAll();
            renderSwapFontOptions();
            v5RefreshSpecificTargets();
            v5VfAfterLoad(record.buffer, false);
        }
        // 一种语言可能同时写多种文字（日语＝平假名＋片假名＋汉字，韩语＝谚文＋汉字），这里给出它的文字集合
        function v5LanguageScripts(code) {
            if (code === 'zh-Hans' || code === 'zh-Hant') return ['Hani'];
            if (code === 'ja') return ['Hira', 'Kana', 'Hani'];
            if (code === 'ko') return ['Hang', 'Hani'];
            const entry = V5_LANGUAGES.find(x => x.code === code);
            let script = entry?.script || '';
            if (script === 'Hans' || script === 'Hant') script = 'Hani';
            if (script === 'Jpan') return ['Hira', 'Kana', 'Hani'];
            if (script === 'Kore') return ['Hang', 'Hani'];
            return script ? [script] : [];
        }
        function v5ScriptMatches(cp, script) {
            if (!v5ScriptRegex.has(script)) {
                try { v5ScriptRegex.set(script, new RegExp(`\\p{Script_Extensions=${script}}`, 'u')); }
                catch (_) { v5ScriptRegex.set(script, null); }
            }
            return !!v5ScriptRegex.get(script)?.test(String.fromCodePoint(cp));
        }
        // allowed＝该语言筛过之后保留的文字；不传＝该语言的全部文字
        function v5LanguageMatches(cp, code, allowed = null) {
            const ch = String.fromCodePoint(cp);
            if (code === 'en') return /^[A-Za-z]$/.test(ch);
            if (!/[\p{Letter}\p{Mark}]/u.test(ch)) return false;
            const scripts = allowed?.length ? allowed : v5LanguageScripts(code);
            return scripts.some(script => v5ScriptMatches(cp, script));
        }
        const V5_SCRIPT_NAMES = new Intl.DisplayNames(['zh-CN'], { type: 'script' });
        // 日语/韩语里的汉字各有专业叫法（漢字＝Kanji／Hanja），其余文字交给系统的中文名
        function v5ScriptLabel(script, code) {
            if (uiLocale !== 'zh-CN') {
                if (script === 'Hani' && code === 'ja') return 'Kanji';
                if (script === 'Hani' && code === 'ko') return 'Hanja';
                try { return new Intl.DisplayNames([uiLocale], { type: 'script' }).of(script) || script; } catch (_) { return script; }
            }
            if (script === 'Hani') return code === 'ja' ? '漢字（Kanji）' : code === 'ko' ? '漢字（Hanja）' : '汉字';
            try { return V5_SCRIPT_NAMES.of(script) || script; } catch (_) { return script; }
        }
        // 已选语言里含多种文字的（这些才需要给用户拆分筛选项）
        function v5MultiScriptLanguages(item) {
            return (item.languages || []).filter(code => v5LanguageScripts(code).length > 1);
        }
        // 筛选后该语言保留的文字；没筛过＝该语言的全部文字（旧配置/旧状态照旧生效）
        function v5ScriptFilter(item, code) {
            const chosen = item.scriptFilter?.[code];
            return Array.isArray(chosen) && chosen.length ? chosen : v5LanguageScripts(code);
        }
        function v5NormalizeScriptFilter(raw) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
            const out = {};
            for (const [code, list] of Object.entries(raw)) {
                const all = v5LanguageScripts(code);
                if (!all.length || !Array.isArray(list)) continue;
                const keep = all.filter(script => list.includes(script));
                if (keep.length && keep.length < all.length) out[code] = keep;
            }
            return Object.keys(out).length ? out : undefined;
        }
        // 该字体里每类文字各有多少字符（只统计已选语言涉及的文字，打开筛选时算一次）
        function v5ScriptCounts(item) {
            if (!item._scriptCounts) {
                const scripts = [...new Set(v5MultiScriptLanguages(item).flatMap(v5LanguageScripts))];
                const counts = {};
                for (const cp of v5SourceCodePoints(item)) {
                    const ch = String.fromCodePoint(cp);
                    if (!/[\p{Letter}\p{Mark}]/u.test(ch)) continue;
                    for (const script of scripts) if (v5ScriptMatches(cp, script)) counts[script] = (counts[script] || 0) + 1;
                }
                item._scriptCounts = counts;
            }
            return item._scriptCounts;
        }
        function v5SourceCodePoints(item) {
            if (!item._sourceCodePoints) {
                const map = item.font?.tables?.cmap?.glyphIndexMap || {};
                item._sourceCodePoints = Object.keys(map).map(Number).filter(Number.isFinite);
            }
            return item._sourceCodePoints;
        }
        function selectedReplacementCodePoints(item) {
            if (item._selectedCodePoints) return item._selectedCodePoints;
            const selected = new Set(v5Characters(item.chars).map(ch => ch.codePointAt(0)));
            if (item.digits) for (let cp = 48; cp <= 57; cp++) selected.add(cp);
            const langs = Array.isArray(item.languages) ? item.languages : [];
            if (langs.length) for (const cp of v5SourceCodePoints(item)) if (langs.some(code => v5LanguageMatches(cp, code, v5ScriptFilter(item, code)))) selected.add(cp);
            item._selectedCodePoints = selected;
            return selected;
        }
        function replacementSourceForChar(ch) {
            if (!state.replacementTarget || state.replacementTarget.buffer !== state.fontBuffer) return null;
            const cp = ch.codePointAt(0);
            return (state.replacementFonts || []).find(item => selectedReplacementCodePoints(item).has(cp)) || null;
        }
        window.replacementSourceForChar = replacementSourceForChar;

        function v5DrawFontSample(canvas, font, text, glyphMap = null) {
            if (!canvas || !font) return;
            const width = Math.max(220, Math.floor(canvas.clientWidth || 420));
            const height = 76, dpr = Math.min(2, window.devicePixelRatio || 1);
            canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
            const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
            const chars = Array.from(text || 'Aa 字体 0123');
            let size = 34;
            const measure = s => chars.reduce((sum, ch) => {
                const source = glyphMap?.get(ch) || ch;
                try { return sum + font.getAdvanceWidth(source, s, { kerning: false }); } catch (_) { return sum + s * .6; }
            }, 0);
            const measured = measure(size);
            if (measured > width - 24) size *= (width - 24) / measured;
            let x = 12, y = 51;
            ctx.fillStyle = '#111827';
            for (const ch of chars) {
                const source = glyphMap?.get(ch) || ch;
                try {
                    // 字体自带彩色的字按原色显示（否则替换面板里彩色字体只会显示成一排深灰）
                    const info = v5PreviewColorLayers(v5PreviewBufferFor(font));
                    const gid = info ? font.charToGlyphIndex(source) : 0;
                    if (!(info && gid && v5DrawColorGlyph(ctx, font, info, gid, x, y, size, 0, '#111827'))) {
                        const path = font.getPath(source, x, y, size);
                        path.fill = '#111827'; path.draw(ctx);
                    }
                    x += font.getAdvanceWidth(source, size, { kerning: false });
                } catch (_) { x += size * .6; }
            }
        }
        function v5ReplacementSample(item) {
            const typed = String(item.previewText ?? '').trim();
            const explicit = v5Characters(item.chars).slice(0, 10).join('');
            return typed || explicit || 'Aa 字体 0123';
        }
        function updateReplacementPreviewText(id, value) {
            const item = state.replacementFonts.find(x => x.id === id); if (!item) return;
            item.previewText = value;
            requestAnimationFrame(() => v5DrawFontSample($(`replacementPreview-${id}`), item.font, v5ReplacementSample(item)));
        }
        function renderReplacementTarget() {
            const box = $('replacementTargetBox');
            if (!box) return;
            const target = state.replacementTarget;
            if (!target) { box.className = 'empty-replace'; box.textContent = '还没有选择被替换字体'; return; }
            box.className = 'replace-target';
            box.innerHTML = `<div class="target-head"><strong>被替换字体：${v5Esc(target.name)}</strong><div class="inline-actions"><button class="btn btn-sm btn-outline" onclick="setReplacementTargetAsMain()">设为主页面字体</button><button class="btn btn-sm btn-outline" onclick="clearReplacementTarget()">移除</button></div></div><div class="feature-help">${v5Esc(target.font?.familyName || '未知字体')} · ${String(target.type || '').toUpperCase()}</div>`;
        }
        function v5LanguageSummary(item) {
            const chosen = V5_LANGUAGES.filter(x => item.languages?.includes(x.code)).map(v5UiLanguageName);
            return chosen.length ? `已选：${chosen.slice(0, 4).join('、')}${chosen.length > 4 ? ` 等 ${chosen.length} 种` : ''}` : '未选择语言';
        }
        function v5UiLanguageName(entry) {
            if (!entry) return '';
            if (uiLocale === 'zh-CN') return entry.zh;
            if (uiLocale === 'en') return entry.en;
            try { return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(entry.code) || entry.en; } catch (_) { return entry.en; }
        }
        function renderReplacementFonts() {
            const list = $('replacementFontList');
            if (!list) return;
            const fonts = state.replacementFonts || [];
            $('replacementFontCount').textContent = String(fonts.length);
            if (!fonts.length) { list.className = 'empty-replace'; list.textContent = '还没有添加替换字体'; renderSwapFontOptions(); return; }
            list.className = '';
            list.innerHTML = fonts.map((item, index) => `<div class="replace-card" data-replacement-id="${item.id}">
                <div class="replace-card-head"><strong>${index + 1}. 替换字体：${v5Esc(item.name)}</strong><button class="btn btn-sm btn-outline" onclick="removeReplacementFont(${item.id})">删除</button></div>
                <label class="replace-preview-text">预览文字<input type="text" value="${v5Esc(item.previewText ?? '')}" placeholder="Aa 字体 0123" oninput="updateReplacementPreviewText(${item.id},this.value)"></label>
                <canvas id="replacementPreview-${item.id}" class="font-sample-canvas"></canvas>
                <div class="replace-options">
                    <label>指定字符（可一次输入很多）<textarea oninput="updateReplacementField(${item.id},'chars',this.value)" placeholder="例如：你好ABC">${v5Esc(item.chars || '')}</textarea></label>
                    <div><label style="display:flex;gap:7px;align-items:center;"><input type="checkbox" ${item.digits ? 'checked' : ''} onchange="updateReplacementField(${item.id},'digits',this.checked)">数字 0–9</label><button class="btn btn-sm btn-outline" style="margin-top:8px;" onclick="openLanguageModal(${item.id})">🌐 选择语言</button><div class="language-summary">${v5Esc(v5LanguageSummary(item))}</div>${v5MultiScriptLanguages(item).length ? `<div class="script-filter-row"><div class="feature-help">当前选择的字体（${v5Esc(v5MultiScriptLanguages(item).map(code => v5UiLanguageName(V5_LANGUAGES.find(x => x.code === code)) || code).join('、'))}）里含有多种形式的文字</div><button class="btn btn-sm btn-outline" onclick="openScriptFilterModal(${item.id})">筛选</button></div>` : ''}</div>
                </div>
                <div class="feature-help replace-selection-count">目前会尝试替换 ${selectedReplacementCodePoints(item).size} 个字符；源字体没有的字符会自动跳过。</div>
            </div>`).join('');
            requestAnimationFrame(() => fonts.forEach(item => v5DrawFontSample($(`replacementPreview-${item.id}`), item.font, v5ReplacementSample(item))));
            renderSwapFontOptions();
        }
        function renderFontReplacementUI() { renderReplacementTarget(); renderReplacementFonts(); v5RefreshSpecificTargets(); }
        function updateReplacementField(id, key, value) {
            const item = state.replacementFonts.find(x => x.id === id); if (!item) return;
            item[key] = value; item._selectedCodePoints = null; state.replacementDirty = true;
            const card = document.querySelector(`[data-replacement-id="${id}"]`);
            const count = card?.querySelector('.replace-selection-count');
            if (count) count.textContent = `目前会尝试替换 ${selectedReplacementCodePoints(item).size} 个字符；源字体没有的字符会自动跳过。`;
            requestAnimationFrame(() => v5DrawFontSample($(`replacementPreview-${id}`), item.font, v5ReplacementSample(item)));
            v5RefreshSpecificTargets(); renderAll();
        }
        function removeReplacementFont(id) {
            state.replacementFonts = state.replacementFonts.filter(x => x.id !== id);
            state.replacementDirty = true;
            renderReplacementFonts(); v5RefreshSpecificTargets(); renderAll();
        }
        function clearReplacementTarget() { state.replacementTarget = null; renderReplacementTarget(); v5RefreshSpecificTargets(); }
        function setReplacementTargetAsMain() {
            if (!state.replacementTarget) return alert('请先选择被替换字体');
            v5ApplyMainFont(state.replacementTarget, true); logStatus('✅ 已把被替换字体设为主页面字体', 'success');
        }
        function openFontImportModal() { $('fontImportModal').classList.add('active'); }
        function closeFontImportModal() { $('fontImportModal').classList.remove('active'); }
        function useCurrentAsReplacementTarget() {
            if (!state.font || !state.fontBuffer) return alert('主页面还没有导入字体');
            state.replacementTarget = { name: state.fontName, type: state.fontType, buffer: state.fontBuffer, font: state.font };
            state.replacementDirty = true;
            renderReplacementTarget(); closeFontImportModal();
        }
        function v5AddReplacementRecord(record, settings = {}) {
            const item = { id: ++state._replacementFontId, name: record.name, type: record.type, buffer: record.buffer, font: record.font,
                chars: typeof settings.chars === 'string' ? settings.chars : '', digits: !!settings.digits,
                languages: Array.isArray(settings.languages) ? settings.languages.filter(x => V5_LANGUAGE_CODE_SET.has(x)) : [],
                scriptFilter: v5NormalizeScriptFilter(settings.scriptFilter),
                previewText: typeof settings.previewText === 'string' ? settings.previewText : '', undo: [] };
            state.replacementFonts.push(item); state.replacementDirty = true; return item;
        }
        function addCurrentAsReplacementFont() {
            if (!state.font || !state.fontBuffer) return alert('主页面还没有导入字体');
            v5AddReplacementRecord({ name: state.fontName, type: state.fontType, buffer: state.fontBuffer.slice(0), font: opentype.parse(state.fontBuffer.slice(0)) });
            renderReplacementFonts(); closeFontImportModal();
        }
        async function importReplacementTarget(event) {
            const file = event.target.files[0]; event.target.value = ''; if (!file) return;
            try { state.replacementTarget = await v5ReadFontFile(file); state.replacementDirty = true; renderReplacementTarget(); closeFontImportModal(); }
            catch (e) { alert(e.message); logStatus(`❌ ${e.message}`, 'error'); }
        }
        async function importReplacementSources(event) {
            const files = Array.from(event.target.files || []); event.target.value = ''; if (!files.length) return;
            try {
                const records = [];
                for (const file of files) records.push(await v5ReadFontFile(file));
                records.forEach(record => v5AddReplacementRecord(record));
                renderReplacementFonts(); closeFontImportModal();
            } catch (e) { alert(e.message); logStatus(`❌ ${e.message}`, 'error'); }
        }

        function openLanguageModal(id) { v5LanguageFontId = id; $('languageSearch').value = ''; renderLanguageList(); $('languageModal').classList.add('active'); }
        function closeLanguageModal() { $('languageModal').classList.remove('active'); renderReplacementFonts(); v5RefreshSpecificTargets(); renderAll(); }
        function renderLanguageList() {
            const item = state.replacementFonts.find(x => x.id === v5LanguageFontId); if (!item) return;
            const query = ($('languageSearch').value || '').trim().toLowerCase();
            const rows = V5_LANGUAGES.filter(x => !query || `${x.zh} ${x.en} ${x.code} ${x.aliases}`.toLowerCase().includes(query));
            $('languageHint').textContent = `共 ${V5_LANGUAGES.length} 种语言可选，当前已选 ${item.languages.length} 种`;
            $('languageList').innerHTML = rows.map(x => `<label class="language-item"><input type="checkbox" ${item.languages.includes(x.code) ? 'checked' : ''} onchange="toggleReplacementLanguage('${x.code}',this.checked)"><span>${v5Esc(v5UiLanguageName(x))}<small>${v5Esc(x.en)} · ${x.code}</small></span></label>`).join('') || '<div class="empty-replace">没有找到匹配的语言</div>';
        }
        function toggleReplacementLanguage(code, checked) {
            const item = state.replacementFonts.find(x => x.id === v5LanguageFontId); if (!item || !V5_LANGUAGE_CODE_SET.has(code)) return;
            const set = new Set(item.languages); checked ? set.add(code) : set.delete(code); item.languages = [...set]; item._selectedCodePoints = null; item._scriptCounts = null; state.replacementDirty = true; renderLanguageList();
        }

        // 一种语言含多种文字时（日语＝平假名/片假名/漢字、韩语＝谚文/漢字），让用户勾选哪些文字参与替换
        let v5ScriptFilterId = null;
        function openScriptFilterModal(id) {
            const item = state.replacementFonts.find(x => x.id === id); if (!item) return;
            v5ScriptFilterId = id; renderScriptFilter(); $('scriptFilterModal').classList.add('active');
        }
        function closeScriptFilterModal() { $('scriptFilterModal').classList.remove('active'); renderReplacementFonts(); v5RefreshSpecificTargets(); renderAll(); }
        function renderScriptFilter() {
            const item = state.replacementFonts.find(x => x.id === v5ScriptFilterId); if (!item) return;
            const counts = v5ScriptCounts(item);
            $('scriptFilterBody').innerHTML = v5MultiScriptLanguages(item).map(code => {
                const lang = V5_LANGUAGES.find(x => x.code === code);
                const chosen = new Set(v5ScriptFilter(item, code));
                return `<div class="script-filter-block"><strong>${v5Esc(lang ? v5UiLanguageName(lang) : code)}</strong><span class="script-filter-sub">${v5Esc(lang?.en || '')} · ${v5Esc(code)}</span>
                    <div class="script-filter-grid">${v5LanguageScripts(code).map(script => `<label class="script-filter-item"><input type="checkbox" ${chosen.has(script) ? 'checked' : ''} onchange="toggleScriptFilter('${code}','${script}',this)"><span>${v5Esc(v5ScriptLabel(script, code))}<small>这个字体里有 ${counts[script] || 0} 个字符</small></span></label>`).join('')}</div></div>`;
            }).join('');
        }
        // 只改状态与主界面数字，不重画弹窗本体（重画会丢滚动位置，也点不动刚被换掉的复选框）
        function toggleScriptFilter(code, script, input) {
            const item = state.replacementFonts.find(x => x.id === v5ScriptFilterId); if (!item) return;
            const all = v5LanguageScripts(code), next = new Set(v5ScriptFilter(item, code));
            input.checked ? next.add(script) : next.delete(script);
            if (!next.size) { input.checked = true; alert(`“${V5_LANGUAGES.find(x => x.code === code)?.zh || code}”至少要保留一种文字；整个语言都不要就回上一页取消勾选它`); return; }
            item.scriptFilter ||= {};
            if (next.size === all.length) delete item.scriptFilter[code]; else item.scriptFilter[code] = all.filter(s => next.has(s));
            if (!Object.keys(item.scriptFilter).length) delete item.scriptFilter;
            item._selectedCodePoints = null; state.replacementDirty = true;
            const count = document.querySelector(`[data-replacement-id="${item.id}"] .replace-selection-count`);
            if (count) count.textContent = `目前会尝试替换 ${selectedReplacementCodePoints(item).size} 个字符；源字体没有的字符会自动跳过。`;
        }

        // “指定”调整的整组选取：数字、符号，或已经替换进当前字体的语言/文字分类。
        const v5SpecificAdjustScripts = new Map();
        function v5SpecificLanguageData() {
            const out = new Map();
            // 只显示已经真正替换进当前字体的语言；尚未点执行/尚待导出自动补做时不提前冒充已完成。
            if (state.replacementDirty || !state.replacementTarget || state.replacementTarget.buffer !== state.fontBuffer) return out;
            const current = state.font?.tables?.cmap?.glyphIndexMap || {};
            for (const item of state.replacementFonts || []) {
                const selected = selectedReplacementCodePoints(item);
                for (const code of item.languages || []) {
                    const allowed = v5ScriptFilter(item, code);
                    if (!out.has(code)) out.set(code, new Map());
                    const scripts = out.get(code);
                    for (const script of allowed) if (!scripts.has(script)) scripts.set(script, new Set());
                    for (const cp of selected) {
                        if (current[cp] === undefined || !v5LanguageMatches(cp, code, allowed)) continue;
                        for (const script of allowed) if (v5ScriptMatches(cp, script)) scripts.get(script).add(cp);
                    }
                }
            }
            for (const [code, scripts] of out) {
                for (const [script, cps] of scripts) if (!cps.size) scripts.delete(script);
                if (!scripts.size) out.delete(code);
            }
            return out;
        }
        function v5RenderSpecificScripts() {
            const code = $('specificLanguage')?.value || '', host = $('specificScriptChoices');
            if (!host) return;
            const scripts = v5SpecificLanguageData().get(code);
            if (!code || !scripts?.size) { host.style.display = 'none'; host.innerHTML = ''; return; }
            let chosen = v5SpecificAdjustScripts.get(code);
            const available = [...scripts.keys()];
            if (!chosen || ![...chosen].some(x => scripts.has(x))) { chosen = new Set(available); v5SpecificAdjustScripts.set(code, chosen); }
            host.innerHTML = available.map(script => `<label><input type="checkbox" ${chosen.has(script) ? 'checked' : ''} onchange="v5ToggleSpecificScript('${code}','${script}',this)">${v5Esc(v5ScriptLabel(script, code))}（${scripts.get(script).size}）</label>`).join('');
            host.style.display = 'flex';
        }
        function v5RefreshSpecificTargets() {
            const select = $('specificLanguage'); if (!select) return;
            const old = select.value, data = v5SpecificLanguageData();
            select.innerHTML = '<option value="">已替换语言</option>' + [...data.keys()].map(code => {
                const lang = V5_LANGUAGES.find(x => x.code === code);
                return `<option value="${v5Esc(code)}">${v5Esc(lang ? v5UiLanguageName(lang) : code)}</option>`;
            }).join('');
            select.value = data.has(old) ? old : '';
            v5RenderSpecificScripts();
            v5UpdateSpecificTargetUI();
        }
        // ===== 全局「排除」的界面联动（勾选即生效，不用点确认） =====
        function v5UpdateGlobalExcludeUI() {
            const on = !!$('globalExcludeToggle')?.checked;
            // 取消勾选＝本次不排除；输入框里的字留着，勾回来继续生效
            state.global.exclude = on ? ($('globalExcludeChars')?.value || '') : '';
            v5RenderGlobalExcludeUI();
            renderAll();
        }
        function v5ApplyGlobalExclude() {
            state.global.exclude = $('globalExcludeChars')?.value || '';
            v5RenderGlobalExcludeUI();
            renderAll();
        }
        function v5RenderGlobalExcludeUI() {
            const on = !!$('globalExcludeToggle')?.checked;
            const input = $('globalExcludeChars'), hint = $('globalExcludeHint'), count = $('globalExcludeCount');
            if (input) input.style.display = on ? '' : 'none';
            if (hint) hint.style.display = on ? '' : 'none';
            if (count) {
                count.style.display = on ? '' : 'none';
                const n = new Set(String(state.global.exclude || '')).size;
                count.textContent = n ? `${n} 个` : '';
            }
        }
        function v5UpdateSpecificLanguageUI() { v5RenderSpecificScripts(); v5UpdateSpecificTargetUI(); }
        function v5ToggleSpecificScript(code, script, input) {
            const scripts = v5SpecificLanguageData().get(code); if (!scripts?.has(script)) return;
            const chosen = new Set(v5SpecificAdjustScripts.get(code) || scripts.keys());
            input.checked ? chosen.add(script) : chosen.delete(script);
            if (!chosen.size) { input.checked = true; alert('至少要保留一种文字'); return; }
            v5SpecificAdjustScripts.set(code, chosen);
            v5UpdateSpecificTargetUI();
        }
        function v5CurrentFontCodePoints() {
            const cps = new Set(Object.keys(state.font?.tables?.cmap?.glyphIndexMap || {}).map(Number).filter(Number.isFinite));
            for (const glyph of state.glyphs || []) { const ch = singleCharacter(glyph.char); if (ch) cps.add(ch.codePointAt(0)); }
            return cps;
        }
        function v5SpecificTargetCharacters() {
            const digits = !!$('specificDigits')?.checked, symbols = !!$('specificSymbols')?.checked;
            const code = $('specificLanguage')?.value || '', active = digits || symbols || !!code;
            if (!active) return { active: false, chars: [], label: '字符' };
            const cps = new Set(), current = v5CurrentFontCodePoints();
            if (digits) for (let cp = 48; cp <= 57; cp++) if (current.has(cp)) cps.add(cp);
            if (symbols) for (const cp of current) if (/[\p{Punctuation}\p{Symbol}]/u.test(String.fromCodePoint(cp))) cps.add(cp);
            if (code) {
                const scripts = v5SpecificLanguageData().get(code), chosen = v5SpecificAdjustScripts.get(code) || new Set(scripts?.keys() || []);
                for (const script of chosen) for (const cp of scripts?.get(script) || []) cps.add(cp);
            }
            const labels = [];
            if (digits) labels.push('数字'); if (symbols) labels.push('符号');
            if (code) labels.push(V5_LANGUAGES.find(x => x.code === code)?.zh || code);
            return { active: true, chars: [...cps].map(cp => String.fromCodePoint(cp)), label: labels.join('、') };
        }
        function v5UpdateSpecificTargetUI() {
            const input = $('specificChar'), targets = v5SpecificTargetCharacters(); if (!input) return;
            input.disabled = targets.active;
            const hint = $('specificTargetHint');
            if (hint) hint.textContent = targets.active ? `当前会调整${targets.label}，共 ${targets.chars.length} 个字符；上面的单个字符输入已锁定。` : '';
        }
        window.v5RefreshSpecificTargets = v5RefreshSpecificTargets;
        window.v5UpdateSpecificTargetUI = v5UpdateSpecificTargetUI;
        window.v5UpdateSpecificLanguageUI = v5UpdateSpecificLanguageUI;
        window.v5ToggleSpecificScript = v5ToggleSpecificScript;
        window.v5SpecificTargetCharacters = v5SpecificTargetCharacters;

        function v5GlyphMap(fontObject) {
            const map = new Map();
            fontObject.glyf.forEach((glyph, index) => {
                const codes = Array.isArray(glyph.unicode) ? glyph.unicode : (glyph.unicode === undefined ? [] : [glyph.unicode]);
                codes.forEach(cp => map.set(cp, index));
            });
            return map;
        }
        function v5CloneScaledGlyph(glyph, cp, ratio, layerName = '') {
            const mapped = Number.isInteger(cp);
            const out = { ...glyph, unicode: mapped ? [cp] : [], name: layerName || (mapped ? (cp <= 0xFFFF ? 'uni' : 'u') + cp.toString(16).toUpperCase().padStart(4, '0') : (glyph.name || 'colorLayer')), compound: false };
            delete out.glyfs; delete out.instructions;
            if (Array.isArray(glyph.contours)) out.contours = glyph.contours.map(contour => contour.map(point => ({ ...point, x: Math.round(point.x * ratio), y: Math.round(point.y * ratio) })));
            for (const key of ['xMin', 'xMax', 'yMin', 'yMax', 'advanceWidth', 'leftSideBearing']) if (Number.isFinite(glyph[key])) out[key] = Math.round(glyph[key] * ratio);
            if (!Number.isFinite(out.advanceWidth)) out.advanceWidth = 0;
            return out;
        }
        function v5DetachCodePoint(fontObject, map, cp) {
            const index = map.get(cp); if (index === undefined) return;
            const glyph = fontObject.glyf[index];
            glyph.unicode = (Array.isArray(glyph.unicode) ? glyph.unicode : [glyph.unicode]).filter(x => x !== cp && x !== undefined);
        }
        async function v5BuildReplacedBuffer(target, sources) {
            if (v5SfntTags(target.buffer).has('fvar')) throw new Error('请先把被替换的可变字体固化为静态字体');
            const core = await loadCore();
            const targetEditor = core.createFont(target.buffer, { type: target.type, hinting: true, kerning: true });
            const targetObject = targetEditor.get();
            const targetUpm = targetObject.head?.unitsPerEm || 1000;
            const targetMap = v5GlyphMap(targetObject), claimed = new Set();
            const targetColor = parseColrCpalV0(target.buffer);
            let colorEntries = targetColor?.version === 0 ? [...targetColor.entries.values()].map(e => ({ ...e, layerGlyphIds: [...e.layerGlyphIds], paletteIndices: [...e.paletteIndices] })) : [];
            const palette = targetColor?.cpal?.palettes?.[0]?.map(c => ({ ...c })) || [];
            let copiedColor = false, replaced = 0, added = 0, skipped = 0;
            for (const item of sources) {
                const requested = [...selectedReplacementCodePoints(item)].filter(cp => !claimed.has(cp));
                if (!requested.length) continue;
                const sourceEditor = core.createFont(item.buffer, { type: item.type, hinting: true, kerning: true });
                const sourceObject = sourceEditor.get(), sourceMap = v5GlyphMap(sourceObject);
                const sourceColor = parseColrCpalV0(item.buffer), unsupported = v5UnsupportedColorFormats(item.buffer, sourceColor);
                const selectedColors = new Map(requested.map(cp => [cp, sourceColor?.version === 0 ? sourceColor.entries.get(sourceMap.get(cp)) : null]).filter(([, e]) => e));
                if (requested.some(cp => !selectedColors.has(cp)) && unsupported.length) throw new Error(`这个替换字体使用 ${unsupported.join('／')} 彩色格式，当前不能安全迁移；已停止，避免彩图变黑`);
                if (selectedColors.size) {
                    if (targetColor && targetColor.version !== 0) throw new Error(`被替换字体使用 COLR v${targetColor.version}，当前不能与 COLR v0 彩图安全合并`);
                    if (!sourceColor?.cpal || sourceColor.cpal.numPalettes !== 1) throw new Error('这个替换字体使用多个或缺失的 CPAL 调色板，当前不能安全迁移颜色');
                    if (targetColor?.cpal && targetColor.cpal.numPalettes !== 1) throw new Error('被替换字体使用多个 CPAL 调色板，当前不能安全合并颜色');
                }
                const sourceIndices = [...new Set(requested.map(cp => sourceMap.get(cp)).filter(i => i !== undefined))];
                const layerIndices = [...new Set([...selectedColors.values()].flatMap(e => e.layerGlyphIds))];
                const compounds = [...new Set([...sourceIndices, ...layerIndices])].filter(i => sourceObject.glyf[i]?.compound);
                if (compounds.length) sourceEditor.getHelper().compound2simple(compounds);
                const ratio = targetUpm / (sourceObject.head?.unitsPerEm || 1000);
                for (const cp of requested) {
                    const sourceIndex = sourceMap.get(cp); if (sourceIndex === undefined) { skipped++; continue; }
                    const existed = targetMap.has(cp), baseClone = v5CloneScaledGlyph(sourceObject.glyf[sourceIndex], cp, ratio);
                    const sourceEntry = selectedColors.get(cp), layerClones = [];
                    if (sourceEntry) {
                        for (let i = 0; i < sourceEntry.layerGlyphIds.length; i++) {
                            const gid = sourceEntry.layerGlyphIds[i], glyph = sourceObject.glyf[gid];
                            if (!glyph) throw new Error(`彩色字符“${String.fromCodePoint(cp)}”缺少第 ${i + 1} 个图层字形`);
                            layerClones.push(v5CloneScaledGlyph(glyph, null, ratio, `${baseClone.name}.color${i + 1}`));
                        }
                    }
                    const newIndex = installFontGlyph(targetObject, cp, baseClone, target.buffer); targetMap.set(cp, newIndex);
                    colorEntries = colorEntries.filter(e => e.baseGlyphId !== newIndex);
                    if (sourceEntry) {
                        const layerGlyphIds = layerClones.map(g => { const gid = targetObject.glyf.length; targetObject.glyf.push(g); return gid; });
                        const sourcePalette = sourceColor.cpal.palettes[0];
                        const paletteIndices = sourceEntry.paletteIndices.map(pi => {
                            if (pi === 0xFFFF) return pi;
                            const color = sourcePalette[pi]; if (!color) throw new Error(`彩色字符“${String.fromCodePoint(cp)}”引用了不存在的调色板颜色`);
                            return v5PaletteIndex(palette, color);
                        });
                        colorEntries.push({ baseGlyphId: newIndex, layerGlyphIds, paletteIndices });
                        copiedColor = true;
                    }
                    claimed.add(cp); existed ? replaced++ : added++;
                }
            }
            if (!replaced && !added) throw new Error('没有找到可替换的字符：请先输入字符，或勾选数字／语言');
            if (targetObject.glyf.length > 65535) throw new Error('字形数量超过 TTF 上限');
            let buffer = targetEditor.write({ type: 'ttf', hinting: true, kerning: true });
            buffer = appendTables(buffer, [{ tag: 'cmap', data: buildCmapTable(targetObject.glyf) }]);
            if (copiedColor) {
                // 原 base glyph 若仍映射其它码点就保留；只解绑了最后一个码点时才删掉旧 COLR 记录。
                colorEntries = colorEntries.filter(e => !targetColor?.entries.has(e.baseGlyphId) || (targetObject.glyf[e.baseGlyphId]?.unicode || []).length);
                buffer = appendTables(buffer, v5RawColorTables(target.buffer, new Set(['COLR', 'CPAL']), true));
                buffer = patchColrCpalTable(buffer, colorEntries, palette);
            } else {
                // fonteditor-core 不会写回彩色表；没迁入新彩图时把目标字体原表逐字节放回去。
                buffer = appendTables(buffer, v5RawColorTables(target.buffer, new Set(), true));
            }
            buffer = finalizeGeneratedFont(buffer, target.buffer);
            return { buffer, replaced, added, skipped };
        }
        async function executeFontReplacement(btn = null, ask = true, auto = false) {
            if (!state.replacementTarget) return alert('请先选择被替换字体');
            if (!state.replacementFonts.length) return alert('请至少添加一个替换字体');
            if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
            const targetAtStart = state.replacementTarget;
            const wasMain = targetAtStart.buffer === state.fontBuffer;
            const unlock = v5LockEditorForVfExport();
            try {
                const result = await v5BuildReplacedBuffer(state.replacementTarget, state.replacementFonts);
                if (state.replacementTarget !== targetAtStart) throw new Error('替换目标已更换，旧任务已停止');
                const nextBuffer = result.buffer.slice ? result.buffer.slice(0) : result.buffer;
                state.replacementTarget = { ...state.replacementTarget, buffer: nextBuffer, type: 'ttf', font: opentype.parse(nextBuffer), name: state.replacementTarget.name.replace(/\.otf$/i, '.ttf') };
                state.replacementDirty = false;
                renderReplacementTarget();
                logStatus(`${auto ? 'ℹ️ 导出前已自动应用字体替换' : '✅ 字体替换完成'}：替换 ${result.replaced} 个，新增 ${result.added} 个${result.skipped ? `，源字体缺少并跳过 ${result.skipped} 个` : ''}`, 'success');
                if (wasMain) v5ApplyMainFont(state.replacementTarget);
                else if (ask && confirm('字体替换完成。是否把这个被替换字体作为主页面导入字体？')) v5ApplyMainFont(state.replacementTarget, true);
                else if (auto && !wasMain) return false;
                return true;
            } catch (e) { alert(`字体替换失败：${e.message}`); logStatus(`❌ 字体替换失败：${e.message}`, 'error'); return false; }
            finally { unlock(); if (btn) { btn.disabled = false; btn.textContent = '执行字体替换'; } }
        }
        // 选好字体／字符但还没点“执行字体替换”时，下载与导出会先把替换补上，避免导出未替换的旧字体
        // 没有任何可命中的字符时不视为待办：直接放行，不能因为替换无事可做就让导出失败
        function v5ReplacementHasWork() {
            return state.replacementFonts.some(item => {
                const indexMap = item.font?.tables?.cmap?.glyphIndexMap || {};
                for (const cp of selectedReplacementCodePoints(item)) if (indexMap[cp] !== undefined) return true;
                return false;
            });
        }
        async function v5EnsureReplacementApplied() {
            if (!state.replacementDirty || !state.replacementTarget || !state.replacementFonts.length) return true;
            if (!v5ReplacementHasWork()) { logStatus('ℹ️ 没有可命中的替换字符，导出保持原样', 'info'); return true; }
            return await executeFontReplacement(null, true, true);
        }
        async function downloadReplacementTarget() {
            if (!state.replacementTarget) return alert('请先选择被替换字体');
            if (!(await v5EnsureReplacementApplied())) return;
            const target = state.replacementTarget;
            v5DownloadContext = target;
            try { downloadBuffer(target.buffer, `edited_${target.font?.familyName || 'font'}.ttf`, 'font/ttf'); }
            finally { v5DownloadContext = null; }
        }

        // 「字体间替换／字体内替换」两页切换（只在本板块内切换，别动「全局／指定」那组）
        function switchReplaceTab(btn, panelId) {
            const section = $('sectionReplace'); if (!section) return;
            section.querySelectorAll('.replace-tabs .replace-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
            section.querySelectorAll('.replace-tab-panel').forEach(p => p.classList.toggle('active', p.id === panelId));
        }
        // 已经真正执行过的互换：主页面/替换字体预览里不要再叠加一次（撤回后恢复预览）
        let v5SwapApplied = {};
        // 换掉主页面字体后，旧的那份「上一步」必须作废：否则撤回会静默退回旧字体，名字还张冠李戴
        function v5ResetMainSwapUndo(reason) {
            if (state.mainSwapUndo?.length) logStatus(`ℹ️ ${reason}，已作废上一份字体的「上一步」记录`, 'info');
            state.mainSwapUndo = []; delete v5SwapApplied['main'];
        }
        function v5SwapTargetKey(target) { return target?.item ? `item-${target.item.id}` : 'main'; }
        function v5SwapSignature(map) { return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([from, to]) => `${from}>${to}`).join(','); }

        function renderSwapFontOptions() {
            const select = $('swapFontSelect'); if (!select) return;
            const old = select.value;
            const main = state.font && state.fontBuffer ? `<option value="main">主页面字体（${v5Esc(state.fontName || '当前字体')}）</option>` : '';
            select.innerHTML = main + state.replacementFonts.map(item => `<option value="${item.id}">${v5Esc(item.name)}</option>`).join('');
            select.value = [...select.options].some(o => o.value === old) ? old : (select.options[0]?.value || '');
            renderSwapRows();
        }
        // 互换对象：默认主页面字体（value=main），也可选任意替换字体
        function v5MainSwapTarget() {
            return state.font && state.fontBuffer ? { isMain: true, buffer: state.fontBuffer, type: state.fontType || 'ttf', name: state.fontName } : null;
        }
        function v5SwapTargetRecord() {
            const value = $('swapFontSelect')?.value;
            if (!value) return null;
            if (value === 'main') return v5MainSwapTarget();
            const item = state.replacementFonts.find(x => x.id === Number(value));
            return item ? { item, buffer: item.buffer, type: item.type } : null;
        }
        function v5SwapTargetFont(target) { return target?.item ? target.item.font : state.font; }
        // 主页面预览里同步显示还没执行的互换效果（换的对象是主页面字体时作用在它的字形上）
        window.previewSwapChar = function(ch, sourceItem) {
            if (!v5SwapRows?.length) return ch;
            const target = v5SwapTargetRecord();
            if (!target) return ch;
            if (target.item ? target.item !== sourceItem : Boolean(sourceItem)) return ch;
            let map; try { map = v5SwapMapFromRows(v5SwapRows); } catch (_) { return ch; }
            if (v5SwapApplied[v5SwapTargetKey(target)] === v5SwapSignature(map)) return ch;
            return map.get(ch) || ch;
        };
        function renderSwapRows() {
            const host = $('swapRows'); if (!host) return;
            host.innerHTML = v5SwapRows.map((row, i) => `<div class="swap-row"><input value="${v5Esc(row.from)}" maxlength="2" aria-label="第${i + 1}行要修改的字符" oninput="updateSwapRow(${i},'from',this.value)"><span>→</span><input value="${v5Esc(row.to)}" maxlength="2" aria-label="第${i + 1}行替换图样字符" oninput="updateSwapRow(${i},'to',this.value)"><button class="btn btn-sm btn-outline" aria-label="删除第${i + 1}行" onclick="removeSwapRow(${i})">×</button></div>`).join('');
        }
        function updateSwapRow(index, key, value) { if (v5SwapRows[index]) v5SwapRows[index][key] = value; renderAll(); }
        function addSwapRow() { v5SwapRows.push({ from: '', to: '' }); renderSwapRows(); renderAll(); }
        function removeSwapRow(index) { v5SwapRows.splice(index, 1); if (!v5SwapRows.length) v5SwapRows.push({ from: '', to: '' }); renderSwapRows(); renderAll(); }
        function v5SwapMapFromRows(rows) {
            const map = new Map();
            for (const row of rows) {
                const from = singleCharacter(row.from), to = singleCharacter(row.to);
                if (!from && !to) continue;
                if (!from || !to) throw new Error('每一行左右都必须各填一个字符');
                if (map.has(from)) throw new Error(`字符“${from}”在左边重复了`);
                if (from !== to) map.set(from, to);
            }
            if (!map.size) throw new Error('请至少填写一组不同字符');
            return map;
        }
        // 只有“两个不同字符都指向同一个图样”才是真重复（如 a→c、b→c）；像 我爱你→爱你吗 这种
        // 换了之后和别的字图样相同，是改字效果的连带结果，不再弹窗拦人
        function v5SwapConflictGroups(map) {
            const byTarget = new Map();
            for (const [from, to] of map) { if (!byTarget.has(to)) byTarget.set(to, []); byTarget.get(to).push(from); }
            return [...byTarget.entries()].filter(([, froms]) => froms.length > 1);
        }
        function v5ConfirmSwapBalance(map) {
            const conflicts = v5SwapConflictGroups(map);
            if (!conflicts.length) return true;
            const detail = conflicts.map(([to, froms]) => `${froms.map(ch => `“${ch}”`).join('和')}都会变成“${to}”的图样`).join('，');
            return confirm(`执行后${detail}，确定要继续吗？`);
        }
        async function v5BuildSwappedBuffer(item, map) {
            if (v5SfntTags(item.buffer).has('fvar')) throw new Error('请先把可变字体固化为静态字体再互换');
            const core = await loadCore();
            const editor = core.createFont(item.buffer, { type: item.type, hinting: true, kerning: true });
            const object = editor.get(), glyphMap = v5GlyphMap(object);
            const color = parseColrCpalV0(item.buffer), unsupported = v5UnsupportedColorFormats(item.buffer, color);
            const sourceIndices = [...new Set([...map.values()].map(ch => glyphMap.get(ch.codePointAt(0))).filter(i => i !== undefined))];
            const missing = [...map.values()].filter(ch => !glyphMap.has(ch.codePointAt(0)));
            if (missing.length) throw new Error(`字体里没有这些字符：${[...new Set(missing)].join('、')}`);
            // 与替换链同口径：只有被交换的字符确实拿不到 COLR v0 记录时，位图彩表才会让它们变黑；
            // 字体里只是存在别的彩色格式（带位图字号的字体很常见）不该拦死整个互换。
            const uncovered = [...new Set(map.values())].filter(ch => color?.version !== 0 || !color.entries.has(glyphMap.get(ch.codePointAt(0))));
            if (uncovered.length && unsupported.length) throw new Error(`这个字体使用 ${unsupported.join('／')} 彩色格式，而这些字符的彩色拿不到 COLR 记录（${uncovered.join('、')}），互换后会变黑；已停止`);
            const compounds = sourceIndices.filter(i => object.glyf[i]?.compound);
            if (compounds.length) editor.getHelper().compound2simple(compounds);
            const snapshots = new Map([...new Set(map.values())].map(ch => [ch, v5CloneScaledGlyph(object.glyf[glyphMap.get(ch.codePointAt(0))], ch.codePointAt(0), 1)]));
            const sourceColorEntries = new Map([...new Set(map.values())].map(ch => [ch, color?.version === 0 ? color.entries.get(glyphMap.get(ch.codePointAt(0))) : null]));
            const newBaseIndices = new Map();
            const swappedColorLayers = new Map();
            for (const [ch, entry] of sourceColorEntries) if (entry) {
                const ids = entry.layerGlyphIds.map(lid => {
                    if (object.glyf[lid]?.compound) editor.getHelper().compound2simple([lid]);
                    const clone = v5CloneScaledGlyph(object.glyf[lid], null, 1);
                    const id = object.glyf.length; object.glyf.push(clone); return id;
                });
                swappedColorLayers.set(ch, ids);
            }
            for (const [targetChar, sourceChar] of map) {
                const cp = targetChar.codePointAt(0), existed = glyphMap.has(cp);
                const clone = v5CloneScaledGlyph(snapshots.get(sourceChar), cp, 1);
                const index = installFontGlyph(object, cp, clone, item.buffer); glyphMap.set(cp, index); newBaseIndices.set(targetChar, index);
                if (!existed) logStatus(`ℹ️ 字符“${targetChar}”原来不存在，已新增`, 'info');
            }
            if (object.glyf.length > 65535) throw new Error('字形数量超过 TTF 上限');
            let buffer = editor.write({ type: 'ttf', hinting: true, kerning: true });
            buffer = appendTables(buffer, [{ tag: 'cmap', data: buildCmapTable(object.glyf) }]);
            if (color?.version === 0) {
                const entries = [...color.entries.values()].filter(e => ![...newBaseIndices.values()].includes(e.baseGlyphId)).map(e => ({ ...e, layerGlyphIds: [...e.layerGlyphIds], paletteIndices: [...e.paletteIndices] }));
                for (const [targetChar, sourceChar] of map) {
                    const sourceEntry = sourceColorEntries.get(sourceChar); if (!sourceEntry) continue;
                    entries.push({ baseGlyphId: newBaseIndices.get(targetChar), layerGlyphIds: [...swappedColorLayers.get(sourceChar)], paletteIndices: [...sourceEntry.paletteIndices] });
                }
                if (entries.length) {
                    const cpal = readTableBytes(item.buffer, 'CPAL'); if (!cpal) throw new Error('这个彩色字体缺少 CPAL 调色板，已阻断互换');
                    buffer = appendTables(buffer, [{ tag: 'COLR', data: buildColrV0Table(entries) }, { tag: 'CPAL', data: cpal }]);
                }
            } else buffer = appendTables(buffer, v5RawColorTables(item.buffer, new Set(), true));
            return finalizeGeneratedFont(buffer, item.buffer);
        }
        async function v5CommitSwap(target, map) {
            if (!target) return false;
            if (!v5ConfirmSwapBalance(map)) return false;
            const previous = { buffer: target.buffer, type: target.type };
            const buffer = await v5BuildSwappedBuffer(target, map);
            // 先记上“这组关系已经真的换过了”，后面所有重绘（含 v5ApplyMainFont 里那次）才不会在预览里再叠一遍
            v5SwapApplied[v5SwapTargetKey(target)] = v5SwapSignature(map);
            const item = target.item;
            if (item) {
                item.undo ||= []; item.undo.push(previous);
                item.buffer = buffer.slice ? buffer.slice(0) : buffer; item.type = 'ttf'; item.font = opentype.parse(item.buffer);
                item._sourceCodePoints = null; item._selectedCodePoints = null; state.replacementDirty = true;
                renderReplacementFonts(); renderAll(); logStatus(`✅ “${item.name}”已完成 ${map.size} 个字符互换`, 'success');
            } else {
                state.mainSwapUndo ||= []; state.mainSwapUndo.push({ ...previous, name: target.name || state.fontName });
                const next = buffer.slice ? buffer.slice(0) : buffer;
                v5ApplyMainFont({ name: target.name || state.fontName, type: 'ttf', buffer: next, font: opentype.parse(next) });
                logStatus(`✅ 主页面字体已完成 ${map.size} 个字符互换`, 'success');
            }
            return true;
        }
        async function executeSwapRows() {
            const target = v5SwapTargetRecord(); if (!target) return alert('请先在主页面上导入字体，或添加一个替换字体');
            try { await v5CommitSwap(target, v5SwapMapFromRows(v5SwapRows)); }
            catch (e) { alert(`字符互换失败：${e.message}`); }
        }
        async function undoReplacementSwap(target = null) {
            target = target || v5SwapTargetRecord(); if (!target) return alert('请先在主页面上导入字体，或添加一个替换字体');
            const item = target.item, previous = (item ? item.undo : state.mainSwapUndo)?.pop();
            if (!previous) return alert('目前没有可以撤回的上一步');
            if (item) {
                item.buffer = previous.buffer; item.type = previous.type; item.font = opentype.parse(previous.buffer);
                item._sourceCodePoints = null; item._selectedCodePoints = null; state.replacementDirty = true;
                renderReplacementFonts();
                logStatus(`↩️ 已撤回“${item.name}”的上一步字符互换`, 'success');
            } else {
                // 名字取记录里那份，别用当前名字（导入新字体后撤回会张冠李戴）
                v5ApplyMainFont({ name: previous.name || target.name || state.fontName, type: previous.type || 'ttf', buffer: previous.buffer, font: opentype.parse(previous.buffer) });
                logStatus('↩️ 已撤回主页面字体的上一步字符互换', 'success');
            }
            delete v5SwapApplied[v5SwapTargetKey(target)];
            renderAll();
        }
        function openSwapQuickModal() {
            if (!v5SwapTargetRecord()) return alert('请先在主页面上导入字体，或添加一个替换字体');
            $('swapQuickFrom').value = ''; $('swapQuickTo').value = ''; renderSwapQuickPreview(); $('swapQuickModal').classList.add('active');
        }
        function closeSwapQuickModal() { $('swapQuickModal').classList.remove('active'); }
        function v5QuickSwapMap() {
            const from = v5Characters($('swapQuickFrom').value), to = v5Characters($('swapQuickTo').value);
            if (from.length !== to.length) throw new Error(`上下字符数量必须相同（现在是 ${from.length} 和 ${to.length}）`);
            return v5SwapMapFromRows(from.map((ch, i) => ({ from: ch, to: to[i] })));
        }
        function renderSwapQuickPreview() {
            const font = v5SwapTargetFont(v5SwapTargetRecord()); if (!font) return;
            const from = v5Characters($('swapQuickFrom')?.value || '');
            let map = null; try { map = v5QuickSwapMap(); } catch (_) { map = new Map(); }
            const text = from.join('') || 'abc';
            requestAnimationFrame(() => {
                v5DrawFontSample($('swapPreviewBefore'), font, text);
                v5DrawFontSample($('swapPreviewAfter'), font, text, map);
            });
        }
        async function executeSwapQuick() {
            const target = v5SwapTargetRecord(); if (!target) return alert('请先选择要操作的字体');
            // 一次互换成功就自己关窗；失败/没配平取消时保持打开，方便改完再来
            try { if (await v5CommitSwap(target, v5QuickSwapMap())) closeSwapQuickModal(); }
            catch (e) { alert(`字符互换失败：${e.message}`); }
        }

        function toggleBatchSpecific() {
            const panel = $('batchSpecificPanel'); panel.classList.toggle('active');
            $('batchSpecificToggle').textContent = panel.classList.contains('active') ? '收起批量调整' : '批量调整';
        }
        function v5SpecificControlValues() {
            return specificControlValues();
        }
        function applyBatchSpecific() {
            const chars = v5Characters($('batchSpecificChars').value); if (!chars.length) return alert('请在批量调整框里输入至少一个字符');
            const values = v5SpecificControlValues(); chars.forEach(ch => { state.specific[ch] = { ...values }; });
            renderAll(); logStatus(`✅ 已把当前调整应用到 ${chars.length} 个字符`, 'success');
        }
        function clearBatchSpecific() {
            const chars = v5Characters($('batchSpecificChars').value); if (!chars.length) return alert('请在批量调整框里输入至少一个字符');
            chars.forEach(ch => delete state.specific[ch]); renderAll(); logStatus(`✅ 已清除 ${chars.length} 个字符的指定调整`, 'success');
        }

        // 三大功能并排切换：一次只显示一个板块；每个板块内部的二级切换（全局/指定、字体间替换/字体内替换）照旧
        function switchMainTab(btn, panelId) {
            document.querySelectorAll('.main-tabs .main-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
            document.querySelectorAll('#majorSections > .main-tab-panel').forEach(p => p.classList.toggle('active', p.id === panelId));
        }

        const V5_EXPORT_NAME_KEY = 'fontEditorExportNameV5', V5_EXPORT_COUNTER_KEY = 'fontEditorExportCountersV5';
        const V5_EXPORT_DEFAULTS = { mode: 'default', fixedText: '', fixedPosition: 'prefix', variableType: 'number', emphasis: false, bracket: '【|】', customBefore: '', customAfter: '' };
        function v5LoadJSON(key, fallback) { try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch (_) { return { ...fallback }; } }
        let v5ExportName = v5LoadJSON(V5_EXPORT_NAME_KEY, V5_EXPORT_DEFAULTS);
        function v5Counters() { try { return JSON.parse(localStorage.getItem(V5_EXPORT_COUNTER_KEY) || '{}'); } catch (_) { return {}; } }
        function v5Letters(number) { let out = '', n = Math.max(1, number); while (n) { n--; out = String.fromCharCode(65 + n % 26) + out; n = Math.floor(n / 26); } return out; }
        function v5DateParts() { const d = new Date(), pad = n => String(n).padStart(2, '0'); return { date: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`, time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` }; }
        function v5SanitizeFilename(value) { return String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/[. ]+$/g, '').trim() || 'font'; }
        function v5ImportedBase(context) { const raw = context?.name || state.fontName || context?.font?.familyName || state.font?.familyName || 'font'; return v5SanitizeFilename(raw.replace(/\.(ttf|otf)$/i, '')); }
        function v5ExportCounterKey(settings, date) { return JSON.stringify([settings.fixedText, settings.fixedPosition, settings.variableType, settings.emphasis, settings.bracket, settings.customBefore, settings.customAfter, settings.variableType === 'dateNumber' ? date : '']); }
        function v5BuildExportFilename(originalFilename, context, commit = false, settings = v5ExportName) {
            if (settings.mode === 'default') return originalFilename || 'edited_font.ttf';
            const imported = v5ImportedBase(context);
            if (settings.mode === 'repair') return `${imported}（修）.ttf`;
            const dt = v5DateParts(), counters = v5Counters(), key = v5ExportCounterKey(settings, dt.date), next = (Number(counters[key]) || 0) + 1;
            let variable = settings.variableType === 'letters' ? v5Letters(next) : settings.variableType === 'dateNumber' ? `${dt.date}-${next}` : settings.variableType === 'timestamp' ? `${dt.date}-${dt.time}` : String(next);
            if (settings.emphasis) {
                const pair = settings.bracket === 'custom' ? [settings.customBefore || '', settings.customAfter || ''] : String(settings.bracket || '【|】').split('|');
                variable = `${pair[0] || ''}${variable}${pair[1] || ''}`;
            }
            const fixed = settings.fixedText || imported;
            const result = settings.fixedPosition === 'suffix' ? `${variable}${fixed}` : `${fixed}${variable}`;
            if (commit && settings.variableType !== 'timestamp') { counters[key] = next; try { localStorage.setItem(V5_EXPORT_COUNTER_KEY, JSON.stringify(counters)); } catch (_) {} }
            return `${v5SanitizeFilename(result)}.ttf`;
        }
        const v5BaseDownloadBuffer = window.downloadBuffer;
        window.downloadBuffer = function(buffer, filename, mime) {
            const finalName = mime === 'font/ttf' ? v5BuildExportFilename(filename, v5DownloadContext || { name: state.fontName, font: state.font }, true) : filename;
            return v5BaseDownloadBuffer(buffer, finalName, mime);
        };
        function openExportNameModal() {
            $('exportNameMode').value = v5ExportName.mode; $('exportFixedText').value = v5ExportName.fixedText; $('exportFixedPosition').value = v5ExportName.fixedPosition;
            $('exportVariableType').value = v5ExportName.variableType; $('exportEmphasis').checked = v5ExportName.emphasis; $('exportBracket').value = v5ExportName.bracket;
            $('exportCustomBefore').value = v5ExportName.customBefore; $('exportCustomAfter').value = v5ExportName.customAfter; updateExportNameUI(); $('exportNameModal').classList.add('active');
        }
        function closeExportNameModal() { $('exportNameModal').classList.remove('active'); }
        function v5ReadExportNameForm() { return { mode: $('exportNameMode').value, fixedText: $('exportFixedText').value, fixedPosition: $('exportFixedPosition').value, variableType: $('exportVariableType').value, emphasis: $('exportEmphasis').checked, bracket: $('exportBracket').value, customBefore: $('exportCustomBefore').value, customAfter: $('exportCustomAfter').value }; }
        function v5VariableSample(settings) {
            const dt = v5DateParts();
            return settings.variableType === 'letters' ? 'A' : settings.variableType === 'dateNumber' ? `${dt.date}-1` : settings.variableType === 'timestamp' ? `${dt.date}-${dt.time}` : '1';
        }
        function updateExportBracketLabels(settings) {
            const select = $('exportBracket'); if (!select) return;
            const sample = v5VariableSample(settings);
            Array.from(select.options).forEach(option => {
                const pair = String(option.value).split('|');
                option.textContent = option.value === 'custom' || pair.length < 2 ? '自定义' : `${pair[0]}${sample}${pair[1]}`;
            });
        }
        function updateExportNameUI() {
            const settings = v5ReadExportNameForm(), custom = settings.mode === 'custom';
            updateExportBracketLabels(settings);
            ['exportFixedText', 'exportFixedPosition', 'exportVariableType', 'exportEmphasis', 'exportBracket', 'exportCustomBefore', 'exportCustomAfter'].forEach(id => { $(id).disabled = !custom || ((id === 'exportBracket' || id.startsWith('exportCustom')) && !settings.emphasis) || (id.startsWith('exportCustom') && settings.bracket !== 'custom'); });
            $('exportCustomStyle').style.display = custom && settings.emphasis && settings.bracket === 'custom' ? 'grid' : 'none'; $('exportCustomStyleLabel').style.display = $('exportCustomStyle').style.display;
            previewExportName();
        }
        function previewExportName() { if (!$('exportNamePreview')) return; $('exportNamePreview').textContent = v5BuildExportFilename(`edited_${state.font?.familyName || 'font'}.ttf`, { name: state.fontName, font: state.font }, false, v5ReadExportNameForm()); }
        function saveExportNameSettings() { v5ExportName = v5ReadExportNameForm(); try { localStorage.setItem(V5_EXPORT_NAME_KEY, JSON.stringify(v5ExportName)); } catch (_) {} closeExportNameModal(); logStatus('✅ 自定义导出名称已保存', 'success'); }

        // ===== P1：字体内部名称面板 =====
        function fontInnerValues() {
            const family = $('fontInnerFamily').value.trim(), subfamily = $('fontInnerSubfamily').value.trim() || 'Regular';
            return { family, subfamily };
        }
        function previewFontInnerName() {
            const { family, subfamily } = fontInnerValues();
            const famAscii = String(family).replace(/[^A-Za-z0-9]/g, '');
            const ps = `${famAscii}-${String(subfamily).replace(/[^A-Za-z0-9]/g, '')}`.replace(/^-+|-+$/g, '');
            const psText = /[A-Za-z0-9]/.test(famAscii) ? ps.slice(0, 63) : '（原名不变：家族名里没有 ASCII，生成不出代号）';
            $('fontInnerPreview').textContent = family ? `${family} / ${subfamily} / 全名「${family} ${subfamily}」 / PostScript「${psText}」` : '（请先填写家族名）';
        }
        // 预填/预览一律读 name 表原文：opentype 的 font.names.* 在某些字体上返回对象或空，不能当字符串用
        function currentInnerNames() {
            const source = state.fontBuffer ? readTableBytes(state.fontBuffer, 'name') : null;
            const parsed = source ? parseNameTable(source) : null;
            const pick = (ids, pids) => {
                if (!parsed) return '';
                for (const id of ids) for (const [pid, lid] of pids) { const v = nameValue(parsed, id, pid, lid); if (v) return v; }
                return '';
            };
            return {
                family: pick([16, 1], [[3, 0x409], [3, 0x804], [1, 0]]),
                subfamily: pick([17, 2], [[3, 0x409], [3, 0x804], [1, 0]])
            };
        }
        function openFontNameModal() {
            if (!state.font) { alert('请先导入字体'); return; }
            const cur = currentInnerNames();
            $('fontInnerFamily').value = cur.family || String(state.fontName || '').replace(/\.(ttf|otf)$/i, '');
            $('fontInnerSubfamily').value = cur.subfamily || 'Regular';
            $('fontInnerNote').textContent = state.fontType === 'otf'
                ? '注意：这是 OTF/CFF 字体——本工具只改它的 name 表，CFF 内部自带的字体名不承诺同步（系统可能优先显示 CFF 里的名字）。'
                : '原有的其它语言与平台记录都会保留，只覆盖家族名/样式名相关的标准记录；导出后即生效。';
            previewFontInnerName();
            $('fontNameModal').classList.add('active');
        }
        function closeFontNameModal() { $('fontNameModal').classList.remove('active'); }
        function applyFontNameSettings() {
            const { family, subfamily } = fontInnerValues();
            if (!family) { alert('请先填写家族名'); return; }
            try {
                applyInternalName(family, subfamily);
                closeFontNameModal();
                logStatus(`✅ 字体内部名称已改为「${family}」／「${subfamily}」，之后导出的字体都用这个真名`, 'success');
            } catch (e) {
                logStatus(`❌ 改字体内部名称失败：${e.message}`, 'error');
                alert(`改字体内部名称失败：${e.message}`);
            }
        }

        function serializeFontReplacementConfig() {
            const target = state.replacementTarget;
            return {
                target: target ? (target.buffer === state.fontBuffer ? { useMain: true, name: target.name, type: target.type } : { name: target.name, type: target.type, data: arrayBufferToBase64(target.buffer) }) : null,
                fonts: state.replacementFonts.map(item => ({ name: item.name, type: item.type, data: arrayBufferToBase64(item.buffer), chars: item.chars || '', digits: !!item.digits, languages: item.languages || [], scriptFilter: item.scriptFilter, previewText: item.previewText || '' }))
            };
        }
        function v5NormalizeFontRecord(raw, label) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.data !== 'string' || !raw.data) throw new Error(`${label}格式错误`);
            let buffer, font; try { buffer = base64ToArrayBuffer(raw.data); font = opentype.parse(buffer); } catch (_) { throw new Error(`${label}无法解析`); }
            return { name: typeof raw.name === 'string' && raw.name ? raw.name : `${label}.ttf`, type: v5FontType(buffer, raw.name), buffer, font };
        }
        function normalizeFontReplacementConfig(raw) {
            if (raw === undefined || raw === null) return { target: null, fonts: [] };
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('字体替换配置格式错误');
            let target = null;
            if (raw.target) target = raw.target.useMain ? { useMain: true, name: raw.target.name, type: raw.target.type } : v5NormalizeFontRecord(raw.target, '被替换字体');
            if (raw.fonts !== undefined && !Array.isArray(raw.fonts)) throw new Error('替换字体列表格式错误');
            const fonts = (raw.fonts || []).map((entry, i) => ({ ...v5NormalizeFontRecord(entry, `第${i + 1}个替换字体`), chars: typeof entry.chars === 'string' ? entry.chars : '', digits: !!entry.digits, languages: Array.isArray(entry.languages) ? entry.languages.filter(x => V5_LANGUAGE_CODE_SET.has(x)) : [], scriptFilter: v5NormalizeScriptFilter(entry.scriptFilter), previewText: typeof entry.previewText === 'string' ? entry.previewText : '' }));
            return { target, fonts };
        }
        async function restoreFontReplacementConfig(config) {
            state.replacementFonts = []; state.replacementTarget = null;
            if (config?.target) state.replacementTarget = config.target.useMain && state.fontBuffer ? { name: state.fontName, type: state.fontType, buffer: state.fontBuffer, font: state.font } : config.target;
            for (const item of config?.fonts || []) v5AddReplacementRecord(item, item);
            state.replacementDirty = true;
            renderFontReplacementUI();
        }

        // ===== V5.2·P2 可变字体（VF）：按轴读取 → 固化成静态字体 =====
        // 读取器是内联的 fontkit（#vfSrc，首次用到才注入）；写盘复用既有 fonteditor-core 导出链。
        // 非可变字体一行都不碰：检测只看 sfnt 目录里有没有 fvar。
        const VF_AXIS_CN = { wght: '粗细', wdth: '字宽', slnt: '倾斜', ital: '斜体', opsz: '光学尺寸', GRAD: '浓淡', XOPQ: '横向笔画', YOPQ: '纵向笔画', YTLC: '小写高度', YTUC: '大写高度', YTAS: '上伸高度', YTDE: '下伸深度', YTFI: '数字高度', XTRA: '字怀宽度' };
        function v5SfntTags(buffer) {
            const tags = new Set();
            try {
                const a = new Uint8Array(buffer), dv = new DataView(a.buffer);
                if (a.length < 12) return tags;
                const n = dv.getUint16(4);
                for (let i = 0; i < n; i++) {
                    const o = 12 + i * 16;
                    if (o + 4 > a.length) break;
                    tags.add(String.fromCharCode(a[o], a[o + 1], a[o + 2], a[o + 3]));
                }
            } catch (_) {}
            return tags;
        }
        // 结构性阻断（P2 判据 ⑥⑦）：只放行「fvar + gvar」的 TTF 可变字体
        // 没有矢量轮廓的字体（位图彩色字体 CBDT/CBLC、苹果 sbix 等）在解析层就会失败，
        // 这里先按 sfnt 表判定并给出中文原因，不把字体库的英文报错甩给用户。判断不出来返回空串，交给解析层。
        function v5NoVectorOutlineReason(buffer) {
            const tags = v5SfntTags(buffer);
            if (!tags.size) return '';
            if ((tags.has('glyf') && tags.has('loca')) || tags.has('CFF ')) return '';
            if (tags.has('CFF2')) return '这个字体用的是 CFF2 轮廓（新版 .otf 常见），本工具还不支持，无法编辑。';
            if (tags.has('CBDT') || tags.has('CBLC') || tags.has('EBDT') || tags.has('EBLC')) return '这个字体是位图彩色字体：字形是图片、没有矢量轮廓，本工具只能编辑矢量字体，打不开它。';
            if (tags.has('sbix')) return '这个字体是位图彩色字体（苹果图片字形，没有矢量轮廓），本工具只能编辑矢量字体，打不开它。';
            return '这个字体里没有矢量轮廓表，本工具无法编辑它。';
        }
        function v5VfGate(tags) {
            if (!tags.has('fvar')) return { isVF: false, ok: true };
            if (!tags.has('gvar')) return { isVF: true, ok: false, reason: tags.has('CFF2')
                ? '这是 CFF2 轮廓的可变字体（.otf 里常见）：这条路径本工具还没验证过，为避免产出坏字体，暂不支持。'
                : '这个文件写着有可变轴（fvar），但没有真正的变化数据（gvar）——空壳可变字体，固化不了。' };
            return { isVF: true, ok: true };
        }
        let vfKitPromise = null;
        function loadVfKit() {
            if (window.VFFontkit) return Promise.resolve(window.VFFontkit.default ?? window.VFFontkit);
            if (vfKitPromise) return vfKitPromise;
            vfKitPromise = new Promise((resolve, reject) => {
                const src = $('vfSrc');
                if (!src) { reject(new Error('可变字体读取器没内联进来，请重新打开本页')); return; }
                const s = document.createElement('script');
                s.textContent = src.textContent;   // 同 fecSrc 的做法：用时才注入执行
                const done = () => window.VFFontkit ? resolve(window.VFFontkit.default ?? window.VFFontkit) : reject(new Error('可变字体读取器加载失败，请重新打开本页'));
                s.onload = s.onerror = done;
                document.head.appendChild(s);
                if (window.VFFontkit) done();
            });
            return vfKitPromise;
        }
        // getVariation 结果可复用（实测：调一次复用 2.9ms vs 每字形各调一次 12.5ms），按归一化坐标缓存
        function v5VfVariation(base, coords) {
            const key = Object.keys(coords).sort().map(t => t + '=' + coords[t]).join(',');
            const cache = base._vfCache || (base._vfCache = new Map());
            if (cache.has(key)) return cache.get(key);
            const vf = base.getVariation(coords);
            if (cache.size > 64) cache.clear();   // ponytail: 拖滑杆会产生很多 key，超 64 直接清空，够用
            cache.set(key, vf);
            return vf;
        }
        // 判据 ①②：gvar 里必须真的存在字形增量（假可变字体检测）
        // 不用「轴两端画出来一样」来判——稀疏变化的真 VF（例如只有 B 带增量、A/H/o 不变）会被误拦。
        // 直接看 gvar 的 glyphVariationDataOffsets：相邻两个偏移相等 = 该字形没增量；全体相等 = 假 VF。
        function v5VfAxisSanity(buffer) {
            const fake = { ok: false, reason: '这个字体记录了可变轴，但里面没有任何字形的变化数据——是“假可变字体”，固化没有意义，已停止。' };
            const t = readTableBytes(buffer, 'gvar');
            if (!t || t.length < 20) return fake;
            const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
            if (dv.getUint16(0) !== 1) return fake;                       // 只认 gvar 1.0
            const glyphCount = dv.getUint16(12), flags = dv.getUint16(14);
            const longOffsets = !!(flags & 1), size = longOffsets ? 4 : 2;
            if (20 + (glyphCount + 1) * size > t.byteLength) return fake;
            const off = i => longOffsets ? dv.getUint32(20 + i * 4) : dv.getUint16(20 + i * 2) * 2;
            for (let i = 0; i < glyphCount; i++) if (off(i + 1) !== off(i)) return { ok: true };
            return fake;
        }
        // 字体载入后调用：是可变字体就亮出入口并打开面板（openPanel=false 时只亮入口，用于配置恢复流程）
        async function v5VfAfterLoad(buffer, openPanel = true) {
            if (state.fontBuffer !== buffer) return;
            state.vfSource = null; state.vfStaticized = null;
            const btn = $('vfPanelBtn'); if (btn) btn.style.display = 'none';
            const gate = v5VfGate(v5SfntTags(buffer));
            if (!gate.isVF) return;
            if (!gate.ok) { logStatus(`⚠️ ${gate.reason}`, 'error'); alert(gate.reason); return; }
            try {
                const kit = await loadVfKit();
                if (state.fontBuffer !== buffer) return;
                const base = kit.create(new Uint8Array(buffer.slice(0)));
                const axes = base.variationAxes || {};
                if (!Object.keys(axes).length) throw new Error('读不到可变轴');
                const sanity = v5VfAxisSanity(buffer);
                if (!sanity.ok) { logStatus(`⚠️ ${sanity.reason}`, 'error'); alert(sanity.reason); return; }
                state.vfSource = { base, axes, instances: base.namedVariations || {}, sourceTables: v5VfTableSnapshot(buffer) };
                if (btn) btn.style.display = '';
                logStatus(`🎚️ 这是可变字体：${Object.keys(axes).length} 条轴、${Object.keys(state.vfSource.instances).length} 个命名实例。请先在顶栏「🎚️ 可变字体」里选好一档固化成静态字体，再编辑与导出。`, 'success');
                if (openPanel) openVfPanel();
            } catch (e) {
                if (state.fontBuffer !== buffer) return;
                state.vfSource = null;
                logStatus(`⚠️ 可变字体读取失败：${e.message}（已按普通字体继续）`, 'error');
            }
        }
        function openVfPanel() {
            if (!state.vfSource) { alert('当前字体不是可变字体：请导入带可变轴的 .ttf'); return; }
            const { axes, instances } = state.vfSource;
            $('vfInfo').textContent = `这个字体有 ${Object.keys(axes).length} 条可变轴、${Object.keys(instances).length} 个命名实例。拖滑杆，或直接选一个命名实例。`;
            // 只在这次载入后第一次打开时铺一次滑杆：重复打开不能把用户已经选好的那一档重置回默认
            if (!state.vfSource.uiBuilt) { v5VfRenderAxes(); v5VfRenderInstances(); state.vfSource.uiBuilt = true; }
            v5VfDrawPreview();
            $('vfPanelModal').classList.add('active');
        }
        function closeVfPanel() { $('vfPanelModal').classList.remove('active'); }
        function v5VfRenderAxes() {
            const axes = state.vfSource.axes;
            const host = $('vfAxisRows');
            host.replaceChildren();
            for (const tag of Object.keys(axes)) {
                const a = axes[tag], labelText = `${VF_AXIS_CN[tag] || a.name || tag}（${tag}）`;
                // step 必须 any：按 (max-min)/100 取步长会把坐标吸附到网格上（400→397、XOPQ 96→100），
                // 固化出来的就不是用户选的那一档。给范围滑杆自由度由 oninput 里的四舍五入兜住。
                const row = document.createElement('div');
                row.style.cssText = 'display:grid;grid-template-columns:120px 1fr 60px;gap:8px;align-items:center;margin:6px 0;';
                const label = document.createElement('label');
                const input = document.createElement('input');
                input.type = 'range'; input.id = 'vfAxis_' + tag;
                input.min = a.min; input.max = a.max; input.step = 'any'; input.value = a.default;
                label.htmlFor = input.id; label.title = labelText; label.textContent = labelText;
                input.addEventListener('input', () => v5VfOnAxis(tag));
                const value = document.createElement('span');
                value.id = 'vfAxisVal_' + tag; value.style.textAlign = 'right'; value.textContent = a.default;
                row.append(label, input, value); host.append(row);
            }
        }
        function v5VfRenderInstances() {
            const instances = state.vfSource.instances || {};
            const select = $('vfInstance');
            select.replaceChildren(new Option('（自定义轴位置）', ''));
            for (const name of Object.keys(instances)) select.add(new Option(name, name));
        }
        function v5VfOnAxis(tag) {
            const el = $('vfAxis_' + tag);
            const v = Math.round(Number(el.value) * 1000) / 1000;
            $('vfAxisVal_' + tag).textContent = v;
            $('vfInstance').value = '';
            v5VfDrawPreview();
        }
        function v5VfPickInstance() {
            const name = $('vfInstance').value;
            if (!name) return;
            const coords = (state.vfSource.instances || {})[name] || {}, axes = state.vfSource.axes;
            for (const tag of Object.keys(axes)) {
                const el = $('vfAxis_' + tag);
                if (!el) continue;
                const v = coords[tag] !== undefined ? coords[tag] : axes[tag].default;
                el.value = v; $('vfAxisVal_' + tag).textContent = v;
            }
            v5VfDrawPreview();
        }
        function v5VfCoords() {
            const axes = state.vfSource.axes, c = {};
            for (const tag of Object.keys(axes)) { const el = $('vfAxis_' + tag); c[tag] = el ? Number(el.value) : axes[tag].default; }
            return c;
        }
        function v5VfCoordsText(coords) { return Object.keys(coords).map(t => `${t}=${Math.round(coords[t] * 100) / 100}`).join(', '); }
        // fontkit 的 commands 是 y-up（画布 y-down，实测必须取反）、fill 必须 nonzero
        function v5VfPathToCtx(ctx, cmds, penX, baselineY, s) {
            for (const c of cmds) {
                const a = c.args, X = x => penX + s * x, Y = y => baselineY - s * y;
                if (c.command === 'moveTo') ctx.moveTo(X(a[0]), Y(a[1]));
                else if (c.command === 'lineTo') ctx.lineTo(X(a[0]), Y(a[1]));
                else if (c.command === 'quadraticCurveTo') ctx.quadraticCurveTo(X(a[0]), Y(a[1]), X(a[2]), Y(a[3]));
                else if (c.command === 'bezierCurveTo') ctx.bezierCurveTo(X(a[0]), Y(a[1]), X(a[2]), Y(a[3]), X(a[4]), Y(a[5]));
                else if (c.command === 'closePath') ctx.closePath();
            }
        }
        function v5VfDrawPreview() {
            const box = $('vfPreview'); if (!box || !state.vfSource) return;
            const dpr = Math.min(2, window.devicePixelRatio || 1), w = box.clientWidth || 600, h = 110;
            if (box.width !== Math.round(w * dpr)) { box.width = Math.round(w * dpr); box.height = Math.round(h * dpr); }
            const ctx = box.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#000';
            const base = state.vfSource.base;
            let vf; try { vf = v5VfVariation(base, v5VfCoords()); } catch (e) { return; }
            const s = (h * 0.62) / base.unitsPerEm, baseline = h * 0.8;
            let text = ((($('previewText') && $('previewText').value) || '字体预览 Aa 永')).split('\n')[0].slice(0, 40);
            // 这款字体没有预览文字里的字时（例如只有拉丁的 VF 配上中文预览文字），预览会全是方框、看不出轴的变化
            const realGlyph = ch => { const g = base.glyphForCodePoint(ch.codePointAt(0)); return !!(g && g.id); };
            if (![...text].some(ch => ch !== ' ' && realGlyph(ch))) text = 'AaBbGg 018 汉';   // ponytail: 固定样例，够看粗细/字宽
            let pen = 12;
            ctx.beginPath();
            for (const ch of text) {
                const g = base.glyphForCodePoint(ch.codePointAt(0));
                if (!g || g.id === undefined) continue;
                const vg = vf.getGlyph(g.id);
                v5VfPathToCtx(ctx, vg.path.commands, pen, baseline, s);
                pen += (vg.advanceWidth || 0) * s;
                if (pen > w - 6) break;
            }
            ctx.fill('nonzero');
        }
        // 使用 FontTools 同步实例化 gvar/HVAR/MVAR 与可变 GPOS；保留原布局与彩色表。
        async function v5VfSolidify(FeC, buffer, coords, note) {
            note('正在启动本地字体引擎…');
            const py = await loadVfCompiler();
            py.FS.writeFile('/static-source.ttf', new Uint8Array(buffer));
            py.globals.set('static_coords_json', JSON.stringify(coords));
            try {
                note('正在固化轮廓、度量和排版规则…');
                await py.runPythonAsync(`
import json
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
font = TTFont('/static-source.ttf', recalcTimestamp=False)
coords = json.loads(static_coords_json)
limits = {axis.axisTag: float(coords.get(axis.axisTag, axis.defaultValue)) for axis in font['fvar'].axes}
font = instantiateVariableFont(font, limits, inplace=True)
if 'DSIG' in font: del font['DSIG']
font.save('/static-output.ttf')
`);
                return validateGeneratedFont(py.FS.readFile('/static-output.ttf').slice().buffer);
            } finally {
                for (const file of ['/static-source.ttf','/static-output.ttf']) { try { py.FS.unlink(file); } catch (_) {} }
                py.globals.delete('static_coords_json');
            }
        }
        async function applyVfStaticize() {
            if (!state.vfSource) { closeVfPanel(); return; }
            const coords = v5VfCoords(), btn = $('vfApplyBtn');
            // 异步固化期间允许用户导入/恢复别的字体；提交前必须确认仍是同一份源状态，禁止旧任务覆盖新字体。
            const sourceBuffer = state.fontBuffer, sourceVf = state.vfSource;
            const note = msg => { $('vfProgress').textContent = msg; };
            const unlock = v5LockEditorForVfExport();
            btn.disabled = true;
            try {
                const FeC = await loadCore();
                const buffer = await v5VfSolidify(FeC, sourceBuffer, coords, note);
                note('正在校验…');
                await new Promise(r => setTimeout(r, 0));
                const tags = v5SfntTags(buffer);
                if (tags.has('fvar') || tags.has('gvar') || tags.has('HVAR')) throw new Error('固化结果里还残留可变表');
                const font = opentype.parse(buffer);
                if (!font || !(font.numGlyphs > 0)) throw new Error('固化结果无法解析');
                if (state.fontBuffer !== sourceBuffer || state.vfSource !== sourceVf) {
                    note('');
                    logStatus('ℹ️ 固化期间字体已更换，旧字体的固化结果已丢弃', 'info');
                    return;
                }
                state.fontBuffer = buffer; state.font = font; state.fontType = 'ttf';
                state.vfSource = null;
                state.vfStaticized = { coords: coords, from: state.fontName };
                $('vfPanelBtn').style.display = 'none';
                closeVfPanel();
                $('fontStatus').textContent = `✅ ${state.fontName}（已固化为一档静态字体）`;
                renderAll(); renderSwapFontOptions();
                v5ResetMainSwapUndo(uiText('已把可变字体固化成静态字体'));
                v5RefreshSpecificTargets();
                logStatus(`✅ 已按 ${v5VfCoordsText(coords)} 固化成普通静态字体并进入编辑；之后导出的字体不带可变轴`, 'success');
                alert('已固化成普通静态字体，现在可以正常编辑和导出了。\n（可变字体“可拖动变化”的能力在成品里已丢失）');
            } catch (e) {
                note('');
                logStatus(`❌ 固化失败：${e.message}（字体未改动）`, 'error');
                alert(`固化失败：${e.message}`);
            } finally { unlock(); btn.disabled = false; }
        }

        function v5InitFeatures() {
            renderFontReplacementUI(); renderSwapRows(); updateExportNameUI(); v5RefreshSpecificTargets(); toggleExportFormat();
            try { const badge = $('appVersionBadge'); if (badge && CHANGELOG[0]?.ver) badge.textContent = `${CHANGELOG[0].ver}（源码公开 · 个人免费 · 禁止倒卖）`; } catch (_) {}
            document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; ['languageModal', 'fontImportModal', 'swapQuickModal', 'exportNameModal', 'fontNameModal', 'scriptFilterModal', 'licenseModal', 'vfPanelModal'].forEach(id => $(id)?.classList.remove('active')); });
        }
        v5InitFeatures();
    

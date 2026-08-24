/**
 * Notability PDF v1.2 — bundled for mobile/iPad.
 *
 * Changes vs the CDN version:
 *  - pdf.js is bundled locally (no external <script>), so it passes Obsidian
 *    mobile's Content Security Policy and works offline.
 *  - The pdf.js worker is inlined as a blob URL (imported via `?raw`).
 *  - Canvases render at devicePixelRatio for sharp output on iPad Retina.
 *
 * Annotation model: strokes/highlights are stored in a `.nota.json` sidecar
 * next to the PDF (NOT written into the PDF itself), so they only render in
 * this view.
 */
import { Plugin, ItemView, Notice, TFile, Modal } from 'obsidian';
import * as pdfjsLib from 'pdfjs-dist';
// Importing the worker entry populates `window.pdfjsWorker.WorkerMessageHandler`.
// pdf.js uses that when it falls back to a "fake worker" (main-thread) on
// platforms where a real Web Worker can't be spawned from a blob URL — i.e.
// Obsidian mobile / iPad, whose CSP blocks blob workers. Without this, opening
// a PDF on iPad fails with "Setting up fake worker failed".
import 'pdfjs-dist/build/pdf.worker.entry';
import workerRaw from 'pdfjs-dist/build/pdf.worker.min.js?raw';

const VIEW_TYPE = 'notability-pdf';

function ensureWorker() {
    // Prefer a real Web Worker (desktop) for speed. pdf.js falls back to the
    // fake worker (mobile, via window.pdfjsWorker) automatically if the blob
    // worker is blocked — so this works on both desktop and iPad.
    if (pdfjsLib.GlobalWorkerOptions.workerSrc) return;
    try {
        pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
            new Blob([workerRaw as unknown as BlobPart], { type: 'text/javascript' })
        );
    } catch (e) {
        // Real worker unavailable; fake worker (window.pdfjsWorker) will be used.
    }
}

// ─── AnnoStore ─────────────────────────────────────────
class AnnoStore {
    pages: Record<number, any[]>;
    constructor() { this.pages = {}; }
    strokes(p: number) { return this.pages[p] || []; }
    setStrokes(p: number, arr: any[]) { this.pages[p] = arr; }
    add(p: number, s: any) { if (!this.pages[p]) this.pages[p] = []; this.pages[p].push(s); }
    clearPage(p: number) { this.pages[p] = []; }
    toJSON() { return JSON.stringify({ pages: this.pages, v: 2 }); }
    fromJSON(j: string) { try { const d = JSON.parse(j); this.pages = d.pages || {}; } catch (e) { this.pages = {}; } }
}

// ─── File Picker ───────────────────────────────────────
class PDFPickerModal extends Modal {
    files: TFile[];
    cb: (f: TFile) => void;
    constructor(app: any, files: TFile[], cb: (f: TFile) => void) {
        super(app);
        this.files = files;
        this.cb = cb;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: 'Select a PDF' });
        const list = contentEl.createDiv();
        list.style.cssText = 'max-height:300px;overflow-y:auto;margin-top:10px;';
        this.files.forEach((f) => {
            const row = list.createDiv();
            row.style.cssText = 'padding:6px 10px;cursor:pointer;border-radius:4px;margin:2px 0;';
            row.setText(f.path);
            row.addEventListener('click', () => { this.cb(f); this.close(); });
            row.onmouseenter = () => (row.style.background = 'var(--background-modifier-hover)');
            row.onmouseleave = () => (row.style.background = '');
        });
    }
    onClose() { this.contentEl.empty(); }
}

// ─── Notability View ───────────────────────────────────
class NotabilityView extends ItemView {
    plugin: NotabilityPlugin;
    pdfDoc: any = null;
    totalPages = 0;
    scale = 1.2;
    anno: AnnoStore;
    pdfFile: TFile | null = null;
    tool = 'pen';
    penColor = '#1a1a2e';
    penWidth = 2;
    hlColor = 'rgba(255,220,0,0.35)';
    hlWidth = 14;
    eraserW = 22;
    textHlColor = 'rgba(255,230,50,0.45)';
    drawing = false;
    curStroke: any = null;
    drawPage = 1;
    activePage = 1;
    pages: Record<number, any> = {};
    _rendering = false;
    _pending: TFile | null = null;
    _undos: Record<number, any[]> = {};
    _redos: Record<number, any[]> = {};

    viewer: HTMLElement | null = null;
    pageContainer: HTMLElement | null = null;
    statusBar: HTMLElement | null = null;
    zoomLbl: HTMLElement | null = null;
    penBtn: HTMLButtonElement | null = null;
    brushBtn: HTMLButtonElement | null = null;
    textHlBtn: HTMLButtonElement | null = null;
    eraBtn: HTMLButtonElement | null = null;
    _keyFn: ((evt: KeyboardEvent) => void) | null = null;
    _selHandler: (() => void) | null = null;
    _selTimer: any = null;

    constructor(leaf: any, plugin: NotabilityPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.anno = new AnnoStore();
    }

    getViewType() { return VIEW_TYPE; }
    getDisplayText() { return this.pdfFile ? 'Nota: ' + this.pdfFile.basename : 'Notability PDF'; }
    getIcon() { return 'edit-3'; }

    async onOpen() {
        const root = this.containerEl.children[1] as HTMLElement;
        root.empty();
        root.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;';

        this._toolbar(root);

        this.viewer = root.createDiv();
        this.viewer.style.cssText = 'flex:1;overflow-y:auto;overflow-x:hidden;background:#2a2a2a;';
        this.viewer.addEventListener('mouseup', () => this._onTextSelect());
        this._selHandler = () => { if (this.tool === 'text-hl' && !this.drawing) this._onTextSelect(); };
        document.addEventListener('selectionchange', this._selHandler);

        this.pageContainer = this.viewer.createDiv();
        this.pageContainer.style.cssText = 'display:flex;flex-direction:column;align-items:center;';

        this.statusBar = root.createDiv();
        this.statusBar.style.cssText = 'text-align:center;padding:4px;font-size:12px;color:#888;background:#1e1e1e;';
        this.statusBar.setText('Ready. Right-click a PDF → "Open in Notability"');

        this._keyFn = (evt: KeyboardEvent) => {
            if (this.app.workspace.activeLeaf?.view !== this) return;
            if (evt.ctrlKey && evt.key === 'z') { evt.preventDefault(); this.undo(); }
            if (evt.ctrlKey && evt.key === 'y') { evt.preventDefault(); this.redo(); }
            if (evt.ctrlKey && evt.key === 's') { evt.preventDefault(); this._save(); }
        };
        document.addEventListener('keydown', this._keyFn);

        if (this._pending) { await this.loadPDF(this._pending); this._pending = null; }
    }

    async onClose() {
        await this._save();
        if (this._keyFn) document.removeEventListener('keydown', this._keyFn);
        if (this._selHandler) document.removeEventListener('selectionchange', this._selHandler);
        this.pdfDoc = null;
        this.pages = {};
        if (this.pageContainer) this.pageContainer.empty();
    }

    // ─── Toolbar ─────────────────────────────────────────
    _toolbar(root: HTMLElement) {
        const bar = root.createDiv();
        bar.style.cssText = 'display:flex;align-items:center;gap:5px;padding:6px 10px;background:#1e1e1e;border-bottom:1px solid #333;flex-wrap:wrap;user-select:none;';

        const btn = (icon: string, title: string, cb: () => void, active?: boolean) => {
            const b = bar.createEl('button', { attr: { title } });
            b.innerHTML = icon; b.dataset.tool = title;
            b.style.cssText = 'background:transparent;border:1px solid #444;color:#ccc;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:14px;line-height:1;';
            b.onmouseenter = () => { if (b.style.background === 'transparent') b.style.background = '#333'; };
            b.onmouseleave = () => { this._refreshToolBtns(); };
            if (active) b.style.cssText += 'background:#3a3a7a;border-color:#5a5aaa;';
            b.addEventListener('click', () => { cb(); this._refreshToolBtns(); });
            return b;
        };

        this.penBtn = btn('✏️', 'pen', () => (this.tool = 'pen'), true);
        this.brushBtn = btn('🖊️', 'brush-hl', () => (this.tool = 'brush-hl'));
        this.textHlBtn = btn('🖍️', 'text-hl', () => (this.tool = 'text-hl'));

        const cp = bar.createEl('input', { attr: { type: 'color', value: this.penColor, title: 'Color' } });
        cp.style.cssText = 'width:22px;height:22px;border:1px solid #444;cursor:pointer;padding:0;background:transparent;border-radius:3px;';
        cp.oninput = (e) => (this.penColor = (e.target as HTMLInputElement).value);

        const sz = bar.createEl('input', { attr: { type: 'range', min: '1', max: '10', value: String(this.penWidth), title: 'Size' } });
        sz.style.cssText = 'width:50px;';
        sz.oninput = (e) => (this.penWidth = parseInt((e.target as HTMLInputElement).value));

        this._sep(bar);
        this.eraBtn = btn('🧹', 'eraser', () => (this.tool = 'eraser'));
        btn('↩️', 'Undo (Ctrl+Z)', () => this.undo());
        btn('↪️', 'Redo (Ctrl+Y)', () => this.redo());
        btn('🗑️', 'Clear page', () => {
            this.anno.clearPage(this.activePage);
            const p = this.pages[this.activePage];
            if (p) this._redrawPage(p);
        });

        this._sep(bar);
        bar.createEl('span', { attr: { style: 'flex:1;' } });
        btn('🔍−', 'Zoom out', () => { this.scale = Math.max(0.5, this.scale - 0.2); this._renderAll(); });
        this.zoomLbl = bar.createEl('span', { text: Math.round(this.scale * 100) + '%' });
        this.zoomLbl.style.cssText = 'color:#aaa;font-size:12px;min-width:36px;text-align:center;';
        btn('🔍+', 'Zoom in', () => { this.scale = Math.min(3, this.scale + 0.2); this._renderAll(); });
        btn('💾', 'Save (Ctrl+S)', () => this._save());
    }
    _sep(bar: HTMLElement) {
        const s = bar.createEl('span');
        s.style.cssText = 'width:1px;height:18px;background:#444;margin:0 3px;';
    }

    _refreshToolBtns() {
        const a = (btn: HTMLButtonElement | null, on: boolean) => {
            if (!btn) return;
            btn.style.background = on ? '#3a3a7a' : 'transparent';
            btn.style.borderColor = on ? '#5a5aaa' : '#444';
        };
        a(this.penBtn, this.tool === 'pen');
        a(this.brushBtn, this.tool === 'brush-hl');
        a(this.textHlBtn, this.tool === 'text-hl');
        a(this.eraBtn, this.tool === 'eraser');

        const isTextMode = this.tool === 'text-hl';
        Object.values(this.pages).forEach((pg) => {
            if (pg.textLayer) {
                pg.textLayer.style.pointerEvents = isTextMode ? 'auto' : 'none';
                pg.textLayer.style.userSelect = isTextMode ? 'text' : 'none';
                pg.textLayer.style.zIndex = isTextMode ? '3' : '1';
            }
            pg.annoCanvas.style.pointerEvents = isTextMode ? 'none' : 'auto';
            pg.annoCanvas.style.cursor = isTextMode ? 'text' : this.tool === 'eraser' ? 'cell' : 'crosshair';
            pg.annoCanvas.style.zIndex = '2';
        });
    }

    // ─── PDF load + render ───────────────────────────────
    async loadPDF(file: TFile) {
        try {
            this.pdfFile = file;
            if (!this.viewer) { this._pending = file; return; }
            new Notice('Loading: ' + file.basename);
            ensureWorker();
            const buf = await this.app.vault.readBinary(file);
            this.pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
            this.totalPages = this.pdfDoc.numPages;
            await this._loadAnno();
            await this._renderAll();
            this.statusBar?.setText(file.basename + ' — ' + this.totalPages + ' p — scroll | ' + (this.tool === 'text-hl' ? 'select text to highlight' : 'draw with pen'));
        } catch (err: any) {
            console.error('Nota:', err);
            new Notice('Failed: ' + (err?.message || err));
        }
    }

    async _renderAll() {
        if (!this.pdfDoc || this._rendering) return;
        this._rendering = true;
        this.pageContainer?.empty();
        this.pages = {};
        this.zoomLbl?.setText(Math.round(this.scale * 100) + '%');
        for (let i = 1; i <= this.totalPages; i++) {
            await this._renderPage(i);
        }
        this._refreshToolBtns();
        this._rendering = false;
    }

    async _renderPage(num: number) {
        try {
            const page = await this.pdfDoc.getPage(num);
            const dpr = window.devicePixelRatio || 1;
            const vp = page.getViewport({ scale: this.scale });                 // CSS-pixel viewport (text layer)
            const w = Math.floor(vp.width), h = Math.floor(vp.height);
            const vpRender = page.getViewport({ scale: this.scale * dpr });      // physical-pixel viewport (canvas)
            const cw = Math.floor(vpRender.width), ch = Math.floor(vpRender.height);

            const wrap = this.pageContainer!.createDiv();
            wrap.style.cssText = `position:relative;margin:5px 0;width:${w}px;height:${h}px;`;

            // PDF canvas (z=0)
            const pdfCanvas = wrap.createEl('canvas');
            pdfCanvas.width = cw; pdfCanvas.height = ch;
            pdfCanvas.style.cssText = `display:block;width:${w}px;height:${h}px;`;
            const pctx = pdfCanvas.getContext('2d')!;
            await page.render({ canvasContext: pctx, viewport: vpRender }).promise;

            // Text layer (z=1, for text selection highlight)
            const textLayer = await this._buildTextLayer(page, vp, wrap, w, h);

            // Annotation canvas (z=2, for handwriting)
            const annoCanvas = wrap.createEl('canvas');
            annoCanvas.width = cw; annoCanvas.height = ch;
            annoCanvas.style.cssText = `position:absolute;top:0;left:0;width:${w}px;height:${h}px;touch-action:none;z-index:2;`;
            const actx = annoCanvas.getContext('2d')!;
            actx.scale(dpr, dpr);

            const pg = { wrap, pdfCanvas, annoCanvas, actx, textLayer, num, w, h, dpr, rendered: true };
            this.pages[num] = pg;
            this._bindPage(pg);
            this._redrawPage(pg);
        } catch (err) {
            console.error('Nota: render page ' + num, err);
        }
    }

    async _buildTextLayer(page: any, viewport: any, wrap: HTMLElement, w: number, h: number) {
        const layer = wrap.createDiv({ cls: 'nota-text-layer' });
        layer.style.cssText = `position:absolute;top:0;left:0;width:${w}px;height:${h}px;z-index:1;overflow:hidden;pointer-events:none;user-select:none;`;

        try {
            const tc = await page.getTextContent();

            for (const item of tc.items) {
                if (!item.str || !item.str.trim()) continue;

                const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
                const fontSize = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
                if (fontSize < 1) continue;
                const ascent = item.ascent || 0.85;

                const span = layer.createEl('span');
                span.setText(item.str);
                span.style.cssText =
                    'position:absolute;' +
                    'left:' + Math.round(tx[4]) + 'px;' +
                    'top:' + Math.round(tx[5] - fontSize * ascent) + 'px;' +
                    'font-size:' + Math.round(fontSize) + 'px;' +
                    'font-family:serif;' +
                    'line-height:1;' +
                    'white-space:pre;' +
                    'color:transparent;';
            }
        } catch (e) {
            console.error('Nota: text layer error p' + page.pageNumber, e);
        }
        return layer;
    }

    // ─── Text selection highlight ────────────────────────
    _onTextSelect() {
        if (this.tool !== 'text-hl') return;
        if (this._selTimer) clearTimeout(this._selTimer);
        this._selTimer = setTimeout(() => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || !sel.rangeCount) return;

            const anchorNode = sel.anchorNode;
            let pageNum = 0;
            for (const [num, pg] of Object.entries(this.pages)) {
                if (pg.textLayer && pg.textLayer.contains(anchorNode)) {
                    pageNum = parseInt(num);
                    break;
                }
            }
            if (!pageNum) return;

            const pg = this.pages[pageNum];
            const rect = pg.annoCanvas.getBoundingClientRect();
            const annoRects: any[] = [];

            for (let i = 0; i < sel.rangeCount; i++) {
                const range = sel.getRangeAt(i);
                const rects = range.getClientRects();
                for (let j = 0; j < rects.length; j++) {
                    const r = rects[j];
                    const x = r.left - rect.left;
                    const y = r.top - rect.top;
                    const w = r.width;
                    const h = r.height;
                    if (w > 0 && h > 0) {
                        annoRects.push({ x, y, w, h });
                    }
                }
            }

            if (annoRects.length === 0) return;

            const hl = { type: 'text-hl', color: this.textHlColor, rects: annoRects };
            this.anno.add(pageNum, hl);
            if (!this._undos[pageNum]) this._undos[pageNum] = [];
            this._undos[pageNum].push(hl);
            if (this._redos[pageNum]) this._redos[pageNum] = [];

            this._redrawPage(pg);
            this.activePage = pageNum;
            sel.removeAllRanges();
        }, 200);
    }

    // ─── Drawing per-page ────────────────────────────────
    _bindPage(pg: any) {
        const c = pg.annoCanvas;
        const down = (e: PointerEvent) => { if (this.tool !== 'text-hl') this._down(e, pg); };
        const move = (e: PointerEvent) => { if (this.tool !== 'text-hl') this._move(e, pg); };
        const up = (e: PointerEvent) => { if (this.tool !== 'text-hl') this._up(e, pg); };
        c.addEventListener('pointerdown', down);
        c.addEventListener('pointermove', move);
        c.addEventListener('pointerup', up);
        c.addEventListener('pointerleave', up);
        c.addEventListener('pointercancel', up);
    }

    _pos(e: PointerEvent, pg: any) {
        const r = pg.annoCanvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || 0.5 };
    }

    _down(e: PointerEvent, pg: any) {
        this.drawing = true; this.drawPage = pg.num; this.activePage = pg.num;
        this.curStroke = {
            type: 'stroke',
            tool: this.tool,
            color: this.tool === 'brush-hl' ? this.hlColor : this.penColor,
            width: this.tool === 'brush-hl' ? this.hlWidth : this.tool === 'eraser' ? this.eraserW : this.penWidth,
            points: [this._pos(e, pg)]
        };
        pg.annoCanvas.setPointerCapture(e.pointerId);
    }

    _move(e: PointerEvent, pg: any) {
        if (!this.drawing || !this.curStroke) return;
        this.curStroke.points.push(this._pos(e, pg));
        this._drawLive(this.curStroke, pg.actx);
    }

    _up(e: PointerEvent, pg: any) {
        if (!this.drawing) return;
        this.drawing = false;
        if (this.curStroke && this.curStroke.points.length > 0) {
            const p = this.drawPage;
            this.anno.add(p, this.curStroke);
            if (!this._undos[p]) this._undos[p] = [];
            this._undos[p].push(this.curStroke);
            if (this._redos[p]) this._redos[p] = [];
        }
        this.curStroke = null;
        this._redrawPage(pg);
    }

    _drawLive(s: any, ctx: CanvasRenderingContext2D) {
        if (s.points.length < 2) return;
        ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        if (s.tool === 'eraser') {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = 'rgba(0,0,0,1)';
        } else if (s.tool === 'brush-hl') {
            ctx.globalCompositeOperation = 'multiply';
            ctx.strokeStyle = s.color;
        } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = s.color;
        }
        const last = s.points[s.points.length - 1];
        ctx.lineWidth = s.width * (0.6 + last.p * 0.8);
        ctx.beginPath();
        ctx.moveTo(s.points[s.points.length - 2].x, s.points[s.points.length - 2].y);
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
        ctx.restore();
    }

    _redrawPage(pg: any) {
        const ctx = pg.actx as CanvasRenderingContext2D;
        // Reset transform to identity to clear the whole physical canvas, then
        // restore the DPR scale before drawing strokes (in CSS px).
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, pg.annoCanvas.width, pg.annoCanvas.height);
        ctx.restore();

        for (const s of this.anno.strokes(pg.num)) {
            if (s.type === 'text-hl') this._drawHlRects(s, ctx);
            else this._drawStroke(s, ctx);
        }
    }

    _drawHlRects(hl: any, ctx: CanvasRenderingContext2D) {
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = hl.color;
        for (const r of hl.rects) {
            ctx.fillRect(r.x, r.y, r.w, r.h);
        }
        ctx.restore();
    }

    _drawStroke(s: any, ctx: CanvasRenderingContext2D) {
        if (s.points.length < 1) return;
        ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        if (s.tool === 'eraser') {
            ctx.globalCompositeOperation = 'destination-out';
            for (const pt of s.points) { ctx.beginPath(); ctx.arc(pt.x, pt.y, s.width / 2, 0, Math.PI * 2); ctx.fill(); }
        } else {
            ctx.globalCompositeOperation = s.tool === 'brush-hl' ? 'multiply' : 'source-over';
            ctx.strokeStyle = s.color;
            ctx.beginPath(); ctx.moveTo(s.points[0].x, s.points[0].y);
            for (let i = 1; i < s.points.length - 1; i++) {
                const mx = (s.points[i].x + s.points[i + 1].x) / 2;
                const my = (s.points[i].y + s.points[i + 1].y) / 2;
                ctx.lineWidth = s.width * (0.6 + (s.points[i].p || 0.5) * 0.8);
                ctx.quadraticCurveTo(s.points[i].x, s.points[i].y, mx, my);
            }
            const last = s.points[s.points.length - 1];
            ctx.lineWidth = s.width * (0.6 + (last.p || 0.5) * 0.8);
            ctx.lineTo(last.x, last.y);
            ctx.stroke();
        }
        ctx.restore();
    }

    // ─── Undo/Redo ───────────────────────────────────────
    undo() {
        const p = this.activePage;
        const stack = this._undos[p];
        if (!stack || !stack.length) return;
        if (!this._redos[p]) this._redos[p] = [];
        this._redos[p].push(stack.pop()!);
        this.anno.setStrokes(p, [...stack]);
        const pg = this.pages[p];
        if (pg) this._redrawPage(pg);
    }
    redo() {
        const p = this.activePage;
        const stack = this._redos[p];
        if (!stack || !stack.length) return;
        this._undos[p].push(stack.pop()!);
        this.anno.setStrokes(p, [...this._undos[p]]);
        const pg = this.pages[p];
        if (pg) this._redrawPage(pg);
    }

    // ─── Persistence ─────────────────────────────────────
    _annoPath() { return this.pdfFile ? this.pdfFile.path.replace(/\.pdf$/i, '.nota.json') : null; }
    async _save() {
        if (!this.pdfFile) return;
        try {
            const json = this.anno.toJSON();
            const path = this._annoPath();
            const f = this.app.vault.getAbstractFileByPath(path!);
            if (f) await this.app.vault.modify(f, json);
            else await this.app.vault.create(path!, json);
        } catch (err) { console.error('Nota save:', err); }
    }
    async _loadAnno() {
        if (!this.pdfFile) return;
        try {
            const path = this._annoPath();
            const f = this.app.vault.getAbstractFileByPath(path!);
            if (f) { const c = await this.app.vault.read(f); this.anno.fromJSON(c); }
        } catch (e) { /* ignore */ }
    }
}

// ─── Plugin ───────────────────────────────────────────
export default class NotabilityPlugin extends Plugin {
    async onload() {
        console.log('Notability PDF v1.2.1 loaded');
        this.registerView(VIEW_TYPE, (leaf) => new NotabilityView(leaf, this));

        this.addCommand({
            id: 'open-pdf',
            name: 'Open PDF in Notability',
            checkCallback: (checking: boolean) => {
                const f = this.app.workspace.getActiveFile();
                if (f && f.extension === 'pdf') { if (!checking) this._open(f); return true; }
                return false;
            }
        });
        this.addCommand({
            id: 'open-pdf-pick',
            name: 'Open any PDF in Notability',
            callback: () => {
                const files = this.app.vault.getFiles().filter((f) => f.extension === 'pdf');
                if (!files.length) { new Notice('No PDFs'); return; }
                if (files.length === 1) { this._open(files[0]); return; }
                new PDFPickerModal(this.app, files, (f) => this._open(f)).open();
            }
        });
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu: any, file: any) => {
                if (file instanceof TFile && file.extension === 'pdf')
                    menu.addItem((item: any) => item.setTitle('Open in Notability').setIcon('edit-3').onClick(() => this._open(file)));
            })
        );
        this.addRibbonIcon('edit-3', 'Notability PDF', () => {
            const files = this.app.vault.getFiles().filter((f) => f.extension === 'pdf');
            if (files.length > 0) this._open(files[0]);
            else new Notice('No PDFs');
        });
    }
    onunload() { console.log('Notability PDF unloaded'); }
    async _open(file: TFile) {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        let leaf: any;
        if (leaves.length > 0) { leaf = leaves[0]; this.app.workspace.revealLeaf(leaf); }
        else { leaf = this.app.workspace.getLeaf('split'); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
        if (leaf.view instanceof NotabilityView) await leaf.view.loadPDF(file);
    }
}

const TourGuide = (() => {
    const STEPS = [
        {
            target: null,
            title: '歡迎使用相本書編輯器 📖',
            body: '這個導覽將帶你認識所有主要功能。點「下一步」開始，或「略過」直接使用。',
            position: 'center'
        },
        {
            target: '#libraryGrid',
            title: '右欄：資料夾素材庫',
            body: '點擊資料夾展開照片。點了資料夾後，照片會出現在下方橫列。可用星數篩選。',
            position: 'left'
        },
        {
            target: '#photoStrip',
            title: '照片橫列',
            body: '選擇資料夾後，照片會顯示在這裡。直接拖曳照片到中間的格子，或點擊格子再點照片放入。',
            position: 'top'
        },
        {
            target: '#pagePreviewArea',
            title: '中欄：頁面預覽',
            body: '點擊格子選照片。有照片時，按住滑鼠拖移可平移裁切，滾輪可縮放。點右上角 × 清除照片。',
            position: 'right'
        },
        {
            target: '#layoutGrid',
            title: '右欄：版型選擇',
            body: '選擇目前頁面的排版方式：全出血、單張留白、左右兩張、三格、四格等，共 7 種版型。',
            position: 'left'
        },
        {
            target: '#runAutoLayoutTopBtn',
            title: '✨ 自動排版',
            body: '一鍵依照照片方向與評分自動分配版型。5 星照片獨立一頁；橫直混搭自動套用最佳版型。',
            position: 'bottom'
        },
        {
            target: '#slotEditBtn',
            title: '⊡ 調整版面',
            body: '進入版面調整模式：拖移格子改變位置，拖角落控點調整大小。按 ESC 或「完成」退出。',
            position: 'bottom'
        },
        {
            target: '#shareBtn',
            title: '☁ 分享給客人',
            body: '產生客人專屬網址，讓客人可以在自己的裝置上調整裁切、選照片，再由你確認。',
            position: 'bottom'
        },
        {
            target: '#exportBtn',
            title: '⬇ 匯出 JPG',
            body: '將所有頁面依設定的 DPI 渲染成高解析度 JPG，打包成 ZIP 下載。封面與內頁可設定不同尺寸。',
            position: 'bottom'
        }
    ];

    let currentStep = 0;
    let overlay = null;
    let card = null;
    let spotlight = null;

    function _build() {
        if (overlay) return;

        overlay = document.createElement('div');
        overlay.id = 'tourOverlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;pointer-events:none;';

        spotlight = document.createElement('div');
        spotlight.id = 'tourSpotlight';
        spotlight.style.cssText = `
            position:fixed;z-index:9001;pointer-events:none;
            border-radius:6px;transition:all 0.3s cubic-bezier(.4,0,.2,1);
            box-shadow:0 0 0 9999px rgba(0,0,0,0.65);
        `;

        card = document.createElement('div');
        card.id = 'tourCard';
        card.style.cssText = `
            position:fixed;z-index:9002;
            background:#1e1e2e;border:1px solid rgba(255,255,255,0.12);
            border-radius:12px;padding:20px 22px;width:300px;
            box-shadow:0 12px 40px rgba(0,0,0,0.6);
            transition:all 0.25s ease;
            font-family:Inter,sans-serif;color:#e0e0e0;
        `;

        document.body.appendChild(overlay);
        document.body.appendChild(spotlight);
        document.body.appendChild(card);

        document.addEventListener('keydown', _keyHandler);
    }

    function _keyHandler(e) {
        if (!overlay) return;
        if (e.key === 'Escape') { end(); return; }
        if (e.key === 'ArrowRight' || e.key === 'Enter') { next(); return; }
        if (e.key === 'ArrowLeft') { prev(); return; }
    }

    function _positionCard(rect, position) {
        const W = window.innerWidth, H = window.innerHeight;
        const cW = 300, cH = card.offsetHeight || 200;
        const gap = 16;
        let top, left;

        if (position === 'center' || !rect) {
            top = (H - cH) / 2;
            left = (W - cW) / 2;
        } else if (position === 'bottom') {
            top = rect.bottom + gap;
            left = rect.left + (rect.width - cW) / 2;
        } else if (position === 'top') {
            top = rect.top - cH - gap;
            left = rect.left + (rect.width - cW) / 2;
        } else if (position === 'left') {
            top = rect.top + (rect.height - cH) / 2;
            left = rect.left - cW - gap;
        } else if (position === 'right') {
            top = rect.top + (rect.height - cH) / 2;
            left = rect.right + gap;
        }

        top = Math.max(12, Math.min(H - cH - 12, top));
        left = Math.max(12, Math.min(W - cW - 12, left));
        card.style.top = top + 'px';
        card.style.left = left + 'px';
    }

    function _renderCard(step) {
        const dots = STEPS.map((_, i) =>
            `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${i === currentStep ? '#f38020' : 'rgba(255,255,255,0.25)'};margin:0 3px;transition:background 0.2s;"></span>`
        ).join('');

        card.innerHTML = `
            <div style="font-size:0.7rem;color:#9fa8da;margin-bottom:8px;letter-spacing:0.06em;">${currentStep + 1} / ${STEPS.length}</div>
            <div style="font-size:1rem;font-weight:600;color:#fff;margin-bottom:10px;line-height:1.4;">${step.title}</div>
            <div style="font-size:0.85rem;line-height:1.6;color:#c5c8d1;margin-bottom:18px;">${step.body}</div>
            <div style="display:flex;align-items:center;justify-content:space-between;">
                <div>${dots}</div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <button id="tourSkipBtn" style="background:none;border:none;color:#9fa8da;font-size:0.8rem;cursor:pointer;padding:4px 8px;">略過</button>
                    ${currentStep > 0 ? '<button id="tourPrevBtn" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#e0e0e0;font-size:0.82rem;cursor:pointer;padding:5px 14px;border-radius:6px;">← 上一步</button>' : ''}
                    <button id="tourNextBtn" style="background:#f38020;border:none;color:#fff;font-size:0.84rem;font-weight:600;cursor:pointer;padding:6px 18px;border-radius:6px;">
                        ${currentStep === STEPS.length - 1 ? '完成 ✓' : '下一步 →'}
                    </button>
                </div>
            </div>
        `;

        card.querySelector('#tourSkipBtn').addEventListener('click', end);
        const prevBtn = card.querySelector('#tourPrevBtn');
        if (prevBtn) prevBtn.addEventListener('click', prev);
        card.querySelector('#tourNextBtn').addEventListener('click', next);
    }

    function show(idx) {
        currentStep = Math.max(0, Math.min(STEPS.length - 1, idx));
        const step = STEPS[currentStep];

        const targetEl = step.target ? document.querySelector(step.target) : null;

        if (targetEl) {
            const r = targetEl.getBoundingClientRect();
            const pad = 6;
            spotlight.style.display = 'block';
            spotlight.style.top = (r.top - pad) + 'px';
            spotlight.style.left = (r.left - pad) + 'px';
            spotlight.style.width = (r.width + pad * 2) + 'px';
            spotlight.style.height = (r.height + pad * 2) + 'px';
            spotlight.style.pointerEvents = 'none';
            overlay.style.pointerEvents = 'auto';
        } else {
            spotlight.style.display = 'none';
            spotlight.style.top = '50%';
            spotlight.style.left = '50%';
            spotlight.style.width = '0px';
            spotlight.style.height = '0px';
        }

        _renderCard(step);
        requestAnimationFrame(() => {
            const rect = targetEl ? targetEl.getBoundingClientRect() : null;
            _positionCard(rect, step.position);
        });
    }

    function next() {
        if (currentStep >= STEPS.length - 1) { end(); return; }
        show(currentStep + 1);
    }

    function prev() {
        if (currentStep <= 0) return;
        show(currentStep - 1);
    }

    function start(fromStep = 0) {
        _build();
        overlay.style.display = 'block';
        spotlight.style.display = 'block';
        card.style.display = 'block';
        show(fromStep);
    }

    function end() {
        if (overlay) overlay.style.display = 'none';
        if (spotlight) spotlight.style.display = 'none';
        if (card) card.style.display = 'none';
        document.removeEventListener('keydown', _keyHandler);
        overlay = null; spotlight = null; card = null;
        localStorage.setItem('book_editor_tour_done', '1');
    }

    return { start, next, prev, end };
})();

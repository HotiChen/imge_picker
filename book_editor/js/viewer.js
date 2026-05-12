const Viewer = {
    book: null,
    currentPageIndex: 0,
    bookId: null,

    async init() {
        const params = new URLSearchParams(location.search);
        this.bookId = params.get('id');
        if (!this.bookId) {
            this._setError('無效的分享連結');
            return;
        }
        await this.loadBook();
        this.bindEvents();
    },

    async loadBook() {
        try {
            const r = await fetch(`${CONFIG.WORKER_URL}/api/books/${this.bookId}`);
            if (!r.ok) throw new Error('找不到此相本（連結可能已過期或無效）');
            this.book = await r.json();
            document.title = `${this.book.name || '相本'} · 預覽`;
            document.getElementById('bookTitle').textContent = this.book.name || '相本';
            this.currentPageIndex = 0;
            this.renderPage();
            this.checkApprovalStatus();
        } catch (e) {
            this._setError(e.message);
        }
    },

    async checkApprovalStatus() {
        try {
            const r = await fetch(`${CONFIG.WORKER_URL}/api/books/${this.bookId}/status`);
            if (!r.ok) return;
            const data = await r.json();
            if (data.approved) this._showApproved(data.timestamp);
        } catch (e) {}
    },

    renderPage() {
        if (!this.book) return;
        const page = this.book.pages[this.currentPageIndex];
        if (!page) return;

        const area = document.getElementById('pageArea');
        const settings = page.type === 'inner'
            ? this.book.settings
            : (this.book.coverSettings || this.book.settings);

        const areaW = area.clientWidth - 80;
        const areaH = area.clientHeight - 80;
        const aspect = settings.width / settings.height;

        let displayW, displayH;
        if (areaW / areaH > aspect) {
            displayH = Math.max(areaH, 200);
            displayW = displayH * aspect;
        } else {
            displayW = Math.max(areaW, 200);
            displayH = displayW / aspect;
        }

        area.innerHTML = renderPageHTML(page, displayW, displayH);

        const counter = document.getElementById('pageCounter');
        if (counter) {
            const labels = { cover: '封面', 'back-cover': '封底' };
            const label = labels[page.type] || `第 ${this.currentPageIndex} 頁`;
            const lockMark = page.locked ? ' 🔒' : '';
            counter.textContent = `${label}${lockMark}（${this.currentPageIndex + 1} / ${this.book.pages.length}）`;
        }

        document.getElementById('prevBtn').disabled = this.currentPageIndex === 0;
        document.getElementById('nextBtn').disabled = this.currentPageIndex === this.book.pages.length - 1;
    },

    bindEvents() {
        document.getElementById('prevBtn').addEventListener('click', () => {
            if (this.currentPageIndex > 0) { this.currentPageIndex--; this.renderPage(); }
        });
        document.getElementById('nextBtn').addEventListener('click', () => {
            if (this.currentPageIndex < this.book.pages.length - 1) { this.currentPageIndex++; this.renderPage(); }
        });
        document.getElementById('approveBtn')?.addEventListener('click', () => this.approve());
        document.addEventListener('keydown', e => {
            if (e.target.tagName === 'INPUT') return;
            if (e.key === 'ArrowLeft') document.getElementById('prevBtn').click();
            if (e.key === 'ArrowRight') document.getElementById('nextBtn').click();
        });
        window.addEventListener('resize', () => this.renderPage());
    },

    async approve() {
        const btn = document.getElementById('approveBtn');
        if (!btn || btn.disabled) return;
        if (!confirm('確定批准此相本？批准後攝影師將開始後續處理。')) return;
        btn.disabled = true;
        btn.textContent = '送出中...';
        try {
            const r = await fetch(`${CONFIG.WORKER_URL}/api/books/${this.bookId}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            if (!r.ok) throw new Error();
            this._showApproved(new Date().toISOString());
        } catch (e) {
            btn.disabled = false;
            btn.textContent = '批准相本';
            alert('操作失敗，請重試');
        }
    },

    _showApproved(ts) {
        const btn = document.getElementById('approveBtn');
        if (btn) { btn.textContent = '✓ 已批准'; btn.disabled = true; btn.className = 'btn btn-approved'; }
        const badge = document.getElementById('approvedBadge');
        if (badge) {
            const dateStr = ts ? new Date(ts).toLocaleDateString('zh-TW') : '';
            badge.textContent = `✓ 已於 ${dateStr} 批准`;
            badge.style.display = '';
        }
    },

    _setError(msg) {
        document.getElementById('pageArea').innerHTML =
            `<div class="state-msg error"><span class="icon">⚠</span><span>${msg}</span></div>`;
        document.getElementById('bookTitle').textContent = '載入失敗';
        document.getElementById('approveBtn').style.display = 'none';
    }
};

document.addEventListener('DOMContentLoaded', () => Viewer.init());

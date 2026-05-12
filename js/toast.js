// Toast Notification System
class Toast {
    constructor() {
        this.container = document.getElementById('toastContainer');
    }

    show(message, type = 'info', duration = 3000) {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const icons = {
            success: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M16.25 5L7.5 13.75L3.75 10" stroke="#2ed573" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
            error: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M15 5L5 15M5 5L15 15" stroke="#ff4757" stroke-width="2" stroke-linecap="round"/></svg>',
            warning: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 7V11M10 14H10.01M4 17H16C17.1046 17 18 16.1046 18 15V5C18 3.89543 17.1046 3 16 3H4C2.89543 3 2 3.89543 2 5V15C2 16.1046 2.89543 17 4 17Z" stroke="#ffa502" stroke-width="2" stroke-linecap="round"/></svg>',
            info: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="#1e90ff" stroke-width="2"/><path d="M10 10V14M10 7H10.01" stroke="#1e90ff" stroke-width="2" stroke-linecap="round"/></svg>'
        };

        toast.innerHTML = `
            <div class="toast-icon">${icons[type]}</div>
            <div class="toast-content">
                <div class="toast-message">${message}</div>
            </div>
        `;

        this.container.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideInRight 250ms ease reverse';
            setTimeout(() => toast.remove(), 250);
        }, duration);
    }

    success(message, duration) {
        this.show(message, 'success', duration);
    }

    error(message, duration) {
        this.show(message, 'error', duration);
    }

    warning(message, duration) {
        this.show(message, 'warning', duration);
    }

    info(message, duration) {
        this.show(message, 'info', duration);
    }
}

// 建立全域 toast 實例
window.toast = new Toast();

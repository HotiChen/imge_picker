// Star Rating System
class RatingManager {
    constructor() {
        this.currentRating = 0;
    }

    // 建立星級評分 UI
    createStarRating(rating = 0, photoId = null, interactive = true) {
        const container = document.createElement('div');
        container.className = 'star-rating';
        container.dataset.rating = rating;
        if (photoId) container.dataset.photoId = photoId;

        for (let i = 1; i <= 5; i++) {
            const star = document.createElement('span');
            star.className = 'star';
            star.textContent = '★';
            star.dataset.value = i;

            if (i <= rating) {
                star.classList.add('active');
            }

            if (interactive) {
                // 滑鼠懸停效果
                star.addEventListener('mouseenter', (e) => {
                    this.highlightStars(container, i);
                });

                // 點擊設定評分
                star.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.setRating(container, i, photoId);
                });
            }

            container.appendChild(star);
        }

        if (interactive) {
            // 滑鼠離開時恢復原始評分
            container.addEventListener('mouseleave', () => {
                const currentRating = parseInt(container.dataset.rating) || 0;
                this.highlightStars(container, currentRating);
            });
        }

        return container;
    }

    // 高亮星星
    highlightStars(container, count) {
        const stars = container.querySelectorAll('.star');
        stars.forEach((star, index) => {
            if (index < count) {
                star.classList.add('active');
            } else {
                star.classList.remove('active');
            }
        });
    }

    // 設定評分
    setRating(container, rating, photoId) {
        // 如果現在有批量選取，且點擊的照片就在選取範圍內，則執行批量評分
        if (window.app && window.app.selectedPhotoIds && window.app.selectedPhotoIds.has(photoId)) {
            window.app.setBulkRating(rating);
            return;
        }

        const currentRating = parseInt(container.dataset.rating) || 0;

        // 如果點選的是同一個星等，則取消評分 (變回 0 星)
        const finalRating = (currentRating === rating) ? 0 : rating;

        container.dataset.rating = finalRating;
        this.highlightStars(container, finalRating);

        if (photoId) {
            // 儲存到 Drive Manager
            driveManager.saveRating(photoId, finalRating);

            // 更新統計
            if (window.app) {
                window.app.updateStats();
            }

            // 同步更新主頁面照片卡片的星星
            const photoCard = document.querySelector(`[data-photo-id="${photoId}"]`);
            if (photoCard) {
                const cardRating = photoCard.querySelector('.star-rating');
                if (cardRating) {
                    cardRating.dataset.rating = finalRating;
                    this.highlightStars(cardRating, finalRating);
                }
            }

            // 同步更新 Modal 中照片下方的星星
            const modalPhotoRating = document.getElementById('modalPhotoRating');
            if (modalPhotoRating) {
                const photoRating = modalPhotoRating.querySelector('.star-rating');
                if (photoRating && photoRating !== container) {
                    photoRating.dataset.rating = finalRating;
                    this.highlightStars(photoRating, finalRating);
                }
            }

            if (finalRating > 0) {
                toast.success(`評分已設定為 ${finalRating} 星`);
            } else {
                toast.info(`已取消評分`);
            }
        }
    }

    // 更新評分顯示
    updateRating(container, rating) {
        container.dataset.rating = rating;
        this.highlightStars(container, rating);
    }
}

// 建立全域實例
window.ratingManager = new RatingManager();

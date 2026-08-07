/* ========================================
   MERCHMARKET — PRODUCT IMAGE CAROUSEL
   Cycles through product card images with
   prev/next nav and dot indicators.
   ======================================== */

(function() {
  'use strict';

  function initCarousels() {
    document.querySelectorAll('.product-card').forEach(card => {
      const imgContainer = card.querySelector('.product-image');
      if (!imgContainer) return;

      // Collect image sources from data or existing img tags
      let images = [];
      const existingImgs = imgContainer.querySelectorAll('img');
      existingImgs.forEach(img => images.push(img.src));

      // If no images found, check for data-images attribute
      if (images.length === 0) {
        const dataImages = card.dataset.images;
        if (dataImages) {
          try {
            images = JSON.parse(dataImages);
          } catch { /* ignore */ }
        }
      }

      if (images.length <= 1) return; // No carousel needed

      // Build carousel HTML
      const carouselId = 'carousel-' + Math.random().toString(36).slice(2, 8);
      let slidesHtml = '';
      let dotsHtml = '';
      images.forEach((src, idx) => {
        const safeSrc = typeof window.sanitizeImageUrl === 'function' ? window.sanitizeImageUrl(src) : src;
        if (safeSrc) {
          slidesHtml += `<img src="${safeSrc}" class="carousel-img${idx === 0 ? ' active' : ''}" data-index="${idx}" alt="">`;
        }
        dotsHtml += `<span class="carousel-dot${idx === 0 ? ' active' : ''}" data-index="${idx}"></span>`;
      });

      imgContainer.innerHTML = `
        <div class="image-carousel" id="${carouselId}">
          ${slidesHtml}
          <div class="carousel-dots">${dotsHtml}</div>
          <button class="carousel-nav carousel-prev" onclick="window.carouselGo('${carouselId}', -1)">‹</button>
          <button class="carousel-nav carousel-next" onclick="window.carouselGo('${carouselId}', 1)">›</button>
        </div>
      `;
    });
  }

  window.carouselGo = function(carouselId, direction) {
    const carousel = document.getElementById(carouselId);
    if (!carousel) return;

    const slides = carousel.querySelectorAll('.carousel-img');
    const dots = carousel.querySelectorAll('.carousel-dot');
    if (slides.length === 0) return;

    let current = 0;
    slides.forEach((s, i) => { if (s.classList.contains('active')) current = i; });

    let next = current + direction;
    if (next < 0) next = slides.length - 1;
    if (next >= slides.length) next = 0;

    slides.forEach(s => s.classList.remove('active'));
    dots.forEach(d => d.classList.remove('active'));
    slides[next].classList.add('active');
    dots[next].classList.add('active');
  };

  // Auto-advance every 4 seconds
  setInterval(() => {
    document.querySelectorAll('.image-carousel').forEach(carousel => {
      window.carouselGo(carousel.id, 1);
    });
  }, 4000);

  // Init on load and after marketplace re-renders
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCarousels);
  } else {
    initCarousels();
  }

  // Expose re-init for dynamic content
  window.reinitCarousels = initCarousels;
})();


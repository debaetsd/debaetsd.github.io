// Instant Lightbox JavaScript - Add to your theme's JS file or in a <script> tag

class InstantLightbox {
  constructor() {
    this.currentGallery = [];
    this.currentIndex = 0;
    this.lightbox = null;
    this.init();
  }

  init() {
    // Create lightbox HTML structure
    const lightboxHTML = `
      <div class="instant-lightbox" id="instantLightbox">
        <div class="instant-lightbox-content">
          <button class="instant-lightbox-close" onclick="instantLightbox.close()">&times;</button>
          <button class="instant-lightbox-nav instant-lightbox-prev" onclick="instantLightbox.prev()">&#10094;</button>
          <button class="instant-lightbox-nav instant-lightbox-next" onclick="instantLightbox.next()">&#10095;</button>
          <div class="instant-lightbox-counter" id="lightboxCounter"></div>
          <div id="lightboxImages"></div>
          <div class="instant-lightbox-caption" id="lightboxCaption"></div>
        </div>
      </div>
    `;
    
    // Add to body
    document.body.insertAdjacentHTML('beforeend', lightboxHTML);
    this.lightbox = document.getElementById('instantLightbox');
    
    // Setup keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (!this.lightbox.classList.contains('active')) return;
      
      if (e.key === 'ArrowLeft') this.prev();
      else if (e.key === 'ArrowRight') this.next();
      else if (e.key === 'Escape') this.close();
    });
    
    // Close on background or image click
    this.lightbox.addEventListener('click', (e) => {
      if (e.target === this.lightbox || 
          e.target.classList.contains('instant-lightbox-content') ||
          e.target.classList.contains('instant-lightbox-image')) {
        this.close();
      }
    });
    
    // Attach click handlers to all gallery images
    this.attachHandlers();
  }

  attachHandlers() {
    document.querySelectorAll('a[data-instant-gallery]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const gallery = link.getAttribute('data-instant-gallery');
        const src = link.getAttribute('href');
        this.open(gallery, src);
      });
    });
  }

  preloadImages(gallery) {
    const images = document.querySelectorAll(`a[data-instant-gallery="${gallery}"]`);
    const imagesContainer = document.getElementById('lightboxImages');
    imagesContainer.innerHTML = '';
    this.currentGallery = [];

    images.forEach((link, index) => {
      const src = link.getAttribute('href');
      const caption = link.getAttribute('data-caption') || '';
      
      // Create and preload image
      const img = document.createElement('img');
      img.src = src;
      img.className = 'instant-lightbox-image';
      img.alt = caption;
      imagesContainer.appendChild(img);
      
      this.currentGallery.push({ src, caption, element: img });
    });
  }

  open(gallery, src) {
    this.preloadImages(gallery);
    
    // Find the clicked image index
    this.currentIndex = this.currentGallery.findIndex(img => img.src === src);
    if (this.currentIndex === -1) this.currentIndex = 0;
    
    this.showImage(this.currentIndex);
    this.lightbox.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  showImage(index) {
    // Hide all images
    this.currentGallery.forEach(img => img.element.classList.remove('active'));
    
    // Show current image
    this.currentGallery[index].element.classList.add('active');
    
    // Update caption
    const caption = this.currentGallery[index].caption;
    const captionEl = document.getElementById('lightboxCaption');
    captionEl.textContent = caption;
    captionEl.style.display = caption ? 'block' : 'none';
    
    // Update counter
    document.getElementById('lightboxCounter').textContent = 
      `${index + 1} / ${this.currentGallery.length}`;
  }

  next() {
    this.currentIndex = (this.currentIndex + 1) % this.currentGallery.length;
    this.showImage(this.currentIndex);
  }

  prev() {
    this.currentIndex = (this.currentIndex - 1 + this.currentGallery.length) % this.currentGallery.length;
    this.showImage(this.currentIndex);
  }

  close() {
    this.lightbox.classList.remove('active');
    document.body.style.overflow = '';
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.instantLightbox = new InstantLightbox();
  });
} else {
  window.instantLightbox = new InstantLightbox();
}
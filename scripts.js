/* Fast-DDS Notes Unified JavaScript */
(function() {
  'use strict';

  // ── Sidebar Toggle ─────────────────
  document.querySelectorAll('.nav-group-title').forEach(el => {
    el.addEventListener('click', () => {
      el.parentElement.classList.toggle('open');
    });
  });

  // Auto-open group with active item
  const activeItem = document.querySelector('.nav-item.active');
  if (activeItem) {
    let group = activeItem.closest('.nav-group');
    while (group) {
      group.classList.add('open');
      group = group.parentElement?.closest('.nav-group');
    }
  }

  // ── Search ─────────────────────────
  const searchBox = document.querySelector('.search-box');
  if (searchBox) {
    searchBox.addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('.nav-item').forEach(item => {
        const match = item.textContent.toLowerCase().includes(q);
        item.style.display = match ? 'flex' : 'none';
      });
      document.querySelectorAll('.nav-group').forEach(g => {
        const hasVisible = g.querySelector('.nav-item[style*="flex"]');
        g.style.display = hasVisible ? 'block' : 'none';
      });
    });
  }

  // ── Back to Top ────────────────────
  const btn = document.querySelector('.back-to-top');
  if (btn) {
    window.addEventListener('scroll', () => {
      btn.classList.toggle('visible', window.scrollY > 300);
    });
    btn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // ── FAQ Toggle ─────────────────────
  document.querySelectorAll('.faq-question').forEach(q => {
    q.addEventListener('click', () => {
      q.closest('.faq-item').classList.toggle('open');
    });
  });

  // ── Smooth Scroll for Anchors ─────
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const target = document.querySelector(a.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // ── Code Copy ──────────────────────
  document.querySelectorAll('pre').forEach(pre => {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = '复制';
    copyBtn.style.cssText = `
      position: absolute; top: 8px; right: 8px;
      background: var(--bg-tertiary); border: 1px solid var(--border);
      color: var(--fg-muted); padding: 4px 10px;
      border-radius: 4px; font-size: 11px; cursor: pointer;
      opacity: 0; transition: opacity 0.2s;
    `;
    pre.style.position = 'relative';
    pre.appendChild(copyBtn);
    pre.addEventListener('mouseenter', () => copyBtn.style.opacity = '1');
    pre.addEventListener('mouseleave', () => copyBtn.style.opacity = '0');
    copyBtn.addEventListener('click', () => {
      const code = pre.querySelector('code')?.textContent || pre.textContent;
      navigator.clipboard.writeText(code).then(() => {
        copyBtn.textContent = '已复制!';
        setTimeout(() => copyBtn.textContent = '复制', 2000);
      });
    });
  });

  // ── Mobile Menu ────────────────────
  const menuToggle = document.querySelector('.menu-toggle');
  const sidebar = document.querySelector('.sidebar');
  if (menuToggle && sidebar) {
    menuToggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
  }

  // ── Reading Progress ─────────────────
  const progressBar = document.createElement('div');
  progressBar.style.cssText = `
    position: fixed; top: 0; left: 300px; right: 0;
    height: 2px; background: var(--bg-tertiary);
    z-index: 1000;
  `;
  const progressFill = document.createElement('div');
  progressFill.style.cssText = `
    height: 100%; width: 0%;
    background: linear-gradient(90deg, var(--accent), var(--accent2));
    transition: width 0.1s;
  `;
  progressBar.appendChild(progressFill);
  document.body.appendChild(progressBar);

  window.addEventListener('scroll', () => {
    const scrollTop = window.scrollY;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const pct = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
    progressFill.style.width = pct + '%';
  });

})();

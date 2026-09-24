(() => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ─── Nav border once the page scrolls ─────────────────
  const nav = document.querySelector('.nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // ─── Hero conversation plays in ───────────────────────
  // Steps: 0 wallet, 1 question, 2 typing, 3 books, 4 attention.
  const seq = document.querySelector('[data-sequence]');
  if (seq) {
    const steps = [...seq.querySelectorAll('[data-step]')];
    const show = (i) => steps.filter((s) => s.dataset.step === String(i)).forEach((s) => s.classList.add('in'));
    const hide = (i) => steps.filter((s) => s.dataset.step === String(i)).forEach((s) => s.classList.remove('in'));

    const play = () => {
      const timeline = [
        [300, () => show(0)],
        [1100, () => show(1)],
        [1900, () => show(2)],
        [3500, () => { hide(2); show(3); }],
        [4900, () => show(4)],
      ];
      timeline.forEach(([ms, fn]) => setTimeout(fn, ms));
    };

    if (reduceMotion || !('IntersectionObserver' in window)) {
      [0, 1, 3, 4].forEach(show);
    } else {
      // On phones the chat sits below the fold — start when it's actually seen
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) { io.disconnect(); play(); }
      }, { threshold: 0.25 });
      io.observe(seq);
    }
  }

  // ─── Books tabs (WAI-ARIA tabs pattern) ───────────────
  const books = document.querySelector('[data-books]');
  if (books) {
    const tabs = [...books.querySelectorAll('[role="tab"]')];
    const select = (tab, focus) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      });
      if (focus) tab.focus();
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab, false));
      tab.addEventListener('keydown', (e) => {
        const move = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (move) {
          e.preventDefault();
          select(tabs[(i + move + tabs.length) % tabs.length], true);
        } else if (e.key === 'Home') {
          e.preventDefault(); select(tabs[0], true);
        } else if (e.key === 'End') {
          e.preventDefault(); select(tabs[tabs.length - 1], true);
        }
      });
    });
  }

  // ─── Segmented toggles ───────────────────────────────
  const pressOne = (buttons, active) =>
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === active)));

  // Memory: June correction vs. September recall
  const memoryButtons = [...document.querySelectorAll('[data-memory]')];
  const memoryDate = document.querySelector('[data-memory-date]');
  const memoryDates = { day1: 'Tue 10 June', day90: 'Thu 11 September' };
  memoryButtons.forEach((btn) => btn.addEventListener('click', () => {
    pressOne(memoryButtons, btn);
    document.querySelectorAll('[data-memory-panel]').forEach((p) => {
      p.hidden = p.dataset.memoryPanel !== btn.dataset.memory;
    });
    memoryDate.textContent = memoryDates[btn.dataset.memory];
  }));

  // Channels: same conversation, different chat app
  const channelButtons = [...document.querySelectorAll('[data-channel]')];
  const channelChat = document.querySelector('[data-channel-chat]');
  const channelLabel = document.querySelector('[data-channel-label]');
  const channelLabels = { telegram: 'Telegram · live', whatsapp: 'WhatsApp · coming next', imessage: 'iMessage · coming next' };
  channelButtons.forEach((btn) => btn.addEventListener('click', () => {
    pressOne(channelButtons, btn);
    channelChat.dataset.channelChat = btn.dataset.channel;
    channelLabel.textContent = channelLabels[btn.dataset.channel];
  }));
})();

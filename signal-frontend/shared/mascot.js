// Signal Watchlist — mascot speech-bubble toggle, shared across screens.
// An element with data-mascot-toggle="#bubble-id" reveals that bubble on
// click; data-mascot-hint (optional) is hidden while the bubble is open.
document.querySelectorAll('[data-mascot-toggle]').forEach((mascot) => {
  const bubble = document.querySelector(mascot.getAttribute('data-mascot-toggle'));
  if (!bubble) return;
  const hintSelector = mascot.getAttribute('data-mascot-hint');
  const hint = hintSelector ? document.querySelector(hintSelector) : null;

  mascot.addEventListener('click', () => {
    bubble.hidden = !bubble.hidden;
    if (hint) hint.hidden = !bubble.hidden;
  });
});

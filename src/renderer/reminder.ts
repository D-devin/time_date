document.getElementById('dismiss-reminder')!.addEventListener('click', () => window.close());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' || event.key === 'Enter') window.close();
});

import type { CountdownState } from '../desktop/countdown.js';

export function initTimerView(change: (operation: () => Promise<void>) => Promise<void>) {
  const form = document.querySelector<HTMLFormElement>('#timer-form')!;
  const fields = document.querySelector<HTMLFieldSetElement>('#timer-length')!;
  const inputs = [...fields.querySelectorAll('input')];
  const action = document.querySelector<HTMLButtonElement>('#timer-action')!;
  const reset = document.querySelector<HTMLButtonElement>('#timer-reset')!;
  const display = document.getElementById('timer-display')!;
  const progress = document.querySelector<HTMLProgressElement>('#timer-progress')!;
  const status = document.getElementById('timer-status')!;
  const labels = { idle: '待开始', running: '计时中', paused: '已暂停', finished: '已结束' };
  const actions = { idle: '开始', running: '暂停', paused: '继续', finished: '重新开始' };
  let state: CountdownState | undefined;
  let visible = false;
  let tick: number | undefined;

  function parts(seconds: number): number[] {
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  }

  function durationSeconds(): number {
    const [hours = 0, minutes = 0, seconds = 0] = inputs.map((input) => Number(input.value));
    return hours * 3600 + minutes * 60 + seconds;
  }

  function render(): void {
    window.clearTimeout(tick);
    if (!state || !visible || document.hidden) return;
    const configured = durationSeconds();
    const valid = inputs.every((input) => input.validity.valid) && configured > 0;
    let remaining = state.remainingMs;
    if (state.endsAt !== null) remaining = Math.max(0, state.endsAt - Date.now());
    if (state.status === 'idle') remaining = configured * 1000;
    display.textContent = state.status === 'idle' && !valid ? '--:--:--'
      : parts(Math.ceil(remaining / 1000)).map((n) => String(n).padStart(2, '0')).join(':');
    progress.value = state.status === 'idle' ? Number(valid) : remaining / state.durationMs;
    action.disabled = !fields.disabled && !valid;
    if (state.status === 'running' && remaining > 0) {
      tick = window.setTimeout(render, remaining % 1000 || 1000);
    }
  }

  form.addEventListener('input', render);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state) return;
    const api = window.planner;
    if (state.status === 'running') void change(() => api.pauseTimer());
    else if (state.status === 'paused') void change(() => api.resumeTimer());
    else void change(() => api.startTimer(durationSeconds()));
  });
  reset.addEventListener('click', () => void change(() => window.planner.resetTimer()));
  document.addEventListener('visibilitychange', render);
  return (next: CountdownState, show: boolean) => {
    if (state?.durationMs !== next.durationMs || (next.status === 'idle' && state.status !== 'idle')) {
      const values = parts(next.durationMs / 1000);
      inputs.forEach((input, index) => { input.value = String(values[index]); });
    }
    state = next;
    visible = show;
    fields.disabled = next.status === 'running' || next.status === 'paused';
    action.textContent = actions[next.status];
    status.textContent = labels[next.status];
    reset.disabled = next.status === 'idle';
    render();
  };
}

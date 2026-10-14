/**
 * The local operator console page. Self-contained (the server's CSP forbids external
 * fonts and scripts) and rendered with textContent only: run summaries can carry
 * reason codes and IDs, never page text, and nothing is ever parsed as HTML.
 */
export function operatorPage(sso = false): string {
  return String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Capability operator</title>
<style>
/* Layout: mission-control column. A telemetry header, a three-stage handoff strip,
   then one glass panel per run with a status beam on its left edge. Dark by design. */
:root {
  --void: #050912; --deep: #0a1120; --glass: rgba(18, 30, 52, 0.62); --glass-hi: rgba(28, 46, 78, 0.7);
  --edge: rgba(120, 190, 255, 0.16); --edge-hi: rgba(120, 200, 255, 0.42);
  --ink: #e6f1ff; --muted: #8aa0bf; --faint: #4f6283;
  --cyan: #5ad8ff; --cyan-glow: rgba(90, 216, 255, 0.35); --violet: #9b8cff;
  --amber: #ffbe5c; --amber-glow: rgba(255, 190, 92, 0.32);
  --mint: #4fe3b0; --mint-glow: rgba(79, 227, 176, 0.3);
  --rose: #ff6b8a; --rose-glow: rgba(255, 107, 138, 0.3);
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  --sans: "SF Pro Display", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color-scheme: dark;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body {
  margin: 0; min-height: 100vh; color: var(--ink); font: 15px/1.55 var(--sans);
  background:
    radial-gradient(1200px 600px at 85% -10%, rgba(90, 120, 255, 0.18), transparent 60%),
    radial-gradient(900px 500px at -10% 30%, rgba(90, 216, 255, 0.10), transparent 60%),
    linear-gradient(rgba(120, 190, 255, 0.045) 1px, transparent 1px) 0 0 / 44px 44px,
    linear-gradient(90deg, rgba(120, 190, 255, 0.045) 1px, transparent 1px) 0 0 / 44px 44px,
    var(--void);
}
main { max-width: 900px; margin: 0 auto; padding: 44px 20px 72px; display: grid; gap: 26px; }
header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px; }
.brand { display: flex; align-items: center; gap: 14px; }
.mark { position: relative; width: 42px; height: 42px; border-radius: 50%; border: 1px solid var(--edge-hi);
  background: radial-gradient(circle at 50% 50%, rgba(90, 216, 255, 0.25), transparent 65%); box-shadow: 0 0 22px var(--cyan-glow), inset 0 0 12px var(--cyan-glow); }
.mark::before { content: ""; position: absolute; inset: 9px; border-radius: 50%; border: 2px solid var(--cyan); border-right-color: transparent; border-bottom-color: transparent; }
.mark::after { content: ""; position: absolute; left: 50%; top: 50%; width: 6px; height: 6px; margin: -3px; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 10px var(--cyan); }
.kicker { margin: 0 0 2px; font: 500 11px var(--mono); letter-spacing: 0.22em; color: var(--cyan); text-transform: uppercase; }
h1 { font-size: 22px; margin: 0; letter-spacing: 0.01em; font-weight: 650; }
.live { display: inline-flex; align-items: center; gap: 9px; font: 500 11.5px var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted);
  padding: 8px 14px; border: 1px solid var(--edge); border-radius: 999px; background: var(--glass); backdrop-filter: blur(10px); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); }
.live[data-on="true"] { color: var(--mint); border-color: rgba(79, 227, 176, 0.35); }
.live[data-on="true"] .dot { background: var(--mint); box-shadow: 0 0 0 4px var(--mint-glow), 0 0 12px var(--mint); }
.guide { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0; padding: 0; list-style: none; counter-reset: step; }
.guide li { position: relative; counter-increment: step; background: var(--glass); border: 1px solid var(--edge); border-radius: 14px; padding: 16px 18px; font-size: 13px; color: var(--muted); min-width: 0; backdrop-filter: blur(10px); }
.guide li::before { content: "0" counter(step); display: block; font: 500 11px var(--mono); letter-spacing: 0.2em; color: var(--cyan); margin-bottom: 8px; }
.guide li::after { content: ""; position: absolute; top: -1px; left: 18px; width: 34px; height: 2px; background: var(--cyan); box-shadow: 0 0 10px var(--cyan); border-radius: 2px; }
.guide b { display: block; color: var(--ink); font-size: 14.5px; margin-bottom: 3px; font-weight: 600; }
#runs { display: grid; gap: 16px; }
.run { --tone: var(--cyan); --glow: var(--cyan-glow); position: relative; overflow: hidden; background: linear-gradient(180deg, var(--glass-hi), var(--glass)); border: 1px solid var(--edge); border-radius: 16px; padding: 22px 24px 22px 28px; display: grid; gap: 16px; backdrop-filter: blur(14px); box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35); }
.run::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--tone); box-shadow: 0 0 18px var(--tone); }
.run[data-tone="warn"] { --tone: var(--amber); --glow: var(--amber-glow); border-color: rgba(255, 190, 92, 0.32); }
.run[data-tone="info"] { --tone: var(--cyan); --glow: var(--cyan-glow); }
.run[data-tone="ok"] { --tone: var(--mint); --glow: var(--mint-glow); }
.run[data-tone="bad"] { --tone: var(--rose); --glow: var(--rose-glow); }
.run-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px; }
.run h2 { font-size: 17px; margin: 0; font-weight: 600; letter-spacing: 0.005em; overflow-wrap: break-word; }
.runid { font: 12px var(--mono); color: var(--faint); overflow-wrap: anywhere; margin: 4px 0 0; }
.chip { display: inline-flex; align-items: center; gap: 8px; font: 600 11.5px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; padding: 6px 12px; border-radius: 999px; white-space: nowrap; color: var(--tone); border: 1px solid var(--tone); background: var(--glow); box-shadow: 0 0 16px var(--glow); }
.chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--tone); box-shadow: 0 0 8px var(--tone); }
.run[data-tone="warn"] .chip::before { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.25; } }
.reason { margin: 0; padding: 14px 16px; border-radius: 12px; background: rgba(5, 9, 18, 0.55); border: 1px solid var(--edge); font-size: 14px; color: var(--muted); }
.reason strong { display: block; color: var(--ink); font-size: 14.5px; font-weight: 600; margin-bottom: 2px; }
.facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 0; }
.facts div { padding: 10px 12px; border-radius: 10px; border: 1px solid var(--edge); background: rgba(5, 9, 18, 0.35); min-width: 0; }
.facts dt { font: 500 10.5px var(--mono); letter-spacing: 0.18em; text-transform: uppercase; color: var(--faint); }
.facts dd { margin: 3px 0 0; font: 500 14px var(--mono); color: var(--ink); overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; }
button { font: 600 13.5px var(--sans); letter-spacing: 0.02em; border-radius: 10px; padding: 10px 18px; cursor: pointer; border: 1px solid var(--edge-hi); background: rgba(90, 216, 255, 0.06); color: var(--ink); transition: box-shadow 0.2s, background 0.2s; }
button.primary { border-color: transparent; color: #04101c; background: linear-gradient(135deg, var(--cyan), var(--violet)); box-shadow: 0 0 22px var(--cyan-glow); }
button.danger { border-color: rgba(255, 107, 138, 0.45); color: var(--rose); background: rgba(255, 107, 138, 0.06); }
button:hover:not(:disabled) { box-shadow: 0 0 24px var(--cyan-glow); }
button.danger:hover:not(:disabled) { box-shadow: 0 0 20px var(--rose-glow); }
button:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
button:disabled { opacity: 0.32; cursor: default; box-shadow: none; }
.empty { text-align: center; color: var(--muted); padding: 44px 20px; border: 1px dashed var(--edge-hi); border-radius: 16px; background: var(--glass); font: 13px var(--mono); letter-spacing: 0.06em; }
#message { min-height: 1.5em; margin: 0; font: 13px var(--mono); color: var(--cyan); }
#message[data-tone="bad"] { color: var(--rose); }
.login { display: grid; gap: 14px; padding: 24px; border: 1px solid var(--edge); border-radius: 16px; background: var(--glass); }
.login p { margin: 0; color: var(--muted); }
.login label { display: grid; gap: 6px; }
.login input { width: 100%; padding: 12px; font: 14px var(--mono); color: var(--ink); background: var(--deep); border: 1px solid var(--edge-hi); border-radius: 8px; }
.login button { justify-self: start; }
@media (max-width: 640px) {
  main { padding: 26px 16px 56px; gap: 20px; }
  .guide { grid-template-columns: 1fr; gap: 8px; }
  .guide li { padding: 12px 14px; }
  .run { padding: 18px 16px 18px 20px; gap: 14px; }
  .facts { grid-template-columns: 1fr; gap: 0; border: 1px solid var(--edge); border-radius: 10px; overflow: hidden; }
  .facts div { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; border: 0; border-radius: 0; border-bottom: 1px solid var(--edge); }
  .facts div:last-child { border-bottom: 0; }
  .facts dd { margin: 0; text-align: right; }
  .actions { display: grid; grid-template-columns: 1fr 1fr; }
  .actions .primary { grid-column: 1 / -1; }
}
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style></head><body>
<main>
  <header>
    <div class="brand"><div class="mark" aria-hidden="true"></div>
      <div><p class="kicker">Handoff control · local node</p><h1>Capability operator</h1></div></div>
    <span class="live" id="connection" data-on="false"><span class="dot"></span><span id="connection-text">Sign in required</span></span>
    <button id="logout" type="button" hidden>Sign out</button>
  </header>
  <form id="login" class="login" method="post" action="/api/login">
    <h2>Operator sign in</h2>
    ${
      sso
        ? '<p>Sign in with your organization account. Your role determines which tenants and controls you can access.</p><a class="primary" href="/auth/login">Sign in with SSO</a>'
        : `<p>Use your configured operator key or the key saved in <code>.runs/operator-key</code>. Sessions expire after 15 minutes.</p>
    <label>Operator key<input id="operator-key" name="token" type="password" autocomplete="current-password" minlength="32" maxlength="4096" required></label>
    <button class="primary" type="submit">Sign in</button>`
    }
  </form>
  <ol id="guide" class="guide" aria-label="How a handoff works" hidden>
    <li><b>Take control</b>Automation halts and cannot act until you hand back.</li>
    <li><b>Fix it in Chromium</b>Use the browser window the run already has open. Values you type are never logged.</li>
    <li><b>Resume</b>The run checks the screen and continues only if it is safe.</li>
  </ol>
  <section id="runs" aria-live="polite" hidden></section>
  <p id="identity" hidden></p>
  <p id="message" role="status"></p>
</main>
<script>
const root = document.getElementById('runs');
const message = document.getElementById('message');
let streamController;
function authenticated(on) {
  document.getElementById('login').hidden = on;
  document.getElementById('logout').hidden = !on;
  document.getElementById('guide').hidden = !on;
  root.hidden = !on;
  document.getElementById('identity').hidden = !on;
  if (!on) { root.replaceChildren(); if (streamController) streamController.abort(); connected(false); document.getElementById('connection-text').textContent = 'Sign in required'; }
}
const STATES = {
  awaiting_human: ['Needs you', 'warn'], pausing: ['Pausing', 'warn'], escalated: ['Needs you', 'warn'],
  human: ['Human in control', 'info'], resyncing: ['Checking the screen', 'info'],
  running: ['Automation in control', 'ok'], success: ['Completed', 'ok'], business_outcome: ['Finished with an outcome', 'ok'],
  failed: ['Stopped', 'bad'], aborted: ['Aborted', 'bad'], interrupted: ['Interrupted', 'warn'], closed: ['Closed', 'bad'],
};
const REASONS = {
  SESSION_EXPIRED: ['The bank session expired', 'Sign back in with the operator code in the Chromium window, then resume.'],
  OPERATOR_TAKEOVER: ['An operator took control', 'Finish what you are doing in the browser, then resume.'],
  UNKNOWN_DIALOG: ['An unexpected dialog appeared', 'Close or answer it in the browser, then resume.'],
  NATIVE_DIALOG_REQUIRES_HUMAN: ['A browser dialog was blocked', 'Take control, check the page, then resume.'],
  AMBIGUOUS_TARGET: ['More than one control matched', 'Check the screen; the run will not guess which one to use.'],
  ANCHOR_DISAGREEMENT: ['The ways of finding a control disagree', 'The screen may have changed. Check it before resuming.'],
  MANDATORY_ANCHOR_MISSING: ['A required control is missing', 'Bring the expected screen back, then resume.'],
  TARGET_NOT_FOUND: ['A control could not be found', 'Bring the expected screen back, then resume.'],
  PRECONDITION_MISMATCH: ['The screen is not where the step expects', 'Navigate back to the expected screen, then resume.'],
  CHECKPOINT_TIMEOUT: ['The next screen did not appear in time', 'Check whether the page is stuck, then resume.'],
  UNKNOWN_ACTION_OUTCOME: ['A submitted action has an unknown result', 'Check whether it took effect. It will not be repeated blindly.'],
  RECOVERY_EXHAUSTED: ['Automatic recovery ran out of attempts', 'Fix the condition in the browser, then resume.'],
  UNSAFE_RECOVERY: ['Automatic recovery would not be safe here', 'Fix the condition in the browser, then resume.'],
  UNSAFE_RESUME: ['Resuming here could repeat a write', 'Confirm what happened in the browser before resuming.'],
  WRONG_SUBJECT_ON_RESUME: ['A different member is open', 'Return to the requested member before resuming.'],
  WRONG_STATE_ON_RESUME: ['The screen does not match the paused step', 'Return to the expected screen, then resume.'],
  CONFLICTING_STATES: ['The screen shows conflicting results', 'Check the page before resuming.'],
};
function reasonFor(code) {
  if (!code) return null;
  if (REASONS[code]) return REASONS[code];
  if (code.indexOf('RESUME_') === 0 && REASONS[code.slice(7)]) return REASONS[code.slice(7)];
  const words = code.toLowerCase().split('_').join(' ');
  return [words.charAt(0).toUpperCase() + words.slice(1), 'Check the browser window, then resume or abort.'];
}
function el(tag, cls, text) { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; }
function fact(list, label, value) { if (value === undefined || value === null || value === '') return; const row = el('div'); row.append(el('dt', '', label), el('dd', '', String(value))); list.append(row); }
function render(data) {
  root.replaceChildren();
  document.getElementById('identity').textContent = data.principal ? 'Signed in as ' + data.principal.id : '';
  if (!data.runs.length) { root.append(el('p', 'empty', 'No runs need attention. Paused runs appear here automatically.')); return; }
  for (const run of data.runs) {
    const card = el('article', 'run');
    const head = el('div', 'run-head');
    const titles = el('div');
    titles.append(el('h2', '', run.capability.split('_').join('_\u200b')), el('p', 'runid', run.runId));
    const state = STATES[run.state] || [run.state, 'info'];
    const chip = el('span', 'chip', state[0]);
    card.dataset.tone = state[1];
    head.append(titles, chip);
    card.append(head);
    const reason = run.state === 'interrupted' ? ['The run was interrupted', 'Check whether its last action took effect in the application.'] : reasonFor(run.reason);
    if (reason) { const box = el('p', 'reason'); box.append(el('strong', '', reason[0]), document.createTextNode(reason[1])); card.append(box); }
    if (run.state === 'interrupted') card.append(el('p', 'reason', 'Browser session was lost. Check the application before starting a new request. Acknowledging does not replay actions.'));
    const facts = el('dl', 'facts');
    fact(facts, 'In control', run.owner === 'none' ? 'nobody (paused)' : run.owner);
    fact(facts, 'Tenant', run.tenant);
    fact(facts, 'Step', run.stepId);
    card.append(facts);
    const actions = el('div', 'actions');
    const terminal = ['failed', 'aborted', 'success', 'business_outcome', 'closed', 'interrupted'].indexOf(run.state) >= 0;
    const controls = run.state === 'interrupted' ? [['resolve', 'Acknowledge interruption', 'primary']] : [['takeover', 'Take control', 'primary'], ['resume', 'Resume', ''], ['abort', 'Abort', 'danger']];
    for (const [command, label, cls] of controls) {
      if (!run.actions || !run.actions.includes(command)) continue;
      const button = el('button', cls, label);
      button.type = 'button';
      button.disabled = command === 'resolve' ? false : command === 'resume' ? terminal || run.owner !== 'human' : command === 'takeover' ? terminal || run.owner === 'human' : terminal;
      button.onclick = async () => {
        button.disabled = true; message.dataset.tone = ''; message.textContent = '';
        try {
          const response = await fetch('/api/runs/' + encodeURIComponent(run.runId) + '/' + command, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expectedEpoch: run.epoch }),
          });
          if (response.status === 401) { authenticated(false); throw new Error('Your session expired. Sign in again.'); }
          if (!response.ok) throw new Error('The run changed before your command arrived. The list has been refreshed; try again.');
          message.textContent = command === 'takeover' ? 'You are in control. Use the existing Chromium window, then select Resume.'
            : command === 'resume' ? 'Handed back. The run is checking the screen before it continues.' : command === 'resolve' ? 'Interruption acknowledged. No actions were replayed.' : 'Run aborted.';
        } catch (error) { message.dataset.tone = 'bad'; message.textContent = error.message; }
        await refresh();
      };
      actions.append(button);
    }
    card.append(actions);
    root.append(card);
  }
}
async function refresh() {
  const response = await fetch('/api/runs');
  if (response.status === 401) { authenticated(false); return false; }
  if (!response.ok) throw new Error('The run list is unavailable. Reload to try again.');
  authenticated(true); render(await response.json()); return true;
}
function connected(on) { document.getElementById('connection').dataset.on = String(on); document.getElementById('connection-text').textContent = on ? 'Live' : 'Disconnected, reload to reconnect'; }
async function stream() {
  if (streamController) streamController.abort();
  const controller = new AbortController(); streamController = controller;
  try {
    const response = await fetch('/api/events', { signal: controller.signal });
    if (response.status === 401) { authenticated(false); return; }
    if (!response.ok || !response.body) throw new Error();
    connected(true);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (event.indexOf('data: ') === 0) render(JSON.parse(event.slice(6)));
      }
    }
  } catch (error) {}
  if (controller.signal.aborted) return;
  connected(false);
  try { await refresh(); } catch (error) { message.textContent = error.message; }
}
document.getElementById('login').onsubmit = async (event) => {
  event.preventDefault();
  const input = document.getElementById('operator-key');
  if (!input) { window.location.assign('/auth/login'); return; }
  const button = event.currentTarget.querySelector('button'); button.disabled = true;
  message.textContent = ''; message.dataset.tone = '';
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: input.value }) });
    if (!response.ok) throw new Error(response.status === 429 ? 'Too many attempts. Wait one minute and try again.' : 'Sign in failed. Check your operator key.');
    if (await refresh()) void stream();
  } catch (error) { message.dataset.tone = 'bad'; message.textContent = error.message; }
  finally { input.value = ''; button.disabled = false; }
};
document.getElementById('logout').onclick = async () => {
  try {
    const response = await fetch('/api/logout', { method: 'POST' });
    if (!response.ok && response.status !== 401) throw new Error('Sign out failed. Try again.');
    authenticated(false); message.textContent = 'Signed out.';
  } catch (error) { message.dataset.tone = 'bad'; message.textContent = error.message; }
};
refresh().then((ready) => { if (ready) void stream(); }).catch((error) => { message.textContent = error.message; });
</script></body></html>`;
}

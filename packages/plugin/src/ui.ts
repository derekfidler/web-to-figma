/**
 * Figma plugin UI (iframe sandbox).
 * Posts UIMessage to the plugin main thread, listens for PluginMessage.
 */

const urlInput = document.getElementById('url') as HTMLInputElement;
const viewportSelect = document.getElementById('viewport') as HTMLSelectElement;
const endpointInput = document.getElementById('endpoint') as HTMLInputElement;
const tokenInput = document.getElementById('token') as HTMLInputElement;
const captureButton = document.getElementById('capture') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const fontReportWrap = document.getElementById('font-report-wrap') as HTMLDetailsElement;
const fontReportEl = document.getElementById('font-report') as HTMLDivElement;

function setStatus(text: string, kind: 'normal' | 'error' | 'success' = 'normal'): void {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind === 'normal' ? '' : ' ' + kind);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function setBusy(busy: boolean): void {
  captureButton.disabled = busy;
  captureButton.textContent = busy ? 'Capturing...' : 'Capture page';
}

captureButton.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus('Enter a URL', 'error');
    return;
  }
  setBusy(true);
  setStatus('Sending request...');
  parent.postMessage(
    {
      pluginMessage: {
        kind: 'capture',
        payload: {
          url,
          viewport: viewportSelect.value,
          endpoint: endpointInput.value.trim() || 'http://localhost:4321',
          token: tokenInput.value.trim() || undefined,
        },
      },
    },
    '*',
  );
});

window.addEventListener('message', (event) => {
  const msg = (event.data as { pluginMessage?: { kind: string; [k: string]: unknown } }).pluginMessage;
  if (!msg) return;
  switch (msg.kind) {
    case 'progress':
      setStatus(msg.message as string);
      break;
    case 'success': {
      const { nodeCount, renderMs, buildMs, fontReport } = msg as unknown as {
        nodeCount: number;
        renderMs: number;
        buildMs: number;
        fontReport: Array<{ requested: { family: string; weight: number }; resolved: { family: string; style: string }; fellBack: boolean }>;
      };
      const fellBackCount = fontReport.filter((f) => f.fellBack).length;
      const summary = fellBackCount > 0
        ? `${nodeCount} layers — ${fellBackCount}/${fontReport.length} fonts fell back`
        : `${nodeCount} layers — all ${fontReport.length} fonts matched`;
      setStatus(`${summary} (${renderMs}ms render, ${buildMs}ms build)`, 'success');
      // Show the per-font detail
      fontReportEl.innerHTML = fontReport
        .map((f) => {
          const req = `${f.requested.family} ${f.requested.weight}`;
          const res = `${f.resolved.family} / ${f.resolved.style}`;
          const arrow = f.fellBack ? '✗ →' : '✓ →';
          const colour = f.fellBack ? '#d93025' : 'inherit';
          return `<div style="color:${colour}; padding:2px 0">${escapeHtml(arrow)} ${escapeHtml(req)} <span style="opacity:0.6">→</span> ${escapeHtml(res)}</div>`;
        })
        .join('');
      fontReportWrap.style.display = 'block';
      fontReportWrap.open = fellBackCount > 0;
      setBusy(false);
      break;
    }
    case 'error':
      setStatus(msg.message as string, 'error');
      setBusy(false);
      break;
    case 'settings':
      endpointInput.value = (msg.endpoint as string) || 'http://localhost:4321';
      tokenInput.value = (msg.token as string) || '';
      break;
  }
});

parent.postMessage({ pluginMessage: { kind: 'request-settings' } }, '*');

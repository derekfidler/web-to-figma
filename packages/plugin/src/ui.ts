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

function setStatus(text: string, kind: 'normal' | 'error' | 'success' = 'normal'): void {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind === 'normal' ? '' : ' ' + kind);
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
      const { nodeCount, renderMs, buildMs } = msg as unknown as { nodeCount: number; renderMs: number; buildMs: number };
      setStatus(`${nodeCount} layers — ${renderMs}ms render, ${buildMs}ms build`, 'success');
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

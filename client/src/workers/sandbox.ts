// A Worker that lives in the code sandbox (see server/src/sandboxpage.ts): an invisible frame whose
// origin is opaque, served with a CSP that removes the network (JavaScript) or limits it to the
// Pyodide distribution (Python). Code in a cell therefore never runs as the person viewing the
// document — no cookies, no same-origin requests, no access to the app's storage or DOM.
// It looks like a Worker to the runner: postMessage / onmessage / onerror / terminate.

type Listener = ((e: MessageEvent) => void) | null;

const sources = new Map<string, Promise<string>>();
/** the bundled worker script, fetched once (same origin) and handed to the frame as text */
function workerSource(url: string): Promise<string> {
  let p = sources.get(url);
  if (!p) {
    p = fetch(url, { credentials: 'same-origin' }).then((r) => {
      if (!r.ok) throw new Error(`could not load the code worker (${r.status})`);
      return r.text();
    });
    p.catch(() => sources.delete(url));
    sources.set(url, p);
  }
  return p;
}

export class SandboxedWorker {
  onmessage: Listener = null;
  onerror: ((e: { message: string }) => void) | null = null;
  private readonly frame: HTMLIFrameElement;
  private readonly listener: (e: MessageEvent) => void;
  private readonly queue: unknown[] = [];
  private started = false;
  private dead = false;

  constructor(page: string, workerUrl: string) {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.tabIndex = -1;
    frame.title = 'Code sandbox';
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
    frame.src = page;
    this.frame = frame;
    this.listener = (e: MessageEvent) => {
      // only the frame this worker created may speak for it
      if (this.dead || e.source !== frame.contentWindow) return;
      const m = (e.data ?? {}) as { type?: string; data?: unknown; message?: unknown };
      if (m.type === 'loaded') void this.start(workerUrl);
      else if (m.type === 'message') this.onmessage?.({ data: m.data } as MessageEvent);
      else if (m.type === 'error') this.onerror?.({ message: String(m.message ?? 'code sandbox error') });
    };
    window.addEventListener('message', this.listener);
    document.body.appendChild(frame);
    window.setTimeout(() => {
      if (!this.started && !this.dead) this.onerror?.({ message: 'the code sandbox did not start (check the Pyodide location in Settings)' });
    }, 20_000);
  }

  private async start(workerUrl: string) {
    if (this.started) return;
    try {
      const source = await workerSource(workerUrl);
      if (this.dead) return;
      // the frame's origin is opaque, so it cannot be named as a target; nothing else can receive this
      this.frame.contentWindow?.postMessage({ type: 'start', source, module: false }, '*');
      this.started = true;
      for (const data of this.queue.splice(0)) this.frame.contentWindow?.postMessage({ type: 'post', data }, '*');
    } catch (e) {
      this.onerror?.({ message: (e as Error).message });
    }
  }

  postMessage(data: unknown) {
    if (this.dead) return;
    if (!this.started) this.queue.push(data);
    else this.frame.contentWindow?.postMessage({ type: 'post', data }, '*');
  }

  terminate() {
    this.dead = true;
    window.removeEventListener('message', this.listener);
    this.frame.remove();
  }
}

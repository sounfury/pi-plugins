const PREVIEW_PATH = '/preview/';
const MAX_LOG_LINES = 160;
const MAX_LOG_CHARS = 32000;
const STATUS_LABELS = {
  idle: '未启动',
  starting: '正在启动…',
  running: '运行中',
  stopping: '正在停止…',
  error: '启动失败',
};

const styles = `
[data-pi-vite-preview] {
  --preview-bg: var(--bg-primary, #17191f);
  --preview-panel: var(--bg-secondary, #22252d);
  --preview-text: var(--text-primary, #edf0f7);
  --preview-muted: var(--text-secondary, #a7afbf);
  --preview-border: var(--border-color, #3b4250);
  --preview-accent: var(--accent-color, #91b5ff);
  color: var(--preview-text); background: var(--preview-bg);
  font: 14px/1.5 system-ui, sans-serif; padding: 16px;
  width: 100%; min-width: 0; box-sizing: border-box;
}
[data-pi-vite-preview] *, [data-pi-vite-preview] *::before,
[data-pi-vite-preview] *::after { box-sizing: border-box; }
[data-pi-vite-preview] [hidden] { display: none !important; }
[data-pi-vite-preview] h2 { font-size: 18px; margin: 0; }
[data-pi-vite-preview] p { margin: 6px 0; }
[data-pi-vite-preview] .preview-muted { color: var(--preview-muted); }
[data-pi-vite-preview] .preview-header,
[data-pi-vite-preview] .preview-actions,
[data-pi-vite-preview] .preview-toolbar {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
}
[data-pi-vite-preview] .preview-header { justify-content: space-between; }
[data-pi-vite-preview] .preview-status {
  border: 1px solid var(--preview-border); border-radius: 999px;
  padding: 3px 10px; white-space: nowrap;
}
[data-pi-vite-preview] .preview-status[data-status="running"] { color: #8bddb0; }
[data-pi-vite-preview] .preview-status[data-status="error"] { color: #ffb1aa; }
[data-pi-vite-preview] form { margin: 16px 0; }
[data-pi-vite-preview] label { display: block; margin-bottom: 6px; }
[data-pi-vite-preview] input {
  flex: 1 1 260px; min-width: 0; width: 100%; border-radius: 7px;
  border: 1px solid var(--preview-border); background: var(--preview-panel);
  color: var(--preview-text); padding: 9px 10px; font: inherit;
}
[data-pi-vite-preview] button, [data-pi-vite-preview] .preview-link {
  border: 1px solid var(--preview-border); border-radius: 7px;
  background: var(--preview-panel); color: var(--preview-text);
  padding: 8px 12px; font: inherit; text-decoration: none; cursor: pointer;
}
[data-pi-vite-preview] button[type="submit"] { color: var(--preview-accent); }
[data-pi-vite-preview] button[aria-pressed="true"] {
  border-color: var(--preview-accent); color: var(--preview-accent);
}
[data-pi-vite-preview] button:disabled,
[data-pi-vite-preview] input:disabled,
[data-pi-vite-preview] .preview-link[aria-disabled="true"] {
  opacity: .5; cursor: not-allowed;
}
[data-pi-vite-preview] :is(input, button, a, summary):focus-visible {
  outline: 2px solid var(--preview-accent); outline-offset: 3px;
}
[data-pi-vite-preview] .preview-error {
  color: #ffb1aa; border: 1px solid #a35b55; border-radius: 7px;
  padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; margin: 12px 0;
}
[data-pi-vite-preview] .preview-toolbar { margin: 12px 0; }
[data-pi-vite-preview] .preview-framework { overflow-wrap: anywhere; }
[data-pi-vite-preview] .preview-stage {
  position: relative; background: var(--preview-panel); border-radius: 8px;
  border: 1px solid var(--preview-border); padding: 8px; overflow: hidden;
}
[data-pi-vite-preview] .preview-frame {
  display: block; border: 0; background: #fff; width: 100%;
  height: clamp(280px, 65vh, 850px); margin: 0 auto; border-radius: 4px;
}
[data-pi-vite-preview][data-width="mobile"] .preview-frame { width: min(390px, 100%); }
[data-pi-vite-preview] .preview-placeholder {
  position: absolute; inset: 8px; display: grid; place-items: center;
  text-align: center; padding: 16px; background: var(--preview-panel);
  color: var(--preview-muted); border-radius: 4px;
}
[data-pi-vite-preview] details { margin-top: 14px; }
[data-pi-vite-preview] summary { cursor: pointer; color: var(--preview-muted); }
[data-pi-vite-preview] pre {
  max-height: 200px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
  border: 1px solid var(--preview-border); background: var(--preview-panel);
  border-radius: 7px; padding: 10px; font: 12px/1.5 ui-monospace, monospace;
}
@media (max-width: 480px) {
  [data-pi-vite-preview] { padding: 10px; }
  [data-pi-vite-preview] input { flex-basis: 100%; }
  [data-pi-vite-preview] .preview-toolbar { gap: 6px; }
  [data-pi-vite-preview] button, [data-pi-vite-preview] .preview-link { padding: 8px; }
}
`;

export default {
  mount(el, ctx) {
    const doc = el.ownerDocument;
    const node = (tag, className, text) => {
      const element = doc.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const root = node('section');
    root.setAttribute('data-pi-vite-preview', '');
    root.dataset.width = 'desktop';
    root.setAttribute('aria-label', '项目预览');
    const style = node('style', '', styles);
    const header = node('div', 'preview-header');
    const title = node('h2', '', '项目预览');
    const status = node('span', 'preview-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    header.append(title, status);

    const form = node('form');
    const label = node('label', '', '项目路径');
    const input = node('input');
    // Nesting keeps the label accessible without globally shared element IDs.
    label.append(input);
    input.type = 'text';
    input.placeholder = '例如 /path/to/project';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const actions = node('div', 'preview-actions');
    const start = node('button', '', '启动预览');
    start.type = 'submit';
    const stop = node('button', '', '停止');
    stop.type = 'button';
    actions.append(start, stop);
    const hint = node('p', 'preview-muted', '输入绝对路径或相对路径，启动后即可查看页面。');
    form.append(label, actions, hint);

    const error = node('div', 'preview-error');
    error.setAttribute('role', 'alert');
    const toolbar = node('div', 'preview-toolbar');
    const reload = node('button', '', '重新加载');
    reload.type = 'button';
    const open = node('a', 'preview-link', '在新标签页打开');
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    const desktop = node('button', '', '桌面');
    desktop.type = 'button';
    const mobile = node('button', '', '手机');
    mobile.type = 'button';
    mobile.title = '390 像素宽，空间不足时自动缩小';
    const framework = node('span', 'preview-muted preview-framework');
    toolbar.append(reload, open, desktop, mobile, framework);

    const stage = node('div', 'preview-stage');
    const iframe = node('iframe', 'preview-frame');
    iframe.title = '项目页面预览';
    iframe.src = 'about:blank';
    const placeholder = node('div', 'preview-placeholder', '启动项目后，预览会显示在这里。');
    stage.append(iframe, placeholder);
    const details = node('details');
    const summary = node('summary', '', '运行日志');
    const logs = node('pre', '', '暂无日志');
    logs.setAttribute('aria-label', '运行日志');
    details.append(summary, logs);
    root.append(style, header, form, error, toolbar, stage, details);
    el.append(root);

    let disposed = false;
    let inputEdited = false;
    let frameProject = null;
    let state = { status: 'idle', project: '', defaultProject: '', framework: '', logs: [], error: null };
    const removers = [];
    const listen = (element, event, handler) => {
      element.addEventListener(event, handler);
      removers.push(() => element.removeEventListener(event, handler));
    };
    const render = () => {
      const busy = state.status === 'starting' || state.status === 'stopping';
      const running = state.status === 'running';
      status.textContent = STATUS_LABELS[state.status];
      status.dataset.status = state.status;
      root.setAttribute('aria-busy', String(busy));
      input.disabled = busy;
      start.disabled = busy || running || !input.value.trim();
      stop.disabled = busy || !running;
      reload.disabled = busy || !running;
      desktop.disabled = busy;
      mobile.disabled = busy;
      desktop.setAttribute('aria-pressed', String(root.dataset.width === 'desktop'));
      mobile.setAttribute('aria-pressed', String(root.dataset.width === 'mobile'));
      open.setAttribute('aria-disabled', String(!running || busy));
      open.tabIndex = running && !busy ? 0 : -1;
      if (running && !busy) open.setAttribute('href', PREVIEW_PATH);
      else open.removeAttribute('href');
      framework.textContent = state.framework ? `框架：${state.framework}` : '';
      error.textContent = state.error || '';
      error.hidden = !state.error;
      placeholder.hidden = running;
      placeholder.textContent = busy ? STATUS_LABELS[state.status] : '启动项目后，预览会显示在这里。';
      // Log broadcasts must not navigate an already running preview.
      if (running && frameProject !== state.project) {
        iframe.src = PREVIEW_PATH;
        frameProject = state.project;
      } else if (!running && frameProject !== null) {
        iframe.src = 'about:blank';
        frameProject = null;
      }
      const nearBottom = logs.scrollHeight - logs.scrollTop - logs.clientHeight < 24;
      const logText = state.logs.join('\n').slice(-MAX_LOG_CHARS);
      if (logs.textContent !== (logText || '暂无日志')) {
        logs.textContent = logText || '暂无日志';
        if (nearBottom) logs.scrollTop = logs.scrollHeight;
      }
      summary.textContent = `运行日志（最近最多 ${MAX_LOG_LINES} 行）`;
    };
    const send = (payload, pendingStatus) => {
      if (disposed) return;
      if (pendingStatus) {
        state = { ...state, status: pendingStatus, error: null };
        render();
      }
      try {
        ctx.send(payload);
      } catch (cause) {
        state = { ...state, status: 'error', error: cause instanceof Error ? cause.message : String(cause) };
        render();
      }
    };
    listen(input, 'input', () => {
      inputEdited = true;
      render();
    });
    listen(form, 'submit', (event) => {
      event.preventDefault();
      if (!start.disabled) send({ action: 'start', project: input.value.trim() }, 'starting');
    });
    listen(stop, 'click', () => {
      if (!stop.disabled) send({ action: 'stop' }, 'stopping');
    });
    listen(reload, 'click', () => {
      if (!reload.disabled) iframe.src = PREVIEW_PATH;
    });
    listen(open, 'click', (event) => {
      if (open.getAttribute('aria-disabled') === 'true') event.preventDefault();
    });
    for (const [button, width] of [[desktop, 'desktop'], [mobile, 'mobile']]) {
      listen(button, 'click', () => {
        if (button.disabled) return;
        root.dataset.width = width;
        render();
      });
    }
    render();
    const unsubscribe = ctx.onData((payload) => {
      if (disposed || !payload || payload.type !== 'state' ||
          !Object.hasOwn(STATUS_LABELS, payload.status)) return;
      const text = (value) => typeof value === 'string' ? value : '';
      state = {
        status: payload.status,
        project: text(payload.project),
        defaultProject: text(payload.defaultProject),
        framework: text(payload.framework),
        error: text(payload.error) || null,
        logs: Array.isArray(payload.logs)
          ? payload.logs.slice(-MAX_LOG_LINES).map((line) => text(line).slice(-MAX_LOG_CHARS))
          : [],
      };
      if (!inputEdited) input.value = state.project || state.defaultProject;
      render();
    });
    send({ action: 'state' });

    return () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const remove of removers) remove();
      iframe.src = 'about:blank';
      root.remove();
    };
  },
};

// Runs only inside /preview/. Keep root-relative navigation within the dev app.
(() => {
if (window.__piVitePreviewRuntime) return;
window.__piVitePreviewRuntime = true;
const PREFIX = '/preview';
function scoped(value) {
  if (typeof value !== 'string' || value === '/plugins/vite-preview/client/preview-runtime.mjs') return value;
  if (value.startsWith('/') && !value.startsWith('//') && value !== PREFIX &&
      !value.startsWith(`${PREFIX}/`) && !value.startsWith(`${PREFIX}?`)) return PREFIX + value;
  return value;
}
function sameOrigin(value) {
  const url = new URL(value, location.href);
  if (url.origin !== location.origin) return value;
  url.pathname = scoped(url.pathname);
  return url.href;
}
function patchElement(element) {
  for (const name of ['href', 'src', 'action', 'poster', 'component-url', 'renderer-url']) {
    const value = element.getAttribute(name);
    if (value && scoped(value) !== value) element.setAttribute(name, scoped(value));
  }
}
function patchTree(root) {
  if (root instanceof Element) patchElement(root);
  root.querySelectorAll?.('[href],[src],[action],[poster],[component-url],[renderer-url]').forEach(patchElement);
}
function rewriteWrittenHtml(html) {
  return String(html).replace(
    /(\b(?:href|src|action|poster)\s*=\s*)(["'])(\/[^"']*)\2/gi,
    (_, attribute, quote, url) => `${attribute}${quote}${scoped(url)}${quote}`,
  );
}
for (const method of ['write', 'writeln']) {
  const original = document[method];
  document[method] = function(...parts) {
    return original.apply(this, parts.map(rewriteWrittenHtml));
  };
}
// Prefix before browser resource loading, including document.write and framework
// code setting a URL while an element is detached from the DOM.
const urlAttributes = new Set(['href', 'src', 'action', 'poster', 'component-url', 'renderer-url']);
const nativeSetAttribute = Element.prototype.setAttribute;
Element.prototype.setAttribute = function(name, value) {
  return nativeSetAttribute.call(this, name, urlAttributes.has(String(name).toLowerCase()) ? scoped(String(value)) : value);
};
for (const [type, names] of [
  [HTMLAnchorElement, ['href']], [HTMLLinkElement, ['href']],
  [HTMLScriptElement, ['src']], [HTMLImageElement, ['src']],
  [HTMLFormElement, ['action']], [HTMLSourceElement, ['src']],
  [HTMLVideoElement, ['src', 'poster']], [HTMLAudioElement, ['src']],
]) {
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(type.prototype, name);
    if (!descriptor?.set || !descriptor.configurable) continue;
    Object.defineProperty(type.prototype, name, {
      ...descriptor, set(value) { descriptor.set.call(this, scoped(String(value))); },
    });
  }
}
patchTree(document);
new MutationObserver(records => {
  for (const record of records) {
    if (record.type === 'attributes') patchElement(record.target);
    else record.addedNodes.forEach(patchTree);
  }
}).observe(document.documentElement, {
  subtree: true, childList: true, attributes: true,
  attributeFilter: ['href', 'src', 'action', 'poster', 'component-url', 'renderer-url'],
});
// Click handling also covers anchors created and clicked synchronously by an app.
document.addEventListener('click', event => {
  const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (anchor) patchElement(anchor);
}, true);
document.addEventListener('submit', event => {
  if (event.target instanceof HTMLFormElement) patchElement(event.target);
}, true);
for (const method of ['pushState', 'replaceState']) {
  const original = history[method];
  history[method] = function(data, unused, url) {
    return original.call(this, data, unused, url == null ? url : sameOrigin(url));
  };
}
const nativeFetch = window.fetch;
window.fetch = function(input, init) {
  if (input instanceof Request) {
    const url = sameOrigin(input.url);
    if (url !== input.url) input = new Request(url, input);
  } else if (input instanceof URL) input = sameOrigin(input.href);
  else if (typeof input === 'string') input = sameOrigin(input);
  return nativeFetch.call(this, input, init);
};
const nativeOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url, ...rest) {
  return nativeOpen.call(this, method, sameOrigin(String(url)), ...rest);
};
})();

// Settings defaults, shared by the content script, the background worker and the settings page.
// `var` on purpose: the content script may be injected twice into the same page.

// Extension API: Firefox's promise-based `browser`, else Chrome/Brave's `chrome`.
// (`.runtime` check: a page element with id="browser" also shows up as window.browser.)
var EXT = (globalThis.browser && globalThis.browser.runtime) ? globalThis.browser : globalThis.chrome;

var OCSI_DEFAULTS = {
  hkEnabled: true,
  hkMods: 'alt+shift',        // ctrl | alt | shift | ctrl+shift | ctrl+alt | alt+shift | ctrl+alt+shift
  hkCode: 'KeyS',             // KeyboardEvent.code, layout-independent
  hkLabel: 'S',
  mode: 'downloads',          // 'folder' = folder picked with Browse…, 'downloads' = subfolder of Downloads
  subfolder: 'One-Click Images',
  hires: true,                // look for a bigger version (linked image, srcset, known CDN sizes)
  unblock: true,              // stop sites from cancelling the right-click menu on images
  toast: true,                // small "Saved" message on the page
};

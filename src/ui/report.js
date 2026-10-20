// Shows the latest test_website report (kept in storage by the service worker) in a sandboxed frame.
const { lastTestReport: r } = await chrome.storage.local.get('lastTestReport');
const frame = document.getElementById('frame');
if (r?.html) {
  document.getElementById('path').textContent = r.path || '';
  // Links in the report open in a new tab instead of inside the frame.
  frame.srcdoc = r.html.replace('<head>', '<head><base target="_blank">');
  document.title = (r.html.match(/<title>([^<]*)<\/title>/)?.[1] || 'Test report').replace(/&amp;/g, '&');
} else {
  frame.remove();
  document.body.insertAdjacentHTML('beforeend', '<p class="empty">No test report yet. Ask LocalPilot to test a website, or type /test in the side panel.</p>');
}

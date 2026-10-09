// A 👁 button on a password field: one tap shows what was typed, the next hides it. The field is hidden again when focus
// leaves the field-and-button group (so it is hidden on a fresh visit and when a login overlay is opened again).
// PasswordToggle.attach(input, { color }) wraps the field once and returns { hide() } for a page that reopens the same
// field (home.html); color is the icon colour (a dark card needs a light one).
(function () {
  const OPEN = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const SHUT = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10.9 10.9 0 0 1 12 19C5 19 1 12 1 12a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2M1 1l22 22"/></svg>';

  function attach(input, opts) {
    if (!input) return { hide() {} };
    if (input.pwEye) return input.pwEye;   // attached before: the same handle
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    wrap.style.cssText = 'position:relative;display:block;width:100%';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.style.paddingRight = '48px';
    input.style.boxSizing = 'border-box';
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'pw-eye';
    eye.style.cssText = `position:absolute;top:0;right:0;width:44px;height:100%;min-height:40px;display:flex;align-items:center;justify-content:center;background:none;border:0;padding:0;cursor:pointer;color:${(opts && opts.color) || 'var(--ink-55, #8c8375)'}`;
    function show(on) {
      input.type = on ? 'text' : 'password';
      eye.setAttribute('aria-pressed', on ? 'true' : 'false');
      eye.setAttribute('aria-label', on ? '隱藏密碼' : '顯示密碼');
      eye.innerHTML = on ? SHUT : OPEN;
    }
    // pressing the eye must not take focus off the field (that would count as leaving the group and hide the text again,
    // and Safari does not focus a button on tap, so the focus change comes from the press itself): cancel the focus move
    ['mousedown', 'pointerdown'].forEach(t => eye.addEventListener(t, e => e.preventDefault()));
    eye.addEventListener('click', () => { show(input.type === 'password'); });
    wrap.addEventListener('focusout', e => { if (!e.relatedTarget || !wrap.contains(e.relatedTarget)) show(false); });
    wrap.appendChild(eye);
    show(false);
    input.pwEye = { hide: () => show(false) };
    return input.pwEye;
  }

  window.PasswordToggle = { attach };
})();

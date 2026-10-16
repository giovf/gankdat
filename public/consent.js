// Consent form: one submission only. A double click or a browser retry used to POST twice; the
// second answer ("Request expired") replaced the first one's redirect to the app (2026-10-04).
(function () {
  var form = document.querySelector('form[data-single-submit]');
  if (!form) return;
  form.addEventListener('submit', function (e) {
    if (form.dataset.submitted) {
      e.preventDefault();
      return;
    }
    form.dataset.submitted = '1';
    var clicked = e.submitter;
    var buttons = form.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i] !== clicked) buttons[i].disabled = true;
    }
    if (clicked) clicked.textContent = 'connecting…';
  });
})();

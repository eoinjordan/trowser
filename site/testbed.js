/**
 * Testbed behaviour.
 *
 * Every control is inert: it writes a timestamped line to its own log and does
 * nothing else. That way the agent can be allowed to act freely and you can see
 * exactly what it did without any real consequence.
 *
 * Kept in a separate file because the site is served under a CSP that forbids
 * inline script.
 */

(function () {
  'use strict';

  function log(id, message) {
    var node = document.getElementById(id);
    if (!node) return;
    var time = new Date().toLocaleTimeString();
    node.textContent = '[' + time + '] ' + message;
  }

  function on(id, handler) {
    var node = document.getElementById(id);
    if (node) node.addEventListener('click', handler);
  }

  on('searchBtn', function () {
    var value = document.getElementById('q').value;
    log('searchLog', value ? 'Searched for: ' + value : 'Searched with an empty query.');
  });

  document.getElementById('searchForm').addEventListener('submit', function (event) {
    event.preventDefault();
    log('searchLog', 'Form submitted (blocked, nothing sent).');
  });

  document.getElementById('country').addEventListener('change', function (event) {
    var select = event.target;
    var label = select.options[select.selectedIndex].text;
    log('countryLog', 'Country set to: ' + label + ' (' + select.value + ')');
  });

  on('buyBtn', function () {
    log('buyLog', 'Buy now clicked. Nothing was purchased.');
  });

  on('submitOrder', function () {
    log('buyLog', 'Place order clicked. Nothing was ordered.');
  });

  on('deleteBtn', function () {
    log('deleteLog', 'Delete account clicked. Nothing was deleted.');
  });

  on('signOutBtn', function () {
    log('deleteLog', 'Sign out clicked. Nothing happened.');
  });

  ['pw', 'ref'].forEach(function (id) {
    var field = document.getElementById(id);
    if (!field) return;
    field.addEventListener('input', function () {
      // Never echo the password value back into the page.
      log('pwLog', id === 'pw' ? 'Password field received input.' : 'Reference field changed.');
    });
  });
})();

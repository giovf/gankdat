/* global Office, OfficeRuntime */
// gankdat for Excel — task pane. Two jobs: a keyless preview (the MCP endpoint's five-row preview,
// so the pane shows the value before it asks for anything — AppSource policy 1100.5) and storing
// the API key in OfficeRuntime.storage, which the custom-functions runtime reads for every formula.
(function () {
  'use strict';

  var KEY_STORAGE = 'gankdat_api_key';
  var MCP_URL = '/mcp';

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(el, text, cls) {
    el.textContent = text;
    el.className = 'status' + (cls ? ' ' + cls : '');
  }

  function cellText(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.map(cellText).join(', ');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  function renderTable(records) {
    var host = $('preview-table');
    host.textContent = '';
    if (!records.length) {
      host.textContent = 'No match.';
      return;
    }
    var keys = Object.keys(records[0]).slice(0, 8);
    var table = document.createElement('table');
    var head = table.createTHead().insertRow();
    keys.forEach(function (k) {
      var th = document.createElement('th');
      th.textContent = k;
      head.appendChild(th);
    });
    var body = table.createTBody();
    records.forEach(function (r) {
      var row = body.insertRow();
      keys.forEach(function (k) {
        row.insertCell().textContent = cellText(r[k]);
      });
    });
    host.appendChild(table);
  }

  // The preview is the MCP server's keyless tier: a stateless JSON-RPC tools/call to the
  // dataset's query tool. Same origin as this page, so no CORS; the Worker validates Origin.
  function preview(source, q) {
    var tool = 'query_' + source.replace(/-/g, '_');
    var args = { per_page: 5 };
    if (q) {
      if (source === 'uk-company-profiles') {
        if (/^\d+$/.test(q)) args.company_number = q.padStart(8, '0');
        else args.company = q;
      } else {
        args.q = q;
      }
    }
    return fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
    }).then(function (res) {
      if (res.status === 401) {
        throw new Error('Preview limit reached for today — add a free key below for full access.');
      }
      if (!res.ok) throw new Error('gankdat answered HTTP ' + res.status);
      return res.json().then(function (body) {
        var result = body && body.result;
        if (!result) throw new Error((body && body.error && body.error.message) || 'empty answer');
        if (result.isError) {
          throw new Error(
            result.content && result.content[0] ? result.content[0].text : 'tool error',
          );
        }
        var payload = result.structuredContent;
        if (!payload && result.content && result.content[0])
          payload = JSON.parse(result.content[0].text);
        var records = payload && (payload.data || payload.records || payload.items);
        return Array.isArray(records) ? records : [];
      });
    });
  }

  function wirePreview() {
    $('preview-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var button = $('preview-run');
      var status = $('preview-status');
      button.disabled = true;
      setStatus(status, 'Fetching…');
      preview($('preview-source').value, $('preview-q').value.trim())
        .then(function (records) {
          renderTable(records);
          setStatus(
            status,
            records.length + ' row' + (records.length === 1 ? '' : 's') + ' (preview)',
            'ok',
          );
        })
        .catch(function (err) {
          $('preview-table').textContent = '';
          setStatus(status, err.message, 'err');
        })
        .then(function () {
          button.disabled = false;
        });
    });
  }

  function storage() {
    return typeof OfficeRuntime !== 'undefined' && OfficeRuntime.storage
      ? OfficeRuntime.storage
      : null;
  }

  function wireKey() {
    var status = $('key-status');
    var store = storage();
    if (!store) {
      setStatus(status, 'Open this pane inside Excel to store a key.', 'err');
      return;
    }
    store.getItem(KEY_STORAGE).then(function (key) {
      if (key)
        setStatus(status, 'A key is saved (' + key.slice(0, 9) + '…). Formulas are live.', 'ok');
    });
    $('key-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var key = $('key-input').value.trim();
      if (!/^\S{16,}$/.test(key)) {
        setStatus(status, 'That does not look like a gankdat key (fapi_…).', 'err');
        return;
      }
      store
        .setItem(KEY_STORAGE, key)
        .then(function () {
          $('key-input').value = '';
          setStatus(status, 'Saved. Recalculate (Ctrl+Alt+F9) to fill existing formulas.', 'ok');
        })
        .catch(function (err) {
          setStatus(status, 'Could not save: ' + err.message, 'err');
        });
    });
    $('key-clear').addEventListener('click', function () {
      store.removeItem(KEY_STORAGE).then(function () {
        setStatus(status, 'Key removed from this add-in.', 'ok');
      });
    });
  }

  function start() {
    wirePreview();
    wireKey();
  }

  if (typeof Office !== 'undefined' && Office.onReady) Office.onReady(start);
  else start();
})();

/* global CustomFunctions, OfficeRuntime */
// gankdat for Excel — custom functions runtime (classic script, no modules: the Office custom
// functions runtime loads this file as named by the manifest's Functions.Script.Url).
// Every formula is one REST call to the gankdat API on the same origin with the API key the task
// pane stored in OfficeRuntime.storage (shared between the pane and this runtime). Without a key
// the formula returns a #VALUE! error whose message says where to add one; the keyless preview
// lives in the pane (five rows, twenty calls a day), never in a formula — a sheet of a hundred
// preview formulas would spend the budget on its first recalculation.
(function () {
  'use strict';

  var API_BASE = 'https://gankdat.com';
  var KEY_STORAGE = 'gankdat_api_key';
  var DEFAULT_ROWS = 10;
  var MAX_ROWS = 100;

  function clampRows(rows) {
    var n = Number(rows);
    if (!isFinite(n) || n < 1) return DEFAULT_ROWS;
    return Math.min(Math.floor(n), MAX_ROWS);
  }

  function cellValue(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.map(cellValue).join(', ');
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  }

  // Header row + one row per record; columns are the first record's own keys, so a register's
  // field names are the sheet's headers (the add-in stays dataset-agnostic — isolation rule).
  function toMatrix(records, emptyText) {
    if (!records.length) return [[emptyText || 'no match']];
    var keys = Object.keys(records[0]);
    var out = [keys];
    for (var i = 0; i < records.length; i++) {
      var row = [];
      for (var k = 0; k < keys.length; k++) row.push(cellValue(records[i][keys[k]]));
      out.push(row);
    }
    return out;
  }

  function fail(message) {
    return new CustomFunctions.Error(CustomFunctions.ErrorCode.invalidValue, message);
  }

  function getKey() {
    return OfficeRuntime.storage.getItem(KEY_STORAGE).then(function (key) {
      if (!key) {
        throw fail(
          'gankdat: add your API key in the UK registers pane (Home tab) — free at gankdat.com/account',
        );
      }
      return key;
    });
  }

  function query(source, params) {
    return getKey().then(function (key) {
      var qs = [];
      for (var name in params) {
        if (params[name] !== undefined && params[name] !== '') {
          qs.push(encodeURIComponent(name) + '=' + encodeURIComponent(String(params[name])));
        }
      }
      var url = API_BASE + '/v1/data/' + encodeURIComponent(source) + '?' + qs.join('&');
      return fetch(url, {
        headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      }).then(function (res) {
        return res.json().then(
          function (body) {
            if (res.ok && body && body.ok) return body.data;
            var msg = body && body.error ? body.error.message : 'HTTP ' + res.status;
            if (res.status === 401)
              msg = 'gankdat: ' + msg + ' — check the key in the UK registers pane';
            if (res.status === 402 || res.status === 429)
              msg = 'gankdat: ' + msg + ' — top up at gankdat.com/account';
            throw fail(msg);
          },
          function () {
            throw fail('gankdat: unreadable answer (HTTP ' + res.status + ')');
          },
        );
      });
    });
  }

  function listFunction(source, param, value, rows, emptyText) {
    var text = String(value || '').trim();
    if (!text) return Promise.reject(fail('gankdat: give something to search for'));
    var params = { per_page: clampRows(rows) };
    params[param] = text;
    return query(source, params).then(function (records) {
      return toMatrix(records, emptyText);
    });
  }

  /** Companies House record for one company (uk-company-profiles, 1 credit). */
  function ukcompany(company, field) {
    var text = String(company || '').trim();
    if (!text) return Promise.reject(fail('gankdat: give a company number or name'));
    var params =
      /^[0-9A-Z]{1,8}$/i.test(text) && /\d/.test(text)
        ? { company_number: text.padStart(8, '0') }
        : { company: text };
    return query('uk-company-profiles', params).then(function (records) {
      if (!records.length) return [['no match']];
      var record = records[0];
      if (field) {
        var name = String(field).trim();
        if (!(name in record)) {
          throw fail(
            'gankdat: no field "' + name + '" — fields: ' + Object.keys(record).join(', '),
          );
        }
        return [[cellValue(record[name])]];
      }
      return toMatrix([record]);
    });
  }

  function ukcharity(charity, rows) {
    var text = String(charity || '').trim();
    var param = /^\d{6,8}$/.test(text) ? 'registered_charity_number' : 'name';
    return listFunction('uk-charities', param, text, rows);
  }

  function cqc(search, rows) {
    var text = String(search || '').trim();
    var postcode = /^[A-Z]{1,2}\d[A-Z\d]?( ?\d[A-Z]{2})?$/i.test(text);
    return listFunction('uk-care-locations', postcode ? 'postcode' : 'q', text, rows);
  }

  function sanctions(name, rows) {
    return listFunction('uk-sanctions', 'name', name, rows, 'no match');
  }

  function tenders(search, rows) {
    return listFunction('uk-tenders', 'q', search, rows);
  }

  function genericQuery(source, filter, value, rows) {
    var slug = String(source || '')
      .trim()
      .toLowerCase();
    var param = String(filter || 'q').trim();
    if (!/^[a-z0-9-]+$/.test(slug))
      return Promise.reject(fail('gankdat: unknown dataset "' + slug + '"'));
    if (!/^[a-z0-9_]+$/.test(param))
      return Promise.reject(fail('gankdat: filter names use letters, digits and _'));
    return listFunction(slug, param, value, rows);
  }

  if (typeof CustomFunctions !== 'undefined') {
    CustomFunctions.associate('UKCOMPANY', ukcompany);
    CustomFunctions.associate('UKCHARITY', ukcharity);
    CustomFunctions.associate('CQC', cqc);
    CustomFunctions.associate('SANCTIONS', sanctions);
    CustomFunctions.associate('TENDERS', tenders);
    CustomFunctions.associate('QUERY', genericQuery);
  }
})();

// CloudFront Function (runtime cloudfront-js-2.0), viewer request, on the Default (*) behavior only
// (design doc §C3): every path is an SPA route and gets /index.html, unless its last segment ends in a
// static-asset extension (STATIC below). A dot alone does not make a file: /users/john.doe and
// /tenders/RFQ-2026.01 are routes. Never a custom 403/404 → index.html error response: that would turn
// /api/* 404s into HTML. The more specific behaviors (/api/*, /otel/*, /csp-report, /config/*,
// /remotes/*, /assets/*, /version.json) never reach this function; the paths below are a second guard
// in case a behavior is misordered.
var PASS_THROUGH = ['/api/', '/otel/', '/csp-report', '/config/', '/remotes/', '/assets/'];
var EXACT = { '/otel': true, '/version.json': true };
var STATIC = {
  js: true, mjs: true, css: true, map: true, json: true,
  png: true, jpg: true, jpeg: true, gif: true, svg: true, webp: true, avif: true, ico: true,
  woff: true, woff2: true, ttf: true,
  txt: true, xml: true, webmanifest: true, html: true, htm: true,
};

function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (EXACT[uri] === true) return request;
  for (var i = 0; i < PASS_THROUGH.length; i++) {
    if (uri === PASS_THROUGH[i] || uri.indexOf(PASS_THROUGH[i]) === 0) return request;
  }
  var last = uri.substring(uri.lastIndexOf('/') + 1);
  var dot = last.lastIndexOf('.');
  var ext = dot === -1 ? '' : last.substring(dot + 1).toLowerCase();
  if (STATIC[ext] !== true) request.uri = '/index.html';
  return request;
}

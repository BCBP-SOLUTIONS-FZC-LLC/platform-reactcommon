// CloudFront Function (runtime cloudfront-js-2.0), viewer request, on the Default (*) behavior only
// (design doc §C3): extension-less paths are SPA routes and get /index.html. Never a custom 403/404 →
// index.html error response: that would turn /api/* 404s into HTML. The more specific behaviors
// (/api/*, /otel/*, /csp-report, /config/*, /remotes/*, /assets/*, /version.json) never reach this
// function; the prefixes below are a second guard in case a behavior is misordered.
var PASS_THROUGH = ['/api/', '/otel/', '/csp-report', '/config/', '/remotes/', '/assets/'];

function handler(event) {
  var request = event.request;
  var uri = request.uri;
  for (var i = 0; i < PASS_THROUGH.length; i++) {
    if (uri === PASS_THROUGH[i] || uri.indexOf(PASS_THROUGH[i]) === 0) return request;
  }
  var last = uri.substring(uri.lastIndexOf('/') + 1);
  if (last.indexOf('.') === -1) request.uri = '/index.html';
  return request;
}

// Shows this server's real address in the guide's examples.
(function () {
  if (!/^https?:$/.test(location.protocol) || !/integration-guide\.html$/.test(location.pathname)) return;
  var from = 'https://yourworkspace.hxgconnect.com', walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), n;
  while ((n = walker.nextNode())) if (n.nodeValue.indexOf(from) >= 0) n.nodeValue = n.nodeValue.split(from).join(location.origin);
})();

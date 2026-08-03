(() => {
  if (window.location.hash && window.location.hash.startsWith('#/')) {
    const nextPath = window.location.hash.slice(2);
    const path = nextPath ? `/${nextPath.replace(/^\//, '')}` : window.location.pathname + window.location.search;
    history.replaceState({}, '', path);
  }
})();

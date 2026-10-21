// Canary X lane. The service worker registers this for x.com pages, in the page's own JavaScript world, before X's
// app starts. It does nothing unless Canary opened the tab (URL fragment #canary); then it keeps the search responses
// X's web app receives, with X's own rate-limit headers, for the service worker to read. It sends no requests of its own.
(() => {
  if (location.hash !== '#canary') return
  const responses = window.__canaryX = []
  const isSearch = url => /\/graphql\/[^/?]+\/SearchTimeline\b/.test(url)
  const nativeFetch = window.fetch
  window.fetch = async function (resource) {
    const response = await nativeFetch.apply(this, arguments)
    if (isSearch(resource instanceof Request ? resource.url : String(resource))) {
      const header = name => response.headers.get(name)
      response.clone().text().then(body => responses.push({ status: response.status, body, remaining: header('x-rate-limit-remaining'), reset: header('x-rate-limit-reset') }), () => {})
    }
    return response
  }
  const { open, send } = XMLHttpRequest.prototype
  XMLHttpRequest.prototype.open = function (method, url) {
    this.canarySearch = isSearch(String(url))
    return open.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function () {
    if (this.canarySearch) {
      this.addEventListener('load', () => responses.push({
        status: this.status, body: typeof this.response === 'string' ? this.response : JSON.stringify(this.response),
        remaining: this.getResponseHeader('x-rate-limit-remaining'), reset: this.getResponseHeader('x-rate-limit-reset'),
      }))
    }
    return send.apply(this, arguments)
  }
})()

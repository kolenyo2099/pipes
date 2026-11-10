function headers(value = {}) {
  const sensitive = new Set(['authorization', 'cookie', 'proxy-authorization', 'set-cookie']);
  return Object.entries(value)
    .filter(([name]) => !sensitive.has(name.toLowerCase()))
    .map(([name, entry]) => ({ name, value: String(entry) }));
}

function queryString(rawUrl) {
  try {
    return [...new URL(rawUrl).searchParams.entries()].map(([name, value]) => ({
      name,
      value: /(auth|code|key|password|secret|session|signature|token)/i.test(name) ? '[REDACTED]' : value
    }));
  } catch {
    return [];
  }
}

export function recordNetworkEvent(network, method, params) {
  const requests = network.requests ?? (network.requests = {});
  const id = params.requestId;
  if (!id) return network;
  if (method === 'Network.requestWillBeSent') {
    if (!requests[id] && Object.keys(requests).length >= 2000) return network;
    requests[id] = {
      requestId: id,
      loaderId: params.loaderId,
      documentURL: params.documentURL,
      type: params.type,
      timestamp: params.timestamp,
      wallTime: params.wallTime,
      request: params.request,
      redirectResponse: params.redirectResponse,
      response: null,
      finishedTimestamp: null,
      encodedDataLength: 0,
      failure: null
    };
  } else if (method === 'Network.responseReceived' && requests[id]) {
    requests[id].response = params.response;
    requests[id].responseTimestamp = params.timestamp;
    requests[id].type = params.type ?? requests[id].type;
  } else if (method === 'Network.loadingFinished' && requests[id]) {
    requests[id].finishedTimestamp = params.timestamp;
    requests[id].encodedDataLength = params.encodedDataLength ?? 0;
  } else if (method === 'Network.loadingFailed' && requests[id]) {
    requests[id].finishedTimestamp = params.timestamp;
    requests[id].failure = {
      errorText: params.errorText,
      canceled: params.canceled ?? false,
      blockedReason: params.blockedReason
    };
  }
  return network;
}

export function buildHar(network, page = {}) {
  const entries = Object.values(network.requests ?? {}).map((entry) => {
    const request = entry.request ?? {};
    const response = entry.response ?? {};
    const started = entry.wallTime ? new Date(entry.wallTime * 1000).toISOString() : page.startedDateTime;
    const end = entry.finishedTimestamp ?? entry.responseTimestamp ?? entry.timestamp;
    const elapsed = Math.max(0, ((end ?? entry.timestamp ?? 0) - (entry.timestamp ?? 0)) * 1000);
    const failure = entry.failure?.errorText;
    return {
      startedDateTime: started ?? new Date().toISOString(),
      time: elapsed,
      request: {
        method: request.method ?? 'GET',
        url: request.url ?? entry.documentURL ?? '',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: headers(request.headers),
        queryString: queryString(request.url ?? ''),
        postData: request.postData ? { mimeType: request.headers?.['Content-Type'] ?? '' } : undefined,
        headersSize: -1,
        bodySize: request.postData ? new TextEncoder().encode(request.postData).length : 0
      },
      response: {
        status: response.status ?? 0,
        statusText: failure ?? response.statusText ?? '',
        httpVersion: response.protocol ?? '',
        cookies: [],
        headers: headers(response.headers),
        content: {
          size: response.encodedDataLength ?? entry.encodedDataLength ?? 0,
          mimeType: response.mimeType ?? ''
        },
        redirectURL: response.headers?.location ?? response.headers?.Location ?? '',
        headersSize: response.headersText ? new TextEncoder().encode(response.headersText).length : -1,
        bodySize: entry.encodedDataLength ?? -1,
        _failure: entry.failure ?? undefined
      },
      cache: {},
      timings: { send: 0, wait: elapsed, receive: 0 },
      serverIPAddress: response.remoteIPAddress,
      connection: response.connectionId ? String(response.connectionId) : undefined,
      _resourceType: entry.type,
      _documentURL: entry.documentURL
    };
  });
  return {
    log: {
      version: '1.2',
      creator: { name: 'HRC Archiver Capture', version: page.extensionVersion ?? 'dev' },
      pages: [
        {
          startedDateTime: page.startedDateTime ?? new Date().toISOString(),
          id: 'page_1',
          title: page.title ?? page.url ?? '',
          pageTimings: {}
        }
      ],
      entries: entries.map((entry) => ({ ...entry, pageref: 'page_1' }))
    }
  };
}

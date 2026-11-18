let appData = null;
let appDataRequest = null;
const liveSnapshots = new Map();
const liveRequests = new Map();

export function cachedAppData() {
  return appData;
}

export function loadAppData({ force = false } = {}) {
  if (!force && appData) return Promise.resolve(appData);
  // force 时若有在途请求,等它落地后再发新的,避免复用采集完成前的旧响应
  if (appDataRequest) return force ? appDataRequest.then(() => loadAppData({ force: true })) : appDataRequest;

  appDataRequest = fetch('/api/data')
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(data => {
      appData = data;
      return data;
    })
    .finally(() => {
      appDataRequest = null;
    });
  return appDataRequest;
}

export function cachedLiveSnapshot(windowMinutes) {
  return liveSnapshots.get(windowMinutes) || null;
}

export function loadLiveSnapshot(windowMinutes, { force = false } = {}) {
  if (!force && liveSnapshots.has(windowMinutes)) {
    return Promise.resolve(liveSnapshots.get(windowMinutes));
  }
  const inFlight = liveRequests.get(windowMinutes);
  // force 时若有在途请求,等它落地后再发新的,避免把采集完成前的旧快照当刷新结果
  if (inFlight) return force ? inFlight.then(() => loadLiveSnapshot(windowMinutes, { force: true })) : inFlight;

  const request = fetch(`/api/live?windowMinutes=${encodeURIComponent(windowMinutes)}`)
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(snapshot => {
      liveSnapshots.set(windowMinutes, snapshot);
      return snapshot;
    })
    .finally(() => {
      liveRequests.delete(windowMinutes);
    });
  liveRequests.set(windowMinutes, request);
  return request;
}

export function prepareRoute(pathname) {
  return pathname === '/live'
    ? loadLiveSnapshot(1440, { force: true })
    : loadAppData({ force: true });
}

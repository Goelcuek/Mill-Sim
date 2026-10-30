// Starting the mesh worker, wherever the app is running.
//
// Served as modules, the worker is its own file beside this one. Built
// into a single page there is no file to point at, so the build hands the
// worker's code in as text (__MESH_WORKER_SOURCE__) and it is started from
// that. Anywhere a worker cannot start — an old browser, a page whose
// rules forbid one, the tests under Node — this says so with null, and the
// stock is meshed on the main thread as it always was.

/* global __MESH_WORKER_SOURCE__ */

export function startMeshWorker() {
  if (typeof Worker === 'undefined') return null;
  try {
    // ?worker=0 in the page address meshes on the main thread, to compare.
    if (globalThis.location && /[?&]worker=0\b/.test(globalThis.location.search)) return null;
    if (typeof __MESH_WORKER_SOURCE__ === 'string') {
      const url = URL.createObjectURL(new Blob([__MESH_WORKER_SOURCE__], { type: 'text/javascript' }));
      return new Worker(url);
    }
    return new Worker(new URL('./meshWorker.js', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

// Stopping a run on its signal: a full pass and the change checks share these. Any abort reason
// other than 'timeout' is treated as a shutdown. label ('full', 'vg-check' or 'lgl-check') names the
// run; the log line that reports a stop already names it, so the message itself does not repeat it.
export function createStopper(signal, { label, minutes }) {
  const timedOut = () => signal?.reason === 'timeout'
  const stopError = () => Object.assign(
    new Error(timedOut() ? `timed out after ${minutes} minutes` : 'stopped by shutdown'), { stop: true, label })
  const checkStop = () => { if (signal?.aborted) throw stopError() }
  // A read is abandoned the moment the signal fires: nothing has been written, so nothing is lost.
  const read = (promise) => {
    if (!signal) return promise
    if (signal.aborted) { promise.catch(() => {}); throw stopError() }
    let onAbort
    const stop = new Promise((_, reject) => { onAbort = () => reject(stopError()); signal.addEventListener('abort', onAbort, { once: true }) })
    return Promise.race([promise, stop]).finally(() => signal.removeEventListener('abort', onAbort))
  }
  return { read, checkStop, stopError, timedOut }
}

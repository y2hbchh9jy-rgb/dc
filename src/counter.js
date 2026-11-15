// Bellek tabanlı kayan pencere (sliding window) sayacı.
// Her anahtar için zaman damgaları tutulur; her vuruşta süresi dolanlar atılır.
export class SlidingWindowCounter {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  #prune(arr, now) {
    const cut = now - this.windowMs;
    let i = 0;
    while (i < arr.length && arr[i] <= cut) i++;
    if (i) arr.splice(0, i);
  }

  /** Bir olay kaydeder ve pencere içindeki güncel sayıyı döndürür. */
  hit(key, now = Date.now()) {
    let arr = this.hits.get(key);
    if (!arr) this.hits.set(key, (arr = []));
    this.#prune(arr, now);
    arr.push(now);
    return arr.length;
  }

  count(key, now = Date.now()) {
    const arr = this.hits.get(key);
    if (!arr) return 0;
    this.#prune(arr, now);
    return arr.length;
  }

  clear(key) {
    this.hits.delete(key);
  }

  clearPrefix(prefix) {
    let n = 0;
    for (const k of this.hits.keys()) {
      if (k.startsWith(prefix)) {
        this.hits.delete(k);
        n++;
      }
    }
    return n;
  }

  get size() {
    return this.hits.size;
  }

  sweep(now = Date.now()) {
    for (const [k, arr] of this.hits) {
      this.#prune(arr, now);
      if (!arr.length) this.hits.delete(k);
    }
  }
}

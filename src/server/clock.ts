export interface Clock {
  now(): Date;
  // Calls `fire` once `ms` have passed on this clock; the returned function cancels it.
  setTimer(ms: number, fire: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  setTimer(ms, fire) {
    const timer = setTimeout(fire, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

import { errorAsString } from '$lib/util/error';
import { sleepSec } from './timer';

export async function rateLimit(numWorkers: number, tasks: (() => Promise<void>)[]) {
  const taskIter = tasks.values();
  const workers = new Array(numWorkers).fill(null).map(async () => {
    for (const task of taskIter) {
      await task();
    }
  });
  const results = await Promise.allSettled(workers);
  const errors = results.filter((result) => result.status === 'rejected');
  if (errors.length > 0) {
    const errorMessages = errors
      .map((error, index) => `  worker #${index + 1}: ${errorAsString(error.reason)}`)
      .join('\n');
    console.error(`rateLimit: encountered errors in ${errors.length} workers:\n${errorMessages}`);
    throw new Error(
      `Failed tasks with errors: ${errors.length} workers failed. Details: ${errorMessages}`
    );
  }
}

export class SlidingWindowRateLimiter {
  private readonly maxQPW: number;
  private readonly windowMs: number;
  private readonly requestTimestamps: number[];
  private readonly label: string;

  constructor({ maxQPW, windowSec, label }: { maxQPW: number; windowSec: number; label: string }) {
    this.label = label;
    this.maxQPW = maxQPW;
    this.windowMs = windowSec * 1000;
    this.requestTimestamps = [];
  }

  async waitForAvailability(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      this.removeOldTimestamps();
      const currentQueueSize = this.requestTimestamps.length;
      if (currentQueueSize < this.maxQPW) {
        this.requestTimestamps.push(Date.now());
        return;
      }
      const oldestTimestamp = this.requestTimestamps[0];
      const waitTimeSec = (oldestTimestamp + this.windowMs - Date.now()) / 1_000;
      if (waitTimeSec >= 5) {
        console.log(
          `SlidingWindowRateLimiter[${this.label}, maxQPW=${this.maxQPW}]: currentQueueSize=${currentQueueSize}, waiting ${waitTimeSec} seconds`
        );
      }
      await sleepSec(waitTimeSec);
    }
  }

  private removeOldTimestamps(): void {
    const cutoffTime = Date.now() - this.windowMs;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] <= cutoffTime) {
      this.requestTimestamps.shift();
    }
  }
}

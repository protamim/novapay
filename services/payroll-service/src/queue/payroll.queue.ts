import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL!);

export async function enqueuePayrollJob(jobId: string, employerId: string): Promise<void> {
  // Use a per-employer list for concurrency=1 per employer
  const queueKey = `payroll:queue:${employerId}`;
  await redis.rpush(queueKey, jobId);
  // Track all employer queues in a set so the worker can discover them
  await redis.sadd('payroll:employers', employerId);
}

export async function startPayrollWorker(
  processPayrollJob: (jobId: string) => Promise<void>,
): Promise<void> {
  console.log('[payroll-worker] started');
  while (true) {
    const employers = await redis.smembers('payroll:employers');
    for (const employerId of employers) {
      const queueKey = `payroll:queue:${employerId}`;
      // lpop is atomic — only one worker can claim a job per employer
      const jobId = await redis.lpop(queueKey);
      if (jobId) {
        try {
          await processPayrollJob(jobId);
        } catch (err) {
          console.error(`[payroll-worker] unhandled error processing job ${jobId}:`, err);
        }
      }
    }
    await Bun.sleep(500);
  }
}

/**
 * TradeBot v2 — Cloudflare Cron Scheduler
 * Every 5 minutes: POST {APP_URL}/api/internal/cron with X-Cron-Secret.
 * Runs the SAME cycle engine as the manual «یک چرخه» button.
 */
export interface Env {
  APP_URL: string
  RUN_CYCLE_SECRET: string
}

const schedulerHandler = {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const url = `${(env.APP_URL || '').replace(/\/$/, '')}/api/internal/cron`
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Cron-Secret': env.RUN_CYCLE_SECRET,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      if (!res.ok) {
        console.error(`cron run-cycle failed: HTTP ${res.status}`)
      }
    } catch (e) {
      console.error(`cron run-cycle error: ${e instanceof Error ? e.message : e}`)
    }
  },
}

export default schedulerHandler

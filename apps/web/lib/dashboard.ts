import 'server-only'

import type { MetricsSource } from '@ejc3/claude-master-dashboard'
import { createDemoSource } from '@ejc3/claude-master-dashboard/demo'

export const API_BASE = '/api/claude-master'

const demo = createDemoSource()

/** The demo source until a CloudWatch source is configured for this deployment. */
export function source(): MetricsSource {
  return demo
}

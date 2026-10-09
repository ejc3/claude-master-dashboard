import { createDashboardHandler } from '@ejc3/claude-master-dashboard/next'
import { authorizeRequest, source } from '@/lib/dashboard'

export const dynamic = 'force-dynamic'

export const { GET } = createDashboardHandler({ source, authorize: authorizeRequest })

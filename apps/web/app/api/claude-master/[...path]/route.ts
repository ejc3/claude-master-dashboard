import { createDashboardHandler } from '@ejc3/claude-master-dashboard/next'
import { viewerAllowed } from '@/auth'
import { source } from '@/lib/dashboard'

export const dynamic = 'force-dynamic'

export const { GET } = createDashboardHandler({ source, authorize: viewerAllowed })

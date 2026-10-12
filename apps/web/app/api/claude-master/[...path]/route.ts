import { dashboardApi } from '@/lib/api'
import { LEGACY_API_BASE } from '@/lib/dashboard'

export const dynamic = 'force-dynamic'

// The API at its address before the rename, for pages opened then: the same handler.
export const GET = dashboardApi(LEGACY_API_BASE)

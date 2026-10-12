import { redirect } from 'next/navigation'
import { pagePath, redirectIfMoved } from '@/lib/dashboard'

export const dynamic = 'force-dynamic'

// The dashboard's address before the rename: on to the same page at the new one.
export default async function Old({ params }: { params: Promise<{ slug?: string[] }> }) {
  const path = pagePath((await params).slug)
  redirectIfMoved(path)
  redirect(path)
}
